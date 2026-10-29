import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformValues } from '../src/values';
import { RUNTIME_OPERATOR_RENDER } from './fixtures/runtime-operator-render';
import { selfSignedCert } from './support/tls';

const root = join(import.meta.dir, '..');

// Child-process helpers: a plain-HTTP fake Kubernetes API that lists the Tenants in $TENANTS (a JSON
// array of names), or answers $TENANT_API_STATUS, and records every request path in `tenantHits`.
// createPlatform lists the installation's Tenants with the provider kubeconfig on a real update
// (#227). One fixed port keeps the kubeconfig, and so every command input, identical across runs.
const TENANT_API_PORT = (() => {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
})();
const TENANT_API_KUBECONFIG = [
  'apiVersion: v1',
  'kind: Config',
  'current-context: c',
  'clusters:',
  '- name: c',
  '  cluster:',
  `    server: http://127.0.0.1:${TENANT_API_PORT}`,
  '    insecure-skip-tls-verify: true',
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
].join('\n');
const TENANT_API = `
  const http = require('http');
  const tenantHits = [];
  const tenantApiKubeconfig = ${JSON.stringify(TENANT_API_KUBECONFIG)};
  function startTenantApi() {
    const server = http.createServer((req, res) => {
      tenantHits.push(req.url);
      res.setHeader('content-type', 'application/json');
      // An unref'd server still holds its accepted keep-alive sockets: without this, every child
      // idles about 3 s after its output before it can exit.
      res.setHeader('connection', 'close');
      res.statusCode = Number(process.env.TENANT_API_STATUS || 200);
      if (res.statusCode !== 200) return res.end('{"kind":"Status","message":"secret detail"}');
      res.end(JSON.stringify({ items: JSON.parse(process.env.TENANTS || '[]').map(name => ({ metadata: { name } })) }));
    });
    return new Promise(resolve => server.listen(${TENANT_API_PORT}, '127.0.0.1', () => { server.unref(); resolve(); }));
  }
`;

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
  // The chart's open ingress policies stay off; the platform renders its own (#462).
  expect(platformValues({ networkPolicy: { enabled: true } }, defaults).networkPolicy).toEqual({
    enabled: false,
  });
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
  // The release post-renders the chart so its scheduler NATS drops `-DV` (#550).
  const patched = execFileSync(release?.inputs.postrender, {
    input: RUNTIME_OPERATOR_RENDER,
    encoding: 'utf8',
  });
  expect(patched).toContain('- /nats-config/nats-server.conf');
  expect(release?.inputs.postrender).toMatch(/nats-postrender-[0-9a-f]{16}$/);
  expect(patched).not.toContain('-DV');
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
  expect(cfg).not.toHaveProperty('insecureRegistry');
  // A TLS install: no plain-HTTP registry anywhere.
  expect(cfg.insecureRegistries).toEqual([]);
  // wash 2.8.0-wasi-tls with patches 0002 (`--insecure-registry`, #149) and 0003 (#159): the
  // default, which the tenant host pin PR moves (#346).
  const defaultHostImage = /export const DEFAULT_HOST_IMAGE =\s*'([^']+)'/.exec(
    readFileSync(join(root, 'src/index.ts'), 'utf8'),
  )?.[1];
  expect(defaultHostImage).toMatch(
    /^ghcr\.io\/di-framework\/wash:2\.8\.0-wasi-tls@sha256:[0-9a-f]{64}$/,
  );
  expect(cfg.hostImage).toBe(defaultHostImage);
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

