import { describe, expect, it } from 'bun:test';
import { evaluate } from '@marcbachmann/cel-js';
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

  it('admits the identity guest shape: no env label, secretFrom identity-control', () => {
    expect(
      workloadEnvironmentReferencesAllowed({
        controllerNamespace: 'wasmcloud',
        workloadName: 'identity',
        username: tenantUser,
        locals: [{ environment: { secretFrom: [{ name: 'identity-control' }] } }],
      }),
    ).toBe(true);
  });

  it('denies managed Secrets as imagePullSecret', () => {
    const check = (imagePullSecrets: string[], username = tenantUser) =>
      workloadEnvironmentReferencesAllowed({ ...base, username, locals: [], imagePullSecrets });
    expect(check(['registry-creds'])).toBe(true);
    expect(check(['di-binding-db-creds'])).toBe(false);
    expect(check(['ok', 'di-bs-cache'])).toBe(false);
    expect(check(['di-bs-cache'], controllerUser)).toBe(true);
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

/** Evaluates the policy's real CEL against the TS mirror over a generated case matrix. */
describe('CEL parity with workloadEnvironmentReferencesAllowed (#88)', () => {
  const policy = admissionResources('test', 'wasmcloud').find(
    (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === 'test-workloads',
  ) as Resource;
  const spec = policy.spec as {
    variables: { name: string; expression: string }[];
    validations: { expression: string; message: string }[];
  };
  const rules = spec.validations.filter(
    (v) => v.message.includes('di-vars-<env>') || v.message.includes('imagePullSecret'),
  );
  const neededVariables = ['w', 'controller', 'env', 'locals', 'pullSecrets'];

  const celAllowed = (request: unknown, object: unknown): boolean => {
    const variables: Record<string, unknown> = {};
    for (const name of neededVariables) {
      const expression = spec.variables.find((v) => v.name === name)?.expression as string;
      variables[name] = evaluate(expression, { request, object, variables });
    }
    return rules.every(
      (rule) => evaluate(rule.expression, { request, object, variables }) === true,
    );
  };

  it('finds both rules', () => expect(rules).toHaveLength(2));

  const labelStates: (Record<string, string> | null)[] = [
    null,
    {},
    { other: 'x' },
    { [ENV_LABEL]: 'prod' },
    { [ENV_LABEL]: 'staging' },
    { [ENV_LABEL]: 'dev' },
    { [ENV_LABEL]: '' },
  ];
  const workloadNames = ['greeter-prod', 'identity', 'di-bs-x'];
  const users = [tenantUser, controllerUser];
  const configNames = [undefined, 'di-vars-prod', 'di-vars-staging', 'di-tenant-stock'];
  const secretNames = [
    undefined,
    'db-password.prod',
    'db-password.staging',
    'db-password',
    'Db.prod',
    '1db.prod',
    `${'a'.repeat(64)}.prod`,
    'di-binding-x.prod',
    'di-bs-x',
    'greeter-prod-control',
    'identity-control',
    'di-bs-x-control',
    'other-control',
  ];
  const pullNames = [undefined, 'registry', 'di-binding-x', 'di-bs-y'];
  const paths = ['component', 'service'] as const;

  it('agrees on every case', () => {
    let cases = 0;
    for (const labels of labelStates)
      for (const name of workloadNames)
        for (const username of users)
          for (const path of paths)
            for (const configName of configNames)
              for (const secretName of secretNames)
                for (const pullName of pullNames) {
                  const local = {
                    environment: {
                      ...(configName ? { configFrom: [{ name: configName }] } : {}),
                      ...(secretName ? { secretFrom: [{ name: secretName }] } : {}),
                    },
                  };
                  const pull = pullName ? { imagePullSecret: { name: pullName } } : {};
                  const holder = { ...pull, localResources: local };
                  const object = {
                    metadata: { name, ...(labels ? { labels } : {}) },
                    spec: {
                      template: {
                        spec: path === 'component' ? { components: [holder] } : { service: holder },
                      },
                    },
                  };
                  const expected = workloadEnvironmentReferencesAllowed({
                    ...base,
                    workloadName: name,
                    username,
                    labels: labels ?? undefined,
                    locals: [local],
                    imagePullSecrets: pullName ? [pullName] : [],
                  });
                  const actual = celAllowed(
                    { userInfo: { username }, operation: 'CREATE' },
                    object,
                  );
                  if (actual !== expected)
                    throw new Error(
                      `CEL ${actual} vs TS ${expected}: ${JSON.stringify({ labels, name, username, path, configName, secretName, pullName })}`,
                    );
                  cases++;
                }
    expect(cases).toBeGreaterThan(5000);
  });
});
