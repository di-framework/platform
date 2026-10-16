import { describe, expect, it } from 'bun:test';
import * as pulumi from '@pulumi/pulumi';
import type { DeletionPolicy } from '../src/tenancy/backing-services';
import { assertTenantDeclaration, tenantObject } from '../src/tenancy/install';
import {
  type LiveTenant,
  removalWarnings,
  tenantListerFromKubeconfig,
  warnRemovedTenants,
} from '../src/tenancy/removal';
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

describe('Tenant spec.deletionPolicy', () => {
  it('defaults to Retain in the CRD schema', () => {
    const tenantCrd = crds.find(
      (c) => (c.spec as { names: { kind: string } }).names.kind === 'Tenant',
    ) as unknown as {
      spec: {
        versions: {
          schema: {
            openAPIV3Schema: {
              properties: {
                spec: { properties: Record<string, unknown> };
              };
            };
          };
        }[];
      };
    };
    const spec = tenantCrd.spec.versions[0]?.schema.openAPIV3Schema.properties.spec.properties;
    expect(spec?.deletionPolicy).toEqual({
      type: 'string',
      enum: ['Retain', 'Delete'],
      default: 'Retain',
    });
  });

  it('validates the Pulumi tenants config values', () => {
    for (const value of ['Retain' as const, 'Delete' as const, undefined])
      expect(() => assertTenantDeclaration({ name: 'a', deletionPolicy: value })).not.toThrow();
    expect(() => assertTenantDeclaration({ name: 'a' })).not.toThrow();
    for (const value of ['retain', 'delete', 'KeepData', ''] as const)
      expect(() =>
        assertTenantDeclaration({ name: 'a', deletionPolicy: value as unknown as 'Retain' }),
      ).toThrow("Tenant a deletionPolicy must be 'Retain' or 'Delete'");
  });

  it('maps a Pulumi tenants entry with deletionPolicy to the Tenant CR spec', () => {
    expect(tenantObject({ name: 'alpha', deletionPolicy: 'Delete' }, 'inst')).toEqual({
      apiVersion: VERSION,
      kind: 'Tenant',
      metadata: {
        name: 'alpha',
        labels: { [INSTALLATION]: 'inst' },
        annotations: { 'pulumi.com/waitFor': 'condition=Ready' },
      },
      spec: { deletionPolicy: 'Delete' },
    });
  });
});

describe('Retain removal warning (#228)', () => {
  const live = (name: string, deletionPolicy?: DeletionPolicy): LiveTenant => ({
    metadata: { name },
    spec: deletionPolicy ? { deletionPolicy } : {},
  });
  it('names both kept namespaces and how to remove them for Retain', () => {
    const [message] = removalWarnings([live('alpha', 'Retain')], []);
    expect(message).toContain('di-tenant-alpha');
    expect(message).toContain('di-runtime-alpha');
    expect(message).toContain(
      'kubectl delete namespace di-tenant-alpha di-runtime-alpha di-apikeys-alpha.',
    );
  });
  it('prints nothing for Delete and for tenants that are still declared', () => {
    expect(removalWarnings([live('alpha', 'Delete'), live('beta', 'Retain')], ['beta'])).toEqual(
      [],
    );
  });
  it('treats a missing policy as Retain', () => {
    expect(removalWarnings([{ metadata: { name: 'alpha' } }], [])).toHaveLength(1);
    expect(removalWarnings([live('alpha')], [])).toHaveLength(1);
  });
  it('takes the live policy, not the declaration', async () => {
    const warned: string[] = [];
    await warnRemovedTenants({
      installation: 'inst',
      declared: [],
      list: async (installation) => {
        expect(installation).toBe('inst');
        return [live('alpha', 'Retain'), live('beta', 'Delete')];
      },
      warn: (m) => warned.push(m),
    });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('di-tenant-alpha');
  });
  it('warns during preview too, and never fails when the cluster cannot be read', async () => {
    const prior = pulumi.runtime.isDryRun;
    const debugged: string[] = [];
    try {
      (pulumi.runtime as { isDryRun: () => boolean }).isDryRun = () => true;
      expect(
        await warnRemovedTenants({
          installation: 'inst',
          declared: [],
          list: async () => [live('alpha')],
          warn: () => {},
        }),
      ).toHaveLength(1);
    } finally {
      (pulumi.runtime as { isDryRun: () => boolean }).isDryRun = prior;
    }
    expect(
      await warnRemovedTenants({
        installation: 'inst',
        declared: [],
        list: async () => {
          throw new Error('no CRD');
        },
        warn: () => {},
        debug: (m) => debugged.push(m),
      }),
    ).toEqual([]);
    expect(debugged[0]).toContain('no CRD');
  });
  it("lists the installation's Tenants from the provider kubeconfig", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname + new URL(request.url).search);
        return Response.json({ items: [live('alpha', 'Retain')] });
      },
    });
    try {
      const kubeconfig = JSON.stringify({
        apiVersion: 'v1',
        kind: 'Config',
        clusters: [
          {
            name: 'c',
            cluster: {
              server: `http://127.0.0.1:${server.port}`,
              'insecure-skip-tls-verify': true,
            },
          },
        ],
        users: [{ name: 'u', user: { token: 't' } }],
        contexts: [{ name: 'x', context: { cluster: 'c', user: 'u' } }],
        'current-context': 'x',
      });
      const tenants = await tenantListerFromKubeconfig(kubeconfig, 'x')('inst');
      expect(tenants.map((t) => t.metadata.name)).toEqual(['alpha']);
      expect(requests[0]).toContain('/apis/platform.di-framework.dev/v1alpha1/tenants');
      expect(decodeURIComponent(requests[0] ?? '')).toContain(
        'platform.di-framework.dev/installation=inst',
      );
    } finally {
      server.stop(true);
    }
  });
});
