import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { classifyDirectory } from '../../backup-agent/src/volume';
import type { ControllerConfig, Tenant } from '../src/tenancy/resources';
import {
  type StorageModeSystem,
  storageMode,
  storageModeCommand,
} from '../src/tenancy/storage-mode';
import {
  HOST_MOUNT_ROOT,
  hostStorage,
  WORKLOADS_ROOT_MOUNT,
} from '../src/tenancy/workload-storage';

const KCV = '0123456789abcdef0123456789abcdef';
const xts = () => Buffer.concat([Buffer.from('DIPGKEY1'), Buffer.from(KCV, 'hex')]);
const integrity = (flags = 0x01, kcv = KCV) =>
  Buffer.concat([Buffer.from('DIPGKEY2'), Buffer.from(kcv, 'hex'), Buffer.from([flags])]);
const RESERVATION = integrity(0x03, '00'.repeat(16));

type Build = (dir: string) => void;
const file =
  (name: string, bytes: Uint8Array | string = 'x'): Build =>
  (dir) =>
    fs.writeFileSync(path.join(dir, name), bytes);
const dir =
  (name: string, ...inside: Build[]): Build =>
  (parent) => {
    fs.mkdirSync(path.join(parent, name));
    for (const build of inside) build(path.join(parent, name));
  };
const link =
  (name: string, target = '/etc/hostname'): Build =>
  (parent) =>
    fs.symlinkSync(target, path.join(parent, name));

/**
 * The fixture directories, each with the class `storage-mode` reports. The backup agent
 * classifies the same directories (`classifyDirectory`, #556); both must agree on every one.
 */
const FIXTURES: [string, Build[], string][] = [
  ['empty', [], 'empty'],
  ['lost-found', [dir('lost+found', file('x'))], 'empty'],
  ['lost-found-file', [file('lost+found')], 'unencrypted'],
  ['plain', [file('PG_VERSION')], 'unencrypted'],
  ['tmp-only', [file('.di-encfs.tmp')], 'unencrypted'],
  ['xts', [file('.di-encfs', xts()), dir('base')], 'xts'],
  ['aead', [file('.di-encfs', integrity()), file('PG_VERSION')], 'aead'],
  ['reserved', [file('.di-encfs', RESERVATION)], 'reserved'],
  ['reserved-lf', [dir('lost+found'), file('.di-encfs', RESERVATION)], 'reserved'],
  ['reserved-data', [file('.di-encfs', RESERVATION), file('PG_VERSION')], 'other'],
  ['reserved-tmp', [file('.di-encfs', RESERVATION), file('.di-encfs.tmp')], 'other'],
  ['bad-flags', [file('.di-encfs', integrity(0x07))], 'other'],
  ['reservation-kcv', [file('.di-encfs', integrity(0x03))], 'other'],
  ['short', [file('.di-encfs', 'short')], 'other'],
  ['long', [file('.di-encfs', Buffer.concat([integrity(), Buffer.from([0])]))], 'other'],
  ['xts-long', [file('.di-encfs', Buffer.concat([xts(), Buffer.from([1])]))], 'other'],
  ['other-magic', [file('.di-encfs', Buffer.from(`DIPGKEY3${'0'.repeat(17)}`))], 'other'],
  ['marker-link', [link('.di-encfs')], 'other'],
  ['tmp-link', [file('.di-encfs', xts()), link('.di-encfs.tmp')], 'other'],
  ['tmp-dir', [file('.di-encfs', xts()), dir('.di-encfs.tmp')], 'other'],
  ['marker-dir', [dir('.di-encfs')], 'other'],
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.chmodSync(root, 0o755);
    for (const entry of fs.readdirSync(root)) {
      const at = path.join(root, entry);
      if (!fs.lstatSync(at).isSymbolicLink()) fs.chmodSync(at, 0o755);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function workspace(fixtures: [string, Build[]][] = []) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'storage-mode-'));
  roots.push(base);
  const root = path.join(base, 'workloads');
  fs.mkdirSync(root);
  for (const [name, builds] of fixtures) dir(name, ...builds)(root);
  return { base, root, log: path.join(base, 'termination-log') };
}

function run(
  args: { root: string; log: string; keys?: string[]; reserve?: string[]; mounts?: string },
  fsImpl: typeof fs = fs,
) {
  const lines: string[] = [];
  const sys: StorageModeSystem = {
    fs: fsImpl,
    print: (line) => lines.push(line),
    at: (_fd, at) => at,
    terminationLog: args.log,
  };
  const code = storageMode(
    [
      `--root=${args.root}`,
      `--mounts=${args.mounts ?? args.root}`,
      `--keys=${(args.keys ?? []).join(',')}`,
      `--reserve=${(args.reserve ?? []).join(',')}`,
    ],
    sys,
  );
  return { code, lines };
}

const classes = (lines: string[]) =>
  Object.fromEntries(
    lines.slice(0, -1).map((line) => line.split(' ') as [string, string]),
  ) as Record<string, string>;

