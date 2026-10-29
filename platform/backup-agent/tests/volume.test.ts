import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeIo } from '../src/io.ts';
import {
  type AgentIo,
  type AgentRequest,
  type ExecResult,
  type PipeEnd,
  runAgent,
} from '../src/run.ts';
import {
  classifyDirectory,
  imageDigestOf,
  markerForm,
  modeOf,
  parseManifest,
  sumsText,
  type VolumeManifest,
} from '../src/volume.ts';

const KCV = '00112233445566778899aabbccddeeff';
const IMAGE = `ghcr.io/acme/identity@sha256:${'ab'.repeat(32)}`;
const STAMP = '2026-10-13T02:00:00.000Z';
const PREFIX = 'di-framework/alpha/workload-volumes/identity/uid-wd/20261013T020000Z';

let root: string;
let source: string;
let claim: string;
let bucket: string;
let work: string;
let workloads: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'volume-'));
  source = join(root, 'source');
  claim = join(root, 'claim');
  bucket = join(root, 'bucket');
  work = join(root, 'work');
  workloads = join(root, 'workloads');
  for (const dir of [source, claim, bucket, work, workloads]) await mkdir(dir);
  // A pglite-like tree: nested files, an empty file, an empty directory, and the encfs marker.
  await mkdir(join(source, 'pglite', 'base', '1'), { recursive: true });
  await mkdir(join(source, 'pglite', 'empty'));
  await writeFile(join(source, 'pglite', 'base', '1', '1259'), Buffer.alloc(8192, 7));
  await writeFile(join(source, 'pglite', 'PG_VERSION'), '17\n');
  await writeFile(join(source, 'pglite', 'postmaster.opts'), '');
  await writeFile(join(source, '.di-encfs'), marker(KCV));
  await chmod(join(source, 'pglite', 'PG_VERSION'), 0o600);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Marker byte layouts, as `pglite-encfs/src/marker.rs` writes and reads them (#200, #551):
 * `DIPGKEY1 ‖ KCV` (24 bytes) for XTS, `DIPGKEY2 ‖ KCV ‖ 0x01` (25) for an integrity directory,
 * and the reservation `DIPGKEY2 ‖ 16 zero bytes ‖ 0x03` the platform writes before encfs keys it.
 */
function marker(kcv: string): Buffer {
  return Buffer.concat([Buffer.from('DIPGKEY1'), Buffer.from(kcv, 'hex')]);
}

function integrity(kcv: string, flags = 0x01): Buffer {
  return Buffer.concat([Buffer.from('DIPGKEY2'), Buffer.from(kcv, 'hex'), Buffer.from([flags])]);
}

const RESERVATION = integrity('00'.repeat(16), 0x03);

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    kind: 'workload-volume',
    host: '',
    port: '',
    bucket: '',
    prefix: PREFIX,
    workdir: work,
    terminationLog: join(work, 'termination'),
    gcKeys: '',
    endpoint: '',
    region: 'us-east-1',
    pgUser: 'app',
    pgDatabase: 'app',
    destinationType: 'pvc',
    pvcMountPath: claim,
    sourceDir: source,
    workloadName: 'identity',
    storageKey: 'identity',
    sourceImage: IMAGE,
    stamp: STAMP,
    targetRoot: workloads,
    ...overrides,
  };
}

type Hook = (argv: string[]) => ExecResult | undefined;

/**
 * Real files and real tar. `rclone` is a directory (`bucket`), ownership changes are recorded
 * (the tests do not run as root), and a hook can replace any command, piped ones included.
 * COPYFILE_DISABLE keeps macOS tar from adding `._` files.
 */
