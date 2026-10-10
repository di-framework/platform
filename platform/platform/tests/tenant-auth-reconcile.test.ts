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
  REGISTRY_PULL_SECRET,
  REGISTRY_PULL_SERVICE,
  REGISTRY_WORKLOAD,
  type Resource,
  registryHttpHost,
  registryPullHost,
  TENANT,
  TENANT_AUTH_LIMITS,
  type Tenant,
  type TenantAuthConfig,
  type TenantAuthInputs,
  tenantAuthResources,
  tenantAuthRoutes,
  tenantControllerCertNames,
  tenantRegistryPublicUrl,
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
    expect(cluster[0]?.verbs).toEqual(['get', 'list', 'create', 'patch', 'delete']);
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
        find(
          tenantResources(tenant(spec), c, undefined, [], !!c.tenantAuth),
          'ResourceQuota',
          'di-runtime-quota',
        ) as unknown as {
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
      'Role/di-tenant-alpha/tenant-controller-secret-reader',
      'ClusterRoleBinding//di-tenant-controller-alpha',
      'RoleBinding/wasmcloud/di-tenant-controller-alpha',
      'RoleBinding/di-runtime-alpha/tenant-controller-keys',
      'RoleBinding/di-tenant-alpha/tenant-controller-secret-reader',
      'NetworkPolicy/di-runtime-alpha/tenant-auth-egress',
      'NetworkPolicy/di-runtime-alpha/tenant-auth-network',
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

  it('lets the controller only read Secrets in the tenant namespace (#112)', () => {
    const resources = tenantAuthResources(tenant(), cfg, inputs);
    const role = find(resources, 'Role', 'tenant-controller-secret-reader');
    expect(role?.metadata.namespace).toBe('di-tenant-alpha');
    expect(role?.rules).toEqual([
      { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list'] },
    ]);
    const binding = find(resources, 'RoleBinding', 'tenant-controller-secret-reader');
    expect(binding?.metadata.namespace).toBe('di-tenant-alpha');
    expect(binding?.roleRef).toEqual({
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: 'tenant-controller-secret-reader',
    });
    expect(binding?.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'tenant-controller', namespace: 'di-runtime-alpha' },
    ]);
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
  /** Every PATCH in order, as `<path> <limits.cpu>` for quotas so the raise can be ordered. */
  patches: string[] = [];
  fail?: (method: string, path: string, body: unknown) => Error | undefined;
  /** RBAC verbs each request needs, as `<verb> <resource>`; a server-side apply of a missing object is a create. */
  verbs = new Set<string>();
  seed(value: Resource | Tenant | User): void {
    this.objects.set(key(value), structuredClone(value) as Resource);
  }
  private authorize(method: string, url: URL, exists: boolean): void {
    const parts = url.pathname.split('/').filter(Boolean);
    const at = parts.indexOf('namespaces');
    const resource = at >= 0 ? parts[at + 2] : parts[parts[0] === 'api' ? 2 : 3];
    const verb =
      method === 'GET'
        ? url.searchParams.has('labelSelector')
          ? 'list'
          : 'get'
        : method === 'PATCH'
          ? exists
            ? 'patch'
            : 'create'
          : method === 'DELETE'
            ? 'delete'
            : method === 'PUT'
              ? 'update'
              : 'create';
    this.verbs.add(`${verb} ${resource}`);
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, 'https://kubernetes');
    const failure = this.fail?.(method, url.pathname, body);
    if (failure) throw failure;
    if (method === 'PATCH')
      this.patches.push(
        `${url.pathname} ${(body as { spec?: { hard?: Record<string, string> } })?.spec?.hard?.['limits.cpu'] ?? ''}`.trim(),
      );
    if (method === 'GET' && url.searchParams.has('labelSelector')) {
      this.authorize(method, url, true);
      const labels = url.searchParams
        .get('labelSelector')!
        .split(',')
        .map((v) => v.split('='));
      return {
        items: [...this.objects.values()]
          .filter(
            (v) =>
              [
                collection(v.apiVersion, v.kind),
                collection(v.apiVersion, v.kind, v.metadata.namespace),
              ].includes(url.pathname) && labels.every(([k, x]) => v.metadata.labels?.[k!] === x),
          )
          .map(({ apiVersion: _version, kind: _kind, ...item }) => item),
      } as T;
    }
    const target = url.pathname.replace(/\/status$/, '');
    const existing = this.objects.get(target);
    this.authorize(method, url, existing !== undefined);
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

  it('lists each kind once per sweep and stops sweeping once nothing is left (tenantAuth unset)', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, [user('alice', ['alpha'])]);
    const lists: string[] = [];
    const counting: Api = {
      call: <T>(method: string, p: string, body?: unknown) => {
        if (method === 'GET' && p.includes(encodeURIComponent(`${COMPONENT}=tenant-auth`)))
          lists.push(p);
        return api.call<T>(method, p, body);
      },
    };
    const { tenantAuth: _, ...plain } = cfg;
    const unset = new Controller(counting, plain);
    const other = tenant();
    await unset.reconcileTenant(t, []);
    expect(lists).toHaveLength(11); // TENANT_AUTH_KINDS, the registry WorkloadDeployment included
    expect(tenantAuthObjects(api)).toEqual([]);
    lists.length = 0;
    await unset.reconcileTenant(t, []);
    await unset.reconcileTenant(other, []);
    expect(lists).toHaveLength(11); // TENANT_AUTH_KINDS, the registry WorkloadDeployment included
    lists.length = 0;
    await unset.reconcileTenant(t, []);
    await unset.reconcileTenant(other, []);
    expect(lists).toHaveLength(0);
    t.metadata.deletionTimestamp = '2026-01-01T00:00:00Z';
    await unset.reconcileTenant(t, []);
    await unset.reconcileTenant(other, []);
    expect(lists.length).toBeGreaterThan(0);
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

describe('tenant-auth reconcile ordering (#121)', () => {
  const quotaPath = `${collection('v1', 'ResourceQuota', 'di-runtime-alpha')}/di-runtime-quota`;
  const hostgroupPath = path('Deployment', 'di-runtime-alpha', 'hostgroup-tenant-alpha');
  const cpu = (api: MemoryApi) =>
    (api.objects.get(quotaPath) as unknown as { spec: { hard: Record<string, string> } }).spec.hard[
      'limits.cpu'
    ];
  const conditions = (t: Tenant) =>
    Object.fromEntries((t.status?.conditions ?? []).map((c) => [c.type, c]));
  const quiet = async (run: () => Promise<void>) => {
    const log = console.error;
    console.error = () => {};
    try {
      await run();
    } finally {
      console.error = log;
    }
  };
  const conflict = () =>
    new ApiError(409, 'Apply failed: conflict with "kubectl-set": WASH_CORE_INSTANCES');
  const leftover = (api: MemoryApi) =>
    api.seed({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: 'tenant-controller',
        namespace: 'di-runtime-alpha',
        labels: { [COMPONENT]: 'tenant-auth', [TENANT]: 'alpha' },
      },
    });

  it('reconciles tenant-auth past a hostgroup 409 and reports the conflict on Ready', async () => {
    const { api, controller, t } = prepare();
    api.fail = (method, p) => (method === 'PATCH' && p === hostgroupPath ? conflict() : undefined);
    const alice = user('alice', ['alpha']);
    api.seed(alice);
    await quiet(() => controller.reconcileTenant(t, [alice]));
    const c = conditions(t);
    expect(c.Ready).toMatchObject({ status: 'False', reason: 'ReconcileError' });
    expect(c.Ready?.message).toContain('kubectl-set');
    expect(c.TenantAuthReady).toMatchObject({ status: 'True', reason: 'Reconciled' });
    expect(
      api.objects.get(path('Deployment', 'di-runtime-alpha', 'tenant-controller')),
    ).toBeDefined();
    expect(tokenNames(api)).toEqual(['di-user-alice']);
    // The tenant step kept the base quota; the tenant-auth step raised it before the pair.
    const raised = api.patches.indexOf(`${quotaPath} 2500m`);
    const pair = api.patches.findIndex((p) => p.endsWith('/deployments/tenant-controller'));
    expect(api.patches.indexOf(`${quotaPath} 2`)).toBeLessThan(raised);
    expect(raised).toBeGreaterThan(-1);
    expect(raised).toBeLessThan(pair);
    expect(cpu(api)).toBe('2500m');
    // Member access still follows Ready alone, as before: a Not-Ready tenant grants no
    // bindings, and tenant-auth succeeding does not change that.
    await controller.reconcileUser(alice, [t]);
    expect(
      [...api.objects.values()].some(
        (r) => r.kind === 'RoleBinding' && r.metadata.labels?.[OWNER] === 'alice-uid',
      ),
    ).toBe(false);
    // Once the conflict clears the tenant is Ready and keeps the raised quota.
    api.fail = undefined;
    await controller.reconcileTenant(t, [alice]);
    expect(conditions(t).Ready?.status).toBe('True');
    expect(cpu(api)).toBe('2500m');
    // A steady-state tick with the pair present never lowers the quota to the base value.
    const before = api.patches.length;
    await controller.reconcileTenant(t, [alice]);
    expect(api.patches.slice(before)).not.toContain(`${quotaPath} 2`);
    expect(cpu(api)).toBe('2500m');
    await controller.reconcileUser(alice, [t]);
    expect(
      [...api.objects.values()].some(
        (r) => r.kind === 'RoleBinding' && r.metadata.labels?.[OWNER] === 'alice-uid',
      ),
    ).toBe(true);
  });

  it('never leaves the quota raised when the pair was not applied', async () => {
    const { api, controller, t } = prepare();
    leftover(api);
    await quiet(() => controller.reconcileTenant(t, []));
    expect(conditions(t).TenantAuthReady).toMatchObject({ status: 'False' });
    expect(
      api.objects.get(path('Deployment', 'di-runtime-alpha', 'tenant-controller')),
    ).toBeUndefined();
    expect(cpu(api)).toBe('2');
  });

  it('reports both failures when neither the tenant nor the quota rollback can be applied', async () => {
    const { api, controller, t } = prepare();
    leftover(api);
    api.fail = (method, p, body) =>
      method === 'PATCH' &&
      p === quotaPath &&
      (body as { spec: { hard: Record<string, string> } }).spec.hard['limits.cpu'] === '2'
        ? conflict()
        : undefined;
    await quiet(() => controller.reconcileTenant(t, []));
    const c = conditions(t);
    expect(c.Ready).toMatchObject({ status: 'False', reason: 'ReconcileError' });
    expect(c.TenantAuthReady).toMatchObject({ status: 'False', reason: 'ReconcileError' });
    // The raise landed, the lowering conflicted, and the next poll retries it.
    expect(cpu(api)).toBe('2500m');
  });
});

describe('tenant-auth gateway routes (#58:routes)', () => {
  const pattern = 'http://{host}.{tenant}.localhost:28180';
  const routed: TenantAuthConfig = {
    ...auth,
    consolePublicUrl: 'http://console.{tenant}.localhost:28180',
    controllerPublicUrl: 'https://controller.{tenant}.localhost:28180',
  };
  const routedCfg: ControllerConfig = { ...cfg, routeUrlPattern: pattern, tenantAuth: routed };

  it('routes gateway-shaped public URLs only while the gateway is published', () => {
    expect(tenantAuthRoutes(routed, pattern)).toEqual({
      routes: { console: 'console', controller: 'controller' },
      urls: {
        console: 'http://console.{tenant}.localhost:28180',
        controller: 'https://controller.{tenant}.localhost:28180',
      },
      problems: [],
    });
    // Unset and default URLs, or no gateway, keep today's unrouted behaviour.
    expect(tenantAuthRoutes(undefined, pattern)).toEqual({ routes: {}, urls: {}, problems: [] });
    const { consolePublicUrl: _c, controllerPublicUrl: _k, ...plain } = routed;
    expect(tenantAuthRoutes(plain, pattern)).toEqual({ routes: {}, urls: {}, problems: [] });
    expect(
      tenantAuthRoutes(
        {
          ...auth,
          consolePublicUrl: 'http://127.0.0.1:8787',
          controllerPublicUrl: 'https://127.0.0.1:8788',
        },
        pattern,
      ),
    ).toEqual({ routes: {}, urls: {}, problems: [] });
    expect(tenantAuthRoutes(routed, undefined)).toEqual({ routes: {}, urls: {}, problems: [] });
    expect(
      tenantAuthRoutes(
        { ...auth, consolePublicUrl: 'http://ui.{tenant}.localhost/' },
        'http://{host}.{tenant}.localhost',
      ).routes,
    ).toEqual({ console: 'ui' });
    // Scheme default ports count: https://…localhost is 443, http://… on :80 is the default.
    expect(
      tenantAuthRoutes(
        {
          ...auth,
          consolePublicUrl: 'http://console.{tenant}.localhost:80',
          controllerPublicUrl: 'https://controller.{tenant}.localhost:80',
        },
        'http://{host}.{tenant}.localhost',
      ).routes,
    ).toEqual({ console: 'console', controller: 'controller' });
    // Upper-case schemes and hosts are normalized, and the published URL is the lower-case one.
    expect(
      tenantAuthRoutes(
        { ...auth, consolePublicUrl: 'HTTP://Console.{tenant}.LOCALHOST:28180' },
        'HTTP://{host}.{tenant}.localhost:28180',
      ),
    ).toEqual({
      routes: { console: 'console' },
      urls: { console: 'http://console.{tenant}.localhost:28180' },
      problems: [],
    });
  });

  it('reports gateway-shaped URLs the gateway cannot route', () => {
    const problems = (overrides: Partial<TenantAuthConfig>) =>
      tenantAuthRoutes({ ...routed, ...overrides }, pattern).problems;
    expect(problems({ consolePublicUrl: 'https://console.{tenant}.localhost:28180' })).toEqual([
      'tenantAuth.consolePublicUrl must use http://',
    ]);
    expect(problems({ controllerPublicUrl: 'http://controller.{tenant}.localhost:28180' })).toEqual(
      ['tenantAuth.controllerPublicUrl must use https://'],
    );
    expect(problems({ consolePublicUrl: 'http://a.b.{tenant}.localhost:28180' })).toEqual([
      'tenantAuth.consolePublicUrl host label is invalid',
    ]);
    expect(problems({ consolePublicUrl: 'http://console.{tenant}.localhost:9999' })).toEqual([
      'tenantAuth.consolePublicUrl must use the gateway port 28180',
    ]);
    expect(
      tenantAuthRoutes(
        { ...routed, consolePublicUrl: 'http://console.{tenant}.localhost:1' },
        'http://{host}.{tenant}.localhost',
      ).problems,
    ).toEqual([
      'tenantAuth.consolePublicUrl must use the gateway port 80',
      'tenantAuth.controllerPublicUrl must use the gateway port 80',
    ]);
    // https://…localhost without a port dials 443, not the gateway's default 80.
    expect(
      tenantAuthRoutes(
        {
          ...routed,
          consolePublicUrl: undefined,
          controllerPublicUrl: 'https://controller.{tenant}.localhost',
        },
        'http://{host}.{tenant}.localhost',
      ),
    ).toEqual({
      routes: {},
      urls: {},
      problems: ['tenantAuth.controllerPublicUrl must use the gateway port 80'],
    });
    // A TLS-terminating (https://) gateway pattern cannot carry controller passthrough.
    expect(tenantAuthRoutes(routed, 'https://{host}.{tenant}.localhost:28180').problems).toEqual([
      'tenantAuth.consolePublicUrl cannot be routed: routeUrlPattern must use http://',
      'tenantAuth.controllerPublicUrl cannot be routed: routeUrlPattern must use http://',
    ]);
    expect(problems({ controllerPublicUrl: 'https://console.{tenant}.localhost:28180' })).toEqual([
      'tenantAuth.controllerPublicUrl must not share the console host',
    ]);
  });

  it('admits the gateway to the routed ports only and publishes the URLs', () => {
    const resources = tenantAuthResources(tenant(), routedCfg, inputs);
    for (const [app, port] of [
      ['tenant-console', 8787],
      ['tenant-controller', 8788],
    ] as const)
      expect(find(resources, 'NetworkPolicy', `${app}-gateway`)).toMatchObject({
        metadata: { namespace: 'di-runtime-alpha', labels: { [COMPONENT]: 'tenant-auth' } },
        spec: {
          podSelector: { matchLabels: { app } },
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: [
                {
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': 'wasmcloud' },
                  },
                  podSelector: { matchLabels: { app: 'di-platform-gateway' } },
                },
              ],
              ports: [{ protocol: 'TCP', port }],
            },
          ],
        },
      });
    const consoleOnly = tenantAuthResources(
      tenant(),
      { ...routedCfg, tenantAuth: { ...routed, controllerPublicUrl: undefined } },
      inputs,
    );
    expect(find(consoleOnly, 'NetworkPolicy', 'tenant-controller-gateway')).toBeUndefined();
    expect(find(consoleOnly, 'NetworkPolicy', 'tenant-console-gateway')).toBeDefined();
    const unrouted = tenantAuthResources(tenant(), cfg, inputs);
    expect(unrouted.filter((r) => r.metadata.name.endsWith('-gateway'))).toEqual([]);

    const routes = (c: ControllerConfig) =>
      find(tenantResources(tenant(), c, undefined), 'ConfigMap', 'di-platform-routes')?.data;
    expect(routes(routedCfg)).toEqual({
      urlTemplate: 'http://{host}.alpha.localhost:28180',
      consoleUrl: 'http://console.alpha.localhost:28180',
      controllerUrl: 'https://controller.alpha.localhost:28180',
    });
    expect(routes({ ...cfg, routeUrlPattern: pattern, tenantAuth: undefined })).toEqual({
      urlTemplate: 'http://{host}.alpha.localhost:28180',
    });
  });

  it('expands an upper-case {TENANT} placeholder the same way for the route, the SANs and the console', async () => {
    const upper: ControllerConfig = {
      ...routedCfg,
      tenantAuth: {
        ...routed,
        consolePublicUrl: 'http://console.{TENANT}.localhost:28180',
        controllerPublicUrl: 'https://controller.{TENANT}.localhost:28180',
      },
    };
    expect(
      find(tenantResources(tenant(), upper, undefined), 'ConfigMap', 'di-platform-routes')?.data,
    ).toMatchObject({
      consoleUrl: 'http://console.alpha.localhost:28180',
      controllerUrl: 'https://controller.alpha.localhost:28180',
    });
    const { api, t } = prepare();
    await new Controller(api, upper).reconcileTenant(t, []);
    const tls = api.objects.get(path('Secret', 'di-runtime-alpha', 'tenant-controller-tls'))!
      .data as Record<string, string>;
    const san = new X509Certificate(Buffer.from(tls['tls.crt']!, 'base64').toString())
      .subjectAltName;
    expect(san).toContain('DNS:controller.alpha.localhost');
    expect(san).not.toContain('{');
    const deployment = api.objects.get(
      path('Deployment', 'di-runtime-alpha', 'tenant-console'),
    ) as Deployment;
    const env = Object.fromEntries(
      (deployment.spec.template.spec.containers[0]!.env as { name: string; value?: string }[]).map(
        (e) => [e.name, e.value],
      ),
    );
    expect(env.TENANT_CONSOLE_CONTROLLER_PUBLIC_URL).toBe(
      'https://controller.alpha.localhost:28180',
    );
    expect(env.TENANT_CONSOLE_PUBLIC_URL).toBe('http://console.alpha.localhost:28180');
  });

  it('applies the routes, prunes unrouted policies and reports problems on TenantAuthReady', async () => {
    const { api, t } = prepare();
    const policy = (name: string) =>
      api.objects.get(
        `${collection('networking.k8s.io/v1', 'NetworkPolicy', 'di-runtime-alpha')}/${name}`,
      );
    await new Controller(api, routedCfg).reconcileTenant(t, []);
    expect(policy('tenant-console-gateway')).toBeDefined();
    expect(policy('tenant-controller-gateway')).toBeDefined();
    const authCondition = () => t.status?.conditions?.find((c) => c.type === 'TenantAuthReady');
    expect(authCondition()).toMatchObject({ status: 'True', reason: 'Reconciled' });

    // Moving the controller off the gateway drops its policy and keeps the console's.
    await new Controller(api, {
      ...routedCfg,
      tenantAuth: { ...routed, controllerPublicUrl: 'https://127.0.0.1:8788' },
    }).reconcileTenant(t, []);
    expect(policy('tenant-controller-gateway')).toBeUndefined();
    expect(policy('tenant-console-gateway')).toBeDefined();

    // A policy of the same name this installation does not own is left alone.
    api.seed({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'tenant-controller-gateway', namespace: 'di-runtime-alpha' },
    });
    await new Controller(api, {
      ...routedCfg,
      tenantAuth: { ...routed, controllerPublicUrl: 'http://controller.{tenant}.localhost:28180' },
    }).reconcileTenant(t, []);
    expect(policy('tenant-controller-gateway')).toBeDefined();
    expect(authCondition()).toMatchObject({
      status: 'False',
      reason: 'RouteError',
      message: 'tenantAuth.controllerPublicUrl must use https://',
    });
    expect(t.status?.conditions?.find((c) => c.type === 'Ready')?.status).toBe('True');
  });

  it('prunes an unrouted gateway policy even when a later apply fails', async () => {
    const { api, t } = prepare();
    const path = `${collection('networking.k8s.io/v1', 'NetworkPolicy', 'di-runtime-alpha')}/tenant-controller-gateway`;
    await new Controller(api, routedCfg).reconcileTenant(t, []);
    expect(api.objects.get(path)).toBeDefined();
    api.fail = (method, p) =>
      method === 'PATCH' && p.includes('/deployments/') ? new ApiError(409, 'conflict') : undefined;
    await new Controller(api, {
      ...routedCfg,
      tenantAuth: { ...routed, controllerPublicUrl: 'https://127.0.0.1:8788' },
    }).reconcileTenant(t, []);
    expect(api.objects.get(path)).toBeUndefined();
    expect(t.status?.conditions?.find((c) => c.type === 'TenantAuthReady')?.status).toBe('False');
  });
});

