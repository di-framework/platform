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
      const platform = createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', httpNodePort:30080, routeUrlPattern:'http://{host}.{tenant}.localhost:28080', storageRoot:'/var/lib/kubesolo', insecureRegistry:false, networkPolicyEngine:'kube-router' });
      await platform.namespace.promise();
      await Promise.all(platform.users.map(u => u.promise()));
      if (platform.kubeconfigs !== undefined) throw new Error('kubeconfigs without apiServer');
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
  const backend = resources.find((r) => r.name === 'http-entrypoint')?.inputs.spec;
  expect(backend.type).toBe('ClusterIP');
  expect(backend.ports[0]).toEqual({ name: 'http', port: 80, targetPort: 9191, protocol: 'TCP' });
  const gateway = (type: string) =>
    resources.find((r) => r.name === 'http-gateway' && r.type === type)?.inputs;
  const service = gateway('kubernetes:core/v1:Service');
  expect(service.metadata.name).toBe('di-platform-gateway');
  expect(service.spec.type).toBe('NodePort');
  expect(service.spec.ports[0].nodePort).toBe(30080);
  expect(gateway('kubernetes:core/v1:ConfigMap').data['gateway.js']).toContain(
    'function routeRequest',
  );
  const deployment = gateway('kubernetes:apps/v1:Deployment');
  expect(deployment.spec.template.spec.automountServiceAccountToken).toBe(false);
  expect(deployment.spec.template.metadata.annotations['di-framework.dev/script-hash']).toMatch(
    /^[0-9a-f]{64}$/,
  );
  const policy = gateway('kubernetes:networking.k8s.io/v1:NetworkPolicy');
  expect(policy.spec.egress[1].to[1].namespaceSelector.matchLabels).toEqual({
    'platform.di-framework.dev/installation': 'di-test',
  });
  expect(cfg.routeUrlPattern).toBe('http://{host}.{tenant}.localhost:28080');
}, 60_000);

