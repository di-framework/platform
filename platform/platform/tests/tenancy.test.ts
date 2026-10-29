import { describe, expect, it, spyOn } from 'bun:test';
import {
  type Api,
  ApiError,
  Controller,
  collection,
  PLACEMENT_RETRY,
  summarizeConflict,
} from '../src/tenancy/controller';
import {
  type ControllerConfig,
  FINALIZER,
  INSTALLATION,
  NAMESPACE_ROLE,
  names,
  OWNER,
  type Resource,
  TENANT,
  type Tenant,
  tenantResources,
  USER,
  type User,
  userResources,
  userTokenSecretName,
  VERSION,
} from '../src/tenancy/resources';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
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
              (collection(v.apiVersion, v.kind) === url.pathname ||
                collection(v.apiVersion, v.kind, v.metadata.namespace) === url.pathname) &&
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
/** A host pod of `tenant` in its runtime namespace, as the hostgroup Deployment labels it. */
function hostPod(
  name: string,
  tenant: string,
  options: { terminating?: boolean; phase?: string } = {},
): Resource {
  const n = names(tenant);
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: n.runtimeNamespace,
      ...(options.terminating
        ? {
            deletionTimestamp: '2026-01-01T00:00:00Z',
            finalizers: ['runtime.wasmcloud.dev/pod-host-finalizer'],
          }
        : {}),
      labels: { 'wasmcloud.com/hostgroup': n.hostgroup, 'wasmcloud.com/name': 'hostgroup' },
    },
    ...(options.phase ? { status: { phase: options.phase } } : {}),
  };
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

  it('names conflicting managers and fields when the hostgroup Deployment patch conflicts', async () => {
    const { api, controller, t } = prepare();
    const causes = Array.from({ length: 60 }, (_, i) => ({
      reason: 'FieldManagerConflict',
      message: `conflict with "manager-${i}" using apps/v1`,
      field: `.spec.template.spec.containers[name="host"].env[name="VAR_${i}"].value`,
    }));
    const summary = summarizeConflict(
      JSON.stringify({
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        reason: 'Conflict',
        message: 'Apply failed with 60 conflicts',
        details: { name: 'hostgroup-tenant-alpha', group: 'apps', kind: 'deployments', causes },
        code: 409,
      }),
    );
    const call = api.call.bind(api);
    spyOn(api, 'call').mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === 'PATCH' && /\/deployments\/hostgroup-/.test(path))
        throw new ApiError(409, `PATCH ${path} returned 409: ${summary}`);
      return call(method, path, body);
    });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await controller.tick();
      const status = api.objects.get(key(t))?.status as {
        conditions: { reason: string; message: string }[];
      };
      const condition = status.conditions[0]!;
      expect(condition.reason).toBe('ReconcileError');
      expect(condition.message).toContain('manager-0: .spec.template.spec.containers');
      expect(condition.message).toContain('returned 409');
      expect(condition.message.length).toBeLessThan(1500);
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

  describe('a Tenant the LIST does not return (#474)', () => {
    function staleList(api: MemoryApi, getTenant?: (path: string) => Promise<unknown>) {
      const call = api.call.bind(api);
      let stale = true;
      spyOn(api, 'call').mockImplementation((async (
        method: string,
        path: string,
        body?: unknown,
      ) => {
        if (stale && method === 'GET' && /\/tenants\?labelSelector=/.test(path))
          return { items: [] };
        if (stale && method === 'GET' && getTenant && /\/tenants\/alpha$/.test(path))
          return getTenant(path);
        return call(method, path, body);
      }) as typeof api.call);
      return (value: boolean) => {
        stale = value;
      };
    }

    it('reconciles a Tenant found by GET and warns once per occurrence', async () => {
      const { api, controller, t, u } = prepare();
      api.seed({
        apiVersion: VERSION,
        kind: 'BackingService',
        metadata: { name: 'db', namespace: names('alpha').namespace },
        spec: {},
      });
      const setStale = staleList(api);
      const reconcile = spyOn(controller, 'reconcileTenant').mockResolvedValue();
      const services = spyOn(
        controller as unknown as { reconcileBackingService: () => Promise<void> },
        'reconcileBackingService',
      ).mockResolvedValue();
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await controller.tick();
        await controller.tick();
        expect(reconcile).toHaveBeenCalledTimes(2);
        expect(reconcile.mock.calls[0]?.[0].metadata.name).toBe(t.metadata.name);
        expect(services).toHaveBeenCalledTimes(2);
        const user = api.objects.get(key(u)) as unknown as User;
        expect(user.status?.conditions?.[0]?.reason).not.toBe('TenantNotReady');
        const stale = (m: unknown) => String(m).startsWith('Tenant list stale');
        const empty = (m: unknown) => String(m).startsWith('Tenant list empty');
        expect(warn.mock.calls.filter(([m]) => stale(m))).toEqual([
          ['Tenant list stale: alpha found by GET; reconciling it'],
        ]);
        expect(warn.mock.calls.filter(([m]) => empty(m))).toEqual([
          ['Tenant list empty while 1 User(s) exist; the API may be serving a stale cache'],
        ]);
        // The LIST recovers: the flags clear, so a later recurrence is reported again.
        setStale(false);
        await controller.tick();
        expect(warn).toHaveBeenCalledTimes(2);
        setStale(true);
        await controller.tick();
        expect(warn).toHaveBeenCalledTimes(4);
      } finally {
        reconcile.mockRestore();
        services.mockRestore();
        warn.mockRestore();
      }
    });

    describe('a declared Tenant before any User exists (#544)', () => {
      function firstInstall(getTenant?: (path: string) => Promise<unknown>) {
        const { api, t, u } = prepare();
        api.objects.delete(key(u));
        staleList(api, getTenant);
        const controller = new Controller(api, { ...cfg, tenants: [t.metadata.name] });
        return {
          t,
          controller,
          reconcile: spyOn(controller, 'reconcileTenant').mockResolvedValue(),
          warn: spyOn(console, 'warn').mockImplementation(() => {}),
        };
      }

      it('reconciles the declared Tenant found by GET on the first tick', async () => {
        const { t, controller, reconcile, warn } = firstInstall();
        try {
          await controller.tick();
          await controller.tick();
          expect(reconcile).toHaveBeenCalledTimes(2);
          expect(reconcile.mock.calls[0]?.[0].metadata.name).toBe(t.metadata.name);
          expect(warn.mock.calls).toEqual([
            ['Tenant list stale: alpha found by GET; reconciling it'],
          ]);
        } finally {
          reconcile.mockRestore();
          warn.mockRestore();
        }
      });

      it('reconciles nothing when the GET finds no declared Tenant', async () => {
        const { controller, reconcile, warn } = firstInstall(async (path) => {
          throw new ApiError(404, `GET ${path} returned 404`);
        });
        const error = spyOn(console, 'error').mockImplementation(() => {});
        try {
          await controller.tick();
          expect(reconcile).not.toHaveBeenCalled();
          expect(warn).not.toHaveBeenCalled();
          expect(error).not.toHaveBeenCalled();
        } finally {
          reconcile.mockRestore();
          warn.mockRestore();
          error.mockRestore();
        }
      });

      it("skips a declared name that matches another installation's Tenant", async () => {
        let tenantOf: Tenant | undefined;
        const { t, controller, reconcile, warn } = firstInstall(async () => ({
          ...tenantOf,
          metadata: {
            ...tenantOf?.metadata,
            labels: { ...tenantOf?.metadata.labels, [INSTALLATION]: 'other' },
          },
        }));
        tenantOf = t;
        try {
          await controller.tick();
          expect(reconcile).not.toHaveBeenCalled();
          expect(warn).not.toHaveBeenCalled();
        } finally {
          reconcile.mockRestore();
          warn.mockRestore();
        }
      });
    });

    it('leaves the User TenantNotReady when the GET finds no Tenant', async () => {
      const { api, controller, u } = prepare();
      staleList(api, async (path) => {
        throw new ApiError(404, `GET ${path} returned 404`);
      });
      const reconcile = spyOn(controller, 'reconcileTenant').mockResolvedValue();
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await controller.tick();
        expect(reconcile).not.toHaveBeenCalled();
        const user = api.objects.get(key(u)) as unknown as User;
        expect(user.status?.conditions?.[0]?.reason).toBe('TenantNotReady');
      } finally {
        reconcile.mockRestore();
        warn.mockRestore();
      }
    });

    it('ignores a Tenant found by GET that belongs to another installation', async () => {
      const { api, controller, t, u } = prepare();
      staleList(api, async () => ({
        ...t,
        metadata: { ...t.metadata, labels: { ...t.metadata.labels, [INSTALLATION]: 'other' } },
      }));
      const reconcile = spyOn(controller, 'reconcileTenant').mockResolvedValue();
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await controller.tick();
        expect(reconcile).not.toHaveBeenCalled();
        expect(warn.mock.calls.some(([m]) => String(m).startsWith('Tenant list stale'))).toBe(
          false,
        );
        const user = api.objects.get(key(u)) as unknown as User;
        expect(user.status?.conditions?.[0]?.reason).toBe('TenantNotReady');
      } finally {
        reconcile.mockRestore();
        warn.mockRestore();
      }
    });

    it('logs a failed GET and completes the tick', async () => {
      const { api, controller, u } = prepare();
      staleList(api, async (path) => {
        throw new ApiError(500, `GET ${path} returned 500`);
      });
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      const log = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await controller.tick();
        expect(log).toHaveBeenCalledWith(
          'Tenant/alpha: GET after a LIST miss failed: GET /apis/platform.di-framework.dev/v1alpha1/tenants/alpha returned 500',
        );
        const user = api.objects.get(key(u)) as unknown as User;
        expect(user.status?.conditions?.[0]?.reason).toBe('TenantNotReady');
      } finally {
        warn.mockRestore();
        log.mockRestore();
      }
    });
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
    // wash (PID 1) handles only SIGINT; the preStop stops it at once on a pod delete (#418).
    const container = (
      host.spec as { template: { spec: { containers: Record<string, unknown>[] } } }
    ).template.spec.containers.find((c) => c.name === 'host');
    expect(container?.lifecycle).toEqual({
      preStop: { exec: { command: ['/bin/kill', '-INT', '1'] } },
    });
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
    expect(userResources(u, [t], cfg)).toHaveLength(4);
  });
  it('keeps an already granted membership while its tenant is merely Not Ready', () => {
    const u = user();
    const granted = new Set(['alpha']);
    const t = tenant();
    t.metadata.generation = 2;
    expect(userResources(u, [t], cfg, granted)).toHaveLength(4);
    t.status = { conditions: [{ ...ready[0]!, status: 'False', reason: 'ReconcileError' }] };
    expect(userResources(u, [t], cfg, granted)).toHaveLength(4);
    // A tenant that never granted access is still waited for.
    expect(userResources(u, [t], cfg, new Set(['beta']))).toHaveLength(1);
    // Missing, suspended and deleting tenants revoke access even when it was granted.
    expect(userResources(u, [], cfg, granted)).toHaveLength(1);
    t.spec.suspended = true;
    expect(userResources(u, [t], cfg, granted)).toHaveLength(1);
    t.spec.suspended = false;
    t.metadata.deletionTimestamp = '2026-01-01T00:00:00Z';
    expect(userResources(u, [t], cfg, granted)).toHaveLength(1);
  });
  it('declares a ServiceAccount token Secret for each ready membership', () => {
    const u = user();
    u.spec.memberships.push({ tenant: 'beta', role: 'viewer' });
    const secrets = userResources(u, [tenant(), tenant('beta')], cfg).filter(
      (r) => r.kind === 'Secret',
    );
    expect(secrets).toEqual([
      expect.objectContaining({
        type: 'kubernetes.io/service-account-token',
        metadata: expect.objectContaining({
          name: 'di-user-alice-alpha-token',
          namespace: 'wasmcloud',
          labels: {
            [INSTALLATION]: 'test',
            [OWNER]: 'alice-uid',
            [USER]: 'alice',
            [TENANT]: 'alpha',
          },
          annotations: { 'kubernetes.io/service-account.name': 'di-user-alice' },
        }),
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({ name: 'di-user-alice-beta-token' }),
      }),
    ]);
    expect(userTokenSecretName('alice', 'beta')).toBe('di-user-alice-beta-token');
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
    // Only the runtime namespace is marked for the gateway's tenant-auth egress.
    const role = (name: string) =>
      api.objects.get(`/api/v1/namespaces/${name}`)?.metadata.labels?.[NAMESPACE_ROLE];
    expect(role('di-runtime-alpha')).toBe('runtime');
    expect(role('di-tenant-alpha')).toBeUndefined();
    expect(t.status?.conditions?.[0]?.status).toBe('True');
  });
  it('reports a logs ConfigMap write that keeps failing on the Tenant, then clears it (#316)', async () => {
    const { api, controller, t } = prepare();
    const failures = (
      controller as unknown as {
        logWriteFailures: Map<string, Map<string, { count: number; message: string }>>;
      }
    ).logWriteFailures;
    const logs = () => t.status?.conditions?.find((c) => c.type === 'LogsProjected');
    const statusWrites = () =>
      api.operations.filter((o) => o.method === 'PATCH' && o.path.endsWith('/tenants/alpha/status'))
        .length;
    const fail = (count: number, message = 'quota') =>
      failures.set('alpha', new Map([['di-logs-web.prod', { count, message }]]));
    // One failed poll is not reported yet.
    fail(1);
    await controller.reconcileTenant(t);
    expect(logs()).toBeUndefined();
    fail(3);
    await controller.reconcileTenant(t);
    // Ready is untouched: projection is best effort.
    expect(t.status?.conditions?.[0]).toMatchObject({ type: 'Ready', status: 'True' });
    expect(logs()).toMatchObject({
      status: 'False',
      reason: 'WriteFailed',
      message: 'logs ConfigMap di-logs-web.prod could not be written: quota',
    });
    // While the same failure lasts, the Tenant status is not written again.
    const written = statusWrites();
    const since = logs()?.lastTransitionTime;
    for (const count of [4, 5, 6]) {
      fail(count);
      await controller.reconcileTenant(t);
    }
    expect(statusWrites()).toBe(written);
    expect(logs()?.lastTransitionTime).toBe(since);
    // A different error is reported, once.
    fail(7, 'forbidden');
    await controller.reconcileTenant(t);
    fail(8, 'forbidden');
    await controller.reconcileTenant(t);
    expect(statusWrites()).toBe(written + 1);
    expect(logs()?.message).toBe('logs ConfigMap di-logs-web.prod could not be written: forbidden');
    expect(logs()?.lastTransitionTime).toBe(since);
    failures.delete('alpha');
    await controller.reconcileTenant(t);
    expect(logs()).toBeUndefined();
    expect(t.status?.conditions?.[0]).toMatchObject({ type: 'Ready', status: 'True' });
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
    expect(deletes).toHaveLength(4);
    expect(deletes[2]?.path).toContain('/secrets/di-user-alice-alpha-token');
    expect(deletes[3]?.path).toContain('/serviceaccounts/di-user-alice');
    expect(
      [...api.objects.values()].filter((r) => r.metadata.labels?.[OWNER] === u.metadata.uid),
    ).toHaveLength(0);
    expect(u.status?.serviceAccount).toBeNull();
  });
  it('reports Ready only once Kubernetes populates every token Secret', async () => {
    const { api, controller, t, u } = prepare();
    await controller.reconcileUser(u, [t]);
    const tokenPath = '/api/v1/namespaces/wasmcloud/secrets/di-user-alice-alpha-token';
    expect(api.objects.get(tokenPath)).toMatchObject({
      type: 'kubernetes.io/service-account-token',
      metadata: { annotations: { 'kubernetes.io/service-account.name': 'di-user-alice' } },
    });
    expect(u.status?.conditions?.[0]).toMatchObject({ status: 'False', reason: 'TokenPending' });
    // The token controller fills data outside the controller's server-side-apply field set.
    const token = api.objects.get(tokenPath);
    if (token) token.data = { token: 'dG9rZW4=', 'ca.crt': 'Y2E=' };
    await controller.reconcileUser(u, [t]);
    expect(u.status?.conditions?.[0]).toMatchObject({ status: 'True', reason: 'Reconciled' });
    expect(api.objects.get(tokenPath)?.data).toEqual({ token: 'dG9rZW4=', 'ca.crt': 'Y2E=' });
  });
  it('deletes the token Secret of a removed membership and keeps the others', async () => {
    const { api, controller, t, u } = prepare();
    const beta = tenant('beta');
    u.spec.memberships.push({ tenant: 'beta', role: 'viewer' });
    await controller.reconcileUser(u, [t, beta]);
    const secrets = () =>
      [...api.objects.values()].filter((r) => r.kind === 'Secret' && r.metadata.labels?.[OWNER]);
    expect(secrets().map((r) => r.metadata.name)).toEqual([
      'di-user-alice-alpha-token',
      'di-user-alice-beta-token',
    ]);
    u.spec.memberships = [{ tenant: 'beta', role: 'viewer' }];
    await controller.reconcileUser(u, [t, beta]);
    expect(secrets().map((r) => r.metadata.name)).toEqual(['di-user-alice-beta-token']);
  });
  it('keeps memberships and token Secrets while a granted tenant is Not Ready (#119)', async () => {
    const { api, controller, t, u } = prepare();
    const tokenPath = '/api/v1/namespaces/wasmcloud/secrets/di-user-alice-alpha-token';
    const owned = () =>
      [...api.objects.values()]
        .filter((r) => r.metadata.labels?.[OWNER] === u.metadata.uid)
        .map((r) => `${r.kind}/${r.metadata.namespace}/${r.metadata.name}`)
        .sort();
    await controller.reconcileUser(u, [t]);
    const token = api.objects.get(tokenPath);
    if (token) token.data = { token: 'dG9rZW4=', 'ca.crt': 'Y2E=' };
    await controller.reconcileUser(u, [t]);
    expect(u.status?.conditions?.[0]).toMatchObject({ status: 'True', reason: 'Reconciled' });
    const granted = owned();
    expect(granted).toHaveLength(4);
    // An upgrade bumps the generation; the tenant is Not Ready until the controller catches up.
    t.metadata.generation = 2;
    api.operations = [];
    await controller.reconcileUser(u, [t]);
    expect(api.operations.filter((o) => o.method === 'DELETE')).toEqual([]);
    expect(owned()).toEqual(granted);
    expect(api.objects.get(tokenPath)?.data).toEqual({ token: 'dG9rZW4=', 'ca.crt': 'Y2E=' });
    expect(u.status?.conditions?.[0]).toMatchObject({ status: 'True', reason: 'Reconciled' });
    // A failing tenant keeps them too, and a role change still converges on the kept binding.
    t.status = { conditions: [{ ...ready[0]!, status: 'False', reason: 'ReconcileError' }] };
    u.spec.memberships[0]!.role = 'viewer';
    api.seed(u);
    await controller.reconcileUser(u, [t]);
    expect(owned()).toEqual(granted);
    expect(
      api.objects.get(
        '/apis/rbac.authorization.k8s.io/v1/namespaces/di-tenant-alpha/rolebindings/di-user-alice',
      )?.roleRef,
    ).toMatchObject({ name: 'di-viewer' });
    // Ready again: the same state, nothing recreated.
    t.status = { conditions: [{ ...ready[0]!, observedGeneration: 2 }] };
    api.operations = [];
    await controller.reconcileUser(u, [t]);
    expect(api.operations.filter((o) => o.method === 'DELETE')).toEqual([]);
    expect(owned()).toEqual(granted);
    expect(u.status?.conditions?.[0]).toMatchObject({ status: 'True', reason: 'Reconciled' });
    // Suspending the tenant still revokes access.
    t.spec.suspended = true;
    await controller.reconcileUser(u, [t]);
    expect(owned()).toEqual([`ServiceAccount/wasmcloud/di-user-alice`]);
    expect(u.status?.conditions?.[0]?.reason).toBe('TenantNotReady');
  });
  it('waits for a Not Ready tenant before granting a new membership', async () => {
    const { api, controller, t, u } = prepare();
    t.metadata.generation = 2;
    await controller.reconcileUser(u, [t]);
    expect([...api.objects.values()].filter((r) => r.kind === 'RoleBinding')).toHaveLength(0);
    expect(api.objects.has('/api/v1/namespaces/wasmcloud/secrets/di-user-alice-alpha-token')).toBe(
      false,
    );
    expect(u.status?.conditions?.[0]).toMatchObject({ status: 'False', reason: 'TenantNotReady' });
    t.status = { conditions: [{ ...ready[0]!, observedGeneration: 2 }] };
    await controller.reconcileUser(u, [t]);
    expect([...api.objects.values()].filter((r) => r.kind === 'RoleBinding')).toHaveLength(2);
    expect(u.status?.conditions?.[0]).toMatchObject({ status: 'False', reason: 'TokenPending' });
  });
  it('removes memberships even when the referenced tenant no longer exists', async () => {
    const { api, controller, t, u } = prepare();
    await controller.reconcileUser(u, [t]);
    await controller.reconcileUser(u, []);
    expect([...api.objects.values()].filter((r) => r.kind === 'RoleBinding')).toHaveLength(0);
    expect(
      [...api.objects.values()].filter((r) => r.metadata.name === 'di-user-alice-alpha-token'),
    ).toHaveLength(0);
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
  it('keeps the Retain finalizer until the host pods are gone, terminating ones included (#245)', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t);
    const n = names('alpha');
    // The Deployments already report zero replicas; a terminating host pod is still there.
    api.seed(hostPod('hostgroup-terminating', 'alpha', { terminating: true, phase: 'Running' }));
    // Another tenant's host pod never holds this tenant back.
    const other = names('beta');
    api.seed(hostPod('hostgroup-beta', 'beta', { terminating: true }));
    t.metadata.deletionTimestamp = new Date().toISOString();
    api.seed(t);
    await controller.reconcileTenant(t);
    expect(t.metadata.finalizers).toContain(FINALIZER);
    // The Tenant says what it waits for.
    expect(t.status?.conditions?.[0]).toMatchObject({
      status: 'False',
      reason: 'WaitingForHostPods',
      message: `Retain: waiting for host pods in ${n.runtimeNamespace} to be gone before removing the Tenant: hostgroup-terminating`,
    });
    expect(api.operations).toContainEqual({
      method: 'GET',
      path: `${collection('v1', 'Pod', n.runtimeNamespace)}?labelSelector=${encodeURIComponent(
        `wasmcloud.com/hostgroup=${n.hostgroup},wasmcloud.com/name=hostgroup`,
      )}`,
    });
    // Nothing is deleted while waiting: the pod, namespaces and the other tenant's pod stay.
    expect(
      api.objects.has(`/api/v1/namespaces/${n.runtimeNamespace}/pods/hostgroup-terminating`),
    ).toBe(true);
    expect(
      api.objects.has(`/api/v1/namespaces/${other.runtimeNamespace}/pods/hostgroup-beta`),
    ).toBe(true);
    expect(api.objects.has(`/api/v1/namespaces/${n.runtimeNamespace}`)).toBe(true);
    // A retry while the pod remains is a no-op; once the operator lets it go, the finalizer goes.
    await controller.reconcileTenant(t);
    expect(t.metadata.finalizers).toContain(FINALIZER);
    api.objects.delete(`/api/v1/namespaces/${n.runtimeNamespace}/pods/hostgroup-terminating`);
    await controller.reconcileTenant(t);
    expect(t.metadata.finalizers).not.toContain(FINALIZER);
    expect(api.objects.has(`/api/v1/namespaces/${n.runtimeNamespace}`)).toBe(true);
    expect(
      api.objects.has(`/api/v1/namespaces/${other.runtimeNamespace}/pods/hostgroup-beta`),
    ).toBe(true);
  });
  it('under Retain, finished host pods do not hold the Tenant; running, pending and unknown ones do (#245)', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t);
    const n = names('alpha');
    const pod = (name: string) => `/api/v1/namespaces/${n.runtimeNamespace}/pods/${name}`;
    for (const name of ['running', 'pending', 'unknown', 'no-status', 'r5', 'r6']) {
      const phase =
        { running: 'Running', pending: 'Pending', unknown: 'Unknown' }[name] ?? 'Running';
      api.seed(hostPod(name, 'alpha', name === 'no-status' ? {} : { phase }));
    }
    // An evicted pod stays Failed until someone deletes it, and under Retain nobody does.
    api.seed(hostPod('evicted', 'alpha', { phase: 'Failed' }));
    api.seed(hostPod('completed', 'alpha', { phase: 'Succeeded' }));
    t.metadata.deletionTimestamp = new Date().toISOString();
    api.seed(t);
    await controller.reconcileTenant(t);
    expect(t.metadata.finalizers).toContain(FINALIZER);
    const waiting = t.status?.conditions?.[0];
    expect(waiting?.reason).toBe('WaitingForHostPods');
    // At most five names, then a count; finished pods are never named.
    expect(waiting?.message).toEndWith(': no-status, pending, r5, r6, running, and 1 more');
    expect(waiting?.message).not.toContain('evicted');
    for (const name of ['running', 'pending', 'unknown', 'no-status', 'r5', 'r6']) {
      api.objects.delete(pod(name));
    }
    await controller.reconcileTenant(t);
    expect(t.metadata.finalizers).not.toContain(FINALIZER);
    // Only finished pods were left; the controller still deletes nothing under Retain.
    expect(api.objects.has(pod('evicted'))).toBe(true);
    expect(api.objects.has(pod('completed'))).toBe(true);
    expect(
      api.operations.filter((o) => o.method === 'DELETE' && o.path.includes('/pods/')),
    ).toEqual([]);
  });
  it('a terminating host pod holds the Retain Tenant even in a finished phase (#245)', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t);
    api.seed(hostPod('evicted-terminating', 'alpha', { terminating: true, phase: 'Failed' }));
    t.metadata.deletionTimestamp = new Date().toISOString();
    api.seed(t);
    await controller.reconcileTenant(t);
    expect(t.metadata.finalizers).toContain(FINALIZER);
    expect(t.status?.conditions?.[0]?.message).toEndWith(': evicted-terminating');
  });
  it('waits for its namespaces to disappear before completing Delete', async () => {
    const { api, controller, t } = prepare();
    await controller.reconcileTenant(t);
    const namespaces = ['di-tenant-alpha', 'di-runtime-alpha', 'di-apikeys-alpha'];
    const live = () =>
      namespaces.filter((name) => api.objects.has(`${collection('v1', 'Namespace')}/${name}`));
    expect(live()).toEqual(namespaces);
    t.spec.deletionPolicy = 'Delete';
    t.metadata.deletionTimestamp = new Date().toISOString();
    api.seed(t);
    await controller.reconcileTenant(t);
    // The API-key namespace (#379) goes with the others.
    expect(live()).toEqual([]);
    expect(t.metadata.finalizers).toContain(FINALIZER);
    await controller.reconcileTenant(t);
    expect(t.metadata.finalizers).not.toContain(FINALIZER);
  });
});

