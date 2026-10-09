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
  ISSUER_PROXY_IMAGE,
  OWNER,
  type Resource,
  TENANT,
  TENANT_AUTH_LIMITS,
  type Tenant,
  type TenantAuthConfig,
  type TenantAuthInputs,
  tenantAuthResources,
  tenantControllerCertNames,
  tenantResources,
  tlsCertDigest,
  type User,
  VERSION,
} from '../src/tenancy/resources';
import {
  certificateNames,
  certificateValid,
  selfSignedCertificate,
  serialNumber,
} from '../src/tenancy/tls';

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
          volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
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
    const cluster = rules.filter(
      (r) => r.resources.includes('clusterroles') || r.resources.includes('clusterrolebindings'),
    );
    expect(cluster).toHaveLength(1);
    expect(cluster[0]?.resources).toEqual(['clusterroles', 'clusterrolebindings']);
    expect(cluster[0]?.verbs).toEqual([
      'get',
      'list',
      'watch',
      'create',
      'patch',
      'update',
      'delete',
    ]);
    // Never cluster-admin by proxy: no rule lets it bind or escalate cluster-scoped roles.
    for (const verb of ['bind', 'escalate']) expect(cluster[0]?.verbs).not.toContain(verb);
    expect(rules.find((r) => r.resources.includes('rolebindings'))?.verbs).toContain('escalate');
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
    // Integer arithmetic: no float error rounds a sum up.
    expect(addQuantity('0.1', '0.2', 'm')).toBe('300m');
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
        [`${'platform.di-framework.dev'}/tls-cert-sha256`]: tlsCertDigest(tls.cert),
      });
      expect(d.spec.template.spec.automountServiceAccountToken).toBe(false);
      expect(d.spec.template.spec.containers[1]?.image).toBe(ISSUER_PROXY_IMAGE);
      expect(ISSUER_PROXY_IMAGE).toMatch(/^alpine\/socat@sha256:[0-9a-f]{64}$/);
      // The sidecar holds no ServiceAccount token.
      expect(d.spec.template.spec.containers[1]?.volumeMounts).toBeUndefined();
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
    // Only the controller container gets the projected token.
    expect(controller.spec.template.spec.containers[0]!.volumeMounts).toContainEqual({
      name: 'service-account',
      mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
      readOnly: true,
    });
    expect(
      controller.spec.template.spec.volumes.find((v) => v.name === 'service-account'),
    ).toHaveProperty('projected.sources.0.serviceAccountToken.path', 'token');
    expect(console.spec.template.spec.volumes.some((v) => v.name === 'service-account')).toBe(
      false,
    );
    expect(
      console.spec.template.spec.containers[0]!.volumeMounts.some(
        (m) => m.name === 'service-account',
      ),
    ).toBe(false);
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

  it('renders /128 for IPv6 API server addresses on dual-stack clusters', () => {
    const resources = tenantAuthResources(tenant(), cfg, {
      ...inputs,
      apiServer: { addresses: ['10.0.0.1', 'fd00::1'], port: 6443 },
    });
    expect(egress(resources)[0]).toEqual({
      to: [{ ipBlock: { cidr: '10.0.0.1/32' } }, { ipBlock: { cidr: 'fd00::1/128' } }],
      ports: [{ protocol: 'TCP', port: 6443 }],
    });
  });

  it('rolls both pods when the certificate changes', () => {
    const digest = (resources: Resource[]) =>
      (resources.filter((r) => r.kind === 'Deployment') as Deployment[]).map(
        (d) => d.spec.template.metadata.annotations['platform.di-framework.dev/tls-cert-sha256'],
      );
    const renewed = selfSignedCertificate('tenant-controller', ['tenant-controller'], [], 30);
    const before = digest(tenantAuthResources(tenant(), cfg, inputs));
    const after = digest(tenantAuthResources(tenant(), cfg, { ...inputs, tls: renewed }));
    expect(before[0]).toBe(before[1]);
    expect(after[0]).toBe(after[1]);
    expect(after[0]).not.toBe(before[0]);
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
    // Backdated a few minutes for clock skew.
    expect(new Date(cert.validFrom).getTime()).toBe(now.getTime() - 5 * 60_000);
    expect(certificateNames(pair.cert)).toEqual({
      dns: ['tenant-controller', 'localhost'],
      ips: ['127.0.0.1'],
    });
    expect(certificateNames('garbage')).toBeUndefined();
  });

  it('encodes every serial as a positive, minimal DER INTEGER', () => {
    for (const first of [0x00, 0x01, 0x3f, 0x7f, 0x80, 0xff]) {
      const serial = serialNumber(Buffer.from([first, 0x00, 0x00, 0x01]));
      // Positive (high bit clear) and minimal (leading byte never a redundant zero).
      expect((serial[0] as number) & 0x80).toBe(0);
      expect((serial[0] as number) & 0x40).toBe(0x40);
      expect(serial.subarray(1)).toEqual(Buffer.from([0x00, 0x00, 0x01]));
    }
    const input = Buffer.from([0x00, 0x05]);
    serialNumber(input);
    expect(input[0]).toBe(0x00);
  });

  it('produces certificates that always parse (2,000 generations)', () => {
    for (let i = 0; i < 2000; i++) {
      const pair = selfSignedCertificate('svc', ['tenant-controller'], ['127.0.0.1'], 30);
      expect(() => new X509Certificate(pair.cert)).not.toThrow();
    }
  });

  it('covers the controller’s public host besides the in-cluster names', () => {
    expect(tenantControllerCertNames('alpha')).toEqual({
      dns: [
        'tenant-controller',
        'tenant-controller.di-runtime-alpha.svc',
        'tenant-controller.di-runtime-alpha.svc.cluster.local',
        'localhost',
      ],
      ips: ['127.0.0.1'],
    });
    expect(
      tenantControllerCertNames('alpha', {
        ...auth,
        controllerPublicUrl: 'https://controller.{tenant}.example.com',
      }).dns,
    ).toContain('controller.alpha.example.com');
    expect(
      tenantControllerCertNames('alpha', { ...auth, controllerPublicUrl: 'https://10.1.2.3:8788' })
        .ips,
    ).toEqual(['127.0.0.1', '10.1.2.3']);
    expect(
      tenantControllerCertNames('alpha', { ...auth, controllerPublicUrl: 'https://[::1]:8788' }),
    ).toEqual(tenantControllerCertNames('alpha'));
    expect(
      tenantControllerCertNames('alpha', { ...auth, controllerPublicUrl: 'not a url' }),
    ).toEqual(tenantControllerCertNames('alpha'));
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
    const log = console.error;
    console.error = () => {};
    try {
      await controller.reconcileTenant(t, []);
    } finally {
      console.error = log;
    }
    // Reported on its own condition; the tenant stays Ready so members keep their access.
    const conditions = Object.fromEntries((t.status?.conditions ?? []).map((c) => [c.type, c]));
    expect(conditions.Ready?.status).toBe('True');
    expect(conditions.TenantAuthReady).toMatchObject({
      status: 'False',
      reason: 'ReconcileError',
    });
    expect(conditions.TenantAuthReady?.message).toContain('Refusing to adopt');
    const alice = user('alice', ['alpha']);
    api.seed(alice);
    await controller.reconcileUser(alice, [t]);
    expect(
      [...api.objects.values()].some(
        (r) => r.kind === 'RoleBinding' && r.metadata.labels?.[OWNER] === 'alice-uid',
      ),
    ).toBe(true);
  });

  it('reports TenantAuthReady and keeps its transition time while unchanged', async () => {
    const { api, controller, t } = prepare();
    api.notReady.add('tenant-console');
    await controller.reconcileTenant(t, []);
    const auth = () => t.status?.conditions?.find((c) => c.type === 'TenantAuthReady');
    expect(auth()).toMatchObject({ status: 'False', reason: 'Provisioning' });
    const since = auth()!.lastTransitionTime;
    await controller.reconcileTenant(t, []);
    expect(auth()?.lastTransitionTime).toBe(since);
    api.notReady.clear();
    await controller.reconcileTenant(t, []);
    expect(auth()).toMatchObject({ status: 'True', reason: 'Reconciled' });
  });

  it('reissues the certificate when the public controller host changes', async () => {
    const { api, t } = prepare();
    await new Controller(api, cfg).reconcileTenant(t, []);
    const tlsPath = path('Secret', 'di-runtime-alpha', 'tenant-controller-tls');
    const first = (api.objects.get(tlsPath)!.data as Record<string, string>)['tls.crt'];
    const moved = new Controller(api, {
      ...cfg,
      tenantAuth: { ...auth, controllerPublicUrl: 'https://controller.{tenant}.example.com' },
    });
    await moved.reconcileTenant(t, []);
    const second = (api.objects.get(tlsPath)!.data as Record<string, string>)['tls.crt']!;
    expect(second).not.toBe(first);
    expect(new X509Certificate(Buffer.from(second, 'base64').toString()).subjectAltName).toContain(
      'DNS:controller.alpha.example.com',
    );
    const deployment = api.objects.get(
      path('Deployment', 'di-runtime-alpha', 'tenant-console'),
    ) as Deployment;
    expect(
      deployment.spec.template.metadata.annotations['platform.di-framework.dev/tls-cert-sha256'],
    ).toBe(tlsCertDigest(Buffer.from(second, 'base64').toString()));
    await moved.reconcileTenant(t, []);
    expect((api.objects.get(tlsPath)!.data as Record<string, string>)['tls.crt']).toBe(second);
  });

  const tenantAuthObjects = (api: MemoryApi) =>
    [...api.objects.values()].filter((r) => r.metadata.labels?.[COMPONENT] === 'tenant-auth');

  it('prunes the pair, its RBAC and the quota addition when tenantAuth is unset', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, [user('alice', ['alpha'])]);
    expect(tenantAuthObjects(api).map((r) => r.kind)).toEqual(
      expect.arrayContaining(['ClusterRole', 'ClusterRoleBinding', 'Role', 'Deployment']),
    );
    const { tenantAuth: _, ...plain } = cfg;
    await new Controller(api, plain).reconcileTenant(t, []);
    expect(tenantAuthObjects(api)).toEqual([]);
    expect(t.status?.conditions?.map((c) => c.type)).toEqual(['Ready']);
    const quota = api.objects.get(
      `${collection('v1', 'ResourceQuota', 'di-runtime-alpha')}/di-runtime-quota`,
    ) as unknown as { spec: { hard: Record<string, string> } };
    expect(quota.spec.hard['limits.cpu']).toBe('2');
  });

  it('logs and skips a failed prune when tenantAuth is unset', async () => {
    const { api, t } = prepare();
    const { tenantAuth: _, ...plain } = cfg;
    const failing: Api = {
      call: <T>(method: string, p: string, body?: unknown) =>
        p.includes('clusterroles?')
          ? Promise.reject(new Error('forbidden'))
          : api.call<T>(method, p, body),
    };
    const errors: string[] = [];
    const log = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      await new Controller(failing, plain).reconcileTenant(t, []);
    } finally {
      console.error = log;
    }
    expect(errors).toEqual(['Tenant/alpha tenant-auth: forbidden']);
    expect(t.status?.conditions?.map((c) => c.type)).toEqual(['Ready']);
  });

  for (const deletionPolicy of ['Delete', 'Retain'] as const)
    it(`deletes the cluster-scoped and platform-namespace RBAC on tenant deletion (${deletionPolicy})`, async () => {
      const { api, controller, t } = prepare();
      await controller.reconcileTenant(t, [user('alice', ['alpha'])]);
      t.spec.deletionPolicy = deletionPolicy;
      t.metadata.deletionTimestamp = '2026-01-01T00:00:00Z';
      await controller.reconcileTenant(t, []);
      expect(
        api.objects.get(path('ClusterRole', undefined, 'di-tenant-controller-alpha')),
      ).toBeUndefined();
      expect(
        api.objects.get(path('Role', 'wasmcloud', 'di-tenant-controller-alpha')),
      ).toBeUndefined();
      expect(tenantAuthObjects(api)).toEqual([]);
    });
});
