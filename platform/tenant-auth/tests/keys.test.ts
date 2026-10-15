import { describe, expect, test } from 'bun:test';
import {
  ApiKeyMigrationPending,
  apiKeysNamespace,
  createApiKey,
  generateKey,
  hashSecret,
  type KeyStore,
  type LegacyKeys,
  legacyKeys,
  listApiKeys,
  parseKey,
  resolveApiKey,
  revokeApiKey,
} from '../src/keys.ts';
import { type KubeClient, KubeError, type SecretResource } from '../src/kube.ts';

/** Knobs of {@link fakeKube}, for the move to `di-apikeys-<tenant>` (#379). */
interface FakeKubeState {
  /** Namespaces whose Secrets the controller may not read (its rule there is gone). */
  forbidden: Set<string>;
  /** Namespaces whose Secret reads fail with a server error. */
  failing?: Set<string>;
  /** The Tenant's `status.apiKeysMigrated`; `error` makes the read fail. */
  migrated: boolean | 'error';
  tenantReads: number;
}
/** An in-memory stand-in for the Secrets the controller stores, keyed `<namespace>/<name>`. */
function fakeKube(state?: FakeKubeState): KubeClient & { secrets: Map<string, SecretResource> } {
  const secrets = new Map<string, SecretResource>();
  const encode = (value: string) => Buffer.from(value).toString('base64');
  const key = (namespace: string, name: string) => `${namespace}/${name}`;
  const guard = (namespace: string) => {
    if (state?.forbidden.has(namespace)) throw new KubeError(403, 'secrets is forbidden');
    if (state?.failing?.has(namespace)) throw new KubeError(500, 'etcdserver: request timed out');
  };
  return {
    secrets,
    platformNamespace: 'wasmcloud',
    async getTenant(name: string) {
      if (!state) return undefined;
      state.tenantReads++;
      if (state.migrated === 'error') throw new KubeError(500, 'unavailable');
      return { metadata: { name }, spec: {}, status: { apiKeysMigrated: state.migrated } };
    },
    async createSecret(namespace: string, secret: SecretResource) {
      const data = Object.fromEntries(
        Object.entries(secret.stringData ?? {}).map(([k, v]) => [k, encode(v)]),
      );
      const stored = {
        ...secret,
        data,
        metadata: { ...secret.metadata, creationTimestamp: new Date().toISOString() },
      };
      secrets.set(key(namespace, secret.metadata.name), stored);
      return stored;
    },
    async getSecret(namespace: string, name: string) {
      guard(namespace);
      return secrets.get(key(namespace, name));
    },
    async deleteSecret(namespace: string, name: string) {
      guard(namespace);
      secrets.delete(key(namespace, name));
    },
    async listSecrets(namespace: string, selector: string) {
      guard(namespace);
      const wanted = Object.fromEntries(
        selector.split(',').map((part) => part.split('=') as [string, string]),
      );
      return {
        items: [...secrets.entries()]
          .filter(([k]) => k.startsWith(`${namespace}/`))
          .map(([, s]) => s)
          .filter((s) => Object.entries(wanted).every(([k, v]) => s.metadata.labels?.[k] === v)),
      };
    },
  } as unknown as KubeClient & { secrets: Map<string, SecretResource> };
}
const storeFor = (kube: KubeClient, tenant = 'acme'): KeyStore => ({
  kube,
  namespace: `di-runtime-${tenant}`,
  tenant,
});

describe('key format', () => {
  test('round-trips through parse', () => {
    const key = generateKey();
    expect(parseKey(key.value)).toEqual({ id: key.id, secret: key.secret });
  });
  test('rejects malformed values', () => {
    expect(parseKey('dik_short_x')).toBeUndefined();
    expect(parseKey('')).toBeUndefined();
    expect(parseKey(`${generateKey().value}extra`)).toBeUndefined();
  });
  test('hashes deterministically', async () => {
    expect(await hashSecret('a')).toBe(await hashSecret('a'));
    expect(await hashSecret('a')).not.toBe(await hashSecret('b'));
  });
});