describe('placement nudge after a tenant host becomes Ready (#418)', () => {
  const workloads = '/apis/runtime.wasmcloud.dev/v1alpha1/namespaces/di-tenant-alpha/workloads';
  const hostPath = '/apis/runtime.wasmcloud.dev/v1alpha1/namespaces/wasmcloud/hosts/alpha-host';
  function setup(hostReady = true) {
    const { api, controller, t } = prepare();
    api.seed({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: names('alpha').namespace,
        labels: { [INSTALLATION]: 'test', [TENANT]: 'alpha' },
      },
    });
    const host = api.objects.get(hostPath)!;
    host.metadata.uid = 'host-uid-1';
    host.hostname = '10.0.0.1';
    const pod = (name: string, ip: string, terminating = false) =>
      api.seed({ ...hostPod(name, 'alpha', { terminating }), status: { podIP: ip } });
    pod('host-pod-1', '10.0.0.1');
    if (!hostReady)
      host.status = { conditions: [{ type: 'Ready', status: 'False', reason: 'NotReady' }] };
    const workload = (name: string, extra: Partial<Resource> = {}) =>
      api.seed({
        apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
        kind: 'Workload',
        metadata: { name, namespace: 'di-tenant-alpha' },
        ...extra,
      });
    workload('unplaced', { status: { conditions: [] } });
    workload('placed', { status: { hostId: 'host-id' } });
    workload('deleting', {
      metadata: {
        name: 'deleting',
        namespace: 'di-tenant-alpha',
        deletionTimestamp: '2026-01-01T00:00:00Z',
      },
    });
    const patches = () =>
      api.operations
        .filter((o) => o.method === 'PATCH' && o.path.startsWith(workloads))
        .map((o) => o.path.slice(workloads.length + 1));
    const annotation = (name: string) =>
      api.objects.get(`${workloads}/${name}`)?.metadata.annotations?.[PLACEMENT_RETRY];
    const reason = () =>
      (api.objects.get(key(t))?.status as { conditions?: { reason: string }[] } | undefined)
        ?.conditions?.[0]?.reason;
    /** Fails calls that `match`, passing every other call through. */
    const failing = (match: (method: string, path: string) => ApiError | undefined) => {
      const call = api.call.bind(api);
      return spyOn(api, 'call').mockImplementation(
        async (method: string, path: string, body?: unknown) => {
          const error = match(method, path);
          if (error) {
            api.operations.push({ method, path });
            throw error;
          }
          return call(method, path, body);
        },
      );
    };
    return { api, controller, t, workload, pod, patches, annotation, reason, failing };
  }

  it('annotates an unplaced workload exactly once per Ready host and leaves placed ones alone', async () => {
    const { api, controller, t, patches, annotation, reason } = setup();
    await controller.reconcileTenant(t);
    expect(patches()).toEqual(['unplaced?fieldManager=di-platform-controller']);
    expect(annotation('unplaced')).toBe('host-uid-1');
    expect(api.objects.get(`${workloads}/placed`)?.metadata.annotations).toBeUndefined();
    expect(reason()).toBe('Reconciled');
    // The next poll does not patch it again.
    await controller.reconcileTenant(t);
    expect(patches()).toHaveLength(1);
  });

  it('re-nudges a still unplaced workload when a new host uid becomes Ready', async () => {
    const { api, controller, t, patches, annotation } = setup();
    await controller.reconcileTenant(t);
    api.objects.get(hostPath)!.metadata.uid = 'host-uid-0';
    await controller.reconcileTenant(t);
    expect(patches()).toHaveLength(2);
    expect(annotation('unplaced')).toBe('host-uid-0');
  });

  it('re-nudges when another host joins the Ready set', async () => {
    const { api, controller, t, patches, annotation } = setup();
    await controller.reconcileTenant(t);
    const second = structuredClone(api.objects.get(hostPath) as Resource);
    second.metadata = { ...second.metadata, name: 'alpha-host-2', uid: 'host-uid-2' };
    api.seed(second);
    await controller.reconcileTenant(t);
    expect(patches()).toHaveLength(2);
    expect(annotation('unplaced')).toBe('host-uid-1,host-uid-2');
  });

  it('leaves a Ready host out of the nudge while its pod is terminating (#418)', async () => {
    const { api, controller, t, pod, patches, annotation } = setup();
    pod('host-pod-1', '10.0.0.1', true);
    await controller.reconcileTenant(t);
    expect(patches()).toEqual([]);
    // Its replacement's host is nudged alone once Ready.
    const next = structuredClone(api.objects.get(hostPath) as Resource);
    next.metadata = { ...next.metadata, name: 'alpha-host-2', uid: 'host-uid-2' };
    next.hostname = '10.0.0.2';
    api.seed(next);
    pod('host-pod-2', '10.0.0.2');
    await controller.reconcileTenant(t);
    expect(annotation('unplaced')).toBe('host-uid-2');
  });

  it('leaves a Ready host out of the nudge when no pod has its IP', async () => {
    const { api, controller, t, patches } = setup();
    api.objects.delete(`${collection('v1', 'Pod', names('alpha').runtimeNamespace)}/host-pod-1`);
    // A pod without an IP yet matches no host either.
    api.seed(hostPod('host-pod-3', 'alpha'));
    await controller.reconcileTenant(t);
    expect(patches()).toEqual([]);
  });

  it('patches nothing without a Ready host', async () => {
    const { controller, t, patches } = setup(false);
    await controller.reconcileTenant(t);
    expect(patches()).toEqual([]);
  });

  it('skips suspended tenants', async () => {
    const { controller, t, patches } = setup();
    t.spec.suspended = true;
    await controller.reconcileTenant(t);
    expect(patches()).toEqual([]);
  });

  it('waits for a freshly Ready host and leaves workloads younger than 5 s alone', async () => {
    const { api, controller, t, workload, patches } = setup();
    const now = new Date().toISOString();
    workload('young', {
      metadata: { name: 'young', namespace: 'di-tenant-alpha', creationTimestamp: now },
    });
    api.objects.get(hostPath)!.status = {
      conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: now }],
    };
    await controller.reconcileTenant(t);
    expect(patches()).toEqual([]);
    api.objects.get(hostPath)!.status = {
      conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: '2026-01-01T00:00:00Z' }],
    };
    await controller.reconcileTenant(t);
    expect(patches()).toEqual(['unplaced?fieldManager=di-platform-controller']);
  });

  it('ignores a 404 and still nudges the remaining workloads', async () => {
    const { controller, t, workload, patches, annotation, reason, failing } = setup();
    workload('later', { status: { conditions: [] } });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    failing((method, path) =>
      method === 'PATCH' && path.startsWith(`${workloads}/unplaced`)
        ? new ApiError(404, 'Not found')
        : undefined,
    );
    try {
      await controller.reconcileTenant(t);
      expect(patches()).toEqual([
        'unplaced?fieldManager=di-platform-controller',
        'later?fieldManager=di-platform-controller',
      ]);
      expect(annotation('later')).toBe('host-uid-1');
      expect(reason()).toBe('Reconciled');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs any other patch failure once per workload and host without failing the reconcile', async () => {
    const { controller, t, workload, patches, annotation, reason, failing } = setup();
    workload('later', { status: { conditions: [] } });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    failing((method, path) =>
      method === 'PATCH' && path.startsWith(`${workloads}/unplaced`)
        ? new ApiError(403, 'Forbidden')
        : undefined,
    );
    try {
      await controller.reconcileTenant(t);
      await controller.reconcileTenant(t);
      expect(patches().filter((p) => p.startsWith('unplaced'))).toHaveLength(2);
      expect(annotation('later')).toBe('host-uid-1');
      expect(reason()).toBe('Reconciled');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('di-tenant-alpha/unplaced@host-uid-1');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a failed Workload list without failing the reconcile', async () => {
    const { controller, t, patches, reason, failing } = setup();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    failing((method, path) =>
      method === 'GET' && path.startsWith(workloads) ? new ApiError(500, 'boom') : undefined,
    );
    try {
      await controller.reconcileTenant(t);
      expect(patches()).toEqual([]);
      expect(reason()).toBe('Reconciled');
      expect(warn.mock.calls[0]![0]).toContain('listing Workloads failed: boom');
    } finally {
      warn.mockRestore();
    }
  });

  it('nudges while a non-host Deployment is not ready, and the tenant stays Provisioning', async () => {
    const { api, controller, t, patches, reason } = setup();
    const call = api.call.bind(api);
    spyOn(api, 'call').mockImplementation(async (method: string, path: string, body?: unknown) => {
      const value = (await call(method, path, body)) as Resource;
      if (method === 'PATCH' && /\/deployments\/di-redis(\?|$)/.test(path))
        value.status = { observedGeneration: 1, readyReplicas: 0 };
      return value as never;
    });
    await controller.reconcileTenant(t);
    expect(patches()).toEqual(['unplaced?fieldManager=di-platform-controller']);
    expect(reason()).toBe('Provisioning');
  });

  it('nudges after an apply failure in the same pass', async () => {
    const { controller, t, patches, reason, failing } = setup();
    const log = spyOn(console, 'error').mockImplementation(() => {});
    failing((method, path) =>
      method === 'PATCH' && /\/deployments\/hostgroup-/.test(path)
        ? new ApiError(409, 'conflict')
        : undefined,
    );
    try {
      await controller.reconcileTenant(t);
      expect(patches()).toEqual(['unplaced?fieldManager=di-platform-controller']);
      expect(reason()).toBe('ReconcileError');
    } finally {
      log.mockRestore();
    }
  });

  it('reports a failed Host list only when it decides readiness', async () => {
    const { controller, t, reason, failing } = setup();
    const log = spyOn(console, 'error').mockImplementation(() => {});
    failing((method, path) =>
      method === 'GET' && path.includes('/hosts?') ? new ApiError(500, 'hosts down') : undefined,
    );
    try {
      await controller.reconcileTenant(t);
      expect(reason()).toBe('ReconcileError');
    } finally {
      log.mockRestore();
    }
  });
});
