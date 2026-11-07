# Embedded PostgreSQL and Encryption at Rest

`@di-framework/pglite-component` (`di-framework:pglite/database@0.2.0`) embeds a single-backend PostgreSQL engine as a WASI Preview 2 WebAssembly component directly inside the workload composition (`wac plug`). Instead of connecting over TCP to an external or CloudNativePG (CNPG) cluster through `wasmcloud:postgres`, the component executes SQL calls across WIT and WebAssembly linear memory and persists its `PGDATA` directory on the workload's mounted WASI filesystem volume.

When combined with `@di-framework/pglite-encfs`, the entire PostgreSQL data directory (`PGDATA`, WAL segments, catalogs, and configuration) is transparently encrypted at rest at the WASI filesystem boundary (`wasi:filesystem/types@0.2.6` and `wasi:filesystem/preopens@0.2.6`, plus `@0.2.9` WASI interfaces) before reaching the host disk.

```text
guest.wasm ──di-framework:pglite/database@0.2.0──▶ pglite-component.wasm ──wasi:filesystem──▶ pglite-encfs.wasm ──▶ host volume (/data)
```

## Overview and When to Use

Choose embedded PostgreSQL (`@di-framework/pglite-component`) when a workload needs full PostgreSQL SQL semantics, interactive multi-statement transactions (`BEGIN` / `COMMIT` / `ROLLBACK` and savepoints), `plpgsql`, or `pgcrypto` with zero external database infrastructure and strict single-writer volume isolation:

| Capability | Embedded PostgreSQL (`@di-framework/pglite-component`) | Managed PostgreSQL (`wasmcloud:postgres@0.2.0`) |
| --- | --- | --- |
| **Execution model** | Bundled WASI component composed via `wac plug`; SQL crosses WIT memory with no network hop or TCP listener. | External PostgreSQL service accessed over the network via host connection pool. |
| **Transactions** | Real interactive `transaction(fn)` with `BEGIN`, `COMMIT`, `ROLLBACK`, and nested `SAVEPOINT` support over an exclusive connection. | Autocommit per call (`openPostgresDatabase`) or write-only single-query `atomicBatch`; no cross-call transaction affinity. |
| **Scaling & concurrency** | Single-owner `PGDATA` (`replicas: 1`, `deployPolicy: Recreate`, `di-framework.dev/exclusive-instance: "true"`). | Multi-replica horizontal scaling backed by a connection pool. |
| **Encryption at rest** | Component-level WASI filesystem encryption via `@di-framework/pglite-encfs` (XTS Codec 3 or crash-safe AEAD Codec 4). | Delegated to cluster storage class / disk-level encryption. |

### Engine Versions and Bundled Extensions

- **PostgreSQL 17.11 (`REL_17_11`)** in published `@di-framework/platform` **6.0.30** (`ghcr.io/di-framework/pglite-component@sha256:<digest>`).
- **PostgreSQL 18.6 (`REL_18_6`)** (upcoming / `main`) initializes new clusters with page-level `data_checksums` enabled (`initdb --data-checksums`).
- **Statically linked extensions:** Because the WASI engine cannot `dlopen` shared libraries at runtime, extensions are linked statically into the engine alongside a static OpenSSL 3.5 LTS `libcrypto` routed to WASI `random`:
  - `plpgsql` (enabled by default).
  - `pgcrypto` (`CREATE EXTENSION IF NOT EXISTS pgcrypto;`) providing `digest()`, `hmac()`, `crypt()`, `gen_salt()`, `pgp_sym_encrypt()`, `pgp_sym_decrypt()`, `pgp_pub_encrypt()`, and `pgp_pub_decrypt()`, alongside built-in `gen_random_uuid()`. Legacy OpenSSL algorithms (`bf`, `cast5`, and single `des`) are disabled for PGP/cipher operations; use `aes128`, `aes192`, or `aes256` for encryption (`crypt()` password hashing with `gen_salt('bf')` is implemented directly by `pgcrypto` and remains supported).
