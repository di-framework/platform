import { describe, expect, it } from 'bun:test';
import {
  APPLY_RESYNC_INTERVAL_MS,
  ApiError,
  Controller,
  collection,
} from '../src/tenancy/controller';
import type { Resource } from '../src/tenancy/resources';
import { cfg, condition, MemoryApi, prepare, START, stored } from './support/controller-harness';

// #643: a steady-state tick re-sent every managed object as a server-side apply (about 1,800
// non-GET requests a minute with 8 tenants). The controller now skips an apply whose rendered body
// is unchanged while the live object still holds the resourceVersion the last apply returned, and
// applies in full on start, on a Tenant generation change, on a periodic resync, and whenever the
// live object moved or is gone, so drift repair (Layer 4 gate 4.10) is unchanged.

const rolePath = `${collection('rbac.authorization.k8s.io/v1', 'Role', 'di-tenant-alpha')}/di-developer`;
const policyPath = `${collection('networking.k8s.io/v1', 'NetworkPolicy', 'di-runtime-alpha')}/di-tenant-network`;
const apiKeysQuotaPath = `${collection('v1', 'ResourceQuota', 'di-apikeys-alpha')}/di-apikeys-quota`;

/** Records the content type too, so server-side applies are told apart from merge patches. */
class CountingApi extends MemoryApi {
  contentTypes: string[] = [];
  override async call<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType?: string,
  ): Promise<T> {
    this.contentTypes.push(contentType ?? '');
    return super.call<T>(method, path, body);
  }
  /** The paths of this window's server-side applies, without their query. */
  applies(): string[] {
    return this.operations
      .filter(
        (o, i) => o.method === 'PATCH' && this.contentTypes[i] === 'application/apply-patch+yaml',
      )
      .map((o) => o.path.split('?')[0] as string);
  }
  /** Server-side applies this window, counted by resource collection. */
  appliesByResource(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const path of this.applies()) {
      const resource = path.split('/').at(-2) as string;
      counts[resource] = (counts[resource] ?? 0) + 1;
    }
    return counts;
  }
  nonGets(): number {
    return this.operations.filter((o) => o.method !== 'GET').length;
  }
  reset(): void {
    this.operations = [];
    this.contentTypes = [];
  }
}

async function settle(clock: { now: Date }) {
  const { api, controller } = await prepare(new CountingApi(), { pki: true }, () => clock.now);
  await controller.tick();
  const first = api.applies().length;
  return { api, controller, first, tick: () => steadyTick(api, controller, clock) };
}

/** Advances the clock one poll, clears the recorder and ticks. */
async function steadyTick(api: CountingApi, controller: Controller, clock: { now: Date }) {
  clock.now = new Date(clock.now.getTime() + 3_000);
  api.reset();
  await controller.tick();
}

/** Rewrites `path` in place as another writer would: same body, new resourceVersion. */
function handEdit(api: CountingApi, path: string): string {
  const object = api.objects.get(path) as Resource;
  const edited = {
    ...object,
    metadata: { ...object.metadata, labels: { ...object.metadata.labels, edited: 'yes' } },
  };
  api.seed(edited);
  return (api.objects.get(path) as Resource).metadata.resourceVersion as string;
}

