import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  configFromEnv as controllerConfigFromEnv,
  serveWhoamiListener,
} from '../../tenant-auth/src/controller';
import { platformRegistryPullHost } from '../src/insecure-registries';
import { CA_DAYS, CA_OVERLAP_DAYS, CA_RENEW_DAYS } from '../src/tenancy/ca-rotation';
import {
  type Api,
  ApiError,
  Controller,
  collection,
  main,
  withHostPullFailure,
} from '../src/tenancy/controller';
import { CONTROLLER_SCRIPT_MODULES, controllerClusterRoleRules } from '../src/tenancy/install';
import {
  addQuantity,
  assertTenantAuthConfig,
  CA_BUNDLE_ANNOTATION,
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
  registryWhoamiHost,
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
  unsetPublicUrls,
  VERSION,
  withDerivedPublicUrls,
} from '../src/tenancy/resources';
import {
  caCertificate,
  caConstraints,
  caPermittedDns,
  certificateNames,
  certificateValid,
  holdsCaKey,
  issuedBy,
  leafCertificate,
  selfSignedCertificate,
  serialNumber,
} from '../src/tenancy/tls';
import { opensslVerifies, verifiesAt as verifies, withinNameConstraints } from './support/tls';

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
/** A CA plus a leaf it signed, as the controller stores them. */
function tlsFixture(dnsName = 'tenant-controller', days = 30): TenantAuthInputs['tls'] {
  const ca = caCertificate('tenant-controller CA', 3650);
  const leaf = leafCertificate('tenant-controller', [dnsName], [], days, ca.cert, ca.key);
  return { ...leaf, caCert: ca.cert, caKey: ca.key };
}
const tls = tlsFixture();
const inputs: TenantAuthInputs = {
  members: [
    { name: 'alice', role: 'developer', suspended: false },
    { name: 'bob', role: 'viewer', suspended: false },
  ],
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
    expect(CONTROLLER_SCRIPT_MODULES).toContain('ca-rotation');
    const rules = controllerClusterRoleRules();
    const cluster = rules.filter(
      (r) => r.resources.includes('clusterroles') || r.resources.includes('clusterrolebindings'),
    );
    expect(cluster).toHaveLength(1);
    expect(cluster[0]?.resources).toEqual(['clusterroles', 'clusterrolebindings']);
    expect(cluster[0]?.verbs).toEqual(['get', 'list', 'create', 'patch', 'delete']);
    // Never cluster-admin by proxy: no rule lets it bind or escalate cluster-scoped roles.
    for (const verb of ['bind', 'escalate']) expect(cluster[0]?.verbs).not.toContain(verb);
    // Nor namespaced ones (#115): no escalate, and bind only on named Roles.
    expect(rules.flatMap((r) => r.verbs)).not.toContain('escalate');
    for (const rule of rules.filter((r) => r.verbs.includes('bind')))
      expect(rule.resourceNames?.length).toBeGreaterThan(0);
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
      'Role/di-apikeys-alpha/tenant-controller-keys',
      'Role/di-tenant-alpha/tenant-controller-secret-reader',
      'ClusterRoleBinding//di-tenant-controller-alpha',
      'RoleBinding/wasmcloud/di-tenant-controller-alpha',
      'RoleBinding/di-runtime-alpha/tenant-controller-keys',
      'RoleBinding/di-apikeys-alpha/tenant-controller-keys',
      'RoleBinding/di-tenant-alpha/tenant-controller-secret-reader',
      'NetworkPolicy/di-runtime-alpha/tenant-auth-egress',
      'NetworkPolicy/di-runtime-alpha/tenant-auth-network',
      // The CA key is stored before the bundle and the leaf publish the CA (#170).
      'Secret/wasmcloud/tenant-controller-ca-alpha',
      'ConfigMap/di-runtime-alpha/tenant-controller-members',
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
        // Only the console reads the trust bundle (#170).
        ...(d === console ? { [CA_BUNDLE_ANNOTATION]: tlsCertDigest(tls.caCert) } : {}),
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
      TENANT_CONSOLE_CONTROLLER_PUBLIC_URL: 'https://localhost:8788',
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
      'ca.crt': Buffer.from(tls.caCert).toString('base64'),
    });
    // The CA and its key live together in the platform namespace (#170), out of the tenant
    // controller's reach, and the runtime namespace holds no CA key.
    const caSecret = find(resources, 'Secret', 'tenant-controller-ca-alpha');
    expect(caSecret?.metadata.namespace).toBe('wasmcloud');
    expect(caSecret?.data).toEqual({
      'ca.crt': Buffer.from(tls.caCert).toString('base64'),
      'ca.key': Buffer.from(tls.caKey).toString('base64'),
    });
    expect(find(resources, 'Secret', 'tenant-controller-ca-key')).toBeUndefined();
    for (const r of resources.filter((r) => r.metadata.namespace === 'di-runtime-alpha'))
      expect(JSON.stringify(r)).not.toContain(Buffer.from(tls.caKey).toString('base64'));
    expect(find(resources, 'ConfigMap', 'tenant-controller-ca')?.data).toEqual({
      'ca.crt': tls.caCert,
    });
    // The CA key is never mounted or referenced by a pod.
    expect(JSON.stringify(resources.filter((r) => r.kind === 'Deployment'))).not.toContain(
      'tenant-controller-ca-alpha',
    );
  });

  it('limits TokenRequest to the members and never renders empty resourceNames', () => {
    const role = (names: string[]) =>
      find(
        tenantAuthResources(tenant(), cfg, {
          ...inputs,
          members: names.map((name) => ({ name, role: 'viewer', suspended: false })),
        }),
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
    const renewed = tlsFixture();
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

  it('issues a CA and a distinct leaf that verifies against it', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const ca = caCertificate('tenant-controller CA (di-runtime-alpha)', 3650, now);
    const leaf = leafCertificate(
      'tenant-controller.di-runtime-alpha.svc',
      ['tenant-controller', 'localhost'],
      ['127.0.0.1'],
      365,
      ca.cert,
      ca.key,
      now,
    );
    const caX = new X509Certificate(ca.cert);
    const leafX = new X509Certificate(leaf.cert);
    expect(caX.ca).toBe(true);
    expect(caX.subject).toBe('CN=tenant-controller CA (di-runtime-alpha)');
    expect(caX.issuer).toBe(caX.subject);
    expect(caX.subjectAltName).toBeUndefined();
    expect(leafX.ca).toBe(false);
    expect(leafX.subject).toBe('CN=tenant-controller.di-runtime-alpha.svc');
    expect(leafX.issuer).toBe(caX.subject);
    expect(leafX.subject).not.toBe(leafX.issuer);
    expect(leafX.subjectAltName).toBe('DNS:tenant-controller, DNS:localhost, IP Address:127.0.0.1');
    expect(leafX.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(leafX.checkIssued(caX)).toBe(true);
    expect(leafX.verify(caX.publicKey)).toBe(true);
    expect(leafX.verify(leafX.publicKey)).toBe(false);
    expect(leafX.checkPrivateKey(createPrivateKey(leaf.key))).toBe(true);
    expect(caX.checkPrivateKey(createPrivateKey(ca.key))).toBe(true);
    expect(new Date(leafX.validFrom).getTime()).toBe(now.getTime() - 5 * 60_000);
    expect(issuedBy(ca.cert, leaf.cert, leaf.key)).toBe(true);
    expect(holdsCaKey(ca.cert, ca.key)).toBe(true);
  });

  it("caps the leaf's notAfter at the CA's notAfter", () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const ca = caCertificate('CA', 100, now);
    const caEnd = new Date(new X509Certificate(ca.cert).validTo).getTime();
    const capped = leafCertificate('leaf', ['a'], [], 365, ca.cert, ca.key, now);
    expect(new Date(new X509Certificate(capped.cert).validTo).getTime()).toBe(caEnd);
    const shorter = leafCertificate('leaf', ['a'], [], 30, ca.cert, ca.key, now);
    expect(new Date(new X509Certificate(shorter.cert).validTo).getTime()).toBe(
      now.getTime() + 30 * 86_400_000,
    );
  });

  it('encodes the CA and leaf extensions RFC 5280 requires', () => {
    const ca = caCertificate('CA', 30);
    const leaf = leafCertificate('leaf', ['a'], [], 30, ca.cert, ca.key);
    const text = (pem: string) =>
      execFileSync('openssl', ['x509', '-noout', '-text'], { input: pem }).toString();
    const caText = text(ca.cert);
    expect(caText).toMatch(/Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
    expect(caText).toMatch(/Key Usage: critical\s+Certificate Sign, CRL Sign/);
    expect(caText).toContain('Subject Key Identifier');
    const leafText = text(leaf.cert);
    expect(leafText).toMatch(/Key Usage: critical\s+Digital Signature/);
    const ski = /Subject Key Identifier:\s+(\S+)/.exec(caText)?.[1];
    expect(leafText).toMatch(new RegExp(`Authority Key Identifier:\\s+${ski}`));
  });

  it('rejects mismatched pairs without throwing', () => {
    const ca = caCertificate('CA', 30);
    const other = caCertificate('CA2', 30);
    const leaf = leafCertificate('leaf', ['a'], [], 30, ca.cert, ca.key);
    expect(issuedBy(other.cert, leaf.cert, leaf.key)).toBe(false);
    expect(issuedBy(ca.cert, leaf.cert, other.key)).toBe(false);
    expect(issuedBy(leaf.cert, leaf.cert, leaf.key)).toBe(false);
    expect(issuedBy('', leaf.cert, leaf.key)).toBe(false);
    expect(holdsCaKey(ca.cert, other.key)).toBe(false);
    expect(holdsCaKey(leaf.cert, leaf.key)).toBe(false);
    expect(holdsCaKey('', '')).toBe(false);
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
      ips: [],
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
    // IPv6 literals are named too, as certificateNames reads them back.
    expect(
      tenantControllerCertNames('alpha', { ...auth, controllerPublicUrl: 'https://[fd00::1]:8788' })
        .ips,
    ).toEqual(['127.0.0.1', 'FD00:0:0:0:0:0:0:1']);
    expect(
      tenantControllerCertNames('alpha', { ...auth, controllerPublicUrl: 'https://[::1]:8788' })
        .dns,
    ).toEqual(tenantControllerCertNames('alpha').dns);
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
    // The suspended member is still listed for `/-/members`, flagged, but not as active (#321).
    const members = api.objects.get(
      path('ConfigMap', 'di-runtime-alpha', 'tenant-controller-members'),
    );
    expect(members?.data).toEqual({
      members: '[]',
      entries: JSON.stringify([{ name: 'alice', role: 'developer', suspended: true }]),
    });
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

  const tlsPath = path('Secret', 'di-runtime-alpha', 'tenant-controller-tls');
  const caKeyPath = path('Secret', 'wasmcloud', 'tenant-controller-ca-alpha');
  const legacyCaKeyPath = path('Secret', 'di-runtime-alpha', 'tenant-controller-ca-key');
  const caMapPath = path('ConfigMap', 'di-runtime-alpha', 'tenant-controller-ca');
  const decode = (data: Record<string, string> | undefined, key: string) =>
    Buffer.from(data?.[key] ?? '', 'base64').toString();
  const encode = (value: string) => Buffer.from(value).toString('base64');
  /** The object at `p`, failing the test when it is missing. */
  const must = (api: MemoryApi, p: string): Resource => {
    const value = api.objects.get(p);
    if (!value) throw new Error(`${p} is missing`);
    return value;
  };
  /** A runtime-namespace `tenant-controller-ca-key` as packages before #170 wrote it. */
  const seedLegacyCaKey = (api: MemoryApi, labels: Resource['metadata']['labels'], key: string) =>
    api.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'tenant-controller-ca-key',
        namespace: 'di-runtime-alpha',
        uid: 'legacy-uid',
        labels,
      },
      type: 'Opaque',
      data: { 'ca.key': key },
    } as Resource);
  /** Runs `run` with `console.error` silenced. */
  const quietly = async (run: () => Promise<unknown>) => {
    const log = console.error;
    console.error = () => {};
    try {
      await run();
    } finally {
      console.error = log;
    }
  };
  /**
   * A reconciled tenant turned back into the layout before #170: the CA key alone in the runtime
   * namespace and `ca.crt` in the TLS Secret.
   */
  const legacyLayout = async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const tls = must(api, tlsPath);
    const before = structuredClone(tls.data);
    const bundle = api.objects.get(caMapPath)?.data;
    const keys = api.objects.get(caKeyPath)?.data as Record<string, string>;
    api.objects.delete(caKeyPath);
    seedLegacyCaKey(api, { ...tls.metadata.labels }, field(keys, 'ca.key'));
    return { api, controller, t, before, bundle, keys };
  };
  /** `data[key]`, failing the test when it is missing. */
  const field = (data: Record<string, string>, key: string): string => {
    const value = data[key];
    if (value === undefined) throw new Error(`${key} is missing`);
    return value;
  };

  it('issues a CA and a leaf, keeps both while valid, and publishes only the CA', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const first = api.objects.get(tlsPath)?.data as Record<string, string>;
    const cert = new X509Certificate(decode(first, 'tls.crt'));
    const caPem = decode(first, 'ca.crt');
    expect(caPem).not.toBe('');
    expect(cert.subjectAltName).toContain('DNS:tenant-controller.di-runtime-alpha.svc');
    expect(cert.ca).toBe(false);
    expect(api.objects.get(caMapPath)?.data).toEqual({ 'ca.crt': caPem });
    expect(issuedBy(caPem, decode(first, 'tls.crt'), decode(first, 'tls.key'))).toBe(true);
    const keys = api.objects.get(caKeyPath)?.data as Record<string, string>;
    // ca.crt is kept with its key (#170 S2).
    expect(decode(keys, 'ca.crt')).toBe(caPem);
    expect(holdsCaKey(caPem, decode(keys, 'ca.key'))).toBe(true);
    expect(api.objects.get(legacyCaKeyPath)).toBeUndefined();
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(tlsPath)?.data).toEqual(first);
    expect(api.objects.get(caKeyPath)?.data).toEqual(keys);
  });

  it('reads each controller TLS Secret once per reconcile pass', async () => {
    const { api, controller, t } = prepare();
    const gets = new Map<string, number>();
    api.fail = (method, p) => {
      if (method === 'GET') gets.set(p, (gets.get(p) ?? 0) + 1);
      return undefined;
    };
    for (let pass = 1; pass <= 2; pass++) {
      gets.clear();
      await controller.reconcileTenant(t, []);
      expect(gets.get(tlsPath)).toBe(1);
      expect(gets.get(caKeyPath)).toBe(1);
      expect(gets.get(legacyCaKeyPath)).toBe(1);
    }
  });

  it('renews an expiring leaf under the same CA', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const first = api.objects.get(tlsPath)?.data as Record<string, string>;
    const keys = api.objects.get(caKeyPath)?.data as Record<string, string>;
    const expiring = leafCertificate(
      'x',
      ['x'],
      [],
      10,
      decode(first, 'ca.crt'),
      decode(keys, 'ca.key'),
    );
    api.objects.get(tlsPath)!.data = {
      ...first,
      'tls.crt': encode(expiring.cert),
      'tls.key': encode(expiring.key),
    };
    await controller.reconcileTenant(t, []);
    const renewed = api.objects.get(tlsPath)?.data as Record<string, string>;
    expect(renewed['tls.crt']).not.toBe(encode(expiring.cert));
    expect(renewed['ca.crt']).toBe(first['ca.crt']);
    expect(
      issuedBy(decode(renewed, 'ca.crt'), decode(renewed, 'tls.crt'), decode(renewed, 'tls.key')),
    ).toBe(true);
  });

  it('restores a tampered ca.crt in tenant-controller-tls from the stored CA', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const first = api.objects.get(tlsPath)?.data as Record<string, string>;
    const stranger = caCertificate('other CA', 3650);
    api.objects.get(tlsPath)!.data = { ...first, 'ca.crt': encode(stranger.cert) };
    await controller.reconcileTenant(t, []);
    const repaired = api.objects.get(tlsPath)?.data as Record<string, string>;
    // The CA comes from the platform-namespace Secret, so the leaf and CA are kept (#170 S2).
    expect(repaired).toEqual(first);
    expect(
      issuedBy(
        decode(repaired, 'ca.crt'),
        decode(repaired, 'tls.crt'),
        decode(repaired, 'tls.key'),
      ),
    ).toBe(true);
    expect(api.objects.get(caMapPath)?.data).toEqual({ 'ca.crt': decode(repaired, 'ca.crt') });
  });

  it('reissues when the stored CA key is missing or is not the CA key', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const first = api.objects.get(tlsPath)?.data as Record<string, string>;
    api.objects.delete(caKeyPath);
    await controller.reconcileTenant(t, []);
    const second = api.objects.get(tlsPath)?.data as Record<string, string>;
    expect(second['ca.crt']).not.toBe(first['ca.crt']);
    must(api, caKeyPath).data = {
      ...(must(api, caKeyPath).data as Record<string, string>),
      'ca.key': encode(caCertificate('o', 30).key),
    };
    await controller.reconcileTenant(t, []);
    const third = api.objects.get(tlsPath)?.data as Record<string, string>;
    expect(third['ca.crt']).not.toBe(second['ca.crt']);
  });

  it('migrates main’s single CA:TRUE certificate once, then stays stable', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const current = api.objects.get(tlsPath)?.data as Record<string, string>;
    const names = certificateNames(decode(current, 'tls.crt'))!;
    const old = selfSignedCertificate(
      'tenant-controller.di-runtime-alpha.svc',
      names.dns,
      names.ips,
      365,
    );
    api.objects.get(tlsPath)!.data = { 'tls.crt': encode(old.cert), 'tls.key': encode(old.key) };
    api.objects.delete(caKeyPath);
    api.objects.get(caMapPath)!.data = { 'ca.crt': old.cert };
    await controller.reconcileTenant(t, []);
    const migrated = api.objects.get(tlsPath)?.data as Record<string, string>;
    expect(migrated['tls.crt']).not.toBe(encode(old.cert));
    expect(new X509Certificate(decode(migrated, 'tls.crt')).ca).toBe(false);
    expect(api.objects.get(caMapPath)?.data).toEqual({ 'ca.crt': decode(migrated, 'ca.crt') });
    const ca = api.objects.get(caMapPath)?.data;
    const keys = api.objects.get(caKeyPath)?.data;
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(tlsPath)?.data).toEqual(migrated);
    expect(api.objects.get(caMapPath)?.data).toEqual(ca);
    expect(api.objects.get(caKeyPath)?.data).toEqual(keys);
  });

  it('keeps the CA when tenant-controller-tls is deleted (#170 S2)', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const first = api.objects.get(tlsPath)?.data as Record<string, string>;
    const bundle = api.objects.get(caMapPath)?.data;
    const keys = api.objects.get(caKeyPath)?.data;
    api.objects.delete(tlsPath);
    await controller.reconcileTenant(t, []);
    const second = api.objects.get(tlsPath)?.data as Record<string, string>;
    // Only the leaf is new: the hosts' bundle and the console's kubeconfigs stay valid.
    expect(second['tls.crt']).not.toBe(first['tls.crt']);
    expect(second['ca.crt']).toBe(first['ca.crt']);
    expect(api.objects.get(caMapPath)?.data).toEqual(bundle);
    expect(api.objects.get(caKeyPath)?.data).toEqual(keys);
    expect(
      issuedBy(decode(first, 'ca.crt'), decode(second, 'tls.crt'), decode(second, 'tls.key')),
    ).toBe(true);
  });

  it('moves the CA key out of the runtime namespace without replacing the CA (#170 S3)', async () => {
    const { api, controller, t, before, bundle, keys } = await legacyLayout();
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(caKeyPath)?.data).toEqual(keys);
    expect(api.objects.get(tlsPath)?.data).toEqual(before);
    expect(api.objects.get(caMapPath)?.data).toEqual(bundle);
    expect(api.objects.get(legacyCaKeyPath)).toBeUndefined();
    // The tenant controller's Role covers only its runtime namespace; the key is not there.
    for (const value of api.objects.values())
      if (value.metadata.namespace === 'di-runtime-alpha')
        expect(JSON.stringify(value)).not.toContain(field(keys, 'ca.key'));
  });

  it('neither adopts nor deletes a runtime-namespace CA key it did not write', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const caPem = decode(api.objects.get(tlsPath)?.data as Record<string, string>, 'ca.crt');
    const keys = api.objects.get(caKeyPath)?.data as Record<string, string>;
    api.objects.delete(caKeyPath);
    seedLegacyCaKey(api, { [COMPONENT]: 'tenant-auth', [TENANT]: 'alpha' }, field(keys, 'ca.key'));
    await controller.reconcileTenant(t, []);
    const replaced = api.objects.get(caKeyPath)?.data as Record<string, string>;
    expect(decode(replaced, 'ca.crt')).not.toBe(caPem);
    expect(api.objects.get(legacyCaKeyPath)?.data).toEqual({ 'ca.key': field(keys, 'ca.key') });
  });

  it('refuses a CA Secret it did not write before publishing anything from it, and logs it once', async () => {
    const { api, controller, t } = prepare();
    const stranger = caCertificate('someone else', 3650);
    const seeded = {
      'ca.crt': encode(stranger.cert),
      'ca.key': encode(stranger.key),
    };
    api.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'tenant-controller-ca-alpha', namespace: 'wasmcloud' },
      type: 'Opaque',
      data: seeded,
    } as Resource);
    const logged: string[] = [];
    const log = console.error;
    console.error = (message: string) => logged.push(message);
    try {
      for (let pass = 0; pass < 3; pass++) await controller.reconcileTenant(t, []);
    } finally {
      console.error = log;
    }
    const conditions = Object.fromEntries((t.status?.conditions ?? []).map((c) => [c.type, c]));
    expect(conditions.Ready?.status).toBe('True');
    expect(conditions.TenantAuthReady).toMatchObject({
      status: 'False',
      reason: 'ControllerCaNotOwned',
    });
    expect(conditions.TenantAuthReady?.message).toContain(
      'Refusing to adopt Secret wasmcloud/tenant-controller-ca-alpha',
    );
    expect(logged.filter((m) => m.includes('tenant-controller-ca-alpha'))).toHaveLength(1);
    // Nothing was rendered from it: no bundle, no leaf, and the Secret is left as it was.
    expect(api.objects.get(caMapPath)).toBeUndefined();
    expect(api.objects.get(tlsPath)).toBeUndefined();
    expect(api.objects.get(caKeyPath)?.data).toEqual(seeded);
    // Once it is deleted, the controller writes its own.
    api.objects.delete(caKeyPath);
    await controller.reconcileTenant(t, []);
    const keys = must(api, caKeyPath);
    expect(keys.metadata.labels).toMatchObject({ [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' });
    expect(decode(keys.data as Record<string, string>, 'ca.crt')).not.toBe(stranger.cert);
  });

  it('refuses a CA Secret left by an earlier Tenant of the same name, keeping the bundle', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const bundle = api.objects.get(caMapPath)?.data;
    const tls = api.objects.get(tlsPath)?.data;
    const stranger = caCertificate('earlier tenant', 3650);
    const secret = must(api, caKeyPath);
    secret.metadata.labels = { ...secret.metadata.labels, [OWNER]: 'earlier-uid' };
    secret.data = { 'ca.crt': encode(stranger.cert), 'ca.key': encode(stranger.key) };
    await quietly(() => controller.reconcileTenant(t, []));
    expect(t.status?.conditions?.find((c) => c.type === 'TenantAuthReady')?.reason).toBe(
      'ControllerCaNotOwned',
    );
    expect(api.objects.get(caMapPath)?.data).toEqual(bundle);
    expect(api.objects.get(tlsPath)?.data).toEqual(tls);
  });

  it('adopts the CA an older package issued after a downgrade instead of the stale one (#170)', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    const stale = decode(api.objects.get(caKeyPath)?.data as Record<string, string>, 'ca.crt');
    const tls = must(api, tlsPath);
    // What a package from before #170 does once downgraded: it finds no runtime-namespace key,
    // replaces the CA and keeps its key in tenant-controller-ca-key. The platform Secret stays.
    const ns = 'di-runtime-alpha';
    const older = caCertificate(`tenant-controller CA (${ns})`, 3650);
    const names = tenantControllerCertNames('alpha', auth);
    const leaf = leafCertificate(
      `tenant-controller.${ns}.svc`,
      names.dns,
      names.ips,
      365,
      older.cert,
      older.key,
    );
    tls.data = {
      'tls.crt': encode(leaf.cert),
      'tls.key': encode(leaf.key),
      'ca.crt': encode(older.cert),
    };
    must(api, caMapPath).data = { 'ca.crt': older.cert };
    seedLegacyCaKey(api, { ...tls.metadata.labels }, encode(older.key));
    const before = structuredClone(tls.data);
    // Upgrading again keeps what every host, console and kubeconfig trusts now and the leaf it
    // signed. That CA has no name constraints, so a constrained successor is published beside it
    // (#365) and switched to after the overlap.
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(tlsPath)?.data).toEqual(before);
    const keys = api.objects.get(caKeyPath)?.data as Record<string, string>;
    expect(Object.keys(keys).sort()).toEqual(['ca.crt', 'ca.key', 'next.crt', 'next.key']);
    const successor = decode(keys, 'next.crt');
    expect(caPermittedDns(successor)).toEqual(names.dns);
    expect(api.objects.get(caMapPath)?.data).toEqual({ 'ca.crt': older.cert + successor });
    expect(decode(keys, 'ca.crt')).toBe(older.cert);
    expect(decode(keys, 'ca.crt')).not.toBe(stale);
    expect(holdsCaKey(older.cert, decode(keys, 'ca.key'))).toBe(true);
    expect(api.objects.get(legacyCaKeyPath)).toBeUndefined();
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(tlsPath)?.data).toEqual(before);
    expect(api.objects.get(caKeyPath)?.data).toEqual(keys);
  });

  it('keeps the legacy CA key until the platform Secret holding it is applied', async () => {
    const { api, controller, t, bundle, keys } = await legacyLayout();
    api.fail = (method, p) =>
      method === 'PATCH' && p === caKeyPath ? new ApiError(500, 'boom') : undefined;
    await quietly(() => controller.reconcileTenant(t, []));
    api.fail = undefined;
    expect(api.objects.get(legacyCaKeyPath)?.data).toEqual({ 'ca.key': field(keys, 'ca.key') });
    expect(api.objects.get(caMapPath)?.data).toEqual(bundle);
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(caKeyPath)?.data).toEqual(keys);
    expect(api.objects.get(legacyCaKeyPath)).toBeUndefined();
  });

  it('removes the platform-namespace CA Secret when tenantAuth is unset', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(caKeyPath)).toBeDefined();
    await new Controller(api, { ...cfg, tenantAuth: undefined }).reconcileTenant(t, []);
    expect(api.objects.get(caKeyPath)).toBeUndefined();
  });

  it('removes the platform-namespace CA Secret with the tenant', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(caKeyPath)).toBeDefined();
    t.metadata.deletionTimestamp = '2026-10-14T00:00:00Z';
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(caKeyPath)).toBeUndefined();
  });

  /** A controller on a fake clock, `days` after 2026-10-14, and the bundle it publishes. */
  const clocked = () => {
    const { api, t } = prepare();
    const t0 = new Date('2026-10-14T00:00:00Z').getTime();
    let clock = new Date(t0);
    const controller = new Controller(api, cfg, undefined, () => clock);
    const pass = async (days: number) => {
      clock = new Date(t0 + days * 86_400_000);
      await controller.reconcileTenant(t, []);
      return field(must(api, caMapPath).data as Record<string, string>, 'ca.crt');
    };
    return { api, pass };
  };

  it('keeps a CA whose key was lost for at most the overlap, also via tenant-controller-tls', async () => {
    const { api, pass } = clocked();
    const a = await pass(0);
    // The key goes missing 100 days in; A would be valid for years more.
    const keys = must(api, caKeyPath);
    keys.data = { 'ca.crt': field(keys.data as Record<string, string>, 'ca.crt') };
    const replaced = await pass(100);
    const c = decode(must(api, caKeyPath).data as Record<string, string>, 'ca.crt');
    expect(c).not.toBe(a);
    // The leaf A signed keeps verifying while the controller rolls.
    expect(replaced).toBe(a + c);
    expect(await pass(100 + CA_OVERLAP_DAYS - 1)).toBe(a + c);
    expect(await pass(100 + CA_OVERLAP_DAYS + 1)).toBe(c);
    // Deleting the platform Secret falls back to `ca.crt` in tenant-controller-tls, which is C by
    // now: A never comes back, and C (keyless there) is again kept for the overlap only.
    api.objects.delete(caKeyPath);
    const again = await pass(200);
    expect(again).not.toContain(a);
    expect(again.startsWith(c)).toBe(true);
    expect(await pass(200 + CA_OVERLAP_DAYS + 1)).not.toContain(c);
  });

  it('revokes a compromised CA at once when both of its Secrets are deleted', async () => {
    const { api, pass } = clocked();
    const a = await pass(0);
    const oldLeaf = decode(must(api, tlsPath).data as Record<string, string>, 'tls.crt');
    api.objects.delete(caKeyPath);
    api.objects.delete(tlsPath);
    const revoked = await pass(100);
    // No overlap: only the new CA is trusted, and the old leaf no longer verifies anywhere.
    expect(revoked).not.toContain(a);
    expect(revoked.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
    const keys = must(api, caKeyPath).data as Record<string, string>;
    expect(Object.keys(keys).sort()).toEqual(['ca.crt', 'ca.key']);
    expect(decode(keys, 'ca.crt')).toBe(revoked);
    const tls = must(api, tlsPath).data as Record<string, string>;
    expect(issuedBy(revoked, decode(tls, 'tls.crt'), decode(tls, 'tls.key'))).toBe(true);
    expect(verifies(oldLeaf, revoked, new Date('2027-01-22T00:00:00Z'))).toBe(false);
  });

  it('revokes on a repeated delete when a pass ran between the two deletes (README check)', async () => {
    const { api, pass } = clocked();
    const a = await pass(0);
    api.objects.delete(caKeyPath);
    // A pass in between treats it as a lost key and keeps A for the overlap ...
    expect(await pass(1)).toContain(a);
    api.objects.delete(tlsPath);
    const between = await pass(1);
    expect(between.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(between).toContain(a);
    // ... so the documented check sees two certificates, and deleting both again revokes A.
    api.objects.delete(caKeyPath);
    api.objects.delete(tlsPath);
    const revoked = await pass(1);
    expect(revoked.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
    expect(revoked).not.toContain(a);
  });

  /**
   * The tenant controller run on one clock, one controller per config, and what each pass leaves
   * behind for the CA rotation tests (#170, #365).
   */
  const rotationHarness = () => {
    const { api, t } = prepare();
    const t0 = new Date('2026-10-14T00:00:00Z').getTime();
    let clock = new Date(t0);
    const controllers = new Map<ControllerConfig, Controller>();
    const snapshot = () => {
      const tls = api.objects.get(tlsPath)?.data as Record<string, string>;
      const consoleDeployment = api.objects.get(
        path('Deployment', 'di-runtime-alpha', 'tenant-console'),
      ) as Deployment;
      return {
        leaf: decode(tls, 'tls.crt'),
        leafKey: decode(tls, 'tls.key'),
        bundle: String(
          (api.objects.get(caMapPath)?.data as Record<string, string> | undefined)?.['ca.crt'],
        ),
        consoleBundle: consoleDeployment.spec.template.metadata.annotations[CA_BUNDLE_ANNOTATION],
        keys: api.objects.get(caKeyPath)?.data as Record<string, string>,
      };
    };
    type State = ReturnType<typeof snapshot>;
    /** One reconcile pass `days` after t0 under `config`. */
    const pass = async (days: number, config = cfg): Promise<State> => {
      clock = new Date(t0 + days * 86_400_000);
      const controller =
        controllers.get(config) ?? new Controller(api, config, undefined, () => clock);
      controllers.set(config, controller);
      await controller.reconcileTenant(t, []);
      const state = snapshot();
      // The console reloads (and copies into the kubeconfigs it issues) what the hosts trust.
      expect(state.consoleBundle).toBe(tlsCertDigest(state.bundle));
      return state;
    };
    /**
     * A rollout is never atomic: until it finishes, an old or new controller pod (leaf) meets an
     * old or new host or kubeconfig (bundle). Every pairing must pass the X.509 path check then.
     */
    const overlaps = (from: State, to: State) => {
      for (const leaf of [from.leaf, to.leaf])
        for (const bundle of [from.bundle, to.bundle])
          expect(verifies(leaf, bundle, clock)).toBe(true);
    };
    return { api, pass, overlaps, at: () => clock };
  };
  const caCount = (bundle: string) => bundle.match(/BEGIN CERTIFICATE/g)?.length;

  it('rotates the CA near expiry so every party verifies throughout (#170 S4, S8)', async () => {
    const { pass, overlaps, at } = rotationHarness();
    const a = decode((await pass(0)).keys, 'ca.crt');
    // A yearly leaf renewal shortly before the rotation window keeps CA A.
    const steady = await pass(CA_DAYS - CA_RENEW_DAYS - 10);
    expect(steady.bundle).toBe(a);
    expect(steady.keys['next.crt']).toBeUndefined();

    // 1. Publish: B joins the bundle (the hosts roll on its digest); the leaf stays A's.
    const published = await pass(CA_DAYS - CA_RENEW_DAYS + 1);
    expect(published.leaf).toBe(steady.leaf);
    expect(caCount(published.bundle)).toBe(2);
    expect(published.bundle.startsWith(a)).toBe(true);
    expect(decode(published.keys, 'ca.crt')).toBe(a);
    const b = decode(published.keys, 'next.crt');
    expect(holdsCaKey(b, decode(published.keys, 'next.key'))).toBe(true);
    overlaps(steady, published);
    // Nothing changes while the overlap lasts.
    const waiting = await pass(CA_DAYS - CA_RENEW_DAYS + CA_OVERLAP_DAYS);
    expect(waiting).toEqual(published);

    // 2. Switch: B signs a new leaf; the bundle bytes are unchanged, so the hosts do not roll.
    const switched = await pass(CA_DAYS - CA_RENEW_DAYS + CA_OVERLAP_DAYS + 2);
    expect(switched.bundle).toBe(published.bundle);
    expect(switched.leaf).not.toBe(published.leaf);
    expect(decode(switched.keys, 'ca.crt')).toBe(b);
    expect(decode(switched.keys, 'previous.crt')).toBe(a);
    expect(switched.keys['next.crt']).toBeUndefined();
    expect(Object.keys(switched.keys).sort()).toEqual(['ca.crt', 'ca.key', 'previous.crt']);
    expect(issuedBy(b, switched.leaf, switched.leafKey)).toBe(true);
    overlaps(published, switched);

    // 3. Retire: A leaves the bundle once it has expired; no leaf it signed outlives it.
    const kept = await pass(CA_DAYS - 1);
    expect(kept).toEqual(switched);
    const retired = await pass(CA_DAYS + 1);
    expect(retired.leaf).toBe(switched.leaf);
    expect(retired.bundle).toBe(b);
    expect(retired.keys['previous.crt']).toBeUndefined();
    overlaps(switched, retired);
    expect(verifies(published.leaf, retired.bundle, at())).toBe(false);
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

  it('refuses to adopt resources left by a manual deploy', async () => {
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

  it('refuses to adopt a tenant-controller-tls Secret left by a manual deploy through the cached read', async () => {
    const { api, controller, t } = prepare();
    const ns = 'di-runtime-alpha';
    const ca = caCertificate(`tenant-controller CA (${ns})`, 3650);
    const leaf = leafCertificate(
      `tenant-controller.${ns}.svc`,
      ['tenant-controller', `tenant-controller.${ns}.svc`, 'localhost'],
      ['127.0.0.1'],
      365,
      ca.cert,
      ca.key,
    );
    const foreign = {
      'tls.crt': encode(leaf.cert),
      'tls.key': encode(leaf.key),
      'ca.crt': encode(ca.cert),
    };
    // The labels and keys the removed manual deploy script wrote; no installation label.
    api.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'tenant-controller-tls',
        namespace: ns,
        labels: { [COMPONENT]: 'tenant-auth', [TENANT]: 'alpha' },
      },
      type: 'kubernetes.io/tls',
      data: foreign,
    } as Resource);
    let gets = 0;
    api.fail = (method, p) => {
      if (method === 'GET' && p === tlsPath) gets++;
      return undefined;
    };
    const log = console.error;
    console.error = () => {};
    try {
      await controller.reconcileTenant(t, []);
    } finally {
      console.error = log;
    }
    const conditions = Object.fromEntries((t.status?.conditions ?? []).map((c) => [c.type, c]));
    expect(conditions.TenantAuthReady).toMatchObject({ status: 'False', reason: 'ReconcileError' });
    expect(conditions.TenantAuthReady?.message).toContain(
      `Refusing to adopt Secret ${ns}/tenant-controller-tls`,
    );
    // ensure() took the Secret from the pass's cache, not a second GET, and still refused it.
    expect(gets).toBe(1);
    const kept = api.objects.get(tlsPath);
    expect(kept?.data).toEqual(foreign);
    expect(kept?.metadata.labels?.[INSTALLATION]).toBeUndefined();
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

  it('rotates the CA through the overlap when the public controller host changes (#365)', async () => {
    const { api, pass, overlaps } = rotationHarness();
    const oldAuth = { ...auth, controllerPublicUrl: 'https://old.{tenant}.example.com' };
    const old: ControllerConfig = { ...cfg, tenantAuth: oldAuth };
    const moved: ControllerConfig = {
      ...cfg,
      tenantAuth: { ...auth, controllerPublicUrl: 'https://controller.{tenant}.example.com' },
    };
    const host = 'DNS:controller.alpha.example.com';
    const oldHost = 'DNS:old.alpha.example.com';
    const sans = (leaf: string) => new X509Certificate(leaf).subjectAltName;
    const before = await pass(0, old);
    const a = decode(before.keys, 'ca.crt');
    expect(caPermittedDns(a)).toEqual(tenantControllerCertNames('alpha', oldAuth).dns);
    expect(sans(before.leaf)).toContain(oldHost);
    // Publish: B permits the new host and A does not, so A's leaf, for the old host, is served
    // until the switch: kubeconfigs that name the old host keep working, none goes dark.
    const published = await pass(100, moved);
    expect(published.leaf).toBe(before.leaf);
    expect(sans(published.leaf)).toContain(oldHost);
    expect(sans(published.leaf)).not.toContain(host);
    const b = decode(published.keys, 'next.crt');
    expect(published.bundle).toBe(a + b);
    expect(caPermittedDns(b)).toContain('controller.alpha.example.com');
    overlaps(before, published);
    expect(await pass(100 + CA_OVERLAP_DAYS - 1, moved)).toEqual(published);
    // B signs a leaf naming the new host; the bundle bytes stay and A is kept.
    const switched = await pass(100 + CA_OVERLAP_DAYS + 1, moved);
    expect(switched.bundle).toBe(published.bundle);
    expect(issuedBy(b, switched.leaf, switched.leafKey)).toBe(true);
    // Switch: the new host is served from here on and the old one is dropped.
    expect(sans(switched.leaf)).toContain(host);
    expect(sans(switched.leaf)).not.toContain(oldHost);
    expect(withinNameConstraints(switched.leaf, a)).toBe(false);
    const consoleDeployment = must(api, path('Deployment', 'di-runtime-alpha', 'tenant-console'));
    expect(
      (consoleDeployment as Deployment).spec.template.metadata.annotations[
        'platform.di-framework.dev/tls-cert-sha256'
      ],
    ).toBe(tlsCertDigest(switched.leaf));
    overlaps(published, switched);
    // Retire: A leaves the bundle once B is twice the overlap old.
    expect(await pass(100 + 2 * CA_OVERLAP_DAYS - 1, moved)).toEqual(switched);
    const retired = await pass(100 + 2 * CA_OVERLAP_DAYS + 1, moved);
    expect(retired.bundle).toBe(b);
    expect(retired.leaf).toBe(switched.leaf);
    overlaps(switched, retired);
  });

  it('publishes a successor instead of replacing the CA when routeUrlPattern is set (#365)', async () => {
    const { pass, overlaps } = rotationHarness();
    const routed: ControllerConfig = {
      ...cfg,
      routeUrlPattern: 'http://{host}.{tenant}.localhost:28180',
      tenantAuth: withDerivedPublicUrls(auth, 'http://{host}.{tenant}.localhost:28180'),
    };
    const before = await pass(0);
    const a = decode(before.keys, 'ca.crt');
    const published = await pass(1, routed);
    expect(decode(published.keys, 'ca.crt')).toBe(a);
    expect(caPermittedDns(decode(published.keys, 'next.crt'))).toContain(
      'controller.alpha.localhost',
    );
    // The derived host lies below A's permitted `localhost`, so A serves it during the overlap.
    expect(new X509Certificate(published.leaf).subjectAltName).toContain(
      'DNS:controller.alpha.localhost',
    );
    expect(issuedBy(a, published.leaf, published.leafKey)).toBe(true);
    overlaps(before, published);
    const switched = await pass(2 + CA_OVERLAP_DAYS, routed);
    expect(issuedBy(decode(published.keys, 'next.crt'), switched.leaf, switched.leafKey)).toBe(
      true,
    );
    overlaps(published, switched);
  });

  it('drops 127.0.0.1 and rolls to a CA excluding IP addresses through the overlap (#381)', async () => {
    const { pass, overlaps } = rotationHarness();
    // Before #381 the leaf always named 127.0.0.1, so its CA left IP addresses unconstrained, as
    // it still does for an explicit IP-literal public URL.
    const ipUrl: ControllerConfig = {
      ...cfg,
      tenantAuth: { ...auth, controllerPublicUrl: 'https://127.0.0.1:8788' },
    };
    const sans = (leaf: string) => new X509Certificate(leaf).subjectAltName ?? '';
    const before = await pass(0, ipUrl);
    const a = decode(before.keys, 'ca.crt');
    expect(caConstraints(a)?.excludesIps).toBe(false);
    expect(sans(before.leaf)).toContain('IP Address:127.0.0.1');
    // Publish: B excludes every IP address; A's leaf, with 127.0.0.1, is served until the switch.
    const published = await pass(100);
    expect(published.leaf).toBe(before.leaf);
    const b = decode(published.keys, 'next.crt');
    expect(caConstraints(b)).toEqual({
      dns: tenantControllerCertNames('alpha', auth).dns,
      excludesIps: true,
    });
    expect(published.bundle).toBe(a + b);
    overlaps(before, published);
    // Switch: B signs a leaf that names no IP address; the bundle bytes stay.
    const switched = await pass(100 + CA_OVERLAP_DAYS + 1);
    expect(issuedBy(b, switched.leaf, switched.leafKey)).toBe(true);
    expect(sans(switched.leaf)).not.toContain('IP Address');
    expect(switched.bundle).toBe(published.bundle);
    overlaps(published, switched);
    const retired = await pass(100 + 2 * CA_OVERLAP_DAYS + 1);
    expect(retired.bundle).toBe(b);
    overlaps(switched, retired);
    // A leaf naming an IP address fails against B, independently of this repository's checks.
    const ipLeaf = leafCertificate(
      'x',
      ['localhost'],
      ['127.0.0.1'],
      30,
      b,
      decode(retired.keys, 'ca.key'),
      new Date('2027-03-01T00:00:00Z'),
    );
    expect(opensslVerifies(ipLeaf.cert, b, new Date('2027-03-02T00:00:00Z'))).toBe(false);
  });

  for (const [label, tenantAuth] of [
    [
      'an explicit IP-literal controller URL',
      { ...auth, controllerPublicUrl: 'https://10.1.2.3:8788' },
    ],
    [
      'an explicit IP-literal registry URL and no controller URL',
      {
        ...auth,
        registry: {
          component: `ghcr.io/di-framework/oci-registry@sha256:${'b'.repeat(64)}`,
          publicUrl: 'https://10.1.2.3:8790',
        },
      },
    ],
    [
      'an explicit IPv6-literal controller URL',
      { ...auth, controllerPublicUrl: 'https://[fd00::1]:8788' },
    ],
  ] as [string, TenantAuthConfig][])
    it(`keeps 127.0.0.1 and an IP-permitting CA, with no rotation, for ${label} (#381)`, async () => {
      const { pass } = rotationHarness();
      const ipUrl: ControllerConfig = { ...cfg, tenantAuth };
      const sans = (leaf: string) => new X509Certificate(leaf).subjectAltName ?? '';
      const before = await pass(0, ipUrl);
      expect(caConstraints(decode(before.keys, 'ca.crt'))?.excludesIps).toBe(false);
      // As before #381: CLIs logged in to https://127.0.0.1:8788 keep verifying.
      expect(sans(before.leaf)).toContain('IP Address:127.0.0.1');
      for (const day of [100, 100 + CA_OVERLAP_DAYS + 1, 100 + 2 * CA_OVERLAP_DAYS + 1]) {
        const later = await pass(day, ipUrl);
        expect(later.keys['next.crt']).toBeUndefined();
        expect(later.leaf).toBe(before.leaf);
        expect(later.bundle).toBe(before.bundle);
      }
    });

  for (const [label, tenantAuth] of [
    [
      'an explicit 127.0.0.1 controller URL',
      { ...auth, controllerPublicUrl: 'https://127.0.0.1:8788' },
    ],
    ['an explicit IPv4 controller URL', { ...auth, controllerPublicUrl: 'https://10.1.2.3:8788' }],
    [
      'an explicit IPv4 registry URL and no controller URL',
      {
        ...auth,
        registry: {
          component: `ghcr.io/di-framework/oci-registry@sha256:${'b'.repeat(64)}`,
          publicUrl: 'https://10.1.2.3:8790',
        },
      },
    ],
  ] as [string, TenantAuthConfig][])
    it(`upgrades main's CA and leaf with no rotation or reissue for ${label} (#381 C1)`, async () => {
      const { api, pass } = rotationHarness();
      const ipUrl: ControllerConfig = { ...cfg, tenantAuth };
      await pass(0, ipUrl);
      // Seed what main issues today: a #365 CA (DNS-constrained, IP addresses unconstrained)
      // issued 100 days ago, serving a leaf that names 127.0.0.1 first plus any IPv4 literal.
      const wanted = tenantControllerCertNames('alpha', tenantAuth);
      const issued = new Date(new Date('2026-10-14T00:00:00Z').getTime() - 100 * 86_400_000);
      const ca = caCertificate('tenant-controller CA', CA_DAYS, issued, wanted.dns);
      const mainIps = [...new Set(['127.0.0.1', ...wanted.ips])];
      const leaf = leafCertificate('x', wanted.dns, mainIps, 365, ca.cert, ca.key, issued);
      api.objects.get(caKeyPath)!.data = { 'ca.crt': encode(ca.cert), 'ca.key': encode(ca.key) };
      api.objects.get(tlsPath)!.data = {
        'tls.crt': encode(leaf.cert),
        'tls.key': encode(leaf.key),
        'ca.crt': encode(ca.cert),
      };
      for (const day of [1, 100, 100 + CA_OVERLAP_DAYS + 1, 100 + 2 * CA_OVERLAP_DAYS + 1]) {
        const later = await pass(day, ipUrl);
        expect(later.keys['next.crt']).toBeUndefined();
        expect(later.keys['previous.crt']).toBeUndefined();
        expect(decode(later.keys, 'ca.crt')).toBe(ca.cert);
        expect(later.leaf).toBe(leaf.cert);
        expect(later.bundle).toBe(ca.cert);
        expect(certificateNames(later.leaf)?.ips).toContain('127.0.0.1');
      }
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

  it('derives unset public URLs from routeUrlPattern so they are routed (#128)', () => {
    const { consolePublicUrl: _c, ...bare } = auth;
    const registry = { component: `ghcr.io/di-framework/oci-registry@sha256:${'b'.repeat(64)}` };
    const derived = withDerivedPublicUrls({ ...bare, registry }, pattern);
    expect(derived).toEqual({
      ...bare,
      consolePublicUrl: 'http://console.{tenant}.localhost:28180',
      controllerPublicUrl: 'https://controller.{tenant}.localhost:28180',
      registry: { ...registry, publicUrl: 'https://registry.{tenant}.localhost:28180' },
    });
    expect(tenantAuthRoutes(derived, pattern)).toEqual({
      routes: { console: 'console', controller: 'controller', registry: 'registry' },
      urls: {
        console: 'http://console.{tenant}.localhost:28180',
        controller: 'https://controller.{tenant}.localhost:28180',
        registry: 'https://registry.{tenant}.localhost:28180',
      },
      problems: [],
    });
    // Without a registry none is invented; without a port the TLS hosts name the gateway's 80.
    const portless = withDerivedPublicUrls(bare, 'http://{host}.{tenant}.localhost');
    expect(portless).toEqual({
      ...bare,
      consolePublicUrl: 'http://console.{tenant}.localhost',
      controllerPublicUrl: 'https://controller.{tenant}.localhost:80',
    });
    expect(tenantAuthRoutes(portless, 'http://{host}.{tenant}.localhost').problems).toEqual([]);
    // No gateway or no tenantAuth: nothing derived, the 127.0.0.1 defaults still apply.
    expect(withDerivedPublicUrls(bare, undefined)).toBe(bare);
    expect(withDerivedPublicUrls(undefined, pattern)).toBeUndefined();
  });

  it('keeps explicit public URLs over the derived defaults (#128)', () => {
    const explicit: TenantAuthConfig = {
      ...auth,
      consolePublicUrl: 'http://ui.{tenant}.localhost:28180',
      controllerPublicUrl: 'https://127.0.0.1:8788',
      registry: {
        component: `ghcr.io/di-framework/oci-registry@sha256:${'b'.repeat(64)}`,
        publicUrl: 'https://oci.{tenant}.localhost:28180',
      },
    };
    expect(withDerivedPublicUrls(explicit, pattern)).toBe(explicit);
    // Only the unset one is derived.
    const { controllerPublicUrl: _k, ...partial } = explicit;
    expect(withDerivedPublicUrls(partial, pattern)).toEqual({
      ...explicit,
      controllerPublicUrl: 'https://controller.{tenant}.localhost:28180',
    });
  });

  it('keeps the 127.0.0.1 defaults for a routeUrlPattern the gateway does not route (#128)', () => {
    const { consolePublicUrl: _c, ...bare } = auth;
    for (const unrouted of [
      'https://{host}.{tenant}.localhost:28180',
      'http://{host}.{tenant}.example.com:28180',
    ]) {
      expect(withDerivedPublicUrls(bare, unrouted)).toBe(bare);
      expect(tenantAuthRoutes(bare, unrouted)).toEqual({ routes: {}, urls: {}, problems: [] });
    }
    expect(unsetPublicUrls(bare)).toEqual(['consolePublicUrl', 'controllerPublicUrl']);
  });

  it('derives the gateway port from an explicit :80 pattern (#128)', () => {
    const { consolePublicUrl: _c, ...bare } = auth;
    const pattern80 = 'http://{host}.{tenant}.localhost:80';
    const derived = withDerivedPublicUrls(bare, pattern80);
    expect(derived).toEqual({
      ...bare,
      consolePublicUrl: 'http://console.{tenant}.localhost',
      controllerPublicUrl: 'https://controller.{tenant}.localhost:80',
    });
    expect(tenantAuthRoutes(derived, pattern80)).toMatchObject({
      routes: { console: 'console', controller: 'controller' },
      problems: [],
    });
  });

  it('renders the derived URLs into the console and controller settings (#128)', () => {
    const { consolePublicUrl: _c, ...bare } = auth;
    const registry = { component: `ghcr.io/di-framework/oci-registry@sha256:${'b'.repeat(64)}` };
    const derivedCfg: ControllerConfig = {
      ...cfg,
      routeUrlPattern: pattern,
      tenantAuth: withDerivedPublicUrls({ ...bare, registry }, pattern),
    };
    const resources = tenantAuthResources(tenant(), derivedCfg, {
      ...inputs,
      registryServing: true,
    });
    expect(env(find(resources, 'Deployment', 'tenant-console') as Deployment)).toMatchObject({
      TENANT_CONSOLE_PUBLIC_URL: 'http://console.alpha.localhost:28180',
      TENANT_CONSOLE_CONTROLLER_PUBLIC_URL: 'https://controller.alpha.localhost:28180',
    });
    expect(env(find(resources, 'Deployment', 'tenant-controller') as Deployment)).toMatchObject({
      TENANT_CONTROLLER_REGISTRY_URL: 'https://registry.alpha.localhost:28180',
    });
    expect(tenantControllerCertNames('alpha', derivedCfg.tenantAuth).dns).toEqual(
      expect.arrayContaining(['controller.alpha.localhost', 'registry.alpha.localhost']),
    );
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
    ).toBe('https://localhost:8790');
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
        config: {
          backend: 'nats',
          url: 'nats://di-nats.di-runtime-alpha.svc.cluster.local:4222',
        },
      },
      {
        namespace: 'wasmcloud',
        package: 'secrets',
        interfaces: ['store', 'reveal'],
        config: {
          'tenant-controller-url': 'https://tenant-controller.di-runtime-alpha.svc:8789',
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
    const plainEnv = env(find(plain, 'Deployment', 'tenant-controller') as Deployment);
    expect(plainEnv).not.toHaveProperty('TENANT_CONTROLLER_REGISTRY_URL');
    expect(plainEnv).not.toHaveProperty('TENANT_CONTROLLER_WHOAMI_PORT');
    expect(plainEnv).not.toHaveProperty('TENANT_CONTROLLER_WHOAMI_TLS_ONLY');
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

  it('names the host the registry calls for whoami exactly in the controller certificate (#113)', () => {
    const resources = tenantAuthResources(tenant(), registryCfg, {
      ...inputs,
      registryServing: true,
    });
    const workload = find(resources, 'WorkloadDeployment', REGISTRY_WORKLOAD) as Workload;
    const { components, hostInterfaces } = workload.spec.template.spec as {
      components: { localResources?: unknown }[];
      hostInterfaces: { package: string; config?: Record<string, string> }[];
    };
    const secrets = hostInterfaces.find((i) => i.package === 'secrets');
    const url = new URL(String(secrets?.config?.['tenant-controller-url']));
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('tenant-controller.di-runtime-alpha.svc');
    expect(url.hostname).toBe(registryWhoamiHost('alpha'));
    expect(url.port).toBe('8789');
    // The egress allowlist names the same host and port.
    expect(components[0]?.localResources).toEqual({
      allowedHosts: [url.host],
    });
    // The certificate the controller is issued carries that exact name: not only a wildcard or
    // the `.cluster.local` form, which the registry's TLS check would not match.
    const names = tenantControllerCertNames('alpha', withRegistry);
    const ca = caCertificate('tenant-controller CA (di-runtime-alpha)', 30);
    const leaf = leafCertificate(url.hostname, names.dns, names.ips, 30, ca.cert, ca.key);
    expect(certificateNames(leaf.cert)?.dns.filter((name) => name === url.hostname)).toEqual([
      url.hostname,
    ]);
    expect(new X509Certificate(leaf.cert).checkHost(url.hostname)).toBe(url.hostname);
    for (const name of ['beta', 'gamma'])
      expect(tenantControllerCertNames(name).dns).toContain(registryWhoamiHost(name));
  });

  it('the rendered controller serves whoami over TLS only, with no plain-HTTP relay or flag (#113)', async () => {
    const rendered = env(
      find(
        tenantAuthResources(tenant(), registryCfg, { ...inputs, registryServing: true }),
        'Deployment',
        'tenant-controller',
      ) as Deployment,
    );
    // The controller's own reading of the rendered env: only the bind address and port differ.
    const config = controllerConfigFromEnv({ ...rendered, TENANT_CONTROLLER_HOST: '127.0.0.1' });
    expect(config.whoamiPort).toBe(8789);
    // TLS is the only mode (#113 `:drop-relay`): no switch is rendered that could reopen plain HTTP.
    expect(rendered).not.toHaveProperty('TENANT_CONTROLLER_WHOAMI_TLS_ONLY');
    expect(config).not.toHaveProperty('whoamiTlsOnly');
    const name = registryWhoamiHost('alpha');
    const names = tenantControllerCertNames('alpha', withRegistry);
    const ca = caCertificate('tenant-controller CA (di-runtime-alpha)', 30);
    const leaf = leafCertificate(name, names.dns, names.ips, 30, ca.cert, ca.key);
    const listener = await serveWhoamiListener(
      { handleWhoami: async () => Response.json({ user: 'u' }) },
      config,
      0,
      { cert: leaf.cert, key: leaf.key },
    );
    const call = (secure: boolean) =>
      new Promise<number>((resolve, reject) => {
        const options = { host: '127.0.0.1', port: listener.port, path: '/v1/auth/whoami' };
        const done = (res: import('node:http').IncomingMessage) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        };
        // The registry's view: the tenant CA and the Service name it calls.
        const req = secure
          ? httpsRequest({ ...options, agent: false, ca: ca.cert, servername: name }, done)
          : httpRequest({ ...options, agent: false }, done);
        req.on('error', reject);
        req.end();
      });
    try {
      expect(await call(true)).toBe(200);
      // A plain-HTTP request is not relayed to the handler: the connection fails instead.
      await expect(call(false)).rejects.toThrow();
    } finally {
      await listener.stop();
    }
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
    routeUrlPattern: 'http://{host}.{tenant}.localhost:28180',
    tenantAuth: withRegistry,
  };
  // What createPlatform passes for a local install (`registry: true`, `insecureRegistry: true`).
  const PLATFORM_REGISTRY = platformRegistryPullHost('wasmcloud');
  const insecureCfg: ControllerConfig = {
    ...tlsCfg,
    insecureRegistries: [PLATFORM_REGISTRY],
  };
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
    // TLS on port 443 even with a plain-HTTP allowlist (tenant hosts always use TLS for it).
    const insecure = tenantAuthResources(tenant(), insecureCfg, {
      ...inputs,
      registryServing: true,
      hostPullToken: TOKEN,
    });
    // The allowlist only reaches the tenant hosts' args; tenant-auth renders identically.
    expect(insecure).toEqual(resources);
    expect(env(find(insecure, 'Deployment', 'tenant-controller') as Deployment)).not.toHaveProperty(
      'TENANT_CONTROLLER_REGISTRY_PULL_TLS',
    );
    expect(find(insecure, 'Service', REGISTRY_PULL_SERVICE)).toMatchObject({
      spec: { ports: [{ name: 'pull', port: 443, targetPort: 8791 }] },
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
    const noneArgs = none.spec.template.spec.containers[0]!.args as string[];
    expect(noneArgs.filter((arg) => arg.includes('ca-path'))).toEqual([]);
    expect(JSON.stringify(none.spec.template.spec.volumes)).not.toContain('registry-');

    const withCa = host(
      tenantResources(tenant(), tlsCfg, schedulerSecret, [], false, true, false, {
        caDigest: 'abc',
      }),
    );
    const container = withCa.spec.template.spec.containers[0]!;
    // The tenant CA is trusted for OCI pulls and for the components' outgoing wasi:http (#113),
    // both from the one mounted file whose digest rolls the hosts.
    expect((container.args as string[]).filter((arg) => arg.includes('ca-path'))).toEqual([
      '--oci-ca-path=/registry-ca/ca.crt',
      '--http-client-ca-path=/registry-ca/ca.crt',
    ]);
    // Layered on the default webpki roots, not replacing them. Every component's HTTPS egress
    // also accepts any name the tenant CA signs, as --oci-ca-path does for pulls (CA follow-ups: #170).
    expect((container.args as string[]).some((arg) => arg.includes('trust-roots'))).toBe(false);
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
    expect(container.args).not.toContain('--insecure-registry');
  });

  it('allowlists only the platform registry for plain HTTP on an insecure install (#149)', () => {
    const render = (config: ControllerConfig) =>
      tenantResources(tenant(), config, schedulerSecret, [], false, true, false, {
        caDigest: 'abc',
      });
    const secure = render(tlsCfg);
    const insecure = render(insecureCfg);
    const args = host(insecure).spec.template.spec.containers[0]!.args as string[];
    expect(args).not.toContain('--allow-insecure-registries');
    // The pull listener stays TLS: the CA is still mounted and trusted.
    expect(args).toContain('--oci-ca-path=/registry-ca/ca.crt');
    // The exact spelling of `registry.pull` in local.ts, which wash matches verbatim.
    expect(PLATFORM_REGISTRY).toBe('di-framework-registry.wasmcloud.svc.cluster.local:5000');
    const at = args.indexOf('--insecure-registry');
    expect(args.slice(at, at + 2)).toEqual(['--insecure-registry', PLATFORM_REGISTRY]);
    expect(args.filter((arg) => arg === '--insecure-registry')).toHaveLength(1);
    // Otherwise the insecure install renders exactly what the TLS install does.
    const container = host(insecure).spec.template.spec.containers[0]!;
    container.args = args.filter((_, i) => i !== at && i !== at + 1);
    expect(insecure).toEqual(secure);
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

  it('rolls the hosts when a CA is published and retired, not when it switches (#170)', async () => {
    const { api, t } = prepare();
    const DAY = 86_400_000;
    const t0 = new Date('2026-10-14T00:00:00Z').getTime();
    let clock = new Date(t0);
    const controller = new Controller(api, tlsCfg, undefined, () => clock);
    const digestAt = async (days: number) => {
      clock = new Date(t0 + days * DAY);
      // The tenant step renders the hosts from the bundle the previous pass applied.
      await controller.reconcileTenant(t, []);
      await controller.reconcileTenant(t, []);
      const bundle = String(
        (api.objects.get(caPath)?.data as Record<string, string> | undefined)?.['ca.crt'],
      );
      const digest =
        host(api).spec.template.metadata.annotations[
          'platform.di-framework.dev/registry-ca-sha256'
        ];
      expect(digest).toBe(tlsCertDigest(bundle));
      return digest;
    };
    const created = await digestAt(0);
    expect(await digestAt(CA_DAYS - CA_RENEW_DAYS - 10)).toBe(created);
    const published = await digestAt(CA_DAYS - CA_RENEW_DAYS + 1);
    expect(published).not.toBe(created);
    expect(await digestAt(CA_DAYS - CA_RENEW_DAYS + CA_OVERLAP_DAYS + 2)).toBe(published);
    const retired = await digestAt(CA_DAYS + 1);
    expect(retired).not.toBe(published);
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

  it('reports HostPullError over Reconciled and Provisioning, and keeps failure reasons (#131)', () => {
    const base = {
      type: 'TenantAuthReady',
      observedGeneration: 1,
      lastTransitionTime: '2026-10-14T00:00:00.000Z',
    };
    const detail = 'Tenant host registry wiring could not be read:';
    for (const [status, reason] of [
      ['True', 'Reconciled'],
      ['False', 'Provisioning'],
    ] as const)
      expect(
        withHostPullFailure({ ...base, status, reason, message: 'm' }, new Error('down')),
      ).toEqual({ ...base, status: 'False', reason: 'HostPullError', message: `${detail} down` });
    for (const reason of ['RouteError', 'RegistryHostConflict', 'ReconcileError'])
      expect(
        withHostPullFailure({ ...base, status: 'False', reason, message: 'earlier' }, 'down'),
      ).toEqual({ ...base, status: 'False', reason, message: `earlier; ${detail} down` });
  });

  it('keeps an earlier TenantAuthReady failure reason when the host wiring lookup fails (#131)', async () => {
    const { api, t } = prepare();
    const controller = new Controller(api, tlsCfg);
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    const condition = () => t.status?.conditions?.find((c) => c.type === 'TenantAuthReady');
    // A workload that claims the registry host: TenantAuthReady reports RegistryHostConflict.
    api.seed({
      apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
      kind: 'WorkloadDeployment',
      metadata: { name: 'claimant', namespace: 'di-tenant-alpha', labels: {} },
      spec: {
        template: {
          spec: {
            hostInterfaces: [
              {
                namespace: 'wasi',
                package: 'http',
                interfaces: ['handler'],
                config: { host: registryHttpHost(withRegistry) },
              },
            ],
          },
        },
      },
    } as unknown as Resource);
    const log = console.error;
    console.error = () => {};
    try {
      await controller.reconcileTenant(t, []);
      expect(condition()).toMatchObject({ status: 'False', reason: 'RegistryHostConflict' });
      const conflict = condition()?.message;
      // Only the host wiring lookup (the first read of the CA this tick) fails.
      let failures = 0;
      api.fail = (method, p) =>
        method === 'GET' && p === caPath && failures++ === 0
          ? new ApiError(500, 'configmaps unavailable')
          : undefined;
      await controller.reconcileTenant(t, []);
      expect(condition()).toMatchObject({ status: 'False', reason: 'RegistryHostConflict' });
      expect(condition()?.message).toBe(
        `${conflict}; Tenant host registry wiring could not be read: configmaps unavailable`,
      );
    } finally {
      api.fail = undefined;
      console.error = log;
    }
  });

  it('wires the hosts with TLS for the pull listener even when insecureRegistry is true', async () => {
    const { api, t } = prepare();
    const controller = new Controller(api, insecureCfg);
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    expect(env(host(api)).DOCKER_CONFIG).toBe('/registry-auth');
    const args = host(api).spec.template.spec.containers[0]!.args as string[];
    expect(args).toContain('--oci-ca-path=/registry-ca/ca.crt');
    expect(args).toContain('--http-client-ca-path=/registry-ca/ca.crt');
    expect(args).not.toContain('--allow-insecure-registries');
    expect(args.join(' ')).toContain(`--insecure-registry ${PLATFORM_REGISTRY}`);
    expect(api.objects.get(pullServicePath)).toMatchObject({
      spec: { ports: [{ port: 443, targetPort: 8791 }] },
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