test('an insecure install keeps the platform flag and allowlists only its registry for tenants', () => {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    const resources = [];
    pulumi.runtime.setAllConfig({'project:tenants': JSON.stringify([{name:'alpha'}]), 'project:insecureRegistries': JSON.stringify(['examples-registry.wasmcloud.svc.cluster.local:5000']), 'project:runtimeNats': JSON.stringify({maxFileStore:'20Gi'})});
    pulumi.runtime.setMocks({
      newResource: args => { resources.push(args); return {id:args.name, state:{...args.inputs, metadata:{...args.inputs.metadata, name:args.inputs.metadata?.name ?? args.name}}}; },
      call: args => args.inputs,
    }, 'project', 'test', false);
    pulumi.runtime.runInPulumiStack(async () => {
      const {createPlatform} = require('./dist');
      const platform = createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', registry:true, insecureRegistry:true });
      await platform.namespace.promise();
      await Promise.all(platform.tenants.map(t => t.promise()));
    }).then(() => { console.log(JSON.stringify(resources)); }).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const resources = JSON.parse(output) as { type: string; name: string; inputs: any }[];
  // The platform host group (stock wasmCloud image) still pulls every registry over plain HTTP.
  const release = resources.find((r) => r.type === 'kubernetes:helm.sh/v3:Release');
  expect(release?.inputs.values.runtime.extraArgs).toEqual(['--allow-insecure-registries']);
  const registry = resources.find(
    (r) => r.name === 'oci-registry' && r.type === 'kubernetes:core/v1:Service',
  );
  expect(registry?.inputs.metadata).toMatchObject({
    name: 'di-framework-registry',
    namespace: 'wasmcloud',
  });
  expect(registry?.inputs.spec.ports[0].port).toBe(5000);
  // Tenant hosts: the platform registry as registry.pull spells it, then the configured ones.
  const controller = resources.find((r) => r.name === 'deployment-di-platform-controller');
  const cfg = JSON.parse(controller?.inputs.spec.template.spec.containers[0].env[0].value);
  // The controller needs only the allowlist; `insecureRegistry` itself is Helm-only.
  expect(cfg).not.toHaveProperty('insecureRegistry');
  expect(cfg.insecureRegistries).toEqual([
    'di-framework-registry.wasmcloud.svc.cluster.local:5000',
    'examples-registry.wasmcloud.svc.cluster.local:5000',
  ]);
  // Config `runtimeNats` reaches the controller, which renders it into each tenant's di-nats (#160).
  expect(cfg.runtimeNats).toEqual({ maxFileStore: '20Gi' });
}, 60_000);

test('an insecure install refuses a tenantHostImage that predates patch 0002', () => {
  const old =
    'ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:ee89fd4bce4f9f35f4cd09c63d3cbdd07bea3071b5d372f82c9f49b9741c3669';
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    pulumi.runtime.setAllConfig({'project:tenantHostImage': '${old}'});
    pulumi.runtime.setMocks({ newResource: a => ({id:a.name, state:a.inputs}), call: a => a.inputs }, 'project', 'test', false);
    try {
      require('./dist').createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', registry:true, insecureRegistry:true });
      console.log('created');
    } catch (e) { console.log(e.message); }
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  expect(output).toContain(`tenantHostImage ${old} predates wash patch 0002`);
}, 60_000);

// Runs createPlatform with kube-router network policy and `config`, waits for every registration
// to reach the mocks, and returns the thrown message (if any) and the Kubernetes resources.
function createWithNetworkPolicy(
  config: Record<string, unknown>,
  args: Record<string, unknown> = {},
): { error?: string; resources: { type: string; name: string }[] } {
  const project = Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      `project:${key}`,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    const resources = [];
    pulumi.runtime.setAllConfig(${JSON.stringify(project)});
    pulumi.runtime.setMocks({
      newResource: a => { resources.push({ type: a.type, name: a.name }); return {id:a.name, state:a.inputs}; },
      call: a => a.inputs,
    }, 'project', 'test', false);
    pulumi.runtime.runInPulumiStack(async () => {
      let error;
      try {
        require('./dist').createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', networkPolicyEngine:'kube-router', ...${JSON.stringify(args)} });
      } catch (e) { error = e.message; }
      // The sentinel round-trips through the mocks. A successful call also polls until its
      // kube-router DaemonSet is registered, so nothing is asserted against a fixed timer.
      const sentinel = new k8s.core.v1.Namespace('sentinel', {}, { provider: new k8s.Provider('sentinel-provider', {}) });
      await new Promise(r => sentinel.urn.apply(r));
      if (!error) for (let i = 0; i < 200 && !resources.some(r => r.type === 'kubernetes:apps/v1:DaemonSet'); i++) await new Promise(r => setTimeout(r, 50));
      return error;
    }).then(error => {
      console.log(JSON.stringify({ error, resources: resources.filter(r => !r.type.startsWith('pulumi:') && r.name !== 'sentinel' && r.name !== 'sentinel-provider') }));
    }).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return JSON.parse(output);
}

