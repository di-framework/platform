import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { ApiError } from '../src/tenancy/controller';
import type { Resource } from '../src/tenancy/resources';
import {
  CA_KEYS,
  IDENTITIES_KEY,
  natsServerLeaf,
  natsServiceNames,
  newSchedulerCa,
  PLATFORM_SECRETS,
  parseIdentityRecord,
  platformClientLeaf,
  SCHEDULER_CA_SECRET,
  tlsSecretData,
} from '../src/tenancy/scheduler-pki';
import {
  SCHEDULER_TLS_ANNOTATION,
  schedulerCertDigest,
} from '../src/tenancy/scheduler-pki-rotation';
import {
  PLATFORM_HOST_DEPLOYMENT,
  PlatformSchedulerIdentities,
  SCHEDULER_DATA_TLS_ANNOTATION,
} from '../src/tenancy/scheduler-platform-identities';
import { TENANT_OPERATOR_PROPAGATION_MS } from '../src/tenancy/tenant-operator';
import { certificateNames, issuedBy } from '../src/tenancy/tls';
import {
  cfg,
  MemoryApi,
  PKI,
  prepare as prepareHarness,
  recordPath,
  START,
} from './support/controller-harness';
import { PropagationInvariant } from './support/propagation-invariant';

// #541 m6e-A: the controller's tick renews the platform's own scheduler identities and the NATS
// server leaf (design-541 §4.5), and rolls hostgroup-default after a platform/host renewal.

const DAY = 86_400_000;
const NS = cfg.namespace;
const secretPath = (name: string) => `/api/v1/namespaces/${NS}/secrets/${name}`;
const deploymentPath = `/apis/apps/v1/namespaces/${NS}/deployments/${PLATFORM_HOST_DEPLOYMENT}`;
const platformPaths = Object.values(PLATFORM_SECRETS).map(secretPath);
const clock = { now: START };

class PlatformApi extends MemoryApi {
  /** Calls to fail once, by `<method> <path>`. */
  failOnce = new Set<string>();
  override async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.failOnce.delete(`${method} ${path}`)) {
      this.operations.push({ method, path, body });
      throw new ApiError(500, 'Injected failure');
    }
    return super.call<T>(method, path, body);
  }
  /** Writes of the record, the platform Secrets and hostgroup-default. */
  platformWrites(): string[] {
    return this.operations
      .filter(
        (o) =>
          o.method !== 'GET' &&
          (o.path === recordPath || platformPaths.includes(o.path) || o.path === deploymentPath),
      )
      .map((o) => `${o.method} ${o.path}`);
  }
}

const advance = (ms: number) => {
  clock.now = new Date(clock.now.getTime() + ms);
};
/**
 * The ticks after the one that recorded a renewal: the next one sees the new users in the accounts
 * file that tick wrote, and the one after the wait writes their Secrets (m6e-E).
 */
async function propagate(controller: { tick(): Promise<void> }) {
  await controller.tick();
  advance(TENANT_OPERATOR_PROPAGATION_MS);
  await controller.tick();
}

const prepare = (options: { pki: boolean } = { pki: true }) =>
  prepareHarness(new PlatformApi(), options, () => clock.now);

const data = (api: MemoryApi, path: string) =>
  (api.objects.get(path) as unknown as { data: Record<string, string> }).data;
const decode = (value: string | undefined) => Buffer.from(value ?? '', 'base64').toString('utf8');
const record = (api: MemoryApi) => parseIdentityRecord(data(api, recordPath)[IDENTITIES_KEY] ?? '');
const cert = (api: MemoryApi, name: string) => decode(data(api, secretPath(name))['tls.crt']);

