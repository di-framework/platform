import { describe, expect, it } from 'bun:test';
import {
  type ApiKeyMigrationIo,
  type ApiKeySecret,
  apiKeyCopy,
  apiKeysNamespace,
  migrateApiKeys,
} from '../src/tenancy/api-keys';
import { crds, names, type Tenant, tenantResources, VERSION } from '../src/tenancy/resources';

// #379: tenant API keys move from `di-runtime-<tenant>` to `di-apikeys-<tenant>`.

const RUNTIME = 'di-runtime-acme';
const KEYS = 'di-apikeys-acme';
const keyLabels = (tenant = 'acme', user = 'alice') => ({
  'platform.di-framework.dev/api-key': 'true',
  'platform.di-framework.dev/tenant': tenant,
  'platform.di-framework.dev/user': user,
});
const legacyKey = (id: string, extra: Partial<ApiKeySecret['metadata']> = {}): ApiKeySecret => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: {
    name: `di-apikey-${id}`,
    namespace: RUNTIME,
    uid: `uid-${id}`,
    labels: keyLabels(),
    ...extra,
  },
  type: 'Opaque',
  data: { hash: Buffer.from(`hash-${id}`).toString('base64'), name: 'Y2k=' },
});
const A = '0123456789abcdef';
const B = 'fedcba9876543210';

