import { describe, expect, it } from 'bun:test';
import {
  type ApiKeyMigrationIo,
  type ApiKeySecret,
  apiKeyCopy,
  apiKeyMoveBlocker,
  apiKeysNamespace,
  migrateApiKeys,
  type TenantControllerDeployment,
  type TenantControllerPod,
} from '../src/tenancy/api-keys';
import { crds, names, type Tenant, tenantResources, VERSION } from '../src/tenancy/resources';
import {
  API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS,
  tenantAuthReadsApiKeyNamespace,
} from '../src/tenant-auth-images';

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
const C = '00112233445566ff';

/** Secrets by `<namespace>/<name>`, with a log of the writes. */
class FakeSecrets implements ApiKeyMigrationIo {
  objects = new Map<string, ApiKeySecret>();
  writes: string[] = [];
  replacedNames: string[] = [];
  waitingFor?: string;
  /** Fails the next call of this kind on this Secret name (or any name), once. */
  failNext?: { op: 'create' | 'remove'; name?: string };
  /** Fails every create of this name, as a quota or admission refusal would. */
  refuse = new Set<string>();
  private uids = 0;
  seed(secret: ApiKeySecret, namespace = secret.metadata.namespace as string) {
    this.objects.set(`${namespace}/${secret.metadata.name}`, {
      ...structuredClone(secret),
      metadata: { ...structuredClone(secret.metadata), namespace },
    });
  }
  private fail(op: 'create' | 'remove', name: string) {
    if (this.failNext?.op !== op || (this.failNext.name && this.failNext.name !== name)) return;
    this.failNext = undefined;
    throw new Error(`${op} failed`);
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
    this.fail('create', secret.metadata.name);
    if (this.refuse.has(secret.metadata.name))
      throw new Error('exceeded quota: di-apikeys-quota, requested: count/secrets=1');
    const key = `${secret.metadata.namespace}/${secret.metadata.name}`;
    this.writes.push(`create ${key}`);
    if (!this.objects.has(key))
      this.objects.set(key, {
        ...structuredClone(secret),
        metadata: { ...structuredClone(secret.metadata), uid: `copy-${++this.uids}` },
      });
  }
  async remove(namespace: string, secret: ApiKeySecret) {
    this.fail('remove', secret.metadata.name);
    const key = `${namespace}/${secret.metadata.name}`;
    this.writes.push(`delete ${key}`);
    if (this.objects.get(key)?.metadata.uid === secret.metadata.uid) this.objects.delete(key);
  }
  async blocker() {
    return this.waitingFor;
  }
  replaced(name: string) {
    this.replacedNames.push(name);
  }
  names(namespace: string) {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(`${namespace}/`))
      .map((key) => key.slice(namespace.length + 1))
      .sort();
  }
}
const done = (moved: number) => ({ done: true, moved, failures: [] });

