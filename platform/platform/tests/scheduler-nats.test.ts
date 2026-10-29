import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ACCOUNTS_KEY,
  type AccountsRender,
  type AccountsTenant,
  bootstrapSchedulerAccounts,
  renderSchedulerAccounts,
  SCHEDULER_ACCOUNTS_CONDITION,
  SCHEDULER_NATS_ACCOUNTS,
  schedulerAccountsCondition,
  tenantMaxConnections,
} from '../src/tenancy/scheduler-nats';
import {
  IDENTITIES_KEY,
  type IdentityRecord,
  type PkiApi,
  SCHEDULER_IDENTITIES,
  SchedulerPkiRefused,
} from '../src/tenancy/scheduler-pki';
import {
  GOLDEN_FILE,
  GOLDEN_IDS,
  GOLDEN_NAMESPACE,
  GOLDEN_NOW,
  GOLDEN_RECORD,
  GOLDEN_TENANTS,
} from './support/scheduler-accounts';

const text = (render: AccountsRender): string => {
  if (!('text' in render)) throw new Error(`refused: ${JSON.stringify(render.problems)}`);
  return render.text;
};
const problems = (render: AccountsRender) => {
  if (!('problems' in render)) throw new Error('rendered');
  return render.problems;
};
const golden = () =>
  renderSchedulerAccounts(GOLDEN_NAMESPACE, GOLDEN_TENANTS, GOLDEN_RECORD, GOLDEN_NOW);
/** The account blocks of a rendered file, by name. */
const accountsOf = (conf: string): Record<string, string> =>
  Object.fromEntries(
    [...conf.matchAll(/^ {2}(\S+): \{\n([\s\S]*?)\n {2}\}$/gm)].map((m) => [m[1], m[2] as string]),
  );
