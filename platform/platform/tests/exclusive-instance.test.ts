import { describe, expect, it } from 'bun:test';
import { evaluate } from '@marcbachmann/cel-js';
import {
  admissionResources,
  EXCLUSIVE_INSTANCE_KEY,
  EXCLUSIVE_INSTANCE_MESSAGE,
  workloadExclusiveInstanceAllowed,
} from '../src/tenancy/admission';
import type { Resource } from '../src/tenancy/resources';
import {
  STORAGE_ANNOTATION,
  storagePatch,
  type WorkloadDeployment,
} from '../src/tenancy/workload-storage';

const exclusive = (value: unknown) => ({ config: { [EXCLUSIVE_INSTANCE_KEY]: value } });

describe('exclusive instance opt-in (#136)', () => {
  it('names the key the patched host reads', () => {
    expect(EXCLUSIVE_INSTANCE_KEY).toBe('di-framework.dev/exclusive-instance');
  });

  it('admits components that do not mention it, or say true or false', () => {
    expect(workloadExclusiveInstanceAllowed([])).toBe(true);
    expect(
      workloadExclusiveInstanceAllowed([{}, { config: {} }, { config: { LOG: 'debug' } }]),
    ).toBe(true);
    expect(workloadExclusiveInstanceAllowed([exclusive('true'), exclusive('false')])).toBe(true);
  });

  it('refuses a value the host would have to guess at', () => {
    for (const value of ['ture', 'True', 'yes', '1', '', ' true', true, 1, null]) {
      expect(workloadExclusiveInstanceAllowed([exclusive(value)])).toBe(false);
    }
    // One bad component refuses the workload, wherever it sits in the list.
    expect(workloadExclusiveInstanceAllowed([exclusive('true'), {}, exclusive('maybe')])).toBe(
      false,
    );
  });

  it('is not fooled by inherited properties', () => {
    const config = Object.create({ [EXCLUSIVE_INSTANCE_KEY]: 'junk' }) as Record<string, unknown>;
    expect(workloadExclusiveInstanceAllowed([{ config }])).toBe(true);
  });
});

/** Evaluates the policy's real CEL against the TS mirror over a generated case matrix. */
describe('CEL parity with workloadExclusiveInstanceAllowed (#136)', () => {
  const policy = admissionResources('test', 'wasmcloud').find(
    (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === 'test-workloads',
  ) as Resource;
  const spec = policy.spec as {
    variables: { name: string; expression: string }[];
    validations: { expression: string; message: string }[];
  };
  const rule = spec.validations.find((v) => v.message === EXCLUSIVE_INSTANCE_MESSAGE);

  const celAllowed = (object: unknown, request: unknown): boolean => {
    const variables: Record<string, unknown> = {};
    for (const name of ['w', 'controller', 'locals']) {
      const expression = spec.variables.find((v) => v.name === name)?.expression as string;
      variables[name] = evaluate(expression, { request, object, variables });
    }
    return (
      evaluate((rule as { expression: string }).expression, { request, object, variables }) === true
    );
  };

  it('is a validation of the workloads policy that applies to every user', () => {
    expect(rule).toBeDefined();
    expect(rule?.expression).not.toContain('variables.controller');
    expect(rule?.expression).toContain(`'${EXCLUSIVE_INSTANCE_KEY}' in l.config`);
    expect(rule?.expression).toContain("in ['true','false']");
  });

  it('agrees on every case', () => {
    const values: (string | undefined)[] = [
      undefined,
      'true',
      'false',
      'ture',
      'True',
      '',
      ' true',
      '1',
    ];
    const others: (Record<string, string> | undefined)[] = [undefined, {}, { LOG: 'debug' }];
    const paths = ['component', 'service'] as const;
    const users = [
      'system:serviceaccount:wasmcloud:di-user-dev',
      'system:serviceaccount:wasmcloud:di-platform-controller',
    ];
    let cases = 0;
    for (const value of values)
      for (const other of others)
        for (const path of paths)
          for (const username of users)
            for (const present of [true, false]) {
              const config =
                present || other
                  ? {
                      ...(other ?? {}),
                      ...(present && value !== undefined
                        ? { [EXCLUSIVE_INSTANCE_KEY]: value }
                        : {}),
                    }
                  : undefined;
              const local = config === undefined ? {} : { config };
              const holder = { localResources: local };
              const object = {
                metadata: { name: 'identity' },
                spec: {
                  template: {
                    spec: path === 'component' ? { components: [holder] } : { service: holder },
                  },
                },
              };
              const expected = workloadExclusiveInstanceAllowed([local]);
              const actual = celAllowed(object, { userInfo: { username }, operation: 'CREATE' });
              if (actual !== expected)
                throw new Error(
                  `CEL ${actual} vs TS ${expected}: ${JSON.stringify({ value, other, path, username, present })}`,
                );
              cases++;
            }
    expect(cases).toBeGreaterThan(100);
  });
});

describe('exclusive instance manifest pass-through (#136)', () => {
  const workload = (config: Record<string, string> | undefined): WorkloadDeployment => ({
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'WorkloadDeployment',
    metadata: {
      name: 'identity',
      namespace: 'di-tenant-alpha',
      annotations: { [STORAGE_ANNOTATION]: 'true' },
    },
    spec: {
      template: {
        spec: {
          components: [
            { name: 'pglite', localResources: { ...(config ? { config } : {}) } },
            { name: 'app', localResources: { config: { LOG: 'debug' } } },
          ],
        },
      },
    },
  });

  const patchedComponents = (config: Record<string, string> | undefined) => {
    const patch = storagePatch(workload(config)) as unknown as {
      spec: {
        template: { spec: { components: { localResources: Record<string, unknown> }[] } };
      };
    };
    return patch.spec.template.spec.components;
  };

  it('keeps a tenant-set opt-in when the controller patches in storage', () => {
    const components = patchedComponents({ [EXCLUSIVE_INSTANCE_KEY]: 'true' });

    expect(components[0]?.localResources.config).toEqual({ [EXCLUSIVE_INSTANCE_KEY]: 'true' });
    expect(components[0]?.localResources.volumeMounts).toEqual([
      { name: 'di-storage', mountPath: '/data' },
    ]);
    // Components that did not ask keep their own config, and gain nothing.
    expect(components[1]?.localResources.config).toEqual({ LOG: 'debug' });
  });

  it('adds no opt-in of its own', () => {
    expect(patchedComponents(undefined)[0]?.localResources.config).toBeUndefined();
  });
});
