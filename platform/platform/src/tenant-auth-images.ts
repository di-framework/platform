/**
 * Published tenant-auth images known to read API keys from `di-apikeys-<tenant>` (#379), by
 * multi-arch index digest. The platform controller moves a tenant's keys out of
 * `di-runtime-<tenant>` only while `tenantAuth.image` is pinned to one of these, so a tenant-auth
 * that reads only the old layout never loses its keys. Fail closed: a tag-only reference or an
 * unknown digest leaves the keys where they are (and the tenant controller's read of runtime
 * Secrets in place), and `pulumi up` warns.
 *
 * The tenant-auth pin PR (scripts/pin-artifact.ts) appends each published build; entries are never
 * removed, since existing installs may still run them. The list lives outside
 * `platform/platform/src/tenancy/`, an input of the tenant-auth image, so merging a pin PR does not
 * publish tenant-auth again.
 */
export const API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS: readonly string[] = [];

/** Whether `image` is pinned to one of {@link API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS}. */
export function tenantAuthReadsApiKeyNamespace(image: string): boolean {
  const at = image.lastIndexOf('@');
  return at > 0 && API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS.includes(image.slice(at + 1));
}
