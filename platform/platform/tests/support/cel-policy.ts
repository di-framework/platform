import { expect } from 'bun:test';
import { admissionResources } from '../../src/tenancy/admission';

export const developer = 'system:serviceaccount:wasmcloud:di-user-dev';
export const controller = 'system:serviceaccount:wasmcloud:di-platform-controller';
export const tenantController = 'system:serviceaccount:di-runtime-acme:tenant-controller';

export interface PolicySpec {
  matchConstraints: { resourceRules: { operations: string[]; resources: string[] }[] };
  validations: { expression: string; message: string }[];
}

/** The rendered ValidatingAdmissionPolicy spec and binding named `test-<suffix>`. */
export const loadPolicy = (suffix: string) => {
  const name = `test-${suffix}`;
  const resources = admissionResources('test', 'wasmcloud');
  const policy = resources.find(
    (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === name,
  );
  const binding = resources.find(
    (r) => r.kind === 'ValidatingAdmissionPolicyBinding' && r.metadata.name === name,
  );
  return { spec: policy?.spec as unknown as PolicySpec, binding };
};

/** Asserts the policy matches `operation` on Secrets and its binding denies in tenant namespaces. */
export const expectSecretPolicyMatch = (
  { spec, binding }: ReturnType<typeof loadPolicy>,
  operation: string,
) => {
  expect(spec.matchConstraints.resourceRules).toEqual([
    expect.objectContaining({ operations: [operation], resources: ['secrets'] }),
  ]);
  expect(JSON.stringify(binding?.spec)).toContain('"operator":"Exists"');
  expect(binding?.spec).toMatchObject({ validationActions: ['Deny'] });
};
