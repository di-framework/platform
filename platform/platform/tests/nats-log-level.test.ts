import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { natsPostrenderer, runNatsPostrender, stripNatsDebugArgs } from '../src/nats-log-level';

const root = join(import.meta.dir, '..');
const chartNats = readFileSync(
  join(import.meta.dir, 'fixtures/runtime-operator-nats-deployment.yaml'),
  'utf8',
);

// biome-ignore lint/suspicious/noExplicitAny: parsed manifests
const containers = (doc: any) => doc.spec.template.spec.containers;

test('the chart renders its scheduler NATS with -DV', () => {
  const [deployment] = loadAll(chartNats);
  expect(containers(deployment)[0].args).toEqual(['-DV', '-c', '/nats-config/nats-server.conf']);
});

test('the scheduler NATS Deployment loses only its debug and trace args', () => {
  const [deployment] = loadAll(stripNatsDebugArgs(chartNats));
  const [original] = loadAll(chartNats);
  expect(containers(deployment)[0].args).toEqual(['-c', '/nats-config/nats-server.conf']);
  containers(original)[0].args = ['-c', '/nats-config/nats-server.conf'];
  expect(deployment).toEqual(original);
});

test('every debug and trace spelling is removed; other args, containers and kinds are kept', () => {
  const flags = ['-D', '-V', '-DV', '-VD', '-VV', '-DVV', '-VVD', '--debug', '--trace'];
  const spec = (list: unknown[]) => ({ template: { spec: { containers: list } } });
  const input = [
    {
      kind: 'Deployment',
      spec: spec([
        { name: 'nats', args: [...flags, '-js', '-c', '/c.conf'] },
        { name: 'sidecar', args: ['-DV'] },
        { name: 'nats' },
      ]),
    },
    { kind: 'StatefulSet', spec: spec([{ name: 'nats', args: ['-DV'] }]) },
    { kind: 'Deployment', metadata: { name: 'empty' } },
  ]
    .map((doc) => JSON.stringify(doc))
    .join('\n---\n')
    .concat('\n---\n');
  // biome-ignore lint/suspicious/noExplicitAny: parsed manifests
  const [deployment, statefulSet, empty] = loadAll(stripNatsDebugArgs(input)) as any[];
  expect(containers(deployment)).toEqual([
    { name: 'nats', args: ['-js', '-c', '/c.conf'] },
    { name: 'sidecar', args: ['-DV'] },
    { name: 'nats' },
  ]);
  expect(containers(statefulSet)[0].args).toEqual(['-DV']);
  expect(empty).toEqual({ kind: 'Deployment', metadata: { name: 'empty' } });
});

test('the post-render entry reads stdin and writes the patched render', () => {
  let out = '';
  runNatsPostrender(
    () => chartNats,
    (text) => {
      out = text;
    },
  );
  expect(out).toBe(stripNatsDebugArgs(chartNats));
});

test('the generated post-renderer is an executable that patches a Helm render', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nats-postrender-'));
  const path = natsPostrenderer(dir, join(root, 'dist/nats-log-level.js'));
  expect(path).toBe(join(dir, 'nats-postrender'));
  expect(statSync(path).mode & 0o111).toBe(0o111);
  expect(readFileSync(path, 'utf8').split('\n')[0]).toBe(`#!${process.execPath}`);
  const node = natsPostrenderer(dir, join(root, 'dist/nats-log-level.js'), 'node');
  const [, script = ''] = readFileSync(node, 'utf8').split('\n');
  const out = execFileSync('node', ['-e', script], { input: chartNats, encoding: 'utf8' });
  expect(containers(loadAll(out)[0])[0].args).toEqual(['-c', '/nats-config/nats-server.conf']);
  expect(natsPostrenderer()).toBe(join(tmpdir(), 'di-framework-platform', 'nats-postrender'));
});