describe('tenant registry (#83:reconcile)', () => {
  const COMPONENT_REF = `ghcr.io/di-framework/oci-registry@sha256:${'b'.repeat(64)}`;
  const pattern = 'http://{host}.{tenant}.localhost:28180';
  const withRegistry: TenantAuthConfig = {
    ...auth,
    registry: { component: COMPONENT_REF, publicUrl: 'https://registry.{tenant}.localhost:28180' },
  };
  const registryCfg: ControllerConfig = {
    ...cfg,
    routeUrlPattern: pattern,
    tenantAuth: withRegistry,
  };
  const wdPath = `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', 'di-tenant-alpha')}/${REGISTRY_WORKLOAD}`;
  const tenantQuotaPath = `${collection('v1', 'ResourceQuota', 'di-tenant-alpha')}/di-tenant-quota`;
  const workloads = (api: MemoryApi) =>
    (api.objects.get(tenantQuotaPath) as unknown as { spec: { hard: Record<string, string> } }).spec
      .hard['count/workloaddeployments.runtime.wasmcloud.dev'];
  const authCondition = (t: Tenant) =>
    t.status?.conditions?.find((c) => c.type === 'TenantAuthReady');
  type Workload = Resource & {
    spec: {
      replicas: number;
      template: {
        spec: {
          environment: string;
          hostSelector: Record<string, string>;
          components: unknown[];
          hostInterfaces: unknown[];
        };
      };
    };
  };
  const hard = (value: Resource | undefined) =>
    (value as unknown as { spec: { hard: Record<string, string> } }).spec.hard;

  it('requires a digest-pinned registry component and a URL', () => {
    expect(() => assertTenantAuthConfig(withRegistry)).not.toThrow();
    expect(() =>
      assertTenantAuthConfig({
        ...auth,
        registry: { component: 'ghcr.io/di-framework/oci-registry:latest' },
      }),
    ).toThrow('tenantAuth.registry.component must be pinned by digest');
    expect(() =>
      assertTenantAuthConfig({ ...auth, registry: {} as { component: string } }),
    ).toThrow('tenantAuth.registry.component must be pinned by digest');
    expect(() =>
      assertTenantAuthConfig({
        ...auth,
        registry: { component: COMPONENT_REF, publicUrl: 'not a url' },
      }),
    ).toThrow('tenantAuth.registry.publicUrl must be a URL');
  });

  it('routes the registry host through the gateway and always blocks it over plain HTTP', () => {
    expect(tenantAuthRoutes(withRegistry, pattern)).toMatchObject({
      routes: { console: 'console', registry: 'registry' },
      urls: { registry: 'https://registry.{tenant}.localhost:28180' },
      problems: [],
    });
    // A port-forwarded registry still has its HTTP host refused by a published gateway.
    const forwarded = { ...auth, registry: { component: COMPONENT_REF } };
    expect(tenantAuthRoutes(forwarded, pattern).routes.registry).toBe('registry');
    expect(tenantAuthRoutes(forwarded, pattern).urls.registry).toBeUndefined();
    expect(tenantAuthRoutes(forwarded, undefined).routes).toEqual({});
    const oci = {
      ...auth,
      registry: { component: COMPONENT_REF, publicUrl: 'https://oci.{tenant}.localhost:28180' },
    };
    expect(tenantAuthRoutes(oci, pattern).routes.registry).toBe('oci');
    const at = (publicUrl: string) =>
      tenantAuthRoutes({ ...auth, registry: { component: COMPONENT_REF, publicUrl } }, pattern)
        .problems;
    expect(at('http://registry.{tenant}.localhost:28180')).toEqual([
      'tenantAuth.registry.publicUrl must use https://',
    ]);
    expect(at('https://console.{tenant}.localhost:28180')).toEqual([
      'tenantAuth.registry.publicUrl must not share the console host',
    ]);
    expect(
      tenantAuthRoutes(
        { ...forwarded, consolePublicUrl: 'http://registry.{tenant}.localhost:28180' },
        pattern,
      ).problems,
    ).toEqual(['tenantAuth.registry.publicUrl must not share the console host']);
  });

  it('names the registry HTTP host from a gateway-shaped URL, else registry', () => {
    const at = (publicUrl: string) =>
      registryHttpHost({ ...auth, registry: { component: COMPONENT_REF, publicUrl } });
    expect(registryHttpHost(undefined)).toBe('registry');
    expect(registryHttpHost(withRegistry)).toBe('registry');
    expect(at('https://OCI.{tenant}.localhost')).toBe('oci');
    expect(at('https://a_b.{tenant}.localhost')).toBe('registry');
    expect(tenantRegistryPublicUrl('alpha', withRegistry)).toBe(
      'https://registry.alpha.localhost:28180',
    );
    expect(
      tenantRegistryPublicUrl('alpha', { ...auth, registry: { component: COMPONENT_REF } }),
    ).toBe('https://127.0.0.1:8790');
  });

  it('renders the registry workload, the whoami listener and the registry front', () => {
    const resources = tenantAuthResources(tenant(), registryCfg, {
      ...inputs,
      registryServing: true,
    });
    const workload = find(resources, 'WorkloadDeployment', REGISTRY_WORKLOAD) as Workload;
    expect(workload.metadata.namespace).toBe('di-tenant-alpha');
    expect(workload.metadata.labels).toMatchObject({
      [COMPONENT]: 'tenant-auth',
      [OWNER]: 'alpha-uid',
      [INSTALLATION]: 'test',
    });
    expect(workload.spec.replicas).toBe(1);
    const spec = workload.spec.template.spec;
    expect(spec.environment).toBe('di-tenant-alpha');
    expect(spec.hostSelector).toEqual({ hostgroup: 'tenant-alpha' });
    expect(spec.components).toEqual([
      {
        name: 'oci-registry',
        image: COMPONENT_REF,
        localResources: { allowedHosts: ['tenant-controller.di-runtime-alpha.svc:8789'] },
      },
    ]);
    expect(spec.hostInterfaces).toEqual([
      {
        namespace: 'wasi',
        package: 'http',
        version: '0.3.0',
        interfaces: ['handler'],
        config: { host: 'registry' },
      },
      {
        namespace: 'wasmcloud',
        package: 'blobstore',
        version: '0.1.0',
        interfaces: ['blobstore', 'container', 'types'],
      },
      {
        namespace: 'wasmcloud',
        package: 'secrets',
        interfaces: ['store', 'reveal'],
        config: {
          'tenant-controller-url': 'http://tenant-controller.di-runtime-alpha.svc:8789',
          tenant: 'alpha',
        },
      },
    ]);
    const controller = find(resources, 'Deployment', 'tenant-controller') as Deployment;
    expect(env(controller)).toMatchObject({
      TENANT_CONTROLLER_WHOAMI_PORT: '8789',
      TENANT_CONTROLLER_REGISTRY_FRONT_PORT: '8790',
      TENANT_CONTROLLER_REGISTRY_HOST: 'registry',
      TENANT_CONTROLLER_REGISTRY_URL: 'https://registry.alpha.localhost:28180',
    });
    expect(
      (controller.spec.template.spec.containers[0] as unknown as { ports: unknown[] }).ports,
    ).toEqual([
      { containerPort: 8788, name: 'http' },
      { containerPort: 8789, name: 'whoami' },
      { containerPort: 8790, name: 'registry' },
      { containerPort: 8791, name: 'pull' },
    ]);
    expect(find(resources, 'Service', 'tenant-controller')).toMatchObject({
      spec: {
        ports: [
          { port: 8788, targetPort: 8788, name: 'http' },
          { port: 8789, targetPort: 8789, name: 'whoami' },
          { port: 8790, targetPort: 8790, name: 'registry' },
        ],
      },
    });
    // Only the tenant hosts reach the whoami listener; only the gateway the registry front.
    expect(find(resources, 'NetworkPolicy', 'tenant-auth-network')).toMatchObject({
      spec: {
        podSelector: { matchLabels: { [COMPONENT]: 'tenant-auth' } },
        ingress: [
          { ports: [{ protocol: 'TCP', port: 8788 }] },
          {
            from: [
              {
                podSelector: {
                  matchLabels: {
                    'wasmcloud.com/hostgroup': 'tenant-alpha',
                    'wasmcloud.com/name': 'hostgroup',
                  },
                },
              },
            ],
            ports: [
              { protocol: 'TCP', port: 8789 },
              { protocol: 'TCP', port: 8791 },
            ],
          },
        ],
      },
    });
    expect(find(resources, 'NetworkPolicy', 'tenant-registry-gateway')).toMatchObject({
      spec: {
        podSelector: { matchLabels: { app: 'tenant-controller' } },
        ingress: [{ ports: [{ protocol: 'TCP', port: 8790 }] }],
      },
    });
    // Until the registry serves (W4), the controller has no registry front and no registry URL.
    const closed = env(
      find(
        tenantAuthResources(tenant(), registryCfg, inputs),
        'Deployment',
        'tenant-controller',
      ) as Deployment,
    );
    expect(closed).toMatchObject({
      TENANT_CONTROLLER_WHOAMI_PORT: '8789',
      TENANT_CONTROLLER_REGISTRY_HOST: 'registry',
    });
    expect(closed).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_FRONT_PORT');
    expect(closed).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_URL');
    expect(closed).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT');
    // Without a registry, none of it.
    const plain = tenantAuthResources(tenant(), { ...registryCfg, tenantAuth: auth }, inputs);
    expect(find(plain, 'WorkloadDeployment', REGISTRY_WORKLOAD)).toBeUndefined();
    expect(env(find(plain, 'Deployment', 'tenant-controller') as Deployment)).not.toHaveProperty(
      'TENANT_CONTROLLER_REGISTRY_URL',
    );
    const plainNetwork = find(plain, 'NetworkPolicy', 'tenant-auth-network') as unknown as {
      spec: { ingress: unknown[] };
    };
    expect(plainNetwork.spec.ingress).toHaveLength(1);
    // A suspended tenant keeps the registry at zero replicas.
    const suspended = tenantAuthResources(tenant({ suspended: true }), registryCfg, inputs);
    const stopped = find(suspended, 'WorkloadDeployment', REGISTRY_WORKLOAD) as Workload;
    expect(stopped.spec.replicas).toBe(0);
  });

  it('keeps tenant-auth pods out of di-tenant-network and grows the workload quota by one', () => {
    const resources = tenantResources(tenant(), cfg, undefined, [], false, true, true);
    const key = 'count/workloaddeployments.runtime.wasmcloud.dev';
    expect(hard(find(resources, 'ResourceQuota', 'di-tenant-quota'))[key]).toBe('21');
    expect(
      hard(find(tenantResources(tenant(), cfg), 'ResourceQuota', 'di-tenant-quota'))[key],
    ).toBe('20');
    const network = find(resources, 'NetworkPolicy', 'di-tenant-network') as unknown as {
      spec: { podSelector: { matchExpressions: { values: string[] }[] }; egress: unknown[] };
    };
    expect(network.spec.podSelector.matchExpressions[0]!.values).toContain('tenant-auth');
    // The pair keeps exactly the egress it had through di-tenant-network.
    const pair = find(
      tenantAuthResources(tenant(), registryCfg, inputs),
      'NetworkPolicy',
      'tenant-auth-network',
    ) as unknown as { spec: { egress: unknown[] } };
    expect(pair.spec.egress).toEqual(network.spec.egress);
  });

  it('covers the registry public host in the controller certificate', () => {
    expect(tenantControllerCertNames('alpha', withRegistry).dns).toContain(
      'registry.alpha.localhost',
    );
    expect(
      tenantControllerCertNames('alpha', {
        ...auth,
        registry: { component: COMPONENT_REF, publicUrl: 'https://10.1.2.3:8790' },
      }).ips,
    ).toContain('10.1.2.3');
  });

  it('deploys the registry after raising the workload quota and reports it on TenantAuthReady', async () => {
    const { api, t } = prepare();
    const controller = new Controller(api, registryCfg);
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(wdPath)).toBeDefined();
    const workload = api.patches.indexOf(wdPath);
    expect(api.patches.lastIndexOf(tenantQuotaPath, workload)).toBeGreaterThan(-1);
    expect(workloads(api)).toBe('21');
    expect(authCondition(t)).toMatchObject({
      status: 'False',
      reason: 'Provisioning',
      message: 'Waiting for the tenant controller, console and registry',
    });
    expect(t.status?.conditions?.find((c) => c.type === 'Ready')?.status).toBe('True');
    api.objects.get(wdPath)!.status = { conditions: ready };
    await controller.reconcileTenant(t, []);
    expect(authCondition(t)).toMatchObject({
      status: 'True',
      reason: 'Reconciled',
      message: 'Tenant controller, console and registry are ready',
    });
    // The tenant step keeps the slot while the registry exists.
    expect(workloads(api)).toBe('21');
    // A suspended tenant does not wait for its stopped registry.
    api.objects.get(wdPath)!.status = {};
    t.spec.suspended = true;
    await controller.reconcileTenant(t, []);
    expect(authCondition(t)).toMatchObject({ reason: 'Reconciled' });
  });

  it('removes the registry and its quota slot when the registry is unset', async () => {
    const { api, t } = prepare();
    await new Controller(api, registryCfg).reconcileTenant(t, []);
    expect(api.objects.get(wdPath)).toBeDefined();
    const without = new Controller(api, { ...registryCfg, tenantAuth: auth });
    await without.reconcileTenant(t, []);
    expect(api.objects.get(wdPath)).toBeUndefined();
    expect(workloads(api)).toBe('20');
    expect(
      api.objects.get(
        `${collection('networking.k8s.io/v1', 'NetworkPolicy', 'di-runtime-alpha')}/tenant-registry-gateway`,
      ),
    ).toBeUndefined();
    // A workload of that name this installation does not own is left alone.
    api.seed({
      apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
      kind: 'WorkloadDeployment',
      metadata: { name: REGISTRY_WORKLOAD, namespace: 'di-tenant-alpha' },
    });
    await without.reconcileTenant(t, []);
    expect(api.objects.get(wdPath)).toBeDefined();
  });

  it('narrows di-tenant-network only once tenant-auth-network exists (S1)', async () => {
    const networkPath = `${collection('networking.k8s.io/v1', 'NetworkPolicy', 'di-runtime-alpha')}/di-tenant-network`;
    const authNetworkPath = `${collection('networking.k8s.io/v1', 'NetworkPolicy', 'di-runtime-alpha')}/tenant-auth-network`;
    const excluded = (api: MemoryApi) =>
      (
        api.objects.get(networkPath) as unknown as {
          spec: { podSelector: { matchExpressions: { values: string[] }[] } };
        }
      ).spec.podSelector.matchExpressions[0]!.values.includes('tenant-auth');
    // A tenant-auth step that fails before its network policy keeps the pair on the broad policy.
    const failing = prepare();
    failing.api.fail = (method, p) =>
      method === 'PATCH' && p === authNetworkPath ? new ApiError(500, 'boom') : undefined;
    const log = console.error;
    console.error = () => {};
    try {
      for (let poll = 0; poll < 2; poll++)
        await new Controller(failing.api, registryCfg).reconcileTenant(failing.t, []);
    } finally {
      console.error = log;
    }
    expect(failing.api.objects.get(authNetworkPath)).toBeUndefined();
    expect(excluded(failing.api)).toBe(false);
    // Otherwise the first poll applies tenant-auth-network, and the next one narrows.
    const { api, t } = prepare();
    const controller = new Controller(api, registryCfg);
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(authNetworkPath)).toBeDefined();
    expect(excluded(api)).toBe(false);
    await controller.reconcileTenant(t, []);
    expect(excluded(api)).toBe(true);
    // A tenant-auth-network this installation does not own does not count.
    api.objects.get(authNetworkPath)!.metadata.labels = {};
    await controller.reconcileTenant(t, []);
    expect(excluded(api)).toBe(false);
  });

  it('needs only WorkloadDeployment verbs the platform ClusterRole grants (#83 C2)', async () => {
    const { api, t } = prepare();
    await new Controller(api, registryCfg).reconcileTenant(t, []);
    await new Controller(api, { ...registryCfg, tenantAuth: auth }).reconcileTenant(t, []);
    const used = [...api.verbs]
      .filter((entry) => entry.endsWith(' workloaddeployments'))
      .map((entry) => entry.split(' ')[0]);
    // The registry is created (a server-side apply of a missing object) and deleted.
    expect(used).toContain('create');
    expect(used).toContain('delete');
    const granted = controllerClusterRoleRules().find((r) =>
      r.resources.includes('workloaddeployments'),
    )?.verbs;
    for (const verb of used) expect(granted).toContain(verb);
  });

  it('keeps unlabelled user workloads when the registry or tenant-auth is removed (S2)', async () => {
    const { api, t } = prepare();
    const user = `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', 'di-tenant-alpha')}/web-prod`;
    api.seed({
      apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
      kind: 'WorkloadDeployment',
      metadata: { name: 'web-prod', namespace: 'di-tenant-alpha' },
    });
    await new Controller(api, registryCfg).reconcileTenant(t, []);
    await new Controller(api, { ...registryCfg, tenantAuth: auth }).reconcileTenant(t, []);
    expect(api.objects.get(wdPath)).toBeUndefined();
    expect(api.objects.get(user)).toBeDefined();
    await new Controller(api, registryCfg).reconcileTenant(t, []);
    const { tenantAuth: _, ...plain } = registryCfg;
    await new Controller(api, plain).reconcileTenant(t, []);
    expect(api.objects.get(wdPath)).toBeUndefined();
    expect(api.objects.get(user)).toBeDefined();
  });

  it('removes the registry with the rest of tenant-auth when tenantAuth is unset', async () => {
    const { api, t } = prepare();
    await new Controller(api, registryCfg).reconcileTenant(t, []);
    const { tenantAuth: _, ...plain } = registryCfg;
    await new Controller(api, plain).reconcileTenant(t, []);
    expect(api.objects.get(wdPath)).toBeUndefined();
  });

  it('gives the quota slot back when the registry could not be applied', async () => {
    const { api, t } = prepare();
    api.fail = (method, p) =>
      method === 'PATCH' && p === wdPath ? new ApiError(409, 'conflict') : undefined;
    const log = console.error;
    console.error = () => {};
    try {
      await new Controller(api, registryCfg).reconcileTenant(t, []);
    } finally {
      console.error = log;
    }
    expect(authCondition(t)).toMatchObject({ status: 'False', reason: 'ReconcileError' });
    expect(workloads(api)).toBe('20');
  });

  it('leaves the registry’s own egress out of the egress grants', async () => {
    const patched: string[] = [];
    const component = (name: string, host: string) => ({
      spec: {
        template: { spec: { components: [{ name, localResources: { allowedHosts: [host] } }] } },
      },
    });
    const items: { metadata: { name: string; labels?: Record<string, string> }; spec: unknown }[] =
      [
        {
          metadata: {
            name: REGISTRY_WORKLOAD,
            labels: { [OWNER]: 'alpha-uid', [INSTALLATION]: 'test' },
          },
          ...component('oci-registry', 'x:1'),
        },
        { metadata: { name: 'web-prod' }, ...component('web', 'y:1') },
      ];
    const api: Api = {
      call: async <T>(method: string, p: string) => {
        if (method === 'GET' && p.endsWith('/workloaddeployments')) return { items } as T;
        if (method === 'PATCH') patched.push(p);
        if (method === 'GET') throw new ApiError(404, 'Not found');
        return {} as T;
      },
    };
    await new Controller(api, registryCfg).reconcileTenantEgress(tenant(), [], new Map());
    expect(patched).toEqual([
      `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', 'di-tenant-alpha')}/web-prod?fieldManager=di-platform-egress`,
    ]);
    // A tenant's own di-tenant-registry without the platform labels is not skipped (S2): its
    // egress is stripped like any other workload's.
    patched.length = 0;
    items.splice(0, items.length, {
      metadata: { name: REGISTRY_WORKLOAD, labels: {} },
      ...component('oci-registry', 'x:1'),
    });
    await new Controller(api, registryCfg).reconcileTenantEgress(tenant(), [], new Map());
    expect(patched).toEqual([
      `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', 'di-tenant-alpha')}/${REGISTRY_WORKLOAD}?fieldManager=di-platform-egress`,
    ]);
  });

  it('renders the registry front limits from tenantAuth.registry.limits (S6)', () => {
    const limited: TenantAuthConfig = {
      ...withRegistry,
      registry: {
        component: COMPONENT_REF,
        limits: {
          maxBodyBytes: 1024,
          upstreamTimeoutMs: 5000,
          maxConcurrent: 4,
          uploadIdleTimeoutMs: 7000,
        },
      },
    };
    expect(() => assertTenantAuthConfig(limited)).not.toThrow();
    const controller = env(
      find(
        tenantAuthResources(tenant(), { ...registryCfg, tenantAuth: limited }, inputs),
        'Deployment',
        'tenant-controller',
      ) as Deployment,
    );
    expect(controller).toMatchObject({
      TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES: '1024',
      TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS: '5000',
      TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT: '4',
      TENANT_CONTROLLER_REGISTRY_UPLOAD_IDLE_TIMEOUT_MS: '7000',
    });
    // Only the limits that are set are rendered.
    const one = env(
      find(
        tenantAuthResources(
          tenant(),
          {
            ...registryCfg,
            tenantAuth: {
              ...withRegistry,
              registry: { component: COMPONENT_REF, limits: { maxConcurrent: 2 } },
            },
          },
          inputs,
        ),
        'Deployment',
        'tenant-controller',
      ) as Deployment,
    );
    expect(one.TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT).toBe('2');
    expect(one).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES');
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() =>
        assertTenantAuthConfig({
          ...withRegistry,
          registry: { component: COMPONENT_REF, limits: { upstreamTimeoutMs: bad } },
        }),
      ).toThrow('tenantAuth.registry.limits.upstreamTimeoutMs must be a positive integer');
    expect(() =>
      assertTenantAuthConfig({
        ...withRegistry,
        registry: { component: COMPONENT_REF, limits: { maxConcurency: 4 } as never },
      }),
    ).toThrow(
      'tenantAuth.registry.limits.maxConcurency is not a known limit (maxBodyBytes, upstreamTimeoutMs, maxConcurrent, uploadIdleTimeoutMs)',
    );
    for (const bad of ['4', 4, null, [4]])
      expect(() =>
        assertTenantAuthConfig({
          ...withRegistry,
          registry: { component: COMPONENT_REF, limits: bad as never },
        }),
      ).toThrow('tenantAuth.registry.limits must be an object');
  });

  describe('registry host conflicts and readiness (W4)', () => {
    const controllerPath = path('Deployment', 'di-runtime-alpha', 'tenant-controller');
    const frontEnv = (api: MemoryApi) =>
      env(api.objects.get(controllerPath) as unknown as Deployment);
    const claimant = (name: string, config: Record<string, string>, labels = {}) => ({
      apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
      kind: 'WorkloadDeployment',
      metadata: { name, namespace: 'di-tenant-alpha', labels },
      spec: {
        template: {
          spec: {
            hostInterfaces: [
              { namespace: 'wasmcloud', package: 'secrets', config: { host: 'registry' } },
              { namespace: 'wasi', package: 'http', interfaces: ['handler'], config },
            ],
          },
        },
      },
    });
    const claimantPath = (name: string) =>
      `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', 'di-tenant-alpha')}/${name}`;
    const quiet = async (run: () => Promise<void>) => {
      const log = console.error;
      console.error = () => {};
      try {
        await run();
      } finally {
        console.error = log;
      }
    };

    const template = (api: MemoryApi) =>
      JSON.stringify((api.objects.get(controllerPath) as unknown as Deployment).spec.template);

    it('opens the front without waiting for registry readiness, which never restarts the controller', async () => {
      const { api, t } = prepare();
      const controller = new Controller(api, registryCfg);
      await controller.reconcileTenant(t, []);
      expect(frontEnv(api).TENANT_CONTROLLER_REGISTRY_FRONT_PORT).toBe('8790');
      expect(frontEnv(api)).toHaveProperty('TENANT_CONTROLLER_REGISTRY_URL');
      expect(authCondition(t)).toMatchObject({ status: 'False', reason: 'Provisioning' });
      const opened = template(api);
      api.objects.get(wdPath)!.status = { conditions: ready };
      await controller.reconcileTenant(t, []);
      expect(authCondition(t)).toMatchObject({ status: 'True', reason: 'Reconciled' });
      expect(template(api)).toBe(opened);
      // The registry stops being Ready after the front opened: TenantAuthReady reports it, and the
      // controller's env and pod template stay as they are (W6).
      api.objects.get(wdPath)!.status = {};
      await controller.reconcileTenant(t, []);
      expect(authCondition(t)).toMatchObject({ status: 'False', reason: 'Provisioning' });
      expect(template(api)).toBe(opened);
      expect(frontEnv(api).TENANT_CONTROLLER_REGISTRY_FRONT_PORT).toBe('8790');
    });

    it('closes an open front when a claimant appears, and while the tenant is suspended', async () => {
      const { api, t } = prepare();
      const controller = new Controller(api, registryCfg);
      await controller.reconcileTenant(t, []);
      api.objects.get(wdPath)!.status = { conditions: ready };
      await controller.reconcileTenant(t, []);
      expect(frontEnv(api).TENANT_CONTROLLER_REGISTRY_FRONT_PORT).toBe('8790');
      api.seed(claimant('late', { host: 'registry' }));
      await quiet(() => controller.reconcileTenant(t, []));
      expect(authCondition(t)).toMatchObject({ reason: 'RegistryHostConflict' });
      expect(frontEnv(api)).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_FRONT_PORT');
      expect(frontEnv(api)).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_URL');
      api.objects.delete(claimantPath('late'));
      await controller.reconcileTenant({ ...t, spec: { ...t.spec, suspended: true } }, []);
      expect(frontEnv(api)).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_FRONT_PORT');
      expect(frontEnv(api)).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_URL');
    });

    it('refuses to serve a host another workload claims, and recovers once it is removed', async () => {
      const { api, t } = prepare();
      // A tenant workload created before the reservation, claiming the host in another case.
      api.seed(claimant('own-registry', { host: 'Registry' }));
      const controller = new Controller(api, registryCfg);
      await quiet(() => controller.reconcileTenant(t, []));
      api.objects.get(wdPath)!.status = { conditions: ready };
      await controller.reconcileTenant(t, []);
      expect(authCondition(t)).toMatchObject({
        status: 'False',
        reason: 'RegistryHostConflict',
        message:
          'WorkloadDeployment own-registry claims the tenant registry host registry; the registry is not served until it is removed',
      });
      expect(frontEnv(api)).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_FRONT_PORT');
      expect(t.status?.conditions?.find((c) => c.type === 'Ready')?.status).toBe('True');
      api.objects.delete(claimantPath('own-registry'));
      await controller.reconcileTenant(t, []);
      expect(authCondition(t)).toMatchObject({ status: 'True', reason: 'Reconciled' });
      expect(frontEnv(api).TENANT_CONTROLLER_REGISTRY_FRONT_PORT).toBe('8790');
    });

    it('finds claims through host-aliases and after a registry label change', async () => {
      const { api, t } = prepare();
      api.seed(claimant('aliased', { host: 'web', 'host-aliases': 'a.b, REGISTRY.' }));
      await quiet(() => new Controller(api, registryCfg).reconcileTenant(t, []));
      expect(authCondition(t)?.message).toStartWith('WorkloadDeployment aliased claims');
      api.objects.delete(claimantPath('aliased'));
      // Hosts that merely contain the label, and non-http interfaces, are no claim.
      api.seed(claimant('web', { host: 'registry-ui', 'host-aliases': 'x' }));
      api.seed({ ...claimant('bare', {}), spec: {} });
      api.objects.get(wdPath)!.status = { conditions: ready };
      await new Controller(api, registryCfg).reconcileTenant(t, []);
      expect(authCondition(t)).toMatchObject({ reason: 'Reconciled' });
      // The operator moves the registry to a label a tenant workload already serves.
      api.seed(claimant('oci-app', { host: 'oci' }));
      const moved: ControllerConfig = {
        ...registryCfg,
        tenantAuth: {
          ...withRegistry,
          registry: { component: COMPONENT_REF, publicUrl: 'https://oci.{tenant}.localhost:28180' },
        },
      };
      await new Controller(api, moved).reconcileTenant(t, []);
      expect(authCondition(t)).toMatchObject({
        reason: 'RegistryHostConflict',
        message: expect.stringContaining(
          'WorkloadDeployment oci-app claims the tenant registry host oci',
        ),
      });
      expect(frontEnv(api)).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_FRONT_PORT');
    });
  });
});

