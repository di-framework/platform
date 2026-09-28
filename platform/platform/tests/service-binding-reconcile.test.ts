import { describe, expect, it } from 'bun:test';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  type BackingService,
  type ControllerConfig,
  CREDENTIAL_STATUS_KEYS,
  FINALIZER,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  type ServiceBinding,
  statusContainsCredentials,
  type Tenant,
  VERSION,
} from '../src/tenancy/resources';
import {
  assertSafeBindingStatus,
  bindingConfigData,
  bindingHostInterfaceProjection,
  bindingProjectionName,
  bindingSecretName,
  electBindingOwner,
  resolveBindingService,
  serviceBindingResources,
  sharedBindingConflict,
} from '../src/tenancy/service-binding-reconcile';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  insecureRegistry: true,
};

function key(value: Resource | Tenant | BackingService | ServiceBinding): string {
  return `${collection(value.apiVersion, value.kind, value.metadata.namespace)}/${value.metadata.name}`;
}

class MemoryApi implements Api {
  objects = new Map<string, Resource>();
  operations: { method: string; path: string }[] = [];
  logSink: string[] = [];
  seed(value: Resource | Tenant | BackingService | ServiceBinding): void {
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

function readyService(
  name: string,
  type: 'keyvalue' | 'messaging',
  opts: { host?: string; port?: number; ready?: boolean } = {},
): BackingService {
  const providerPort = type === 'keyvalue' ? 6379 : 4222;
  const n = names('alpha');
  const host = opts.host ?? `di-bs-${name}.${n.runtimeNamespace}.svc.cluster.local`;
  const port = opts.port ?? providerPort;
  const ready = opts.ready !== false;
  return {
    apiVersion: VERSION,
    kind: 'BackingService',
    metadata: {
      name,
      namespace: n.namespace,
      uid: `${name}-uid`,
      generation: 1,
    },
    spec: { type },
    status: {
      observedGeneration: 1,
      endpoint: { host, port, capability: type },
      runtimeNamespace: n.runtimeNamespace,
      conditions: [
        {
          type: 'Ready',
          status: ready ? 'True' : 'False',
          reason: ready ? 'Ready' : 'Provisioning',
          message: ready ? 'ok' : 'waiting',
          observedGeneration: 1,
          lastTransitionTime: '2020-01-01T00:00:00.000Z',
        },
      ],
    },
  };
}

function binding(
  name: string,
  spec: {
    serviceName: string;
    bindingName: string;
    capability: 'keyvalue' | 'messaging';
    workloadName?: string;
  },
): ServiceBinding {
  return {
    apiVersion: VERSION,
    kind: 'ServiceBinding',
    metadata: {
      name,
      namespace: names('alpha').namespace,
      uid: `${name}-uid`,
      generation: 1,
    },
    spec,
  };
}

function prepare(): { api: MemoryApi; controller: Controller; t: Tenant } {
  const api = new MemoryApi();
  const t = tenant();
  api.seed(t);
  return { api, controller: new Controller(api, cfg), t };
}

describe('service binding helpers', () => {
  it('names projections di-binding-* and describes named hostInterfaces', () => {
    expect(bindingProjectionName('stock')).toBe('di-binding-stock');
    expect(bindingSecretName('stock')).toBe('di-binding-stock-creds');
    expect(
      bindingHostInterfaceProjection({ bindingName: 'stock', capability: 'keyvalue' }),
    ).toEqual({
      name: 'stock',
      namespace: 'wasmcloud',
      package: 'keyvalue',
      configFrom: [{ name: 'di-binding-stock' }],
    });
    expect(
      bindingHostInterfaceProjection({ bindingName: 'sync', capability: 'messaging' }),
    ).toEqual({
      name: 'sync',
      namespace: 'wasmcloud',
      package: 'messaging',
      configFrom: [{ name: 'di-binding-sync' }],
    });
  });

  it('builds redis/nats config without credential keys', () => {
    const kv = binding('orders-stock', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    const msg = binding('orders-sync', {
      serviceName: 'bus',
      bindingName: 'sync',
      capability: 'messaging',
    });
    const redis = bindingConfigData(kv, {
      host: 'di-bs-stock.di-runtime-alpha.svc.cluster.local',
      port: 6379,
      capability: 'keyvalue',
    });
    const nats = bindingConfigData(msg, {
      host: 'di-bs-bus.di-runtime-alpha.svc.cluster.local',
      port: 4222,
      capability: 'messaging',
    });
    expect(redis).toEqual({
      backend: 'redis',
      url: 'redis://di-bs-stock.di-runtime-alpha.svc.cluster.local:6379',
      prefix: 'stock:',
    });
    expect(nats).toEqual({
      backend: 'nats',
      url: 'nats://di-bs-bus.di-runtime-alpha.svc.cluster.local:4222',
    });
    for (const data of [redis, nats]) {
      for (const key of CREDENTIAL_STATUS_KEYS) {
        if (key === 'url') continue; // host plugin url is non-secret for unauthenticated backends
        expect(data).not.toHaveProperty(key);
      }
    }
  });

  it('elects a stable owner and detects shared binding conflicts', () => {
    const a = binding('a-orders', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    const b = binding('b-receive', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    const conflict = binding('c-bad', {
      serviceName: 'other',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    const capConflict = binding('d-cap', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'messaging',
    });
    expect(electBindingOwner('stock', [b, a])?.metadata.name).toBe('a-orders');
    expect(sharedBindingConflict(conflict, [a, b, conflict])).toContain('already bound');
    expect(sharedBindingConflict(capConflict, [a, capConflict])).toContain('capability conflict');
    expect(sharedBindingConflict(a, [a, b])).toBeUndefined();
  });

  it('rejects missing endpoint or endpoint capability mismatch', () => {
    const kv = binding('bind-stock', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    const noEndpoint: BackingService = {
      ...readyService('stock', 'keyvalue'),
      status: {
        observedGeneration: 1,
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'Ready',
            message: 'ok',
            observedGeneration: 1,
            lastTransitionTime: '2020-01-01T00:00:00.000Z',
          },
        ],
      },
    };
    expect(resolveBindingService(kv, noEndpoint)).toEqual({
      error: expect.stringContaining('has no endpoint'),
    });
    const wrongEndpoint = readyService('stock', 'keyvalue');
    wrongEndpoint.status = {
      ...wrongEndpoint.status,
      endpoint: {
        host: 'di-bs-stock.di-runtime-alpha.svc.cluster.local',
        port: 6379,
        capability: 'messaging',
      },
    };
    expect(resolveBindingService(kv, wrongEndpoint)).toEqual({
      error: expect.stringContaining('endpoint capability'),
    });
  });
});

describe('service binding reconciliation', () => {
  it('defers when the BackingService is missing or not Ready', async () => {
    const { api, controller, t } = prepare();
    const missing = binding('bind-missing', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    api.seed(missing);
    await controller.reconcileServiceBinding(missing, t, undefined, [missing]);
    expect(missing.status?.conditions?.[0]?.status).toBe('False');
    expect(missing.status?.conditions?.[0]?.reason).toBe('Failed');
    expect(missing.status?.conditions?.[0]?.message).toContain('not found');
    expect(statusContainsCredentials(missing.status as Record<string, unknown>)).toBe(false);

    const unready = readyService('stock', 'keyvalue', { ready: false });
    const waiting = binding('bind-wait', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    api.seed(unready);
    api.seed(waiting);
    await controller.reconcileServiceBinding(waiting, t, unready, [waiting]);
    expect(waiting.status?.conditions?.[0]?.message).toContain('not Ready');
    expect(api.objects.has('/api/v1/namespaces/di-tenant-alpha/configmaps/di-binding-stock')).toBe(
      false,
    );
  });

  it('fails on capability mismatch', async () => {
    const { api, controller, t } = prepare();
    const service = readyService('stock', 'keyvalue');
    const mismatched = binding('bind-bad', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'messaging',
    });
    api.seed(service);
    api.seed(mismatched);
    await controller.reconcileServiceBinding(mismatched, t, service, [mismatched]);
    expect(mismatched.status?.conditions?.[0]?.reason).toBe('Failed');
    expect(mismatched.status?.conditions?.[0]?.message).toMatch(/does not match/);
    expect(statusContainsCredentials(mismatched.status as Record<string, unknown>)).toBe(false);
  });

  it('projects Ready redis and nats ConfigMaps for named hostInterfaces', async () => {
    const { api, controller, t } = prepare();
    const stock = readyService('stock', 'keyvalue');
    const bus = readyService('bus', 'messaging');
    const kv = binding('bind-stock', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    const msg = binding('bind-sync', {
      serviceName: 'bus',
      bindingName: 'sync',
      capability: 'messaging',
    });
    api.seed(stock);
    api.seed(bus);
    api.seed(kv);
    api.seed(msg);
    await controller.reconcileServiceBinding(kv, t, stock, [kv, msg]);
    await controller.reconcileServiceBinding(msg, t, bus, [kv, msg]);

    const redisCm = api.objects.get(
      '/api/v1/namespaces/di-tenant-alpha/configmaps/di-binding-stock',
    );
    const natsCm = api.objects.get('/api/v1/namespaces/di-tenant-alpha/configmaps/di-binding-sync');
    expect(redisCm?.data).toEqual({
      backend: 'redis',
      url: 'redis://di-bs-stock.di-runtime-alpha.svc.cluster.local:6379',
      prefix: 'stock:',
    });
    expect(natsCm?.data).toEqual({
      backend: 'nats',
      url: 'nats://di-bs-bus.di-runtime-alpha.svc.cluster.local:4222',
    });
    expect(redisCm?.metadata.labels?.[OWNER]).toBe('bind-stock-uid');
    expect(kv.status?.conditions?.[0]).toMatchObject({ status: 'True', reason: 'Ready' });
    expect(msg.status?.conditions?.[0]).toMatchObject({ status: 'True', reason: 'Ready' });
    expect(kv.status?.serviceRef).toEqual({
      name: 'stock',
      uid: 'stock-uid',
      generation: 1,
    });
    expect(statusContainsCredentials(kv.status as Record<string, unknown>)).toBe(false);
    expect(statusContainsCredentials(msg.status as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(kv.status)).not.toMatch(/password|token|credential/i);
    expect(JSON.stringify(msg.status)).not.toMatch(/password|token|credential/i);
  });

  it('updates projected url when the BackingService endpoint changes', async () => {
    const { api, controller, t } = prepare();
    const stock = readyService('stock', 'keyvalue');
    const kv = binding('bind-stock', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    api.seed(stock);
    api.seed(kv);
    await controller.reconcileServiceBinding(kv, t, stock, [kv]);
    stock.status = {
      ...stock.status,
      endpoint: {
        host: 'di-bs-stock.di-runtime-alpha.svc.cluster.local',
        port: 6380,
        capability: 'keyvalue',
      },
    };
    stock.metadata.generation = 2;
    api.seed(stock);
    await controller.reconcileServiceBinding(kv, t, stock, [kv]);
    const cm = api.objects.get('/api/v1/namespaces/di-tenant-alpha/configmaps/di-binding-stock');
    expect((cm?.data as Record<string, string> | undefined)?.url).toBe(
      'redis://di-bs-stock.di-runtime-alpha.svc.cluster.local:6380',
    );
    expect(kv.status?.serviceRef?.generation).toBe(2);
  });

  it('shares one projection across peers and retains it until the last is revoked', async () => {
    const { api, controller, t } = prepare();
    const stock = readyService('stock', 'keyvalue');
    const receive = binding('receive', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
      workloadName: 'receive',
    });
    const take = binding('take', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
      workloadName: 'take',
    });
    api.seed(stock);
    api.seed(receive);
    api.seed(take);
    await controller.reconcileServiceBinding(receive, t, stock, [receive, take]);
    await controller.reconcileServiceBinding(take, t, stock, [receive, take]);
    const cm = api.objects.get('/api/v1/namespaces/di-tenant-alpha/configmaps/di-binding-stock');
    // Lexicographic owner is "receive".
    expect(cm?.metadata.labels?.[OWNER]).toBe('receive-uid');
    expect(receive.metadata.finalizers).toContain(FINALIZER);

    take.metadata.deletionTimestamp = new Date().toISOString();
    api.seed(take);
    await controller.reconcileServiceBinding(take, t, stock, [receive, take]);
    expect(api.objects.has('/api/v1/namespaces/di-tenant-alpha/configmaps/di-binding-stock')).toBe(
      true,
    );
    expect(take.metadata.finalizers).not.toContain(FINALIZER);
    expect(take.status?.conditions?.[0]?.reason).toBe('Deleting');

    receive.metadata.deletionTimestamp = new Date().toISOString();
    api.seed(receive);
    await controller.reconcileServiceBinding(receive, t, stock, [receive, take]);
    expect(api.objects.has('/api/v1/namespaces/di-tenant-alpha/configmaps/di-binding-stock')).toBe(
      false,
    );
    expect(receive.metadata.finalizers).not.toContain(FINALIZER);
  });

  it('survives revocation of the elected owner when peers remain', async () => {
    const { api, controller, t } = prepare();
    const stock = readyService('stock', 'keyvalue');
    const receive = binding('receive', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
      workloadName: 'receive',
    });
    const take = binding('take', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
      workloadName: 'take',
    });
    api.seed(stock);
    api.seed(receive);
    api.seed(take);
    await controller.reconcileServiceBinding(receive, t, stock, [receive, take]);
    await controller.reconcileServiceBinding(take, t, stock, [receive, take]);

    // Delete the elected owner 'receive' first
    receive.metadata.deletionTimestamp = new Date().toISOString();
    api.seed(receive);
    await controller.reconcileServiceBinding(receive, t, stock, [receive, take]);
    expect(api.objects.has('/api/v1/namespaces/di-tenant-alpha/configmaps/di-binding-stock')).toBe(
      true,
    );

    // Surviving peer 'take' must reconcile and adopt the projection successfully
    await controller.reconcileServiceBinding(take, t, stock, [receive, take]);
    expect(take.status?.conditions?.[0]?.status).toBe('True');
    const cm = api.objects.get('/api/v1/namespaces/di-tenant-alpha/configmaps/di-binding-stock');
    expect(cm?.metadata.labels?.[OWNER]).toBe('take-uid');
  });

  it('projects credentials only into a Secret and never into status', async () => {
    const { api, controller, t } = prepare();
    const stock = readyService('stock', 'keyvalue');
    const kv = binding('bind-stock', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    api.seed(stock);
    api.seed(kv);
    api.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'di-bs-stock-conn',
        namespace: names('alpha').runtimeNamespace,
        labels: { [INSTALLATION]: 'test' },
      },
      stringData: {
        backend: 'redis',
        url: 'redis://di-bs-stock.di-runtime-alpha.svc.cluster.local:6379',
        password: 'super-secret-password',
      },
    } as Resource);
    await controller.reconcileServiceBinding(kv, t, stock, [kv]);
    const secret = api.objects.get(
      '/api/v1/namespaces/di-tenant-alpha/secrets/di-binding-stock-creds',
    );
    expect(secret?.stringData).toEqual({ password: 'super-secret-password' });
    expect(statusContainsCredentials(kv.status as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(kv.status)).not.toContain('super-secret-password');
    expect(() => assertSafeBindingStatus({ password: 'nope' } as Record<string, unknown>)).toThrow(
      /credential/,
    );
  });

  it('builds desired resources with deterministic labels for deploy helpers', () => {
    const t = tenant();
    const kv = binding('bind-stock', {
      serviceName: 'stock',
      bindingName: 'stock',
      capability: 'keyvalue',
    });
    const resources = serviceBindingResources(
      kv,
      t,
      cfg,
      {
        host: 'di-bs-stock.di-runtime-alpha.svc.cluster.local',
        port: 6379,
        capability: 'keyvalue',
      },
      'bind-stock-uid',
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]?.metadata.name).toBe('di-binding-stock');
    expect(resources[0]?.metadata.namespace).toBe('di-tenant-alpha');
    expect(resolveBindingService(kv, readyService('stock', 'keyvalue'))).toMatchObject({
      endpoint: { port: 6379 },
    });
  });
});