describe('apply cache (#643)', () => {
  it('issues no apply and no other write on a steady-state tick', async () => {
    const clock = { now: START };
    const { api, first, tick } = await settle(clock);
    expect(first).toBeGreaterThan(20);
    for (const resource of ['roles', 'networkpolicies', 'deployments', 'services', 'configmaps'])
      expect(api.appliesByResource()[resource]).toBeGreaterThan(0);
    await tick();
    expect(api.applies()).toEqual([]);
    expect(api.nonGets()).toBe(0);
    await tick();
    expect(api.applies()).toEqual([]);
  });

  it('re-applies an object another writer changed, then goes quiet again', async () => {
    const clock = { now: START };
    const { api, tick } = await settle(clock);
    await tick();
    const edited = handEdit(api, rolePath);
    await tick();
    expect(api.applies()).toEqual([rolePath]);
    expect((api.objects.get(rolePath) as Resource).metadata.resourceVersion).not.toBe(edited);
    await tick();
    expect(api.applies()).toEqual([]);
  });

  it('re-creates an object that was deleted', async () => {
    const clock = { now: START };
    const { api, tick } = await settle(clock);
    await tick();
    api.objects.delete(policyPath);
    await tick();
    expect(api.applies()).toEqual([policyPath]);
    expect(api.objects.get(policyPath)?.kind).toBe('NetworkPolicy');
    await tick();
    expect(api.applies()).toEqual([]);
  });

  it('applies an object whose rendered body changed', async () => {
    const clock = { now: START };
    const { api, tick } = await settle(clock);
    await tick();
    // A spec change with the generation left alone: only the hash tells the apply is due.
    stored(api).spec.resources = { apiKeys: 7 };
    await tick();
    expect(api.applies()).toEqual([apiKeysQuotaPath]);
    const quota = api.objects.get(apiKeysQuotaPath) as Resource & {
      spec: { hard: Record<string, string> };
    };
    expect(quota.spec.hard['count/secrets']).toBe('7');
    await tick();
    expect(api.applies()).toEqual([]);
  });

  it('applies every object of a Tenant whose generation moved', async () => {
    const clock = { now: START };
    const { api, first, tick } = await settle(clock);
    await tick();
    stored(api).metadata.generation = 2;
    await tick();
    expect(api.applies().length).toBe(first);
    await tick();
    expect(api.applies()).toEqual([]);
  });

  it('applies every object again on the periodic resync', async () => {
    const clock = { now: START };
    const { api, first, tick } = await settle(clock);
    await tick();
    clock.now = new Date(START.getTime() + APPLY_RESYNC_INTERVAL_MS - 10_000);
    await tick();
    expect(api.applies()).toEqual([]);
    clock.now = new Date(START.getTime() + APPLY_RESYNC_INTERVAL_MS - 3_000);
    await tick();
    expect(api.applies().length).toBe(first);
    await tick();
    expect(api.applies()).toEqual([]);
  });

  it('applies every object again after a restart', async () => {
    const clock = { now: START };
    const { api, first, tick } = await settle(clock);
    await tick();
    expect(api.applies()).toEqual([]);
    const restarted = new Controller(
      api,
      cfg,
      async () => [],
      () => clock.now,
    );
    clock.now = new Date(clock.now.getTime() + 3_000);
    api.reset();
    await restarted.tick();
    expect(api.applies().length).toBe(first);
  });

  it('drops the entries of a Tenant that is gone', async () => {
    const clock = { now: START };
    const { api, tick } = await settle(clock);
    await tick();
    const alpha = stored(api);
    api.objects.delete(`${collection(alpha.apiVersion, 'Tenant')}/alpha`);
    await tick();
    // Listed again with its old generation: as after a restart, everything is applied.
    api.seed(alpha);
    await tick();
    expect(api.applies().length).toBeGreaterThan(20);
  });

  it('passes fieldManager=di-platform-controller&force=true on server-side apply after ownership verification (#660)', async () => {
    const clock = { now: START };
    const { api, tick } = await settle(clock);
    const applyUrls = () =>
      api.operations
        .filter(
          (o, i) => o.method === 'PATCH' && api.contentTypes[i] === 'application/apply-patch+yaml',
        )
        .map((o) => o.path);
    expect(applyUrls().length).toBeGreaterThan(20);
    for (const url of applyUrls())
      expect(url.split('?')[1]).toBe('fieldManager=di-platform-controller&force=true');
    await tick();

    // A foreign fieldManager (e.g. kubectl-label) claims a controller-declared label on an owned
    // object; the API server rejects server-side apply unless force=true is present.
    handEdit(api, rolePath);
    const call = api.call.bind(api);
    api.call = async <T>(
      method: string,
      path: string,
      body?: unknown,
      contentType?: string,
    ): Promise<T> => {
      if (
        method === 'PATCH' &&
        contentType === 'application/apply-patch+yaml' &&
        new URL(path, 'https://kubernetes').searchParams.get('force') !== 'true'
      ) {
        throw new ApiError(
          409,
          `PATCH ${path} returned 409: kubectl-label: .metadata.labels.platform.di-framework.dev/component`,
        );
      }
      return call<T>(method, path, body, contentType);
    };
    await tick();
    expect(applyUrls()).toEqual([`${rolePath}?fieldManager=di-platform-controller&force=true`]);
    expect(condition(api, 'Ready')?.reason).not.toBe('ReconcileError');

    // Unowned objects are still refused by the pre-apply GET check before any PATCH is sent.
    api.seed({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'di-developer', namespace: 'di-tenant-alpha' },
    });
    await tick();
    expect(condition(api, 'Ready')).toMatchObject({
      status: 'False',
      reason: 'ReconcileError',
      message: 'Refusing to adopt Role di-tenant-alpha/di-developer',
    });
    expect(applyUrls().filter((u) => u.startsWith(rolePath))).toEqual([]);
  });
});