describe('storage-mode classification (#200)', () => {
  it('classifies every fixture directory the way the backup agent does', async () => {
    const { root, log } = workspace(FIXTURES.map(([name, builds]) => [name, builds]));
    const { code, lines } = run({ root, log });
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe(`done count=${FIXTURES.length}`);
    const found = classes(lines);
    for (const [name, , expected] of FIXTURES) {
      expect(`${name} ${found[name]}`).toBe(`${name} ${expected}`);
      const at = path.join(root, name);
      const entries = fs.readdirSync(at, { withFileTypes: true }).map((entry) => ({
        path: entry.name,
        type: entry.isSymbolicLink()
          ? ('symlink' as const)
          : entry.isDirectory()
            ? ('directory' as const)
            : ('file' as const),
      }));
      const agent = await classifyDirectory(entries, async () =>
        fs.readFileSync(path.join(at, '.di-encfs')),
      );
      const named = { integrity: 'aead', corrupt: 'other' }[agent as string] ?? agent;
      expect(`${name} ${named}`).toBe(`${name} ${expected}`);
    }
    expect(fs.existsSync(log)).toBe(false);
  });

  it('lists only storage-key directories under the root and reports links there as other', () => {
    const { root, log } = workspace([['mesh', []]]);
    fs.symlinkSync(path.join(root, 'mesh'), path.join(root, 'linked'));
    fs.writeFileSync(path.join(root, 'stray'), 'x');
    fs.mkdirSync(path.join(root, 'mesh.replaced-20261029T000000Z'));
    fs.mkdirSync(path.join(root, 'Upper'));
    fs.mkdirSync(path.join(root, 'a'.repeat(51)));
    const { code, lines } = run({ root, log });
    expect(code).toBe(0);
    expect(lines).toEqual([
      'linked other link',
      'mesh empty',
      'stray other not a directory',
      'done count=3',
    ]);
  });
});

