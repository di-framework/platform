import { describe, expect, it } from 'bun:test';
import {
  TENANT_CONTROLLER_SECRET_MESSAGE,
  tenantControllerSecretAllowed,
} from '../src/tenancy/admission';
import { evaluate } from './support/cel';
import { controller, developer, loadPolicy, tenantController } from './support/cel-policy';

const policy = loadPolicy('tenant-controller-secrets');
const { spec } = policy;
const KEY = 'di-apikey-0123456789abcdef';
/** Where the tenant controller keeps acme's API keys (#379). */
const KEYS_NS = 'di-apikeys-acme';
const keyLabels = {
  'platform.di-framework.dev/api-key': 'true',
  'platform.di-framework.dev/tenant': 'acme',
  'platform.di-framework.dev/user': 'alice',
};

interface Case {
  username: string;
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
  namespace?: string;
  name?: string;
  labels?: Record<string, string>;
}

const celAllowed = (c: Case) => {
  const metadata: Record<string, unknown> = { name: c.name ?? KEY };
  if (c.labels) metadata.labels = c.labels;
  const object = c.operation === 'DELETE' ? null : { metadata };
  const oldObject = c.operation === 'CREATE' ? null : { metadata };
  const request = {
    operation: c.operation,
    namespace: c.namespace ?? KEYS_NS,
    userInfo: { username: c.username },
  };
  return spec.validations.every(
    (rule) => evaluate(rule.expression, { request, object, oldObject }) === true,
  );
};

/** Evaluates the CEL rule and asserts the TS mirror agrees. */
const both = (c: Case) => {
  const cel = celAllowed(c);
  expect(
    tenantControllerSecretAllowed({
      ...c,
      namespace: c.namespace ?? KEYS_NS,
      name: c.name ?? KEY,
    }),
  ).toBe(cel);
  return cel;
};

describe('tenant-controller-secrets admission (#321, #379)', () => {
  it('matches Secret writes in tenant namespaces', () => {
    expect(spec.matchConstraints.resourceRules).toEqual([
      expect.objectContaining({
        operations: ['CREATE', 'UPDATE', 'DELETE'],
        resources: ['secrets'],
      }),
    ]);
    expect(JSON.stringify(policy.binding?.spec)).toContain('"operator":"Exists"');
    expect(policy.binding?.spec).toMatchObject({ validationActions: ['Deny'] });
    expect(spec.validations.map((v) => v.message)).toEqual([TENANT_CONTROLLER_SECRET_MESSAGE]);
  });

  it('lets the tenant controller create and revoke its API keys', () => {
    for (const operation of ['CREATE', 'DELETE'] as const)
      expect(both({ username: tenantController, operation, labels: keyLabels })).toBe(true);
  });

  it('denies the tenant controller every other Secret write', () => {
    for (const operation of ['CREATE', 'DELETE'] as const) {
      for (const name of [
        'tenant-console-oauth',
        'tenant-controller-tls',
        'tenant-controller-ca-key',
        'di-tenant-registry-pull',
        'di-apikey-0123',
        'di-apikey-0123456789ABCDEF',
        `${KEY}-x`,
      ])
        expect(both({ username: tenantController, operation, name, labels: keyLabels })).toBe(
          false,
        );
      // An API-key name without the key labels, or labelled for another tenant.
      expect(both({ username: tenantController, operation })).toBe(false);
      expect(
        both({
          username: tenantController,
          operation,
          labels: { 'platform.di-framework.dev/tenant': 'acme' },
        }),
      ).toBe(false);
      expect(
        both({
          username: tenantController,
          operation,
          labels: { ...keyLabels, 'platform.di-framework.dev/api-key': 'false' },
        }),
      ).toBe(false);
      expect(
        both({
          username: tenantController,
          operation,
          labels: { 'platform.di-framework.dev/api-key': 'true' },
        }),
      ).toBe(false);
      expect(
        both({
          username: tenantController,
          operation,
          labels: { ...keyLabels, 'platform.di-framework.dev/tenant': 'other' },
        }),
      ).toBe(false);
      // API keys, correctly labelled, anywhere but its key namespace: the tenant namespace, and
      // the runtime namespace where keys lived before #379 and its own Secrets still live.
      for (const namespace of ['di-tenant-acme', 'di-runtime-acme', 'di-apikeys-other'])
        expect(both({ username: tenantController, operation, namespace, labels: keyLabels })).toBe(
          false,
        );
    }
    // keys.ts never updates a key; neither may the controller.
    expect(both({ username: tenantController, operation: 'UPDATE', labels: keyLabels })).toBe(
      false,
    );
  });

  it('denies a tenant controller writes outside its own namespace', () => {
    const other = 'system:serviceaccount:di-runtime-other:tenant-controller';
    const otherLabels = { ...keyLabels, 'platform.di-framework.dev/tenant': 'other' };
    for (const operation of ['CREATE', 'DELETE'] as const) {
      // Another tenant's controller, with this tenant's key labels, in this tenant's namespace.
      expect(both({ username: other, operation, labels: keyLabels })).toBe(false);
      // Another tenant's controller, with its own labels, in this tenant's key namespace.
      expect(both({ username: other, operation, labels: otherLabels })).toBe(false);
      // A ServiceAccount of the same name in another namespace, the key namespace included.
      for (const namespace of ['di-tenant-acme', 'di-apikeys-acme'])
        expect(
          both({
            username: `system:serviceaccount:${namespace}:tenant-controller`,
            operation,
            labels: keyLabels,
          }),
        ).toBe(false);
      // The other controller in its own tenant's key namespace is allowed.
      expect(
        both({ username: other, operation, namespace: 'di-apikeys-other', labels: otherLabels }),
      ).toBe(true);
    }
  });

  it('leaves the platform controller and tenant users to their own rules', () => {
    for (const username of [controller, developer, 'system:serviceaccount:x:tenant-console'])
      for (const operation of ['CREATE', 'UPDATE', 'DELETE'] as const)
        expect(both({ username, operation, name: 'tenant-console-oauth' })).toBe(true);
  });

  it('lets the platform controller move keys between the namespaces (#379)', () => {
    // The migration copies each key into the key namespace and deletes the original.
    expect(both({ username: controller, operation: 'CREATE', labels: keyLabels })).toBe(true);
    expect(
      both({
        username: controller,
        operation: 'DELETE',
        namespace: 'di-runtime-acme',
        labels: keyLabels,
      }),
    ).toBe(true);
  });
});
