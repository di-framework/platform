import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { ApiError, Controller } from '../src/tenancy/controller';
import { FINALIZER, INSTALLATION, OWNER, type Tenant } from '../src/tenancy/resources';
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
  serializeIdentityRecord,
} from '../src/tenancy/scheduler-pki';
import {
  cfg,
  condition as conditionOf,
  MemoryApi,
  PKI,
  prepare as prepareHarness,
  recordPath,
  START,
  stored,
  tenant,
} from './support/controller-harness';

// #541 m6d: the controller's tick renders `di-scheduler-nats-accounts` from the Tenant list and the
// identity record, writes it only when it changed, and refuses a render the m2 validation rejects
// (design-541 §4.4).

const accountsPath = `/api/v1/namespaces/${cfg.namespace}/configmaps/${SCHEDULER_NATS_ACCOUNTS}`;
const clock = { now: START };

class AccountsApi extends MemoryApi {
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

const prepare = () => prepareHarness(new AccountsApi(), { pki: true }, () => clock.now);
const condition = (api: AccountsApi) => conditionOf(api, SCHEDULER_ACCOUNTS_CONDITION);
const file = (api: AccountsApi) =>
  (api.objects.get(accountsPath) as unknown as { data: Record<string, string> } | undefined)?.data[
    ACCOUNTS_KEY
  ];
const record = (api: AccountsApi): IdentityRecord =>
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
const ownOperatorNamespace = (api: AccountsApi) =>
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
    // A healthy start is logged once.
    const rendered = () =>
      log.mock.calls.filter(
        (c: unknown[]) => c[0] === `${SCHEDULER_NATS_ACCOUNTS} is rendered from the record`,
      );
    expect(rendered()).toHaveLength(1);
    api.operations.length = 0;
    for (let i = 0; i < 6; i++) await controller.tick();
    expect(api.accountsWrites()).toEqual([]);
    expect(rendered()).toHaveLength(1);
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

  /** A refusal held across ticks: `platform/data` names the same user twice. */
  async function refused() {
    const { api, controller } = await prepare();
    await controller.tick();
    const bad = record(api);
    const data = bad['platform/data'] as { current: string };
    bad['platform/data'] = {
      current: data.current,
      previous: data.current,
      previousUntil: '2027-01-01T00:00:00Z',
    };
    setRecord(api, bad);
    await controller.tick();
    await controller.tick();
    const held = condition(api);
    expect(held).toMatchObject({ status: 'False', reason: REFUSED_FOR_OTHER });
    return { api, held };
  }
  const tenantStatusWrites = (api: AccountsApi) =>
    api.operations.filter((o) => o.method === 'PATCH' && o.path.endsWith('/alpha/status'));

  it('keeps a standing refusal and its lastTransitionTime across a controller restart', async () => {
    const { api, held } = await refused();
    clock.now = new Date(START.getTime() + 60_000);
    const restarted = new Controller(
      api,
      cfg,
      async () => [],
      () => clock.now,
    );
    for (let i = 0; i < 3; i++) {
      await restarted.tick();
      expect(condition(api)).toEqual(held);
    }
  });

  it('keeps a standing refusal untouched while the record cannot be read', async () => {
    const { api, held } = await refused();
    clock.now = new Date(START.getTime() + 60_000);
    const call = api.call.bind(api);
    api.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (method === 'GET' && path === recordPath) throw new ApiError(500, 'unavailable');
      return call<T>(method, path, body);
    };
    // The cluster without a controller in memory: a fresh one starts during the outage too.
    for (const controller of [
      new Controller(
        api,
        cfg,
        async () => [],
        () => clock.now,
      ),
      new Controller(
        api,
        cfg,
        async () => [],
        () => clock.now,
      ),
    ])
      for (let i = 0; i < 2; i++) {
        await controller.tick();
        expect(condition(api)).toEqual(held);
      }
    expect(tenantStatusWrites(api).length).toBeGreaterThan(0);
  });

  it('renders a suspended Tenant, whose operator keeps running (§4.5)', async () => {
    const { api, controller } = await prepare();
    ownOperatorNamespace(api);
    await controller.tick();
    const t = stored(api);
    t.spec.suspended = true;
    api.seed(t);
    for (let i = 0; i < 3; i++) await controller.tick();
    const ids = record(api);
    expect(users(file(api))).toEqual(
      expect.arrayContaining([
        `${ids['tenant/alpha/hosts']?.current}.di-tenant-alpha.tenants.scheduler.di-framework.invalid`,
        `${ids['tenant/alpha/operator']?.current}.operator.di-tenant-alpha.platform.scheduler.di-framework.invalid`,
      ]),
    );
  });

  it('renders a deleting Tenant until removal drops its record entries', async () => {
    const { api, controller } = await prepare();
    await controller.tick();
    const before = file(api);
    // R1/R4 cannot drop the entries (their record write conflicts), so the deleting Tenant's users
    // stay in the file.
    const call = api.call.bind(api);
    api.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (method === 'PUT' && path === recordPath) throw new ApiError(409, 'Conflict');
      return call<T>(method, path, body);
    };
    const t = stored(api);
    t.metadata.deletionTimestamp = START.toISOString();
    api.seed(t);
    for (let i = 0; i < 3; i++) await controller.tick();
    expect(stored(api).metadata.deletionTimestamp).toBeDefined();
    expect(record(api)['tenant/alpha/hosts']).toBeDefined();
    expect(file(api)).toBe(before);
    expect(file(api)).toContain('T_di-tenant-alpha');
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
    const api = new AccountsApi();
    const writer = new SchedulerAccountsWriter(api, cfg, () => START);
    expect(await writer.reconcile(tenants)).toEqual([]);
    api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: PKI } });
    expect(await writer.reconcile(tenants)).toEqual([]);
    expect(api.operations.filter((o) => o.method !== 'GET')).toEqual([]);
    // No record yet is not a failure.
    expect(error).not.toHaveBeenCalled();
  });

  it('logs a failed read once, reports it as unknown and recovers', async () => {
    const api = new AccountsApi();
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
    expect(await writer.reconcile(tenants)).toBeUndefined();
    expect(await writer.reconcile(tenants)).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('could not be written: unreadable');
    fail = false;
    expect(await writer.reconcile(tenants)).toEqual([]);
    expect(api.objects.has(accountsPath)).toBe(true);
    expect(log).toHaveBeenCalledWith(`${SCHEDULER_NATS_ACCOUNTS} is rendered from the record`);
  });

  it('passes a 403 on the write to the log', async () => {
    const api = new AccountsApi();
    api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: PKI } });
    await bootstrapSchedulerPki(api, cfg, START);
    const call = api.call.bind(api);
    api.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (method === 'POST' && path.endsWith('/configmaps')) throw new ApiError(403, 'Forbidden');
      return call<T>(method, path, body);
    };
    const writer = new SchedulerAccountsWriter(api, cfg, () => START);
    expect(await writer.reconcile(tenants)).toBeUndefined();
    expect(String(error.mock.calls[0]?.[0])).toContain('Forbidden');
    expect(api.objects.has(accountsPath)).toBe(false);
  });
});
