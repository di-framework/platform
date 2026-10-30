import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  type ControllerConfig,
  FINALIZER,
  INSTALLATION,
  OWNER,
  type Resource,
  type Tenant,
  VERSION,
} from '../src/tenancy/resources';
import { SchedulerAccountsWriter } from '../src/tenancy/scheduler-accounts';
import {
  ACCOUNTS_KEY,
  REFUSED_FOR_OTHER,
  SCHEDULER_ACCOUNTS_CONDITION,
  SCHEDULER_NATS_ACCOUNTS,
} from '../src/tenancy/scheduler-nats';
import {
  bootstrapSchedulerPki,
  IDENTITIES_KEY,
  type IdentityRecord,
  parseIdentityRecord,
  SCHEDULER_IDENTITIES,
  serializeIdentityRecord,
} from '../src/tenancy/scheduler-pki';

// #541 m6d: the controller's tick renders `di-scheduler-nats-accounts` from the Tenant list and the
// identity record, writes it only when it changed, and refuses a render the m2 validation rejects
// (design-541 §4.4). The in-memory API server is the m6c test's.

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
};
const PKI = 'wasmcloud-scheduler-pki';
const recordPath = `/api/v1/namespaces/${PKI}/configmaps/${SCHEDULER_IDENTITIES}`;
const accountsPath = `/api/v1/namespaces/${cfg.namespace}/configmaps/${SCHEDULER_NATS_ACCOUNTS}`;
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
  /** Writes of the accounts ConfigMap. */
  accountsWrites(): string[] {
    return this.operations
      .filter(
        (o) =>
          o.method !== 'GET' &&
          (o.path === accountsPath ||
            (o.method === 'POST' && o.path === `/api/v1/namespaces/${cfg.namespace}/configmaps`)),
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

async function prepare() {
  const api = new MemoryApi();
  api.seed(tenant());
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'wasmcloud-runtime-tls', namespace: cfg.namespace },
    data: { 'ca.crt': 'test' },
  });
  api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: PKI } });
  await bootstrapSchedulerPki(api, cfg, START);
  const controller = new Controller(
    api,
    cfg,
    async () => [],
    () => clock.now,
  );
  return { api, controller };
}
const stored = (api: MemoryApi) => api.objects.get(tenantPath) as unknown as Tenant;
const condition = (api: MemoryApi) =>
  stored(api).status?.conditions?.find((c) => c.type === SCHEDULER_ACCOUNTS_CONDITION);
const file = (api: MemoryApi) =>
  (api.objects.get(accountsPath) as unknown as { data: Record<string, string> } | undefined)?.data[
    ACCOUNTS_KEY
  ];
const record = (api: MemoryApi): IdentityRecord =>
  parseIdentityRecord(
    (api.objects.get(recordPath) as unknown as { data: Record<string, string> }).data[
      IDENTITIES_KEY
    ] as string,
  );
const setRecord = (api: MemoryApi, value: IdentityRecord) => {
  (api.objects.get(recordPath) as unknown as { data: Record<string, string> }).data[
    IDENTITIES_KEY
  ] = serializeIdentityRecord(value);
};
const users = (text: string | undefined) =>
  [...(text ?? '').matchAll(/user: "([^"]+)"/g)].map((m) => m[1] as string);
const ownOperatorNamespace = (api: MemoryApi) =>
  api.seed({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: 'di-operator-alpha',
      labels: { [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' },
    },
  });

let warn: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  clock.now = START;
  warn = spyOn(console, 'warn').mockImplementation(() => {});
  log = spyOn(console, 'log').mockImplementation(() => {});
  error = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
  error.mockRestore();
});

