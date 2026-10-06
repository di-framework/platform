import { afterEach, describe, expect, it } from 'bun:test';
import { Container as CoreContainer } from '@di-framework/core/container';
import { Container } from '@di-framework/core/decorators';
import {
  bindCloudflareBindings,
  CFW_D1_TOKEN,
  CFW_ENVIRONMENT_TOKEN,
  CFW_KV_TOKEN,
  cloudflareBindingToken,
  lookupCloudflareBinding,
} from '../src/bindings.ts';
import { CloudflareBinding, EnableCloudflareBindings } from '../src/decorators.ts';
import {
  CloudflareEnvironment,
  getDefaultEnvironment,
  resetCloudflareBindings,
  setCloudflareBindings,
} from '../src/environment.ts';
import type { CloudflareBindingInfo, D1BindingInfo, KvBindingInfo } from '../src/types.ts';

const fn = () => undefined;
const sessions = { get: fn, put: fn, delete: fn, list: fn };
const orders = { prepare: fn, batch: fn, exec: fn };

afterEach(() => {
  resetCloudflareBindings();
});

describe('bindCloudflareBindings and decorators', () => {
  it('registers lazy factories that see a later Worker env', () => {
    const container = new CoreContainer();
    const snapshot = bindCloudflareBindings(container, { localFallback: false, env: {} });
    expect(snapshot.getBindings()).toEqual([]);
    expect(container.resolve(CFW_KV_TOKEN)).toBeNull();

    setCloudflareBindings({ SESSIONS: sessions, ORDERS: orders });
    const kv = container.resolve<KvBindingInfo>(CFW_KV_TOKEN);
    expect(kv.name).toBe('SESSIONS');
    expect(container.resolve<D1BindingInfo>(CFW_D1_TOKEN).kind).toBe('d1');
    expect(container.resolve<CloudflareEnvironment>(CFW_ENVIRONMENT_TOKEN)).toBeInstanceOf(
      CloudflareEnvironment,
    );
    expect(container.resolve(CloudflareEnvironment)).toBeInstanceOf(CloudflareEnvironment);

    setCloudflareBindings({ CACHE: sessions });
    expect(container.resolve<KvBindingInfo>(CFW_KV_TOKEN).name).toBe('CACHE');
  });

  it('injects properties, fallbacks, and defaults', () => {
    const container = new CoreContainer();
    bindCloudflareBindings(container, {
      bindings: { SESSIONS: sessions },
      localFallback: false,
      env: {},
    });

    class ServiceClass {
      @CloudflareBinding('SESSIONS', { container, bindings: { SESSIONS: sessions } })
      kv!: KvBindingInfo;

      @CloudflareBinding('MISSING', {
        container,
        bindings: {},
        fallbackEnv: ['ABSENT', 'FALLBACK_URL'],
        env: { ABSENT: '', FALLBACK_URL: 'https://fallback.test' },
      })
      fallback!: CloudflareBindingInfo;

      @CloudflareBinding('ALSO_MISSING', {
        container,
        bindings: {},
        defaultValue: { name: 'default', kind: 'unknown' },
      })
      optional!: { name: string };
    }

    const instance = new ServiceClass();
    expect(instance.kv.name).toBe('SESSIONS');
    expect(instance.kv.kind).toBe('kv');
    expect(instance.fallback.binding).toBe('https://fallback.test');
    expect(instance.optional.name).toBe('default');
    instance.kv = { name: 'custom', kind: 'kv' };
    expect(instance.kv.name).toBe('custom');
  });

  it('throws when a required binding is missing and allows required: false', () => {
    class StrictClass {
      @CloudflareBinding('MISSING', { container: new CoreContainer(), bindings: {} })
      kv!: KvBindingInfo;
    }

    const instance = new StrictClass();
    expect(() => instance.kv).toThrow(/MISSING/);
    expect(
      lookupCloudflareBinding('MISSING', { bindings: {}, required: false, env: {} }),
    ).toBeUndefined();
    expect(
      lookupCloudflareBinding('MISSING', {
        bindings: {},
        fallbackEnv: ['EMPTY', 'ALSO_EMPTY'],
        env: { EMPTY: '', ALSO_EMPTY: '' },
        required: false,
      }),
    ).toBeUndefined();
    expect(
      lookupCloudflareBinding('MISSING', {
        bindings: {},
        fallbackEnv: 'ONE',
        env: { ONE: 'value' },
      }),
    ).toMatchObject({ kind: 'var', binding: 'value' });

    const lookupContainer = {
      resolve(): unknown {
        throw new Error('unregistered');
      },
    };
    class LookupClass {
      @CloudflareBinding('SESSIONS', {
        container: lookupContainer,
        bindings: { SESSIONS: sessions },
      })
      kv!: KvBindingInfo;

      @CloudflareBinding('MISSING', { container: lookupContainer, bindings: {}, required: false })
      missing!: KvBindingInfo | undefined;
    }
    const lookedUp = new LookupClass();
    expect(lookedUp.kv.name).toBe('SESSIONS');
    expect(lookedUp.kv.name).toBe('SESSIONS');
    expect(lookedUp.missing).toBeUndefined();
  });

  it('supports constructor injection after the handler publishes env', () => {
    const container = new CoreContainer();

    @EnableCloudflareBindings({ container, localFallback: false, env: {} })
    @Container({ container })
    class WorkerService {
      constructor(
        @CloudflareBinding('ORDERS', { container, localFallback: false })
        public db: D1BindingInfo,
      ) {}
    }

    setCloudflareBindings({ ORDERS: orders });
    const resolved = container.resolve(WorkerService);
    expect(resolved.db.name).toBe('ORDERS');
    expect(container.resolve<D1BindingInfo>(CFW_D1_TOKEN).name).toBe('ORDERS');
  });

  it('keeps an existing registration and supports containers without factories', () => {
    const container = new CoreContainer();
    container.registerValue(cloudflareBindingToken('SESSIONS'), { name: 'preset', kind: 'kv' });
    bindCloudflareBindings(container, { bindings: { SESSIONS: sessions }, env: {} });
    expect(container.resolve<{ name: string }>(cloudflareBindingToken('SESSIONS')).name).toBe(
      'preset',
    );

    const values = new Map<string, unknown>();
    const valueContainer = {
      registerValue(token: string, value: unknown) {
        values.set(token, value);
      },
    };
    bindCloudflareBindings(valueContainer, { bindings: { SESSIONS: sessions }, env: {} });
    expect((values.get(cloudflareBindingToken('SESSIONS')) as KvBindingInfo).name).toBe('SESSIONS');
    expect(values.get(CFW_ENVIRONMENT_TOKEN)).toBeInstanceOf(CloudflareEnvironment);

    const instances = new Map<string, unknown>();
    const instanceContainer = {
      registerInstance(token: string, value: unknown) {
        instances.set(token, value);
      },
    };
    bindCloudflareBindings(instanceContainer, {
      bindings: { API_HOST: 'https://example.com' },
      env: {},
    });
    expect(instances.get(cloudflareBindingToken('API_HOST'))).toMatchObject({ kind: 'var' });

    const snapshot = bindCloudflareBindings(
      { has: () => false },
      { bindings: { A: 'x' }, env: {} },
    );
    expect(snapshot.getBinding('A')?.binding).toBe('x');
    const isolated = new CoreContainer();
    expect(
      bindCloudflareBindings(undefined, {
        container: isolated,
        bindings: { B: 'y' },
        env: {},
      }).getBinding('B')?.binding,
    ).toBe('y');
    expect(isolated.resolve<{ binding: string }>(cloudflareBindingToken('B')).binding).toBe('y');

    const registered: unknown[] = [];
    const functionContainer = Object.assign(() => undefined, {
      registerValue(_token: string, value: unknown) {
        registered.push(value);
      },
    });
    bindCloudflareBindings(functionContainer, { bindings: { A: 'fn' }, env: {} });
    expect(
      registered.some(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          (value as { binding?: string }).binding === 'fn',
      ),
    ).toBe(true);

    expect(
      bindCloudflareBindings(1, { bindings: { A: 'z' }, env: {} }).getBinding('A')?.binding,
    ).toBe('z');
  });

  it('publishes bindings to the default environment', () => {
    resetCloudflareBindings();
    const original = process.env.CLOUDFLARE_BINDINGS;
    delete process.env.CLOUDFLARE_BINDINGS;
    try {
      expect(getDefaultEnvironment().getBinding('SESSIONS')).toBeNull();
      setCloudflareBindings({ SESSIONS: sessions });
      expect(getDefaultEnvironment().getKvBinding('SESSIONS')?.name).toBe('SESSIONS');
      const cached = getDefaultEnvironment();
      setCloudflareBindings({ SESSIONS: sessions });
      expect(getDefaultEnvironment()).not.toBe(cached);
    } finally {
      if (original === undefined) delete process.env.CLOUDFLARE_BINDINGS;
      else process.env.CLOUDFLARE_BINDINGS = original;
      resetCloudflareBindings();
    }
  });
});
