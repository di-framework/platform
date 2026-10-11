# di-framework:pglite — embedded PostgreSQL over WIT

The provider bundles the PGlite PostgreSQL 17.5 engine into a WebAssembly
component. SQL calls cross WIT and WebAssembly memory. There is no TCP listener,
network client, native sidecar, or separate database service.

```text
app.wasm → di-framework:pglite/database → bundled PostgreSQL engine
                                                ↓
                                          WASI filesystem
                                                ↓
                                       persistent /data mount
```

`open("/data/orders", none)` opens a persistent database root. An empty path
selects `/data/pglite`. Missing or read-only storage fails; the provider never
silently substitutes an in-memory database. This replaces the old TCP client:
`PGHOST`, `PGPORT`, and connection-target strings are no longer used.

## Build and verify

```sh
make tools
make build
make smoke
bun test
```

Use the pinned Rust toolchain through rustup, Python 3, and the installed
`wasm-tools`/`wac`. Preparing the engine from source also needs a Linux Docker
or Podman daemon, Git, curl, and several GB of build storage. The engine build
is cached under `target/engine`. Containers are build tools only; deployment
runs the resulting `.wasm` directly. For a remote Podman daemon, set the task's
`DOCKER_CONTEXT=podman`.

The build embeds the support filesystem, adapts the engine's WASI Preview 1
imports to Preview 2, and composes the engine with the Rust database provider.
It fails if the final artifact imports sockets or leaves the engine unresolved.
Ship `dist/di-framework-pglite.wasm` together with `THIRD-PARTY-NOTICES.txt`.
Build provenance and checksums are in `dist/BUILD-INFO.txt` and `SHA256SUMS`.

`make smoke` composes a real WIT consumer, runs it without network access, and
checks typed parameters/results, SQL errors and recovery, transactions,
rollback on close/drop, exclusive connection ownership, durability settings,
and persistence across separate runtime processes. It also exits a runtime
with an open transaction and verifies that committed rows survive and the
uncommitted row is absent after restart. No scripted database server is used.

## Publishing to GHCR

