import { describe, expect, it } from 'bun:test';
import { evaluate } from '@marcbachmann/cel-js';
import {
  admissionResources,
  ENV_LABEL,
  WORKLOAD_SECRET_SUFFIXES,
  workloadEnvironmentReferencesAllowed,
} from '../src/tenancy/admission';
import type { Resource } from '../src/tenancy/resources';

const tenantUser = 'system:serviceaccount:wasmcloud:di-user-dev';
const controllerUser = 'system:serviceaccount:wasmcloud:di-platform-controller';

const policy = admissionResources('test', 'wasmcloud').find(
  (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === 'test-workloads',
) as Resource;
const spec = policy.spec as {
  variables: { name: string; expression: string }[];
  validations: { expression: string; message: string }[];
};
const rule = spec.validations.find((v) => v.message.includes('di-vars-<env>')) as {
  expression: string;
};
const neededVariables = ['w', 'controller', 'env', 'locals'];

interface Case {
  workloadName: string;
  secretFrom: string[];
  labels?: Record<string, string>;
  path?: 'component' | 'service';
  username?: string;
}

const tsAllowed = ({ workloadName, secretFrom, labels, username = tenantUser }: Case) =>
  workloadEnvironmentReferencesAllowed({
    controllerNamespace: 'wasmcloud',
    workloadName,
    username,
    labels,
    locals: [{ environment: { secretFrom: secretFrom.map((name) => ({ name })) } }],
  });

const celAllowed = ({
  workloadName,
  secretFrom,
  labels,
  path = 'component',
  username = tenantUser,
}: Case): boolean => {
  const holder = {
    localResources: { environment: { secretFrom: secretFrom.map((name) => ({ name })) } },
  };
  const object = {
    metadata: { name: workloadName, ...(labels ? { labels } : {}) },
    spec: {
      template: { spec: path === 'component' ? { components: [holder] } : { service: holder } },
    },
  };
  const request = { userInfo: { username }, operation: 'CREATE' };
  const variables: Record<string, unknown> = {};
  for (const name of neededVariables) {
    const expression = spec.variables.find((v) => v.name === name)?.expression as string;
    variables[name] = evaluate(expression, { request, object, variables });
  }
  return evaluate(rule.expression, { request, object, variables }) === true;
};

/** Asserts the TS mirror and the policy's real CEL (component and service paths) agree on `want`. */
const expectAllowed = (input: Case, want: boolean) => {
  expect(tsAllowed(input)).toBe(want);
  expect(celAllowed({ ...input, path: 'component' })).toBe(want);
  expect(celAllowed({ ...input, path: 'service' })).toBe(want);
};

describe('<workload>-secrets as a second secretFrom (#203)', () => {
  it('lists exactly the control and app Secret suffixes', () => {
    expect([...WORKLOAD_SECRET_SUFFIXES]).toEqual(['-control', '-secrets']);
  });

  it('admits <workload>-control and <workload>-secrets together without an env label', () => {
    expectAllowed(
      { workloadName: 'identity', secretFrom: ['identity-control', 'identity-secrets'] },
      true,
    );
    expectAllowed({ workloadName: 'identity', secretFrom: ['identity-secrets'] }, true);
  });

  it('admits them alongside env Secrets on a labelled workload', () => {
    expectAllowed(
      {
        workloadName: 'greeter-prod',
        labels: { [ENV_LABEL]: 'prod' },
        secretFrom: ['greeter-prod-control', 'greeter-prod-secrets', 'db-password.prod'],
      },
      true,
    );
  });

  it("denies another workload's -secrets Secret", () => {
    expectAllowed({ workloadName: 'identity', secretFrom: ['other-secrets'] }, false);
    expectAllowed(
      { workloadName: 'identity', secretFrom: ['identity-control', 'greeter-secrets'] },
      false,
    );
    expectAllowed(
      {
        workloadName: 'greeter-prod',
        labels: { [ENV_LABEL]: 'prod' },
        secretFrom: ['greeter-secrets'],
      },
      false,
    );
  });

  it('allows no other name derived from the workload (no wildcard)', () => {
    for (const name of [
      'identity-secret',
      'identity-secrets-2',
      'identity-secretsx',
      'identity-secrets.prod',
      'identity-other',
      'identitysecrets',
      'secrets',
      '-secrets',
      'xidentity-secrets',
      'IDENTITY-secrets',
    ])
      expectAllowed({ workloadName: 'identity', secretFrom: [name] }, false);
  });

  it('still denies managed workload names', () => {
    expectAllowed({ workloadName: 'di-bs-x', secretFrom: ['di-bs-x-secrets'] }, false);
    expectAllowed({ workloadName: 'di-binding-x', secretFrom: ['di-binding-x-secrets'] }, false);
  });

  it('keeps the platform controller exempt', () => {
    expectAllowed(
      { workloadName: 'identity', secretFrom: ['di-bs-x-secrets'], username: controllerUser },
      true,
    );
  });

  it('agrees between CEL and TS across a case matrix', () => {
    const workloadNames = ['identity', 'greeter-prod', 'di-bs-x', 'a'];
    const labelStates = [undefined, { [ENV_LABEL]: 'prod' }, { [ENV_LABEL]: 'staging' }];
    const suffixes = ['-control', '-secrets', '-secret', '-secrets-x', '.prod', '-other'];
    let cases = 0;
    for (const workloadName of workloadNames)
      for (const labels of labelStates)
        for (const owner of workloadNames)
          for (const suffix of suffixes)
            for (const path of ['component', 'service'] as const) {
              const input: Case = { workloadName, labels, path, secretFrom: [`${owner}${suffix}`] };
              const expected = tsAllowed(input);
              const actual = celAllowed(input);
              if (actual !== expected)
                throw new Error(`CEL ${actual} vs TS ${expected}: ${JSON.stringify(input)}`);
              cases++;
            }
    expect(cases).toBe(4 * 3 * 4 * 6 * 2);
  });
});
