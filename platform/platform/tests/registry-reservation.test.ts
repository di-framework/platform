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
import { GROUP, REGISTRY_WORKLOAD, type Resource } from '../src/tenancy/resources';

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
  metadata: { name: string; labels?: Record<string, string> };
  spec: { template: { spec: { hostInterfaces?: HostInterfaceLike[] } } };
};
const workload = (
  name: string,
  labels?: Record<string, string>,
  hostInterfaces?: HostInterfaceLike[],
): Workload => ({
  metadata: { name, ...(labels ? { labels } : {}) },
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
  const variants: [string, HostInterfaceLike[]][] = [
    ['registry shape', [http('registry'), secrets()]],
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
        for (const [label, hostInterfaces] of variants) {
          const object = workload(REGISTRY_WORKLOAD, undefined, hostInterfaces);
          const expected = hostInterfaces.every((h) =>
            hostInterfaceAllowed(h, { username, controllerNamespace: 'wasmcloud' }),
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
