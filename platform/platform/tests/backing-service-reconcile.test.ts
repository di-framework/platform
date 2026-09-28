import { describe, expect, it } from 'bun:test';
import {
  backingServiceHostPath,
  backingServiceResourceName,
  backingServiceResources,
  mergeSizing,
  PROVIDER_RUNTIME,
  parseCpu,
  parseMemory,
  RUNTIME_DATA_NATS,
  resolveBackingSizing,
  resolveClass,
  runtimeDataNatsHostPath,
  SERVICE,
  TRANSITIONAL_REDIS,
  transitionalRedisHostPath,
  validateSizingAgainstClass,
  validateSizingAgainstTenantBudget,
} from '../src/tenancy/backing-service-reconcile';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  type BackingService,
  type BackingServiceClass,
  type ControllerConfig,
  DEFAULT_CLASS_NAMES,
  defaultClassSeed,
  FINALIZER,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  type Tenant,
  VERSION,
} from '../src/tenancy/resources';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  insecureRegistry: true,
};

function key(value: Resource | Tenant | BackingService | BackingServiceClass): string {
  return `${collection(value.apiVersion, value.kind, value.metadata.namespace)}/${value.metadata.name}`;
}

class MemoryApi implements Api {
  objects = new Map<string, Resource>();
  operations: { method: string; path: string }[] = [];
  seed(value: Resource | Tenant | BackingService | BackingServiceClass): void {
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
        .filter(Boolean)
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
          replicas: (value.spec as { replicas: number }).replicas,
        };
      this.objects.set(target, value);
      return structuredClone(value) as T;
    }
    throw new Error(`Unexpected ${method}`);
  }
}

function tenant(name = 'alpha'): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: { name, uid: `${name}-uid`, generation: 1, labels: { [INSTALLATION]: 'test' } },
    spec: { resources: { cpu: '2', memory: '4Gi', workloads: 20 } },
  };
}

