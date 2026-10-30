import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  type ControllerConfig,
  FINALIZER,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  type Tenant,
  VERSION,
} from '../src/tenancy/resources';
import {
  SCHEDULER_IDENTITY_PENDING,
  TENANT_HOST_SECRET,
} from '../src/tenancy/scheduler-identities';
import {
  bootstrapSchedulerPki,
  IDENTITIES_KEY,
  parseIdentityRecord,
  SCHEDULER_IDENTITIES,
} from '../src/tenancy/scheduler-pki';

// #541 m6c: the controller's tick issues tenant scheduler identities and never loops on its own
// writes (design-541 §4.5).

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
};
const PKI = 'wasmcloud-scheduler-pki';
const RUNTIME = names('alpha').runtimeNamespace;
const recordPath = `/api/v1/namespaces/${PKI}/configmaps/${SCHEDULER_IDENTITIES}`;
const hostPath = `/api/v1/namespaces/${RUNTIME}/secrets/${TENANT_HOST_SECRET}`;
const operatorPath = '/api/v1/namespaces/di-operator-alpha/secrets/di-scheduler-operator-tls';
const tenantPath = `${collection(VERSION, 'Tenant')}/alpha`;
const START = new Date('2026-10-30T00:00:00Z');
const clock = { now: START };

const key = (v: { apiVersion: string; kind: string; metadata: Resource['metadata'] }) =>
  `${collection(v.apiVersion, v.kind, v.metadata.namespace)}/${v.metadata.name}`;

/** An in-memory API server for the controller's tick and the bootstrap's create and update calls. */
class MemoryApi implements Api {
  objects = new Map<string, Resource>();
  operations: { method: string; path: string; body?: unknown }[] = [];
  private version = 1;
  seed(value: Resource | Tenant): void {
    this.objects.set(key(value), {
      ...structuredClone(value),
      metadata: { ...value.metadata, resourceVersion: String(this.version++) },
    } as Resource);
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.operations.push({ method, path, body });
    const url = new URL(path, 'https://kubernetes');
    const data = structuredClone(body) as Resource;
    const notFound = () => new ApiError(404, 'Not found');
    if (method === 'GET' && url.searchParams.has('labelSelector')) {
      const selector = url.searchParams.get('labelSelector') ?? '';
      const labels = selector ? selector.split(',').map((v) => v.split('=')) : [];
      return {
        items: [...this.objects.values()]
          .filter(
            (v) =>
              (collection(v.apiVersion, v.kind) === url.pathname ||
                collection(v.apiVersion, v.kind, v.metadata.namespace) === url.pathname) &&
              labels.every(([k, x]) => v.metadata.labels?.[k as string] === x),
          )
          .map(({ apiVersion: _v, kind: _k, ...item }) => structuredClone(item)),
      } as T;
    }
    const target = url.pathname.replace(/\/status$/, '');
    const existing = this.objects.get(target);
    if (method === 'GET') {
      if (!existing) throw notFound();
      return structuredClone(existing) as T;
    }
    if (method === 'DELETE') {
      if (!existing) throw notFound();
      this.objects.delete(target);
      return {} as T;
    }
    const stamp = (value: Resource) => {
      value.metadata.resourceVersion = String(this.version++);
      this.objects.set(key(value), value);
      return structuredClone(value) as T;
    };
    if (method === 'POST') return stamp(data);
    if (method === 'PUT') {
      if (!existing) throw notFound();
      if (data.metadata.resourceVersion !== existing.metadata.resourceVersion)
        throw new ApiError(409, 'Conflict');
      return stamp(data);
    }
    if (method === 'PATCH') {
      const rv = data.metadata?.resourceVersion;
      if (existing && rv && rv !== existing.metadata.resourceVersion)
        throw new ApiError(409, 'Conflict');
      const value = {
        ...existing,
        ...data,
        metadata: { ...existing?.metadata, ...data.metadata },
        ...(path.split('?')[0]?.endsWith('/status')
          ? { status: { ...(existing?.status as object), ...(data.status as object) } }
          : {}),
      } as Resource;
      value.metadata.uid ??= `${value.metadata.name}-uid`;
      value.metadata.generation ??= 1;
      if (value.kind === 'Deployment')
        value.status = {
          observedGeneration: value.metadata.generation,
          replicas: (value.spec as { replicas: number }).replicas,
        };
      return stamp(value);
    }
    throw new Error(`Unexpected ${method}`);
  }
  /**
   * Writes of the identity record, the identity Secrets and the handled rotation. The controller's
   * own Tenant status write is not counted: whether it repeats depends on how this fake orders
   * status keys, not on issuance; the conditions issuance returns are stable (unit tests).
   */
  identityWrites(): string[] {
    return this.operations
      .filter(
        (o) =>
          o.method !== 'GET' &&
          (o.path === recordPath ||
            o.path.includes(TENANT_HOST_SECRET) ||
            (o.method === 'POST' && o.path.endsWith('/secrets')) ||
            (o.path === `${tenantPath}/status` &&
              !Object.hasOwn((o.body as { status: object }).status, 'conditions'))),
      )
      .map((o) => `${o.method} ${o.path}`);
  }
}

function tenant(): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec: {},
  };
}

