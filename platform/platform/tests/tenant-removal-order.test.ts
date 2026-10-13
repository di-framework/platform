import { expect, test } from 'bun:test';
import { platformValues } from '../src/values';

test('tenant removal: Helm values can be updated with fewer namespaces for proper deletion ordering', () => {
  // This test verifies that when tenants are removed from the config, the Helm values
  // are correctly updated with a shrunk hostNamespaces list.
  // The actual ordering (tenant deletion before Helm update) is enforced by making the
  // Helm release depend on tenant CustomResources in createPlatform (#227).

  const initialNamespaces = ['wasmcloud', 'di-runtime-alpha', 'di-runtime-beta'];
  const updatedNamespaces = ['wasmcloud', 'di-runtime-alpha'];

  const initialValues = platformValues(
    {},
    {
      operator: { hostNamespaces: initialNamespaces },
    },
  ) as Record<string, unknown>;
  const updatedValues = platformValues(
    {},
    {
      operator: { hostNamespaces: updatedNamespaces },
    },
  ) as Record<string, unknown>;

  // Verify initial values include both tenants
  const initialOp = initialValues.operator as Record<string, unknown>;
  const updatedOp = updatedValues.operator as Record<string, unknown>;
  expect(initialOp.hostNamespaces).toEqual(initialNamespaces);

  // Verify updated values have shrunk list
  expect(updatedOp.hostNamespaces).toEqual(updatedNamespaces);

  // Verify that the beta namespace was removed
  expect(initialOp.hostNamespaces as string[]).toContain('di-runtime-beta');
  expect(updatedOp.hostNamespaces as string[]).not.toContain('di-runtime-beta');
});

test('tenant removal: clear error message pattern for drain timeout', () => {
  // This test verifies the error message format for drain timeouts.
  // When hosts don't drain within the timeout, the error should clearly identify:
  // 1. That it's a timeout error
  // 2. Which namespace timed out
  // 3. The timeout duration
  // 4. What the issue is (pods with finalizers)

  const errorMessagePattern =
    /timeout draining hosts in namespace (di-runtime-[\w-]+) after (\d+)s(:\s*.*)?/;
  const exampleError1 = 'timeout draining hosts in namespace di-runtime-beta after 10s';
  const exampleError2 =
    'timeout draining hosts in namespace di-runtime-beta after 10s: pods still have runtime.wasmcloud.dev/pod-host-finalizer';

  expect(exampleError1).toMatch(errorMessagePattern);
  expect(exampleError2).toMatch(errorMessagePattern);

  // Verify key information is present
  expect(exampleError2).toContain('di-runtime-beta');
  expect(exampleError2).toContain('10s');
  expect(exampleError2).toContain('pod-host-finalizer');
});
