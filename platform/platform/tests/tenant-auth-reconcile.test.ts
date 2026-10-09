import { describe, expect, it } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { type Api, ApiError, Controller, collection, main } from '../src/tenancy/controller';
import { CONTROLLER_SCRIPT_MODULES, controllerClusterRoleRules } from '../src/tenancy/install';
import {
  addQuantity,
  assertTenantAuthConfig,
  COMPONENT,
  type ControllerConfig,
  INSTALLATION,
  OWNER,
  type Resource,
  TENANT,
  TENANT_AUTH_LIMITS,
  type Tenant,
  type TenantAuthConfig,
  type TenantAuthInputs,
  tenantAuthResources,
  tenantResources,
  type User,
  VERSION,
} from '../src/tenancy/resources';
import { certificateValid, selfSignedCertificate } from '../src/tenancy/tls';

const IMAGE = `ghcr.io/di-framework/tenant-auth@sha256:${'a'.repeat(64)}`;
const auth: TenantAuthConfig = {
  image: IMAGE,
  issuer: 'http://identity.alpha.localhost:28180',
  oauthClient: { id: 'access', secretName: 'tenant-auth-oauth' },
  issuerUpstream: 'di-platform-gateway.wasmcloud.svc.cluster.local:80',
  issuerUpstreamPodPort: 8080,
  consolePublicUrl: 'http://console.{tenant}.localhost:28180',
};
const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  insecureRegistry: true,
  tenantAuth: auth,
};
const ready = [
  {
    type: 'Ready' as const,
    status: 'True' as const,
    observedGeneration: 1,
    reason: 'Reconciled',
    message: '',
    lastTransitionTime: '2026-01-01T00:00:00Z',
  },
];
function tenant(spec: Tenant['spec'] = {}): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec,
    status: { conditions: ready },
  };
}
function user(name: string, tenants: string[], extra: Partial<User['spec']> = {}): User {
  return {
    apiVersion: VERSION,
    kind: 'User',
    metadata: { name, uid: `${name}-uid`, generation: 1, labels: { [INSTALLATION]: 'test' } },
    spec: { memberships: tenants.map((t) => ({ tenant: t, role: 'developer' })), ...extra },
  };
}
const tls = selfSignedCertificate('tenant-controller', ['tenant-controller'], [], 30);
const inputs: TenantAuthInputs = {
  members: ['alice', 'bob'],
  apiServer: { addresses: ['10.0.0.1'], port: 6443 },
  tls,
  clientSecret: 'c2VjcmV0',
};
type Deployment = Resource & {
  spec: {
    replicas: number;
    strategy: { type: string };
    template: {
      metadata: { labels: Record<string, string>; annotations: Record<string, string> };
      spec: {
        hostAliases?: unknown[];
        automountServiceAccountToken: boolean;
        containers: {
          name: string;
          image: string;
          env: { name: string; value?: string; valueFrom?: unknown }[];
          resources: { limits: { cpu: string; memory: string } };
          volumeMounts: { name: string; mountPath: string }[];
          args?: string[];
        }[];
        volumes: Record<string, unknown>[];
      };
    };
  };
};
const find = (resources: Resource[], kind: string, name: string) =>
  resources.find((r) => r.kind === kind && r.metadata.name === name);
const env = (d: Deployment) =>
  Object.fromEntries(d.spec.template.spec.containers[0]!.env.map((e) => [e.name, e.value]));
const egress = (resources: Resource[]) =>
  (
    find(resources, 'NetworkPolicy', 'tenant-auth-egress') as unknown as {
      spec: { egress: unknown[] };
    }
  ).spec.egress;

