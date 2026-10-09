import type { DeployBundle } from '../../src/client/index.ts';

/**
 * A complete, valid deploy bundle as the CLI renders it: a WorkloadDeployment without namespace
 * or host selector, one binding to a backing service, and one secret name. Shared by the tenant
 * controller's deploy tests and di-framework/cli-extensions#53, so both sides agree on the shape.
 * Returns a fresh copy each time, so a test can change it freely.
 */
export function deployBundle(overrides: Partial<DeployBundle> = {}): DeployBundle {
  return {
    env: 'prod',
    service: 'web',
    component: {
      reference: 'registry.platform.svc/acme/web:1.0.0',
      digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    workload: {
      apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
      kind: 'WorkloadDeployment',
      spec: {
        replicas: 1,
        template: {
          spec: {
            components: [
              {
                name: 'web',
                image:
                  'registry.platform.svc/acme/web@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              },
            ],
            hostInterfaces: [
              { namespace: 'wasi', package: 'http', interfaces: ['incoming-handler'] },
              { namespace: 'wasi', package: 'logging', interfaces: ['logging'] },
            ],
          },
        },
      },
    },
    bindings: [{ name: 'cache', capability: 'keyvalue', serviceName: 'cache' }],
    secrets: ['API_TOKEN'],
    ...overrides,
  };
}
