/**
 * Tenant-scoped API keys, owned by the tenant controller. Only a SHA-256 hash of the secret is
 * stored, as a Secret in `di-apikeys-<tenant>`, a namespace that holds nothing else and that
 * tenant users cannot read or write (#379). A presented key is accepted as a bearer token by the
 * controller and acts as the user who created it.
 *
 * Before #379 the keys were Secrets in `di-runtime-<tenant>`. The platform controller moves them
 * (copy, check, delete the original) and then sets `status.apiKeysMigrated` on the Tenant. Until
 * then a {@link KeyStore} with `legacy` set also reads that namespace, after the new one, so a
 * valid key is found whichever side of its move it is on.
 */
import type { KubeClient, SecretResource } from './kube.ts';
import { KubeError, PLATFORM_GROUP } from './kube.ts';
import { sha256 } from './oidc.ts';

export const KEY_PREFIX = 'dik';
export const KEY_LABEL = `${PLATFORM_GROUP}/api-key`;
export const TENANT_LABEL = `${PLATFORM_GROUP}/tenant`;
export const USER_LABEL = `${PLATFORM_GROUP}/user`;
const KEY_PATTERN = /^dik_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export interface ApiKey {
  id: string;
  name: string;
  tenant: string;
  user: string;
  createdAt: string;
  expiresAt: string;
}
export interface IssuedApiKey extends ApiKey {
  /** The full secret, shown exactly once. */
  secret: string;
}
/** Where one tenant's keys live. */
export interface KeyStore {
  kube: KubeClient;
  /** Where keys are created, and read first: `di-apikeys-<tenant>`. */
  namespace: string;
  tenant: string;
  /** The layout before #379, read until the platform reports the move done. */
  legacy?: LegacyKeys;
}
/** The pre-#379 layout: keys in the tenant's runtime namespace. */
export interface LegacyKeys {
  namespace: string;
  /** Whether the platform has moved every key out of `namespace`; once true, it stays true. */
  migrated(): Promise<boolean>;
}
/** The namespace that holds a tenant's API keys (#379). */
export const apiKeysNamespace = (tenant: string) => `di-apikeys-${tenant}`;
/** How long a "not moved yet" answer is reused before the Tenant is read again. */
const MIGRATION_RECHECK_MS = 30_000;

/**
 * Reads the migration state from the tenant's own Tenant status (`apiKeysMigrated`), which the
 * controller may already `get`. A true answer is kept for good; a false one, or a failed read, is
 * rechecked after {@link MIGRATION_RECHECK_MS}, and meanwhile the old layout is still read.
 */
export function legacyKeys(
  kube: KubeClient,
  tenant: string,
  now: () => number = Date.now,
): LegacyKeys {
  let migrated = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  return {
    namespace: `di-runtime-${tenant}`,
    async migrated() {
      if (migrated || now() - checkedAt < MIGRATION_RECHECK_MS) return migrated;
      checkedAt = now();
      try {
        migrated = (await kube.getTenant(tenant))?.status?.apiKeysMigrated === true;
      } catch {
        // Unknown: keep reading both layouts.
      }
      return migrated;
    },
  };
}

/** Thrown by {@link revokeApiKey} while the key is still in the old layout. */
export class ApiKeyMigrationPending extends Error {}

/** The old namespace, while the platform has not reported the move done. */
async function legacyNamespace(store: KeyStore): Promise<string | undefined> {
  if (!store.legacy || (await store.legacy.migrated())) return undefined;
  return store.legacy.namespace;
}
/**
 * A read in the old namespace. The platform drops the controller's Secret read there in the pass
 * that finds no key left, possibly before this controller sees `apiKeysMigrated`: a 403 there
 * means nothing is left to find.
 */
async function legacyRead<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof KubeError && error.status === 403) return empty;
    throw error;
  }
}
/**
 * A key's Secret, as `{ secret, original }`: `secret` from the new namespace, `original` from the
 * old one while keys are being moved. When neither read finds it, the new namespace is read once
 * more: the move may have copied the key and deleted its original between the two reads, and the
 * original is deleted only once its copy exists.
 */