The pglite component is published to GitHub Container Registry (GHCR) as an OCI wasm component. [The workflow](https://github.com/di-framework/platform/actions/workflows/pglite-component-publish.yml) runs by itself on each push to `main` that changes one of its input paths (`on.push.paths`). `workflow_dispatch` stays available for reruns and always builds.

The workflow has four jobs:
- `check-source` (`packages: read`) hashes the committed input files (`scripts/source-check.ts`). On a push it skips the build when `ghcr.io/di-framework/pglite-component:src-<hash>` already exists, so commits that do not change the component publish nothing.
- `build` (no write token) runs the same targets as `ci.yml`: `make tools-rust`, `make unit smoke` (which runs `make build`, composing the provider with the engine via `wac plug`), then the publisher crates' clippy and tests.
- `publish` (`packages: write`) downloads the tested `dist/` and runs `pglite-component-publisher`. It never rebuilds or modifies `dist/`. It checks `SHA256SUMS`, requires the export `di-framework:pglite/database@0.2.0` and rejects any import that is not `wasi:*`, then pushes `ghcr.io/di-framework/pglite-component:<commit sha>` once, pulls it back by the manifest digest to compare bytes, then points the version tag (`0.2.0`, the WIT package version) at that same manifest with `oras tag` and asserts both tags resolve to one digest. The `build` job passes the tested wasm sha256 to `publish`, which verifies it before pushing. It also tags the manifest `src-<hash>`.
- `pin` (`contents: write`, `pull-requests: write`) opens or updates the PR `bot/pin-pglite-component`, "chore: pin pglite-component to <digest>", which rewrites the digests in this README with `scripts/pin-artifact.ts`. GitHub does not run workflows on a PR that `GITHUB_TOKEN` opened, so a maintainer has to start its checks (close and reopen it) before merging.

Tags are movable. `0.2.0` always points to the latest `main` publish for WIT package 0.2.0, and re-running a commit also moves its SHA tag. Only the `@sha256:...` digest is immutable, so consumers pin by digest.

### Artifact location

The digest is in **Details** > **Record component digest** > **Step summary**, and in the `pglite-publish-report` artifact (`publish-report.json`).
Published digest: `ghcr.io/di-framework/pglite-component@sha256:<pending first publish>`

**Note:** The GHCR package must be made public by an org admin after the first publish. Until then, only members with access to di-framework/platform can pull it.

## Use from an application

The application imports `di-framework:pglite/database@0.2.0`. For a JavaScript
component built with the framework's component toolchain:

```ts
import { open } from 'di-framework:pglite/database@0.2.0';

const db = open('/data/orders', undefined);
try {
  db.exec('CREATE TABLE IF NOT EXISTS orders (id bigint PRIMARY KEY, title text)');
  db.run('INSERT INTO orders VALUES ($1, $2)', [
    { tag: 'integer', val: 1n },
    { tag: 'text', val: 'First order' },
  ]);
  const row = db.first('SELECT title FROM orders WHERE id = $1', [
    { tag: 'integer', val: 1n },
  ]);
} finally {
  db.close();
}
```

Compose the application with the provider. For a local build:

```sh
make compose APP=path/to/app.wasm OUT=path/to/app.composed.wasm
mkdir -p ./data
wasmtime run --dir ./data::/data path/to/app.composed.wasm
```

To use the published OCI component from GHCR instead (pin by digest for reproducibility):

```sh
export PGLITE_REF='ghcr.io/di-framework/pglite-component@sha256:<digest>'
wash oci pull "${PGLITE_REF}" pglite.wasm
wac plug --plug pglite.wasm path/to/app.wasm -o path/to/app.composed.wasm
mkdir -p ./data
wasmtime run --dir ./data::/data path/to/app.composed.wasm
```

Consumers (like cli-extensions) pin the component by digest.

That invocation is for a command component; serve HTTP components using your
normal host while granting the same filesystem preopen. The final component
requires WASI filesystem, clocks, streams, CLI and randomness interfaces, plus
standardized WebAssembly exception handling for PostgreSQL error recovery.

The public interface retains `exec`, `run`, `query`, `first`, transactions,
savepoints, `rows-affected`, `close`, and `server-version`. PostgreSQL parameters
use `$1`, `$2`, etc. Text parameters are sent with OID 0 (unknown type), allowing
PostgreSQL to infer the type from context; comparisons against `uuid`, `timestamptz`,
and `jsonb` columns work correctly (see Typed values). `server-version()` reports the bundled engine without
opening a database. Only the `template1` database is currently supported;
other `open-options.database` values are rejected. Requests must fit the engine's
input buffer; each serialized result is limited to 64 MiB and stays in memory.
Larger results return a PostgreSQL program-limit error. Signal-based statement
timeouts are unavailable in this WASI engine: nonzero `statement-timeout-ms`
options fail explicitly. Use host execution limits for runaway queries.

## Typed values (0.2.0+)

Every `open` pins `DateStyle=ISO` and `TimeZone=UTC` (set in the startup packet and re-applied
on each open, since `close` runs `DISCARD ALL`), so text output is deterministic. Result mapping by
PostgreSQL type:

| PostgreSQL type | `value` variant | Format |
| --- | --- | --- |
| `bool` | `boolean` | |
| `int2`, `int4`, `int8` | `integer` | `int8` is `integer` (`s64`); node-pg returns a string |
| `float4`, `float8` | `real` | |
| `bytea` | `blob` | |
| `json`, `jsonb` | `json` | JSON text; `jsonb` is re-rendered by PostgreSQL (`{"a": 1}`) |
| `timestamptz` | `timestamp` | RFC 3339 in UTC, e.g. `2024-01-15T10:30:00Z`, fractional seconds kept (`...:00.123Z`). `infinity` and `-infinity` are returned as those literals; BC dates are returned unmodified (`0044-03-15 00:00:00+00 BC`) |
| `timestamp` (no zone) | `text` | `2024-01-15 10:30:00` (ISO, space separator, no offset). Deliberately not `timestamp`, which always denotes an instant |
| `date` | `text` | `2024-01-15` |
| `uuid`, `numeric` | `text` | canonical PostgreSQL text (`12.50` keeps its scale) |
| arrays | `text` | PostgreSQL array literal, e.g. `{a,b}` |
| everything else | `text` | |

Parameters are typed as follows. `integer`, `real`, `boolean` and `blob` are
sent as `int8`, `float8`, `bool` and `bytea`. `text`, `json` and `timestamp`
are all sent with OID 0 (unknown), so PostgreSQL infers the type from context:
a `json` parameter works against `json` and `jsonb` columns and with `jsonb`
operators (`@>`, `=`), and a `timestamp` parameter against `timestamptz` and
`timestamp` columns. Send RFC 3339 for `timestamp`; any string PostgreSQL
accepts for the inferred type works.

Column type OIDs are not exposed: adding them to `row` would change its shape
and break every existing consumer, and the variants above plus Text for the
rest cover the adapters' needs. A separate additive API can be added later.

### Migrating from 0.1.0

Bump consumers and composition pins to `di-framework:pglite/database@0.2.0`
(the `value` variant gained cases, so 0.1.0 bindings do not link). Text
parameters were previously sent as `text` (OID 25); they are now OID 0. That
fixes `uuid = $1`, `timestamptz < $1` and `jsonb @> $1`, but PostgreSQL can no
longer type a parameter that has no context: `SELECT $1 IS NULL` now fails with
`could not determine data type of parameter $1`. Add a cast, for example
`SELECT $1::text IS NULL`.

Error mapping changed: undefined table (42P01), undefined column (42703) and
every other class-42 code except 42601 (syntax error) and 42P18 (un-inferable
parameter type) moved from `invalid-sql` to `execution-failed`. Branch on
`pg-error.code` instead of the variant for those cases.

Error handling surfaces SQLSTATE codes through `error.code`, enabling
machine-readable handling of constraint violations and other conditions:
- `"23505"` = unique violation
- `"22012"` = division by zero
- `"54000"` = result too large

## Persistence and ownership

For an `open("/data/orders", ...)` call:

- `/data/orders/data/` is PGDATA (catalogs, tables, WAL and configuration).
- `/data/orders/runtime/` contains bundled initialization/support files.
- Bootstrap and shared-memory scratch files also stay beneath `/data/orders`.

Mount the entire root on persistent storage and reuse it after restarts.
Initialization creates the cluster once; later starts reuse it. Incomplete
clusters or an incompatible PostgreSQL major version are rejected.
`fsync`, `synchronous_commit`, and `full_page_writes` are enabled before the
backend starts. The host filesystem must honor WASI sync operations; a local
restart test is not a power-loss durability certification.

**Give each database directory one component owner at a time.** The provider
rejects a second simultaneous connection within its component instance. Close
or drop rolls back uncommitted work, resets session settings, and allows the
same root to be reopened. A component instance stays bound to its first root;
use another instance for a different database.

There is no cross-instance filesystem lock in this WASI implementation. The
host must serialize access to each directory, including request instances and
rolling replacements. A single replica alone does not prevent concurrent
request instances from sharing files. Do not mount one root into overlapping
instances or replicas. Fatal engine traps require a new component instance.

For the framework's platform-managed storage, annotate the WorkloadDeployment:

```yaml
metadata:
  annotations:
    di-framework.dev/persistent-storage: "true"
    di-framework.dev/storage-mount: /data
```

The platform controller mounts the workload's persistent directory and grants
its components the matching WASI preopen. Use a stable workload identity on
redeploy and configure exclusive execution for this database. These
annotations provide storage; they do not enforce database ownership.

## Implementation

- `src/lib.rs`: public WIT resources and connection lifecycle.
- `src/pgwire.rs`: PostgreSQL message encoding and typed rows, over memory.
- `src/engine.rs`: persistent filesystem setup and exclusive engine access.
- `engine/bridge.wat`: private canonical ABI bridge to the core engine.
- `scripts/prepare-engine.ts`: pinned engine preparation and componentization (all build scripts are Bun TypeScript; see `scripts/`).
- `wit/deps/pglite-engine/engine.wit`: internal interface, composed away at build.

Engine provenance and modifications are described in `engine/NOTICE`.