describe('tenant-auth configuration', () => {
  it('requires a digest-pinned image, an issuer URL and the shared OAuth client', () => {
    expect(() => assertTenantAuthConfig(undefined)).not.toThrow();
    expect(() => assertTenantAuthConfig(auth)).not.toThrow();
    expect(() =>
      assertTenantAuthConfig({ ...auth, image: 'ghcr.io/di-framework/tenant-auth:latest' }),
    ).toThrow('pinned by digest');
    expect(() => assertTenantAuthConfig({ ...auth, issuer: 'not a url' })).toThrow('issuer');
    expect(() =>
      assertTenantAuthConfig({ ...auth, oauthClient: { id: 'access', secretName: '' } }),
    ).toThrow('oauthClient');
  });

  it('rejects an invalid tenantAuth at controller startup', async () => {
    const saved = process.env.PLATFORM_CONFIG;
    process.env.PLATFORM_CONFIG = JSON.stringify({ ...cfg, tenantAuth: { ...auth, image: 'x' } });
    try {
      await expect(main()).rejects.toThrow('pinned by digest');
    } finally {
      if (saved === undefined) delete process.env.PLATFORM_CONFIG;
      else process.env.PLATFORM_CONFIG = saved;
    }
  });

  it('ships the certificate module and lets the controller grant cluster RBAC and read endpoints', () => {
    expect(CONTROLLER_SCRIPT_MODULES).toContain('tls');
    const rules = controllerClusterRoleRules();
    expect(rules.find((r) => r.resources.includes('clusterrolebindings'))?.verbs).toContain(
      'escalate',
    );
    expect(rules.find((r) => r.apiGroups.includes('discovery.k8s.io'))?.resources).toEqual([
      'endpointslices',
    ]);
  });
});

describe('tenant-auth quota', () => {
  it('adds quantities across units', () => {
    expect(addQuantity('2', '500m', 'm')).toBe('2500m');
    expect(addQuantity('1500m', '0.5', 'm')).toBe('2000m');
    expect(addQuantity('4Gi', '448Mi', 'Mi')).toBe('4544Mi');
    expect(addQuantity('1024Ki', '1Mi', 'Mi')).toBe('2Mi');
  });

  it('grows the runtime quota by the pair’s limits so the tenant keeps its whole budget', () => {
    const quota = (c: ControllerConfig, spec: Tenant['spec'] = {}) =>
      (
        find(tenantResources(tenant(spec), c), 'ResourceQuota', 'di-runtime-quota') as unknown as {
          spec: { hard: Record<string, string> };
        }
      ).spec.hard;
    expect(quota({ ...cfg, tenantAuth: undefined })).toMatchObject({
      'limits.cpu': '2',
      'limits.memory': '4Gi',
    });
    expect(quota(cfg)).toMatchObject({ 'limits.cpu': '2500m', 'limits.memory': '4544Mi' });
    expect(quota(cfg, { resources: { cpu: '3', memory: '1Gi' } })).toMatchObject({
      'limits.cpu': '3500m',
      'limits.memory': '1472Mi',
    });
  });

  it('accounts for every container the pair runs, sidecars included', () => {
    let cpu = '0';
    let memory = '0';
    for (const d of tenantAuthResources(tenant(), cfg, inputs).filter(
      (r) => r.kind === 'Deployment',
    ) as Deployment[])
      for (const c of d.spec.template.spec.containers) {
        cpu = addQuantity(cpu, c.resources.limits.cpu, 'm');
        memory = addQuantity(memory, c.resources.limits.memory, 'Mi');
      }
    expect({ cpu, memory }).toEqual(TENANT_AUTH_LIMITS);
  });
});

