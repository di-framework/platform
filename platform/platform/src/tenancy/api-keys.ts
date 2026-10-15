/**
 * Tenant API keys live in their own namespace, `di-apikeys-<tenant>` (#379). The tenant controller
 * (tenant-auth) creates one Secret per key there, named `di-apikey-<16 hex>`, and holds Secret
 * rights in that namespace only; nothing else is stored there and no pod runs there. Before #379
 * the keys were Secrets in `di-runtime-<tenant>`, so the controller could read every Secret of the
 * runtime namespace. {@link migrateApiKeys} moves them.
 */

const GROUP = 'platform.di-framework.dev';
/** Prefix of the per-tenant API-key namespace. */
export const API_KEYS_NAMESPACE_PREFIX = 'di-apikeys-';
/** The namespace that holds `tenant`'s API keys. */
export const apiKeysNamespace = (tenant: string) => `${API_KEYS_NAMESPACE_PREFIX}${tenant}`;
/** The name tenant-auth gives an API-key Secret (`tenant-auth/src/keys.ts`). */
export const API_KEY_SECRET = /^di-apikey-[0-9a-f]{16}$/;
/** The labels tenant-auth puts on every API-key Secret. */
export const API_KEY_LABEL = `${GROUP}/api-key`;
const TENANT_LABEL = `${GROUP}/tenant`;
const USER_LABEL = `${GROUP}/user`;
/** Default for `spec.resources.apiKeys`: the `count/secrets` hard limit of the key namespace. */
export const DEFAULT_API_KEYS = 1000;
/** Bounds of `spec.resources.apiKeys` in the Tenant CRD. */
export const API_KEYS_LIMITS = { minimum: 1, maximum: 10000 } as const;

/** An API-key Secret as listed or read from the API server. */
export interface ApiKeySecret {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
  };
  type?: string;
  data?: Record<string, string>;
}

/** The cluster access {@link migrateApiKeys} needs; the platform controller provides it. */
export interface ApiKeyMigrationIo {
  /** Secrets in `namespace` carrying every one of `labels`. */
  list(namespace: string, labels: Record<string, string>): Promise<ApiKeySecret[]>;
  /** One Secret, or undefined when it does not exist. */
  get(namespace: string, name: string): Promise<ApiKeySecret | undefined>;
  /** Create `secret`; resolves without error when one of that name already exists. */
  create(secret: ApiKeySecret): Promise<void>;
  /** Delete exactly this Secret (by uid); a Secret already gone is not an error. */
  remove(secret: ApiKeySecret): Promise<void>;
  /**
   * Whether every tenant controller pod runs the image this platform deploys, which reads the
   * new namespace. Until then keys are not moved: an older image reads only the old layout.
   */
  rolledOut(): Promise<boolean>;
}

export interface ApiKeyMigration {
  /** True once no API-key Secret is left in the runtime namespace. */
  done: boolean;
  /** How many keys this call moved. */
  moved: number;
}

/** The copy of a legacy key: the same name, key labels, type and data, in the key namespace. */
export function apiKeyCopy(secret: ApiKeySecret, tenant: string): ApiKeySecret {
  const labels = secret.metadata.labels ?? {};
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secret.metadata.name,
      namespace: apiKeysNamespace(tenant),
      labels: Object.fromEntries(
        [API_KEY_LABEL, TENANT_LABEL, USER_LABEL]
          .filter((key) => labels[key] !== undefined)
          .map((key) => [key, labels[key] as string]),
      ),
    },
    type: secret.type ?? 'Opaque',
    data: { ...(secret.data ?? {}) },
  };
}

/** Whether `actual` holds the same key as `wanted`: key labels, type and every data entry. */
export function sameApiKey(actual: ApiKeySecret, wanted: ApiKeySecret): boolean {
  const labels = actual.metadata.labels ?? {};
  const want = wanted.metadata.labels ?? {};
  const a = actual.data ?? {};
  const b = wanted.data ?? {};
  return (
    Object.entries(want).every(([key, value]) => labels[key] === value) &&
    (actual.type ?? 'Opaque') === (wanted.type ?? 'Opaque') &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(b).every(([key, value]) => a[key] === value)
  );
}

/**
 * Moves `tenant`'s API keys from `di-runtime-<tenant>` to `di-apikeys-<tenant>` (#379). Each
 * `di-apikey-<16 hex>` Secret labelled as a key of this tenant is copied once with the same name
 * and data, the copy is read back and compared, and only then is the original deleted. Every step
 * is idempotent, so an interrupted pass (copied but not deleted) finishes on the next one; a copy
 * that already exists is never overwritten, and one that differs keeps its original and fails the
 * pass instead. With no key left in the runtime namespace the migration is `done`.
 *
 * Keys are moved only once the tenant controller runs an image that reads the new namespace
 * ({@link ApiKeyMigrationIo.rolledOut}). That image reads the new namespace first and the runtime
 * namespace second until the platform reports the migration done, so a valid key is found at
 * every step: before the copy, in the runtime namespace; after it, in the key namespace.
 */
export async function migrateApiKeys(
  tenant: string,
  runtimeNamespace: string,
  io: ApiKeyMigrationIo,
): Promise<ApiKeyMigration> {
  const legacy = (
    await io.list(runtimeNamespace, { [API_KEY_LABEL]: 'true', [TENANT_LABEL]: tenant })
  ).filter((secret) => API_KEY_SECRET.test(secret.metadata.name));
  if (legacy.length === 0) return { done: true, moved: 0 };
  if (!(await io.rolledOut())) return { done: false, moved: 0 };
  const namespace = apiKeysNamespace(tenant);
  let moved = 0;
  for (const original of legacy) {
    const copy = apiKeyCopy(original, tenant);
    let existing = await io.get(namespace, copy.metadata.name);
    if (!existing) {
      await io.create(copy);
      existing = await io.get(namespace, copy.metadata.name);
    }
    if (!existing || !sameApiKey(existing, copy))
      throw new Error(
        `API key Secret ${namespace}/${copy.metadata.name} does not match ` +
          `${runtimeNamespace}/${copy.metadata.name}; the original is kept until the copy is removed`,
      );
    await io.remove(original);
    moved++;
  }
  return { done: true, moved };
}
