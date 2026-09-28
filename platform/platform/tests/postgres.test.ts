import { describe, expect, test } from 'bun:test';
import { hostInterfaceAllowed } from '../src/tenancy/admission';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  POSTGRES_BOOTSTRAP,
  postgresNames,
  postgresReadiness,
  secretData,
} from '../src/tenancy/postgres';
import {
  type BackingService,
  type BackingServiceClass,
  type ControllerConfig,
  defaultClassSeed,
  FINALIZER,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  type ServiceBinding,
  type Tenant,
  VERSION,
} from '../src/tenancy/resources';
import {
  bindingHostInterfaceProjections,
  bindingSecretName,
  connectionUrl,
} from '../src/tenancy/service-binding-reconcile';

const cfg: ControllerConfig = {
  installation: 'pg-test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  insecureRegistry: true,
};
const tenant: Tenant = {
  apiVersion: VERSION,
  kind: 'Tenant',
  metadata: { name: 'alpha', uid: 'tenant-uid' },
  spec: { resources: { cpu: '2', memory: '4Gi' } },
};
const cls: BackingServiceClass = {
  apiVersion: VERSION,
  kind: 'BackingServiceClass',
  metadata: { name: 'postgres-dedicated', uid: 'class-uid' },
  spec: defaultClassSeed('postgres'),
};
const ns = names('alpha').runtimeNamespace;
function service(name = 'orders', uid = 'orders-uid'): BackingService {
  return {
    apiVersion: VERSION,
    kind: 'BackingService',
    metadata: { name, namespace: names('alpha').namespace, uid, generation: 1 },
    spec: { type: 'postgres' },
  };
}
function key(r: {
  apiVersion: string;
  kind: string;
  metadata: { namespace?: string; name: string };
}): string {
  return `${collection(r.apiVersion, r.kind, r.metadata.namespace)}/${r.metadata.name}`;
}
class MemoryApi implements Api {
  objects = new Map<string, Resource>();
  pending = false;
  delayedDelete = new Set<string>();
  failCreate = false;
  seed(r: unknown) {
    const resource = structuredClone(r) as Resource;
    this.objects.set(key(resource), resource);
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, 'https://test');
    if (method === 'GET' && url.searchParams.has('labelSelector')) {
      const labels = url.searchParams
        .get('labelSelector')!
        .split(',')
        .filter(Boolean)
        .map((x) => x.split('='));
      return {
        items: [...this.objects.values()].filter(
          (r) =>
            collection(r.apiVersion, r.kind) === url.pathname &&
            labels.every(([k, v]) => r.metadata.labels?.[k!] === v),
        ),
      } as T;
    }
    const data = structuredClone(body) as Resource;
    const target =
      method === 'POST'
        ? `${url.pathname}/${data.metadata.name}`
        : url.pathname.replace(/\/status$/, '');
    const existing = this.objects.get(target);
    if (method === 'GET') {
      if (!existing) throw new ApiError(404, 'Missing');
      return structuredClone(existing) as T;
    }
    if (method === 'DELETE') {
      if (!this.delayedDelete.has(target)) this.objects.delete(target);
      return {} as T;
    }
    if (method === 'POST' && this.failCreate) throw new ApiError(500, 'API unavailable');
    if (method === 'POST' && existing) throw new ApiError(409, 'Conflict');
    const value = {
      ...existing,
      ...data,
      metadata: { ...existing?.metadata, ...data.metadata },
      ...(data.spec ? { spec: { ...(existing?.spec as object), ...(data.spec as object) } } : {}),
    } as Resource;
    value.metadata.uid ??= `${value.metadata.name}-uid`;
    value.metadata.generation ??= 1;
    if (value.kind === 'Deployment')
      value.status = {
        observedGeneration: 1,
        readyReplicas: (value.spec as { replicas: number }).replicas,
        replicas: (value.spec as { replicas: number }).replicas,
      };
    if (value.kind === 'PersistentVolumeClaim')
      value.status = { phase: this.pending ? 'Pending' : 'Bound' };
    this.objects.set(target, value);
    return structuredClone(value) as T;
  }
}
function setup(s = service()) {
  const api = new MemoryApi();
  api.seed(s);
  const controller = new Controller(api, cfg);
  return {
    api,
    controller,
    s,
    reconcile: (t = tenant, c = cls) => controller.reconcileBackingService(s, t, [c]),
    get: (kind: string, name: string, namespace = ns) =>
      api.objects.get(
        `${collection(kind === 'Deployment' ? 'apps/v1' : 'v1', kind, namespace)}/${name}`,
      ),
  };
}
function condition(s: BackingService) {
  return s.status?.conditions?.[0];
}