test('an invalid tenant host allowlist fails before any resource, network policy included', () => {
  const old =
    'ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:ee89fd4bce4f9f35f4cd09c63d3cbdd07bea3071b5d372f82c9f49b9741c3669';
  const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
    [
      { egressAllowedDestinations: JSON.stringify('bad') },
      {},
      'egressAllowedDestinations must be a list',
    ],
    [
      { tenantAuth: { image: 'ghcr.io/x/y:latest', issuer: 'https://issuer.example' } },
      {},
      'tenantAuth.image must be pinned by digest',
    ],
    [
      { runtimeNats: { maxMemoryStore: '1Gi' } },
      {},
      'runtimeNats.maxMemoryStore must be at most 64Mi, half the di-nats memory limit (128Mi)',
    ],
    [{}, { apiServer: 'https://k8s.example:6443' }, 'apiServer requires kubeconfig'],
    [
      { insecureRegistries: ['http://registry.example:5000'] },
      { registry: true, insecureRegistry: true },
      'insecureRegistries entries must be a registry host[:port]',
    ],
    [
      { insecureRegistries: JSON.stringify('registry.example:5000') },
      { registry: true, insecureRegistry: true },
      'insecureRegistries must be a list of host[:port]',
    ],
    [
      { insecureRegistries: ['registry.example:5000'] },
      {},
      'insecureRegistries requires insecureRegistry: true',
    ],
    [
      { tenantHostImage: old },
      { registry: true, insecureRegistry: true },
      `tenantHostImage ${old} predates wash patch 0002`,
    ],
  ];
  for (const [config, args, message] of cases) {
    const { error, resources } = createWithNetworkPolicy(config, args);
    expect(error).toContain(message);
    expect(resources).toEqual([]);
  }
}, 120_000);

test('a valid tenant host allowlist still installs the kube-router network policy', () => {
  const { error, resources } = createWithNetworkPolicy(
    { insecureRegistries: ['examples-registry.wasmcloud.svc.cluster.local:5000'] },
    { registry: true, insecureRegistry: true },
  );
  expect(error).toBeUndefined();
  expect(resources.some((r) => r.type === 'kubernetes:apps/v1:DaemonSet')).toBe(true);
  expect(resources.some((r) => r.type === 'kubernetes:helm.sh/v3:Release')).toBe(true);
}, 60_000);

test('existing entrypoint derives the route pattern from a loopback HTTP endpoint', () => {
  const kubeconfigFile = join(mkdtempSync(join(tmpdir(), 'existing-')), 'config');
  writeFileSync(kubeconfigFile, TENANT_API_KUBECONFIG);
  const run = (config: Record<string, string>) =>
    JSON.parse(
      execFileSync(
        'node',
        [
          '-e',
          `
    const pulumi = require('@pulumi/pulumi');
    ${TENANT_API}
    pulumi.runtime.setAllConfig(${JSON.stringify(
      Object.fromEntries(
        Object.entries({ kubeconfig: kubeconfigFile, ...config }).map(([k, v]) => [
          `project:${k}`,
          v,
        ]),
      ),
    )});
    pulumi.runtime.setMocks({
      newResource: a => ({id:a.name, state:{...a.inputs, metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}),
      call: a => a.inputs,
    }, 'project', 'test', false);
    startTenantApi().then(() => pulumi.runtime.runInPulumiStack(async () => require('./dist/existing').routeUrlPattern)).then((pattern) => console.log(JSON.stringify(pattern ?? null))).catch(e => {console.error(e);process.exitCode=1;});
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

// Child-process helpers: a fake Kubernetes API that serves Secrets with a token, and a
// kubeconfig that points at it. `hits` records every request path per server.
const FAKE_API = `
  const https = require('https');
  const tls = { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) };
  const b64 = s => Buffer.from(s).toString('base64');
  function startApi(label, hits) {
    const server = https.createServer(tls, (req, res) => {
      hits.push({ label, path: req.url });
      const name = decodeURIComponent(req.url.split('/').pop());
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ kind: 'Secret', apiVersion: 'v1', metadata: { name, namespace: 'wasmcloud' }, data: { token: b64('api-token-' + name) } }));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'https://127.0.0.1:' + server.address().port })));
  }
  const kubeconfigFor = (url, context = 'ctx') => [
    'apiVersion: v1', 'kind: Config', 'current-context: ' + context,
    'clusters:', '- name: c', '  cluster:', '    server: ' + url, '    certificate-authority-data: ' + Buffer.from(tls.cert).toString('base64'),
    'users:', '- name: u', '  user:', '    token: admin-token',
    'contexts:', '- name: ' + context, '  context:', '    cluster: c', '    user: u', '',
  ].join('\\n');
