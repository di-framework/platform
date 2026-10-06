import { describe, expect, it } from 'bun:test';
import { CloudflareEnvironment, resetCloudflareBindings } from '../src/environment.ts';
import type { CloudflareBindingClassifier } from '../src/spi/classifier.ts';
import { BindingClassifierRegistry } from '../src/spi/registry.ts';
import type { CloudflareBindingInfo, HyperdriveBindingInfo, KvBindingInfo } from '../src/types.ts';

const fn = () => undefined;

const kv = { get: fn, put: fn, delete: fn, list: fn };
const otherKv = { get: fn, put: fn, delete: fn, list: fn };
const bucket = { get: fn, put: fn, head: fn };
const database = { prepare: fn, batch: fn, exec: fn };
const hyperdrive = { connectionString: 'postgres://db/app', host: 'db', database: 'app' };

describe('CloudflareEnvironment', () => {
  it('classifies a Worker env and returns typed primaries in name order', () => {
    const env = new CloudflareEnvironment({
      bindings: {
        SESSIONS: kv,
        CACHE: otherKv,
        MEDIA: bucket,
        ORDERS: database,
        PG: hyperdrive,
        API_HOST: 'https://example.com',
        ENABLED: false,
      },
      env: {},
      scope: {},
      secretNames: ['API_HOST'],
    });

    expect(env.isCloudflare()).toBe(false);
    expect(env.getBindings().map((binding) => binding.name)).toEqual([
      'API_HOST',
      'CACHE',
      'ENABLED',
      'MEDIA',
      'ORDERS',
      'PG',
      'SESSIONS',
    ]);
    expect(env.getBinding('SESSIONS')?.kind).toBe('kv');
    expect(env.getKvBinding()?.name).toBe('CACHE');
    expect(env.getKvBinding('SESSIONS')?.kind).toBe('kv');
    expect(env.getKvBinding('MEDIA')).toBeNull();
    expect(env.getD1Binding()?.name).toBe('ORDERS');
    expect(env.getR2Binding()?.name).toBe('MEDIA');
    expect(env.getHyperdriveBinding()?.connectionString).toBe('postgres://db/app');
    expect(env.getQueueBinding()).toBeNull();
    expect(env.getServiceBinding()).toBeNull();
    expect(env.getAiBinding()).toBeNull();
    expect(env.getDurableObjectBinding()).toBeNull();
    expect(env.getVectorizeBinding()).toBeNull();
    expect(env.getAnalyticsBinding()).toBeNull();
    expect(env.getBindingByKind('secret')?.name).toBe('API_HOST');
    expect(env.getBindingByKind<KvBindingInfo>('kv', 'ORDERS')).toBeNull();
    expect(env.getBindings(/^S/)?.map((binding) => binding.name)).toEqual(['SESSIONS']);
    expect(
      env.getBindings({ kind: 'kv', predicate: (binding) => binding.name === 'NOPE' }),
    ).toEqual([]);
    expect(env.getBindings({ name: /MEDIA/, kind: 'r2' })).toHaveLength(1);
    expect(env.getBindings({ name: 'MISSING' })).toEqual([]);
    expect(env.getBinding('MISSING')).toBeNull();
    expect(env.getBindings()).toBe(env.getBindings());
  });

  it('lets wrangler declarations and kind hints override the live shape', () => {
    const env = new CloudflareEnvironment({
      bindings: {
        ASSETS: { fetch: fn },
        API_TOKEN: 'secret-value',
        PG: null,
        DROPPED: null,
      },
      config: {
        assets: { binding: 'ASSETS' },
        hyperdrive: [{ binding: 'PG', connectionString: 'postgres://config' }],
        vars: { API_HOST: 'https://from-config.test' },
        kv_namespaces: [{ binding: 'DECLARED' }],
      },
      kindHints: { API_TOKEN: 'var' },
      secretNames: ['API_HOST'],
      env: {},
      scope: { navigator: { userAgent: 'Cloudflare-Workers' } },
    });

    expect(env.isCloudflare()).toBe(true);
    expect(env.getBinding('ASSETS')?.kind).toBe('assets');
    expect(env.getBinding('API_TOKEN')?.kind).toBe('var');
    expect(env.getBinding('API_HOST')).toMatchObject({
      kind: 'secret',
      binding: 'https://from-config.test',
    });
    expect((env.getHyperdriveBinding('PG') as HyperdriveBindingInfo).connectionString).toBe(
      'postgres://config',
    );
    expect(env.getKvBinding('DECLARED')?.binding).toBeUndefined();
    expect(env.getBinding('DROPPED')).toBeNull();
    expect(
      env
        .getDeclarations()
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['API_HOST', 'ASSETS', 'DECLARED', 'PG']);
    expect(env.getDeclarations()).toBe(env.getDeclarations());
  });

  it('reads local fallback JSON and ignores it when bindings are explicit or disabled', () => {
    resetCloudflareBindings();
    const fromObject = new CloudflareEnvironment({
      localFallback: { FLAG: 'object' },
      env: { CLOUDFLARE_BINDINGS: JSON.stringify({ FLAG: 'json' }) },
      scope: {},
    });
    expect(fromObject.getBinding('FLAG')?.binding).toBe('object');

    const fromJson = new CloudflareEnvironment({
      env: { CLOUDFLARE_BINDINGS: JSON.stringify({ FLAG: 'json', NESTED: { ok: true } }) },
      scope: { navigator: {} },
    });
    expect(fromJson.isCloudflare()).toBe(false);
    expect(fromJson.getBinding('FLAG')?.binding).toBe('json');
    expect(fromJson.getBinding('NESTED')?.kind).toBe('unknown');

    expect(
      new CloudflareEnvironment({
        env: { CLOUDFLARE_BINDINGS: 'not-json', CF_PAGES: '1' },
        scope: {},
      }).getBindings(),
    ).toEqual([]);
    expect(
      new CloudflareEnvironment({
        env: { CLOUDFLARE_BINDINGS: '[]' },
        scope: {},
      }).getBindings(),
    ).toEqual([]);
    expect(
      new CloudflareEnvironment({
        env: { CLOUDFLARE_BINDINGS: '"nope"' },
        scope: {},
      }).getBindings(),
    ).toEqual([]);
    expect(
      new CloudflareEnvironment({
        bindings: {},
        env: { CLOUDFLARE_BINDINGS: JSON.stringify({ FLAG: 'json' }) },
        scope: {},
      }).getBindings(),
    ).toEqual([]);
    expect(
      new CloudflareEnvironment({
        localFallback: false,
        env: { CLOUDFLARE_BINDINGS: JSON.stringify({ FLAG: 'json' }), CF_PAGES: '1' },
        scope: {},
      }).isCloudflare(),
    ).toBe(true);
    expect(
      new CloudflareEnvironment({
        localFallback: false,
        env: { CLOUDFLARE_BINDINGS: JSON.stringify({ FLAG: 'json' }) },
        scope: {},
      }).getBindings(),
    ).toEqual([]);
  });

  it('uses a caller-supplied registry', () => {
    const registry = new BindingClassifierRegistry(false);
    const classifier: CloudflareBindingClassifier = {
      kind: 'email',
      accept: () => true,
      create(name, value): CloudflareBindingInfo {
        return { name, kind: 'email', binding: value };
      },
    };
    registry.register(classifier);
    const env = new CloudflareEnvironment({
      bindings: { MAIL: { send: fn } },
      registry,
      env: {},
      scope: {},
    });
    expect(env.getBinding('MAIL')?.kind).toBe('email');
  });
});