describe('tenantAuthResources', () => {
  it('renders nothing when the platform does not configure tenant-auth', () => {
    expect(tenantAuthResources(tenant(), { ...cfg, tenantAuth: undefined }, inputs)).toEqual([]);
  });

  it('renders the pair from the digest-pinned image with no ConfigMap bundle', () => {
    const resources = tenantAuthResources(tenant(), cfg, inputs);
    expect(
      resources.map((r) => `${r.kind}/${r.metadata.namespace ?? ''}/${r.metadata.name}`),
    ).toEqual([
      'ServiceAccount/di-runtime-alpha/tenant-controller',
      'ServiceAccount/di-runtime-alpha/tenant-console',
      'ClusterRole//di-tenant-controller-alpha',
      'Role/wasmcloud/di-tenant-controller-alpha',
      'Role/di-runtime-alpha/tenant-controller-keys',
      'ClusterRoleBinding//di-tenant-controller-alpha',
      'RoleBinding/wasmcloud/di-tenant-controller-alpha',
      'RoleBinding/di-runtime-alpha/tenant-controller-keys',
      'NetworkPolicy/di-runtime-alpha/tenant-auth-egress',
      'ConfigMap/di-runtime-alpha/tenant-controller-ca',
      'Secret/di-runtime-alpha/tenant-controller-tls',
      'Secret/di-runtime-alpha/tenant-console-oauth',
      'Deployment/di-runtime-alpha/tenant-controller',
      'Deployment/di-runtime-alpha/tenant-console',
      'Service/di-runtime-alpha/tenant-controller',
      'Service/di-runtime-alpha/tenant-console',
    ]);
    for (const r of resources)
      expect(r.metadata.labels).toMatchObject({
        [INSTALLATION]: 'test',
        [OWNER]: 'alpha-uid',
        [TENANT]: 'alpha',
        [COMPONENT]: 'tenant-auth',
      });
    expect(resources.some((r) => r.metadata.name === 'tenant-auth-bundle')).toBe(false);
    const controller = find(resources, 'Deployment', 'tenant-controller') as Deployment;
    const console = find(resources, 'Deployment', 'tenant-console') as Deployment;
    for (const d of [controller, console]) {
      expect(d.spec.replicas).toBe(1);
      expect(d.spec.strategy.type).toBe('Recreate');
      expect(d.spec.template.spec.containers[0]!.image).toBe(IMAGE);
      expect(d.spec.template.metadata.annotations).toEqual({
        [`${'platform.di-framework.dev'}/image-digest`]: `sha256:${'a'.repeat(64)}`,
      });
      expect(d.spec.template.spec.volumes[0]).toEqual({ name: 'tmp', emptyDir: {} });
      expect(
        d.spec.template.spec.volumes.some((v) => 'configMap' in v && v.name === 'bundle'),
      ).toBe(false);
      expect(d.spec.template.metadata.labels[COMPONENT]).toBe('tenant-auth');
      expect(d.spec.template.spec.containers[1]?.args).toEqual([
        'TCP-LISTEN:28180,fork,reuseaddr,bind=127.0.0.1',
        'TCP:di-platform-gateway.wasmcloud.svc.cluster.local:80',
      ]);
    }
    expect(controller.spec.template.spec.automountServiceAccountToken).toBe(true);
    expect(console.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(env(controller)).toMatchObject({
      TENANT_CONTROLLER_TENANT: 'alpha',
      TENANT_CONTROLLER_PLATFORM_NAMESPACE: 'wasmcloud',
      TENANT_CONTROLLER_ISSUER: auth.issuer,
      TENANT_CONTROLLER_HOST: '0.0.0.0',
      TENANT_CONTROLLER_TLS_CERT: '/tls/tls.crt',
      TENANT_CONTROLLER_TLS_KEY: '/tls/tls.key',
    });
    expect(controller.spec.template.spec.containers[0]!.volumeMounts).toContainEqual(
      expect.objectContaining({ mountPath: '/tls' }),
    );
    expect(controller.spec.template.spec.volumes[1]).toEqual({
      name: 'mounted',
      secret: { secretName: 'tenant-controller-tls' },
    });
    expect(env(console)).toMatchObject({
      TENANT_CONSOLE_HOST: '0.0.0.0',
      TENANT_CONSOLE_CLIENT_ID: 'access',
      TENANT_CONSOLE_PUBLIC_URL: 'http://console.alpha.localhost:28180',
      TENANT_CONSOLE_CONTROLLER_PUBLIC_URL: 'https://127.0.0.1:8788',
      TENANT_CONSOLE_CONTROLLER_URL: 'https://tenant-controller:8788',
    });
    expect(console.spec.template.spec.containers[0]!.env).toContainEqual({
      name: 'TENANT_CONSOLE_CLIENT_SECRET',
      valueFrom: { secretKeyRef: { name: 'tenant-console-oauth', key: 'clientSecret' } },
    });
    expect(find(resources, 'Secret', 'tenant-console-oauth')?.data).toEqual({
      clientSecret: 'c2VjcmV0',
    });
    expect(find(resources, 'Secret', 'tenant-controller-tls')?.data).toEqual({
      'tls.crt': Buffer.from(tls.cert).toString('base64'),
      'tls.key': Buffer.from(tls.key).toString('base64'),
    });
  });

  it('limits TokenRequest to the members and never renders empty resourceNames', () => {
    const role = (members: string[]) =>
      find(
        tenantAuthResources(tenant(), cfg, { ...inputs, members }),
        'Role',
        'di-tenant-controller-alpha',
      )?.rules;
    expect(role(['alice', 'bob'])).toEqual([
      {
        apiGroups: [''],
        resources: ['serviceaccounts/token'],
        verbs: ['create'],
        resourceNames: ['di-user-alice', 'di-user-bob'],
      },
    ]);
    expect(role([])).toEqual([]);
  });

  it('allows egress to the API server, the issuer upstream, the tenant’s di-http pods and DNS', () => {
    expect(egress(tenantAuthResources(tenant(), cfg, inputs))).toEqual([
      { to: [{ ipBlock: { cidr: '10.0.0.1/32' } }], ports: [{ protocol: 'TCP', port: 6443 }] },
      {
        to: [
          { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'wasmcloud' } } },
        ],
        ports: [
          { protocol: 'TCP', port: 80 },
          { protocol: 'TCP', port: 8080 },
        ],
      },
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'di-runtime-alpha' },
            },
            podSelector: {
              matchLabels: {
                'wasmcloud.com/hostgroup': 'tenant-alpha',
                'wasmcloud.com/name': 'hostgroup',
              },
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: 9191 }],
      },
      {
        to: [
          { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } },
        ],
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 },
        ],
      },
    ]);
    // A bare upstream defaults to port 80 and the platform namespace.
    expect(
      egress(
        tenantAuthResources(
          tenant(),
          {
            ...cfg,
            tenantAuth: { ...auth, issuerUpstream: 'gateway', issuerUpstreamPodPort: undefined },
          },
          { ...inputs, apiServer: { addresses: [], port: 443 } },
        ),
      )[0],
    ).toEqual({
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'wasmcloud' } } }],
      ports: [{ protocol: 'TCP', port: 80 }],
    });
  });

  it('reaches a public issuer by IP through hostAliases, and an IP issuer directly', () => {
    const viaIp = tenantAuthResources(
      tenant(),
      {
        ...cfg,
        tenantAuth: {
          ...auth,
          issuer: 'https://id.example.com',
          issuerIp: '192.0.2.7',
          issuerUpstream: undefined,
        },
      },
      inputs,
    );
    const controller = find(viaIp, 'Deployment', 'tenant-controller') as Deployment;
    expect(controller.spec.template.spec.hostAliases).toEqual([
      { ip: '192.0.2.7', hostnames: ['id.example.com'] },
    ]);
    expect(controller.spec.template.spec.containers).toHaveLength(1);
    expect(egress(viaIp)[1]).toEqual({
      to: [{ ipBlock: { cidr: '192.0.2.7/32' } }],
      ports: [{ protocol: 'TCP', port: 443 }],
    });
    const literal = tenantAuthResources(
      tenant(),
      {
        ...cfg,
        tenantAuth: { ...auth, issuer: 'http://192.0.2.8:4180', issuerUpstream: undefined },
      },
      inputs,
    );
    expect(egress(literal)[1]).toEqual({
      to: [{ ipBlock: { cidr: '192.0.2.8/32' } }],
      ports: [{ protocol: 'TCP', port: 4180 }],
    });
    // A loopback issuer with an IP runs the sidecar against that IP; a DNS issuer gets no rule.
    const loopback = tenantAuthResources(
      tenant(),
      {
        ...cfg,
        tenantAuth: {
          ...auth,
          issuer: 'http://localhost:4180',
          issuerIp: '192.0.2.9',
          issuerUpstream: undefined,
        },
      },
      inputs,
    );
    const sidecar = (find(loopback, 'Deployment', 'tenant-console') as Deployment).spec.template
      .spec;
    expect(sidecar.hostAliases).toBeUndefined();
    expect(sidecar.containers[1]?.args?.[1]).toBe('TCP:192.0.2.9:4180');
    const dns = tenantAuthResources(
      tenant(),
      {
        ...cfg,
        tenantAuth: { ...auth, issuer: 'https://id.example.com', issuerUpstream: undefined },
      },
      inputs,
    );
    expect(egress(dns)).toHaveLength(3);
  });

  it('stops the pair and drops its bindings for a suspended tenant', () => {
    const resources = tenantAuthResources(tenant({ suspended: true }), cfg, {
      ...inputs,
      clientSecret: undefined,
    });
    expect(resources.some((r) => r.kind.endsWith('Binding'))).toBe(false);
    expect(resources.some((r) => r.metadata.name === 'tenant-console-oauth')).toBe(false);
    for (const d of resources.filter((r) => r.kind === 'Deployment') as Deployment[])
      expect(d.spec.replicas).toBe(0);
  });
});

