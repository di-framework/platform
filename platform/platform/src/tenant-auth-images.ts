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
export const API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS: readonly string[] = [
  // ghcr.io/di-framework/tenant-auth
  'sha256:39eb90e585701b90dbf4e772546028c1f2c6f792e95d1c3d1695905f1646fe66',
  // ghcr.io/di-framework/tenant-auth
  'sha256:af36573e89fa4a266ea6b158a6ec26e2c13da1efb3ab632ee9c7a997754ba40f',
  // ghcr.io/di-framework/tenant-auth
  'sha256:b8204f0ce8bad48263a497ff4d49757cfc577163f3cfd9dfad39f31e2998e446',
  // ghcr.io/di-framework/tenant-auth
  'sha256:e9eb762ad39d30039adc391e70518b9946af6e849605bd8aa8a6fa0fe300ed55',
  // ghcr.io/di-framework/tenant-auth
  'sha256:455af084f57e60a54b16b6f5c4f39fcafb0593612fb036e1b099b88423147a30',
  // ghcr.io/di-framework/tenant-auth
  'sha256:7d0af6dbe61de00cc63dc9bf60db039b357eea60baa6e7a21c6115f43cfda96b',
];

/** Whether `image` is pinned by digest to one of `digests`. */
export function imagePinnedTo(image: string, digests: readonly string[]): boolean {
  const at = image.lastIndexOf('@');
  return at > 0 && digests.includes(image.slice(at + 1));
}

/** Whether `image` is pinned to one of {@link API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS}. */
export function tenantAuthReadsApiKeyNamespace(image: string): boolean {
  return imagePinnedTo(image, API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS);
}