`;

test('kubeconfigs wait on the provider kubeconfig after each User, not the ambient KUBECONFIG', () => {
  const cert = selfSignedCert();
  const decoyKubeconfig = join(mkdtempSync(join(tmpdir(), 'decoy-')), 'config');
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    const fs = require('fs');
    ${FAKE_API}
    const resources = [];
    const hits = [];
    let hitsWhenUserDone;
    (async () => {
      const real = await startApi('real', hits);
      const decoy = await startApi('decoy', hits);
      fs.writeFileSync(${JSON.stringify(decoyKubeconfig)}, kubeconfigFor(decoy.url, 'decoy'));
      pulumi.runtime.setAllConfig({'project:tenants': JSON.stringify([{name:'alpha'},{name:'beta'}]), 'project:users': JSON.stringify([{name:'alice',memberships:[{tenant:'alpha',role:'developer'},{tenant:'beta',role:'viewer'}]},{name:'bob',memberships:[{tenant:'alpha',role:'viewer'}]}])});
      pulumi.runtime.setMocks({
        newResource: async args => {
          resources.push({type:args.type, name:args.name, id:args.id});
          if (args.id) return {id:args.id, state:{data:{token:b64('token-' + args.name), 'ca.crt':b64('ca')}}};
          if (args.name === 'user-bob') { await new Promise(r => setTimeout(r, 300)); hitsWhenUserDone = hits.filter(h => h.path.includes('bob')).length; }
          return {id:args.name, state:{...args.inputs, metadata:{...args.inputs.metadata, name:args.inputs.metadata?.name ?? args.name}}};
        },
        call: args => args.inputs,
      }, 'project', 'test', false);
      let result;
      await pulumi.runtime.runInPulumiStack(async () => {
        const {createPlatform} = require('./dist');
        const platform = createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', apiServer: pulumi.output('https://127.0.0.1:26443'), kubeconfig: pulumi.secret(kubeconfigFor(real.url)), kubeContext: 'ctx' });
        result = { secret: await pulumi.isSecret(platform.kubeconfigs), value: await platform.kubeconfigs.promise() };
      });
      console.log(JSON.stringify({resources, hits, hitsWhenUserDone, ...result}));
      real.server.close(); decoy.server.close();
    })().catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        KUBECONFIG: decoyKubeconfig,
        TLS_KEY: cert.keyPath,
        TLS_CERT: cert.certPath,
      },
    },
  );
  const parsed = JSON.parse(output) as {
    hits: { label: string; path: string }[];
    hitsWhenUserDone: number;
  };
  // Only the provider's cluster is contacted, never the ambient one.
  expect(parsed.hits.length).toBeGreaterThanOrEqual(3);
  expect(parsed.hits.every((h) => h.label === 'real')).toBe(true);
  expect(parsed.hits.map((h) => h.path)).toEqual(
    expect.arrayContaining([
      '/api/v1/namespaces/wasmcloud/secrets/di-user-alice-alpha-token',
      '/api/v1/namespaces/wasmcloud/secrets/di-user-alice-beta-token',
      '/api/v1/namespaces/wasmcloud/secrets/di-user-bob-alpha-token',
    ]),
  );
  // No poll for a user's Secret starts before that User resource has been registered.
  expect(parsed.hitsWhenUserDone).toBe(0);
  const { resources, secret, value } = parsed as unknown as {
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

/**
 * Runs createPlatform with the provider kubeconfig against the fake Tenant API, with `declared`
 * tenants in config and `cluster` as the Tenants that exist. Returns the Helm release's
 * operator.hostNamespaces, the API request paths and the Pulumi log, or the failure.
 */
function operatorNamespaces(options: {
  declared: string[];
  cluster?: string[];
  dryRun?: boolean;
  status?: number;
}): { hits?: string[]; hostNamespaces?: string[]; failure?: string; log: string } {
  const tenants = JSON.stringify(options.declared.map((name) => ({ name })));
  const child = spawnSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    ${TENANT_API}
    const resources = [];
    pulumi.runtime.setAllConfig({ 'project:tenants': ${JSON.stringify(tenants)} });
    pulumi.runtime.setMocks({
      newResource: a => { resources.push(a); return {id:a.name, state:{...a.inputs, metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}; },
      call: a => a.inputs,
    }, 'project', 'test', ${options.dryRun === true});
    startTenantApi().then(() => pulumi.runtime.runInPulumiStack(async () => {
      const platform = require('./dist').createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', kubeconfig: pulumi.secret(tenantApiKubeconfig) });
      await platform.release.urn.promise();
    })).then(() => {
      const release = resources.find(r => r.type === 'kubernetes:helm.sh/v3:Release');
      console.log(JSON.stringify({ hits: tenantHits, hostNamespaces: release.inputs.values.operator.hostNamespaces }));
    }).catch(e => { console.error(e.message); process.exitCode = 1; });
  `,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        TENANTS: JSON.stringify(options.cluster ?? []),
        TENANT_API_STATUS: String(options.status ?? 200),
      },
    },
  );
  // Pulumi logs info to stdout and warnings and errors to stderr when no engine is attached.
  const log = `${child.stdout}${child.stderr}`;
  if (child.status !== 0) return { failure: child.stderr, log };
  return {
    ...(JSON.parse(child.stdout.trim().split('\n').at(-1) as string) as {
      hits: string[];
      hostNamespaces: string[];
    }),
    log,
  };
}