describe('api keys in the cluster', () => {
  test('create, resolve, list, and revoke', async () => {
    const store = storeFor(fakeKube());
    const issued = await createApiKey(store, 'alice', 'ci', 3600);
    expect(issued.secret.startsWith('dik_')).toBe(true);
    const resolved = await resolveApiKey(store, issued.secret);
    expect(resolved).toMatchObject({ id: issued.id, tenant: 'acme', user: 'alice', name: 'ci' });
    expect((await listApiKeys(store, 'alice')).map((k) => k.id)).toEqual([issued.id]);
    expect(await listApiKeys(store, 'bob')).toEqual([]);
    expect(await revokeApiKey(store, 'bob', issued.id)).toBe(false);
    expect(await revokeApiKey(store, 'alice', issued.id)).toBe(true);
    await expect(resolveApiKey(store, issued.secret)).rejects.toThrow('unknown or revoked');
  });
  test('a key is only valid in the tenant that issued it', async () => {
    const kube = fakeKube();
    const issued = await createApiKey(storeFor(kube, 'acme'), 'alice', 'ci', 3600);
    await expect(resolveApiKey(storeFor(kube, 'other'), issued.secret)).rejects.toThrow(
      'unknown or revoked',
    );
  });
  test('rejects a wrong secret for a known id', async () => {
    const store = storeFor(fakeKube());
    const issued = await createApiKey(store, 'alice', 'ci', 3600);
    const forged = issued.secret.slice(0, -1) + (issued.secret.endsWith('a') ? 'b' : 'a');
    await expect(resolveApiKey(store, forged)).rejects.toThrow('unknown or revoked');
  });
  test('rejects an expired key', async () => {
    const store = storeFor(fakeKube());
    const issued = await createApiKey(store, 'alice', 'ci', -1);
    await expect(resolveApiKey(store, issued.secret)).rejects.toThrow('expired');
  });
});

