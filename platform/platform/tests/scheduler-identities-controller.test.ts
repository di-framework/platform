import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { FINALIZER, INSTALLATION, names, OWNER, type Resource } from '../src/tenancy/resources';
import {
  SCHEDULER_CA_EXPIRING,
  SCHEDULER_IDENTITY_PENDING,
  TENANT_HOST_SECRET,
} from '../src/tenancy/scheduler-identities';
import {
  CA_KEYS,
  IDENTITIES_KEY,
  newSchedulerCa,
  parseIdentityRecord,
  SCHEDULER_CA_SECRET,
} from '../src/tenancy/scheduler-pki';
import { TENANT_OPERATOR_PROPAGATION_MS } from '../src/tenancy/tenant-operator';
import {
  condition,
  MemoryApi,
  PKI,
  prepare as prepareHarness,
  recordPath,
  START,
  stored,
  tenantPath,
} from './support/controller-harness';

// #541 m6c: the controller's tick issues tenant scheduler identities and never loops on its own
// writes (design-541 §4.5).

const RUNTIME = names('alpha').runtimeNamespace;
const hostPath = `/api/v1/namespaces/${RUNTIME}/secrets/${TENANT_HOST_SECRET}`;
const operatorPath = '/api/v1/namespaces/di-operator-alpha/secrets/di-scheduler-operator-tls';
const caPath = `/api/v1/namespaces/${PKI}/secrets/${SCHEDULER_CA_SECRET}`;
const clock = { now: START };

class IdentityApi extends MemoryApi {
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

/**
 * Ticks until issued: the first records the users and writes the accounts file, the next sees them
 * named, and the one after the wait writes the Secrets (m6e-E).
 */
async function issue(controller: { tick(): Promise<void> }) {
  await controller.tick();
  await controller.tick();
  clock.now = new Date(clock.now.getTime() + TENANT_OPERATOR_PROPAGATION_MS);
  await controller.tick();
}

const prepare = (options: { pki: boolean }) =>
  prepareHarness(new IdentityApi(), options, () => clock.now);

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  clock.now = START;
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('controller tick: tenant scheduler identities (#541 m6c)', () => {
  it('issues once and then writes neither the identity, the record nor the rotation over many ticks', async () => {
    const { api, controller } = await prepare({ pki: true });
    await issue(controller);
    const record = parseIdentityRecord(
      (api.objects.get(recordPath) as unknown as { data: Record<string, string> }).data[
        IDENTITIES_KEY
      ] as string,
    );
    expect(record['tenant/alpha/hosts']?.current).toMatch(/^[0-9a-f]{16}$/);
    expect(api.objects.get(hostPath)?.metadata.labels?.[OWNER]).toBe('alpha-uid');
    expect(condition(api, SCHEDULER_IDENTITY_PENDING)).toBeUndefined();
    // Issuance wrote the record, the Secret and the status; let one more tick settle the status.
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
    await issue(controller);
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
      await issue(controller);
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

/**
 * Issues the tenant identities, moves the clock into the scheduler CAs' last 30 days and ticks until
 * the capped leaves have settled; `api.operations` is then empty.
 */
async function settleInCaWindow() {
  const { api, controller } = await prepare({ pki: true });
  api.seed({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: 'di-operator-alpha',
      labels: { [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' },
    },
  });
  await issue(controller);
  expect(api.objects.has(operatorPath)).toBe(true);
  const ca = (api.objects.get(caPath) as unknown as { data: Record<string, string> }).data;
  const caEnd = (kind: 'platform' | 'tenant') =>
    new Date(
      new X509Certificate(Buffer.from(ca[CA_KEYS[kind].cert] as string, 'base64')).validTo,
    ).getTime();
  clock.now = new Date(Math.min(caEnd('platform'), caEnd('tenant')) - 20 * 86_400_000);
  api.operations.length = 0;
  await issue(controller);
  await controller.tick();
  const writes = (path: string) =>
    api.operations.filter((o) => o.method !== 'GET' && o.path === path).length;
  expect(writes(hostPath)).toBe(1);
  expect(writes(operatorPath)).toBe(1);
  expect(condition(api, SCHEDULER_CA_EXPIRING)).toMatchObject({
    status: 'True',
    reason: 'CaExpiring',
  });
  // The overlap ends and the platform's own identities (also capped now) settle once.
  for (let i = 0; i < 3; i++) {
    clock.now = new Date(clock.now.getTime() + 11 * 60_000);
    await controller.tick();
  }
  expect(writes(hostPath) + writes(operatorPath)).toBe(2);
  api.operations.length = 0;
  return { api, controller, writes };
}

describe('tenant identities in the CA last 30 days (#612)', () => {
  it('issues each identity at most once, then writes nothing and reports SchedulerCaExpiring', async () => {
    const { api, controller, writes } = await settleInCaWindow();
    for (let i = 0; i < 5; i++) {
      clock.now = new Date(clock.now.getTime() + 86_400_000);
      await controller.tick();
    }
    expect(api.identityWrites()).toEqual([]);
    expect(writes(operatorPath)).toBe(0);
    expect(writes(`${tenantPath}/status`)).toBe(0);
    const logged = warn.mock.calls.filter(([m]: unknown[]) =>
      String(m).includes('scheduler tenant CA expires'),
    );
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain('certificates they sign cannot outlive them');
  });

  it('re-issues the capped leaves once and clears SchedulerCaExpiring when the CAs are replaced', async () => {
    const { api, controller, writes } = await settleInCaWindow();
    const secret = api.objects.get(caPath) as unknown as { data: Record<string, string> };
    for (const kind of ['platform', 'tenant'] as const) {
      const next = newSchedulerCa(kind, 'wasmcloud', clock.now);
      secret.data[CA_KEYS[kind].cert] = Buffer.from(next.cert).toString('base64');
      secret.data[CA_KEYS[kind].key] = Buffer.from(next.key).toString('base64');
    }
    await issue(controller);
    for (let i = 0; i < 3; i++) {
      clock.now = new Date(clock.now.getTime() + 11 * 60_000);
      await controller.tick();
    }
    expect(writes(hostPath)).toBe(1);
    expect(writes(operatorPath)).toBe(1);
    expect(condition(api, SCHEDULER_CA_EXPIRING)).toBeUndefined();
    api.operations.length = 0;
    for (let i = 0; i < 5; i++) {
      clock.now = new Date(clock.now.getTime() + 86_400_000);
      await controller.tick();
    }
    expect(writes(hostPath) + writes(operatorPath)).toBe(0);
  });
});