/** Secrets by `<namespace>/<name>`, with a log of the writes. */
class FakeSecrets implements ApiKeyMigrationIo {
  objects = new Map<string, ApiKeySecret>();
  writes: string[] = [];
  ready = true;
  /** Fails the next call of this kind once. */
  failNext?: 'create' | 'remove';
  seed(secret: ApiKeySecret, namespace = secret.metadata.namespace as string) {
    this.objects.set(`${namespace}/${secret.metadata.name}`, {
      ...structuredClone(secret),
      metadata: { ...structuredClone(secret.metadata), namespace },
    });
  }
  async list(namespace: string, labels: Record<string, string>) {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${namespace}/`))
      .map(([, secret]) => structuredClone(secret))
      .filter((s) => Object.entries(labels).every(([k, v]) => s.metadata.labels?.[k] === v));
  }
  async get(namespace: string, name: string) {
    const value = this.objects.get(`${namespace}/${name}`);
    return value && structuredClone(value);
  }
  async create(secret: ApiKeySecret) {
    if (this.failNext === 'create') {
      this.failNext = undefined;
      throw new Error('create failed');
    }
    const key = `${secret.metadata.namespace}/${secret.metadata.name}`;
    this.writes.push(`create ${key}`);
    if (!this.objects.has(key)) this.objects.set(key, structuredClone(secret));
  }
  async remove(secret: ApiKeySecret) {
    if (this.failNext === 'remove') {
      this.failNext = undefined;
      throw new Error('delete failed');
    }
    const key = `${secret.metadata.namespace}/${secret.metadata.name}`;
    this.writes.push(`delete ${key}`);
    if (this.objects.get(key)?.metadata.uid === secret.metadata.uid) this.objects.delete(key);
  }
  async rolledOut() {
    return this.ready;
  }
  names(namespace: string) {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(`${namespace}/`))
      .map((key) => key.slice(namespace.length + 1))
      .sort();
  }
}

describe('API-key migration (#379)', () => {
  it('is done at once when the runtime namespace holds no key (new layout or fresh tenant)', async () => {
    const io = new FakeSecrets();
    io.ready = false;
    io.seed(apiKeyCopy(legacyKey(A), 'acme'));
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual({ done: true, moved: 0 });
    expect(io.writes).toEqual([]);
  });

  it('moves nothing until the tenant controller runs an image that reads the new namespace', async () => {
    const io = new FakeSecrets();
    io.ready = false;
    io.seed(legacyKey(A));
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual({ done: false, moved: 0 });
    expect(io.writes).toEqual([]);
    expect(io.names(RUNTIME)).toEqual([`di-apikey-${A}`]);
  });

  it('copies each key with the same name, labels and data, then deletes the original', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A));
    io.seed(legacyKey(B, { labels: keyLabels('acme', 'bob') }));
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual({ done: true, moved: 2 });
    expect(io.names(RUNTIME)).toEqual([]);
    expect(io.names(KEYS)).toEqual([`di-apikey-${A}`, `di-apikey-${B}`]);
    const copy = (await io.get(KEYS, `di-apikey-${B}`)) as ApiKeySecret;
    expect(copy.metadata.labels).toEqual(keyLabels('acme', 'bob'));
    expect(copy.data).toEqual(legacyKey(B).data);
    expect(copy.type).toBe('Opaque');
    // Each original is deleted only after its copy exists.
    expect(io.writes).toEqual([
      `create ${KEYS}/di-apikey-${A}`,
      `delete ${RUNTIME}/di-apikey-${A}`,
      `create ${KEYS}/di-apikey-${B}`,
      `delete ${RUNTIME}/di-apikey-${B}`,
    ]);
    // A second run has nothing left to do.
    io.writes = [];
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual({ done: true, moved: 0 });
    expect(io.writes).toEqual([]);
  });

  it('keeps only the key labels on the copy and puts it in the tenant key namespace', () => {
    const copy = apiKeyCopy(
      legacyKey(A, { labels: { ...keyLabels(), 'example.com/other': 'x' } }),
      'acme',
    );
    expect(copy.metadata).toEqual({
      name: `di-apikey-${A}`,
      namespace: apiKeysNamespace('acme'),
      labels: keyLabels(),
    });
  });

  it('leaves Secrets that are not this tenant’s API keys alone', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A, { labels: keyLabels('other') }));
    io.seed(legacyKey(B, { name: 'tenant-console-oauth' }));
    io.seed(legacyKey(B, { name: 'di-apikey-0123' }));
    io.seed(legacyKey(B, { labels: { 'platform.di-framework.dev/tenant': 'acme' } }));
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual({ done: true, moved: 0 });
    expect(io.writes).toEqual([]);
    expect(io.names(KEYS)).toEqual([]);
  });

  it('finishes a key that was copied but whose original was not deleted', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A));
    io.seed(legacyKey(B));
    io.failNext = 'remove';
    await expect(migrateApiKeys('acme', RUNTIME, io)).rejects.toThrow('delete failed');
    // Interrupted: A is in both namespaces, B only in the old one.
    expect(io.names(KEYS)).toEqual([`di-apikey-${A}`]);
    expect(io.names(RUNTIME)).toEqual([`di-apikey-${A}`, `di-apikey-${B}`]);
    io.writes = [];
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual({ done: true, moved: 2 });
    // The existing copy is checked, not written again.
    expect(io.writes).toEqual([
      `delete ${RUNTIME}/di-apikey-${A}`,
      `create ${KEYS}/di-apikey-${B}`,
      `delete ${RUNTIME}/di-apikey-${B}`,
    ]);
    expect(io.names(RUNTIME)).toEqual([]);
    expect(io.names(KEYS)).toEqual([`di-apikey-${A}`, `di-apikey-${B}`]);
  });

  it('keeps the original when the copy fails, and copies it on the next run', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A));
    io.failNext = 'create';
    await expect(migrateApiKeys('acme', RUNTIME, io)).rejects.toThrow('create failed');
    expect(io.names(RUNTIME)).toEqual([`di-apikey-${A}`]);
    expect(io.names(KEYS)).toEqual([]);
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual({ done: true, moved: 1 });
    expect(io.names(KEYS)).toEqual([`di-apikey-${A}`]);
  });

  it('never overwrites a different Secret of that name, and keeps the original', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A));
    io.seed(
      { ...apiKeyCopy(legacyKey(A), 'acme'), data: { hash: Buffer.from('x').toString('base64') } },
      KEYS,
    );
    await expect(migrateApiKeys('acme', RUNTIME, io)).rejects.toThrow(
      `API key Secret ${KEYS}/di-apikey-${A} does not match ${RUNTIME}/di-apikey-${A}`,
    );
    expect(io.writes).toEqual([]);
    expect(io.names(RUNTIME)).toEqual([`di-apikey-${A}`]);
    // Nor a copy of another user's key.
    const other = new FakeSecrets();
    other.seed(legacyKey(A));
    other.seed(apiKeyCopy(legacyKey(A, { labels: keyLabels('acme', 'mallory') }), 'acme'), KEYS);
    await expect(migrateApiKeys('acme', RUNTIME, other)).rejects.toThrow('does not match');
    expect(other.names(RUNTIME)).toEqual([`di-apikey-${A}`]);
  });

  it('error messages name Secrets, never their data', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A));
    io.seed({ ...apiKeyCopy(legacyKey(A), 'acme'), data: {} }, KEYS);
    const error = await migrateApiKeys('acme', RUNTIME, io).catch((e: Error) => e);
    expect(String(error)).not.toContain(legacyKey(A).data?.hash as string);
  });
});

/** The Tenant CRD's top-level schema properties. */
const tenantSchema = () =>
  (
    crds[0] as unknown as {
      spec: {
        versions: {
          schema: {
            openAPIV3Schema: {
              properties: {
                spec: { properties: { resources: { properties: Record<string, unknown> } } };
                status: { properties: Record<string, unknown> };
              };
            };
          };
        }[];
      };
    }
  ).spec.versions[0]?.schema.openAPIV3Schema.properties as {
    spec: { properties: { resources: { properties: Record<string, unknown> } } };
    status: { properties: Record<string, unknown> };
  };

describe('API-key namespace (#379)', () => {
  const tenant = (resources: NonNullable<Tenant['spec']['resources']> = {}): Tenant => ({
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: { name: 'acme', uid: 'acme-uid', generation: 1 },
    spec: { resources },
  });
  const cfg = {
    installation: 'test',
    namespace: 'wasmcloud',
    hostImage: 'wash:test',
    schedulerNatsUrl: 'nats://nats:4222',
  };
  const quota = (t: Tenant) =>
    tenantResources(t, cfg).find(
      (r) => r.kind === 'ResourceQuota' && r.metadata.namespace === KEYS,
    );

  it('is named after the tenant and reported in the Tenant status', () => {
    expect(names('acme').apiKeysNamespace).toBe(KEYS);
    const status = tenantSchema().status.properties;
    expect(status.apiKeysNamespace).toEqual({ type: 'string' });
    expect(status.apiKeysMigrated).toEqual({ type: 'boolean' });
  });

  it('caps the keys with count/secrets, default 1000, and admits no pod', () => {
    expect(quota(tenant())).toMatchObject({
      metadata: {
        name: 'di-apikeys-quota',
        labels: {
          'platform.di-framework.dev/installation': 'test',
          'platform.di-framework.dev/tenant': 'acme',
          'platform.di-framework.dev/owner-uid': 'acme-uid',
        },
      },
      spec: { hard: { 'count/secrets': '1000', pods: '0' } },
    });
    expect(quota(tenant({ apiKeys: 25 }))?.spec).toEqual({
      hard: { 'count/secrets': '25', pods: '0' },
    });
  });

  it('takes the cap from spec.resources.apiKeys, bounded by the CRD', () => {
    const spec = tenantSchema().spec.properties.resources.properties;
    expect(spec.apiKeys).toEqual({ type: 'integer', minimum: 1, maximum: 10000, default: 1000 });
  });
});
