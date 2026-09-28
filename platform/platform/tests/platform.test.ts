import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { platformValues } from '../src/values';

const root = join(import.meta.dir, '..');

test('administrator overrides cannot enable shared hosts or escape watched namespaces', () => {
  const defaults = {
    operator: { allowSharedHosts: false, hostNamespaces: ['wasmcloud', 'di-runtime-alpha'] },
    runtime: { resources: { limits: { memory: '2Gi' }, requests: { cpu: '250m' } } },
  };
  const values = platformValues(
    {
      operator: { allowSharedHosts: true, hostNamespaces: ['other'] },
      runtime: { resources: { limits: { memory: '3Gi' } } },
    },
    defaults,
  );
  expect(values.operator).toEqual(defaults.operator);
  expect(values.runtime).toEqual({
    resources: { limits: { memory: '3Gi' }, requests: { cpu: '250m' } },
  });
  expect(platformValues({ operator: null }, defaults).operator).toEqual(defaults.operator);
  expect(() => platformValues(JSON.parse('{"__proto__":{}}'), defaults)).toThrow(
    'Invalid values key',
  );
});

test('published implementation provisions tenancy and isolation for an existing cluster', () => {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    const resources = [];
    pulumi.runtime.setAllConfig({'project:tenants': JSON.stringify([{name:'alpha'}]), 'project:users': JSON.stringify([{name:'alice',memberships:[{tenant:'alpha',role:'developer'}]}])});
    pulumi.runtime.setMocks({
      newResource: args => { resources.push(args); return {id:args.name, state:{...args.inputs, metadata:{...args.inputs.metadata, name:args.inputs.metadata?.name ?? args.name}}}; },
      call: args => args.inputs,
    }, 'project', 'test', false);
    pulumi.runtime.runInPulumiStack(async () => {
      const {createPlatform} = require('./dist');
      const platform = createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', httpNodePort:30080, storageRoot:'/var/lib/kubesolo', insecureRegistry:false, networkPolicyEngine:'kube-router' });
      await platform.namespace.promise();
      await Promise.all(platform.users.map(u => u.promise()));
    }).then(() => { console.log(JSON.stringify(resources)); }).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const resources = JSON.parse(output) as { type: string; name: string; inputs: any }[];
  const release = resources.find((r) => r.type === 'kubernetes:helm.sh/v3:Release');
  expect(release?.inputs.values.operator).toEqual({
    allowSharedHosts: false,
    hostNamespaces: ['wasmcloud', 'di-runtime-alpha'],
  });
  expect(release?.inputs.values.runtime.extraArgs).toEqual([]);
  const firewall = resources.find((r) => r.type === 'kubernetes:apps/v1:DaemonSet');
  expect(firewall?.inputs.spec.template.spec.containers[0].args).toEqual([
    '--run-router=false',
    '--run-service-proxy=false',
    '--run-firewall=true',
  ]);
  expect(resources.some((r) => r.name === 'oci-registry')).toBe(false);
  expect(
    resources.some((r) => r.name === 'customresourcedefinition-tenants.platform.di-framework.dev'),
  ).toBe(true);
  const controller = resources.find((r) => r.name === 'deployment-di-platform-controller');
  const cfg = JSON.parse(controller?.inputs.spec.template.spec.containers[0].env[0].value);
  expect(cfg.storageRoot).toBe('/var/lib/kubesolo');
  expect(cfg.insecureRegistry).toBe(false);
  const scripts = resources.find((r) => r.name === 'configmap-di-platform-controller')?.inputs.data;
  expect(scripts['controller.js']).toContain('class Controller');
  expect(scripts['resources.js']).toContain('tenantResources');
  expect(scripts['backing-services.js']).toContain('BackingServiceClass');
  expect(scripts['backing-service-reconcile.js']).toContain('di-bs-');
  expect(scripts['service-binding-reconcile.js']).toContain('di-binding-');
  expect(scripts['resources.js']).toMatch(/require\(["'].\/backing-services["']\)/);
  expect(scripts['controller.js']).toMatch(/require\(["'].\/backing-service-reconcile["']\)/);
  expect(scripts['controller.js']).toMatch(/require\(["'].\/service-binding-reconcile["']\)/);
  expect(resources.some((r) => r.name === 'backingserviceclass-keyvalue-redis')).toBe(true);
  expect(resources.some((r) => r.name === 'backingserviceclass-messaging-nats')).toBe(true);
  const role = resources.find((r) => r.name === 'clusterrole-di-test-controller');
  expect(role?.inputs.rules[0].resources).toEqual(
    expect.arrayContaining([
      'backingserviceclasses',
      'backingservices',
      'servicebindings',
      'backingserviceclasses/status',
      'backingservices/finalizers',
    ]),
  );
  expect(
    resources.some(
      (r) => r.name === 'customresourcedefinition-backingserviceclasses.platform.di-framework.dev',
    ),
  ).toBe(true);
  expect(resources.find((r) => r.name === 'http-entrypoint')?.inputs.spec.ports[0].nodePort).toBe(
    30080,
  );
}, 60_000);

test('local entrypoint retains existing logical names and guarded Docker cleanup', () => {
  const local = readFileSync(join(root, 'src/local.ts'), 'utf8');
  expect(local).toContain('createPlatform({');
  expect(local).toContain("'runtime-shutdown'");
  expect(local).toContain('delete deployment/hostgroup-default');
  expect(local).toContain('Refusing to replace existing container');
  expect(local.match(/Logging\.None/g)).toHaveLength(2);
});

test('local packaged entrypoint provisions Docker and the shared platform', () => {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const resources = [];
    pulumi.runtime.setMocks({
      newResource: a => { resources.push(a); return {id:a.name, state:{...a.inputs, stdout:'test-kubeconfig', metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}; },
      call: a => a.inputs,
    }, 'project', 'test', false);
    pulumi.runtime.runInPulumiStack(() => require('./dist/local')).then(async () => { await pulumi.runtime.disconnect(); console.log(JSON.stringify(resources)); }).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const resources = JSON.parse(output) as { type: string; name: string; inputs: any }[];
  expect(
    resources.find((r) => r.name === 'k0s' && r.type.startsWith('command:'))?.inputs.create,
  ).toContain('docker run -d');
  expect(resources.some((r) => r.name === 'oci-registry')).toBe(true);
  expect(resources.find((r) => r.name === 'http-entrypoint')?.inputs.spec.ports[0].nodePort).toBe(
    30180,
  );
  expect(
    resources.find((r) => r.type === 'kubernetes:helm.sh/v3:Release')?.inputs.values.operator
      .allowSharedHosts,
  ).toBe(false);
  expect(resources.some((r) => r.type === 'kubernetes:apps/v1:DaemonSet')).toBe(false);
}, 60_000);