describe('dedicated PostgreSQL', () => {
  test('provisions authenticated PVC-backed instances and reuses credentials after suspension', async () => {
    const t = setup();
    const n = postgresNames(t.s);
    await t.reconcile();
    expect(condition(t.s)?.status).toBe('True');
    const credentials = secretData(t.get('Secret', n.credentials)!);
    const conn = secretData(t.get('Secret', n.connection)!);
    expect(credentials.APP_PASSWORD).not.toBe(credentials.POSTGRES_PASSWORD);
    expect(conn.url).toContain('postgresql://app:');
    expect(conn.url).not.toContain(credentials.POSTGRES_PASSWORD!);
    const deployment = t.get('Deployment', n.instance)!;
    expect(
      (deployment.spec as any).template.metadata.labels['platform.di-framework.dev/component'],
    ).toBe('backing-service');
    expect(
      (deployment.spec as any).template.spec.containers[0].readinessProbe.exec.command.join(' '),
    ).toContain('PGPASSWORD');
    await t.reconcile({ ...tenant, spec: { ...tenant.spec, suspended: true } });
    expect(condition(t.s)?.reason).toBe('Suspended');
    expect((t.get('Deployment', n.instance)!.spec as any).replicas).toBe(0);
    await t.reconcile();
    expect(secretData(t.get('Secret', n.credentials)!)).toEqual(credentials);
    expect(t.get('PersistentVolumeClaim', n.pvc)).toBeDefined();
    expect(JSON.stringify(t.s.status)).not.toContain(credentials.APP_PASSWORD!);
  });
  test('refuses missing credentials on an existing PVC and retries recoverable failures', async () => {
    const t = setup();
    const n = postgresNames(t.s);
    await t.reconcile();
    const saved = t.get('Secret', n.credentials)!;
    t.api.objects.delete(key(saved));
    await t.reconcile();
    expect(condition(t.s)?.message).toContain('CredentialsMissing');
    expect(t.get('Secret', n.credentials)).toBeUndefined();
    t.api.seed(saved);
    await t.reconcile();
    expect(condition(t.s)?.status).toBe('True');
    t.api.seed({ ...saved, stringData: { POSTGRES_PASSWORD: 'only-one' } });
    await t.reconcile();
    expect(condition(t.s)?.message).toContain('restore both passwords');
  });
  test('reports pending volumes and initialization failures', async () => {
    const t = setup();
    t.api.pending = true;
    await t.reconcile();
    expect(condition(t.s)?.reason).toBe('StoragePending');
    const pvc = t.get('PersistentVolumeClaim', postgresNames(t.s).pvc)!;
    pvc.status = { phase: 'Bound' };
    const pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'failed',
        namespace: ns,
        labels: { [INSTALLATION]: cfg.installation, [OWNER]: t.s.metadata.uid! },
      },
      status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
    };
    t.api.seed(pod);
    await t.reconcile();
    expect(condition(t.s)?.reason).toBe('InitializationFailed');
    expect(postgresReadiness(pvc, [], []).reason).toBe('Initializing');
    expect(
      postgresReadiness(
        pvc,
        [],
        [{ ...pod, status: { containerStatuses: [{ state: { terminated: { exitCode: 1 } } }] } }],
      ).reason,
    ).toBe('InitializationFailed');
  });
  test('preserves the selected storage class, rejects shrinking and checks expansion support', async () => {
    const t = setup();
    const custom = { ...cls, spec: { ...cls.spec, storageClassName: 'fast' } };
    await t.reconcile(tenant, custom);
    const n = postgresNames(t.s);
    expect((t.get('PersistentVolumeClaim', n.pvc)!.spec as any).storageClassName).toBe('fast');
    await t.reconcile(tenant, {
      ...custom,
      spec: { ...custom.spec, storageClassName: 'different' },
    });
    expect((t.get('PersistentVolumeClaim', n.pvc)!.spec as any).storageClassName).toBe('fast');
    t.s.spec.parameters = { storage: '512Mi' };
    await t.reconcile();
    expect(condition(t.s)?.message).toContain('StorageShrinkForbidden');
    t.s.spec.parameters = { storage: '2Gi' };
    await t.reconcile();
    expect(condition(t.s)?.message).toContain('StorageExpansionUnsupported');
    t.api.seed({
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'fast' },
      allowVolumeExpansion: true,
    });
    await t.reconcile();
    expect(condition(t.s)?.status).toBe('True');
    expect((t.get('PersistentVolumeClaim', n.pvc)!.spec as any).resources.requests.storage).toBe(
      '2Gi',
    );
  });
  test('refuses foreign resources and reports credential creation failures', async () => {
    const t = setup();
    const n = postgresNames(t.s);
    t.api.failCreate = true;
    await t.reconcile();
    expect(condition(t.s)?.message).toContain('API unavailable');
    t.api.failCreate = false;
    await t.reconcile();
    const secret = t.get('Secret', n.credentials)!;
    secret.metadata.labels![OWNER] = 'foreign';
    await t.reconcile();
    expect(condition(t.s)?.message).toContain('Refusing to adopt');
    secret.metadata.labels![OWNER] = t.s.metadata.uid!;
    t.get('PersistentVolumeClaim', n.pvc)!.metadata.labels![OWNER] = 'foreign';
    await t.reconcile();
    expect(condition(t.s)?.message).toContain('Refusing to adopt');
  });
  test.each(['Retain', 'Delete'] as const)(
    '%s waits for bindings and pod termination, then applies retention',
    async (policy) => {
      const t = setup();
      const n = postgresNames(t.s);
      t.s.spec.deletionPolicy = policy;
      await t.reconcile();
      const binding: ServiceBinding = {
        apiVersion: VERSION,
        kind: 'ServiceBinding',
        metadata: {
          name: 'orders-client',
          namespace: names('alpha').namespace,
          uid: 'binding-uid',
        },
        spec: { bindingName: 'orders-db', serviceName: 'orders', capability: 'postgres' },
      };
      t.api.seed(binding);
      await t.controller.reconcileServiceBinding(binding, tenant, t.s, [binding]);
      const projected = t.get('Secret', bindingSecretName('orders-db'), names('alpha').namespace)!;
      expect(Object.keys(secretData(projected))).toEqual(['url']);
      t.s.metadata.deletionTimestamp = new Date().toISOString();
      await t.reconcile();
      expect(condition(t.s)?.reason).toBe('DeletionBlocked');
      expect((t.get('Deployment', n.instance)!.spec as any).replicas).toBe(1);
      await t.controller.reconcileServiceBinding(binding, tenant, t.s, [binding]);
      expect(binding.status?.conditions?.[0]?.status).toBe('True');
      const fresh: ServiceBinding = {
        ...binding,
        metadata: { ...binding.metadata, name: 'new-client', uid: 'new-uid' },
        status: undefined,
      };
      t.api.seed(fresh);
      await t.controller.reconcileServiceBinding(fresh, tenant, t.s, [binding, fresh]);
      expect(fresh.status?.conditions?.[0]?.message).toContain('deleting');
      await t.controller.reconcileServiceBinding(fresh, tenant, t.s, [binding, fresh]);
      expect(fresh.status?.conditions?.[0]?.message).toContain('deleting');
      t.api.objects.delete(key(fresh));
      t.api.objects.delete(key(binding));
      const pod = {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: 'terminating',
          namespace: ns,
          labels: { [OWNER]: t.s.metadata.uid!, [INSTALLATION]: cfg.installation },
          deletionTimestamp: 'now',
        },
      };
      t.api.seed(pod);
      await t.reconcile();
      expect(t.s.metadata.finalizers).toContain(FINALIZER);
      expect(t.get('PersistentVolumeClaim', n.pvc)).toBeDefined();
      t.api.objects.delete(key(pod));
      const pvcKey = key(t.get('PersistentVolumeClaim', n.pvc)!);
      if (policy === 'Delete') t.api.delayedDelete.add(pvcKey);
      await t.reconcile();
      if (policy === 'Delete') {
        expect(t.s.metadata.finalizers).toContain(FINALIZER);
        t.api.delayedDelete.clear();
        await t.reconcile();
      }
      expect(t.s.metadata.finalizers).not.toContain(FINALIZER);
      expect(t.get('Deployment', n.instance)).toBeUndefined();
      expect(!!t.get('PersistentVolumeClaim', n.pvc)).toBe(policy === 'Retain');
      expect(!!t.get('Secret', n.credentials)).toBe(policy === 'Retain');
      expect(postgresNames(service('orders', 'replacement-uid')).pvc).not.toBe(n.pvc);
      expect(postgresNames(service('orders', 'replacement-uid')).credentials).not.toBe(
        n.credentials,
      );
    },
  );
  test('bootstrap is rerunnable without password replacement or superuser application roles', () => {
    expect(POSTGRES_BOOTSTRAP).toContain('WHERE NOT EXISTS');
    expect(POSTGRES_BOOTSTRAP).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION');
    expect(POSTGRES_BOOTSTRAP).not.toContain('ALTER ROLE');
    expect(POSTGRES_BOOTSTRAP).toContain('PGPASSWORD="$APP_PASSWORD"');
  });
  test('admits only exact managed named query/prepared Secret references and shared types', () => {
    const base = { namespace: 'wasmcloud', package: 'postgres' };
    expect(hostInterfaceAllowed({ ...base, interfaces: ['types'] })).toBe(true);
    for (const iface of ['query', 'prepared']) {
      const entry = {
        ...base,
        name: `orders-db-${iface}`,
        interfaces: [iface],
        secretFrom: [{ name: 'di-binding-orders-db-creds' }],
      };
      expect(hostInterfaceAllowed(entry)).toBe(true);
      expect(hostInterfaceAllowed({ ...entry, config: { url: 'postgres://x' } })).toBe(false);
      expect(
        hostInterfaceAllowed({ ...entry, secretFrom: [{ name: 'di-binding-other-creds' }] }),
      ).toBe(false);
      expect(
        hostInterfaceAllowed({ ...entry, configFrom: [{ name: 'di-binding-orders-db' }] }),
      ).toBe(false);
      expect(hostInterfaceAllowed({ ...entry, interfaces: ['types'] })).toBe(false);
      expect(hostInterfaceAllowed({ ...entry, name: 'wrong' })).toBe(false);
    }
    expect(hostInterfaceAllowed({ ...base, interfaces: ['query'] })).toBe(false);
  });
});

test('decodes live API Secret data without publishing credentials', () => {
  expect(
    secretData({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'auth' },
      data: { APP_PASSWORD: Buffer.from('test-password').toString('base64') },
    }),
  ).toEqual({ APP_PASSWORD: 'test-password' });
  expect(secretData({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'empty' } })).toEqual({});
});

test('projects PostgreSQL callable interfaces without a standalone database connection', () => {
  const entries = bindingHostInterfaceProjections({
    bindingName: 'orders-db',
    capability: 'postgres',
  });
  expect(entries.map((e) => e.name)).toEqual(['orders-db-query', 'orders-db-prepared']);
  expect(entries.every((e) => e.secretFrom?.[0]?.name === 'di-binding-orders-db-creds')).toBe(true);
  expect(
    bindingHostInterfaceProjections({ bindingName: 'cache', capability: 'keyvalue' }),
  ).toHaveLength(1);
  expect(() =>
    connectionUrl({ host: 'host', port: 5432, capability: 'postgres' }, 'postgres'),
  ).toThrow('runtime credentials');
});
