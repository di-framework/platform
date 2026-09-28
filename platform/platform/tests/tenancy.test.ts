import { describe, expect, it, spyOn } from 'bun:test';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  type ControllerConfig,
  FINALIZER,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  TENANT,
  type Tenant,
  tenantResources,
  type User,
  userResources,
  VERSION,
} from '../src/tenancy/resources';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  insecureRegistry: true,
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
function user(): User {
  return {
    apiVersion: VERSION,
    kind: 'User',
    metadata: {
      name: 'alice',
      uid: 'alice-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec: { memberships: [{ tenant: 'alpha', role: 'developer' }] },
  };
}
function key(value: Resource | Tenant | User): string {
  return `${collection(value.apiVersion, value.kind, value.metadata.namespace)}/${value.metadata.name}`;
}
class MemoryApi implements Api {
  objects = new Map<string, Resource>();
  operations: { method: string; path: string }[] = [];
  seed(value: Resource | Tenant | User): void {
    this.objects.set(key(value), structuredClone(value) as Resource);
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.operations.push({ method, path });
    const url = new URL(path, 'https://kubernetes');
    const data = structuredClone(body) as Resource;
    if (method === 'GET' && url.searchParams.has('labelSelector')) {
      const labels = url.searchParams
        .get('labelSelector')!
        .split(',')
        .map((v) => v.split('='));
      return {
        items: [...this.objects.values()]
          .filter(
            (v) =>
              collection(v.apiVersion, v.kind) === url.pathname &&
              labels.every(([k, x]) => v.metadata.labels?.[k!] === x),
          )
          .map(({ apiVersion: _version, kind: _kind, ...item }) => item),
      } as T;
    }
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
    if (method === 'PATCH') {
      const value = {
        ...existing,
        ...data,
        metadata: { ...existing?.metadata, ...data.metadata },
      } as Resource;
      value.metadata.uid ??= `${value.metadata.name}-created-uid`;
      value.metadata.generation ??= 1;
      if (value.kind === 'Deployment')
        value.status = {
          observedGeneration: 1,
          readyReplicas: (value.spec as { replicas: number }).replicas,
        };
      this.objects.set(target, value);
      return structuredClone(value) as T;
    }
    throw new Error(`Unexpected ${method}`);
  }
}
function prepare(): { api: MemoryApi; controller: Controller; t: Tenant; u: User } {
  const api = new MemoryApi();
  const t = tenant();
  const u = user();
  api.seed(t);
  api.seed(u);
  api.seed({
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'Host',
    metadata: { name: 'alpha-host', namespace: 'wasmcloud', labels: { hostgroup: 'tenant-alpha' } },
    environment: 'di-tenant-alpha',
    status: { conditions: ready },
  });
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'wasmcloud-runtime-tls', namespace: cfg.namespace },
    data: { 'ca.crt': 'test' },
  });
  return { api, controller: new Controller(api, cfg), t, u };
}

