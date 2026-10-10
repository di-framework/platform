import { describe, expect, it } from 'bun:test';
import { evaluate } from '@marcbachmann/cel-js';
import { tenantSecretDeleteAllowed } from '../src/tenancy/admission';
import { controller, developer, loadPolicy, tenantController } from './support/cel-policy';

const { spec, binding } = loadPolicy('tenant-secret-delete');

interface Case {
  username: string;
  dryRun?: boolean;
  options?: { propagationPolicy?: string; orphanDependents?: boolean };
  finalizers?: string[];
  deletionTimestamp?: string;
}

const celAllowed = (c: Case) => {
  const request: Record<string, unknown> = {
    operation: 'DELETE',
    userInfo: { username: c.username },
    dryRun: c.dryRun ?? false,
  };
  if (c.options) request.options = c.options;
  const metadata: Record<string, unknown> = { name: 'db.prod' };
  if (c.finalizers) metadata.finalizers = c.finalizers;
  if (c.deletionTimestamp) metadata.deletionTimestamp = c.deletionTimestamp;
  return spec.validations.every(
    (rule) => evaluate(rule.expression, { request, oldObject: { metadata } }) === true,
  );
};

/** Evaluates the CEL rule and asserts the TS mirror agrees. */
const both = (c: Case) => {
  const cel = celAllowed(c);
  expect(tenantSecretDeleteAllowed({ ...c, controllerNamespace: 'wasmcloud' })).toBe(cel);
  return cel;
};

describe('tenant-secret-delete admission (#112)', () => {
  it('matches Secret DELETEs in tenant namespaces', () => {
    expect(spec.matchConstraints.resourceRules).toEqual([
      expect.objectContaining({ operations: ['DELETE'], resources: ['secrets'] }),
    ]);
    expect(JSON.stringify(binding?.spec)).toContain('"operator":"Exists"');
    expect(binding?.spec).toMatchObject({ validationActions: ['Deny'] });
  });

  it('allows a plain delete by a developer', () => {
    expect(both({ username: developer })).toBe(true);
    expect(both({ username: developer, options: { propagationPolicy: 'Background' } })).toBe(true);
    expect(both({ username: developer, options: {} })).toBe(true);
  });

  it('denies developer deletes that return the Secret without removing it', () => {
    expect(both({ username: developer, dryRun: true })).toBe(false);
    for (const propagationPolicy of ['Orphan', 'Foreground'])
      expect(both({ username: developer, options: { propagationPolicy } })).toBe(false);
    expect(both({ username: developer, options: { orphanDependents: true } })).toBe(false);
    expect(both({ username: developer, finalizers: ['example.com/hold'] })).toBe(false);
    expect(both({ username: developer, deletionTimestamp: '2026-10-09T00:00:00Z' })).toBe(false);
  });

  it('leaves the platform and tenant controllers unaffected', () => {
    for (const username of [controller, tenantController]) {
      expect(both({ username, dryRun: true })).toBe(true);
      expect(both({ username, options: { propagationPolicy: 'Foreground' } })).toBe(true);
      expect(both({ username, finalizers: ['x'] })).toBe(true);
    }
  });
});