function io(
  hook: Hook = () => undefined,
): AgentIo & { calls: string[][]; owners: [string, number, number][] } {
  const base = nodeIo();
  const calls: string[][] = [];
  const owners: [string, number, number][] = [];
  const object = (remote: string) => join(bucket, remote.replace(/^:s3:[^/]+\//, ''));
  const run = (argv: string[]) => base.exec(argv, { env: { COPYFILE_DISABLE: '1' } });
  /** `rclone cat` and `rclone rcat` read and write the bucket directory. */
  const local = async (end: PipeEnd): Promise<PipeEnd> => {
    if ('file' in end) return end;
    const [tool, verb] = end.argv;
    const target = object(end.argv.at(-1) ?? '');
    if (tool === 'rclone' && verb === 'rcat') {
      await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      return { file: target };
    }
    if (tool === 'rclone' && verb === 'cat') return { file: target };
    return { argv: end.argv, env: { ...end.env, COPYFILE_DISABLE: '1' } };
  };
  return {
    ...base,
    calls,
    owners,
    async chown(path, uid, gid) {
      owners.push([path, uid, gid]);
    },
    async pipe(from, to, inspect) {
      for (const end of [from, to]) {
        if (!end || 'file' in end) continue;
        calls.push(end.argv);
        const hooked = hook(end.argv);
        if (hooked) return { code: hooked.code, stderr: hooked.stderr };
      }
      return base.pipe(await local(from), to && (await local(to)), inspect);
    },
    async exec(argv) {
      calls.push(argv);
      const hooked = hook(argv);
      if (hooked) return hooked;
      if (argv[0] === 'bash' && argv[3] === 'volume-restore') {
        return run([
          'tar',
          '-x',
          '-p',
          '--no-same-owner',
          '-f',
          object(argv[4] ?? ''),
          '-C',
          argv[5] ?? '',
        ]);
      }
      if (argv[0] === 'rclone' && argv[1] === 'copyto') {
        const [from, to] = [argv[2] ?? '', argv[3] ?? ''];
        if (to.startsWith(':s3:')) {
          await mkdir(object(to).slice(0, object(to).lastIndexOf('/')), { recursive: true });
          return run(['cp', from, object(to)]);
        }
        return run(['cp', object(from), to]);
      }
      if (argv[0] === 'rclone' && argv[1] === 'deletefile') {
        await rm(object(argv[2] ?? ''), { force: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      return run(argv);
    },
  };
}

/** Runs `effect` after each real command that `match` picks, as if something else acted then. */
function after(match: (argv: string[]) => boolean, effect: (argv: string[]) => Promise<unknown>) {
  const base = io();
  const wrapped = io();
  wrapped.exec = async (argv, opts) => {
    const result = await base.exec(argv, opts);
    if (match(argv)) await effect(argv);
    return result;
  };
  return wrapped;
}

async function termination(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(work, 'termination'), 'utf8')) as Record<string, unknown>;
}

async function manifestAt(dir: string): Promise<VolumeManifest> {
  return JSON.parse(await readFile(join(dir, PREFIX, 'manifest.json'), 'utf8')) as VolumeManifest;
}

async function backupToClaim(): Promise<void> {
  expect(await runAgent(request(), io())).toBe(0);
}

describe('workload volume backup', () => {
  test('writes the archive, per-file sha256, and a manifest with stamp, digest, count, and KCV', async () => {
    await backupToClaim();
    const record = await termination();
    expect(record).toMatchObject({
      ok: true,
      tool: 'tar',
      format: 'workload-volume',
      fileCount: 4,
      encfsKcv: KCV,
      imageDigest: `sha256:${'ab'.repeat(32)}`,
      objectKey: `${PREFIX}/data.tar`,
      bytes: 8192 + 3 + 0 + 24,
    });
    const manifest = await manifestAt(claim);
    expect(manifest).toMatchObject({
      kind: 'WorkloadVolumeManifest',
      workloadName: 'identity',
      storageKey: 'identity',
      stamp: STAMP,
      image: IMAGE,
      imageDigest: `sha256:${'ab'.repeat(32)}`,
      fileCount: 4,
      directoryCount: 4,
      encfsKcv: KCV,
      archive: 'data.tar',
    });
    const expected = {
      '.di-encfs': sha(marker(KCV)),
      'pglite/PG_VERSION': sha('17\n'),
      'pglite/base/1/1259': sha(Buffer.alloc(8192, 7)),
      'pglite/postmaster.opts': sha(''),
    };
    expect(Object.fromEntries(manifest.files.map((file) => [file.path, file.sha256]))).toEqual(
      expected,
    );
    expect(manifest.files.find((file) => file.path === 'pglite/PG_VERSION')?.mode).toBe(0o600);
    expect(manifest.directories.map((entry) => entry.path).sort()).toEqual([
      'pglite',
      'pglite/base',
      'pglite/base/1',
      'pglite/empty',
    ]);
    const sums = await readFile(join(claim, PREFIX, 'SHA256SUMS'), 'utf8');
    expect(sums).toBe(sumsText(manifest.files));
    expect(sums).toContain(`${expected['pglite/PG_VERSION']}  ./pglite/PG_VERSION\n`);
    expect(existsSync(join(claim, PREFIX, 'data.tar'))).toBe(true);
    expect(existsSync(join(claim, PREFIX, 'data.tar.partial'))).toBe(false);
    expect(record.digest).toBe(
      `sha256:${sha(await readFile(join(claim, PREFIX, 'manifest.json')))}`,
    );
  });

  test('records no KCV without a marker and no digest for a tag', async () => {
    await rm(join(source, '.di-encfs'));
    expect(await runAgent(request({ sourceImage: 'ghcr.io/acme/identity:1.2' }), io())).toBe(0);
    const record = await termination();
    expect(record.encfsKcv).toBeUndefined();
    expect(record.imageDigest).toBeUndefined();
    const manifest = await manifestAt(claim);
    expect(manifest.encfsKcv).toBeNull();
    expect(manifest.imageDigest).toBeNull();
    expect(manifest.image).toBe('ghcr.io/acme/identity:1.2');
    expect(
      await runAgent(
        request({
          sourceImage: undefined,
          workloadName: undefined,
          storageKey: undefined,
          stamp: undefined,
        }),
        io(),
      ),
    ).toBe(0);
    expect((await manifestAt(claim)).image).toBeNull();
  });

  test('streams to S3 through rclone rcat and uploads the manifest last', async () => {
    const s3 = io();
    expect(
      await runAgent(request({ destinationType: 's3', bucket: 'b', pvcMountPath: undefined }), s3),
    ).toBe(0);
    // One read of the volume: tar streams through the hashing reader into rclone.
    expect(s3.calls.find((argv) => argv[0] === 'tar')).toEqual([
      'tar',
      '--numeric-owner',
      '-C',
      source,
      '-cf',
      '-',
      '.',
    ]);
    expect(s3.calls.find((argv) => argv[1] === 'rcat')).toEqual([
      'rclone',
      'rcat',
      '--s3-chunk-size',
      '5Mi',
      `:s3:b/${PREFIX}/data.tar`,
    ]);
    expect(s3.calls.some((argv) => argv[0] === 'bash')).toBe(false);
    const uploads = s3.calls.filter((argv) => argv[1] === 'copyto').map((argv) => argv[3]);
    expect(uploads).toEqual([`:s3:b/${PREFIX}/SHA256SUMS`, `:s3:b/${PREFIX}/manifest.json`]);
    expect((await manifestAt(bucket)).fileCount).toBe(4);
  });

  test('refuses links, a short marker, an unreadable source, and missing configuration', async () => {
    await symlink('/etc/passwd', join(source, 'pglite', 'escape'));
    expect(await runAgent(request(), io())).toBe(1);
    expect((await termination()).error).toBe('UnsupportedEntry');
    await rm(join(source, 'pglite', 'escape'));

    await writeFile(join(source, '.di-encfs'), 'short');
    expect(await runAgent(request(), io())).toBe(1);
    expect((await termination()).error).toBe('EncfsMarkerInvalid');

    expect(await runAgent(request({ sourceDir: join(root, 'absent') }), io())).toBe(1);
    expect((await termination()).error).toBe('SourceUnreadable');
    expect(await runAgent(request({ sourceDir: undefined }), io())).toBe(1);
    expect((await termination()).error).toBe('MissingSource');
    expect(await runAgent(request({ pvcMountPath: undefined }), io())).toBe(1);
    expect((await termination()).error).toBe('MissingClaim');
    expect(await runAgent(request({ destinationType: 's3' }), io())).toBe(1);
    expect((await termination()).error).toBe('MissingBucket');
    expect(await runAgent(request({ prefix: '../outside' }), io())).toBe(1);
    expect((await termination()).error).toBe('PvcPathInvalid');
  });

  test('fails and discards the archive when tar, an upload, or the source changes', async () => {
    const tarFails = io((argv) =>
      argv[0] === 'tar' ? { code: 2, stdout: '', stderr: 'tar: read error' } : undefined,
    );
    expect(await runAgent(request(), tarFails)).toBe(1);
    expect((await termination()).error).toBe('UploadFailed');
    expect(existsSync(join(claim, PREFIX, 'data.tar.partial'))).toBe(false);

    const mvFails = io((argv) =>
      argv[0] === 'mv' ? { code: 1, stdout: '', stderr: 'mv' } : undefined,
    );
    expect(await runAgent(request(), mvFails)).toBe(1);
    expect((await termination()).error).toBe('UploadFailed');

    const unwritable = io();
    unwritable.mkdir = async () => {
      throw new Error('read-only claim');
    };
    expect(await runAgent(request(), unwritable)).toBe(1);
    expect((await termination()).error).toBe('UploadFailed');

    let copies = 0;
    const manifestFails = io((argv) => {
      if (argv[0] !== 'cp') return undefined;
      copies += 1;
      return copies === 2 ? { code: 1, stdout: '', stderr: 'full' } : undefined;
    });
    expect(await runAgent(request(), manifestFails)).toBe(1);
    expect((await termination()).error).toBe('UploadFailed');
    expect(existsSync(join(claim, PREFIX, 'data.tar'))).toBe(false);

    // Something still writes while the copy runs.
    const changed = after(
      (argv) => argv[0] === 'mv',
      () => writeFile(join(source, 'pglite', 'late'), 'new'),
    );
    expect(await runAgent(request(), changed)).toBe(1);
    expect((await termination()).error).toBe('SourceChanged');
    expect(existsSync(join(claim, PREFIX, 'data.tar'))).toBe(false);
    await rm(join(source, 'pglite', 'late'));

    const s3Fails = io((argv) =>
      argv[1] === 'rcat' ? { code: 1, stdout: '', stderr: 'rclone' } : undefined,
    );
    expect(await runAgent(request({ destinationType: 's3', bucket: 'b' }), s3Fails)).toBe(1);
    expect(s3Fails.calls.some((argv) => argv[1] === 'deletefile')).toBe(true);

    const gone = after(
      (argv) => argv[0] === 'mv',
      () => rm(source, { recursive: true, force: true }),
    );
    expect(await runAgent(request(), gone)).toBe(1);
    expect((await termination()).error).toBe('SourceChanged');
  });
});

async function tree(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name).slice(dir.length + 1);
    found[path] = entry.isDirectory() ? '<dir>' : sha(await readFile(join(dir, path)));
  }
  return found;
}

const restore = (overrides: Partial<AgentRequest> = {}) =>
  request({ kind: 'restore-workload-volume', stamp: '2026-10-14T09:30:00.000Z', ...overrides });

describe('workload volume restore', () => {
  test('restores into a missing or empty target, verifies every hash, and hands it to the host uid', async () => {
    await backupToClaim();
    const original = await tree(source);
    const restored = io();
    expect(await runAgent(restore(), restored)).toBe(0);
    expect(await tree(join(workloads, 'identity'))).toEqual(original);
    expect(await termination()).toMatchObject({ ok: true, fileCount: 4, encfsKcv: KCV });
    expect((await termination()).replacedPath).toBeUndefined();
    // The key directory goes to the host uid; every entry gets the owner the manifest recorded.
    const manifest = await manifestAt(claim);
    const target = join(workloads, 'identity');
    expect(restored.owners).toEqual([
      [target, 65532, 65532],
      ...[...manifest.directories, ...manifest.files].map((entry): [string, number, number] => [
        join(target, entry.path),
        entry.uid as number,
        entry.gid as number,
      ]),
    ]);
    expect(manifest.files.every((file) => file.uid === process.getuid?.())).toBe(true);
    expect(manifest.foreignOwners).toBe(
      process.getuid?.() === 65532 ? 0 : manifest.files.length + manifest.directories.length,
    );
    expect(await readdir(workloads)).toEqual(['identity']);

    await rm(join(workloads, 'identity'), { recursive: true });
    await mkdir(join(workloads, 'identity'));
    expect(await runAgent(restore(), io())).toBe(0);
  });

  test('refuses a non-empty target unless forced, then moves the old data aside', async () => {
    await backupToClaim();
    const target = join(workloads, 'identity');
    await mkdir(target);
    await writeFile(join(target, '.di-encfs'), marker(KCV));
    await writeFile(join(target, 'newer'), 'keep me');
    const refused = io();
    expect(await runAgent(restore(), refused)).toBe(1);
    expect((await termination()).error).toBe('TargetNotEmpty');
    expect(refused.calls).toEqual([]);
    expect(await readFile(join(target, 'newer'), 'utf8')).toBe('keep me');

    expect(await runAgent(restore({ force: true }), io())).toBe(0);
    expect((await termination()).replacedPath).toBe('identity.replaced-20261014T093000Z');
    const aside = join(workloads, 'identity.replaced-20261014T093000Z');
    expect(await readFile(join(aside, 'newer'), 'utf8')).toBe('keep me');
    expect(await tree(target)).toEqual(await tree(source));
  });

  test('checks the KCV against the backup, the old data, and an expected value', async () => {
    await backupToClaim();
    const target = join(workloads, 'identity');
    await mkdir(target);
    await writeFile(join(target, '.di-encfs'), marker('ff'.repeat(16)));
    expect(await runAgent(restore({ force: true }), io())).toBe(1);
    expect((await termination()).error).toBe('KcvMismatch');
    expect(await runAgent(restore({ force: true, expectedKcv: 'aa'.repeat(16) }), io())).toBe(1);
    expect((await termination()).error).toBe('KcvMismatch');
    // Naming the backup's KCV is the explicit way to change keys.
    expect(await runAgent(restore({ force: true, expectedKcv: KCV }), io())).toBe(0);

    const manifest = await manifestAt(claim);
    await writeFile(
      join(claim, PREFIX, 'manifest.json'),
      JSON.stringify({ ...manifest, encfsKcv: 'aa'.repeat(16) }),
    );
    await rm(target, { recursive: true });
    expect(await runAgent(restore(), io())).toBe(1);
    expect((await termination()).error).toBe('KcvMismatch');
    await writeFile(
      join(claim, PREFIX, 'manifest.json'),
      JSON.stringify({ ...manifest, encfsKcv: null }),
    );
    expect(await runAgent(restore(), io())).toBe(1);
    expect((await termination()).error).toBe('ManifestInvalid');
    expect(existsSync(join(workloads, 'identity.restoring-20261014T093000Z'))).toBe(false);
  });

  test('refuses a tampered backup', async () => {
    await backupToClaim();
    const manifest = await manifestAt(claim);
    const write = (value: unknown, sums = sumsText((value as VolumeManifest).files)) =>
      Promise.all([
        writeFile(join(claim, PREFIX, 'manifest.json'), JSON.stringify(value)),
        writeFile(join(claim, PREFIX, 'SHA256SUMS'), sums),
      ]);
    const attempt = async () => {
      await rm(join(workloads, 'identity'), { recursive: true, force: true });
      expect(await runAgent(restore(), io())).toBe(1);
      return (await termination()).error;
    };
    const files = manifest.files.map((file) =>
      file.path === 'pglite/PG_VERSION' ? { ...file, sha256: '0'.repeat(64) } : file,
    );
    await write({ ...manifest, files });
    expect(await attempt()).toBe('HashMismatch');
    // Caught before a byte is extracted: sizes, extra members, and missing ones.
    await write({ ...manifest, files: manifest.files.map((file) => ({ ...file, size: 1 })) });
    expect(await attempt()).toBe('ArchiveRejected');
    await write({ ...manifest, files: manifest.files.slice(1) });
    expect(await attempt()).toBe('ArchiveRejected');
    await write({ ...manifest, directories: manifest.directories.slice(1) });
    expect(await attempt()).toBe('ArchiveRejected');
    await write({
      ...manifest,
      files: [...manifest.files, { ...manifest.files[0], path: 'extra' }],
    });
    expect(await attempt()).toBe('ArchiveRejected');
    await write(manifest, 'tampered\n');
    expect(await attempt()).toBe('ManifestInvalid');
    await write({ ...manifest, kind: 'Other' });
    expect(await attempt()).toBe('ManifestInvalid');
    await writeFile(join(claim, PREFIX, 'manifest.json'), '{not json');
    expect(await attempt()).toBe('ManifestInvalid');
    expect(await readdir(workloads)).toEqual(['identity']);
    expect(await readdir(join(workloads, 'identity'))).toEqual([]);
  });

  test('fails closed on download, extract, link, move, and ownership errors', async () => {
    await backupToClaim();
    const fails = (tool: string, match = (argv: string[]) => argv[0] === tool) =>
      io((argv) => (match(argv) ? { code: 1, stdout: '', stderr: tool } : undefined));
    const reset = () => rm(join(workloads, 'identity'), { recursive: true, force: true });
    expect(
      await runAgent(
        restore(),
        fails('cp', (argv) => !!argv[1]?.endsWith('manifest.json')),
      ),
    ).toBe(1);
    expect((await termination()).error).toBe('DownloadFailed');
    await reset();
    expect(
      await runAgent(
        restore(),
        fails('cp', (argv) => !!argv[1]?.endsWith('SHA256SUMS')),
      ),
    ).toBe(1);
    expect((await termination()).error).toBe('DownloadFailed');
    await reset();
    expect(await runAgent(restore(), fails('tar'))).toBe(1);
    expect((await termination()).error).toBe('DownloadFailed');
    expect(await readdir(workloads)).toEqual(['identity']);
    await reset();
    const owners = io();
    owners.chown = async () => {
      throw new Error('EPERM');
    };
    expect(await runAgent(restore(), owners)).toBe(1);
    expect(await termination()).toEqual({ ok: false, error: 'OwnershipFailed' });
    await reset();
    // A move that fails part-way reports where the old data and the staging directory are.
    const target = join(workloads, 'identity');
    await mkdir(target);
    await writeFile(join(target, '.di-encfs'), marker(KCV));
    await writeFile(join(target, 'old'), 'old');
    const moves = io();
    let renames = 0;
    moves.rename = async (from, to) => {
      renames += 1;
      if (renames === 3) throw new Error('EXDEV');
      await nodeIo().rename(from, to);
    };
    expect(await runAgent(restore({ force: true }), moves)).toBe(1);
    expect(await termination()).toEqual({
      ok: false,
      error: 'RestoreFailed',
      replacedPath: 'identity.replaced-20261014T093000Z',
      restoringPath: 'identity.restoring-20261014T093000Z',
    });
    expect(existsSync(join(workloads, 'identity.restoring-20261014T093000Z'))).toBe(true);
    const ownersAfterForce = io();
    ownersAfterForce.chown = async () => {
      throw new Error('EPERM');
    };
    await rm(join(workloads, 'identity.restoring-20261014T093000Z'), { recursive: true });
    await writeFile(join(target, '.di-encfs'), marker(KCV));
    await writeFile(join(target, 'newer'), 'newer');
    expect(
      await runAgent(restore({ force: true, stamp: '2026-10-15T00:00:00Z' }), ownersAfterForce),
    ).toBe(1);
    expect(await termination()).toEqual({
      ok: false,
      error: 'OwnershipFailed',
      replacedPath: 'identity.replaced-20261015T000000Z',
    });
    await reset();
    const noMoves = io();
    noMoves.rename = async () => {
      throw new Error('EXDEV');
    };
    expect(await runAgent(restore(), noMoves)).toBe(1);
    expect(await termination()).toEqual({
      ok: false,
      error: 'RestoreFailed',
      restoringPath: 'identity.restoring-20261014T093000Z',
    });
    await reset();
    const withLink = after(
      (argv) => argv[0] === 'tar' && argv[1] === '-x',
      (argv) => symlink('/etc', join(argv[argv.length - 1] ?? '', 'link')),
    );
    expect(await runAgent(restore(), withLink)).toBe(1);
    expect((await termination()).error).toBe('UnsupportedEntry');
    await reset();
    const unreadable = io();
    unreadable.scan = async () => {
      throw new Error('EIO');
    };
    expect(await runAgent(restore(), unreadable)).toBe(1);
    expect((await termination()).error).toBe('ContentMismatch');
    await reset();
    // Only a missing target is empty: any other read error refuses before anything is touched.
    const denied = io();
    denied.list = async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    expect(await runAgent(restore({ force: true }), denied)).toBe(1);
    expect((await termination()).error).toBe('TargetUnreadable');
    expect(denied.calls).toEqual([]);
  });

  test('lists the archive before extracting and refuses links or unknown members', async () => {
    await backupToClaim();
    const manifest = await manifestAt(claim);
    const archive = join(claim, PREFIX, 'data.tar');
    // The same tree plus a symlink, archived by real tar.
    const forged = join(root, 'forged');
    await mkdir(forged);
    await nodeIo().exec(['cp', '-R', `${source}/.`, forged]);
    await symlink('/etc', join(forged, 'pglite', 'escape'));
    const made = await nodeIo().exec(
      ['tar', '--numeric-owner', '-C', forged, '-cf', archive, '.'],
      {
        env: { COPYFILE_DISABLE: '1' },
      },
    );
    expect(made.code).toBe(0);
    const extracted = io();
    expect(await runAgent(restore(), extracted)).toBe(1);
    expect((await termination()).error).toBe('ArchiveRejected');
    // Nothing was extracted: no tar -x ran, no staging directory exists.
    expect(extracted.calls.some((argv) => argv[0] === 'tar')).toBe(false);
    expect(await readdir(workloads)).toEqual(['identity']);
    // A file that is not an archive at all.
    await writeFile(archive, Buffer.alloc(1024, 1));
    expect(await runAgent(restore(), io())).toBe(1);
    expect((await termination()).error).toBe('ArchiveRejected');
    // Cut short: no end-of-archive block.
    await writeFile(archive, Buffer.alloc(0));
    expect(await runAgent(restore(), io())).toBe(1);
    expect((await termination()).error).toBe('ArchiveRejected');
    // Unreadable.
    await rm(archive);
    expect(await runAgent(restore(), io())).toBe(1);
    expect((await termination()).error).toBe('DownloadFailed');
    expect(manifest.fileCount).toBe(4);
  });

  test('restores from S3 and refuses missing configuration', async () => {
    expect(
      await runAgent(
        request({ destinationType: 's3', bucket: 'b', pvcMountPath: undefined }),
        io(),
      ),
    ).toBe(0);
    const s3 = io();
    expect(
      await runAgent(restore({ destinationType: 's3', bucket: 'b', pvcMountPath: undefined }), s3),
    ).toBe(0);
    expect(s3.calls.find((argv) => argv[0] === 'bash')?.[2]).toContain('rclone cat "$1" | tar -x');
    expect(await tree(join(workloads, 'identity'))).toEqual(await tree(source));

    for (const [overrides, error] of [
      [{ targetRoot: undefined }, 'MissingTarget'],
      [{ storageKey: 'Bad_Key' }, 'MissingTarget'],
      [{ storageKey: 'a'.repeat(51) }, 'MissingTarget'],
      [{ pvcMountPath: undefined }, 'MissingClaim'],
      [{ prefix: '/abs' }, 'PvcPathInvalid'],
    ] as const) {
      expect(await runAgent(restore(overrides), io())).toBe(1);
      expect((await termination()).error).toBe(error);
    }
    expect(
      await runAgent(
        restore({ stamp: undefined, force: true, destinationType: 's3', bucket: 'b' }),
        io(),
      ),
    ).toBe(0);
  });
});

describe('volume helpers and node io', () => {
  test('KCV, digest, sums, and manifest parsing', () => {
    expect(imageDigestOf(IMAGE)).toBe(`sha256:${'ab'.repeat(32)}`);
    expect(imageDigestOf(undefined)).toBeNull();
    expect(sumsText([{ path: 'a', size: 0, mode: 0o644, sha256: 'f'.repeat(64) }])).toBe(
      `${'f'.repeat(64)}  ./a\n`,
    );
    const good = {
      kind: 'WorkloadVolumeManifest',
      files: [{ path: 'a/b', size: 1, sha256: 'a'.repeat(64) }],
      directories: [{ path: 'a' }],
      encfsKcv: null,
      encfsMode: 'NotEncfs',
      encfsReservation: false,
    };
    expect(parseManifest(JSON.stringify(good))).toBeDefined();
    for (const fine of [
      { encfsMode: 'XTS', encfsKcv: KCV },
      { encfsMode: 'AEAD', encfsKcv: KCV },
      { encfsMode: 'AEAD', encfsReservation: true },
    ]) {
      expect(parseManifest(JSON.stringify({ ...good, ...fine }))).toBeDefined();
    }
    for (const bad of [
      'null',
      JSON.stringify({ ...good, files: 'x' }),
      JSON.stringify({ ...good, directories: undefined }),
      JSON.stringify({ ...good, files: [{ path: '../x', size: 1, sha256: 'a'.repeat(64) }] }),
      JSON.stringify({ ...good, files: [{ path: 'x', size: '1', sha256: 'a'.repeat(64) }] }),
      JSON.stringify({ ...good, files: [{ path: 'x', size: 1, sha256: 'nope' }] }),
      JSON.stringify({ ...good, files: [null] }),
      JSON.stringify({ ...good, directories: [{ path: '/etc' }] }),
      JSON.stringify({ ...good, directories: [null] }),
      JSON.stringify({ ...good, encfsKcv: 'short' }),
      JSON.stringify({ ...good, encfsMode: undefined }),
      JSON.stringify({ ...good, encfsMode: 'Other' }),
      JSON.stringify({ ...good, encfsReservation: 'no' }),
      JSON.stringify({ ...good, encfsKcv: KCV }),
      JSON.stringify({ ...good, encfsMode: 'XTS' }),
      JSON.stringify({ ...good, encfsReservation: true }),
      JSON.stringify({ ...good, encfsMode: 'AEAD', encfsReservation: true, encfsKcv: KCV }),
    ]) {
      expect(parseManifest(bad)).toBeUndefined();
    }
  });

  test('scans without following links, hashes by streaming, lists, renames, and runs commands', async () => {
    const real = nodeIo();
    await symlink('/etc', join(source, 'link'));
    const fifo = await real.exec(['mkfifo', join(source, 'pipe')]);
    expect(fifo.code).toBe(0);
    await utimes(join(source, 'pglite', 'PG_VERSION'), 1, 1);
    const entries = await real.scan(source);
    expect(entries.find((entry) => entry.path === 'link')?.type).toBe('symlink');
    expect(entries.find((entry) => entry.path === 'pipe')?.type).toBe('other');
    expect(entries.find((entry) => entry.path === 'pglite/PG_VERSION')).toMatchObject({
      type: 'file',
      size: 3,
      mode: 0o600,
      mtimeMs: 1000,
    });
    expect(await real.hash(join(source, 'pglite', 'PG_VERSION'))).toBe(sha('17\n'));
    await expect(real.hash(join(source, 'missing'))).rejects.toThrow();
    expect(await real.list(join(source, 'pglite'))).toEqual([
      'PG_VERSION',
      'base',
      'empty',
      'postmaster.opts',
    ]);
    await real.rename(join(source, 'pglite', 'PG_VERSION'), join(source, 'moved'));
    expect(existsSync(join(source, 'moved'))).toBe(true);
    await real.mkdir(join(work, 'a', 'b'));
    await real.writeFile(join(work, 'a', 'b', 'f'), 'x');
    expect(Buffer.from(await real.readFile(join(work, 'a', 'b', 'f'))).toString()).toBe('x');
    await real.remove(join(work, 'a'));
    expect(existsSync(join(work, 'a'))).toBe(false);
    expect((await real.exec(['cat'], { input: 'piped' })).stdout).toBe('piped');
    expect(await real.exec(['sh', '-c', 'echo err >&2; exit 3'])).toMatchObject({
      code: 3,
      stderr: 'err\n',
    });
    await expect(real.exec(['/nonexistent/tool'])).rejects.toThrow();
  });
});

describe('encfs directory modes (#553)', () => {
  test('classifies marker bytes with exact lengths and fails closed on anything else', () => {
    expect(markerForm(marker(KCV))).toEqual({ form: 'xts', kcv: KCV });
    expect(markerForm(integrity(KCV))).toEqual({ form: 'integrity', kcv: KCV });
    expect(markerForm(RESERVATION)).toEqual({ form: 'reserved' });
    for (const bad of [
      Buffer.alloc(0),
      Buffer.from('short'),
      Buffer.concat([marker(KCV), Buffer.from([0x01])]),
      marker(KCV).subarray(0, 23),
      Buffer.concat([Buffer.from('DIPGKEY2'), Buffer.from(KCV, 'hex')]),
      Buffer.concat([integrity(KCV), Buffer.from([0])]),
      Buffer.concat([Buffer.from('DIPGKEY3'), Buffer.from(KCV, 'hex'), Buffer.from([1])]),
      integrity(KCV, 0x00),
      integrity(KCV, 0x02),
      integrity(KCV, 0x03),
      integrity(KCV, 0x05),
      integrity('00'.repeat(16), 0x01 | 0x80),
      integrity('00'.repeat(16), 0x02),
    ]) {
      expect(markerForm(bad)).toEqual({ form: 'corrupt' });
    }
    // A zero KCV with the codec-4 bit alone is a keyed marker, not a reservation.
    expect(markerForm(integrity('00'.repeat(16)))).toEqual({
      form: 'integrity',
      kcv: '00'.repeat(16),
    });
  });

  test('classifies directories the way storage-mode does', async () => {
    const file = (path: string) => ({ path, type: 'file' as const });
    const dir = (path: string) => ({ path, type: 'directory' as const });
    const of = (bytes: Uint8Array) => async () => bytes;
    const never = async (): Promise<Uint8Array> => {
      throw new Error('not read');
    };
    const cases: [Parameters<typeof classifyDirectory>[0], () => Promise<Uint8Array>, string][] = [
      [[], never, 'empty'],
      [[dir('lost+found'), file('lost+found/x')], never, 'empty'],
      [[file('lost+found')], never, 'unencrypted'],
      [[file('PG_VERSION')], never, 'unencrypted'],
      [[file('.di-encfs'), dir('base')], of(marker(KCV)), 'xts'],
      [[file('.di-encfs'), file('PG_VERSION')], of(integrity(KCV)), 'integrity'],
      [[file('.di-encfs')], of(RESERVATION), 'reserved'],
      [[dir('lost+found'), file('.di-encfs')], of(RESERVATION), 'reserved'],
      [[file('.di-encfs'), file('PG_VERSION')], of(RESERVATION), 'corrupt'],
      [[file('.di-encfs'), file('.di-encfs.tmp')], of(RESERVATION), 'corrupt'],
      [[file('.di-encfs')], of(integrity(KCV, 0x07)), 'corrupt'],
      [[{ path: '.di-encfs', type: 'symlink' }], never, 'corrupt'],
      [[file('.di-encfs'), dir('.di-encfs.tmp')], never, 'corrupt'],
    ];
    for (const [entries, read, expected] of cases) {
      expect(await classifyDirectory(entries, read)).toBe(expected as never);
    }
    expect(modeOf('xts')).toBe('XTS');
    expect(modeOf('integrity')).toBe('AEAD');
    expect(modeOf('reserved')).toBe('AEAD');
    expect(modeOf('empty')).toBe('NotEncfs');
    expect(modeOf('unencrypted')).toBe('NotEncfs');
    expect(modeOf('corrupt')).toBeUndefined();
  });

  test('records the mode in the manifest for XTS, integrity, reserved, and unmarked sources', async () => {
    const run = async () => {
      expect(await runAgent(request(), io())).toBe(0);
      const manifest = await manifestAt(claim);
      return [manifest.encfsMode, manifest.encfsReservation, manifest.encfsKcv];
    };
    expect(await run()).toEqual(['XTS', false, KCV]);
    expect((await termination()).encfsMode).toBe('XTS');
    await writeFile(join(source, '.di-encfs'), integrity(KCV));
    expect(await run()).toEqual(['AEAD', false, KCV]);
    await rm(join(source, '.di-encfs'));
    expect(await run()).toEqual(['NotEncfs', false, null]);
    await rm(source, { recursive: true });
    await mkdir(source);
    await writeFile(join(source, '.di-encfs'), RESERVATION);
    expect(await run()).toEqual(['AEAD', true, null]);
    expect((await termination()).encfsKcv).toBeUndefined();

    // A reservation beside data, or a marker with unknown flags, fails closed.
    await writeFile(join(source, 'PG_VERSION'), '17\n');
    expect(await runAgent(request(), io())).toBe(1);
    expect((await termination()).error).toBe('EncfsMarkerInvalid');
    await writeFile(join(source, '.di-encfs'), integrity(KCV, 0x05));
    expect(await runAgent(request(), io())).toBe(1);
    expect((await termination()).error).toBe('EncfsMarkerInvalid');
  });

  test('round-trips an integrity directory, also into a reserved target without force', async () => {
    await writeFile(join(source, '.di-encfs'), integrity(KCV));
    await backupToClaim();
    const original = await tree(source);
    expect(await runAgent(restore(), io())).toBe(0);
    expect(await termination()).toMatchObject({ ok: true, encfsKcv: KCV, encfsMode: 'AEAD' });
    expect(await tree(join(workloads, 'identity'))).toEqual(original);

    // The reservation is neither data nor a key: no TargetNotEmpty, no KcvMismatch, nothing aside.
    const target = join(workloads, 'identity');
    await rm(target, { recursive: true });
    await mkdir(join(target, 'lost+found'), { recursive: true });
    await writeFile(join(target, '.di-encfs'), RESERVATION);
    expect(await runAgent(restore(), io())).toBe(0);
    expect((await termination()).replacedPath).toBeUndefined();
    expect(await tree(target)).toEqual({ ...original, 'lost+found': '<dir>' });
    expect(await readdir(workloads)).toEqual(['identity']);

    // Same mode, forced over existing integrity data.
    expect(await runAgent(restore({ force: true }), io())).toBe(0);
    expect((await termination()).replacedPath).toBe('identity.replaced-20261014T093000Z');
  });

  test('a reserved target moves its own lost+found aside when the backup brings one', async () => {
    await rm(source, { recursive: true });
    await mkdir(join(source, 'lost+found'), { recursive: true });
    await writeFile(join(source, 'lost+found', '#12'), 'from backup');
    await writeFile(join(source, '.di-encfs'), integrity(KCV));
    await writeFile(join(source, 'PG_VERSION'), '17\n');
    await backupToClaim();
    const target = join(workloads, 'identity');
    await mkdir(join(target, 'lost+found'), { recursive: true });
    await writeFile(join(target, 'lost+found', '#7'), 'fsck found me');
    await writeFile(join(target, '.di-encfs'), RESERVATION);
    expect(await runAgent(restore(), io())).toBe(0);
    expect((await termination()).replacedPath).toBe('identity.replaced-20261014T093000Z');
    const aside = join(workloads, 'identity.replaced-20261014T093000Z');
    expect(await readFile(join(aside, 'lost+found', '#7'), 'utf8')).toBe('fsck found me');
    expect(await readdir(aside)).toEqual(['lost+found']);
    expect(await tree(target)).toEqual(await tree(source));
  });

  test('a symlinked marker in a backup source is a marker problem', async () => {
    await rm(join(source, '.di-encfs'));
    await symlink('/etc/passwd', join(source, '.di-encfs'));
    expect(await runAgent(request(), io())).toBe(1);
    expect((await termination()).error).toBe('EncfsMarkerInvalid');
  });

  test('round-trips a reservation-only directory', async () => {
    await rm(source, { recursive: true });
    await mkdir(source);
    await writeFile(join(source, '.di-encfs'), RESERVATION);
    await backupToClaim();
    expect(await runAgent(restore(), io())).toBe(0);
    expect(sha(await readFile(join(workloads, 'identity', '.di-encfs')))).toBe(sha(RESERVATION));
  });

  test('refuses a cross-mode restore before anything moves', async () => {
    await backupToClaim();
    const target = join(workloads, 'identity');
    await mkdir(target);
    // XTS backup over a reserved (AEAD) target, with the same KCV everywhere.
    await writeFile(join(target, '.di-encfs'), RESERVATION);
    const refused = io();
    expect(await runAgent(restore({ force: true }), refused)).toBe(1);
    expect(await termination()).toMatchObject({
      error: 'ModeMismatch',
      detail: 'backup is XTS, target is AEAD; a restore keeps the mode',
    });
    expect(refused.calls.some((argv) => argv[0] === 'tar')).toBe(false);
    // XTS backup over an integrity directory.
    await writeFile(join(target, '.di-encfs'), integrity(KCV));
    await writeFile(join(target, 'PG_VERSION'), '17\n');
    expect(await runAgent(restore({ force: true, expectedKcv: KCV }), io())).toBe(1);
    expect((await termination()).error).toBe('ModeMismatch');
    // XTS backup over an unmarked directory.
    await rm(join(target, '.di-encfs'));
    expect(await runAgent(restore({ force: true }), io())).toBe(1);
    expect((await termination()).detail).toBe(
      'backup is XTS, target is NotEncfs; a restore keeps the mode',
    );
    expect(await readFile(join(target, 'PG_VERSION'), 'utf8')).toBe('17\n');

    // An integrity backup over an XTS directory.
    await writeFile(join(source, '.di-encfs'), integrity(KCV));
    await backupToClaim();
    await writeFile(join(target, '.di-encfs'), marker(KCV));
    expect(await runAgent(restore({ force: true }), io())).toBe(1);
    expect((await termination()).detail).toBe(
      'backup is AEAD, target is XTS; a restore keeps the mode',
    );
  });

  test('refuses a target whose on-disk mode its storage record does not accept (#553)', async () => {
    await backupToClaim();
    const target = join(workloads, 'identity');
    await mkdir(target);
    await writeFile(join(target, '.di-encfs'), marker(KCV));
    await writeFile(join(target, 'PG_VERSION'), '16\n');
    // Same mode as the backup, but the record says the key is AEAD.
    const refused = io();
    expect(await runAgent(restore({ force: true, targetModes: ['AEAD'] }), refused)).toBe(1);
    expect(await termination()).toMatchObject({
      error: 'ModeMismatch',
      detail: 'target is XTS, its storage record accepts AEAD',
    });
    expect(refused.calls.some((argv) => argv[0] === 'tar')).toBe(false);
    expect(await readFile(join(target, 'PG_VERSION'), 'utf8')).toBe('16\n');
    // An accepted mode restores; an empty target passes whatever the record holds.
    expect(await runAgent(restore({ force: true, targetModes: ['XTS', 'AEAD'] }), io())).toBe(0);
    await rm(target, { recursive: true });
    expect(await runAgent(restore({ targetModes: ['AEAD'] }), io())).toBe(0);
  });

  test('refuses a corrupt target marker and an extracted marker that contradicts the manifest', async () => {
    await backupToClaim();
    const target = join(workloads, 'identity');
    await mkdir(target);
    await writeFile(join(target, '.di-encfs'), integrity(KCV, 0x09));
    expect(await runAgent(restore({ force: true }), io())).toBe(1);
    expect((await termination()).error).toBe('EncfsMarkerInvalid');
    await rm(join(target, '.di-encfs'));
    await symlink('/etc/passwd', join(target, '.di-encfs'));
    expect(await runAgent(restore({ force: true }), io())).toBe(1);
    expect((await termination()).error).toBe('EncfsMarkerInvalid');
    await rm(target, { recursive: true });

    // The manifest claims another mode than the archived marker has.
    const manifest = await manifestAt(claim);
    const forge = (fields: Partial<VolumeManifest>) =>
      writeFile(join(claim, PREFIX, 'manifest.json'), JSON.stringify({ ...manifest, ...fields }));
    await forge({ encfsMode: 'AEAD' });
    expect(await runAgent(restore(), io())).toBe(1);
    expect((await termination()).error).toBe('ModeMismatch');
    expect(existsSync(join(workloads, 'identity.restoring-20261014T093000Z'))).toBe(false);
    await forge({ encfsMode: 'AEAD', encfsReservation: true, encfsKcv: null });
    expect(await runAgent(restore(), io())).toBe(1);
    expect((await termination()).error).toBe('ModeMismatch');
  });

  test('refuses an archived marker that is corrupt or not the recorded reservation', async () => {
    await rm(source, { recursive: true });
    await mkdir(source);
    await writeFile(join(source, '.di-encfs'), RESERVATION);
    await backupToClaim();
    const manifest = await manifestAt(claim);
    const forge = (fields: Partial<VolumeManifest>) =>
      writeFile(join(claim, PREFIX, 'manifest.json'), JSON.stringify({ ...manifest, ...fields }));
    await forge({ encfsReservation: false, encfsKcv: KCV });
    expect(await runAgent(restore(), io())).toBe(1);
    expect((await termination()).error).toBe('ModeMismatch');

    // Swap the archived marker for a corrupt one of the same size, with a matching manifest hash.
    const corrupt = integrity(KCV, 0x07);
    await writeFile(join(source, '.di-encfs'), corrupt);
    const files = manifest.files.map((file) =>
      file.path === '.di-encfs' ? { ...file, sha256: sha(corrupt) } : file,
    );
    await run([
      'tar',
      '--numeric-owner',
      '-C',
      source,
      '-cf',
      join(claim, PREFIX, 'data.tar'),
      '.',
    ]);
    await writeFile(join(claim, PREFIX, 'SHA256SUMS'), sumsText(files));
    await forge({ files });
    expect(await runAgent(restore(), io())).toBe(1);
    expect((await termination()).error).toBe('EncfsMarkerInvalid');
  });

  test('a restore target that cannot be scanned is unreadable, not empty', async () => {
    await backupToClaim();
    const target = join(workloads, 'identity');
    await mkdir(target);
    await writeFile(join(target, 'PG_VERSION'), '17\n');
    const broken = io();
    broken.scan = async () => {
      throw new Error('EIO');
    };
    expect(await runAgent(restore({ force: true }), broken)).toBe(1);
    expect((await termination()).error).toBe('TargetUnreadable');
  });
});

async function run(argv: string[]): Promise<void> {
  const result = await nodeIo().exec(argv, { env: { COPYFILE_DISABLE: '1' } });
  expect(result.code).toBe(0);
}
