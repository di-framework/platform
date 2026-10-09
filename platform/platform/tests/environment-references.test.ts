import { describe, expect, it } from 'bun:test';
import {
  admissionResources,
  ENV_LABEL,
  workloadEnvironmentReferencesAllowed,
} from '../src/tenancy/admission';
import type { Resource } from '../src/tenancy/resources';

const tenantUser = 'system:serviceaccount:wasmcloud:di-user-dev';
const controllerUser = 'system:serviceaccount:wasmcloud:di-platform-controller';
const base = { controllerNamespace: 'wasmcloud', workloadName: 'greeter-prod' };
const prod = { [ENV_LABEL]: 'prod' };

const env = (configFrom: string[] = [], secretFrom: string[] = []) => ({
  environment: {
    configFrom: configFrom.map((name) => ({ name })),
    secretFrom: secretFrom.map((name) => ({ name })),
  },
});

const allowed = (
  locals: Parameters<typeof workloadEnvironmentReferencesAllowed>[0]['locals'],
  labels: Record<string, string> | null = prod,
  username = tenantUser,
) =>
  workloadEnvironmentReferencesAllowed({ ...base, username, labels: labels ?? undefined, locals });

describe('workload environment references (#88)', () => {
  it('admits the env vars ConfigMap and tenant secrets of the labelled env', () => {
    expect(allowed([env(['di-vars-prod'], ['db-password.prod', 'a.prod'])])).toBe(true);
    expect(
      allowed([env(['di-vars-staging'], ['api-key.staging'])], { [ENV_LABEL]: 'staging' }),
    ).toBe(true);
    expect(allowed([{}, { environment: {} }, { environment: { config: { A: '1' } } }])).toBe(true);
  });

  it('denies managed Secrets on any path, with or without the env suffix', () => {
    for (const name of [
      'di-binding-db-creds',
      'di-bs-cache',
      'di-binding-db-creds.prod',
      'di-bs-cache.prod',
    ]) {
      // First entry stands for a component, the second for the service (localsOf order).
      expect(allowed([env([], [name])])).toBe(false);
      expect(allowed([{}, env([], [name])])).toBe(false);
    }
    expect(
      workloadEnvironmentReferencesAllowed({
        ...base,
        workloadName: 'di-bs-x',
        username: tenantUser,
        locals: [env([], ['di-bs-x-control'])],
      }),
    ).toBe(false);
  });

  it('requires references to match the env label', () => {
    expect(allowed([env(['di-vars-staging'])])).toBe(false);
    expect(allowed([env([], ['db-password.staging'])])).toBe(false);
    expect(allowed([env(['di-tenant-stock'])])).toBe(false);
    expect(allowed([env([], ['db-password'])])).toBe(false);
    expect(allowed([env([], ['Db.prod'])])).toBe(false);
    expect(allowed([env([], ['1db.prod'])])).toBe(false);
    expect(allowed([env([], ['db-.prod'])])).toBe(false);
    expect(allowed([env([], [`${'a'.repeat(64)}.prod`])])).toBe(false);
    for (const labels of [null, {}, { [ENV_LABEL]: 'dev' }] as (Record<string, string> | null)[]) {
      expect(allowed([env(['di-vars-prod'])], labels)).toBe(false);
      expect(allowed([env([], ['db-password.prod'])], labels)).toBe(false);
      expect(allowed([{}], labels)).toBe(true);
    }
  });

  it('keeps the cli-plugin-platform control Secret allowed without an env label', () => {
    expect(allowed([env([], ['greeter-prod-control'])], null)).toBe(true);
    expect(allowed([env([], ['other-control'])], null)).toBe(false);
  });

  it('exempts the platform controller', () => {
    expect(allowed([env(['di-vars-x'], ['di-binding-db-creds'])], null, controllerUser)).toBe(true);
  });

  it('expresses the same rules in CEL', () => {
    const policy = admissionResources('test', 'wasmcloud').find(
      (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === 'test-workloads',
    ) as Resource;
    const spec = policy.spec as {
      variables: { name: string; expression: string }[];
      validations: { expression: string; message: string }[];
    };
    const envVar = spec.variables.find((v) => v.name === 'env')?.expression;
    expect(envVar).toContain(`object.metadata.labels['${ENV_LABEL}'] in ['prod','staging']`);
    expect(envVar).toContain(": ''");
    const locals = spec.variables.find((v) => v.name === 'locals')?.expression;
    expect(locals).toContain('variables.w.components.filter(c, has(c.localResources))');
    expect(locals).toContain('variables.w.service.localResources');
    const rule = spec.validations.find((v) => v.message.includes('di-vars-<env>'))?.expression;
    expect(rule).toStartWith('variables.controller || variables.locals.all(l,');
    expect(rule).toContain("variables.env != '' && c.name == 'di-vars-' + variables.env");
    expect(rule).toContain("!s.name.startsWith('di-binding-') && !s.name.startsWith('di-bs-')");
    expect(rule).toContain("s.name == object.metadata.name + '-control'");
    expect(rule).toContain("s.name.endsWith('.' + variables.env)");
    expect(rule).toContain("s.name.matches('^[a-z]([-a-z0-9]{0,61}[a-z0-9])?[.](prod|staging)$')");
  });
});