- **Database layout and durability:** Opening `/data/orders` stores `PGDATA` under `/data/orders/data/` (including the `di-framework-database` marker selecting the `postgres` database on newly initialized clusters) and runtime support files under `/data/orders/runtime/`. `fsync`, `synchronous_commit`, and `full_page_writes` are enabled before the backend starts. Missing or read-only storage fails closed; the component never silently substitutes an in-memory database.

## Application Adapter (`createWasmPgliteDatabase`)

Guest applications wrap the `di-framework:pglite/database@0.2.0` WIT import with `createWasmPgliteDatabase` (exported by `@di-framework/repo/postgres` and `@di-framework/pglite-component`) to obtain a full `SqlDatabase` implementation compatible with `@di-framework/repo` repositories and `MigrationRunner`:

```typescript
import { MigrationRunner, SqlStorageAdapter, type SqlDatabase } from '@di-framework/repo';
import { createWasmPgliteDatabase } from '@di-framework/repo/postgres';

const db: SqlDatabase = await createWasmPgliteDatabase(
  process.env.DI_PGLITE_DATA_DIR ?? '/data/pglite',
);

// Run schema migrations against embedded PostgreSQL
const runner = new MigrationRunner({ db, binding: 'orders' });
await runner.execute();

// Interactive multi-statement transactions and nested savepoints
await db.transaction(async (tx) => {
  await tx.run(
    'INSERT INTO orders (id, customer_id, total_cents, meta) VALUES (?, ?, ?, ?)',
    ['0195f3c0-0000-7000-8000-000000000001', 'cust_42', 12500n, { currency: 'USD' }],
  );

  // Nested transaction() calls open a SAVEPOINT
  await tx.transaction(async (sp) => {
    await sp.run('INSERT INTO order_audit (order_id, event) VALUES (?, ?)', [
      '0195f3c0-0000-7000-8000-000000000001',
      'created',
    ]);
  });
});

const order = await db.first<{ id: string; total_cents: number; meta: { currency: string } }>(
  'SELECT id, total_cents, meta FROM orders WHERE id = ?',
  ['0195f3c0-0000-7000-8000-000000000001'],
);
```

### `SqlDatabase` Contract and Type Mapping

The provider allows one open connection per component instance and serializes concurrent calls through an internal `AsyncMutex`:

- **Methods:** `query<T>(sql, params?)`, `first<T>(sql, params?)` (and repository `queryOne` helpers), `run(sql, params?)` returning `{ changes: number }`, `exec(sql)`, `transaction(fn)`, and `close()`.
- **Real transactions and savepoints:** Root `db.transaction(fn)` calls execute `BEGIN`, `COMMIT`, and `ROLLBACK` on error. Nested `tx.transaction(fn)` calls issue `SAVEPOINT di_sp_<n>`, `RELEASE SAVEPOINT`, and `ROLLBACK TO SAVEPOINT`, allowing inner work to roll back without aborting the outer transaction. Always prefer the callback view (`tx`) inside `fn` so statements join the active transaction across any async context.
- **Placeholder rewriting (`toPgPlaceholders`):** SQLite-style `?` placeholders are automatically rewritten to positional `$1`, `$2`, ... parameters when `params` is non-empty. Quoted strings (`'...'`, `E'...'`), quoted identifiers (`"..."`), dollar-quoted blocks (`$tag$...$tag$`), SQL comments (`--`, `/* ... */`), and `jsonb` `?|` / `?&` operators are preserved. For the bare `jsonb` key-existence `?` operator in a parameterized statement, use `jsonb_exists(col, ?)`. Do not mix `?` and `$n` in the same statement.
- **Parameter and result type mapping:**
  - `int8` / integers: Safe integers (`number` or `bigint` within `±(2^53 - 1)`) are bound as `integer` (`int8`) and returned as `number`. `bigint` values beyond `±(2^53 - 1)` within signed 64-bit range are bound as exact `int8` `BigInt` payloads and decoded as exact decimal strings (requires `@di-framework/componentize-qjs` `0.4.4-di.5` or later, installed by `@di-framework/cli-plugin-platform` `6.2.0+`). `bigint` values outside 64-bit `int8` range are sent as decimal `text` for `numeric` columns. Passing an unsafe integer `number` throws a `TypeError` to prevent silent precision loss.
  - `timestamptz` and `Date`: Every connection pins `DateStyle=ISO` and `TimeZone=UTC`. `Date` parameters are sent as RFC 3339 UTC strings (`toISOString()`), and `timestamptz` result cells are normalized to RFC 3339 UTC strings (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
  - `bytea`: `Uint8Array`, `ArrayBuffer`, and typed arrays are bound as `blob` (`bytea`) and returned as `Uint8Array`.
  - `json` / `jsonb`: Plain objects and arrays are serialized with `JSON.stringify` (sent with OID 0 for context inference) and parsed back with `JSON.parse` on read.
  - `string` (`text`, `uuid`, `numeric`): Sent with OID 0 so PostgreSQL infers `uuid`, `timestamptz`, `numeric`, or `jsonb` from column context.
- **Errors and `MigrationRunner` compatibility:** Provider errors throw `WasmPgliteError` with the PostgreSQL SQLSTATE in `error.code` (for example `'23505'` for unique violations) and a message prefixed with `PostgreSQL <code>`, matching `isUniqueViolation` from `@di-framework/repo`. Because `createWasmPgliteDatabase` rewrites `?` placeholders and provides real transactions, `MigrationRunner` runs directly against embedded PostgreSQL.

## CLI Build and Composition (`di-framework.config.json`)

Configure embedded PostgreSQL in `di-framework.config.json` under the `"pglite"` block:

```json
{
  "name": "orders",
  "entry": "src/app.ts",
  "pglite": {
    "image": "ghcr.io/di-framework/pglite-component@sha256:<digest>",
    "storageMount": "/data",
    "dataDir": "/data/pglite"
  }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `pglite.image` | Required (unless `wasm` is set) | Immutable OCI component reference pinned by `@sha256:<digest>`. Mutable tags are rejected. |
| `pglite.wasm` | None | Local `.wasm` file path inside the project for offline component development (or `DI_FRAMEWORK_PGLITE_WASM` env override). Refused by `platform deploy` and in CI unless `DI_FRAMEWORK_ALLOW_LOCAL_PGLITE=1` is set. |
| `pglite.storageMount` | `"/data"` | Mounted WASI filesystem preopen path (resolved against `wasmcloud.storage.mounts`; tenant targets accept `/data` or `/data/actors`). |
| `pglite.dataDir` | `"<storageMount>/pglite"` (`/data/pglite`) | Database root directory under `storageMount`, injected into the guest environment as `DI_PGLITE_DATA_DIR`. Setting a conflicting user `wasmcloud.env.DI_PGLITE_DATA_DIR` or configuring two workload members that resolve to the same database root fails with `WASMCLOUD_PGLITE_DATA_DIR_CONFLICT`. |
| `pglite.encryption` | None | Optional `@di-framework/pglite-encfs` configuration (`{ "image": "ghcr.io/di-framework/pglite-encfs@sha256:..." }` or local `wasm`); see [Encryption at Rest](#encryption-at-rest-di-frameworkpglite-encfs). |

### Build and Composition Pipeline

When you run `di-framework platform build`:

1. The CLI verifies that the guest imports `di-framework:pglite/database@0.2.0` and that the `"pglite"` configuration block is present.
2. It pulls the digest-pinned OCI artifact using `oras`, verifies both the manifest digest and the `application/wasm` layer digest, and caches the verified artifact under `ORAS_CACHE_DIR` / `$DI_FRAMEWORK_CACHE_DIR` (`~/.cache/di-framework/oras/pglite/<sha256>.wasm` and `~/.cache/di-framework/oci/sha256/<digest>/`).
3. It copies the verified provider into `.di-framework/di-framework-pglite.wasm` and plugs it into the compiled application component via `wac plug`.

## Exclusive Instances and Rollout Serialization

Because PostgreSQL locks its `PGDATA` directory to a single process (`postmaster.pid`) and does not share write state across instances, `di-framework platform deploy` automatically enforces single-owner execution on every pglite workload:

- Annotates the workload component with `di-framework.dev/exclusive-instance: "true"` and `di-framework.dev/persistent-storage: "true"`.
- Sets `replicas: 1` (`maxInstances: 1`) and `deployPolicy: Recreate` (Kubernetes deployment strategy `Recreate`). Any configuration with `replicas > 1` is rejected.

On the exclusive tenant host image (`ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive`, pinned by digest), the platform enforces **two-gate serialization** so two instances or rollout revisions never open the same `PGDATA` directory concurrently:

1. **Host-local FIFO call permit (`ExclusiveInstanceGate`):** Within a host pod, concurrent `wasi:http/incoming-handler` requests queue in arrival order behind a single FIFO call permit. Only one warm component instance is built, and each caller holds the permit until its in-flight execution slot finishes, ensuring the instance is completely idle before the next request is admitted.
2. **Cross-pod / cross-revision store lease (`di-exclusive-store-<workload>`):** Across revisions and pods, a Kubernetes `Lease` (`di-exclusive-store-<workload>` in `di-runtime-<t>`) and the host's canonical volume-mount gate registry ensure that a new revision's store cannot be instantiated until the terminating revision has finished draining in-flight calls, dropped its Wasm store, and released the lease (bounded by `WASH_EXCLUSIVE_WAIT_TIMEOUT_SECS`, default `600` seconds).

## Encryption at Rest (`@di-framework/pglite-encfs`)

`@di-framework/pglite-encfs` (`ghcr.io/di-framework/pglite-encfs@sha256:<digest>`) is a WASI WebAssembly component that interposes on `wasi:filesystem/types@0.2.6` and `wasi:filesystem/preopens@0.2.6` (as well as the provider's `@0.2.9` WASI filesystem/io/cli imports) between `pglite-component` and the host. Every file under `PGDATA` is encrypted before it is written to the host volume, while the guest application's own WASI imports continue to go directly to the host.

### Configuring Encryption in `di-framework.config.json`

Add `pglite.encryption` and declare `"DI_PGLITE_KEY"` in `controlSecretKeys` (or `wasmcloud.controlSecretKeys`):

```json
{
  "name": "orders",
  "entry": "src/app.ts",
  "controlSecretKeys": ["DI_PGLITE_KEY"],
  "pglite": {
    "image": "ghcr.io/di-framework/pglite-component@sha256:<digest>",
    "encryption": {
      "image": "ghcr.io/di-framework/pglite-encfs@sha256:<digest>"
    }
  }
}
```

Build-time verification enforces three fail-closed checks:

- **Declared key requirement (`WASMCLOUD_PGLITE_KEY_UNDECLARED`):** Omitting `DI_PGLITE_KEY` from `controlSecretKeys` when `pglite.encryption` is set immediately fails `di-framework platform build` with `WASMCLOUD_PGLITE_KEY_UNDECLARED` before bundling or pulling artifacts.
- **Layer identity check (`WASMCLOUD_PGLITE_ENCRYPTION_LAYER_UNMARKED`):** `platform build` inspects the encryption component for the `di-framework:pglite-encfs` custom section (`format=1 codec=aes-256-xts write-codec=3 read-codecs=2,3,4 integrity=1`) and stops with `WASMCLOUD_PGLITE_ENCRYPTION_LAYER_UNMARKED` if a non-encfs or unmarked component was supplied.
- **Explicit filesystem interposition check (`WASMCLOUD_PGLITE_ENCRYPTION_NOT_INTERPOSED`):** Rather than relying on `wac plug` (which silently skips mismatched exports), `platform build` inspects both worlds with `jco wit`, generates `.di-framework/pglite-encryption.wac`, and runs `wac compose` to verify that every `wasi:filesystem/*` import of `pglite-component` is wired through `pglite-encfs`. Any un-interposed filesystem import or disallowed pass-through fails the build with `WASMCLOUD_PGLITE_ENCRYPTION_NOT_INTERPOSED`.

### Key Provisioning and Zero-Downtime Rotation

`pglite-encfs` requires a 256-bit master key (supplied as 64 hex characters or 32 random bytes encoded in base64). `pglite-encfs` reads `DI_PGLITE_KEY` once at initialization, derives its Key Encryption Key (KEK) and 16-byte Key Check Value (KCV) via `HKDF-SHA256(salt = "di-framework/encfs/v1")`, wipes the key material from memory, and strips `DI_PGLITE_KEY` and `DI_PGLITE_KEY_PREVIOUS` from the `wasi:cli/environment` export seen by the PostgreSQL engine.

Provision the key before deploying. On a controller-backed (`/v1`) target, set secret
`di-pglite-key` (which the controller exposes to the workload as `DI_PGLITE_KEY`):

```bash
# Via the platform CLI extension:
openssl rand -base64 32 | di-framework platform secrets set di-pglite-key --env prod --from-file -

# Or via the tenant CLI:
openssl rand -base64 32 | di-tenant secrets set di-pglite-key --env prod --from-file -
```

On a kubeconfig-backed target, write `DI_PGLITE_KEY` (alongside `DI_CONTROL_TOKEN` and
`DI_CONTROL_IDENTITY`) into the workload's `<deployment>-control` Secret in the target namespace.

To rotate the master key without downtime:

1. Provision the new 256-bit key in `DI_PGLITE_KEY` and move the existing key to `DI_PGLITE_KEY_PREVIOUS` (declaring both `"DI_PGLITE_KEY"` and `"DI_PGLITE_KEY_PREVIOUS"` in `controlSecretKeys`).
2. Redeploy or restart the workload. On startup, `pglite-encfs` verifies the 16-byte KCV in the hidden `.di-encfs` root marker against `DI_PGLITE_KEY_PREVIOUS`, walks the volume to re-wrap per-file DEKs in the 4096-byte file headers (and re-encrypts blocks on write), syncs each file, and atomically updates `.di-encfs` (via `.di-encfs.tmp`) to the new key's KCV.
3. Once the log reports `pglite-encfs: key rotation complete`, remove `DI_PGLITE_KEY_PREVIOUS`. If a crash occurs mid-rotation, the root marker remains on the previous KCV and the next startup idempotently resumes rotation.

> [!WARNING]
> **Fail-closed semantics and key custody:** If `DI_PGLITE_KEY` is missing, malformed, or its KCV does not match `.di-encfs` (and `DI_PGLITE_KEY_PREVIOUS` does not match), or if an unencrypted directory is mounted under `pglite-encfs`, the layer refuses access before any byte is written. Back up `DI_PGLITE_KEY` separately from volume backups—losing the key renders the volume permanently unreadable.

### On-Disk Encryption Codecs

Every encrypted file starts with a 4096-byte header (`magic = DIPGENC1`, format version `1`, codec byte, 16-byte random `file_id`, 16-byte wrapping key KCV, 24-byte XChaCha20 nonce, 64-byte per-file random DEK wrapped with XChaCha20-Poly1305, and 16-byte Poly1305 tag). `pglite-encfs` supports two production on-disk data codecs:

- **Codec 3 — Length-Preserving AES-256-XTS:**
  - Default mode for standard `DIPGKEY1` directories.
  - Encrypts 4096-byte logical sectors (`physical_size == logical_size` after the 4096-byte header) using AES-256-XTS with a 64-byte key derived via HKDF-SHA256.
  - Complete 16-byte blocks use standard XTS tweak encryption; a final partial tail block (`len % 16` bytes) is XORed with a length-independent keystream (`AES-256(key2, unit_le64 || block_le32 || "TAIL")`), bounding unaligned-resize crash damage to at most 15 bytes while preserving PostgreSQL's 8 KiB page and WAL tear-resistance.
- **Codec 4 — Two-Slot Crash-Safe AES-256-GCM / AEAD:**
  - Authenticated integrity mode (`DIPGKEY2` root marker) providing full ciphertext authentication, tamper detection, and anti-rollback guarantees without sacrificing crash safety on in-place page rewrites (`pg_control`, WAL tail pages, and heap pages).
  - Logical 4096-byte blocks are stored in 8288-byte physical frames consisting of two 4144-byte A/B slots (and at the 8 KiB unit level, 16512-byte slot pairs alongside dual 4096-byte authenticated durable-size watermark records `D`).
  - Each write alternates to the inactive slot (`slot_id` A or B) with a monotonically increasing 64-bit transaction sequence number (`tx_seq`), a commit marker, and Additional Authenticated Data (AAD) binding `[file_id, block_index, slot_id, tx_seq, logical_len, is_final]`.
  - On read, `pglite-encfs` selects the slot with the highest valid `tx_seq` whose authentication tag verifies. If a power loss tears the in-flight slot write, the previous committed slot remains intact and verifiable. Any tampered or erased block below the durable-size watermark fails closed with an `io` error.
  - Selected when `DI_PGLITE_STORAGE_MODE=aead` is set or when `Tenant.spec.storage.integrity: AEAD` is configured on the tenant. Workloads declare `di-framework.dev/storage-format: pglite-encfs`, the tenant host's `storage-mode` init container writes the `DIPGKEY2` reservation marker into empty directories, and the platform controller reports the tenant's `StorageIntegrity` condition (`AsRecorded`, `IntegrityMismatch`, `AwaitingObservation`).

## Storage Records, Cold-Copy Backups, and Major-Version Migration

### Storage Records (`di-storage-records`)

The platform controller tracks every persistent workload volume's encryption format, requested and observed integrity mode (`NotEncfs`, `XTS`, or `AEAD`), and active `keyId` / KCV in `Tenant.status.storage.keys` and projects them into the `di-storage-records` ConfigMap in `di-runtime-<t>`. This provides an auditable cluster-side inventory of volume encryption state and prevents backup restores from downgrading or mismatching a volume's encryption mode (`ModeMismatch`, `KcvMismatch`, `StorageRecordsUntrusted`, `TargetNotRecorded`).

### Cold-Copy Workload-Volume Backups

Because embedded PostgreSQL is a single-writer engine with no network listener or online snapshot API, workload volumes are backed up via coordinated cold copies using `BackupDestination` and `TenantBackupSchedule` (`di-backup-<t>-*` CronJobs):

1. **Lease acquisition and scale-down:** After verifying node placement (`probe-placement`), the backup operator records active replica counts in `di-backup-held-replicas`, scales the workload to zero, and acquires the workload's `di-exclusive-store-<workload>` lease before snapshotting so no component instance can write to `PGDATA`.
2. **Streaming hash and manifest generation:** The backup agent streams the volume into `data.tar` while computing per-file SHA-256 checksums (`SHA256SUMS`) and inspecting directory names to record every `PGDATA` tree under `manifest.json` (`dataDirectories`, `complete`, `applicationDatabase`, `encfsMode`, and the `.di-encfs` KCV). If any file changes during the read, the backup aborts with `SourceChanged`.
3. **Envelope encryption:** For off-host durability, the archive is encrypted with an ephemeral AES-256-GCM Data Encryption Key (DEK) wrapped by the tenant's Key Encryption Key (`tenant-backup-kek-<t>`), while preserving the inner `pglite-encfs` ciphertext untouched.
4. **Replica restoration:** Once the upload completes (or on any timeout, cancellation, or failure), the operator releases the exclusive lease and restores the workload's replicas from `di-backup-held-replicas`.

### Offline PostgreSQL 17 to 18 Volume Migration

A `PGDATA` directory is bound to a single PostgreSQL major version (`PG_VERSION`). Opening a PostgreSQL 17 directory with the PostgreSQL 18.6 provider fails closed with `incompatible PostgreSQL data directory: PG_VERSION is 17`.

To upgrade existing PostgreSQL 17 `PGDATA` directories (either plaintext or encrypted with `pglite-encfs`) to PostgreSQL 18.6 with `data_checksums` enabled, run the offline volume migration script (`scripts/migrate-17-to-18.ts`) while the workload is scaled down:

- The script mounts the existing PG 17 root (composing `pglite-encfs` with `DI_PGLITE_KEY` when `.di-encfs` is present), exports the application database (`postgres` or legacy `template1`) using the pinned PG 17.11 provider, initializes a fresh PG 18.6 cluster with `initdb --data-checksums` in a staging directory, imports and verifies the schema and row counts, and atomically swaps the directory into place.
- If any export, import, or verification step fails, the script automatically rolls back to the untouched PG 17 directory.
