import { describe, expect, it } from 'bun:test';
import { assertTenantDeclaration, tenantObject } from '../src/tenancy/install';
import {
  CORE_INSTANCES,
  type ControllerConfig,
  crds,
  INSTALLATION,
  type Tenant,
  type TenantSpec,
  tenantResources,
  VERSION,
} from '../src/tenancy/resources';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  insecureRegistry: false,
};
type HostDeployment = {
  spec: {
    template: {
      spec: { containers: { name: string; env: { name: string; value?: string }[] }[] };
    };
  };
};
function tenant(spec: TenantSpec): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: { name: 'alpha', uid: 'alpha-uid', generation: 1 },
    spec,
  };
}
function coreInstances(spec: TenantSpec): string | undefined {
  const host = tenantResources(tenant(spec), cfg, { data: {} }).find(
    (r) => r.kind === 'Deployment' && r.metadata.name === 'hostgroup-tenant-alpha',
  ) as unknown as HostDeployment;
  return host.spec.template.spec.containers
    .find((c) => c.name === 'host')
    ?.env.find((e) => e.name === 'WASH_CORE_INSTANCES')?.value;
}

describe('Tenant spec.runtime.coreInstances', () => {
  it('renders WASH_CORE_INSTANCES=100 by default', () => {
    expect(coreInstances({})).toBe('100');
    expect(coreInstances({ runtime: { replicas: 1 } })).toBe('100');
  });

  it('renders a custom value', () => {
    expect(coreInstances({ runtime: { coreInstances: 300 } })).toBe('300');
  });

  it('bounds the CRD schema to an integer from 1 to 10000, default 100', () => {
    const tenantCrd = crds.find(
      (c) => (c.spec as { names: { kind: string } }).names.kind === 'Tenant',
    ) as unknown as {
      spec: {
        versions: {
          schema: {
            openAPIV3Schema: {
              properties: {
                spec: { properties: { runtime: { properties: Record<string, unknown> } } };
              };
            };
          };
        }[];
      };
    };
    const runtime =
      tenantCrd.spec.versions[0]?.schema.openAPIV3Schema.properties.spec.properties.runtime;
    expect(runtime?.properties.coreInstances).toEqual({
      type: 'integer',
      default: 100,
      minimum: 1,
      maximum: 10000,
    });
    expect(CORE_INSTANCES).toEqual({ default: 100, minimum: 1, maximum: 10000 });
  });

  it('validates the Pulumi tenants config bounds', () => {
    for (const value of [1, 300, 10000, undefined])
      expect(() =>
        assertTenantDeclaration({ name: 'a', runtime: { coreInstances: value } }),
      ).not.toThrow();
    expect(() => assertTenantDeclaration({ name: 'a' })).not.toThrow();
    for (const value of [0, 10001, 2.5, '300' as unknown as number])
      expect(() =>
        assertTenantDeclaration({ name: 'a', runtime: { coreInstances: value } }),
      ).toThrow('Tenant a runtime.coreInstances must be an integer from 1 to 10000');
  });

  it('maps a Pulumi tenants entry to the Tenant CR spec', () => {
    expect(tenantObject({ name: 'identity', runtime: { coreInstances: 300 } }, 'inst')).toEqual({
      apiVersion: VERSION,
      kind: 'Tenant',
      metadata: {
        name: 'identity',
        labels: { [INSTALLATION]: 'inst' },
        annotations: { 'pulumi.com/waitFor': 'condition=Ready' },
      },
      spec: { runtime: { coreInstances: 300 } },
    });
  });
});