describe('api keys across the move to di-apikeys-<tenant> (#379)', () => {
  const RUNTIME = 'di-runtime-acme';
  const KEYS = 'di-apikeys-acme';
  function setup() {
    const state: FakeKubeState = { forbidden: new Set(), migrated: false, tenantReads: 0 };
    const kube = fakeKube(state);
    let now = 0;
    const store: KeyStore = {
      kube,
      namespace: apiKeysNamespace('acme'),
      tenant: 'acme',
      legacy: legacyKeys(kube, 'acme', () => now),
    };
    /** A key created by a tenant-auth from before #379, in the runtime namespace. */
    const legacyKey = (user = 'alice') =>
      createApiKey({ ...store, namespace: RUNTIME }, user, 'ci', 3600);
    /** The platform controller's steps (platform/src/tenancy/api-keys.ts). */
    const copy = (id: string) =>
      kube.secrets.set(
        `${KEYS}/di-apikey-${id}`,
        structuredClone(kube.secrets.get(`${RUNTIME}/di-apikey-${id}`) as SecretResource),
      );
    const deleteOriginal = (id: string) => kube.secrets.delete(`${RUNTIME}/di-apikey-${id}`);
    const markDone = () => {
      state.forbidden.add(RUNTIME);
      state.migrated = true;
      now += 60_000;
    };
    return {
      state,
      kube,
      store,
      legacyKey,
      copy,
      deleteOriginal,
      markDone,
      tick: (ms: number) => (now += ms),
    };
  }

  test('creates new keys in the API-key namespace only', async () => {
    const { kube, store } = setup();
    const issued = await createApiKey(store, 'alice', 'ci', 3600);
    expect([...kube.secrets.keys()]).toEqual([`${KEYS}/di-apikey-${issued.id}`]);
    expect((await resolveApiKey(store, issued.secret)).id).toBe(issued.id);
  });

  test('a valid key works at every step of its move, and after it', async () => {
    const { store, legacyKey, copy, deleteOriginal, markDone } = setup();
    const issued = await legacyKey();
    const works = async () => {
      expect((await resolveApiKey(store, issued.secret)).id).toBe(issued.id);
      expect((await listApiKeys(store, 'alice')).map((k) => k.id)).toEqual([issued.id]);
    };
    await works(); // old layout only
    copy(issued.id);
    await works(); // in both: listed once
    deleteOriginal(issued.id);
    await works(); // new layout only
    markDone();
    await works(); // the old namespace is no longer read (and would answer 403)
  });

  test('a 403 in the old namespace before the done signal counts as nothing there', async () => {
    const { state, store } = setup();
    state.forbidden.add(RUNTIME);
    const issued = await createApiKey(store, 'alice', 'ci', 3600);
    expect((await resolveApiKey(store, issued.secret)).id).toBe(issued.id);
    expect((await listApiKeys(store, 'alice')).map((k) => k.id)).toEqual([issued.id]);
    await expect(resolveApiKey(store, generateKey().value)).rejects.toThrow('unknown or revoked');
    expect(await revokeApiKey(store, 'alice', issued.id)).toBe(true);
  });

  test('any other failure in the old namespace is an error, not a missing key', async () => {
    const { state, store } = setup();
    state.failing = new Set([RUNTIME]);
    await expect(resolveApiKey(store, generateKey().value)).rejects.toThrow('timed out');
  });

  test('stops reading the old layout once the platform reports the move done', async () => {
    const { state, store, legacyKey, markDone } = setup();
    const issued = await legacyKey();
    markDone();
    state.forbidden.delete(RUNTIME);
    // Still there (as if left over), but no longer read: only the new layout counts.
    await expect(resolveApiKey(store, issued.secret)).rejects.toThrow('unknown or revoked');
    expect(await listApiKeys(store, 'alice')).toEqual([]);
  });

  test('refuses to revoke a key that is still in the old namespace', async () => {
    const { kube, store, legacyKey, copy, deleteOriginal } = setup();
    const issued = await legacyKey();
    await expect(revokeApiKey(store, 'alice', issued.id)).rejects.toBeInstanceOf(
      ApiKeyMigrationPending,
    );
    // Copied, original not yet deleted: deleting only the copy would let the move copy it back.
    copy(issued.id);
    await expect(revokeApiKey(store, 'alice', issued.id)).rejects.toBeInstanceOf(
      ApiKeyMigrationPending,
    );
    expect(kube.secrets.has(`${KEYS}/di-apikey-${issued.id}`)).toBe(true);
    // Still only its owner learns that it exists.
    expect(await revokeApiKey(store, 'bob', issued.id)).toBe(false);
    deleteOriginal(issued.id);
    expect(await revokeApiKey(store, 'alice', issued.id)).toBe(true);
    await expect(resolveApiKey(store, issued.secret)).rejects.toThrow('unknown or revoked');
  });

  test('reads the Tenant status at most every 30s until it reports done, then never again', async () => {
    const { state, store, tick } = setup();
    const legacy = store.legacy as LegacyKeys;
    expect(await legacy.migrated()).toBe(false);
    expect(await legacy.migrated()).toBe(false);
    expect(state.tenantReads).toBe(1);
    state.migrated = true;
    tick(29_999);
    expect(await legacy.migrated()).toBe(false);
    tick(1);
    expect(await legacy.migrated()).toBe(true);
    state.migrated = false;
    tick(60_000);
    expect(await legacy.migrated()).toBe(true);
    expect(state.tenantReads).toBe(2);
  });

  test('keeps reading both layouts when the Tenant cannot be read', async () => {
    const { state, store, legacyKey } = setup();
    state.migrated = 'error';
    const issued = await legacyKey();
    expect((await resolveApiKey(store, issued.secret)).id).toBe(issued.id);
  });

  test('a store without the old layout reads only its own namespace', async () => {
    const { kube, legacyKey } = setup();
    const issued = await legacyKey();
    const store: KeyStore = { kube, namespace: KEYS, tenant: 'acme' };
    await expect(resolveApiKey(store, issued.secret)).rejects.toThrow('unknown or revoked');
  });
});