describe('API-key migration (#379)', () => {
  it('is done at once when the runtime namespace holds no key (new layout or fresh tenant)', async () => {
    const io = new FakeSecrets();
    io.waitingFor = 'not allowlisted';
    io.seed(apiKeyCopy(legacyKey(A), 'acme'));
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual(done(0));
    expect(io.writes).toEqual([]);
  });

  it('moves nothing while the tenant controller is not known to read the new namespace', async () => {
    const io = new FakeSecrets();
    io.waitingFor = 'not allowlisted';
    io.seed(legacyKey(A));
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual({
      done: false,
      moved: 0,
      waiting: 'not allowlisted',
      failures: [],
    });
    expect(io.writes).toEqual([]);
    expect(io.names(RUNTIME)).toEqual([`di-apikey-${A}`]);
  });

  it('copies each key with the same name, labels and data, then deletes the original', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A));
    io.seed(legacyKey(B, { labels: keyLabels('acme', 'bob') }));
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual(done(2));
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
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual(done(0));
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
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual(done(0));
    expect(io.writes).toEqual([]);
    expect(io.names(KEYS)).toEqual([]);
  });

  it('finishes a key that was copied but whose original was not deleted', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A));
    io.seed(legacyKey(B));
    io.failNext = { op: 'remove', name: `di-apikey-${A}` };
    const first = await migrateApiKeys('acme', RUNTIME, io);
    // Interrupted on A, but B still moved.
    expect(first).toEqual({
      done: false,
      moved: 1,
      failures: [`di-apikey-${A}: remove failed`],
    });
    expect(io.names(KEYS)).toEqual([`di-apikey-${A}`, `di-apikey-${B}`]);
    expect(io.names(RUNTIME)).toEqual([`di-apikey-${A}`]);
    io.writes = [];
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual(done(1));
    // The existing copy is checked, not written again.
    expect(io.writes).toEqual([`delete ${RUNTIME}/di-apikey-${A}`]);
    expect(io.names(RUNTIME)).toEqual([]);
  });

  it('keeps going past keys it cannot move, reporting each, and keeps their originals', async () => {
    const io = new FakeSecrets();
    for (const id of [A, B, C]) io.seed(legacyKey(id));
    io.failNext = { op: 'create', name: `di-apikey-${A}` };
    io.refuse.add(`di-apikey-${B}`);
    const result = await migrateApiKeys('acme', RUNTIME, io);
    expect(result).toEqual({
      done: false,
      moved: 1,
      failures: [
        `di-apikey-${A}: create failed`,
        `di-apikey-${B}: exceeded quota: di-apikeys-quota, requested: count/secrets=1`,
      ],
    });
    expect(io.names(RUNTIME)).toEqual([`di-apikey-${A}`, `di-apikey-${B}`]);
    expect(io.names(KEYS)).toEqual([`di-apikey-${C}`]);
    // Once the cap is raised, the next run moves the rest.
    io.refuse.clear();
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual(done(2));
    expect(io.names(RUNTIME)).toEqual([]);
  });

  it('treats the original as authoritative: a differing copy is replaced', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A));
    io.seed(legacyKey(B));
    // Planted under A's name with other data, and under B's for another user.
    io.seed(
      {
        ...apiKeyCopy(legacyKey(A), 'acme'),
        metadata: { ...apiKeyCopy(legacyKey(A), 'acme').metadata, uid: 'planted-a' },
        data: { hash: Buffer.from('x').toString('base64') },
      },
      KEYS,
    );
    io.seed(
      {
        ...apiKeyCopy(legacyKey(B, { labels: keyLabels('acme', 'mallory') }), 'acme'),
        metadata: {
          ...apiKeyCopy(legacyKey(B, { labels: keyLabels('acme', 'mallory') }), 'acme').metadata,
          uid: 'planted-b',
        },
      },
      KEYS,
    );
    expect(await migrateApiKeys('acme', RUNTIME, io)).toEqual(done(2));
    expect(io.replacedNames).toEqual([`di-apikey-${A}`, `di-apikey-${B}`]);
    expect(io.writes.slice(0, 3)).toEqual([
      `delete ${KEYS}/di-apikey-${A}`,
      `create ${KEYS}/di-apikey-${A}`,
      `delete ${RUNTIME}/di-apikey-${A}`,
    ]);
    for (const id of [A, B]) {
      const copy = (await io.get(KEYS, `di-apikey-${id}`)) as ApiKeySecret;
      expect(copy.data).toEqual(legacyKey(id).data);
      expect(copy.metadata.labels).toEqual(keyLabels());
    }
    expect(io.names(RUNTIME)).toEqual([]);
  });

  it('keeps the original when a foreign copy comes back, saying it was not the platform’s', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A));
    const planted = {
      ...apiKeyCopy(legacyKey(A), 'acme'),
      data: { hash: Buffer.from('x').toString('base64') },
    };
    io.seed({ ...planted, metadata: { ...planted.metadata, uid: 'planted' } }, KEYS);
    // Re-planted right after the platform deleted it, so its own create meets a 409.
    const remove = io.remove.bind(io);
    io.remove = async (namespace, secret) => {
      await remove(namespace, secret);
      if (namespace === KEYS)
        io.seed({ ...planted, metadata: { ...planted.metadata, uid: 'again' } }, KEYS);
    };
    const result = await migrateApiKeys('acme', RUNTIME, io);
    expect(result.done).toBe(false);
    expect(result.failures).toEqual([
      `di-apikey-${A}: a Secret not written by the platform holds ${KEYS}/di-apikey-${A}; the original is kept`,
    ]);
    expect(io.names(RUNTIME)).toEqual([`di-apikey-${A}`]);
    // No Secret data in the message.
    expect(result.failures.join()).not.toContain(planted.data.hash);
    expect(result.failures.join()).not.toContain(legacyKey(A).data?.hash as string);
  });

  it('reports a failure that is not an Error', async () => {
    const io = new FakeSecrets();
    io.seed(legacyKey(A));
    io.create = async () => {
      throw 'refused';
    };
    expect((await migrateApiKeys('acme', RUNTIME, io)).failures).toEqual([
      `di-apikey-${A}: refused`,
    ]);
  });
});