describe('controller certificate', () => {
  it('is self-signed for the given names and reports its validity window', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const pair = selfSignedCertificate(
      'svc',
      ['tenant-controller', 'localhost'],
      ['127.0.0.1'],
      365,
      now,
    );
    const cert = new X509Certificate(pair.cert);
    expect(cert.subjectAltName).toBe('DNS:tenant-controller, DNS:localhost, IP Address:127.0.0.1');
    expect(cert.ca).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(certificateValid(pair.cert, 30, now)).toBe(true);
    expect(certificateValid(pair.cert, 30, new Date('2027-09-15T00:00:00Z'))).toBe(false);
    expect(certificateValid('garbage', 30)).toBe(false);
  });
});

function key(value: Resource | Tenant | User): string {
  return `${collection(value.apiVersion, value.kind, value.metadata.namespace)}/${value.metadata.name}`;
}
/** In-memory API server: server-side apply merges, lists filter by label (see tenancy.test.ts). */
class MemoryApi implements Api {
  objects = new Map<string, Resource>();
  notReady = new Set<string>();
  seed(value: Resource | Tenant | User): void {
    this.objects.set(key(value), structuredClone(value) as Resource);
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, 'https://kubernetes');
    if (method === 'GET' && url.searchParams.has('labelSelector')) {
      const labels = url.searchParams
        .get('labelSelector')!
        .split(',')
        .map((v) => v.split('='));
      return {
        items: [...this.objects.values()]
          .filter(
            (v) =>
              collection(v.apiVersion, v.kind) === url.pathname &&
              labels.every(([k, x]) => v.metadata.labels?.[k!] === x),
          )
          .map(({ apiVersion: _version, kind: _kind, ...item }) => item),
      } as T;
    }
    const target = url.pathname.replace(/\/status$/, '');
    const existing = this.objects.get(target);
    if (method === 'GET') {
      if (!existing) throw new ApiError(404, 'Not found');
      return structuredClone(existing) as T;
    }
    if (method === 'DELETE') {
      this.objects.delete(target);
      return {} as T;
    }
    const data = structuredClone(body) as Resource;
    const value = {
      ...existing,
      ...data,
      metadata: { ...existing?.metadata, ...data.metadata },
    } as Resource;
    value.metadata.uid ??= `${value.metadata.name}-created-uid`;
    value.metadata.generation ??= 1;
    if (value.kind === 'Deployment')
      value.status = {
        observedGeneration: 1,
        readyReplicas: this.notReady.has(value.metadata.name)
          ? 0
          : (value.spec as { replicas: number }).replicas,
      };
    this.objects.set(target, value);
    return structuredClone(value) as T;
  }
}
function prepare() {
  const api = new MemoryApi();
  const t = tenant();
  api.seed(t);
  api.seed({
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'Host',
    metadata: { name: 'alpha-host', namespace: 'wasmcloud', labels: { hostgroup: 'tenant-alpha' } },
    environment: 'di-tenant-alpha',
    status: { conditions: ready },
  });
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'wasmcloud-runtime-tls', namespace: 'wasmcloud' },
    data: { 'ca.crt': 'test' },
  });
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'tenant-auth-oauth', namespace: 'wasmcloud' },
    data: { clientSecret: 'c2hhcmVk' },
  });
  for (const [namespace, address] of [
    ['default', '10.0.0.1'],
    ['elsewhere', '10.9.9.9'],
  ] as const)
    api.seed({
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      metadata: {
        name: `kubernetes-${namespace}`,
        namespace,
        labels: { 'kubernetes.io/service-name': 'kubernetes' },
      },
      endpoints: [{ addresses: [address] }],
      ports: [{ port: 6443 }],
    });
  return { api, controller: new Controller(api, cfg), t };
}
const path = (kind: string, namespace: string | undefined, name: string) =>
  `${collection(kind.endsWith('Role') || kind.endsWith('Binding') ? 'rbac.authorization.k8s.io/v1' : kind === 'Deployment' ? 'apps/v1' : 'v1', kind, namespace)}/${name}`;
