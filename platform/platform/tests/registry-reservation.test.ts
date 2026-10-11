import { describe, expect, it } from 'bun:test';
import { evaluate } from '@marcbachmann/cel-js';
import {
  admissionResources,
  claimsRegistryHost,
  type HostInterfaceLike,
  hostInterfaceAllowed,
  REGISTRY_HOST_MESSAGE,
  REGISTRY_RESERVED_MESSAGE,
  REGISTRY_WORKLOAD_NAME,
  reservedWorkloadDenial,
} from '../src/tenancy/admission';
import {
  type ControllerConfig,
  GROUP,
  INSTALLATION,
  REGISTRY_WORKLOAD,
  type Resource,
  type Tenant,
  tenantAuthResources,
  VERSION,
} from '../src/tenancy/resources';
import { caCertificate, leafCertificate } from '../src/tenancy/tls';

const controllerUser = 'system:serviceaccount:wasmcloud:di-platform-controller';
const tenantUser = 'system:serviceaccount:wasmcloud:di-user-dev';
/** Accounts that look like the controller or a tenant user but are neither. */
const lookAlikes = [
  'system:serviceaccount:wasmcloud:di-platform-controller-x',
  'system:serviceaccount:other:di-platform-controller',
  'system:serviceaccount:other:di-user-dev',
  'system:serviceaccount:wasmcloud:di-userdev',
  'di-user-dev',
];
const users = [controllerUser, tenantUser, ...lookAlikes];
const COMPONENT_LABEL = `${GROUP}/component`;

