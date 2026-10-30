import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #294: invalid platform input fails before an entrypoint registers its first cluster resource.

const root = join(import.meta.dir, '..');

/** Invalid inputs, each paired with the message `createPlatform` has always refused it with. */
const INVALID: [Record<string, unknown>, string][] = [
  [{ tenants: [{ name: 'Bad Name' }] }, 'tenants must be an array with valid names'],
  [
    { runtimeNats: { maxMemoryStore: '1Gi' } },
    'runtimeNats.maxMemoryStore must be at most 64Mi, half the di-nats memory limit (128Mi)',
  ],
  [{ insecureRegistries: ['http://registry.example:5000'] }, 'insecureRegistries entries must be'],
  [{ routeAliases: JSON.stringify('site.alpha') }, 'routeAliases must be an object'],
  [
    { tenantAuth: { image: 'ghcr.io/x/y:latest', issuer: 'https://issuer.example' } },
    'tenantAuth.image must be pinned by digest',
  ],
];

function projectConfig(config: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      `project:${key}`,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
}

/**
 * Loads a packaged entrypoint (`dist/local` or `dist/existing`) under Pulumi mocks and returns its
 * error, if any, and every resource it registered, providers included.
 */
function runEntrypoint(
  entrypoint: string,
  config: Record<string, string>,
): { error?: string; resources: { type: string; name: string }[] } {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const resources = [];
    pulumi.runtime.setAllConfig(${JSON.stringify(config)});
    pulumi.runtime.setMocks({
      newResource: a => { resources.push({ type: a.type, name: a.name }); return {id:a.name, state:{...a.inputs, stdout:'', metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}; },
      call: a => a.inputs,
    }, 'project', 'test', false);
    let error;
    pulumi.runtime.runInPulumiStack(async () => {
      try { require(${JSON.stringify(entrypoint)}); } catch (e) { error = e.message; }
    }).then(async () => {
      // Waits for every registration still in flight, the provider's included.
      await pulumi.runtime.disconnect();
      console.log(JSON.stringify({ error, resources: resources.filter(r => !r.type.startsWith('pulumi:pulumi:')) }));
    }).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(output.trim().split('\n').at(-1) as string);
}

test('validatePlatformConfig refuses invalid input without registering or logging anything', () => {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const resources = [];
    const logged = [];
    for (const level of ['warn', 'info', 'error']) pulumi.log[level] = m => logged.push(m);
    pulumi.runtime.setMocks({
      newResource: a => { resources.push(a.name); return {id:a.name, state:a.inputs}; },
      call: a => a.inputs,
    }, 'project', 'test', false);
    const { validatePlatformConfig } = require('./dist');
    const cases = ${JSON.stringify(INVALID.map(([config]) => projectConfig(config)))};
    const errors = cases.map(config => {
      pulumi.runtime.setAllConfig(config);
      try { validatePlatformConfig({ installation: 'di-test', config: new pulumi.Config() }); }
      catch (e) { return e.message; }
    });
    console.log(JSON.stringify({ errors, resources, logged }));
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const { errors, resources, logged } = JSON.parse(output);
  INVALID.forEach(([, message], index) => {
    expect(errors[index]).toContain(message);
  });
  expect(resources).toEqual([]);
  expect(logged).toEqual([]);
}, 60_000);

test('validatePlatformConfig normalizes valid input and returns warnings instead of logging', () => {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const logged = [];
    pulumi.log.warn = m => logged.push(m);
    pulumi.runtime.setAllConfig(${JSON.stringify(
      projectConfig({
        tenants: [{ name: 'identity' }, { name: 'identity-pg' }],
        routeAliases: { 'API.identity': 'api.identity-pg' },
      }),
    )});
    const v = require('./dist').validatePlatformConfig({
      installation: 'di-test',
      registry: true,
      insecureRegistry: true,
      routeUrlPattern: 'http://{host}.{tenant}.localhost:28180',
    });
    console.log(JSON.stringify({ namespace: v.namespace, tenants: v.declared.tenants.map(t => t.name), routeAliases: v.routeAliases, routeUrlPattern: v.routeUrlPattern, insecureRegistries: v.insecureRegistries, warnings: v.warnings, logged }));
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const validated = JSON.parse(output);
  expect(validated.namespace).toBe('wasmcloud');
  expect(validated.tenants).toEqual(['identity', 'identity-pg']);
  expect(validated.routeAliases).toEqual({ 'api.identity': 'api.identity-pg' });
  expect(validated.routeUrlPattern).toBe('http://{host}.{tenant}.localhost:28180');
  expect(validated.insecureRegistries).toEqual([
    'di-framework-registry.wasmcloud.svc.cluster.local:5000',
  ]);
  expect(validated.warnings).toEqual([]);
  expect(validated.logged).toEqual([]);
}, 60_000);

test('local entrypoint refuses invalid platform input before creating the cluster (#294)', () => {
  for (const [config, message] of INVALID) {
    const { error, resources } = runEntrypoint('./dist/local', projectConfig(config));
    expect(error).toContain(message);
    // No container network, volume, k0s container, kubeconfig, or provider.
    expect(resources).toEqual([]);
  }
}, 120_000);

// Valid input: the local and existing entrypoint tests in platform.test.ts provision unchanged.

test('existing-cluster entrypoint refuses invalid platform input before its provider (#294)', () => {
  const kubeconfigFile = join(mkdtempSync(join(tmpdir(), 'existing-294-')), 'config');
  writeFileSync(
    kubeconfigFile,
    [
      'apiVersion: v1',
      'kind: Config',
      'current-context: c',
      'clusters:',
      '- name: c',
      '  cluster:',
      '    server: https://127.0.0.1:6443',
      'users:',
      '- name: u',
      '  user:',
      '    token: admin-token',
      'contexts:',
      '- name: c',
      '  context:',
      '    cluster: c',
      '    user: u',
      '',
    ].join('\n'),
  );
  for (const [config, message] of INVALID) {
    const { error, resources } = runEntrypoint(
      './dist/existing',
      projectConfig({ kubeconfig: kubeconfigFile, ...config }),
    );
    expect(error).toContain(message);
    expect(resources).toEqual([]);
  }
}, 120_000);

test('validatePlatformConfig refuses a chartVersion other than the pinned operator version (#541 m6a)', () => {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    pulumi.runtime.setAllConfig({});
    const { validatePlatformConfig } = require('./dist');
    const run = chartVersion => {
      try { validatePlatformConfig({ installation: 'di-test', config: new pulumi.Config(), chartVersion }); }
      catch (e) { return e.message; }
      return 'ok';
    };
    console.log(JSON.stringify({ pinned: run('2.8.0'), unset: run(undefined), other: run('2.9.0') }));
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  expect(JSON.parse(output)).toEqual({
    pinned: 'ok',
    unset: 'ok',
    other:
      'chartVersion must be 2.8.0, the runtime-operator version whose image is pinned (got 2.9.0)',
  });
}, 60_000);

test('the generated project runs the packaged local entrypoint, so it validates first too', () => {
  const template = readFileSync(join(root, 'assets/platform/index.ts.tmpl'), 'utf8');
  const code = template.split('\n').filter((line) => line.trim() && !line.trim().startsWith('//'));
  expect(code).toHaveLength(1);
  expect(code[0]).toMatch(/^export \{[^}]+\} from '@di-framework\/platform\/local';$/);
});