describe('tenant and user resource reconciliation', () => {
  it('polls both resource kinds and isolates reconciliation failures', async () => {
    const { api, controller, t, u } = prepare();
    api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: names('alpha').namespace } });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await controller.tick();
      expect(api.objects.get(key(t))?.status).toMatchObject({
        conditions: [expect.objectContaining({ reason: 'ReconcileError', status: 'False' })],
      });
      expect(api.objects.get(key(u))?.status).toBeDefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Refusing to adopt'));
    } finally {
      log.mockRestore();
    }
  });

  it('continues polling when reporting a reconciliation error also fails', async () => {
    const { controller } = prepare();
    const reconcile = spyOn(controller, 'reconcileTenant').mockRejectedValue('conflict');
    const log = spyOn(console, 'error').mockImplementation(() => {});
    // A failed status update must not prevent the user from being reconciled.
    const status = spyOn(
      controller as unknown as { status: () => Promise<void> },
      'status',
    ).mockRejectedValue(new Error('resourceVersion conflict'));
    const userReconcile = spyOn(controller, 'reconcileUser').mockResolvedValue();
    try {
      await controller.tick();
      expect(log).toHaveBeenCalledWith('Tenant/alpha: Reconciliation failed');
      expect(userReconcile).toHaveBeenCalledTimes(1);
    } finally {
      reconcile.mockRestore();
      status.mockRestore();
      userReconcile.mockRestore();
      log.mockRestore();
    }
  });

  it('separates runtime credentials and data backends from the workload namespace', () => {
    const resources = tenantResources(tenant(), cfg, { data: { 'tls.key': 'private' } });
    expect(
      resources
        .filter((r) => r.kind === 'Secret')
        .every((r) => r.metadata.namespace === 'di-runtime-alpha'),
    ).toBe(true);
    const host = resources.find(
      (r) => r.kind === 'Deployment' && r.metadata.name === 'hostgroup-tenant-alpha',
    )!;
    const text = JSON.stringify(host);
    expect(text).toContain('--environment=di-tenant-alpha');
    expect(text).toContain('--socket-egress=enforce');
    expect(text).toContain('nats://di-nats.di-runtime-alpha.svc.cluster.local:4222');
    const appRoles = resources.filter(
      (r) => r.kind === 'Role' && r.metadata.namespace === 'di-tenant-alpha',
    );
    expect(JSON.stringify(appRoles)).not.toContain('pods/exec');
    expect(JSON.stringify(appRoles)).not.toContain('rolebindings');
    expect(JSON.stringify(resources.filter((r) => r.kind === 'Deployment'))).toContain(
      '/var/lib/k0s/di-tenants/alpha-uid/',
    );
  });
  it('does not grant access to missing, suspended, or stale tenants', () => {
    const u = user();
    expect(userResources(u, [], cfg)).toHaveLength(1);
    const t = tenant();
    t.spec.suspended = true;
    expect(userResources(u, [t], cfg)).toHaveLength(1);
    t.spec.suspended = false;
    t.metadata.generation = 2;
    expect(userResources(u, [t], cfg)).toHaveLength(1);
    t.metadata.generation = 1;
    expect(userResources(u, [t], cfg)).toHaveLength(3);
  });
  it('only adopts namespaces explicitly seeded for this installation and tenant', async () => {
    const { api, controller, t } = prepare();
    api.seed({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: names('alpha').namespace,
        labels: { [INSTALLATION]: 'test', [TENANT]: 'alpha' },
      },
    });
    await controller.reconcileTenant(t);
    expect(api.objects.get('/api/v1/namespaces/di-tenant-alpha')?.metadata.labels?.[OWNER]).toBe(
      'alpha-uid',
    );
    expect(t.status?.conditions?.[0]?.status).toBe('True');
  });
  it('refuses to adopt a foreign namespace', async () => {
    const { api, controller, t } = prepare();
    api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: names('alpha').namespace } });
    await expect(controller.reconcileTenant(t)).rejects.toThrow('Refusing to adopt');
  });
  it('removes the immutable old role binding before a downgrade', async () => {
    const { api, controller, t, u } = prepare();
    await controller.reconcileUser(u, [t]);
    u.spec.memberships[0]!.role = 'viewer';
    api.seed(u);
    api.operations = [];
    await controller.reconcileUser(u, [t]);
    const bindingPath =
      '/apis/rbac.authorization.k8s.io/v1/namespaces/di-tenant-alpha/rolebindings/di-user-alice';
    const operations = api.operations
      .filter((o) => o.path.split('?')[0] === bindingPath)
      .map((o) => o.method);
    expect(operations).toEqual(['GET', 'DELETE', 'PATCH']);
    expect(api.objects.get(bindingPath)?.roleRef).toMatchObject({ name: 'di-viewer' });
  });
  it('revokes every binding before deleting the ServiceAccount on suspension', async () => {
    const { api, controller, t, u } = prepare();
    await controller.reconcileUser(u, [t]);
    u.spec.suspended = true;
    api.seed(u);
    api.operations = [];
    await controller.reconcileUser(u, [t]);
    const deletes = api.operations.filter((o) => o.method === 'DELETE');
    expect(deletes).toHaveLength(3);
    expect(deletes[2]!.path).toContain('/serviceaccounts/di-user-alice');
    expect(
      [...api.objects.values()].filter((r) => r.metadata.labels?.[OWNER] === u.metadata.uid),
    ).toHaveLength(0);
    expect(u.status?.serviceAccount).toBeNull();
  });
  it('removes memberships even when the referenced tenant no longer exists', async () => {
    const { api, controller, t, u } = prepare();
    await controller.reconcileUser(u, [t]);
    await controller.reconcileUser(u, []);
    expect([...api.objects.values()].filter((r) => r.kind === 'RoleBinding')).toHaveLength(0);
    expect(u.status?.conditions?.[0]?.reason).toBe('TenantNotReady');
  });
  it('retains namespaces and stops deployments when a tenant is deleted by default', async () => {
    const { api, controller, t, u } = prepare();
    await controller.reconcileTenant(t);
    await controller.reconcileUser(u, [t]);
    t.metadata.deletionTimestamp = new Date().toISOString();
    api.seed(t);
    await controller.reconcileTenant(t);
    expect(api.objects.has('/api/v1/namespaces/di-tenant-alpha')).toBe(true);
    expect(
      [...api.objects.values()]
        .filter((r) => r.kind === 'Deployment')
        .every((r) => (r.spec as { replicas: number }).replicas === 0),
    ).toBe(true);
    expect([...api.objects.values()].filter((r) => r.kind === 'RoleBinding')).toHaveLength(0);
    expect(t.metadata.finalizers).not.toContain(FINALIZER);
  });
  it('waits for both namespaces to disappear before completing Delete', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t);
    t.spec.deletionPolicy = 'Delete';
    t.metadata.deletionTimestamp = new Date().toISOString();
    api.seed(t);
    await controller.reconcileTenant(t);
    expect(t.metadata.finalizers).toContain(FINALIZER);
    await controller.reconcileTenant(t);
    expect(t.metadata.finalizers).not.toContain(FINALIZER);
  });
});
