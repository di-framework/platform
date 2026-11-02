import { describe, expect, it } from 'bun:test';
import { sameValue } from '../src/tenancy/controller';
import { MemoryApi, prepare, START, stored, tenantPath } from './support/controller-harness';

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

/** Answers every call with its keys sorted, as the API server does, and stores them sorted. */
class SortedApi extends MemoryApi {
  override async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await super.call<T>(method, path, body);
    for (const [k, v] of this.objects) this.objects.set(k, sortKeys(v) as typeof v);
    return sortKeys(result) as T;
  }
  statusPatches(): number {
    return this.operations.filter((o) => o.method === 'PATCH' && o.path === `${tenantPath}/status`)
      .length;
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