function seedClass(
  type: 'keyvalue' | 'messaging',
  overrides: Partial<BackingServiceClass['spec']> & { name?: string } = {},
): BackingServiceClass {
  const { name, ...specOverrides } = overrides;
  return {
    apiVersion: VERSION,
    kind: 'BackingServiceClass',
    metadata: {
      name: name ?? DEFAULT_CLASS_NAMES[type],
      uid: `${type}-class-uid`,
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec: { ...defaultClassSeed(type), ...specOverrides },
  };
}

function backingService(
  name: string,
  type: 'keyvalue' | 'messaging',
  opts: {
    className?: string;
    parameters?: BackingService['spec']['parameters'];
    uid?: string;
  } = {},
): BackingService {
  return {
    apiVersion: VERSION,
    kind: 'BackingService',
    metadata: {
      name,
      namespace: names('alpha').namespace,
      uid: opts.uid ?? `${name}-uid`,
      generation: 1,
    },
    spec: {
      type,
      ...(opts.className !== undefined ? { className: opts.className } : {}),
      ...(opts.parameters ? { parameters: opts.parameters } : {}),
    },
  };
}

function prepare(): {
  api: MemoryApi;
  controller: Controller;
  t: Tenant;
  classes: BackingServiceClass[];
} {
  const api = new MemoryApi();
  const t = tenant();
  const classes = [seedClass('keyvalue'), seedClass('messaging')];
  api.seed(t);
  for (const cls of classes) api.seed(cls);
  return { api, controller: new Controller(api, cfg), t, classes };
}

describe('backing service provisioner helpers', () => {
  it('names instances di-bs-* and keeps runtime di-nats / transitional di-redis separate', () => {
    expect(backingServiceResourceName('stock')).toBe('di-bs-stock');
    expect(RUNTIME_DATA_NATS).toBe('di-nats');
    expect(TRANSITIONAL_REDIS).toBe('di-redis');
    expect(backingServiceHostPath('alpha-uid', 'stock')).toBe(
      '/var/lib/k0s/di-tenants/alpha-uid/bs-stock',
    );
    expect(runtimeDataNatsHostPath('alpha-uid')).toBe('/var/lib/k0s/di-tenants/alpha-uid/di-nats');
    expect(transitionalRedisHostPath('alpha-uid')).toBe(
      '/var/lib/k0s/di-tenants/alpha-uid/di-redis',
    );
    expect(PROVIDER_RUNTIME.redis.image).toBe('redis:7.4.5-alpine');
    expect(PROVIDER_RUNTIME.nats.image).toBe('nats:2.12.8-alpine');
  });

  it('applies class defaults and rejects sizing outside class schema or tenant budget', () => {
    const cls = seedClass('keyvalue');
    const t = tenant();
    const service = backingService('stock', 'keyvalue');
    expect(mergeSizing(cls.spec.defaults, undefined)).toEqual({
      storage: '1Gi',
      memory: '128Mi',
      cpu: '250m',
    });
    expect(validateSizingAgainstClass({ memory: '32Mi' }, cls)).toContain('at least');
    expect(validateSizingAgainstClass({ memory: '8Gi' }, cls)).toContain('at most');
    expect(validateSizingAgainstTenantBudget({ memory: '8Gi' }, t)).toContain(
      'exceeds tenant budget',
    );
    expect(validateSizingAgainstTenantBudget({ cpu: '4' }, t)).toContain('exceeds tenant budget');
    expect(resolveBackingSizing(service, cls, t)).toEqual({
      sizing: { storage: '1Gi', memory: '128Mi', cpu: '250m' },
    });
    expect(parseCpu('250m')).toBe(250);
    expect(parseCpu('1')).toBe(1000);
    expect(parseMemory('128Mi')).toBe(128 * 1024 ** 2);
    expect(parseMemory('1Ki')).toBe(1024);
    expect(parseMemory('1Gi')).toBe(1024 ** 3);
    expect(parseMemory('1Ti')).toBe(1024 ** 4);
    expect(parseMemory('42')).toBe(42);
    expect(() => parseCpu('nope')).toThrow(/Invalid cpu/);
    expect(() => parseMemory('nope')).toThrow(/Invalid memory/);
  });

  it('resolves default classes and rejects invisible or mismatched classes', () => {
    const classes = [
      seedClass('keyvalue'),
      seedClass('messaging', {
        name: 'messaging-private',
        visibility: 'SelectedTenants',
        allowedTenants: ['other'],
        default: false,
      }),
    ];
    const ok = resolveClass(backingService('stock', 'keyvalue'), classes, 'alpha');
    expect('cls' in ok).toBe(true);
    const hidden = resolveClass(
      backingService('bus', 'messaging', { className: 'messaging-private' }),
      classes,
      'alpha',
    );
    expect(hidden).toEqual({ error: expect.stringContaining('not visible') });
  });
});

describe('backing service reconciliation', () => {
  it('provisions independent keyvalue and messaging instances in the runtime namespace', async () => {
    const { api, controller, t, classes } = prepare();
    const stock = backingService('stock', 'keyvalue');
    const bus = backingService('bus', 'messaging');
    api.seed(stock);
    api.seed(bus);
    await controller.reconcileBackingService(stock, t, classes);
    await controller.reconcileBackingService(bus, t, classes);

    const redis = api.objects.get(
      '/apis/apps/v1/namespaces/di-runtime-alpha/deployments/di-bs-stock',
    );
    const nats = api.objects.get('/apis/apps/v1/namespaces/di-runtime-alpha/deployments/di-bs-bus');
    expect(redis?.metadata.labels?.[OWNER]).toBe('stock-uid');
    expect(nats?.metadata.labels?.[OWNER]).toBe('bus-uid');
    expect(redis?.metadata.labels?.[SERVICE]).toBe('stock');
    expect(JSON.stringify(redis)).toContain('redis:7.4.5-alpine');
    expect(JSON.stringify(nats)).toContain('nats:2.12.8-alpine');
    expect(JSON.stringify(redis)).toContain('/var/lib/k0s/di-tenants/alpha-uid/bs-stock');
    expect(JSON.stringify(nats)).toContain('/var/lib/k0s/di-tenants/alpha-uid/bs-bus');
    expect(api.objects.has('/api/v1/namespaces/di-runtime-alpha/services/di-bs-stock')).toBe(true);
    expect(api.objects.has('/api/v1/namespaces/di-runtime-alpha/services/di-bs-bus')).toBe(true);
    expect(api.objects.has('/api/v1/namespaces/di-runtime-alpha/secrets/di-bs-stock-conn')).toBe(
      true,
    );

    expect(stock.status).toMatchObject({
      conditions: [expect.objectContaining({ type: 'Ready', status: 'True', reason: 'Ready' })],
      runtimeNamespace: 'di-runtime-alpha',
      classRef: { name: 'keyvalue-redis' },
      endpoint: {
        host: 'di-bs-stock.di-runtime-alpha.svc.cluster.local',
        port: 6379,
        capability: 'keyvalue',
      },
    });
    expect(JSON.stringify(stock.status)).not.toMatch(/password|credential|token/i);
    expect(bus.status?.endpoint).toMatchObject({ port: 4222, capability: 'messaging' });
    // Runtime data-plane NATS is never created by BackingService reconcile.
    expect(api.objects.has('/apis/apps/v1/namespaces/di-runtime-alpha/deployments/di-nats')).toBe(
      false,
    );
  });

  it('is idempotent and repairs drift on subsequent reconciles', async () => {
    const { api, controller, t, classes } = prepare();
    const stock = backingService('stock', 'keyvalue');
    api.seed(stock);
    await controller.reconcileBackingService(stock, t, classes);
    const path = '/apis/apps/v1/namespaces/di-runtime-alpha/deployments/di-bs-stock';
    const dep = api.objects.get(path)!;
    (dep.spec as { replicas: number }).replicas = 0;
    api.seed(dep as never);
    await controller.reconcileBackingService(stock, t, classes);
    expect((api.objects.get(path)!.spec as { replicas: number }).replicas).toBe(1);
  });

  it('refuses to adopt deployments owned by a different BackingService uid', async () => {
    const { api, controller, t, classes } = prepare();
    const stock = backingService('stock', 'keyvalue');
    api.seed(stock);
    api.seed({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'di-bs-stock',
        namespace: 'di-runtime-alpha',
        labels: { [INSTALLATION]: 'test', [OWNER]: 'other-uid' },
      },
      spec: { replicas: 1 },
    });
    await expect(controller.reconcileBackingService(stock, t, classes)).rejects.toThrow(
      'Refusing to adopt',
    );
  });

  it('refuses to adopt leftover resources when a name is reused with a new uid', async () => {
    const { api, controller, t, classes } = prepare();
    const first = backingService('stock', 'keyvalue', { uid: 'stock-uid-1' });
    api.seed(first);
    await controller.reconcileBackingService(first, t, classes);
    const reused = backingService('stock', 'keyvalue', { uid: 'stock-uid-2' });
    api.seed(reused);
    await expect(controller.reconcileBackingService(reused, t, classes)).rejects.toThrow(
      'Refusing to adopt',
    );
  });

  it('marks Failed when class is missing or sizing is invalid', async () => {
    const { api, controller, t } = prepare();
    const missing = backingService('stock', 'keyvalue', { className: 'no-such-class' });
    api.seed(missing);
    await controller.reconcileBackingService(missing, t, []);
    expect(missing.status?.conditions?.[0]).toMatchObject({
      status: 'False',
      reason: 'Failed',
    });
    expect(missing.status?.conditions?.[0]?.message).toContain('not found');

    const { classes } = prepare();
    const oversized = backingService('big', 'keyvalue', { parameters: { memory: '8Gi' } });
    api.seed(oversized);
    await controller.reconcileBackingService(oversized, t, classes);
    expect(oversized.status?.conditions?.[0]?.reason).toBe('Failed');
    expect(oversized.status?.conditions?.[0]?.message).toMatch(/at most|budget/);
  });

  it('reports Provisioning when the deployment is not ready yet', async () => {
    const { api, controller, t, classes } = prepare();
    const stock = backingService('stock', 'keyvalue');
    api.seed(stock);
    const original = api.call.bind(api);
    api.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const result = await original<T>(method, path, body);
      if (
        method === 'PATCH' &&
        path.includes('/deployments/di-bs-stock') &&
        !path.includes('/status')
      ) {
        const dep = result as Resource;
        dep.status = { observedGeneration: 1, readyReplicas: 0, replicas: 1 };
        api.objects.set(path.split('?')[0]!, dep);
        return structuredClone(dep) as T;
      }
      return result;
    };
    await controller.reconcileBackingService(stock, t, classes);
    expect(stock.status?.conditions?.[0]).toMatchObject({
      status: 'False',
      reason: 'Provisioning',
    });
    // A pending Deployment must not prevent the remaining resources from being applied.
    expect(api.objects.has('/api/v1/namespaces/di-runtime-alpha/services/di-bs-stock')).toBe(true);
    expect(api.objects.has('/api/v1/namespaces/di-runtime-alpha/secrets/di-bs-stock-conn')).toBe(
      true,
    );
  });

  it('reconciles BackingServices during tick alongside tenants', async () => {
    const { api, controller, classes } = prepare();
    api.seed({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: names('alpha').namespace,
        labels: { [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' },
      },
    });
    api.seed({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: names('alpha').runtimeNamespace,
        labels: { [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' },
      },
    });
    api.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'wasmcloud-runtime-tls', namespace: cfg.namespace },
      data: { 'ca.crt': 'test' },
    });
    api.seed({
      apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
      kind: 'Host',
      metadata: {
        name: 'alpha-host',
        namespace: 'wasmcloud',
        labels: { hostgroup: 'tenant-alpha' },
      },
      environment: 'di-tenant-alpha',
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            observedGeneration: 1,
            reason: 'Ready',
            message: '',
            lastTransitionTime: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });
    const stock = backingService('stock', 'keyvalue');
    api.seed(stock);
    void classes;
    await controller.tick();
    expect(
      api.objects.has('/apis/apps/v1/namespaces/di-runtime-alpha/deployments/di-bs-stock'),
    ).toBe(true);
    // Transitional tenant path still creates di-nats + di-redis.
    expect(api.objects.has('/apis/apps/v1/namespaces/di-runtime-alpha/deployments/di-nats')).toBe(
      true,
    );
    expect(api.objects.has('/apis/apps/v1/namespaces/di-runtime-alpha/deployments/di-redis')).toBe(
      true,
    );
    const refreshed = api.objects.get(key(stock)) as BackingService | undefined;
    expect(refreshed?.status?.conditions?.[0]?.reason).toBe('Ready');
  });

  it('builds resources with owner labels and fixed images only', () => {
    const t = tenant();
    const cls = seedClass('keyvalue');
    const service = backingService('stock', 'keyvalue');
    const resources = backingServiceResources(service, t, cls, cfg, {
      storage: '1Gi',
      memory: '128Mi',
      cpu: '250m',
    });
    expect(resources.map((r) => r.kind).sort()).toEqual(['Deployment', 'Secret', 'Service']);
    for (const r of resources) {
      expect(r.metadata.labels?.[OWNER]).toBe('stock-uid');
      expect(r.metadata.labels?.[INSTALLATION]).toBe('test');
      expect(r.metadata.labels?.[SERVICE]).toBe('stock');
    }
    const text = JSON.stringify(resources);
    expect(text).toContain('/var/lib/k0s/di-tenants/alpha-uid/bs-stock');
    expect(text).toContain('redis:7.4.5-alpine');
    expect(text).not.toMatch(/nginx:|busybox:|custom-image/);
  });

  it('sets a finalizer and scales down on Retain delete', async () => {
    const { api, controller, t, classes } = prepare();
    const stock = backingService('stock', 'keyvalue');
    api.seed(stock);
    await controller.reconcileBackingService(stock, t, classes);
    expect(stock.metadata.finalizers).toContain(FINALIZER);
    stock.metadata.deletionTimestamp = new Date().toISOString();
    stock.spec.deletionPolicy = 'Retain';
    api.seed(stock);
    await controller.reconcileBackingService(stock, t, classes);
    const dep = api.objects.get(
      '/apis/apps/v1/namespaces/di-runtime-alpha/deployments/di-bs-stock',
    );
    expect(dep && (dep.spec as { replicas: number }).replicas).toBe(0);
    expect(stock.metadata.finalizers).not.toContain(FINALIZER);
  });

  it.each([
    { observedGeneration: 0, replicas: 0 },
    { observedGeneration: 1, replicas: 1 },
  ])('retains the finalizer until scale-down is observed: %j', async (deploymentStatus) => {
    const { api, controller, t, classes } = prepare();
    const stock = backingService('stock', 'keyvalue');
    api.seed(stock);
    await controller.reconcileBackingService(stock, t, classes);
    stock.metadata.deletionTimestamp = new Date().toISOString();
    stock.spec.deletionPolicy = 'Retain';
    api.seed(stock);

    const original = api.call.bind(api);
    api.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const result = await original<T>(method, path, body);
      if (method === 'PATCH' && path.includes('/deployments/di-bs-stock')) {
        (result as Resource).status = deploymentStatus;
      }
      return result;
    };
    await controller.reconcileBackingService(stock, t, classes);
    expect(stock.metadata.finalizers).toContain(FINALIZER);
    expect(stock.status?.conditions?.[0]).toMatchObject({ status: 'False', reason: 'Deleting' });

    api.call = original;
    await controller.reconcileBackingService(stock, t, classes);
    expect(stock.metadata.finalizers).not.toContain(FINALIZER);
  });

  it('releases finalizer on deletion even if the BackingServiceClass was deleted', async () => {
    const { api, controller, t, classes } = prepare();
    const stock = backingService('stock', 'keyvalue');
    api.seed(stock);
    await controller.reconcileBackingService(stock, t, classes);
    expect(stock.metadata.finalizers).toContain(FINALIZER);

    stock.metadata.deletionTimestamp = new Date().toISOString();
    stock.spec.deletionPolicy = 'Retain';
    api.seed(stock);
    // BackingServiceClass is removed from cluster
    await controller.reconcileBackingService(stock, t, []);
    expect(stock.metadata.finalizers).not.toContain(FINALIZER);
  });

  it('handles deletion reported while adding the finalizer before provisioning resources', async () => {
    const { api, controller, t, classes } = prepare();
    const stock = backingService('stock', 'keyvalue');
    stock.spec.deletionPolicy = 'Delete';
    api.seed(stock);
    const original = api.call.bind(api);
    api.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const result = await original<T>(method, path, body);
      if (method === 'PATCH' && path === key(stock)) {
        (result as BackingService).metadata.deletionTimestamp = '2026-09-15T00:00:00Z';
      }
      return result;
    };

    await controller.reconcileBackingService(stock, t, classes);
    expect(stock.metadata.finalizers).not.toContain(FINALIZER);
    expect(
      api.operations.some(
        ({ method, path }) => method === 'PATCH' && path.includes('/namespaces/di-runtime-alpha/'),
      ),
    ).toBe(false);
  });

  it('deletes owned infra when deletionPolicy is Delete', async () => {
    const { api, controller, t, classes } = prepare();
    const stock = backingService('stock', 'keyvalue');
    api.seed(stock);
    await controller.reconcileBackingService(stock, t, classes);
    stock.metadata.deletionTimestamp = new Date().toISOString();
    stock.spec.deletionPolicy = 'Delete';
    api.seed(stock);
    await controller.reconcileBackingService(stock, t, classes);
    expect(
      api.objects.has('/apis/apps/v1/namespaces/di-runtime-alpha/deployments/di-bs-stock'),
    ).toBe(false);
    expect(api.objects.has('/api/v1/namespaces/di-runtime-alpha/services/di-bs-stock')).toBe(false);
    expect(api.objects.has('/api/v1/namespaces/di-runtime-alpha/secrets/di-bs-stock-conn')).toBe(
      false,
    );
    expect(stock.metadata.finalizers).not.toContain(FINALIZER);
  });

  it('scales down when the owning tenant is suspended', async () => {
    const { api, controller, t, classes } = prepare();
    const stock = backingService('stock', 'keyvalue');
    api.seed(stock);
    t.spec.suspended = true;
    await controller.reconcileBackingService(stock, t, classes);
    const dep = api.objects.get(
      '/apis/apps/v1/namespaces/di-runtime-alpha/deployments/di-bs-stock',
    );
    expect(dep && (dep.spec as { replicas: number }).replicas).toBe(0);
    expect(stock.status?.conditions?.[0]?.reason).toBe('Suspended');
  });

  it('rejects class type mismatches', async () => {
    const { api, controller, t } = prepare();
    const wrong = seedClass('messaging', {
      name: 'keyvalue-redis',
      type: 'messaging',
      provider: 'nats',
    });
    const stock = backingService('stock', 'keyvalue', { className: 'keyvalue-redis' });
    api.seed(stock);
    await controller.reconcileBackingService(stock, t, [wrong]);
    expect(stock.status?.conditions?.[0]?.reason).toBe('Failed');
    expect(stock.status?.conditions?.[0]?.message).toContain('does not match');
  });
});