async function findSecret(
  store: KeyStore,
  id: string,
): Promise<{ secret?: SecretResource; original?: SecretResource }> {
  const read = () => store.kube.getSecret(store.namespace, secretName(id));
  const secret = await read();
  const legacy = await legacyNamespace(store);
  if (!legacy) return { secret };
  const original = await legacyRead(() => store.kube.getSecret(legacy, secretName(id)), undefined);
  return { secret: secret ?? (original ? undefined : await read()), original };
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
export async function hashSecret(secret: string): Promise<string> {
  return hex(await sha256(secret));
}
export function generateKey(): { id: string; secret: string; value: string } {
  const id = hex(crypto.getRandomValues(new Uint8Array(8)));
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  return { id, secret, value: `${KEY_PREFIX}_${id}_${secret}` };
}
export function parseKey(value: string): { id: string; secret: string } | undefined {
  const match = KEY_PATTERN.exec(value);
  return match?.[1] && match[2] ? { id: match[1], secret: match[2] } : undefined;
}
export const looksLikeKey = (value: string) => value.startsWith(`${KEY_PREFIX}_`);
export const secretName = (id: string) => `di-apikey-${id}`;

function fromSecret(secret: SecretResource): ApiKey | undefined {
  const data = secret.data ?? {};
  const read = (field: string) =>
    data[field] ? Buffer.from(data[field], 'base64').toString('utf8') : undefined;
  const id = secret.metadata.name.replace(/^di-apikey-/, '');
  const tenant = secret.metadata.labels?.[TENANT_LABEL];
  const user = secret.metadata.labels?.[USER_LABEL];
  const expiresAt = read('expiresAt');
  if (!tenant || !user || !expiresAt) return undefined;
  return {
    id,
    name: read('name') ?? id,
    tenant,
    user,
    createdAt: read('createdAt') ?? secret.metadata.creationTimestamp ?? '',
    expiresAt,
  };
}

export async function createApiKey(
  store: KeyStore,
  user: string,
  name: string,
  ttlSeconds: number,
): Promise<IssuedApiKey> {
  const key = generateKey();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
  await store.kube.createSecret(store.namespace, {
    metadata: {
      name: secretName(key.id),
      labels: { [KEY_LABEL]: 'true', [TENANT_LABEL]: store.tenant, [USER_LABEL]: user },
    },
    type: 'Opaque',
    stringData: {
      hash: await hashSecret(key.secret),
      name,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
  });
  return {
    id: key.id,
    name,
    tenant: store.tenant,
    user,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    secret: key.value,
  };
}

export async function listApiKeys(store: KeyStore, user: string): Promise<ApiKey[]> {
  const selector = `${KEY_LABEL}=true,${TENANT_LABEL}=${store.tenant},${USER_LABEL}=${user}`;
  const { items } = await store.kube.listSecrets(store.namespace, selector);
  const legacy = await legacyNamespace(store);
  const old = legacy
    ? (await legacyRead(() => store.kube.listSecrets(legacy, selector), { items: [] })).items
    : [];
  // A key that was copied but whose original is not deleted yet is listed once.
  const keys = new Map<string, ApiKey>();
  for (const secret of [...old, ...items]) {
    const key = fromSecret(secret);
    if (key) keys.set(key.id, key);
  }
  return [...keys.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Delete a key the caller owns. Returns false when it does not exist or is not theirs. While the
 * key is still in the old namespace it throws {@link ApiKeyMigrationPending}: the controller may
 * not delete there, and deleting only the copy would let the move copy the original again.
 */
export async function revokeApiKey(store: KeyStore, user: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{16}$/.test(id)) return false;
  const { secret, original } = await findSecret(store, id);
  const found = secret ?? original;
  const key = found ? fromSecret(found) : undefined;
  if (!key || key.tenant !== store.tenant || key.user !== user) return false;
  if (original)
    throw new ApiKeyMigrationPending('the platform is moving this API key; try again in a minute');
  await store.kube.deleteSecret(store.namespace, secretName(id));
  return true;
}

export class ApiKeyError extends Error {}

/** Look up and check a presented key. Throws ApiKeyError with a safe message. */
export async function resolveApiKey(store: KeyStore, presented: string): Promise<ApiKey> {
  const parsed = parseKey(presented.trim());
  if (!parsed) throw new ApiKeyError('API key is malformed');
  const found = await findSecret(store, parsed.id);
  const secret = found.secret ?? found.original;
  const key = secret ? fromSecret(secret) : undefined;
  const storedHash = secret?.data?.hash
    ? Buffer.from(secret.data.hash, 'base64').toString('utf8')
    : undefined;
  if (!key || !storedHash || key.tenant !== store.tenant)
    throw new ApiKeyError('API key is unknown or revoked');
  const presentedHash = await hashSecret(parsed.secret);
  const a = Buffer.from(presentedHash);
  const b = Buffer.from(storedHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    throw new ApiKeyError('API key is unknown or revoked');
  if (new Date(key.expiresAt).getTime() <= Date.now()) throw new ApiKeyError('API key has expired');
  return key;
}