describe('controller tick: scheduler NATS accounts file (#541 m6d)', () => {
  it('renders the file on the first tick from the record, then writes nothing over many ticks', async () => {
    const { api, controller } = await prepare();
    expect(api.objects.has(accountsPath)).toBe(false);
    await controller.tick();
    const text = file(api);
    const ids = record(api);
    expect(users(text).sort()).toEqual(
      [
        `${ids['platform/data']?.current}.data.platform.scheduler.di-framework.invalid`,
        `${ids['platform/host']?.current}.host.platform.scheduler.di-framework.invalid`,
        `${ids['platform/operator']?.current}.operator.platform.scheduler.di-framework.invalid`,
        `${ids['tenant/alpha/hosts']?.current}.di-tenant-alpha.tenants.scheduler.di-framework.invalid`,
      ].sort(),
    );
    expect(text).toContain('jetstream: { max_mem: 32M, max_file: 1G }');
    expect(api.objects.get(accountsPath)?.metadata.labels?.[INSTALLATION]).toBe('test');
    expect(condition(api)).toBeUndefined();
    api.operations.length = 0;
    for (let i = 0; i < 6; i++) await controller.tick();
    expect(api.accountsWrites()).toEqual([]);
  });

  it('adds the user of an identity issued later, in the same tick', async () => {
    const { api, controller } = await prepare();
    await controller.tick();
    expect(file(api)).not.toContain('.operator.di-tenant-alpha.');
    ownOperatorNamespace(api);
    api.operations.length = 0;
    await controller.tick();
    const id = record(api)['tenant/alpha/operator']?.current;
    expect(users(file(api))).toContain(
      `${id}.operator.di-tenant-alpha.platform.scheduler.di-framework.invalid`,
    );
    expect(api.accountsWrites()).toEqual([`PUT ${accountsPath}`]);
  });

  it('keeps a previous operator user during the overlap and drops it after previousUntil', async () => {
    const { api, controller } = await prepare();
    ownOperatorNamespace(api);
    await controller.tick();
    const first = record(api)['tenant/alpha/operator']?.current as string;
    const user = `${first}.operator.di-tenant-alpha.platform.scheduler.di-framework.invalid`;
    clock.now = new Date(START.getTime() + 61 * 86_400_000);
    await controller.tick();
    const entry = record(api)['tenant/alpha/operator'];
    expect(entry?.previous).toBe(first);
    expect(users(file(api))).toContain(user);
    expect(users(file(api))).toContain(
      `${entry?.current}.operator.di-tenant-alpha.platform.scheduler.di-framework.invalid`,
    );
    clock.now = new Date(Date.parse(entry?.previousUntil as string) + 1000);
    await controller.tick();
    expect(users(file(api))).not.toContain(user);
  });

  it('drops a removed Tenant from the file', async () => {
    const { api, controller } = await prepare();
    await controller.tick();
    expect(file(api)).toContain('T_di-tenant-alpha');
    const t = stored(api);
    t.metadata.deletionTimestamp = START.toISOString();
    api.seed(t);
    for (let i = 0; i < 6 && stored(api)?.metadata.finalizers?.includes(FINALIZER); i++)
      await controller.tick();
    await controller.tick();
    expect(file(api)).not.toContain('di-tenant-alpha');
    expect(file(api)).toContain('T_wasmcloud');
  });

  it('refuses an invalid record: keeps the previous file, reports SchedulerAccounts and logs once', async () => {
    const { api, controller } = await prepare();
    await controller.tick();
    const before = file(api);
    const bad = record(api);
    const data = bad['platform/data'] as { current: string };
    // The same user twice.
    bad['platform/data'] = {
      current: data.current,
      previous: data.current,
      previousUntil: '2027-01-01T00:00:00Z',
    };
    setRecord(api, bad);
    api.operations.length = 0;
    warn.mockClear();
    for (let i = 0; i < 4; i++) await controller.tick();
    expect(api.accountsWrites()).toEqual([]);
    expect(file(api)).toBe(before);
    expect(condition(api)).toMatchObject({ status: 'False', reason: REFUSED_FOR_OTHER });
    expect(condition(api)?.message).toContain(`${SCHEDULER_NATS_ACCOUNTS} was not written`);
    const refusals = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes(`${SCHEDULER_NATS_ACCOUNTS} was not written`),
    );
    expect(refusals).toHaveLength(1);
    expect(String(refusals[0]?.[0])).toContain('appears more than once');
    // Repaired: the condition clears.
    bad['platform/data'] = { current: data.current };
    setRecord(api, bad);
    await controller.tick();
    await controller.tick();
    expect(condition(api)).toBeUndefined();
    expect(file(api)).toBe(before);
  });

  it('names the offending Tenant in its condition', async () => {
    const { api, controller } = await prepare();
    await controller.tick();
    const t = stored(api);
    t.spec.runtime = { replicas: 0 } as Tenant['spec']['runtime'];
    api.seed(t);
    await controller.tick();
    await controller.tick();
    expect(condition(api)).toMatchObject({ status: 'False', reason: 'InvalidReplicas' });
  });

  it('creates the file again when it is deleted out of band', async () => {
    const { api, controller } = await prepare();
    await controller.tick();
    const before = file(api);
    api.objects.delete(accountsPath);
    api.operations.length = 0;
    await controller.tick();
    expect(api.accountsWrites()).toEqual([`POST /api/v1/namespaces/${cfg.namespace}/configmaps`]);
    expect(file(api)).toBe(before);
  });
});

describe('SchedulerAccountsWriter (#541 m6d)', () => {
  const tenants = [tenant()];
  it('does nothing without a PKI namespace or before the record exists', async () => {
    const api = new MemoryApi();
    const writer = new SchedulerAccountsWriter(api, cfg, () => START);
    expect(await writer.reconcile(tenants)).toEqual([]);
    api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: PKI } });
    expect(await writer.reconcile(tenants)).toEqual([]);
    expect(api.operations.filter((o) => o.method !== 'GET')).toEqual([]);
  });

  it('logs a failed write once, reports no problems and recovers', async () => {
    const api = new MemoryApi();
    api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: PKI } });
    await bootstrapSchedulerPki(api, cfg, START);
    const call = api.call.bind(api);
    let fail = true;
    api.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (fail && method === 'POST' && path.endsWith('/configmaps'))
        throw new ApiError(403, 'Forbidden');
      if (fail && method === 'GET' && path === recordPath) throw 'unreadable';
      return call<T>(method, path, body);
    };
    const writer = new SchedulerAccountsWriter(api, cfg, () => START);
    expect(await writer.reconcile(tenants)).toEqual([]);
    expect(await writer.reconcile(tenants)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('could not be written: unreadable');
    fail = false;
    expect(await writer.reconcile(tenants)).toEqual([]);
    expect(api.objects.has(accountsPath)).toBe(true);
    expect(log).toHaveBeenCalledWith(`${SCHEDULER_NATS_ACCOUNTS} is rendered from the record`);
  });

  it('passes a 403 on the write to the log', async () => {
    const api = new MemoryApi();
    api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: PKI } });
    await bootstrapSchedulerPki(api, cfg, START);
    const call = api.call.bind(api);
    api.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (method === 'POST' && path.endsWith('/configmaps')) throw new ApiError(403, 'Forbidden');
      return call<T>(method, path, body);
    };
    const writer = new SchedulerAccountsWriter(api, cfg, () => START);
    expect(await writer.reconcile(tenants)).toEqual([]);
    expect(String(error.mock.calls[0]?.[0])).toContain('Forbidden');
    expect(api.objects.has(accountsPath)).toBe(false);
  });
});