test('existing entrypoint derives the route pattern from a loopback HTTP endpoint', () => {
  const run = (config: Record<string, string>) =>
    JSON.parse(
      execFileSync(
        'node',
        [
          '-e',
          `
    const pulumi = require('@pulumi/pulumi');
    pulumi.runtime.setAllConfig(${JSON.stringify(
      Object.fromEntries(
        Object.entries({ kubeconfig: join(root, 'package.json'), ...config }).map(([k, v]) => [
          `project:${k}`,
          v,
        ]),
      ),
    )});
    pulumi.runtime.setMocks({
      newResource: a => ({id:a.name, state:{...a.inputs, metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}),
      call: a => a.inputs,
    }, 'project', 'test', false);
    pulumi.runtime.runInPulumiStack(async () => require('./dist/existing').routeUrlPattern).then((pattern) => console.log(JSON.stringify(pattern ?? null))).catch(e => {console.error(e);process.exitCode=1;});
  `,
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    );
  expect(run({ httpEndpoint: 'http://127.0.0.1:28089' })).toBe(
    'http://{host}.{tenant}.localhost:28089',
  );
  expect(run({ httpEndpoint: 'http://10.0.0.5:30080' })).toBeNull();
  expect(
    run({
      httpEndpoint: 'http://127.0.0.1:28089',
      routeUrlPattern: 'https://{host}.{tenant}.apps.example.com',
    }),
  ).toBe('https://{host}.{tenant}.apps.example.com');
}, 60_000);

test('kubeconfigs read each token Secret after its User and are a secret output', () => {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    const resources = [];
    const b64 = s => Buffer.from(s).toString('base64');
    pulumi.runtime.setAllConfig({'project:tenants': JSON.stringify([{name:'alpha'},{name:'beta'}]), 'project:users': JSON.stringify([{name:'alice',memberships:[{tenant:'alpha',role:'developer'},{tenant:'beta',role:'viewer'}]},{name:'bob',memberships:[{tenant:'alpha',role:'viewer'}]}])});
    pulumi.runtime.setMocks({
      newResource: args => {
        resources.push({type:args.type, name:args.name, id:args.id});
        if (args.id) return {id:args.id, state:{data:{token:b64('token-' + args.name), 'ca.crt':b64('ca')}}};
        return {id:args.name, state:{...args.inputs, metadata:{...args.inputs.metadata, name:args.inputs.metadata?.name ?? args.name}}};
      },
      call: args => args.inputs,
    }, 'project', 'test', false);
    let result;
    pulumi.runtime.runInPulumiStack(async () => {
      const {createPlatform} = require('./dist');
      const platform = createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', apiServer: pulumi.output('https://127.0.0.1:26443') });
      result = { secret: await pulumi.isSecret(platform.kubeconfigs), value: await platform.kubeconfigs.promise() };
    }).then(() => { console.log(JSON.stringify({resources, ...result})); }).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const { resources, secret, value } = JSON.parse(output) as {
    resources: { type: string; name: string; id?: string }[];
    secret: boolean;
    value: Record<string, Record<string, string>>;
  };
  expect(secret).toBe(true);
  expect(Object.keys(value).sort()).toEqual(['alpha', 'beta']);
  const { alpha = {}, beta = {} } = value;
  expect(Object.keys(alpha).sort()).toEqual(['alice', 'bob']);
  expect(Object.keys(beta)).toEqual(['alice']);
  expect(beta.alice).toContain('server: "https://127.0.0.1:26443"');
  expect(beta.alice).toContain('token: "token-user-token-alice-beta"');
  expect(beta.alice).toContain('namespace: "di-tenant-beta"');
  const reads = resources.filter((r) => r.id);
  expect(reads.map((r) => [r.type, r.name, r.id])).toEqual(
    expect.arrayContaining([
      [
        'kubernetes:core/v1:Secret',
        'user-token-alice-alpha',
        'wasmcloud/di-user-alice-alpha-token',
      ],
      ['kubernetes:core/v1:Secret', 'user-token-alice-beta', 'wasmcloud/di-user-alice-beta-token'],
      ['kubernetes:core/v1:Secret', 'user-token-bob-alpha', 'wasmcloud/di-user-bob-alpha-token'],
    ]),
  );
  // Each read is registered only once its User custom resource has been created (and is Ready).
  for (const user of ['alice', 'bob']) {
    const created = resources.findIndex((r) => r.name === `user-${user}`);
    expect(created).toBeGreaterThanOrEqual(0);
    for (const read of reads.filter((r) => r.name.startsWith(`user-token-${user}-`)))
      expect(created).toBeLessThan(resources.indexOf(read));
  }
}, 60_000);

test('local entrypoint retains existing logical names and guarded Docker cleanup', () => {
  const local = readFileSync(join(root, 'src/local.ts'), 'utf8');
  expect(local).toContain('createPlatform({');
  expect(local).toContain("'runtime-shutdown'");
  expect(local).toContain('shutdownRuntime(cli)');
  expect(local).toContain('refuseExistingContainerThenRun(owned');
  expect(local.match(/Logging\.None/g)).toHaveLength(2);
  expect(local).toContain('apiServer: `https://127.0.0.1:$' + '{apiPort}`');
  expect(local).toContain('export const kubeconfigs = platform.kubeconfigs;');
  const existing = readFileSync(join(root, 'src/existing.ts'), 'utf8');
  expect(existing).toContain("config.get('kubernetesEndpoint') ?? kubeconfigServer(");
  expect(existing).toContain('export const kubeconfigs = platform.kubeconfigs;');
});

function localResources(config: Record<string, string> = {}) {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const resources = [];
    pulumi.runtime.setAllConfig(${JSON.stringify(config)});
    pulumi.runtime.setMocks({
      newResource: a => { resources.push(a); return {id:a.name, state:{...a.inputs, stdout:'test-kubeconfig', metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}; },
      call: a => a.inputs,
    }, 'project', 'test', false);
    pulumi.runtime.runInPulumiStack(() => require('./dist/local')).then(async () => { await pulumi.runtime.disconnect(); console.log(JSON.stringify(resources)); }).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(output) as { type: string; name: string; inputs: any }[];
}

test('local packaged entrypoint provisions Docker and the shared platform', () => {
  const resources = localResources();
  expect(
    resources.find((r) => r.name === 'k0s' && r.type.startsWith('command:'))?.inputs.create,
  ).toContain('docker run -d');
  expect(resources.some((r) => r.name === 'oci-registry')).toBe(true);
  expect(resources.find((r) => r.name === 'http-entrypoint')?.inputs.spec.type).toBe('ClusterIP');
  expect(
    resources.find((r) => r.name === 'http-gateway' && r.type === 'kubernetes:core/v1:Service')
      ?.inputs.spec.ports[0].nodePort,
  ).toBe(30180);
  const controller = resources.find((r) => r.name === 'deployment-di-platform-controller');
  expect(
    JSON.parse(controller?.inputs.spec.template.spec.containers[0].env[0].value).routeUrlPattern,
  ).toBe('http://{host}.{tenant}.localhost:28180');
  expect(
    resources.find((r) => r.type === 'kubernetes:helm.sh/v3:Release')?.inputs.values.operator
      .allowSharedHosts,
  ).toBe(false);
  expect(resources.some((r) => r.type === 'kubernetes:apps/v1:DaemonSet')).toBe(false);
}, 60_000);

test('local entrypoint drives the configured container CLI for every container command', () => {
  const resources = localResources({ 'project:containerCli': 'podman' });
  const commands = resources
    .filter((r) => r.type.startsWith('command:'))
    .flatMap((r) => [r.inputs.create, r.inputs.delete].filter(Boolean) as string[]);
  const containerCommands = commands.filter((c) => /\b(run|exec|inspect|rm) /.test(c));
  expect(containerCommands.length).toBeGreaterThanOrEqual(8);
  for (const command of commands) {
    expect(command).not.toMatch(/\bdocker (run|exec|logs|network|volume|container)\b/);
  }
  expect(resources.find((r) => r.name === 'k0s')?.inputs.create).toContain('podman run -d');
  expect(resources.find((r) => r.name === 'runtime-shutdown')?.inputs.delete).toContain(
    'podman exec "$K0S_NAME"',
  );
}, 60_000);

const MIRRORS = JSON.stringify({ 'docker.io': ['https://mirror.gcr.io'] });

test('local entrypoint without registry mirrors keeps the k0s command and every command unchanged', () => {
  const commands = (config: Record<string, string> = {}) =>
    localResources(config)
      .filter((r) => r.type.startsWith('command:'))
      .map((r) => [r.name, r.inputs]);
  const unset = commands();
  expect(commands({ 'project:registryMirrors': '{}' })).toEqual(unset);
  const k0s = Object.fromEntries(unset).k0s;
  expect(k0s.environment).toBeUndefined();
  expect(k0s.create).toBe(
    'set -eu; if docker container inspect di-framework-test-244210e484-k0s >/dev/null 2>&1; then ' +
      'echo "Refusing to replace existing container di-framework-test-244210e484-k0s" >&2; exit 1; fi; ' +
      'docker run -d --name di-framework-test-244210e484-k0s --hostname di-framework-test-244210e484-k0s ' +
      '--label di-framework.dev.platform-scope=di-framework-test-244210e484 ' +
      '--network di-framework-test-244210e484-network --privileged ' +
      '--tmpfs /run:rw,nosuid,nodev,exec,mode=755 ' +
      '--mount type=volume,source=di-framework-test-244210e484-k0s-data,target=/var/lib/k0s ' +
      '--mount type=volume,source=di-framework-test-244210e484-k0s-pod-logs,target=/var/log/pods ' +
      '--publish 127.0.0.1:26443:6443 --publish 127.0.0.1:25000:30500 --publish 127.0.0.1:28180:30180 ' +
      'docker.io/k0sproject/k0s:v1.36.3-k0s.2 k0s controller --enable-worker --no-taints',
  );
}, 60_000);

test('local entrypoint configures containerd registry mirrors before k0s starts', () => {
  const resources = localResources({
    'project:containerCli': 'podman',
    'project:registryMirrors': MIRRORS,
  });
  const k0s = resources.find((r) => r.name === 'k0s')?.inputs;
  expect(k0s.create).toContain(
    '--publish 127.0.0.1:28180:30180 --env K0S_ENTRYPOINT_ROLE=controller+worker ' +
      '--env DI_K0S_FILE_0 --env DI_K0S_FILE_1 docker.io/k0sproject/k0s:v1.36.3-k0s.2 ' +
      "sh -c 'set -eu; mkdir -p /etc/k0s/containerd.d /etc/containerd/certs.d/docker.io; " +
      'printf %s "$DI_K0S_FILE_0" > /etc/k0s/containerd.d/di-framework-registry-mirrors.toml; ' +
      'printf %s "$DI_K0S_FILE_1" > /etc/containerd/certs.d/docker.io/hosts.toml; ' +
      "unset DI_K0S_FILE_0 DI_K0S_FILE_1; exec k0s controller --enable-worker --no-taints'",
  );
  expect(k0s.environment).toEqual({
    DI_K0S_FILE_0:
      '# Managed by @di-framework/platform: registry mirrors.\nversion = 3\n\n' +
      '[plugins."io.containerd.cri.v1.images".registry]\n  config_path = "/etc/containerd/certs.d"\n',
    DI_K0S_FILE_1:
      '# Managed by @di-framework/platform: registry mirrors.\n' +
      'server = "https://registry-1.docker.io"\n\n' +
      '[host."https://mirror.gcr.io"]\n  capabilities = ["pull", "resolve"]\n',
  });
}, 60_000);

test('local entrypoint rejects registry mirrors with shell or TOML metacharacters', () => {
  expect(() =>
    localResources({
      'project:registryMirrors': JSON.stringify({ 'docker.io': ['https://mirror.gcr.io/"; id'] }),
    }),
  ).toThrow('registryMirrors.docker.io entries must be http:// or https:// URLs');
}, 60_000);

test('local entrypoint rejects a container CLI with shell metacharacters', () => {
  expect(() => localResources({ 'project:containerCli': 'podman; true' })).toThrow(
    'containerCli must be a plain command name or path',
  );
}, 60_000);