const usersOf = (block: string) => [...block.matchAll(/user: "([^"]+)"/g)].map((m) => m[1]);
const shuffle = <T>(values: T[], seed: number): T[] => {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (seed * (i + 7)) % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

describe('scheduler NATS accounts file (#541 m2, design-541 §4.2-4.4)', () => {
  it('matches the golden file shared with the broker test', () => {
    expect(text(golden())).toBe(readFileSync(GOLDEN_FILE, 'utf8'));
  });

  it('renders one account per tenant, the platform account and DATA, with exact users', () => {
    const accounts = accountsOf(text(golden()));
    expect(Object.keys(accounts)).toEqual([
      'DATA',
      'T_di-tenant-a',
      'T_di-tenant-b',
      'T_wasmcloud',
    ]);
    expect(usersOf(accounts.T_wasmcloud as string)).toEqual([
      `${GOLDEN_IDS.platformOperator}.operator.platform.scheduler.di-framework.invalid`,
      `${GOLDEN_IDS.platformHost}.host.platform.scheduler.di-framework.invalid`,
    ]);
    expect(usersOf(accounts['T_di-tenant-b'] as string)).toEqual([
      `${GOLDEN_IDS.bHosts}.di-tenant-b.tenants.scheduler.di-framework.invalid`,
      `${GOLDEN_IDS.bOperator}.operator.di-tenant-b.platform.scheduler.di-framework.invalid`,
    ]);
    expect(usersOf(accounts.DATA as string)).toEqual([
      `${GOLDEN_IDS.platformData}.data.platform.scheduler.di-framework.invalid`,
    ]);
  });

  it('enables JetStream only on DATA (O5), limits only tenant accounts, and shares nothing', () => {
    const conf = text(golden());
    const accounts = accountsOf(conf);
    for (const [name, block] of Object.entries(accounts)) {
      expect(block.includes('jetstream: enabled')).toBe(name === 'DATA');
      expect(block.includes('limits:')).toBe(name.startsWith('T_di-tenant-'));
    }
    expect(accounts['T_di-tenant-a']).toContain(
      'limits: { max_connections: 8, max_subscriptions: 64, max_payload: 1048576 }',
    );
    expect(accounts['T_di-tenant-b']).toContain('max_connections: 6,');
    expect(tenantMaxConnections(1)).toBe(6);
    for (const word of ['imports', 'exports', 'mappings', 'no_auth_user', 'import', 'export'])
      expect(conf).not.toContain(word);
  });

  it('gives hosts and operators exactly their §4.3 permissions', () => {
    const lines = text(golden()).split('\n');
    const host = lines.find((l) => l.includes('.di-tenant-a.tenants.'));
    const operator = lines.find((l) => l.includes(`${GOLDEN_IDS.aOperator}.operator.di-tenant-a`));
    expect(host).toContain(
      'permissions: { publish: { allow: ["runtime.operator.heartbeat.*"] }, subscribe: { allow: ["runtime.host.*.>"] }, allow_responses: { max: 1, expires: "2m" } }',
    );
    expect(operator).toContain(
      'permissions: { publish: { allow: ["runtime.host.*.>"] }, subscribe: { allow: ["runtime.operator.heartbeat.>", "_INBOX.>"] } }',
    );
    const data = lines.find((l) => l.includes('.data.platform.'));
    expect(data).not.toContain('permissions');
  });

  it('is byte-stable under any order of Tenants and record entries', () => {
    const expected = text(golden());
    const entries = Object.entries(GOLDEN_RECORD);
    for (let seed = 1; seed <= 6; seed++) {
      const record = Object.fromEntries(shuffle(entries, seed)) as IdentityRecord;
      const tenants = shuffle(GOLDEN_TENANTS, seed);
      expect(text(renderSchedulerAccounts(GOLDEN_NAMESPACE, tenants, record, GOLDEN_NOW))).toBe(
        expected,
      );
    }
  });

  it('drops a removed Tenant, record entries without a Tenant, and accounts without users', () => {
    const [b] = GOLDEN_TENANTS as [AccountsTenant];
    const conf = text(renderSchedulerAccounts(GOLDEN_NAMESPACE, [b], GOLDEN_RECORD, GOLDEN_NOW));
    expect(conf).not.toContain('di-tenant-a');
    const withoutOperator = { ...GOLDEN_RECORD };
    delete withoutOperator['tenant/b/operator'];
    delete withoutOperator['tenant/b/hosts'];
    delete withoutOperator['platform/data'];
    const accounts = accountsOf(
      text(renderSchedulerAccounts(GOLDEN_NAMESPACE, [b], withoutOperator, GOLDEN_NOW)),
    );
    expect(Object.keys(accounts)).toEqual(['T_wasmcloud']);
    // R1: the host entry is gone, the operator stays.
    const r1 = { ...GOLDEN_RECORD };
    delete r1['tenant/b/hosts'];
    const block = accountsOf(text(renderSchedulerAccounts(GOLDEN_NAMESPACE, [b], r1, GOLDEN_NOW)))[
      'T_di-tenant-b'
    ] as string;
    expect(usersOf(block)).toEqual([
      `${GOLDEN_IDS.bOperator}.operator.di-tenant-b.platform.scheduler.di-framework.invalid`,
    ]);
  });

  it('renders a previous user only until previousUntil, and a host previous until it is dropped', () => {
    const previous = `${GOLDEN_IDS.aOperatorPrevious}.operator.di-tenant-a`;
    expect(text(golden())).toContain(previous);
    const after = renderSchedulerAccounts(
      GOLDEN_NAMESPACE,
      GOLDEN_TENANTS,
      GOLDEN_RECORD,
      new Date('2026-10-29T12:10:00Z'),
    );
    expect(text(after)).not.toContain(previous);
    // A forced rotation records no previous, so none is rendered.
    const forced = { ...GOLDEN_RECORD, 'tenant/a/operator': { current: GOLDEN_IDS.aOperator } };
    expect(
      text(renderSchedulerAccounts(GOLDEN_NAMESPACE, GOLDEN_TENANTS, forced, GOLDEN_NOW)),
    ).not.toContain(previous);
    // Hosts keep their previous user until the rollout is observed: no previousUntil.
    const hosts = {
      ...GOLDEN_RECORD,
      'tenant/b/hosts': { current: GOLDEN_IDS.bHosts, previous: 'bbbbbbbbbbbbbbb9' },
    };
    expect(
      text(renderSchedulerAccounts(GOLDEN_NAMESPACE, GOLDEN_TENANTS, hosts, new Date(9e15))),
    ).toContain('bbbbbbbbbbbbbbb9.di-tenant-b.tenants.');
  });

  it('refuses a duplicate user and names the offending Tenant', () => {
    const duplicate = {
      ...GOLDEN_RECORD,
      'tenant/b/hosts': { current: GOLDEN_IDS.bHosts, previous: GOLDEN_IDS.bHosts },
    };
    expect(
      problems(renderSchedulerAccounts(GOLDEN_NAMESPACE, GOLDEN_TENANTS, duplicate, GOLDEN_NOW)),
    ).toEqual([
      {
        reason: 'DuplicateSchedulerUser',
        tenant: 'b',
        message: `user '${GOLDEN_IDS.bHosts}.di-tenant-b.tenants.scheduler.di-framework.invalid' appears more than once`,
      },
    ]);
    const twice = [...GOLDEN_TENANTS, { metadata: { name: 'a' } }];
    expect(
      problems(renderSchedulerAccounts(GOLDEN_NAMESPACE, twice, GOLDEN_RECORD, GOLDEN_NOW)).map(
        (p) => [p.reason, p.tenant],
      ),
    ).toEqual([
      ['DuplicateSchedulerUser', 'a'],
      ['DuplicateSchedulerUser', 'a'],
      ['DuplicateSchedulerUser', 'a'],
    ]);
  });

  it('refuses a user that does not match its pattern', () => {
    for (const [key, id] of [
      ['tenant/a/hosts', 'AAAAAAAAAAAAAAAA'],
      ['tenant/a/operator', 'aaaa'],
      ['platform/host', '000000000000000g'],
    ] as const) {
      const bad = { ...GOLDEN_RECORD, [key]: { current: id } };
      const [problem, ...more] = problems(
        renderSchedulerAccounts(GOLDEN_NAMESPACE, GOLDEN_TENANTS, bad, GOLDEN_NOW),
      );
      expect(more).toEqual([]);
      expect(problem?.reason).toBe('InvalidSchedulerUser');
      expect(problem?.tenant).toBe(key.startsWith('tenant/') ? 'a' : undefined);
      expect(problem?.message).toContain(`user '${id}.`);
    }
  });

  it('refuses names that give invalid account names, before any user is checked', () => {
    for (const name of ['A', 'a.b', 'a_b', 'a-', '-a', '1a', 'x'.repeat(41), 'a b']) {
      expect(
        problems(
          renderSchedulerAccounts(GOLDEN_NAMESPACE, [{ metadata: { name } }], {}, GOLDEN_NOW),
        ),
      ).toEqual([
        {
          reason: 'InvalidAccountName',
          tenant: name,
          message: `Tenant '${name}' does not give a valid account name`,
        },
      ]);
    }
    for (const ns of ['Wasmcloud', 'ns.x', 'x'.repeat(64), '-ns'])
      expect(problems(renderSchedulerAccounts(ns, [], GOLDEN_RECORD, GOLDEN_NOW))).toEqual([
        {
          reason: 'InvalidAccountName',
          message: `the platform namespace '${ns}' does not give a valid account name`,
        },
      ]);
  });

  it('reports a refusal as a Tenant condition', () => {
    const found = [
      { reason: 'InvalidSchedulerUser' as const, message: 'platform' },
      { reason: 'DuplicateSchedulerUser' as const, tenant: 'b', message: 'dup' },
    ];
    expect(schedulerAccountsCondition(found, 'b', 3, GOLDEN_NOW)).toEqual({
      type: SCHEDULER_ACCOUNTS_CONDITION,
      status: 'False',
      reason: 'DuplicateSchedulerUser',
      message: `${SCHEDULER_NATS_ACCOUNTS} was not written: dup`,
      observedGeneration: 3,
      lastTransitionTime: GOLDEN_NOW.toISOString(),
    });
    expect(schedulerAccountsCondition(found, 'a', 1, GOLDEN_NOW)).toMatchObject({
      reason: 'InvalidSchedulerUser',
      message: `${SCHEDULER_NATS_ACCOUNTS} was not written: platform`,
    });
  });
});

// --- bootstrap ---------------------------------------------------------------------------------

interface Stored {
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  data?: Record<string, string>;
}
class FakeApi implements PkiApi {
  readonly objects = new Map<string, Stored>();
  readonly calls: string[] = [];
  failNext?: { path: string; code: number };
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push(`${method} ${path}`);
    if (this.failNext?.path === path) {
      const { code } = this.failNext;
      this.failNext = undefined;
      throw Object.assign(new Error(`${method} ${path} returned ${code}`), { code });
    }
    if (method === 'GET') {
      const found = this.objects.get(path);
      if (!found) throw Object.assign(new Error('not found'), { code: 404 });
      return structuredClone(found) as T;
    }
    const value = structuredClone(body) as Stored;
    this.objects.set(`${path}/${value.metadata.name}`, value);
    return value as T;
  }
}
const NS = 'wasmcloud';
const config = { installation: 'di-test', namespace: NS };
const accountsPath = `/api/v1/namespaces/${NS}/configmaps/${SCHEDULER_NATS_ACCOUNTS}`;
const recordPath = `/api/v1/namespaces/${NS}-scheduler-pki/configmaps/${SCHEDULER_IDENTITIES}`;
const withRecord = (record: IdentityRecord | string) => {
  const api = new FakeApi();
  api.objects.set(recordPath, {
    metadata: { name: SCHEDULER_IDENTITIES, namespace: `${NS}-scheduler-pki` },
    data: { [IDENTITIES_KEY]: typeof record === 'string' ? record : JSON.stringify(record) },
  });
  return api;
};

