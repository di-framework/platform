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
  /** Delete exactly this Secret in `namespace` (by uid); one already gone is not an error. */
  remove(namespace: string, secret: ApiKeySecret): Promise<void>;
  /**
   * Why keys cannot be moved yet, or undefined once the tenant controller is known to read the new
   * namespace (see {@link apiKeyMoveBlocker}). An older tenant-auth image reads only the old layout.
   */
  blocker(): Promise<string | undefined>;
  /** A copy that was not the platform's was replaced; for the controller log. */
  replaced?(name: string): void;
}

export interface ApiKeyMigration {
  /** True once no API-key Secret is left in the runtime namespace. */
  done: boolean;
  /** How many keys this call moved. */
  moved: number;
  /** Why nothing was moved: the tenant controller does not read the new namespace yet. */
  waiting?: string;
  /** One message per key that could not be moved this time (its original is kept). */
  failures: string[];
}

/** The `tenant-controller` Deployment fields {@link apiKeyMoveBlocker} reads. */
export interface TenantControllerDeployment {
  metadata: { generation?: number };
  spec?: { replicas?: number; template?: { spec?: { containers?: { image?: string }[] } } };
  status?: { observedGeneration?: number; replicas?: number; updatedReplicas?: number };
}
/** A tenant controller pod, terminating ones included. */
export interface TenantControllerPod {
  metadata: { name: string; deletionTimestamp?: string };
  spec?: { containers?: { image?: string }[] };
}

/**
 * Why the tenant controller cannot be relied on to read `di-apikeys-<tenant>` yet, or undefined
 * when it can (#379). All of these must hold:
 * - `supported`: the configured `tenantAuth.image` is a published build known to read the new
 *   namespace (`API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS`, which the tenant-auth pin appends to);
 * - the Deployment exists, its template runs that image, the Deployment controller has seen the
 *   latest spec, and every replica it counts is an updated one;
 * - no pod runs anything else, terminating pods included: an old pod in its grace period may still
 *   answer a request routed to it before it left the endpoints.
 */
export function apiKeyMoveBlocker(
  image: string,
  supported: boolean,
  deployment: TenantControllerDeployment | undefined,
  pods: TenantControllerPod[],
): string | undefined {
  if (!supported)
    return `tenantAuth.image ${image} is not a known tenant-auth build that reads the API-key namespace`;
  if (!deployment) return 'the tenant-controller Deployment does not exist yet';
  const replicas = deployment.spec?.replicas ?? 1;
  const status = deployment.status ?? {};
  const runs = (containers: { image?: string }[] | undefined) =>
    (containers ?? []).some((c) => c.image === image);
  if (
    !runs(deployment.spec?.template?.spec?.containers) ||
    status.observedGeneration !== deployment.metadata.generation ||
    (status.updatedReplicas ?? 0) !== replicas ||
    (status.replicas ?? 0) !== replicas
  )
    return `the tenant-controller Deployment has not finished rolling out ${image}`;
  const old = pods.filter((pod) => !runs(pod.spec?.containers)).map((pod) => pod.metadata.name);
  if (old.length) return `tenant-controller pods still run another image: ${old.sort().join(', ')}`;
  return undefined;
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
 * `di-apikey-<16 hex>` Secret labelled as a key of this tenant is copied with the same name and
 * data, the copy is read back and compared, and only then is the original deleted. Every step is
 * idempotent, so an interrupted pass (copied but not deleted) finishes on the next one.
 *
 * The original is authoritative. A Secret of that name already in the key namespace that differs
 * from it was not written by the platform (ids are random and nothing updates a key), so it is
 * deleted by uid and the copy written again. A key that still cannot be moved keeps its original
 * and is reported in `failures`; the others are moved anyway. With no key left in the runtime
 * namespace the migration is `done`.
 *
 * Keys are moved only while {@link ApiKeyMigrationIo.blocker} reports nothing. The tenant-auth
 * images it accepts read the new namespace first and the runtime namespace second until the
 * platform reports the migration done, so a valid key is found at every step: before the copy, in
 * the runtime namespace; after it, in the key namespace.
 */
export async function migrateApiKeys(
  tenant: string,
  runtimeNamespace: string,
  io: ApiKeyMigrationIo,
): Promise<ApiKeyMigration> {
  const legacy = (
    await io.list(runtimeNamespace, { [API_KEY_LABEL]: 'true', [TENANT_LABEL]: tenant })
  ).filter((secret) => API_KEY_SECRET.test(secret.metadata.name));
  if (legacy.length === 0) return { done: true, moved: 0, failures: [] };
  const waiting = await io.blocker();
  if (waiting) return { done: false, moved: 0, waiting, failures: [] };
  const namespace = apiKeysNamespace(tenant);
  let moved = 0;
  const failures: string[] = [];
  for (const original of legacy) {
    const name = original.metadata.name;
    try {
      const copy = apiKeyCopy(original, tenant);
      let existing = await io.get(namespace, name);
      if (existing && !sameApiKey(existing, copy)) {
        io.replaced?.(name);
        await io.remove(namespace, existing);
        existing = undefined;
      }
      if (!existing) {
        await io.create(copy);
        existing = await io.get(namespace, name);
      }
      if (!existing || !sameApiKey(existing, copy))
        throw new Error(
          `a Secret not written by the platform holds ${namespace}/${name}; the original is kept`,
        );
      await io.remove(runtimeNamespace, original);
      moved++;
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { done: failures.length === 0, moved, failures };
}
