import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import {
  defaultPostrenderDir,
  natsPostrenderer,
  natsPostrenderScript,
  runNatsPostrender,
  stripNatsDebugArgs,
} from '../src/nats-log-level';
import { RUNTIME_OPERATOR_RENDER } from './fixtures/runtime-operator-render';

const root = join(import.meta.dir, '..');
const built = join(root, 'dist/nats-log-level.js');
const NATS_ARGS = ['-c', '/nats-config/nats-server.conf'];

// biome-ignore lint/suspicious/noExplicitAny: parsed manifests
const containers = (doc: any) => doc.spec.template.spec.containers;
const documents = (text: string) => text.split(/^(?=---[ \t]*$)/m);
const natsDocument = (text: string) =>
  documents(text).findIndex((d) =>
    d.includes('# Source: runtime-operator/templates/nats/deployment.yaml'),
  );
const scratch = () => mkdtempSync(join(tmpdir(), 'nats-postrender-'));

test('the chart renders its scheduler NATS with -DV', () => {
  const doc = documents(RUNTIME_OPERATOR_RENDER)[natsDocument(RUNTIME_OPERATOR_RENDER)] as string;
  expect(containers(loadAll(doc)[0])[0].args).toEqual(['-DV', ...NATS_ARGS]);
});

test('only the scheduler NATS Deployment changes: its debug and trace args go, the rest stays', () => {
  const out = stripNatsDebugArgs(RUNTIME_OPERATOR_RENDER);
  const before = documents(RUNTIME_OPERATOR_RENDER);
  const after = documents(out);
  const nats = natsDocument(RUNTIME_OPERATOR_RENDER);
  expect(after).toHaveLength(before.length);
  // Every other document byte for byte, comments included.
  for (const [i, doc] of before.entries()) if (i !== nats) expect(after[i]).toBe(doc);
  const patched = after[nats] as string;
  expect(
    patched.startsWith('---\n# Source: runtime-operator/templates/nats/deployment.yaml\n'),
  ).toBe(true);
  const [original] = loadAll(before[nats] as string);
  containers(original)[0].args = NATS_ARGS;
  expect(loadAll(patched)[0]).toEqual(original);
});

test('every debug and trace spelling is removed; other args, containers and kinds are kept', () => {
  const flags = ['-D', '-V', '-DV', '-VD', '-VV', '-DVV', '-VVD', '--debug', '--trace'];
  const forms = ['--debug=true', '--trace=false', '-D=true', '-V=1'];
  const spec = (list: unknown[]) => ({ template: { spec: { containers: list } } });
  const docs = [
    {
      kind: 'Deployment',
      spec: spec([
        { name: 'nats', args: [...flags, ...forms, '-js', '-c', '/c.conf', '--debugx'] },
        { name: 'sidecar', args: ['-DV'] },
        { name: 'nats' },
      ]),
    },
    { kind: 'StatefulSet', spec: spec([{ name: 'nats', args: ['-DV'] }]) },
    { kind: 'Deployment', spec: spec([{ name: 'nats', args: ['-js'] }]) },
    { kind: 'Deployment', metadata: { name: 'empty' } },
  ];
  const input = `${docs.map((doc) => `---\n${JSON.stringify(doc)}\n`).join('')}---\n# only a comment\n`;
  const chunks = documents(stripNatsDebugArgs(input));
  expect(containers(loadAll(chunks[0] as string)[0])).toEqual([
    { name: 'nats', args: ['-js', '-c', '/c.conf', '--debugx'] },
    { name: 'sidecar', args: ['-DV'] },
    { name: 'nats' },
  ]);
  expect(chunks.slice(1)).toEqual(documents(input).slice(1));
});

test('the post-render entry reads stdin and writes the patched render', () => {
  let out = '';
  runNatsPostrender(
    () => RUNTIME_OPERATOR_RENDER,
    (text) => {
      out = text;
    },
  );
  expect(out).toBe(stripNatsDebugArgs(RUNTIME_OPERATOR_RENDER));
});

test('the script is a /bin/sh wrapper with the runtime and module quoted', () => {
  expect(natsPostrenderScript("/opt/it's here/m.js", '/usr/local/my node')).toBe(
    `#!/bin/sh\nexec '/usr/local/my node' -e 'require("/opt/it'\\''s here/m.js").runNatsPostrender()'\n`,
  );
});

test('the post-renderer lives in a per-user cache directory', () => {
  expect(defaultPostrenderDir({ XDG_CACHE_HOME: '/c' })).toBe('/c/di-framework-platform');
  expect(defaultPostrenderDir({})).toBe(join(homedir(), '.cache', 'di-framework-platform'));
  expect(defaultPostrenderDir()).toBe(defaultPostrenderDir(process.env));
});

test('the generated post-renderer is a stable, private executable that patches a Helm render', () => {
  const dir = join(scratch(), 'cache');
  const path = natsPostrenderer({ dir, module: built, runtime: 'node' });
  expect(path).toMatch(/\/nats-postrender-[0-9a-f]{16}$/);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o700);
  // Same install: same path, so the Release has no diff; no temp files are left behind.
  expect(natsPostrenderer({ dir, module: built, runtime: 'node' })).toBe(path);
  // Another install's module: another path; both stay valid.
  const other = natsPostrenderer({ dir, module: '/elsewhere/nats-log-level.js', runtime: 'node' });
  expect(other).not.toBe(path);
  expect(readdirSync(dir).sort()).toEqual([path, other].map((p) => p.slice(dir.length + 1)).sort());
  const out = execFileSync(path, { input: RUNTIME_OPERATOR_RENDER, encoding: 'utf8' });
  expect(out).toBe(stripNatsDebugArgs(RUNTIME_OPERATOR_RENDER));
  expect(natsPostrenderer().startsWith(defaultPostrenderDir())).toBe(true);
});

test('concurrent writers of the same script never expose a partial file', async () => {
  const dir = scratch();
  const path = natsPostrenderer({ dir, module: built, runtime: 'node' });
  const script = readFileSync(path, 'utf8');
  const writer = `const { natsPostrenderer } = require(${JSON.stringify(built)});
    for (let i = 0; i < 300; i++) natsPostrenderer({ dir: ${JSON.stringify(dir)}, module: ${JSON.stringify(built)}, runtime: 'node' });`;
  const done = [0, 1].map(
    () =>
      new Promise<number | null>((resolve) =>
        spawn('node', ['-e', writer], { stdio: 'inherit' }).on('exit', resolve),
      ),
  );
  let running = true;
  const all = Promise.all(done).finally(() => {
    running = false;
  });
  let reads = 0;
  while (running) {
    expect(readFileSync(path, 'utf8')).toBe(script);
    reads++;
    await Bun.sleep(0);
  }
  expect(await all).toEqual([0, 0]);
  expect(reads).toBeGreaterThan(0);
  expect(readdirSync(dir)).toEqual([path.slice(dir.length + 1)]);
});

test('a symlinked, foreign-owned or shared directory is refused', () => {
  const base = scratch();
  const real = join(base, 'real');
  mkdirSync(real, { mode: 0o700 });
  const link = join(base, 'link');
  symlinkSync(real, link);
  expect(() => natsPostrenderer({ dir: link })).toThrow('is not a directory (symlink?)');
  const uid = (process.getuid?.() ?? 0) + 1;
  expect(() => natsPostrenderer({ dir: real, uid })).toThrow(`owned by uid ${uid - 1}`);
  chmodSync(real, 0o777);
  expect(() => natsPostrenderer({ dir: real })).toThrow('writable by group or others');
  expect(readdirSync(real)).toEqual([]);
});
