/**
 * The one Node image the platform runs (the tenancy controller, the gateway and the tenant host
 * pod's `storage-mode` step), pinned by digest so a node caches exactly one copy. It is the digest
 * `platform/operator/Dockerfile` builds on; a test keeps the two equal.
 */
export const NODE_IMAGE =
  'node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b';