/** hostgroup-default with its template annotation and a completed (or held) rollout. */
function seedDeployment(
  api: MemoryApi,
  digest?: string,
  complete = true,
  dataDigest?: string,
): void {
  const annotations = {
    ...(digest ? { [SCHEDULER_TLS_ANNOTATION]: digest } : {}),
    ...(dataDigest ? { [SCHEDULER_DATA_TLS_ANNOTATION]: dataDigest } : {}),
  };
  api.seed({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: PLATFORM_HOST_DEPLOYMENT, namespace: NS, generation: 2 },
    spec: {
      replicas: 1,
      template: { metadata: { annotations } },
    },
    status: {
      observedGeneration: 2,
      updatedReplicas: complete ? 1 : 0,
      readyReplicas: complete ? 1 : 0,
    },
  } as unknown as Resource);
}
const annotation = (api: MemoryApi, name = SCHEDULER_TLS_ANNOTATION) =>
  (
    api.objects.get(deploymentPath) as unknown as {
      spec: { template: { metadata: { annotations?: Record<string, string> } } };
    }
  ).spec.template.metadata.annotations?.[name];
const patches = (api: PlatformApi) =>
  api.platformWrites().filter((w) => w === `PATCH ${deploymentPath}`).length;
const digestOf = (api: MemoryApi, role: 'host' | 'data') =>
  schedulerCertDigest(cert(api, PLATFORM_SECRETS[role]));
/** Replaces the `platform/data` leaf with one for its recorded ID issued `days` days before START. */
function ageData(api: MemoryApi, days: number): void {
  const ca = data(api, `/api/v1/namespaces/${PKI}/secrets/${SCHEDULER_CA_SECRET}`);
  const platformCa = {
    cert: decode(ca[CA_KEYS.platform.cert]),
    key: decode(ca[CA_KEYS.platform.key]),
  };
  const id = record(api)['platform/data']?.current as string;
  const leaf = platformClientLeaf('data', id, platformCa, new Date(START.getTime() - days * DAY));
  const path = secretPath(PLATFORM_SECRETS.data);
  const secret = api.objects.get(path) as Resource;
  api.seed({ ...secret, data: tlsSecretData(leaf, platformCa.cert) } as unknown as Resource);
}

let warn: ReturnType<typeof spyOn>;
const warned = (text: string) =>
  warn.mock.calls.filter(([message]: unknown[]) => String(message).includes(text)).length;
