import { describe, expect, it } from 'bun:test';
import { evaluate } from '@marcbachmann/cel-js';
import {
  SECRET_UPDATE_KEYS_MESSAGE,
  SECRET_UPDATE_MANAGED_MESSAGE,
  tenantSecretUpdateDenial,
} from '../src/tenancy/admission';
import {
  controller,
  developer,
  expectSecretPolicyMatch,
  loadPolicy,
  tenantController,
} from './support/cel-policy';

const policy = loadPolicy('tenant-secret-update');
const { spec } = policy;

interface Case {
  username: string;
  name?: string;
  oldKeys?: string[];
  newKeys?: string[];
  dryRun?: boolean;
}

const data = (keys?: string[]) =>
  keys === undefined ? {} : { data: Object.fromEntries(keys.map((key) => [key, 'eA=='])) };

/** The first failing CEL rule's message, or undefined when every rule passes. */
const celDenial = (c: Case) => {
  const metadata = { name: c.name ?? 'db.prod' };
  const oldObject = { metadata, ...data(c.oldKeys) };
  const object = { metadata, ...data(c.newKeys) };
  const request: Record<string, unknown> = {
    operation: 'UPDATE',
    userInfo: { username: c.username },
  };
  if (c.dryRun !== undefined) request.dryRun = c.dryRun;
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
    expectSecretPolicyMatch(policy, 'UPDATE');
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

  it('denies dry-run UPDATEs that drop keys (no dryRun exemption - CLI probes rely on it)', () => {
    // tenant-secret-update has NO dryRun exemption: the CLI's dry-run probes (cli-extensions#70)
    // rely on this policy denying dry-run requests that would drop a Secret key, to prove three
    // things without reading: every extra key in <workload>-control is declared, the CLI keys
    // are present, and the policy applies to this caller. If a dryRun exemption is added, the
    // probes pass silently and undeclared keys are "kept" without guard (#204).
    expect(both({ username: developer, dryRun: true, oldKeys: ['a', 'b'], newKeys: ['a'] })).toBe(
      SECRET_UPDATE_KEYS_MESSAGE,
    );
    expect(both({ username: developer, dryRun: true, oldKeys: ['a'], newKeys: ['b'] })).toBe(
      SECRET_UPDATE_KEYS_MESSAGE,
    );
  });

  it('allows dry-run UPDATEs that keep all keys', () => {
    // dryRun UPDATEs that keep all keys are allowed, just like real UPDATEs.
    expect(both({ username: developer, dryRun: true, oldKeys: ['a'], newKeys: ['a'] })).toBe(
      undefined,
    );
    expect(
      both({
        username: developer,
        dryRun: true,
        oldKeys: ['a', 'b'],
        newKeys: ['a', 'b'],
      }),
    ).toBe(undefined);
  });

  it('has no request.dryRun clause in its validations (no exemption)', () => {
    // Assert that the policy has no dryRun-related exclusions. The CLI's dry-run probes
    // (tenant-auth/README and cli-extensions#70) must receive the full admission check.
    for (const validation of spec.validations) {
      expect(validation.expression).not.toContain('request.dryRun');
      expect(validation.expression).not.toContain('dryRun');
    }
  });
});
