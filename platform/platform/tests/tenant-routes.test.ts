import { describe, expect, it } from 'bun:test';
import { admissionResources } from '../src/tenancy/admission';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  type ControllerConfig,
  GATEWAY_POD_LABELS,
  INSTALLATION,
  OWNER,
  type Resource,
  ROUTES_CONFIG_NAME,
  type Tenant,
  tenantResources,
  VERSION,
} from '../src/tenancy/resources';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  insecureRegistry: true,
};
const routed: ControllerConfig = {
  ...cfg,
  routeUrlPattern: 'http://{host}.{tenant}.localhost:28180',
};
const ready = [
  {
    type: 'Ready' as const,
    status: 'True' as const,
    observedGeneration: 1,
    reason: 'Reconciled',
    message: '',
    lastTransitionTime: '2026-01-01T00:00:00Z',
  },
];
function tenant(name = 'alpha'): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: { name, uid: `${name}-uid`, generation: 1, labels: { [INSTALLATION]: 'test' } },
    spec: {},
    status: { conditions: ready },
  };
}
const routesPath = `${collection('v1', 'ConfigMap', 'di-tenant-alpha')}/${ROUTES_CONFIG_NAME}`;

/** Path-keyed object store: enough of the API for a tenant reconcile. */
class MemoryApi implements Api {
  objects = new Map<string, Resource>([
    [`${collection(VERSION, 'Tenant')}/alpha`, tenant() as unknown as Resource],
    [
      `${collection('v1', 'Secret', 'wasmcloud')}/wasmcloud-runtime-tls`,
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'wasmcloud-runtime-tls', namespace: 'wasmcloud' },
        data: {},
      },
    ],
  ]);
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, 'https://kubernetes');
    if (url.searchParams.has('labelSelector')) return { items: [] } as T;
    const target = url.pathname.replace(/\/status$/, '');
    const existing = this.objects.get(target);
    if (method === 'GET') {
      if (!existing) throw new ApiError(404, 'Not found');
      return structuredClone(existing) as T;
    }
    if (method === 'DELETE') {
      this.objects.delete(target);
      return {} as T;
    }
    const data = structuredClone(body) as Resource;
    const value = {
      ...existing,
      ...data,
      metadata: { ...existing?.metadata, ...data.metadata },
    } as Resource;
    if (value.kind === 'Deployment')
      value.status = {
        observedGeneration: value.metadata.generation,
        readyReplicas: (value.spec as { replicas: number }).replicas,
      };
    this.objects.set(target, value);
    return structuredClone(value) as T;
  }
}

describe('tenant HTTP routes', () => {
  it('admits only the platform gateway pods to the tenant hosts on 9191', () => {
    const policy = tenantResources(tenant(), cfg).find(
      (r) => r.kind === 'NetworkPolicy' && r.metadata.name === 'di-tenant-gateway',
    );
    expect(policy?.metadata.namespace).toBe('di-runtime-alpha');
    expect(policy?.spec).toEqual({
      podSelector: {
        matchLabels: {
          'wasmcloud.com/hostgroup': 'tenant-alpha',
          'wasmcloud.com/name': 'hostgroup',
        },
      },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'wasmcloud' } },
              podSelector: { matchLabels: GATEWAY_POD_LABELS },
            },
          ],
          ports: [{ protocol: 'TCP', port: 9191 }],
        },
      ],
    });
    // The broad tenant policy still admits only the tenant's own namespaces.
    const network = tenantResources(tenant(), cfg).filter(
      (r) => r.metadata.name === 'di-tenant-network',
    );
    expect(JSON.stringify(network)).not.toContain(GATEWAY_POD_LABELS.app);
  });

  it('publishes the URL template with the tenant filled in, only when a gateway is known', () => {
    expect(tenantResources(tenant(), cfg).some((r) => r.metadata.name === ROUTES_CONFIG_NAME)).toBe(
      false,
    );
    const routes = tenantResources(tenant('mesh-tastic'), routed).find(
      (r) => r.metadata.name === ROUTES_CONFIG_NAME,
    );
    expect(routes).toMatchObject({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { namespace: 'di-tenant-mesh-tastic' },
      data: { urlTemplate: 'http://{host}.mesh-tastic.localhost:28180' },
    });
  });

  it('lets tenant viewers and developers read the template but not write it', () => {
    const roles = tenantResources(tenant(), routed).filter(
      (r) => r.kind === 'Role' && r.metadata.namespace === 'di-tenant-alpha',
    );
    for (const name of ['di-viewer', 'di-developer']) {
      const rules = roles.find((r) => r.metadata.name === name)?.rules as {
        apiGroups: string[];
        resources: string[];
        verbs: string[];
      }[];
      expect(
        rules.some(
          (r) =>
            r.apiGroups.includes('') &&
            r.resources.includes('configmaps') &&
            r.verbs.includes('get'),
        ),
      ).toBe(true);
    }
    const reserved = admissionResources('test', 'wasmcloud').find(
      (r) => r.metadata.name === 'test-backend-config',
    );
    expect(JSON.stringify(reserved)).toContain(`== '${ROUTES_CONFIG_NAME}'`);
  });

  it('writes the template on reconcile and removes it once no gateway is known', async () => {
    const api = new MemoryApi();
    const t = tenant();
    await new Controller(api, routed).reconcileTenant(t);
    expect(api.objects.get(routesPath)?.data).toEqual({
      urlTemplate: 'http://{host}.alpha.localhost:28180',
    });
    await new Controller(api, cfg).reconcileTenant(t);
    expect(api.objects.has(routesPath)).toBe(false);
    // Nothing to remove is not an error.
    await new Controller(api, cfg).reconcileTenant(t);
  });

  it('leaves a ConfigMap it does not own in place', async () => {
    const api = new MemoryApi();
    const foreign: Resource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: ROUTES_CONFIG_NAME,
        namespace: 'di-tenant-alpha',
        labels: { [INSTALLATION]: 'test', [OWNER]: 'someone-else' },
      },
    };
    api.objects.set(routesPath, foreign);
    await new Controller(api, cfg).reconcileTenant(tenant());
    expect(api.objects.get(routesPath)).toEqual(foreign);
    api.objects.set(routesPath, { ...foreign, metadata: { ...foreign.metadata, labels: {} } });
    await new Controller(api, cfg).reconcileTenant(tenant());
    expect(api.objects.has(routesPath)).toBe(true);
  });
});
