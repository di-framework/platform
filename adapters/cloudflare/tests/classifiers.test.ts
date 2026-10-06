import { describe, expect, it } from 'bun:test';
import type { CloudflareBindingClassifier } from '../src/spi/classifier.ts';
import {
  BindingClassifierRegistry,
  getDefaultRegistry,
  resetDefaultRegistry,
} from '../src/spi/registry.ts';
import type { CloudflareBindingInfo, CloudflareBindingKind } from '../src/types.ts';

const fn = () => undefined;

function binding(methods: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...extra, ...Object.fromEntries(Object.keys(methods).map((key) => [key, fn])) };
}

describe('BindingClassifierRegistry', () => {
  it('classifies host objects by shape', () => {
    const registry = new BindingClassifierRegistry();
    const cases: Array<[unknown, CloudflareBindingKind]> = [
      [{ connectionString: 'postgres://db', host: 'db', database: 'app' }, 'hyperdrive'],
      [binding({ prepare: fn, batch: fn, exec: fn }), 'd1'],
      [binding({ prepare: fn, batch: fn, dump: fn }), 'd1'],
      [binding({ get: fn, put: fn, head: fn, list: fn }), 'r2'],
      [binding({ get: fn, put: fn, delete: fn, list: fn, getWithMetadata: fn }), 'kv'],
      [binding({ get: fn, idFromName: fn, idFromString: fn, newUniqueId: fn }), 'durable-object'],
      [binding({ send: fn, sendBatch: fn }), 'queue'],
      [binding({ query: fn, upsert: fn }), 'vectorize'],
      [binding({ query: fn, insert: fn }), 'vectorize'],
      [binding({ writeDataPoint: fn }), 'analytics'],
      [binding({ run: fn, models: fn }), 'ai'],
      [binding({ run: fn, gateway: fn }), 'ai'],
      [binding({ input: fn, info: fn }), 'images'],
      [binding({ create: fn, get: fn, createBatch: fn }), 'workflow'],
      [binding({ limit: fn }), 'ratelimit'],
      [binding({ launch: fn }), 'browser'],
      [binding({ send: fn }), 'pipeline'],
      [binding({ fetch: fn }), 'service'],
      ['https://example.com', 'var'],
      [42, 'var'],
      [true, 'var'],
      [{}, 'unknown'],
      [fn, 'unknown'],
      [[], 'unknown'],
    ];

    for (const [value, kind] of cases) {
      expect(registry.classify('BINDING', value).kind).toBe(kind);
    }

    const hyperdrive = registry.classify('PG', {
      connectionString: 'postgres://db',
      user: 'app',
    });
    expect(hyperdrive).toMatchObject({ connectionString: 'postgres://db' });
  });

  it('does not treat an R2 bucket as KV or a rate limiter with fetch as a rate limiter', () => {
    const registry = new BindingClassifierRegistry();
    expect(
      registry.classify('MEDIA', binding({ get: fn, put: fn, delete: fn, list: fn, head: fn }))
        .kind,
    ).toBe('r2');
    expect(registry.classify('LIMIT', binding({ limit: fn, fetch: fn })).kind).toBe('service');
    expect(registry.classify('AI', binding({ run: fn })).kind).toBe('unknown');
    expect(registry.classify('PG', { connectionString: 'postgres://db' }).kind).toBe('unknown');
  });

  it('prefers a high-priority classifier and skips classifiers that throw', () => {
    const registry = new BindingClassifierRegistry();
    const throwing: CloudflareBindingClassifier = {
      kind: 'email',
      accept() {
        throw new Error('boom');
      },
      create(name): CloudflareBindingInfo {
        return { name, kind: 'email', binding: true };
      },
    };
    const custom: CloudflareBindingClassifier = {
      kind: 'email',
      accept(_name, value) {
        return value === 'marked';
      },
      create(name, value): CloudflareBindingInfo {
        return { name, kind: 'email', binding: value };
      },
    };
    const fallback: CloudflareBindingClassifier = {
      kind: 'assets',
      accept() {
        return true;
      },
      create(name, value): CloudflareBindingInfo {
        return { name, kind: 'assets', binding: value };
      },
    };

    registry.register(throwing);
    registry.register(custom);
    registry.register(fallback, { priority: 'low' });

    expect(registry.classify('MAIL', 'marked').kind).toBe('email');
    expect(registry.classify('PLAIN', {}).kind).toBe('assets');
    expect(registry.classify('FLAG', 'keep').kind).toBe('var');
  });

  it('starts empty when defaults are disabled', () => {
    const registry = new BindingClassifierRegistry(false);
    expect(registry.classify('FLAG', 'keep')).toEqual({
      name: 'FLAG',
      kind: 'unknown',
      binding: 'keep',
    });
    expect(registry.findClassifier('FLAG', 'keep')).toBeUndefined();
  });

  it('reuses and resets the default registry', () => {
    resetDefaultRegistry();
    const first = getDefaultRegistry();
    expect(getDefaultRegistry()).toBe(first);
    resetDefaultRegistry();
    expect(getDefaultRegistry()).not.toBe(first);
    resetDefaultRegistry();
  });
});
