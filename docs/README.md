# di-framework Platform Documentation

Comprehensive documentation for the operated wasmCloud platform (`@di-framework/platform`), application guest bindings (`@di-framework/bindings`), embedded Wasm PostgreSQL (`@di-framework/pglite-component`, `@di-framework/pglite-encfs`), per-tenant authentication and OCI registry (`@di-framework/tenant-auth`, `@di-framework/tenant-cli`), the `PlatformInstance` Kubernetes operator (`@di-framework/platform-operator`), and `di-framework-kube`.

## Topics

| Guide | Summary |
| --- | --- |
| [Platform (`platform.md`)](platform.md) | Build, run, and deploy WASI 0.3 HTTP, messaging, cron, queue, and actor workloads with `@di-framework/cli-plugin-platform` and `@di-framework/bindings`, multi-tenant Pulumi cluster installation, HTTP gateway routing, network isolation, and backups. |
| [Backing Services (`backing-services.md`)](backing-services.md) | Provision and bind tenant-scoped Redis, NATS, S3 blobstore, dedicated PostgreSQL (`BackingService` / `ServiceBinding`), and egress policies. |
| [Tenant Access & Registry (`tenant-auth.md`)](tenant-auth.md) | Per-tenant authentication (`tenantAuth`), OAuth2 / API keys, gateway routes, OCI registry (`tenantAuth.registry`), `di-tenant` and `di-framework platform` `/v1` controller workflow, CA rotation, and tenant upgrades. |
| [Embedded PostgreSQL & Encryption at Rest (`pglite.md`)](pglite.md) | Single-instance Wasm PostgreSQL (`@di-framework/pglite-component`, bundled extensions including `pgvector`) and transparent encryption at rest (`@di-framework/pglite-encfs`, Codec 3 AES-256-XTS and Codec 4 AEAD). |
| [Kubernetes with `di-framework-kube` (`kube.md`)](kube.md) | Local KubeSolo cluster lifecycle (`di-framework kube`), platform configuration, live verification workspace, and controller targets. |
| [Platform Operator (`platform-operator.md`)](platform-operator.md) | Install and manage isolated `PlatformInstance` clusters (`vcluster` and `k0s` modes) with the `platform-operator` Helm chart and Headlamp plugin. |
| [`PlatformInstance` Reference (`platform-instance-reference.md`)](platform-instance-reference.md) | Full `platform.di-framework.dev/v1alpha1` `PlatformInstance` `spec`, `status`, conditions, and annotations reference. |
| [Operate Platform Instances (`platform-operator-operations.md`)](platform-operator-operations.md) | Upgrades, failure diagnosis, host-namespace isolation, `Delete` vs `Retain`, and owner-Service / host-namespace deletion resync runbooks. |

## Package READMEs

For package-level internals and development guides:

- [`platform/platform/README.md`](../platform/platform/README.md) — `@di-framework/platform` Pulumi program, CRDs, controller, tenancy, and backing services
- [`platform/bindings/README.md`](../platform/bindings/README.md) — `@di-framework/bindings` guest bindings and unit-test doubles
- [`platform/pglite-component/README.md`](../platform/pglite-component/README.md) — `@di-framework/pglite-component` Wasm PostgreSQL provider
- [`platform/pglite-encfs/README.md`](../platform/pglite-encfs/README.md) — `@di-framework/pglite-encfs` encrypted WASI filesystem layer
- [`platform/sqlite-component/README.md`](../platform/sqlite-component/README.md) — `@di-framework/sqlite-component` SQLite provider component
- [`platform/tenant-auth/README.md`](../platform/tenant-auth/README.md) — `@di-framework/tenant-auth` identity server and controller auth
- [`platform/tenant-cli/README.md`](../platform/tenant-cli/README.md) — `@di-framework/tenant-cli` (`di-tenant`) CLI
- [`platform/oci-registry/README.md`](../platform/oci-registry/README.md) — `@di-framework/oci-registry` per-tenant OCI registry
- [`platform/operator/README.md`](../platform/operator/README.md) — `@di-framework/platform-operator` Kubernetes operator and Headlamp plugin
- [`platform/backup-agent/README.md`](../platform/backup-agent/README.md) — `@di-framework/backup-agent` backup and restore job image
- [`platform/backup-destination/README.md`](../platform/backup-destination/README.md) — `@di-framework/backup-destination` tenant backup operator and console
- [`adapters/cloudflare/README.md`](../adapters/cloudflare/README.md) — `@di-framework/cloudflare` Cloudflare Workers adapter
- [`adapters/cloudfoundry/README.md`](../adapters/cloudfoundry/README.md) — `@di-framework/cloudfoundry` Cloud Foundry adapter