describe('bootstrapSchedulerAccounts (#541 m2)', () => {
  it('creates the accounts ConfigMap with no tenants, from the record', async () => {
    const api = withRecord(GOLDEN_RECORD);
    expect(await bootstrapSchedulerAccounts(api, config, GOLDEN_NOW)).toEqual([
      `${NS}/${SCHEDULER_NATS_ACCOUNTS}`,
    ]);
    const created = api.objects.get(accountsPath) as Stored;
    expect(created.metadata).toEqual({
      name: SCHEDULER_NATS_ACCOUNTS,
      namespace: NS,
      labels: {
        'platform.di-framework.dev/installation': 'di-test',
        'platform.di-framework.dev/component': 'scheduler-pki',
      },
    });
    const conf = created.data?.[ACCOUNTS_KEY] as string;
    expect(conf).toBe(text(renderSchedulerAccounts(NS, [], GOLDEN_RECORD, GOLDEN_NOW)));
    expect(Object.keys(accountsOf(conf))).toEqual(['DATA', 'T_wasmcloud']);
    expect(conf).not.toContain('di-tenant-');
  });

  it('never overwrites an existing accounts ConfigMap', async () => {
    const api = withRecord(GOLDEN_RECORD);
    api.objects.set(accountsPath, {
      metadata: { name: SCHEDULER_NATS_ACCOUNTS, namespace: NS },
      data: { [ACCOUNTS_KEY]: 'controller-written' },
    });
    expect(await bootstrapSchedulerAccounts(api, config)).toEqual([]);
    expect(api.calls).toEqual([`GET ${accountsPath}`]);
    expect(api.objects.get(accountsPath)?.data?.[ACCOUNTS_KEY]).toBe('controller-written');
  });

  it('refuses without a record, or with one that does not render, and writes nothing', async () => {
    const empty = new FakeApi();
    await expect(bootstrapSchedulerAccounts(empty, config)).rejects.toBeInstanceOf(
      SchedulerPkiRefused,
    );
    expect(empty.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
    const bad = withRecord('not json');
    await expect(bootstrapSchedulerAccounts(bad, config)).rejects.toThrow(SCHEDULER_IDENTITIES);
    const dup = withRecord({
      'platform/host': { current: '0000000000000002', previous: '0000000000000002' },
    });
    await expect(bootstrapSchedulerAccounts(dup, config)).rejects.toThrow(
      `${SCHEDULER_NATS_ACCOUNTS} was not written: user '0000000000000002.host.platform`,
    );
    for (const api of [bad, dup]) expect(api.objects.has(accountsPath)).toBe(false);
  });

  it('passes on API errors other than not-found', async () => {
    const api = withRecord(GOLDEN_RECORD);
    api.failNext = { path: accountsPath, code: 403 };
    await expect(bootstrapSchedulerAccounts(api, config)).rejects.toMatchObject({ code: 403 });
    expect(api.objects.has(accountsPath)).toBe(false);
  });
});
