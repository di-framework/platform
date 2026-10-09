import { describe, expect, it } from 'bun:test';
import { evaluate } from '@marcbachmann/cel-js';
import {
  admissionResources,
  SECRET_UPDATE_KEYS_MESSAGE,
  SECRET_UPDATE_MANAGED_MESSAGE,
  tenantSecretUpdateDenial,
} from '../src/tenancy/admission';

const developer = 'system:serviceaccount:wasmcloud:di-user-dev';
const controller = 'system:serviceaccount:wasmcloud:di-platform-controller';
const tenantController = 'system:serviceaccount:di-runtime-acme:tenant-controller';

const resources = admissionResources('test', 'wasmcloud');
const policy = resources.find(
  (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === 'test-tenant-secret-update',
);
const binding = resources.find(
  (r) =>
    r.kind === 'ValidatingAdmissionPolicyBinding' &&
    r.metadata.name === 'test-tenant-secret-update',
);
const spec = policy?.spec as {
  matchConstraints: { resourceRules: { operations: string[]; resources: string[] }[] };
  validations: { expression: string; message: string }[];
};

interface Case {
  username: string;
  name?: string;
  oldKeys?: string[];
  newKeys?: string[];
}

const data = (keys?: string[]) =>
  keys === undefined ? {} : { data: Object.fromEntries(keys.map((key) => [key, 'eA=='])) };

/** The first failing CEL rule's message, or undefined when every rule passes. */
const celDenial = (c: Case) => {
  const metadata = { name: c.name ?? 'db.prod' };
  const oldObject = { metadata, ...data(c.oldKeys) };
  const object = { metadata, ...data(c.newKeys) };
  const request = { operation: 'UPDATE', userInfo: { username: c.username } };
  return spec.validations.find(
    (rule) => evaluate(rule.expression, { request, object, oldObject }) !== true,
  )?.message;
};

/** Evaluates the CEL rules and asserts the TS mirror agrees. */
const both = (c: Case) => {
  const cel = celDenial(c);
  expect(
    tenantSecretUpdateDenial({ ...c, name: c.name ?? 'db.prod', controllerNamespace: 'wasmcloud' }),
  ).toBe(cel);
  return cel;
};

describe('tenant-secret-update admission (#112)', () => {
  it('matches Secret UPDATEs in tenant namespaces', () => {
    expect(spec.matchConstraints.resourceRules).toEqual([
      expect.objectContaining({ operations: ['UPDATE'], resources: ['secrets'] }),
    ]);
    expect(JSON.stringify(binding?.spec)).toContain('"operator":"Exists"');
    expect(binding?.spec).toMatchObject({ validationActions: ['Deny'] });
  });

  it('denies a developer update of a platform-managed Secret', () => {
    for (const name of ['di-binding-web-prod-cache', 'di-bs-cache'])
      expect(both({ username: developer, name, oldKeys: ['a'], newKeys: ['a'] })).toBe(
        SECRET_UPDATE_MANAGED_MESSAGE,
      );
  });

  it('denies a developer update that drops a key', () => {
    expect(both({ username: developer, oldKeys: ['a', 'b'], newKeys: ['a'] })).toBe(
      SECRET_UPDATE_KEYS_MESSAGE,
    );
    expect(both({ username: developer, oldKeys: ['a'], newKeys: ['b'] })).toBe(
      SECRET_UPDATE_KEYS_MESSAGE,
    );
    expect(both({ username: developer, oldKeys: ['a'] })).toBe(SECRET_UPDATE_KEYS_MESSAGE);
  });

  it('allows same-key and superset updates (the /v1 set and update, the CLI control Secret)', () => {
    expect(both({ username: developer, oldKeys: ['value'], newKeys: ['value'] })).toBeUndefined();
    expect(
      both({ username: developer, name: 'web-control', oldKeys: ['a', 'b'], newKeys: ['b', 'a'] }),
    ).toBeUndefined();
    expect(both({ username: developer, oldKeys: ['a'], newKeys: ['a', 'b'] })).toBeUndefined();
    expect(both({ username: developer, newKeys: ['a'] })).toBeUndefined();
    expect(both({ username: developer })).toBeUndefined();
  });

  it('leaves the platform and tenant controllers unaffected', () => {
    for (const username of [controller, tenantController]) {
      expect(
        both({ username, name: 'di-bs-cache', oldKeys: ['a'], newKeys: ['a'] }),
      ).toBeUndefined();
      expect(both({ username, oldKeys: ['a', 'b'], newKeys: [] })).toBeUndefined();
    }
  });
});