test('removing a tenant keeps its runtime namespace watched until its Tenant is gone (#227)', () => {
  // The up that drops beta from config: Pulumi updates the release before it deletes the Tenant,
  // so the operator must still watch di-runtime-beta to release its host pods' finalizers.
  const removing = operatorNamespaces({ declared: ['alpha'], cluster: ['alpha', 'beta'] });
  expect(removing.failure).toBeUndefined();
  expect(removing.hostNamespaces).toEqual(['wasmcloud', 'di-runtime-alpha', 'di-runtime-beta']);
  // Listed once through tenancy/removal's lister and shared with the #228 Retain check, which
  // warns from the same snapshot (#245).
  expect(removing.hits).toEqual([TENANT_LIST_PATH]);
  expect(removing.log).toContain('Tenant beta is no longer declared but still exists');
  expect(removing.log).toContain('Tenant beta is being removed with deletionPolicy Retain');
  // The next up, after the Tenant is gone: the namespace stops being watched.
  const removed = operatorNamespaces({ declared: ['alpha'], cluster: ['alpha'] });
  expect(removed.hostNamespaces).toEqual(['wasmcloud', 'di-runtime-alpha']);
  expect(removed.log).not.toContain('no longer declared');
}, 60_000);

test('preview reads the shared Tenant list once, so its diff matches the up (#245)', () => {
  const preview = operatorNamespaces({
    declared: ['alpha'],
    cluster: ['alpha', 'beta'],
    dryRun: true,
  });
  expect(preview.failure).toBeUndefined();
  // beta still exists, so preview keeps watching di-runtime-beta exactly as the up will.
  expect(preview.hostNamespaces).toEqual(['wasmcloud', 'di-runtime-alpha', 'di-runtime-beta']);
  expect(preview.hits).toEqual([TENANT_LIST_PATH]);
  expect(preview.log).toContain('Tenant beta is no longer declared but still exists');
  expect(preview.log).toContain('Tenant beta is being removed with deletionPolicy Retain');
  // Nothing is logged about watched namespaces when no tenant is being removed.
  const unchanged = operatorNamespaces({ declared: ['alpha'], cluster: ['alpha'], dryRun: true });
  expect(unchanged.hostNamespaces).toEqual(['wasmcloud', 'di-runtime-alpha']);
  expect(unchanged.hits).toEqual([TENANT_LIST_PATH]);
  expect(unchanged.log).not.toContain('(#227)');
}, 60_000);

test('a preview that cannot list Tenants shows the declared tenants with a warning (#245)', () => {
  const preview = operatorNamespaces({
    declared: ['alpha'],
    cluster: ['beta'],
    dryRun: true,
    status: 403,
  });
  expect(preview.failure).toBeUndefined();
  expect(preview.hostNamespaces).toEqual(['wasmcloud', 'di-runtime-alpha']);
  expect(preview.hits).toEqual([TENANT_LIST_PATH]);
  expect(preview.log).toContain('Preview cannot list the Tenants of installation di-test');
  expect(preview.log).toContain('(#227): HTTP 403');
  expect(preview.log).not.toContain('secret detail');
}, 60_000);

test('an unreadable Tenant list fails the update with a clear message, not a shrunk list', () => {
  const failed = operatorNamespaces({ declared: ['alpha'], cluster: ['beta'], status: 403 });
  expect(failed.failure).toContain(
    "Cannot list the Tenants of installation di-test, which keep a removed tenant's runtime namespace watched by the wasmCloud operator until the Tenant is deleted (#227): HTTP 403",
  );
  expect(failed.failure).not.toContain('secret detail');
}, 60_000);

