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
    namespace: c.namespace ?? 'di-runtime-acme',
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
      namespace: c.namespace ?? 'di-runtime-acme',
      name: c.name ?? KEY,
    }),
  ).toBe(cel);
  return cel;
};

describe('tenant-controller-secrets admission (#321)', () => {
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
      expect(
        both({
          username: tenantController,
          operation,
          namespace: 'di-tenant-acme',
          labels: keyLabels,
        }),
      ).toBe(false);
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
      // A ServiceAccount of the same name in another namespace.
      expect(
        both({
          username: 'system:serviceaccount:di-tenant-acme:tenant-controller',
          operation,
          labels: keyLabels,
        }),
      ).toBe(false);
      // The same controller in its own namespace is allowed.
      expect(
        both({ username: other, operation, namespace: 'di-runtime-other', labels: otherLabels }),
      ).toBe(true);
    }
  });

  it('leaves the platform controller and tenant users to their own rules', () => {
    for (const username of [controller, developer, 'system:serviceaccount:x:tenant-console'])
      for (const operation of ['CREATE', 'UPDATE', 'DELETE'] as const)
        expect(both({ username, operation, name: 'tenant-console-oauth' })).toBe(true);
  });
});
