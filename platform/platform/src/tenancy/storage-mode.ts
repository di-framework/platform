/**
 * The `storage-mode` init step of the tenant host pod (#200, design-200 §9.1).
 *
 * It runs after `storage-owner`, as the host uid with no capabilities, before the host starts.
 * It writes the integrity reservation marker into each empty directory on its reserve list and
 * prints one line per directory of the Tenant (`<key> <class>`), then `done count=<n>`. The
 * controller reads that listing through `pods/log`. On a failure it also writes a one-line
 * termination message naming the key and the cause, and exits 1, so the host does not start.
 *
 * Tenant code can plant links in its own directories, so nothing here follows one: directories
 * are opened with `O_NOFOLLOW | O_DIRECTORY` and every entry is reached through the directory's
 * descriptor (`/proc/self/fd/<fd>`), markers are opened with `O_NOFOLLOW` and checked with
 * `fstat`, and the reservation is created with `O_EXCL` and renamed over the marker name.
 *
 * {@link storageMode} is rendered into the pod as its own source text (`node -e`), so it must
 * not reference anything outside its body. The classification is the one the backup agent uses
 * (`platform/backup-agent/src/volume.ts`), with the classes named as §9.1 names them:
 * `integrity` is `aead` and `corrupt` is `other`.
 */

export type StorageClass = 'empty' | 'unencrypted' | 'xts' | 'aead' | 'reserved' | 'other';

/** What the program touches outside itself; the pod passes Node's own. */
export interface StorageModeSystem {
  fs: typeof import('node:fs');
  /** Print one line of the listing. */
  print(line: string): void;
  /** The path through which entries of the directory open as `fd` are reached. */
  at(fd: number, path: string): string;
  /** Where the termination message goes (`/dev/termination-log` in the pod). */
  terminationLog: string;
}

/**
 * Arguments: `--root=<workloads root>`, `--mounts=<where each mounted key is>`,
 * `--keys=<mounted keys, comma-separated>` and `--reserve=<keys to reserve, comma-separated>`.
 * Returns the exit code.
 */