const tokenNames = (api: MemoryApi) =>
  (
    api.objects.get(path('Role', 'wasmcloud', 'di-tenant-controller-alpha'))?.rules as
      | { resourceNames: string[] }[]
      | undefined
  )?.flatMap((r) => r.resourceNames);

describe('reconcileTenant with tenant-auth', () => {
  it('applies the pair with the copied OAuth secret and the cluster’s API server', async () => {
    const { api, controller, t } = prepare();
    api.notReady.add('tenant-console');
    await controller.reconcileTenant(t, [user('alice', ['alpha']), user('carol', ['beta'])]);
    const deployment = api.objects.get(
      path('Deployment', 'di-runtime-alpha', 'tenant-controller'),
    ) as Deployment;
    expect(deployment.spec.template.spec.containers[0]!.image).toBe(IMAGE);
    expect(
      api.objects.get(path('Secret', 'di-runtime-alpha', 'tenant-console-oauth'))?.data,
    ).toEqual({ clientSecret: 'c2hhcmVk' });
    const policy = api.objects.get(
      `${collection('networking.k8s.io/v1', 'NetworkPolicy', 'di-runtime-alpha')}/tenant-auth-egress`,
    ) as unknown as { spec: { egress: unknown[] } };
    expect(policy.spec.egress[0]).toEqual({
      to: [{ ipBlock: { cidr: '10.0.0.1/32' } }],
      ports: [{ protocol: 'TCP', port: 6443 }],
    });
    expect(
      api.objects.get(path('ClusterRoleBinding', undefined, 'di-tenant-controller-alpha')),
    ).toBeDefined();
    expect(tokenNames(api)).toEqual(['di-user-alice']);
    // The console is not ready yet, but the tenant runtime is, so Users can still bind.
    expect(t.status?.conditions?.[0]?.status).toBe('True');
  });

  it('recomputes the TokenRequest resourceNames when User memberships change', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, [user('alice', ['alpha']), user('bob', ['alpha'])]);
    expect(tokenNames(api)).toEqual(['di-user-alice', 'di-user-bob']);
    await controller.reconcileTenant(t, [
      user('alice', ['alpha'], { suspended: true }),
      user('bob', ['beta']),
    ]);
    expect(tokenNames(api)).toEqual([]);
  });

  it('lists Users itself when tick does not hand them over, and tick passes them through', async () => {
    const { api, controller, t } = prepare();
    api.seed(user('dave', ['alpha']));
    const gone = user('erin', ['alpha']);
    gone.metadata.deletionTimestamp = '2026-01-01T00:00:00Z';
    api.seed(gone);
    await controller.reconcileTenant(t);
    expect(tokenNames(api)).toEqual(['di-user-dave']);
    api.seed(user('frank', ['alpha']));
    const log = console.error;
    console.error = () => {};
    try {
      await controller.tick();
    } finally {
      console.error = log;
    }
    expect(tokenNames(api)).toEqual(['di-user-dave', 'di-user-frank']);
  });

  it('keeps a valid controller certificate and replaces one that is expiring', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const tlsPath = path('Secret', 'di-runtime-alpha', 'tenant-controller-tls');
    const first = api.objects.get(tlsPath)?.data as Record<string, string>;
    const cert = new X509Certificate(Buffer.from(first['tls.crt']!, 'base64').toString());
    expect(cert.subjectAltName).toContain('DNS:tenant-controller.di-runtime-alpha.svc');
    expect(
      api.objects.get(path('ConfigMap', 'di-runtime-alpha', 'tenant-controller-ca'))?.data,
    ).toEqual({ 'ca.crt': Buffer.from(first['tls.crt']!, 'base64').toString() });
    expect(cert.ca).toBe(true);
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(tlsPath)?.data).toEqual(first);
    const expiring = selfSignedCertificate('x', ['x'], [], 10);
    api.objects.get(tlsPath)!.data = {
      'tls.crt': Buffer.from(expiring.cert).toString('base64'),
    };
    await controller.reconcileTenant(t, []);
    const renewed = api.objects.get(tlsPath)?.data as Record<string, string> | undefined;
    expect(renewed?.['tls.crt']).not.toBe(Buffer.from(expiring.cert).toString('base64'));
  });

  it('waits for the OAuth Secret, defaults the API port, and revokes the ClusterRoleBinding on suspend', async () => {
    const { api, controller, t } = prepare();
    api.objects.delete(path('Secret', 'wasmcloud', 'tenant-auth-oauth'));
    for (const k of [...api.objects.keys()].filter((k) => k.includes('endpointslices')))
      api.objects.delete(k);
    await controller.reconcileTenant(t, []);
    expect(
      api.objects.get(path('Secret', 'di-runtime-alpha', 'tenant-console-oauth')),
    ).toBeUndefined();
    const policy = api.objects.get(
      `${collection('networking.k8s.io/v1', 'NetworkPolicy', 'di-runtime-alpha')}/tenant-auth-egress`,
    ) as unknown as { spec: { egress: unknown[] } };
    expect(policy.spec.egress).toHaveLength(3);
    t.spec.suspended = true;
    await controller.reconcileTenant(t, []);
    expect(
      api.objects.get(path('ClusterRoleBinding', undefined, 'di-tenant-controller-alpha')),
    ).toBeUndefined();
    expect(
      api.objects.get(path('RoleBinding', 'wasmcloud', 'di-tenant-controller-alpha')),
    ).toBeUndefined();
  });

  it('refuses to adopt resources left by deploy-local.ts', async () => {
    const { api, controller, t } = prepare();
    api.seed({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: 'tenant-controller',
        namespace: 'di-runtime-alpha',
        labels: { [COMPONENT]: 'tenant-auth', [TENANT]: 'alpha' },
      },
    });
    await expect(controller.reconcileTenant(t, [])).rejects.toThrow('Refusing to adopt');
  });
});