/** The one request that lists the installation's Tenants. */
const TENANT_LIST_PATH =
  '/apis/platform.di-framework.dev/v1alpha1/tenants?labelSelector=platform.di-framework.dev%2Finstallation%3Ddi-test';

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
    ${TENANT_API}
    const resources = [];
    pulumi.runtime.setAllConfig(${JSON.stringify(config)});
    pulumi.runtime.setMocks({
      newResource: a => { resources.push(a); return {id:a.name, state:{...a.inputs, stdout:tenantApiKubeconfig, metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}; },
      call: a => a.inputs,
    }, 'project', 'test', false);
    startTenantApi().then(() => pulumi.runtime.runInPulumiStack(() => require('./dist/local'))).then(async () => { await pulumi.runtime.disconnect(); console.log(JSON.stringify(resources)); }).catch(e => {console.error(e);process.exitCode=1;});
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

test('apiServer without the provider kubeconfig fails loudly instead of skipping the wait', () => {
  expect(() =>
    execFileSync(
      'node',
      [
        '-e',
        `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    pulumi.runtime.setAllConfig({'project:tenants': '[]', 'project:users': '[]'});
    pulumi.runtime.setMocks({ newResource: a => ({id:a.name, state:a.inputs}), call: a => a.inputs }, 'project', 'test', false);
    pulumi.runtime.runInPulumiStack(async () => {
      require('./dist').createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', apiServer:'https://127.0.0.1:26443' });
    }).catch(e => {console.error(e.message);process.exitCode=1;});
  `,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  ).toThrow();
}, 60_000);

test('local entrypoint rejects a container CLI with shell metacharacters', () => {
  expect(() => localResources({ 'project:containerCli': 'podman; true' })).toThrow(
    'containerCli must be a plain command name or path',
  );
}, 60_000);

/**
 * Runs `createPlatform` with `config` (unprefixed keys; non-strings are JSON-encoded) and extra
 * `args` source, and returns the gateway Deployment's GATEWAY_CONFIG and config hash and the
 * platform controller's PLATFORM_CONFIG, or the error.
 */
function gatewayInstall(
  config: Record<string, unknown>,
  args = '',
): {
  gatewayConfig?: { routeAliases?: Record<string, string> };
  configHash?: string;
  platformConfig?: {
    tenantAuth?: Record<string, unknown>;
    tenantAuthReadsApiKeyNamespace?: boolean;
    tenants?: string[];
  };
  error?: string;
} {
  const prefixed = Object.fromEntries(
    Object.entries({ tenants: [{ name: 'identity' }, { name: 'identity-pg' }], ...config }).map(
      ([key, value]) => [
        `project:${key}`,
        typeof value === 'string' ? value : JSON.stringify(value),
      ],
    ),
  );
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    const resources = [];
    pulumi.runtime.setAllConfig(${JSON.stringify(prefixed)});
    pulumi.runtime.setMocks({
      newResource: a => { resources.push(a); return {id:a.name, state:{...a.inputs, metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}; },
      call: a => a.inputs,
    }, 'project', 'test', false);
    let error;
    pulumi.runtime.runInPulumiStack(async () => {
      let platform;
      try {
        platform = require('./dist').createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', ${args} });
      } catch (e) { error = e.message; return; }
      await platform.namespace.promise();
      await Promise.all(platform.tenants.map(t => t.promise()));
    }).then(() => {
      if (error) return console.log(JSON.stringify({ error }));
      const gateway = resources.find(r => r.name === 'http-gateway' && r.type === 'kubernetes:apps/v1:Deployment').inputs.spec.template;
      const controller = resources.find(r => r.type === 'kubernetes:apps/v1:Deployment' && r.inputs.metadata?.name === 'di-platform-controller').inputs.spec.template;
      const platformConfig = JSON.parse(controller.spec.containers[0].env.find(e => e.name === 'PLATFORM_CONFIG').value);
      console.log(JSON.stringify({ gatewayConfig: JSON.parse(gateway.spec.containers[0].env[0].value), configHash: gateway.metadata.annotations['di-framework.dev/config-hash'], platformConfig }));
    }).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return JSON.parse(output.trim().split('\n').at(-1) as string);
}

test('install validates config routeAliases and deploys them normalized to the gateway (#217)', () => {
  const deployed = gatewayInstall({
    routeAliases: {
      'Identity.identity': 'IDENTITY.identity-pg',
      'api.identity': 'api.identity-pg',
    },
  });
  expect(deployed.error).toBeUndefined();
  expect(Object.entries(deployed.gatewayConfig?.routeAliases ?? {})).toEqual([
    ['api.identity', 'api.identity-pg'],
    ['identity.identity', 'identity.identity-pg'],
  ]);
  // Same aliases in another order and spelling: same GATEWAY_CONFIG and hash, so no rollout.
  const reordered = gatewayInstall({
    routeAliases: {
      'api.identity': 'api.identity-pg',
      'identity.identity': 'identity.identity-pg',
    },
  });
  expect(reordered).toEqual(deployed);
  // Removing the alias drops it from GATEWAY_CONFIG and changes the hash, rolling the gateway.
  const removed = gatewayInstall({});
  expect(removed.gatewayConfig).not.toHaveProperty('routeAliases');
  expect(removed.configHash).not.toBe(deployed.configHash);
  // PlatformArgs.routeAliases wins over config.
  const fromArgs = gatewayInstall(
    { routeAliases: { 'api.identity': 'api.identity-pg' } },
    `routeAliases: { 'identity.identity': 'identity.identity-pg' }`,
  );
  expect(fromArgs.gatewayConfig?.routeAliases).toEqual({
    'identity.identity': 'identity.identity-pg',
  });
}, 120_000);

test('install routes tenant-auth hosts derived from routeUrlPattern through the gateway (#128)', () => {
  const tenantAuth = {
    image: `ghcr.io/x/y@sha256:${'a'.repeat(64)}`,
    issuer: 'https://issuer.example',
    oauthClient: { id: 'access', secretName: 'tenant-auth-oauth' },
  };
  const pattern = `routeUrlPattern: 'http://{host}.{tenant}.localhost:28180'`;
  const derived = gatewayInstall({ tenantAuth }, pattern);
  expect(derived.error).toBeUndefined();
  expect(derived.gatewayConfig).toMatchObject({
    tenantAuthRoutes: { console: 'console', controller: 'controller' },
  });
  // The controller is told which Tenants to GET when a stale LIST misses them (#544).
  expect(derived.platformConfig?.tenants).toEqual(['identity', 'identity-pg']);
  const reordered = gatewayInstall(
    { tenantAuth, tenants: [{ name: 'identity-pg' }, { name: 'identity' }] },
    pattern,
  );
  expect(reordered.platformConfig?.tenants).toEqual(['identity', 'identity-pg']);
  // Not a listed tenant-auth build, so API keys stay where they are (#379).
  expect(derived.platformConfig?.tenantAuthReadsApiKeyNamespace).toBe(false);
  // The platform controller renders the console and controller from the same derived URLs.
  expect(derived.platformConfig?.tenantAuth).toMatchObject({
    consolePublicUrl: 'http://console.{tenant}.localhost:28180',
    controllerPublicUrl: 'https://controller.{tenant}.localhost:28180',
  });
  // An explicit URL wins: a loopback console stays unrouted.
  const explicit = gatewayInstall(
    { tenantAuth: { ...tenantAuth, consolePublicUrl: 'http://127.0.0.1:8787' } },
    pattern,
  );
  expect(explicit.gatewayConfig).toMatchObject({
    tenantAuthRoutes: { controller: 'controller' },
  });
  expect(explicit.gatewayConfig).not.toHaveProperty('tenantAuthRoutes.console');
  expect(explicit.platformConfig?.tenantAuth?.consolePublicUrl).toBe('http://127.0.0.1:8787');
  // A pattern the gateway does not route to tenant-auth keeps the 127.0.0.1 defaults, as before.
  const unrouted = gatewayInstall(
    { tenantAuth },
    `routeUrlPattern: 'https://{host}.{tenant}.localhost:28180'`,
  );
  expect(unrouted.error).toBeUndefined();
  expect(unrouted.gatewayConfig).not.toHaveProperty('tenantAuthRoutes');
  expect(unrouted.platformConfig?.tenantAuth).not.toHaveProperty('consolePublicUrl');
  expect(unrouted.platformConfig?.tenantAuth).not.toHaveProperty('controllerPublicUrl');
}, 180_000);

test('install refuses a gateway config key even when PlatformArgs.routeAliases is passed (#217)', () => {
  const result = gatewayInstall(
    { gateway: { routeAliases: { 'api.identity': 'api.identity-pg' } } },
    `routeAliases: { 'identity.identity': 'identity.identity-pg' }`,
  );
  expect(result.error).toContain('top-level config key routeAliases');
}, 60_000);

test.each([
  [
    'a chain',
    { routeAliases: { 'a.identity': 'a.identity-pg', 'a.identity-pg': 'b.identity' } },
    'Chained route aliases',
  ],
  [
    'a reserved target',
    { routeAliases: { 'a.identity': 'controller.identity-pg' } },
    'reserved route host controller',
  ],
  [
    'an undeclared tenant',
    { routeAliases: { 'a.identity': 'a.other' } },
    'undeclared tenant other',
  ],
  [
    'a nested map',
    { routeAliases: { identity: { identity: 'identity.identity-pg' } } },
    'routeAliases["identity"] must be a',
  ],
  ['an array', { routeAliases: ['identity.identity-pg'] }, 'routeAliases must be an object'],
  ['non-JSON', { routeAliases: 'identity.identity' }, 'is not a valid JSON object'],
  [
    'nested gateway.routeAliases',
    { gateway: { routeAliases: {} } },
    'top-level config key routeAliases',
  ],
  [
    'a dotted gateway.routeAliases key',
    { 'gateway.routeAliases': {} },
    'top-level config key routeAliases',
  ],
])(
  'install refuses %s in route aliases (#217)',
  (_, config, message) => {
    expect(gatewayInstall(config).error).toContain(message);
  },
  60_000,
);

test('install warns that tenant registries stay in the shared NATS account unless the host is a known 0003 build (#159)', () => {
  const run = (config: Record<string, unknown>) => {
    const prefixed = Object.fromEntries(
      Object.entries({ tenants: [{ name: 'alpha' }], ...config }).map(([key, value]) => [
        `project:${key}`,
        typeof value === 'string' ? value : JSON.stringify(value),
      ]),
    );
    const child = spawnSync(
      'node',
      [
        '-e',
        `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    pulumi.runtime.setAllConfig(${JSON.stringify(prefixed)});
    pulumi.runtime.setMocks({
      newResource: a => ({id:a.name, state:{...a.inputs, metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}),
      call: a => a.inputs,
    }, 'project', 'test', false);
    pulumi.runtime.runInPulumiStack(async () => {
      const platform = require('./dist').createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test' });
      await platform.namespace.promise();
    }).catch(e => {console.error(e);process.exitCode=1;});
  `,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
    return `${child.stdout}${child.stderr}`;
  };
  const tenantAuth = {
    image: `ghcr.io/x/y@sha256:${'a'.repeat(64)}`,
    issuer: 'https://issuer.example',
    oauthClient: { id: 'access', secretName: 'tenant-auth-oauth' },
    registry: { component: `ghcr.io/x/registry@sha256:${'b'.repeat(64)}` },
  };
  const warning = 'is not a known build with wash patch 0003 (NATS blobstore credentials)';
  // The default host image carries 0003; so does the pinned exclusive build.
  expect(run({ tenantAuth })).not.toContain(warning);
  expect(
    run({
      tenantAuth,
      tenantHostImage:
        'ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@sha256:da38d84b52a6327e02febe7172a466f628b1d923944ebf50171f1df630ec37a9',
    }),
  ).not.toContain(warning);
  // Fail closed: an earlier build, an unknown digest or a tag alone is not trusted to carry it.
  for (const tenantHostImage of [
    'ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:d88158b0b09edd9fc3e79d787762697c60f65baf134d895529e85d6c47cd80ad',
    `ghcr.io/di-framework/wash@sha256:${'c'.repeat(64)}`,
    'ghcr.io/di-framework/wash:2.8.0-wasi-tls',
  ])
    expect(run({ tenantAuth, tenantHostImage })).toContain(warning);
  // Without a registry nothing is logged about it.
  const { registry: _registry, ...withoutRegistry } = tenantAuth;
  const unregistered = run({
    tenantAuth: withoutRegistry,
    tenantHostImage: 'ghcr.io/di-framework/wash:2.8.0-wasi-tls',
  });
  expect(unregistered).not.toContain(warning);
  // #379: a tenant-auth not listed as reading di-apikeys-<tenant> leaves the keys where they are.
  const keys = 'is not a known tenant-auth build that reads di-apikeys-<tenant> (#379)';
  expect(unregistered).toContain(`tenantAuth.image ${tenantAuth.image} ${keys}`);
  expect(run({})).not.toContain(keys);
}, 180_000);