async function prepare(options: { pki: boolean }) {
  const api = new MemoryApi();
  api.seed(tenant());
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'wasmcloud-runtime-tls', namespace: cfg.namespace },
    data: { 'ca.crt': 'test' },
  });
  api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: PKI } });
  if (options.pki) await bootstrapSchedulerPki(api, cfg, START);
  const controller = new Controller(
    api,
    cfg,
    async () => [],
    () => clock.now,
  );
  return { api, controller };
}
const stored = (api: MemoryApi) => api.objects.get(tenantPath) as unknown as Tenant;
const condition = (api: MemoryApi, type: string) =>
  stored(api).status?.conditions?.find((c) => c.type === type);

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  clock.now = START;
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('controller tick: tenant scheduler identities (#541 m6c)', () => {
  it('issues once and then writes neither the identity, the record nor the rotation over many ticks', async () => {
    const { api, controller } = await prepare({ pki: true });
    await controller.tick();
    const record = parseIdentityRecord(
      (api.objects.get(recordPath) as unknown as { data: Record<string, string> }).data[
        IDENTITIES_KEY
      ] as string,
    );
    expect(record['tenant/alpha/hosts']?.current).toMatch(/^[0-9a-f]{16}$/);
    expect(api.objects.get(hostPath)?.metadata.labels?.[OWNER]).toBe('alpha-uid');
    expect(condition(api, SCHEDULER_IDENTITY_PENDING)).toBeUndefined();
    // The first tick wrote the record, the Secret and the status; let one more settle the status.
    await controller.tick();
    api.operations.length = 0;
    for (let i = 0; i < 6; i++) await controller.tick();
    expect(api.identityWrites()).toEqual([]);
  });

  it('reports SchedulerIdentityPending on the Tenant while the CA is missing, writing nothing else and logging once', async () => {
    const { api, controller } = await prepare({ pki: false });
    await controller.tick();
    expect(condition(api, SCHEDULER_IDENTITY_PENDING)).toMatchObject({
      status: 'True',
      reason: 'CaNotReady',
    });
    await controller.tick();
    api.operations.length = 0;
    for (let i = 0; i < 6; i++) await controller.tick();
    expect(api.identityWrites()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps issuing and renewing for a suspended Tenant, whose operator keeps running', async () => {
    const { api, controller } = await prepare({ pki: true });
    const t = stored(api);
    t.spec.suspended = true;
    api.seed(t);
    api.seed({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'di-operator-alpha',
        labels: { [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' },
      },
    });
    await controller.tick();
    expect(api.objects.has(hostPath)).toBe(true);
    expect(api.objects.has(operatorPath)).toBe(true);
    const id = parseIdentityRecord(
      (api.objects.get(recordPath) as unknown as { data: Record<string, string> }).data[
        IDENTITIES_KEY
      ] as string,
    )['tenant/alpha/operator']?.current;
    clock.now = new Date(START.getTime() + 61 * 86_400_000);
    await controller.tick();
    const renewed = parseIdentityRecord(
      (api.objects.get(recordPath) as unknown as { data: Record<string, string> }).data[
        IDENTITIES_KEY
      ] as string,
    )['tenant/alpha/operator'];
    expect(renewed?.previous).toBe(id as string);
    expect(renewed?.current).not.toBe(id as string);
  });

  it('keeps the handled rotation in the status it writes', async () => {
    const { api, controller } = await prepare({ pki: true });
    const t = stored(api);
    t.metadata.annotations = { 'platform.di-framework.dev/rotate-scheduler-identity': 'r1' };
    api.seed(t);
    await controller.tick();
    expect(stored(api).status?.schedulerIdentity).toEqual({ hosts: 'r1' });
    await controller.tick();
    api.operations.length = 0;
    for (let i = 0; i < 3; i++) await controller.tick();
    expect(api.identityWrites()).toEqual([]);
    expect(stored(api).status?.schedulerIdentity).toEqual({ hosts: 'r1' });
    // Every status the controller writes after the rotation carries the handled value.
    const statusWrites = api.operations.filter(
      (o) => o.method === 'PATCH' && o.path === `${tenantPath}/status`,
    );
    expect(statusWrites.length).toBeGreaterThan(0);
    for (const write of statusWrites)
      expect((write.body as { status: Record<string, unknown> }).status.schedulerIdentity).toEqual({
        hosts: 'r1',
      });
  });

  it('drops the record entries and deletes the hosts identity during removal, never a foreign Secret', async () => {
    // Ours; another installation's; and (S6) ours by installation and owner but without the
    // scheduler-identity component label.
    for (const labels of <(Record<string, string> | undefined)[]>[
      undefined,
      { [INSTALLATION]: 'other' },
      { [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' },
    ]) {
      const foreign = labels !== undefined;
      const { api, controller } = await prepare({ pki: true });
      await controller.tick();
      if (labels) (api.objects.get(hostPath) as Resource).metadata.labels = labels;
      const t = stored(api);
      t.metadata.deletionTimestamp = START.toISOString();
      api.seed(t);
      for (let i = 0; i < 6 && stored(api)?.metadata.finalizers?.includes(FINALIZER); i++)
        await controller.tick();
      const record = parseIdentityRecord(
        (api.objects.get(recordPath) as unknown as { data: Record<string, string> }).data[
          IDENTITIES_KEY
        ] as string,
      );
      expect(Object.keys(record).filter((k) => k.startsWith('tenant/'))).toEqual([]);
      expect(api.objects.has(hostPath)).toBe(foreign);
    }
  });
});
