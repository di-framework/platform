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
  'sha256:5606ea2cf68d017ce8730857003b0c3eb2109b8e49fecbde399089aaf300f604',
  // ghcr.io/di-framework/tenant-auth
  'sha256:7ea1bcbe5ded849f8df80f53423ff2c5fff6dbce3870267e748374b84ae85370',
  // ghcr.io/di-framework/tenant-auth
  'sha256:ede9577238b304dc87a19cf69bd20bfc00889116b17da12c2e98e2c97657a715',
  // ghcr.io/di-framework/tenant-auth
  'sha256:a7c29cd6e9878232315b8fca06ab751758248b64838c180c9901a0a7a4e45ec0',
  // ghcr.io/di-framework/tenant-auth
  'sha256:f580e771726c5a0b4fa4f5e5e45c9abcb168729297887fd34b51fec6f3052381',
  // ghcr.io/di-framework/tenant-auth
  'sha256:c4ac4c4da366860357caa7a287b37bbf26b8c6411785fc28ebb4552e8843714d',
  // ghcr.io/di-framework/tenant-auth
  'sha256:146bebc9633b28a6a3afbc8939a04c32bc7a539707d9a5b6330f18aef35d8cf8',
  // ghcr.io/di-framework/tenant-auth
  'sha256:893e53416ea7c534b616b18208d4bacc46de2f162adeed00b6ffd12a24ab303e',
  // ghcr.io/di-framework/tenant-auth
  'sha256:8507e78967ca7c960669d502bd1947f256e77e9d74de9ef2eff3defa6c940822',
  // ghcr.io/di-framework/tenant-auth
  'sha256:1f0b819a6e60f3d0d474756b3be4f828996806316ca3f5f631d77421ffc63bd2',
  // ghcr.io/di-framework/tenant-auth
  'sha256:872780d5c65c30224deecf1256342a419a9dc5e08f8623c70907f7b2851ecd43',
  // ghcr.io/di-framework/tenant-auth
  'sha256:f7d3a56b7e7ec0e4641505b68634e8e0582e222620f84c3a802094977ada0897',
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
