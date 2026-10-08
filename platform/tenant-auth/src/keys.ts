/**
 * Tenant-scoped API keys, owned by the tenant controller. Only a SHA-256 hash of the secret is
 * stored, as a Secret in the tenant's runtime namespace, which tenant users cannot read or write
 * (their roles there cover pods and logs only). A presented key is accepted as a bearer token by
 * the controller and acts as the user who created it.
 */
import type { KubeClient, SecretResource } from './kube.ts';
import { PLATFORM_GROUP } from './kube.ts';
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
  namespace: string;
  tenant: string;
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
  return items
    .map(fromSecret)
    .filter((key): key is ApiKey => key !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Delete a key the caller owns. Returns false when it does not exist or is not theirs. */
export async function revokeApiKey(store: KeyStore, user: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{16}$/.test(id)) return false;
  const secret = await store.kube.getSecret(store.namespace, secretName(id));
  const key = secret ? fromSecret(secret) : undefined;
  if (!key || key.tenant !== store.tenant || key.user !== user) return false;
  await store.kube.deleteSecret(store.namespace, secretName(id));
  return true;
}

export class ApiKeyError extends Error {}

/** Look up and check a presented key. Throws ApiKeyError with a safe message. */
export async function resolveApiKey(store: KeyStore, presented: string): Promise<ApiKey> {
  const parsed = parseKey(presented.trim());
  if (!parsed) throw new ApiKeyError('API key is malformed');
  const secret = await store.kube.getSecret(store.namespace, secretName(parsed.id));
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