type Spec = {
  variables?: { name: string; expression: string }[];
  validations: { expression: string; message: string }[];
};
function policy(name: string, registryHost?: string): Spec & { operations: string[] } {
  const value = admissionResources('test', 'wasmcloud', registryHost).find(
    (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === `test-${name}`,
  ) as Resource;
  const spec = value.spec as Spec & {
    matchConstraints: { resourceRules: { operations: string[] }[] };
  };
  return { ...spec, operations: spec.matchConstraints.resourceRules[0]!.operations };
}

type Workload = {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec: { template: { spec: { hostInterfaces?: HostInterfaceLike[] } } };
};
const workload = (
  name: string,
  labels?: Record<string, string>,
  hostInterfaces?: HostInterfaceLike[],
): Workload => ({
  metadata: { name, namespace: 'di-tenant-alpha', ...(labels ? { labels } : {}) },
  spec: { template: { spec: hostInterfaces ? { hostInterfaces } : {} } },
});
const http = (host?: string): HostInterfaceLike => ({
  namespace: 'wasi',
  package: 'http',
  interfaces: ['handler'],
  ...(host === undefined ? {} : { config: { host } }),
});

describe('tenant registry reservation (#83 C1)', () => {
  it('names the workload the controller renders and matches CREATE, UPDATE and DELETE', () => {
    expect(REGISTRY_WORKLOAD_NAME).toBe(REGISTRY_WORKLOAD);
    expect(policy('reserved-workloads').operations).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    // The other workload rules read `object`, so they stay CREATE/UPDATE only.
    expect(policy('workloads').operations).toEqual(['CREATE', 'UPDATE']);
  });

  it('matches the registry host in any case, with a trailing dot or a port', () => {
    for (const host of ['registry', 'Registry', 'REGISTRY', 'registry.', 'registry:80'])
      expect(claimsRegistryHost(host, 'registry')).toBe(true);
    for (const host of ['registry-prod', 'xregistry', 'registry.example', 'oci', ''])
      expect(claimsRegistryHost(host, 'registry')).toBe(false);
    expect(claimsRegistryHost('OCI', 'oci')).toBe(true);
  });

  it('denies tenant users and leaves the controller and other deletes alone', () => {
    const deny = (
      username: string,
      operation: 'CREATE' | 'UPDATE' | 'DELETE',
      object?: Workload,
      oldObject?: Workload,
    ) =>
      reservedWorkloadDenial({
        username,
        controllerNamespace: 'wasmcloud',
        operation,
        registryHost: 'registry',
        object,
        oldObject,
      });
    const registry = workload(REGISTRY_WORKLOAD, { [COMPONENT_LABEL]: 'tenant-auth' }, [
      http('registry'),
    ]);
    for (const op of ['CREATE', 'UPDATE'] as const)
      expect(deny(controllerUser, op, registry, registry)).toBeUndefined();
    expect(deny(controllerUser, 'DELETE', undefined, registry)).toBeUndefined();
    expect(deny(tenantUser, 'CREATE', registry)).toBe(REGISTRY_RESERVED_MESSAGE);
    expect(deny(tenantUser, 'UPDATE', registry, registry)).toBe(REGISTRY_RESERVED_MESSAGE);
    expect(deny(tenantUser, 'DELETE', undefined, registry)).toBe(REGISTRY_RESERVED_MESSAGE);
    // Dropping the label or the secrets entry from the registry does not help: the name holds.
    const stripped = workload(REGISTRY_WORKLOAD, {}, [http('x')]);
    expect(deny(tenantUser, 'UPDATE', stripped, registry)).toBe(REGISTRY_RESERVED_MESSAGE);
    // Neither does removing the label from another labelled workload, or forging it.
    const forged = workload('web-prod', { [COMPONENT_LABEL]: 'tenant-auth' });
    expect(deny(tenantUser, 'CREATE', forged)).toBe(REGISTRY_RESERVED_MESSAGE);
    expect(deny(tenantUser, 'UPDATE', workload('web-prod'), forged)).toBe(
      REGISTRY_RESERVED_MESSAGE,
    );
    expect(deny(tenantUser, 'CREATE', workload('web-prod', {}, [http('REGISTRY')]))).toBe(
      REGISTRY_HOST_MESSAGE,
    );
    expect(deny(tenantUser, 'DELETE', undefined, workload('web-prod'))).toBeUndefined();
    expect(
      deny(tenantUser, 'CREATE', workload('web-prod', {}, [http('web-prod')])),
    ).toBeUndefined();
    for (const user of lookAlikes)
      expect(deny(user, 'DELETE', undefined, registry)).toBeUndefined();
  });

  /** Evaluates the policy's real CEL against the TS mirror over a generated case matrix. */
  for (const registryHost of ['registry', 'oci']) {
    it(`agrees with the CEL on every case (registry host ${registryHost})`, () => {
      const spec = policy('reserved-workloads', registryHost);
      expect(spec.validations).toHaveLength(2);
      const cel = (request: unknown, object: unknown, oldObject: unknown) => {
        const failed = spec.validations.find(
          (rule) => evaluate(rule.expression, { request, object, oldObject }) !== true,
        );
        return failed?.message;
      };
      const names = [
        REGISTRY_WORKLOAD,
        'di-tenant-registry-x',
        'Di-Tenant-Registry',
        'web-prod',
        'registry',
      ];
      const labelStates: (Record<string, string> | undefined)[] = [
        undefined,
        {},
        { [COMPONENT_LABEL]: 'tenant-auth' },
        { [COMPONENT_LABEL]: 'Tenant-Auth' },
        { [COMPONENT_LABEL]: 'backing-service' },
        { 'other/component': 'tenant-auth' },
      ];
      const hostStates: (HostInterfaceLike[] | undefined)[] = [
        undefined,
        [],
        [http()],
        [{ ...http(), config: {} }],
        ...[
          'registry',
          'Registry',
          'REGISTRY',
          'registry.',
          'registry:8080',
          'registry-prod',
          'oci',
          'OCI',
          'oci-staging',
        ].map((host) => [http(host)]),
        [{ namespace: 'wasmcloud', package: 'keyvalue', config: { host: registryHost } }],
        [http('web-prod'), http(registryHost.toUpperCase())],
      ];
      const objects: Workload[] = [];
      for (const name of names)
        for (const labels of labelStates)
          for (const hosts of hostStates) objects.push(workload(name, labels, hosts));
      const pairs: [Workload | undefined, Workload | undefined][] = [];
      const sample = (index: number) => objects[(index * 7919) % objects.length]!;
      let cases = 0;
      for (const username of users)
        for (const operation of ['CREATE', 'UPDATE', 'DELETE'] as const) {
          pairs.length = 0;
          for (const [index, value] of objects.entries()) {
            if (operation === 'CREATE') pairs.push([value, undefined]);
            else if (operation === 'DELETE') pairs.push([undefined, value]);
            else pairs.push([value, sample(index)], [sample(index), value]);
          }
          for (const [object, oldObject] of pairs) {
            const expected = reservedWorkloadDenial({
              username,
              controllerNamespace: 'wasmcloud',
              operation,
              registryHost,
              object,
              oldObject,
            });
            const actual = cel(
              { userInfo: { username }, operation },
              object ?? null,
              oldObject ?? null,
            );
            if (actual !== expected)
              throw new Error(
                `CEL ${actual} vs TS ${expected}: ${JSON.stringify({ username, operation, object, oldObject })}`,
              );
            cases++;
          }
        }
      expect(cases).toBeGreaterThan(10000);
    });
  }
});

/** The registry's hostInterfaces, exactly as the controller renders them (#150). */
function renderedRegistryInterfaces(): HostInterfaceLike[] {
  const tenant: Tenant = {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec: {},
  };
  const cfg: ControllerConfig = {
    installation: 'test',
    namespace: 'wasmcloud',
    hostImage: 'wash:test',
    schedulerNatsUrl: 'nats://nats:4222',
    insecureRegistry: true,
    tenantAuth: {
      image: `ghcr.io/di-framework/tenant-auth@sha256:${'a'.repeat(64)}`,
      issuer: 'http://identity.alpha.localhost:28180',
      oauthClient: { id: 'access', secretName: 'tenant-auth-oauth' },
      issuerUpstream: 'di-platform-gateway.wasmcloud.svc.cluster.local:80',
      issuerUpstreamPodPort: 8080,
      consolePublicUrl: 'http://console.{tenant}.localhost:28180',
      registry: {
        component: `ghcr.io/di-framework/oci-registry@sha256:${'b'.repeat(64)}`,
        publicUrl: 'https://registry.{tenant}.localhost:28180',
      },
    },
  };
  const ca = caCertificate('tenant-controller CA', 30);
  const tls = {
    ...leafCertificate('tenant-controller', ['tenant-controller'], [], 30, ca.cert, ca.key),
    caCert: ca.cert,
    caKey: ca.key,
  };
  const rendered = tenantAuthResources(tenant, cfg, {
    members: ['alice'],
    apiServer: { addresses: ['10.0.0.1'], port: 6443 },
    tls,
    clientSecret: 'c2VjcmV0',
  }).find((r) => r.metadata.name === REGISTRY_WORKLOAD)!;
  return (rendered.spec as Workload['spec']).template.spec.hostInterfaces!;
}

describe('wasmcloud:secrets bind-time config (#83 W1)', () => {
  const spec = policy('workloads');
  const rule = spec.validations.find((v) =>
    v.expression.includes('variables.w.hostInterfaces.all'),
  )!;
  const celAllowed = (username: string, operation: string, object: Workload) => {
    const request = { userInfo: { username }, operation };
    const variables: Record<string, unknown> = {};
    for (const name of ['w', 'controller']) {
      const expression = spec.variables!.find((v) => v.name === name)!.expression;
      variables[name] = evaluate(expression, { request, object, variables });
    }
    return evaluate(rule.expression, { request, object, variables }) === true;
  };
  const secrets = (extra: Partial<HostInterfaceLike> = {}): HostInterfaceLike => ({
    namespace: 'wasmcloud',
    package: 'secrets',
    interfaces: ['store', 'reveal'],
    config: { 'tenant-controller-url': 'http://tenant-controller.di-runtime-alpha.svc:8789' },
    ...extra,
  });
  const blobstoreNats = (config: Record<string, string> = {}): HostInterfaceLike => ({
    namespace: 'wasmcloud',
    package: 'blobstore',
    interfaces: ['blobstore', 'container', 'types'],
    config: {
      backend: 'nats',
      url: 'nats://di-nats.di-runtime-alpha.svc.cluster.local:4222',
      ...config,
    },
  });
  const variants: [string, HostInterfaceLike[], string?][] = [
    ['registry shape', [http('registry'), blobstoreNats(), secrets()]],
    ['rendered registry', renderedRegistryInterfaces()],
    [
      'nats tenant-agnostic url',
      [blobstoreNats({ url: 'nats://di-nats.di-runtime-beta.svc.cluster.local:4222' })],
    ],
    ['nats other backend', [blobstoreNats({ backend: 'redis' })]],
    [
      'nats look-alike host',
      [blobstoreNats({ url: 'nats://di-nats.di-runtime-alpha.svc.cluster.local:4222.evil' })],
    ],
    ['nats extra interface', [{ ...blobstoreNats(), interfaces: ['blobstore', 'evil'] }]],
    ['nats other tenant namespace', [blobstoreNats()], 'di-tenant-beta'],
    ['nats non-tenant namespace', [blobstoreNats()], 'default'],
    ['nats extra key', [blobstoreNats({ extra: 'x' })]],
    ['nats named', [{ ...blobstoreNats(), name: 'other' }]],
    ['nats configFrom', [{ ...blobstoreNats(), configFrom: [{ name: 'di-bs-x' }] }]],
    ['blobstore empty config', [{ ...blobstoreNats(), config: {} }]],
    ['bare', [secrets({ config: undefined, interfaces: undefined })]],
    ['named', [secrets({ name: 'other' })]],
    ['empty name', [secrets({ name: '' })]],
    ['secretFrom', [secrets({ secretFrom: [{ name: 'tenant-creds' }] })]],
    ['configFrom', [secrets({ configFrom: [{ name: 'di-bs-x' }] })]],
    ['empty references', [secrets({ secretFrom: [], configFrom: [] })]],
    ['dropped', [http('registry')]],
  ];

  it('agrees with the mirror for every requester on CREATE and UPDATE', () => {
    let cases = 0;
    for (const username of users)
      for (const operation of ['CREATE', 'UPDATE'])
        for (const [label, hostInterfaces, ns = 'di-tenant-alpha'] of variants) {
          const object = workload(REGISTRY_WORKLOAD, undefined, hostInterfaces);
          object.metadata.namespace = ns;
          const expected = hostInterfaces.every((h) =>
            hostInterfaceAllowed(h, {
              username,
              controllerNamespace: 'wasmcloud',
              workloadNamespace: ns,
            }),
          );
          const actual = celAllowed(username, operation, object);
          if (actual !== expected)
            throw new Error(`CEL ${actual} vs TS ${expected}: ${username} ${operation} ${label}`);
          cases++;
        }
    expect(cases).toBe(users.length * 2 * variants.length);
  });

  it('admits the controller, denies tenant users and look-alikes', () => {
    const registry = workload(REGISTRY_WORKLOAD, undefined, [http('registry'), secrets()]);
    for (const operation of ['CREATE', 'UPDATE'])
      expect(celAllowed(controllerUser, operation, registry)).toBe(true);
    for (const username of [tenantUser, ...lookAlikes])
      for (const operation of ['CREATE', 'UPDATE'])
        expect(celAllowed(username, operation, registry)).toBe(false);
    // Even the controller may not name it or reference Secrets or ConfigMaps through it.
    for (const extra of [
      { name: 'other' },
      { secretFrom: [{ name: 'x' }] },
      { configFrom: [{ name: 'x' }] },
    ])
      expect(celAllowed(controllerUser, 'CREATE', workload('x', undefined, [secrets(extra)]))).toBe(
        false,
      );
    // Without a requester the mirror is fail-closed.
    expect(hostInterfaceAllowed(secrets())).toBe(false);
  });

  it('admits the rendered registry blobstore for the controller only, and only exactly', () => {
    const rendered = renderedRegistryInterfaces();
    const blob = rendered.find((h) => h.package === 'blobstore')!;
    expect(blob.config).toEqual({
      backend: 'nats',
      url: 'nats://di-nats.di-runtime-alpha.svc.cluster.local:4222',
    });
    const registry = workload(REGISTRY_WORKLOAD, undefined, rendered);
    for (const operation of ['CREATE', 'UPDATE'])
      expect(celAllowed(controllerUser, operation, registry)).toBe(true);
    for (const username of [tenantUser, ...lookAlikes])
      for (const operation of ['CREATE', 'UPDATE'])
        expect(celAllowed(username, operation, registry)).toBe(false);
    for (const config of [
      { backend: 'nats', url: 'nats://evil.example:4222' },
      { backend: 'nats', url: 'nats://di-nats.di-runtime-beta.svc.cluster.local:4222' },
      { backend: 's3', url: 'nats://di-nats.di-runtime-alpha.svc.cluster.local:4222' },
      { backend: 'nats' },
    ])
      expect(
        celAllowed(controllerUser, 'CREATE', workload('x', undefined, [{ ...blob, config }])),
      ).toBe(false);
    // The mirror is fail-closed without a workload namespace.
    expect(
      hostInterfaceAllowed(blob, { username: controllerUser, controllerNamespace: 'wasmcloud' }),
    ).toBe(false);
  });

  it('lets a tenant update that drops secrets through this rule, but not the reservation', () => {
    const dropped = workload(REGISTRY_WORKLOAD, undefined, [http('registry')]);
    expect(celAllowed(tenantUser, 'UPDATE', dropped)).toBe(true);
    expect(
      reservedWorkloadDenial({
        username: tenantUser,
        controllerNamespace: 'wasmcloud',
        operation: 'UPDATE',
        registryHost: 'registry',
        object: dropped,
        oldObject: workload(REGISTRY_WORKLOAD, undefined, [http('registry'), secrets()]),
      }),
    ).toBe(REGISTRY_RESERVED_MESSAGE);
  });
});