describe('storage-mode reservation (#200)', () => {
  it('reserves an empty directory on the list and nothing else', () => {
    const { root, log } = workspace([
      ['pg', [dir('lost+found')]],
      ['busy', [file('PG_VERSION')]],
      ['plain', []],
    ]);
    // In the pod each key has its own mount; here the workloads root stands in for them.
    const { code, lines } = run({ root, log, keys: ['pg', 'busy'], reserve: ['pg', 'busy'] });
    expect(code).toBe(0);
    expect(lines).toEqual(['pg reserved', 'busy unencrypted', 'plain empty', 'done count=3']);
    expect(fs.readFileSync(path.join(root, 'pg', '.di-encfs'))).toEqual(RESERVATION);
    expect(fs.existsSync(path.join(root, 'pg', '.di-encfs.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'busy', '.di-encfs'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'plain', '.di-encfs'))).toBe(false);
    // A second run finds the reservation and leaves it alone.
    expect(run({ root, log, keys: ['pg'], reserve: ['pg'] }).lines[0]).toBe('pg reserved');
    expect(fs.readFileSync(path.join(root, 'pg', '.di-encfs'))).toEqual(RESERVATION);
  });

  it('refuses a reserve-list key with a link at a marker name, finishes the listing and exits 1', () => {
    const { root, log } = workspace([
      ['pg', [link('.di-encfs.tmp', '/tmp/elsewhere')]],
      ['other', []],
    ]);
    const { code, lines } = run({ root, log, keys: ['pg'], reserve: ['pg'] });
    expect(code).toBe(1);
    expect(lines).toEqual([
      'pg other non-regular entry at a marker name',
      'other empty',
      'done count=2',
    ]);
    expect(fs.readFileSync(log, 'utf8')).toBe(
      'pg: non-regular entry at a marker name; not reserved',
    );
    expect(fs.lstatSync(path.join(root, 'pg', '.di-encfs.tmp')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(root, 'pg', '.di-encfs'))).toBe(false);
  });

  it('fails when a reservation cannot be written', () => {
    const { root, log } = workspace([['pg', []]]);
    fs.chmodSync(path.join(root, 'pg'), 0o555);
    const { code, lines } = run({ root, log, keys: ['pg'], reserve: ['pg'] });
    expect(code).toBe(1);
    expect(lines[0]).toBe('pg empty reservation failed EACCES');
    expect(fs.readFileSync(log, 'utf8')).toBe('pg: reservation could not be written (EACCES)');
  });

  it('reports an unreadable directory, and fails only for a reserve-list key', () => {
    const { root, log } = workspace();
    const quiet = run({ root, log, keys: ['gone'] });
    expect(quiet).toEqual({ code: 0, lines: ['gone other unreadable ENOENT', 'done count=1'] });
    const loud = run({ root, log, keys: ['gone'], reserve: ['gone'] });
    expect(loud.code).toBe(1);
    expect(fs.readFileSync(log, 'utf8')).toBe('gone: directory unreadable (ENOENT)');
  });

  it('fails when the workloads root is unreadable, even without a termination log', () => {
    const { base, log } = workspace();
    const missing = path.join(base, 'missing');
    expect(run({ root: missing, log })).toEqual({ code: 1, lines: ['done count=0'] });
    expect(fs.readFileSync(log, 'utf8')).toBe('workloads root: unreadable (ENOENT)');
    expect(run({ root: missing, log: path.join(base, 'no', 'log') }).code).toBe(1);
  });

  it('treats a marker that is not a regular file once opened, or a failing listing, as other', () => {
    const { root, log } = workspace([
      ['pg', [file('.di-encfs', xts())]],
      ['x', []],
    ]);
    const notRegular = {
      ...fs,
      fstatSync: () => ({ isFile: () => false }),
    } as unknown as typeof fs;
    expect(run({ root, log, keys: ['pg'], reserve: ['pg'] }, notRegular).lines[0]).toBe(
      'pg other non-regular entry at a marker name',
    );
    expect(run({ root, log, keys: ['pg'] }, notRegular).code).toBe(0);
    let calls = 0;
    const failingList = {
      ...fs,
      readdirSync: ((at: string, options: unknown) => {
        // The root listing succeeds; each key's listing then fails.
        if (calls++ > 0) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return fs.readdirSync(at, options as { withFileTypes: true });
      }) as typeof fs.readdirSync,
    } as typeof fs;
    const failed = run({ root, log, reserve: ['x'] }, failingList);
    expect(failed.lines).toEqual([
      'pg other unreadable EIO',
      'x other unreadable EIO',
      'done count=2',
    ]);
    expect(failed.code).toBe(1);
    const thrown = {
      ...fs,
      readdirSync: () => {
        throw 'plain';
      },
    } as unknown as typeof fs;
    expect(run({ root, log }, thrown).code).toBe(1);
  });
});

describe('storage-mode command', () => {
  it('renders the program from its own source for Node', () => {
    const [node, flag, source] = storageModeCommand();
    expect([node, flag]).toEqual(['node', '-e']);
    expect(source).toContain('function storageMode(');
    expect(source).toContain("'/proc/self/fd/' + fd");
    expect(source).toContain("terminationLog: '/dev/termination-log'");
    // It parses as a script on its own: nothing outside the function is referenced.
    expect(() => new Function('require', 'process', source as string)).not.toThrow();
  });

  // The init container's exact command and args, run by a real Node. It reaches entries through
  // `/proc/self/fd`, so it runs where that exists (Linux, as in CI and in the pod).
  it.skipIf(process.platform !== 'linux')(
    'runs as the rendered init container with Node (C1)',
    () => {
      const node = Bun.which('node');
      expect(node).toBeTruthy();
      const work = fs.mkdtempSync(path.join(tmpdir(), 'pr563-storage-mode-'));
      try {
        const root = path.join(work, 'root');
        fs.mkdirSync(root);
        fs.mkdirSync(path.join(root, 'db'));
        fs.mkdirSync(path.join(root, 'act'));
        fs.writeFileSync(path.join(root, 'act', 'data'), 'x');
        fs.mkdirSync(path.join(root, 'old'));
        fs.writeFileSync(path.join(root, 'old', '.di-encfs'), xts());
        const tenant = { metadata: { name: 'alpha', uid: 'alpha-uid' }, spec: {} } as Tenant;
        const cfg = { installation: 'test', namespace: 'wasmcloud' } as ControllerConfig;
        const run = (keys: string[], reserve: string[]) => {
          const step = hostStorage(tenant, cfg, keys, reserve).initContainers.find(
            (c) => c.name === 'storage-mode',
          ) as { command: string[]; args: string[] };
          // Only the mount points move into the temporary workspace; the argv stays as rendered.
          const args = step.args.map((arg) =>
            arg.replace(WORKLOADS_ROOT_MOUNT, root).replace(HOST_MOUNT_ROOT, root),
          );
          const [, ...rest] = step.command;
          const out = Bun.spawnSync([node as string, ...rest, ...args], { cwd: work });
          return {
            code: out.exitCode,
            stdout: out.stdout.toString(),
            stderr: out.stderr.toString(),
          };
        };
        const ok = run(['act', 'db'], ['db']);
        expect(ok.stderr).toBe('');
        expect(ok.stdout).toBe('act unencrypted\ndb reserved\nold xts\ndone count=3\n');
        expect(ok.code).toBe(0);
        expect(fs.readFileSync(path.join(root, 'db', '.di-encfs'))).toEqual(RESERVATION);
        expect(fs.statSync(path.join(root, 'db', '.di-encfs')).mode & 0o777).toBe(0o600);
        // A refusal: a directory at the marker name of a key to reserve.
        fs.mkdirSync(path.join(root, 'pg'));
        fs.mkdirSync(path.join(root, 'pg', '.di-encfs'));
        const refused = run(['pg'], ['pg']);
        expect(refused.stdout).toContain('pg other non-regular entry at a marker name\n');
        expect(refused.code).not.toBe(0);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
  );
});
