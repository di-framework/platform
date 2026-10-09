import { describe, expect, test } from 'bun:test';
import {
  createApiKey,
  generateKey,
  hashSecret,
  type KeyStore,
  listApiKeys,
  parseKey,
  resolveApiKey,
  revokeApiKey,
} from '../src/keys.ts';
import type { KubeClient, SecretResource } from '../src/kube.ts';

/** An in-memory stand-in for the Secrets the controller stores in the tenant runtime namespace. */
function fakeKube(): KubeClient {
  const secrets = new Map<string, SecretResource>();
  const encode = (value: string) => Buffer.from(value).toString('base64');
  const key = (namespace: string, name: string) => `${namespace}/${name}`;
  return {
    platformNamespace: 'wasmcloud',
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
      return secrets.get(key(namespace, name));
    },
    async deleteSecret(namespace: string, name: string) {
      secrets.delete(key(namespace, name));
    },
    async listSecrets(namespace: string, selector: string) {
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
  } as unknown as KubeClient;
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
