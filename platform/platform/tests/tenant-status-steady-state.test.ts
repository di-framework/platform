import { describe, expect, it } from 'bun:test';
import { collection, mergePatch, sameValue } from '../src/tenancy/controller';
import { INSTALLATION, VERSION } from '../src/tenancy/resources';
import { MemoryApi, prepare, START, stored } from './support/controller-harness';

// #595: the API server returns status keys sorted, so the controller must compare the Tenant
// status structurally or it PATCHes every Tenant's status on every tick.

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
  );
};

const userPath = `${collection(VERSION, 'User')}/bob`;

/**
 * Answers every call with its keys sorted, as the API server does, and stores them sorted. A
 * status PATCH is a merge patch: `null` deletes a key (the base fake keeps it as `null`).
 */
class SortedApi extends MemoryApi {
  failDeployments = false;
  override async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.failDeployments && method === 'PATCH' && path.includes('/deployments/'))
      throw new Error('deployment apply failed');
    const before = this.objects.get(path.replace(/\/status$/, ''));
    const result = await super.call<T>(method, path, body);
    if (method === 'PATCH' && path.endsWith('/status')) {
      const target = path.replace(/\/status$/, '');
      const merged = mergePatch(
        (before as { status?: object } | undefined)?.status,
        (body as { status: object }).status,
      );
      const object = this.objects.get(target) as { status?: object };
      object.status = merged;
      (result as { status?: object }).status = merged;
    }
    for (const [k, v] of this.objects) this.objects.set(k, sortKeys(v) as typeof v);
    return sortKeys(result) as T;
  }
  statusPatches(): number {
    return this.operations.filter((o) => o.method === 'PATCH' && o.path.endsWith('/status')).length;
  }
}

const clock = { now: START };

async function settle() {
  const { api, controller } = await prepare(new SortedApi(), { pki: true }, () => clock.now);
  for (let i = 0; i < 6; i++) {
    await controller.tick();
    clock.now = new Date(clock.now.getTime() + 60 * 60 * 1000);
  }
  return { api, controller };
}

describe('Tenant status write (#595)', () => {
  it('issues no status PATCH on steady-state ticks when the API server sorts keys', async () => {
    const { api, controller } = await settle();
    expect(stored(api).status?.conditions?.length).toBeGreaterThan(0);
    api.operations = [];
    await controller.tick();
    await controller.tick();
    expect(api.statusPatches()).toBe(0);
  });

  it('still PATCHes the status when it changes, keeping lastTransitionTime', async () => {
    const { api, controller } = await settle();
    const before = stored(api).status?.conditions?.find((c) => c.type === 'Ready');
    stored(api).metadata.generation = 2;
    api.operations = [];
    await controller.tick();
    expect(api.statusPatches()).toBe(1);
    expect(stored(api).status?.observedGeneration).toBe(2);
    const after = stored(api).status?.conditions?.find((c) => c.type === 'Ready');
    expect(after?.status).toEqual(before?.status);
    expect(after?.lastTransitionTime).toEqual(before?.lastTransitionTime);
  });
});

describe('Unhealthy Tenant status write (#630)', () => {
  it('issues no status PATCH for a suspended User, whose desired serviceAccount is null', async () => {
    const { api, controller } = await settle();
    api.seed({
      apiVersion: VERSION,
      kind: 'User',
      metadata: { name: 'bob', uid: 'bob-uid', generation: 1, labels: { [INSTALLATION]: 'test' } },
      spec: { memberships: [], suspended: true },
    } as never);
    await controller.tick();
    await controller.tick();
    const status = (api.objects.get(userPath) as { status?: Record<string, unknown> }).status;
    expect(status?.conditions).toBeDefined();
    expect('serviceAccount' in (status ?? {})).toBe(false);
    api.operations = [];
    await controller.tick();
    await controller.tick();
    expect(api.statusPatches()).toBe(0);
  });

  it('issues no status PATCH for a Tenant stuck in ReconcileError after a success', async () => {
    const { api, controller } = await settle();
    expect(stored(api).status?.namespace).toBeDefined();
    api.failDeployments = true;
    await controller.tick();
    await controller.tick();
    const ready = stored(api).status?.conditions?.find((c) => c.type === 'Ready');
    expect(ready).toMatchObject({ reason: 'ReconcileError', message: 'deployment apply failed' });
    expect(stored(api).status?.namespace).toBeDefined();
    api.operations = [];
    await controller.tick();
    await controller.tick();
    expect(api.statusPatches()).toBe(0);
  });
});

describe('mergePatch', () => {
  it('deletes null keys, merges objects and replaces everything else', () => {
    expect(
      mergePatch<unknown>({ a: 1, b: { c: 1, d: 2 }, e: [1] }, { a: null, b: { c: null }, e: [2] }),
    ).toEqual({
      b: { d: 2 },
      e: [2],
    });
    expect(mergePatch<unknown>(undefined, { a: { b: null, c: 1 } })).toEqual({ a: { c: 1 } });
    expect(mergePatch<unknown>([1], { a: 1 })).toEqual({ a: 1 });
    expect(mergePatch<unknown>({ a: 1 }, 'x')).toBe('x');
  });
});

describe('sameValue', () => {
  it('ignores key order and undefined members', () => {
    expect(sameValue({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1, c: undefined }, { a: 1 })).toBe(true);
    expect(sameValue(null, null)).toBe(true);
  });
  it('reports differences', () => {
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue([1], { 0: 1 })).toBe(false);
    expect(sameValue(undefined, {})).toBe(false);
  });
});