describe('API-key move gate (#379)', () => {
  const IMAGE = `ghcr.io/di-framework/tenant-auth@sha256:${'a'.repeat(64)}`;
  const OLD = `ghcr.io/di-framework/tenant-auth@sha256:${'b'.repeat(64)}`;
  const deployment = (
    overrides: {
      image?: string;
      replicas?: number;
      generation?: number;
      status?: TenantControllerDeployment['status'];
    } = {},
  ): TenantControllerDeployment => {
    const replicas = overrides.replicas ?? 1;
    return {
      metadata: { generation: overrides.generation ?? 2 },
      spec: {
        replicas,
        template: { spec: { containers: [{ image: overrides.image ?? IMAGE }] } },
      },
      status: overrides.status ?? {
        observedGeneration: 2,
        replicas,
        updatedReplicas: replicas,
      },
    };
  };
  const pod = (name: string, image = IMAGE, terminating = false): TenantControllerPod => ({
    metadata: { name, ...(terminating ? { deletionTimestamp: '2026-10-15T00:00:00Z' } : {}) },
    spec: { containers: [{ image }] },
  });
  const ok = [pod('tenant-controller-new')];

  it('opens only for an allowlisted image, fully rolled out, with no other pod left', () => {
    expect(apiKeyMoveBlocker(IMAGE, true, deployment(), ok)).toBeUndefined();
  });

  it.each([
    ['an image not known to read the new namespace', false, deployment(), ok, 'is not a known'],
    ['no Deployment', true, undefined, [], 'does not exist yet'],
    ['a template naming another image', true, deployment({ image: OLD }), ok, 'rolling out'],
    [
      'an observedGeneration behind',
      true,
      deployment({ status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1 } }),
      ok,
      'rolling out',
    ],
    [
      'fewer updated replicas than the spec',
      true,
      deployment({ status: { observedGeneration: 2, replicas: 1, updatedReplicas: 0 } }),
      ok,
      'rolling out',
    ],
    [
      'old replicas still counted',
      true,
      deployment({ status: { observedGeneration: 2, replicas: 2, updatedReplicas: 1 } }),
      ok,
      'rolling out',
    ],
    ['no status yet', true, deployment({ status: {} }), ok, 'rolling out'],
    [
      'a terminating old pod',
      true,
      deployment(),
      [...ok, pod('tenant-controller-old', OLD, true)],
      'still run another image: tenant-controller-old',
    ],
    [
      'a pod without containers',
      true,
      deployment(),
      [{ metadata: { name: 'tenant-controller-x' } }],
      'still run another image',
    ],
  ] as const)('stays closed with %s', (_, supported, value, pods, reason) => {
    expect(apiKeyMoveBlocker(IMAGE, supported, value, [...pods])).toContain(reason);
  });

  it('opens with zero replicas (a suspended tenant) once no pod is left', () => {
    const suspended = deployment({ replicas: 0, status: { observedGeneration: 2 } });
    expect(apiKeyMoveBlocker(IMAGE, true, suspended, [])).toBeUndefined();
    expect(apiKeyMoveBlocker(IMAGE, true, suspended, [pod('old', OLD, true)])).toContain(
      'another image',
    );
    // A Deployment without a replica count means one.
    expect(
      apiKeyMoveBlocker(IMAGE, true, { metadata: { generation: 1 }, status: {} }, []),
    ).toContain('rolling out');
  });
});

describe('tenant-auth images that read the API-key namespace (#379)', () => {
  it('starts empty, so nothing moves until the first tenant-auth pin lists a build', () => {
    // The pin bot appends; entries are never removed.
    expect(new Set(API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS).size).toBe(
      API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS.length,
    );
    for (const digest of API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS) {
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(tenantAuthReadsApiKeyNamespace(`ghcr.io/di-framework/tenant-auth@${digest}`)).toBe(
        true,
      );
    }
  });

  it('accepts only digest-pinned references to a listed build', () => {
    for (const image of [
      'ghcr.io/di-framework/tenant-auth:latest',
      'ghcr.io/di-framework/tenant-auth',
      `ghcr.io/di-framework/tenant-auth@sha256:${'0'.repeat(64)}`,
      '@sha256:x',
    ])
      expect(tenantAuthReadsApiKeyNamespace(image)).toBe(false);
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