beforeEach(() => {
  clock.now = START;
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('controller tick: platform scheduler identities (#541 m6e-A)', () => {
  it('writes nothing while the leaves are fresh', async () => {
    const { api, controller } = await prepare();
    seedDeployment(api);
    for (let i = 0; i < 3; i++) await controller.tick();
    expect(api.platformWrites().filter((w) => w !== `PUT ${recordPath}`)).toEqual([]);
    expect(annotation(api)).toBeUndefined();
  });

  it('renews each role and the server leaf once at +61 days, record first, rolls hostgroup-default, then settles', async () => {
    const { api, controller } = await prepare();
    seedDeployment(api);
    await controller.tick();
    const before = record(api);
    const server = cert(api, PLATFORM_SECRETS.server);
    api.operations.length = 0;

    clock.now = new Date(START.getTime() + 61 * DAY);
    await controller.tick();
    // The record and the server leaf, which is no NATS user; no client Secret before the wait.
    expect(api.platformWrites()).toEqual([
      `PUT ${recordPath}`,
      `PUT ${secretPath(PLATFORM_SECRETS.server)}`,
    ]);
    await propagate(controller);
    const writes = api.platformWrites();
    for (const path of platformPaths)
      expect(writes.filter((w) => w === `PUT ${path}`)).toHaveLength(1);
    const firstSecret = Math.min(...platformPaths.map((p) => writes.indexOf(`PUT ${p}`)));
    expect(writes.indexOf(`PUT ${recordPath}`)).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf(`PUT ${recordPath}`)).toBeLessThan(firstSecret);
    const after = record(api);
    for (const role of ['operator', 'host', 'data'] as const) {
      const entry = after[`platform/${role}`];
      expect(entry?.previous).toBe(before[`platform/${role}`]?.current as string);
      expect(entry?.current).not.toBe(entry?.previous as string);
      expect(cert(api, PLATFORM_SECRETS[role])).toContain('BEGIN CERTIFICATE');
      expect(certificateNames(cert(api, PLATFORM_SECRETS[role]))?.dns?.[0]).toStartWith(
        `${entry?.current}.${role}.`,
      );
    }

    // The server leaf: same CA, same names, both CAs in the bundle.
    const ca = data(api, `/api/v1/namespaces/${PKI}/secrets/${SCHEDULER_CA_SECRET}`);
    const platformCa = decode(ca[CA_KEYS.platform.cert]);
    const renewed = cert(api, PLATFORM_SECRETS.server);
    expect(renewed).not.toBe(server);
    const serverData = data(api, secretPath(PLATFORM_SECRETS.server));
    expect(issuedBy(platformCa, renewed, decode(serverData['tls.key']))).toBe(true);
    expect(certificateNames(renewed)?.dns?.sort()).toEqual(natsServiceNames(NS).sort());
    expect(decode(serverData['ca.crt'])).toBe(`${platformCa}${decode(ca[CA_KEYS.tenant.cert])}`);

    // hostgroup-default carries the new host certificate's digest.
    const digest = schedulerCertDigest(cert(api, PLATFORM_SECRETS.host));
    expect(annotation(api)).toBe(digest);
    expect(writes.filter((w) => w === `PATCH ${deploymentPath}`)).toHaveLength(1);

    // The rollout completes; past previousUntil every previous is dropped once, then nothing.
    seedDeployment(api, digest, true, digestOf(api, 'data'));
    advance(11 * 60_000);
    api.operations.length = 0;
    await controller.tick();
    expect(api.platformWrites()).toEqual([`PUT ${recordPath}`]);
    for (const role of ['operator', 'host', 'data'] as const)
      expect(record(api)[`platform/${role}`]?.previous).toBeUndefined();
    api.operations.length = 0;
    for (let i = 0; i < 4; i++) await controller.tick();
    expect(api.platformWrites()).toEqual([]);
    expect(warned('has not rolled out')).toBe(0);
  });

  it('skips the roll when hostgroup-default is absent and logs the stall once', async () => {
    const { api, controller } = await prepare();
    clock.now = new Date(START.getTime() + 61 * DAY);
    await controller.tick();
    await propagate(controller);
    expect(api.operations.some((o) => o.path === deploymentPath && o.method !== 'GET')).toBe(false);
    expect(api.objects.has(deploymentPath)).toBe(false);
    advance(11 * 60_000);
    for (let i = 0; i < 4; i++) await controller.tick();
    expect(warned(`Deployment ${NS}/${PLATFORM_HOST_DEPLOYMENT} has not rolled out`)).toBe(1);
    expect(record(api)['platform/host']?.previous).toBeDefined();
    expect(record(api)['platform/operator']?.previous).toBeUndefined();
  });

  it('retries a failed Secret write on the next tick, once per tick', async () => {
    const { api, controller } = await prepare();
    seedDeployment(api);
    clock.now = new Date(START.getTime() + 61 * DAY);
    const host = secretPath(PLATFORM_SECRETS.host);
    api.failOnce.add(`PUT ${host}`);
    await controller.tick();
    api.operations.length = 0;
    await propagate(controller);
    expect(api.platformWrites().filter((w) => w === `PUT ${host}`)).toHaveLength(1);
    expect(warned('Platform scheduler identities: renewal failed: Injected failure')).toBe(1);
    expect(annotation(api)).toBeUndefined();
    // The record names the new ID; the Secret still carries the old one, so it is pending.
    api.operations.length = 0;
    await controller.tick();
    expect(api.platformWrites().filter((w) => w === `PUT ${host}`)).toHaveLength(1);
    expect(annotation(api)).toBe(schedulerCertDigest(cert(api, PLATFORM_SECRETS.host)));
    expect(certificateNames(cert(api, PLATFORM_SECRETS.host))?.dns?.[0]).toStartWith(
      `${record(api)['platform/host']?.current}.host.`,
    );
    api.operations.length = 0;
    await controller.tick();
    expect(api.platformWrites().filter((w) => w !== `PUT ${recordPath}`)).toEqual([]);
  });

  it('retries a failed rollout PATCH on the next tick', async () => {
    const { api, controller } = await prepare();
    seedDeployment(api);
    clock.now = new Date(START.getTime() + 61 * DAY);
    api.failOnce.add(`PATCH ${deploymentPath}`);
    await controller.tick();
    await propagate(controller);
    expect(annotation(api)).toBeUndefined();
    await controller.tick();
    expect(annotation(api)).toBe(schedulerCertDigest(cert(api, PLATFORM_SECRETS.host)));
  });

  it('re-rolls a Deployment whose template carries a stale digest', async () => {
    const { api, controller } = await prepare();
    seedDeployment(api, 'stale');
    await controller.tick();
    expect(annotation(api)).toBe(schedulerCertDigest(cert(api, PLATFORM_SECRETS.host)));
  });

  it('leaves unowned, unrecorded and missing Secrets to the bootstrap Job', async () => {
    const { api, controller } = await prepare();
    const server = api.objects.get(secretPath(PLATFORM_SECRETS.server)) as Resource;
    api.seed({ ...server, metadata: { ...server.metadata, labels: {} } });
    api.objects.delete(secretPath(PLATFORM_SECRETS.data));
    const stored = record(api);
    delete stored['platform/operator'];
    const cm = api.objects.get(recordPath) as Resource & { data: Record<string, string> };
    api.seed({ ...cm, data: { [IDENTITIES_KEY]: JSON.stringify(stored) } } as Resource);
    clock.now = new Date(START.getTime() + 61 * DAY);
    api.operations.length = 0;
    await controller.tick();
    await propagate(controller);
    const writes = api.platformWrites();
    expect(writes).toContain(`PUT ${secretPath(PLATFORM_SECRETS.host)}`);
    expect(writes.filter((w) => w.includes(PLATFORM_SECRETS.operator))).toEqual([]);
    expect(writes.filter((w) => w.includes(PLATFORM_SECRETS.server))).toEqual([]);
    expect(api.objects.has(secretPath(PLATFORM_SECRETS.data))).toBe(false);
  });

  it('does nothing, and logs nothing, before the bootstrap Job has run', async () => {
    const { api } = await prepare({ pki: false });
    const platform = new PlatformSchedulerIdentities(api, cfg, () => clock.now);
    api.operations.length = 0;
    await platform.reconcile();
    expect(api.operations.map((o) => o.method)).toEqual(['GET', 'GET']);
    api.objects.delete(`/api/v1/namespaces/${PKI}`);
    api.operations.length = 0;
    await platform.reconcile();
    expect(api.operations.map((o) => o.path)).toEqual([`/api/v1/namespaces/${PKI}`]);
    expect(warned('Platform scheduler identities')).toBe(0);
  });

  it('does nothing without the identity record', async () => {
    const { api } = await prepare();
    api.objects.delete(recordPath);
    api.operations.length = 0;
    await new PlatformSchedulerIdentities(api, cfg, () => clock.now).reconcile();
    expect(api.operations.every((o) => o.method === 'GET')).toBe(true);
    expect(warned('Platform scheduler identities')).toBe(0);
  });

  it('still rolls hostgroup-default after a restart between the Secret write and the PATCH', async () => {
    const { api, controller } = await prepare();
    seedDeployment(api);
    clock.now = new Date(START.getTime() + 61 * DAY);
    api.failOnce.add(`PATCH ${deploymentPath}`);
    await controller.tick();
    await propagate(controller);
    expect(annotation(api)).toBeUndefined();
    // A new process: nothing of the failed PATCH is held in memory.
    await new PlatformSchedulerIdentities(api, cfg, () => clock.now).reconcile();
    expect(annotation(api)).toBe(digestOf(api, 'host'));
    expect(annotation(api, SCHEDULER_DATA_TLS_ANNOTATION)).toBe(digestOf(api, 'data'));
  });

  it('keeps platform/data previous past previousUntil while the rollout is held', async () => {
    const { api, controller } = await prepare();
    seedDeployment(api);
    clock.now = new Date(START.getTime() + 61 * DAY);
    api.operations.length = 0;
    await controller.tick();
    await propagate(controller);
    expect(patches(api)).toBe(1);
    seedDeployment(api, digestOf(api, 'host'), false, digestOf(api, 'data'));
    advance(11 * 60_000);
    await controller.tick();
    expect(record(api)['platform/host']?.previous).toBeDefined();
    expect(record(api)['platform/data']?.previous).toBeDefined();
    expect(record(api)['platform/operator']?.previous).toBeUndefined();
    expect(warned('has not rolled out')).toBe(1);
    // Once both certificates have rolled out, both previous are dropped.
    seedDeployment(api, digestOf(api, 'host'), true, digestOf(api, 'data'));
    api.operations.length = 0;
    await controller.tick();
    expect(record(api)['platform/data']?.previous).toBeUndefined();
    expect(record(api)['platform/host']?.previous).toBeUndefined();
    expect(patches(api)).toBe(0);
  });

  it('rolls hostgroup-default on a data-only renewal, keeping the host annotation', async () => {
    const { api, controller } = await prepare();
    await controller.tick();
    const host = digestOf(api, 'host');
    seedDeployment(api, host, true, digestOf(api, 'data'));
    ageData(api, 70);
    api.operations.length = 0;
    await controller.tick();
    await propagate(controller);
    const writes = api.platformWrites();
    expect(writes).toContain(`PUT ${secretPath(PLATFORM_SECRETS.data)}`);
    expect(writes).not.toContain(`PUT ${secretPath(PLATFORM_SECRETS.host)}`);
    expect(patches(api)).toBe(1);
    expect(annotation(api, SCHEDULER_DATA_TLS_ANNOTATION)).toBe(digestOf(api, 'data'));
    expect(annotation(api)).toBe(host);
    expect(record(api)['platform/data']?.previous).toBeDefined();
  });

  it('sends one PATCH with both annotations when host and data renew in one tick', async () => {
    const { api, controller } = await prepare();
    seedDeployment(api);
    clock.now = new Date(START.getTime() + 61 * DAY);
    api.operations.length = 0;
    await controller.tick();
    await propagate(controller);
    expect(patches(api)).toBe(1);
    expect(annotation(api)).toBe(digestOf(api, 'host'));
    expect(annotation(api, SCHEDULER_DATA_TLS_ANNOTATION)).toBe(digestOf(api, 'data'));
  });

  it('re-issues a server leaf from a foreign CA exactly once', async () => {
    const { api, controller } = await prepare();
    const path = secretPath(PLATFORM_SECRETS.server);
    const foreign = natsServerLeaf(NS, newSchedulerCa('platform', NS, START), START);
    const secret = api.objects.get(path) as Resource;
    api.seed({ ...secret, data: tlsSecretData(foreign, foreign.cert) } as unknown as Resource);
    api.operations.length = 0;
    for (let i = 0; i < 4; i++) await controller.tick();
    expect(api.platformWrites().filter((w) => w === `PUT ${path}`)).toHaveLength(1);
  });

  it('logs a non-Error failure', async () => {
    const api = new PlatformApi();
    api.call = async () => {
      throw 'boom';
    };
    await new PlatformSchedulerIdentities(api, cfg, () => clock.now).reconcile();
    expect(warned('renewal failed: boom')).toBe(1);
  });
});

// #541 m6e-E: the platform Secrets keep the previous certificate until the renewed user has been in
// the accounts file for the wait, and hostgroup-default rolls only then.
describe('platform identity Secrets after propagation (#541 m6e-E)', () => {
  it('keeps every renewed role on its previous certificate until its user propagated', async () => {
    const { api, controller } = await prepare();
    seedDeployment(api);
    await controller.tick();
    const invariant = new PropagationInvariant(api, () => clock.now);
    const tick = async () => {
      await controller.tick();
      invariant.check();
    };
    const before = Object.fromEntries(
      (['operator', 'host', 'data'] as const).map((role) => [
        role,
        cert(api, PLATFORM_SECRETS[role]),
      ]),
    );
    clock.now = new Date(START.getTime() + 61 * DAY);
    await tick();
    await tick();
    advance(TENANT_OPERATOR_PROPAGATION_MS - 1);
    await tick();
    for (const role of ['operator', 'host', 'data'] as const)
      expect(cert(api, PLATFORM_SECRETS[role])).toBe(before[role] as string);
    expect(annotation(api)).toBeUndefined();
    advance(1);
    await tick();
    for (const role of ['operator', 'host', 'data'] as const)
      expect(cert(api, PLATFORM_SECRETS[role])).not.toBe(before[role] as string);
    expect(annotation(api)).toBe(digestOf(api, 'host'));
  });
});