describe('tenant registry host pull (#83:host-pull)', () => {
  const COMPONENT_REF = `ghcr.io/di-framework/oci-registry@sha256:${'b'.repeat(64)}`;
  const withRegistry: TenantAuthConfig = {
    ...auth,
    registry: { component: COMPONENT_REF, publicUrl: 'https://registry.{tenant}.localhost:28180' },
  };
  const tlsCfg: ControllerConfig = {
    ...cfg,
    insecureRegistry: false,
    routeUrlPattern: 'http://{host}.{tenant}.localhost:28180',
    tenantAuth: withRegistry,
  };
  const insecureCfg: ControllerConfig = { ...tlsCfg, insecureRegistry: true };
  const TOKEN = 't'.repeat(43);
  const pullSecretPath = path('Secret', 'di-runtime-alpha', REGISTRY_PULL_SECRET);
  const pullServicePath = path('Service', 'di-runtime-alpha', REGISTRY_PULL_SERVICE);
  const hostPath = path('Deployment', 'di-runtime-alpha', 'hostgroup-tenant-alpha');
  const caPath = path('ConfigMap', 'di-runtime-alpha', 'tenant-controller-ca');
  const decode = (value: string) => Buffer.from(value, 'base64').toString();
  const token = (api: MemoryApi) =>
    decode((api.objects.get(pullSecretPath)!.data as Record<string, string>).token!);
  const host = (resources: Resource[] | MemoryApi) =>
    (Array.isArray(resources)
      ? find(resources, 'Deployment', 'hostgroup-tenant-alpha')
      : resources.objects.get(hostPath)) as unknown as Deployment;
  const schedulerSecret = { data: { 'ca.crt': 'test' } };
  const rulesOf = (role: Resource | undefined) =>
    (role as unknown as { rules: { resources: string[]; verbs: string[] }[] }).rules;

  it('renders the pull Secret, the pull listener and the pull Service', () => {
    const resources = tenantAuthResources(tenant(), tlsCfg, {
      ...inputs,
      registryServing: true,
      hostPullToken: TOKEN,
    });
    const secret = find(resources, 'Secret', REGISTRY_PULL_SECRET)!;
    expect(secret.metadata.namespace).toBe('di-runtime-alpha');
    expect(secret.metadata.labels).toMatchObject({
      [COMPONENT]: 'tenant-auth',
      [OWNER]: 'alpha-uid',
    });
    const data = secret.data as Record<string, string>;
    expect(decode(data.token!)).toBe(TOKEN);
    expect(JSON.parse(decode(data['config.json']!))).toEqual({
      auths: {
        'tenant-registry.di-runtime-alpha.svc': {
          auth: Buffer.from(`tenant-host:${TOKEN}`).toString('base64'),
        },
      },
    });
    expect(registryPullHost('alpha')).toBe('tenant-registry.di-runtime-alpha.svc');
    const controller = find(resources, 'Deployment', 'tenant-controller') as Deployment;
    expect(env(controller)).toMatchObject({
      TENANT_CONTROLLER_REGISTRY_PULL_PORT: '8791',
      TENANT_CONTROLLER_REGISTRY_PULL_HOST: 'tenant-registry.di-runtime-alpha.svc',
      TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE: '/tls/host-pull-token',
    });
    expect(env(controller)).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_PULL_TLS');
    // The token is a file next to the certificate, so a rotation reaches the pod without a restart.
    expect(controller.spec.template.spec.volumes).toContainEqual({
      name: 'mounted',
      projected: {
        sources: [
          { secret: { name: 'tenant-controller-tls' } },
          {
            secret: {
              name: REGISTRY_PULL_SECRET,
              items: [{ key: 'token', path: 'host-pull-token' }],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(controller.spec.template)).not.toContain(TOKEN);
    expect(find(resources, 'Service', REGISTRY_PULL_SERVICE)).toMatchObject({
      metadata: { namespace: 'di-runtime-alpha', labels: { [COMPONENT]: 'tenant-auth' } },
      spec: {
        selector: { app: 'tenant-controller' },
        ports: [{ name: 'pull', port: 443, targetPort: 8791 }],
      },
    });
    // Plain HTTP on port 80 when wash pulls everything over plain HTTP.
    const insecure = tenantAuthResources(tenant(), insecureCfg, {
      ...inputs,
      registryServing: true,
      hostPullToken: TOKEN,
    });
    expect(
      env(find(insecure, 'Deployment', 'tenant-controller') as Deployment)
        .TENANT_CONTROLLER_REGISTRY_PULL_TLS,
    ).toBe('false');
    expect(find(insecure, 'Service', REGISTRY_PULL_SERVICE)).toMatchObject({
      spec: { ports: [{ name: 'pull', port: 80, targetPort: 8791 }] },
    });
  });

  it('opens the pull listener only while the front is served, and needs the token for the Secret', () => {
    const closed = tenantAuthResources(tenant(), tlsCfg, { ...inputs, hostPullToken: TOKEN });
    const closedEnv = env(find(closed, 'Deployment', 'tenant-controller') as Deployment);
    expect(closedEnv).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_PULL_PORT');
    expect(closedEnv.TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE).toBe('/tls/host-pull-token');
    const tokenless = tenantAuthResources(tenant(), tlsCfg, { ...inputs, registryServing: true });
    expect(find(tokenless, 'Secret', REGISTRY_PULL_SECRET)).toBeUndefined();
    const controller = find(tokenless, 'Deployment', 'tenant-controller') as Deployment;
    expect(env(controller)).not.toHaveProperty('TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE');
    expect(controller.spec.template.spec.volumes).toContainEqual({
      name: 'mounted',
      secret: { secretName: 'tenant-controller-tls' },
    });
    // Without a registry, a stray token renders nothing.
    const plain = tenantAuthResources(
      tenant(),
      { ...tlsCfg, tenantAuth: auth },
      { ...inputs, registryServing: true, hostPullToken: TOKEN },
    );
    expect(find(plain, 'Secret', REGISTRY_PULL_SECRET)).toBeUndefined();
    expect(find(plain, 'Service', REGISTRY_PULL_SERVICE)).toBeUndefined();
  });

  it('admits only the tenant host pods to the pull listener', () => {
    const resources = tenantAuthResources(tenant(), tlsCfg, {
      ...inputs,
      registryServing: true,
      hostPullToken: TOKEN,
    });
    const policies = resources.filter((r) => r.kind === 'NetworkPolicy') as unknown as {
      metadata: { name: string };
      spec: { ingress?: { from: unknown[]; ports?: { port: number }[] }[] };
    }[];
    const admitting = policies.flatMap((p) =>
      (p.spec.ingress ?? [])
        .filter((rule) => rule.ports?.some((port) => port.port === 8791))
        .map((rule) => ({ policy: p.metadata.name, from: rule.from })),
    );
    expect(admitting).toEqual([
      {
        policy: 'tenant-auth-network',
        from: [
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
      },
    ]);
    // Every ingress rule on the tenant-auth pods names its ports, so none opens 8791 implicitly.
    for (const p of policies.filter((p) => p.metadata.name.startsWith('tenant-')))
      for (const rule of p.spec.ingress ?? []) expect(rule.ports?.length).toBeGreaterThan(0);
  });

  it('covers the pull Service in the controller certificate', () => {
    expect(tenantControllerCertNames('alpha', withRegistry).dns).toEqual(
      expect.arrayContaining([
        'tenant-registry.di-runtime-alpha.svc',
        'tenant-registry.di-runtime-alpha.svc.cluster.local',
      ]),
    );
    expect(tenantControllerCertNames('alpha', auth).dns).not.toContain(
      'tenant-registry.di-runtime-alpha.svc',
    );
  });

  it('configures the hosts with the Docker config and, over TLS, the tenant CA', () => {
    const none = host(tenantResources(tenant(), tlsCfg, schedulerSecret));
    expect(env(none)).not.toHaveProperty('DOCKER_CONFIG');
    expect(none.spec.template.metadata.annotations).toBeUndefined();
    expect(none.spec.template.spec.containers[0]!.args).not.toContain(
      '--oci-ca-path=/registry-ca/ca.crt',
    );
    expect(JSON.stringify(none.spec.template.spec.volumes)).not.toContain('registry-');

    const withCa = host(
      tenantResources(tenant(), tlsCfg, schedulerSecret, [], false, true, false, {
        caDigest: 'abc',
      }),
    );
    const container = withCa.spec.template.spec.containers[0]!;
    expect(container.args).toContain('--oci-ca-path=/registry-ca/ca.crt');
    expect(container.args).not.toContain('--allow-insecure-registries');
    expect(env(withCa).DOCKER_CONFIG).toBe('/registry-auth');
    expect(withCa.spec.template.metadata.annotations).toEqual({
      'platform.di-framework.dev/registry-ca-sha256': 'abc',
    });
    expect(container.volumeMounts).toEqual(
      expect.arrayContaining([
        { name: 'registry-auth', mountPath: '/registry-auth', readOnly: true },
        { name: 'registry-ca', mountPath: '/registry-ca', readOnly: true },
      ]),
    );
    expect(withCa.spec.template.spec.volumes).toEqual(
      expect.arrayContaining([
        {
          name: 'registry-auth',
          secret: {
            secretName: REGISTRY_PULL_SECRET,
            optional: true,
            items: [{ key: 'config.json', path: 'config.json' }],
          },
        },
        {
          name: 'registry-ca',
          configMap: { name: 'tenant-controller-ca', items: [{ key: 'ca.crt', path: 'ca.crt' }] },
        },
      ]),
    );
    // Plain HTTP: the credential only, no CA.
    const plain = host(
      tenantResources(tenant(), insecureCfg, schedulerSecret, [], false, true, false, {}),
    );
    expect(env(plain).DOCKER_CONFIG).toBe('/registry-auth');
    expect(plain.spec.template.spec.containers[0]!.args).toContain('--allow-insecure-registries');
    expect(plain.spec.template.spec.containers[0]!.args).not.toContain(
      '--oci-ca-path=/registry-ca/ca.crt',
    );
    expect(JSON.stringify(plain.spec.template.spec.volumes)).not.toContain('registry-ca');
  });

  it('keeps no credential where a tenant user can read it', () => {
    const resources = tenantResources(tenant(), tlsCfg, schedulerSecret, [], false, true, false, {
      caDigest: 'abc',
    });
    // Runtime-namespace roles (where the pull Secret lives) grant no Secret access and no exec.
    for (const name of ['di-runtime-viewer', 'di-runtime-developer'])
      for (const rule of rulesOf(find(resources, 'Role', name))) {
        expect(rule.resources).not.toContain('secrets');
        expect(rule.resources).not.toContain('pods/exec');
        expect(rule.resources).not.toContain('pods/attach');
      }
    // Tenant-namespace developers write Secrets but never read them (#112).
    const developer = rulesOf(find(resources, 'Role', 'di-developer'));
    const secretRules = developer.filter((r) => r.resources.includes('secrets'));
    expect(secretRules.length).toBeGreaterThan(0);
    for (const rule of secretRules)
      for (const verb of ['get', 'list', 'watch', 'patch']) expect(rule.verbs).not.toContain(verb);
    // The host pod holds a Secret volume reference, never the token itself.
    expect(JSON.stringify(host(resources))).not.toContain(TOKEN);
    const auths = tenantAuthResources(tenant(), tlsCfg, {
      ...inputs,
      registryServing: true,
      hostPullToken: TOKEN,
    });
    // The token appears in the runtime-namespace pull Secret only, and nowhere in clear.
    expect(
      auths.filter((r) => JSON.stringify(r).includes(Buffer.from(TOKEN).toString('base64'))),
    ).toEqual([find(auths, 'Secret', REGISTRY_PULL_SECRET)!]);
    expect(auths.filter((r) => JSON.stringify(r).includes(TOKEN))).toEqual([]);
  });

  it('wires the hosts once the registry and the tenant CA exist, and rotation leaves them alone', async () => {
    const { api, t } = prepare();
    const controller = new Controller(api, tlsCfg);
    await controller.reconcileTenant(t, []);
    // The tenant step ran before the registry existed, so the hosts are not wired yet.
    expect(env(host(api))).not.toHaveProperty('DOCKER_CONFIG');
    const first = token(api);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(api.objects.get(pullServicePath)).toBeDefined();
    await controller.reconcileTenant(t, []);
    expect(env(host(api)).DOCKER_CONFIG).toBe('/registry-auth');
    const ca = (api.objects.get(caPath)!.data as Record<string, string>)['ca.crt']!;
    expect(host(api).spec.template.metadata.annotations).toEqual({
      'platform.di-framework.dev/registry-ca-sha256': tlsCertDigest(ca),
    });
    const template = JSON.stringify(host(api).spec.template);
    // The token is kept across reconciles.
    expect(token(api)).toBe(first);
    // Deleting the Secret rotates it, and the host template stays byte-identical across the
    // rotation (W1 of the :host-pull review): the wiring comes from desired state, not the Secret.
    api.objects.delete(pullSecretPath);
    await controller.reconcileTenant(t, []);
    expect(JSON.stringify(host(api).spec.template)).toBe(template);
    const second = token(api);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    await controller.reconcileTenant(t, []);
    expect(JSON.stringify(host(api).spec.template)).toBe(template);
    expect(token(api)).toBe(second);
    // A malformed one is replaced too.
    (api.objects.get(pullSecretPath)!.data as Record<string, string>).token =
      Buffer.from('short').toString('base64');
    await controller.reconcileTenant(t, []);
    expect(token(api)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(host(api).spec.template)).toBe(template);
  });

  it('keeps the hosts wired while the pull Secret cannot be recreated', async () => {
    const { api, t } = prepare();
    const controller = new Controller(api, tlsCfg);
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    const template = JSON.stringify(host(api).spec.template);
    const log = console.error;
    console.error = () => {};
    try {
      api.objects.delete(pullSecretPath);
      api.fail = (method, p) =>
        method === 'PATCH' && p === pullSecretPath ? new ApiError(500, 'boom') : undefined;
      await controller.reconcileTenant(t, []);
      expect(JSON.stringify(host(api).spec.template)).toBe(template);
    } finally {
      api.fail = undefined;
      console.error = log;
    }
  });

  it('does not roll the hosts while the CA ConfigMap is temporarily missing', async () => {
    const { api, t } = prepare();
    const controller = new Controller(api, tlsCfg);
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    const template = JSON.stringify(host(api).spec.template);
    expect(template).toContain('registry-ca-sha256');
    const log = console.error;
    console.error = () => {};
    try {
      // The tenant-auth step cannot recreate it either, so it stays missing across the tick.
      api.fail = (method, p) =>
        method === 'PATCH' && p === caPath ? new ApiError(500, 'boom') : undefined;
      api.objects.delete(caPath);
      await controller.reconcileTenant(t, []);
      expect(JSON.stringify(host(api).spec.template)).toBe(template);
      // A restarted controller reads the last digest from the host template.
      api.objects.delete(caPath);
      await new Controller(api, tlsCfg).reconcileTenant(t, []);
      expect(JSON.stringify(host(api).spec.template)).toBe(template);
      // With neither a CA nor a known digest, the hosts get the credential and no CA yet.
      api.objects.delete(caPath);
      api.objects.delete(hostPath);
      await new Controller(api, tlsCfg).reconcileTenant(t, []);
      expect(env(host(api)).DOCKER_CONFIG).toBe('/registry-auth');
      expect(host(api).spec.template.metadata.annotations).toBeUndefined();
    } finally {
      api.fail = undefined;
      console.error = log;
    }
    // Once the CA is back, the hosts trust it.
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    expect(JSON.stringify(host(api).spec.template)).toBe(template);
  });

  it('reports a failed host wiring lookup on TenantAuthReady, not as a reconcile error', async () => {
    const { api, t } = prepare();
    const controller = new Controller(api, tlsCfg);
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    const template = JSON.stringify(host(api).spec.template);
    const conditions = () =>
      Object.fromEntries((t.status?.conditions ?? []).map((c) => [c.type, c]));
    let failures = 0;
    api.fail = (method, p) =>
      method === 'GET' && p === caPath && failures++ === 0
        ? new ApiError(500, 'configmaps unavailable')
        : undefined;
    // Known wiring: the hosts keep it.
    await controller.reconcileTenant(t, []);
    expect(JSON.stringify(host(api).spec.template)).toBe(template);
    expect(conditions().Ready?.reason).not.toBe('ReconcileError');
    expect(conditions().TenantAuthReady).toMatchObject({
      status: 'False',
      reason: 'HostPullError',
    });
    expect(conditions().TenantAuthReady?.message).toContain('configmaps unavailable');
    // Unknown wiring (a restarted controller): the host Deployment is left untouched this tick.
    failures = 0;
    const patches = api.patches.length;
    await new Controller(api, tlsCfg).reconcileTenant(t, []);
    expect(api.patches.slice(patches).some((entry) => entry.startsWith(hostPath))).toBe(false);
    expect(JSON.stringify(host(api).spec.template)).toBe(template);
    expect(conditions().TenantAuthReady?.reason).toBe('HostPullError');
    api.fail = undefined;
    await controller.reconcileTenant(t, []);
    expect(conditions().TenantAuthReady?.reason).not.toBe('HostPullError');
  });

  it('wires the hosts without a CA when they pull over plain HTTP', async () => {
    const { api, t } = prepare();
    const controller = new Controller(api, insecureCfg);
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    expect(env(host(api)).DOCKER_CONFIG).toBe('/registry-auth');
    expect(host(api).spec.template.spec.containers[0]!.args).not.toContain(
      '--oci-ca-path=/registry-ca/ca.crt',
    );
    expect(api.objects.get(pullServicePath)).toMatchObject({
      spec: { ports: [{ port: 80, targetPort: 8791 }] },
    });
  });

  it('removes the pull Secret and Service with the registry, and leaves foreign ones', async () => {
    const { api, t } = prepare();
    await new Controller(api, tlsCfg).reconcileTenant(t, []);
    await new Controller(api, tlsCfg).reconcileTenant(t, []);
    const without = new Controller(api, { ...tlsCfg, tenantAuth: auth });
    await without.reconcileTenant(t, []);
    expect(api.objects.get(pullSecretPath)).toBeUndefined();
    expect(api.objects.get(pullServicePath)).toBeUndefined();
    // The hosts drop the pull configuration once the registry is gone.
    await without.reconcileTenant(t, []);
    expect(env(host(api))).not.toHaveProperty('DOCKER_CONFIG');
    for (const [kind, name] of [
      ['Secret', REGISTRY_PULL_SECRET],
      ['Service', REGISTRY_PULL_SERVICE],
    ] as const)
      api.seed({ apiVersion: 'v1', kind, metadata: { name, namespace: 'di-runtime-alpha' } });
    await without.reconcileTenant(t, []);
    expect(api.objects.get(pullSecretPath)).toBeDefined();
    expect(api.objects.get(pullServicePath)).toBeDefined();
  });

  it('needs only Secret, Service and ConfigMap verbs the platform ClusterRole grants', async () => {
    const { api, t } = prepare();
    await new Controller(api, tlsCfg).reconcileTenant(t, []);
    await new Controller(api, tlsCfg).reconcileTenant(t, []);
    await new Controller(api, { ...tlsCfg, tenantAuth: auth }).reconcileTenant(t, []);
    for (const resource of ['secrets', 'services', 'configmaps']) {
      const used = [...api.verbs]
        .filter((entry) => entry.endsWith(` ${resource}`))
        .map((entry) => entry.split(' ')[0]);
      expect(used).toContain('get');
      const granted = controllerClusterRoleRules()
        .filter((r) => r.resources.includes(resource))
        .flatMap((r) => r.verbs);
      for (const verb of used) expect(granted).toContain(verb as string);
    }
  });
});