export function storageMode(args: string[], sys: StorageModeSystem): number {
  const fs = sys.fs;
  const C = fs.constants;
  const MARKER = '.di-encfs';
  const MARKER_TMP = '.di-encfs.tmp';
  const KEY = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
  const option = (name: string) =>
    (args.find((arg) => arg.startsWith(`--${name}=`)) ?? `--${name}=`).slice(name.length + 3);
  const list = (name: string) => option(name).split(',').filter(Boolean);
  const root = option('root');
  const mounts = option('mounts');
  const mounted = list('keys');
  const reserve = new Set(list('reserve'));
  const failures: string[] = [];
  let count = 0;
  const report = (key: string, found: StorageClass, cause?: string) => {
    count++;
    sys.print(cause ? `${key} ${found} ${cause}` : `${key} ${found}`);
  };
  const fail = (key: string, cause: string) => failures.push(`${key}: ${cause}`);
  const reason = (error: unknown) => (error as { code?: string }).code ?? String(error);
  // DIPGKEY2, a zero KCV and flags 0b11: an integrity directory encfs has not keyed yet.
  const reservation = Buffer.concat([
    Buffer.from('DIPGKEY2', 'latin1'),
    Buffer.alloc(16),
    Buffer.from([0x03]),
  ]);
  const markerClass = (bytes: Buffer): StorageClass | 'reservation' => {
    const magic = bytes.subarray(0, 8).toString('latin1');
    if (bytes.length === 24 && magic === 'DIPGKEY1') return 'xts';
    if (bytes.length !== 25 || magic !== 'DIPGKEY2') return 'other';
    const zero = bytes.subarray(8, 24).every((byte) => byte === 0);
    if (bytes[24] === 0x01) return 'aead';
    return bytes[24] === 0x03 && zero ? 'reservation' : 'other';
  };
  /** Classify one directory and reserve it when asked; a link at a marker name is `link`. */
  const visit = (key: string, path: string) => {
    let fd: number;
    try {
      fd = fs.openSync(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    } catch (error) {
      report(key, 'other', `unreadable ${reason(error)}`);
      if (reserve.has(key)) fail(key, `directory unreadable (${reason(error)})`);
      return;
    }
    try {
      const base = sys.at(fd, path);
      const entries = fs.readdirSync(base, { withFileTypes: true });
      const markers = entries.filter((entry) => entry.name === MARKER || entry.name === MARKER_TMP);
      if (markers.some((entry) => !entry.isFile())) {
        report(key, 'other', 'non-regular entry at a marker name');
        if (reserve.has(key)) fail(key, 'non-regular entry at a marker name; not reserved');
        return;
      }
      const data = entries.filter(
        (entry) => entry.name !== MARKER && !(entry.name === 'lost+found' && entry.isDirectory()),
      );
      if (!entries.some((entry) => entry.name === MARKER)) {
        if (data.length > 0) return report(key, 'unencrypted');
        if (!reserve.has(key)) return report(key, 'empty');
        try {
          const tmp = fs.openSync(
            `${base}/${MARKER_TMP}`,
            C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
            0o600,
          );
          try {
            fs.writeSync(tmp, reservation);
            fs.fsyncSync(tmp);
          } finally {
            fs.closeSync(tmp);
          }
          fs.renameSync(`${base}/${MARKER_TMP}`, `${base}/${MARKER}`);
          fs.fsyncSync(fd);
        } catch (error) {
          report(key, 'empty', `reservation failed ${reason(error)}`);
          fail(key, `reservation could not be written (${reason(error)})`);
          return;
        }
        return report(key, 'reserved');
      }
      const marker = fs.openSync(`${base}/${MARKER}`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      let bytes: Buffer;
      try {
        if (!fs.fstatSync(marker).isFile()) {
          report(key, 'other', 'non-regular entry at a marker name');
          if (reserve.has(key)) fail(key, 'non-regular entry at a marker name; not reserved');
          return;
        }
        const buffer = Buffer.alloc(26);
        bytes = buffer.subarray(0, fs.readSync(marker, buffer, 0, 26, 0));
      } finally {
        fs.closeSync(marker);
      }
      const found = markerClass(bytes);
      if (found !== 'reservation') return report(key, found);
      report(key, data.length === 0 ? 'reserved' : 'other');
    } catch (error) {
      report(key, 'other', `unreadable ${reason(error)}`);
      if (reserve.has(key)) fail(key, `directory unreadable (${reason(error)})`);
    } finally {
      fs.closeSync(fd);
    }
  };
  const seen = new Set<string>();
  for (const key of mounted) {
    seen.add(key);
    visit(key, `${mounts}/${key}`);
  }
  try {
    const rootFd = fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY);
    try {
      const entries = fs.readdirSync(sys.at(rootFd, root), { withFileTypes: true });
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (seen.has(entry.name) || entry.name.length > 50 || !KEY.test(entry.name)) continue;
        if (entry.isDirectory()) visit(entry.name, `${sys.at(rootFd, root)}/${entry.name}`);
        else report(entry.name, 'other', entry.isSymbolicLink() ? 'link' : 'not a directory');
      }
    } finally {
      fs.closeSync(rootFd);
    }
  } catch (error) {
    failures.push(`workloads root: unreadable (${reason(error)})`);
  }
  sys.print(`done count=${count}`);
  if (failures.length === 0) return 0;
  try {
    fs.writeFileSync(sys.terminationLog, failures.join('; ').slice(0, 4000));
  } catch {
    /* The listing and the exit code still report the failure. */
  }
  return 1;
}

/** The init container's command: {@link storageMode}'s own source, run by Node. */
export function storageModeCommand(): string[] {
  return [
    'node',
    '-e',
    `process.exitCode = (${storageMode.toString()})(process.argv.slice(1), {
  fs: require('node:fs'),
  print: (line) => process.stdout.write(line + '\\n'),
  at: (fd) => '/proc/self/fd/' + fd,
  terminationLog: '/dev/termination-log',
});`,
  ];
}
