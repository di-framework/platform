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

## npm package

`@di-framework/pglite-component` is versioned with this repository (6.0.x) and
published by the platform release workflow. It contains:

| Import | What |
| --- | --- |
| `@di-framework/pglite-component` | The `SqlDatabase` adapter (`createWasmPgliteDatabase`, see below), ESM with types |
| `@di-framework/pglite-component/wasm` | `dist/di-framework-pglite.wasm`, the composed provider component |
| `@di-framework/pglite-component/wit` | `dist/di-framework-pglite.wit`, the WIT recovered from that component |
| `@di-framework/pglite-component/wit/*` | The source WIT (`wit/world.wit` and its `deps/`) for bindings generators |

`BUILD-INFO.txt`, `SHA256SUMS` and `THIRD-PARTY-NOTICES.txt` ship next to the
wasm. The adapter needs `@di-framework/repo` `^6.1.0` as a peer dependency.

The release job builds the wasm from source with the same `make` targets as
CI, runs `make unit smoke` against it, and refuses to publish a pack without
the wasm or the adapter. The npm copy is for application developers composing
locally. GHCR stays the digest-pinned source that the CLI composes at deploy
time (see [Publishing to GHCR](#publishing-to-ghcr)); the two are separate
builds of the same sources and are not guaranteed to be byte-identical, so pin
deployments by GHCR digest.

## Build and verify

```sh
make tools
make build
make smoke
bun test
```

`bun run build` builds the adapter (`bun run build:adapter`, TypeScript only,
no engine) and then runs `make build`.

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

On one host architecture and one builder image, two clean engine builds are
byte-identical. `scripts/build-engine.ts` sets `SOURCE_DATE_EPOCH` to the commit
time of the pinned engine recipe (`PGLITE_SOURCE_REF`) and passes it into the
build container. OpenSSL then writes that date into `crypto/buildinf.h`
instead of the wall clock, so `libcrypto.a` is deterministic, and clang's
`__DATE__`/`__TIME__` are fixed. `engine/build-pgcrypto.sh` fails if
`buildinf.h` does not carry the pinned date. The engine does not link
OpenSSL's build info today, so this guards against it being linked in later.
`make reproducible` builds the engine twice from clean copies of the package
and fails unless `pglite.wasi`, `engine.core.wasm`, `engine.wasm` and every
embedded support file have the same sha256. The builds go in a new
`df-pglite-repro.*` directory under the system temp dir, or under
`REPRO_ARGS="--work-dir DIR"`, which must be outside the repository checkout.
Only that new directory is deleted, and it is kept if a build fails or the
digests differ. `--sdk-cache DIR` reuses SDK tarballs you have already
downloaded, and `--keep` keeps both builds. The
[reproducibility workflow](../../.github/workflows/pglite-engine-reproducible.yml)
runs the check on x86_64 when an engine input changes.

The results are not portable across these limits:
- An aarch64 host and an x86_64 host produce different engines and support
  files, so an Apple Silicon build does not reproduce the released x86_64
  engine.
- The builder image's `FROM debian:12` tag and its `apt-get` packages are not
  pinned, so builds made months apart can differ.

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
- `pin` (`contents: write`, `pull-requests: write`) opens or updates the PR `bot/pin-pglite-component`, "chore: pin pglite-component to <digest>", which rewrites the digests in this README with `scripts/pin-artifact.ts`. GitHub does not run workflows on a PR that `GITHUB_TOKEN` opened, so a maintainer has to start its checks (close and reopen it) before merging. It also runs when a push's source is already published (a revert to an older source, or a pin PR closed unmerged), so `main`'s pin follows the current source; it opens no PR when `main` already has the digest. On that path the `realign` job (`packages: write`) points the moving version tag back at that source's digest with `scripts/retag.sh`, which leaves a tag that is already there alone. Every tag move is behind the same source guard, so a stale run never retags.

Tags are movable. `0.2.0` always points to the latest `main` publish for WIT package 0.2.0, and re-running a commit also moves its SHA tag. Only the `@sha256:...` digest is immutable, so consumers pin by digest.

### Artifact location

The digest is in **Details** > **Record component digest** > **Step summary**, and in the `pglite-publish-report` artifact (`publish-report.json`).
Published digest: `ghcr.io/di-framework/pglite-component@sha256:9ead24c8d0612beb6a6533c8d4b14b192eeb6c1811d2fb19f248ec2fe7206d2e`

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
export PGLITE_REF='ghcr.io/di-framework/pglite-component@sha256:9ead24c8d0612beb6a6533c8d4b14b192eeb6c1811d2fb19f248ec2fe7206d2e'
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

## `SqlDatabase` adapter

`createWasmPgliteDatabase` adapts the `di-framework:pglite/database@0.2.0`
import to the `SqlDatabase` contract of `@di-framework/repo`, so repositories
and migrations run on embedded PostgreSQL. Compose your component with this
provider (see above). The adapter is portable: it uses only
`node:async_hooks`, which the framework's component toolchain shims.

```ts
import type { SqlDatabase } from '@di-framework/repo';
import { createWasmPgliteDatabase } from '@di-framework/pglite-component';

// The database root is yours to choose. An empty path selects /data/pglite.
const db: SqlDatabase = await createWasmPgliteDatabase('/data/identity');

await db.exec('CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, email text UNIQUE, meta jsonb)');
await db.transaction(async (tx) => {
  await tx.run('INSERT INTO users (id, email, meta) VALUES (?, ?, ?)', [id, email, { plan: 'free' }]);
});
const user = await db.first<{ email: string; meta: { plan: string } }>(
  'SELECT email, meta FROM users WHERE id = ?',
  [id],
);
```

The provider allows one open connection per component instance. Keep one
handle and share it: every call goes through one async mutex.

- **Transactions.** `transaction(fn)` runs the provider's `begin` and `commit`, and `rollback` when `fn` throws. Statements issued from inside `fn`, through the callback view or the outer handle, join the transaction; other tasks wait for it. Inside `fn`, prefer the callback view: while the transaction is open it joins from any async context, including a worker loop or `AsyncResource` created earlier, and Wasm-guest code that the `node:async_hooks` shim does not instrument (native async generators). The outer handle joins only from `fn`'s own async context. From any other context it waits for the mutex, so awaiting it from `fn` deadlocks. A nested `transaction()` opens a savepoint. When it throws, only its own work rolls back, and the outer transaction can continue. Its work commits only with the outer transaction. Sibling savepoints started concurrently run one at a time. A plain statement issued through a view while a sibling savepoint is open joins that savepoint and rolls back with it: in `Promise.all([tx.transaction(failing), (async () => { await work(); await tx.run(...); })()])`, a `run` issued while the savepoint is open lands inside it, so await the savepoint first when the statement must survive it. Statements issued concurrently inside one transaction reach the connection one at a time, also with bindings that return promises. `transaction()` on a view, called from another async context while a sibling savepoint is open, waits for that sibling to finish; if the sibling awaits that call, it waits forever. Joining lasts only while a transaction is open. A savepoint's callback view kept after the savepoint returns joins the nearest open ancestor while the root transaction is still open, and its work commits or rolls back with that ancestor. Once the root transaction has ended, a retained callback view, like a timer scheduled inside `fn`, waits for the mutex like any other caller and never runs inside another task's transaction.
- **Placeholders.** `?` placeholders become `$1`, `$2`, ... in order (`toPgPlaceholders`). The rewrite skips `'...'` and `E'...'` strings, `"..."` identifiers, `$tag$...$tag$` bodies, `--` and `/* */` comments, and the jsonb operators `?|` and `?&`. Because of that, `?||` reads as `?|` followed by `|`: put a space in the concatenation (`? || 'x'`). The bare jsonb `?` operator looks like a placeholder: use `jsonb_exists(col, ?)` in a statement with parameters. A statement run without parameters is not rewritten. You can write `$n` yourself, but do not mix `$n` with `?` in one statement.
- **Parameters.** `string` is sent as text, and PostgreSQL infers its type from context, so a UUID or timestamp string works against `uuid` and `timestamptz` columns. A safe integer is `int8`, another number is `float8`, a `boolean` is `bool`, and `Uint8Array`, `ArrayBuffer` and typed arrays are `bytea`. A `Date` is sent as an RFC 3339 timestamp. Plain objects and arrays are sent as JSON, so a JavaScript array is not a PostgreSQL array: pass a literal such as `'{a,b}'`. A `bigint` outside the safe integer range is sent as decimal text, so it is not rounded. A `number` that is an integer outside the safe range throws a `TypeError`, because it has already lost precision: pass a `bigint` or a decimal string for `int8`. NaN and Infinity are valid `float8` values and are sent as `real`.
- **Results.** Values match the `wasmcloud:postgres` codec in `@di-framework/repo`, so repositories behave the same on both backends. `json` and `jsonb` are parsed. `timestamptz` is an ISO string with milliseconds (`2024-01-15T10:30:00.123Z`, microseconds truncated); `infinity` and BC dates are returned as PostgreSQL prints them. An `int8` outside the safe integer range is a decimal string, but only when the binding lifts WIT `s64` as a `bigint`; a binding that lifts it as a JavaScript number (componentize-qjs lowers `s64` from numbers) has already lost the precision, so cast large `int8` columns to `text` in the query (`id::text`) when exact values matter (#153). `bool` is a boolean, `bytea` is a `Uint8Array`, and `timestamp` without zone, `date`, `uuid`, `numeric` and arrays are strings.
- **Errors.** Failures throw `WasmPgliteError` with the WIT `tag`. A PostgreSQL error keeps its SQLSTATE in `error.code` (`'23505'` for a unique violation), and the message starts with `PostgreSQL <code>`, so `isUniqueViolation` from `@di-framework/repo` works too.

Pass `module` or `loadModule` to supply the interface yourself (for tests), and
`database` or `statementTimeoutMs` to forward `open-options`.
`createSqlDatabaseFromWasmPgliteConnection` wraps a connection you have already
opened.

The adapter's view of the import is typed by `js/wit.d.ts`, generated from
`wit/world.wit` by `bun scripts/wit-types.ts`. After changing the WIT, rerun it;
the tests and `build:adapter` fail while the file is stale, and the typecheck
fails when the WIT no longer fits the adapter. That check covers method names,
arity and result types, not parameter variants: removing or narrowing a `value`
case is not caught (TODO #153).

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

## Extensions

The engine cannot load shared libraries, so extensions are linked into it
statically. It includes `plpgsql` and `pgcrypto`. Enable pgcrypto from a migration:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT pgp_sym_decrypt(pgp_sym_encrypt('secret', 'key'), 'key');
SELECT encode(digest('a', 'sha256'), 'hex');
SELECT crypt('password', gen_salt('bf'));
```

pgcrypto links a static `libcrypto` built from the pinned OpenSSL 3.5 LTS
source (`OPENSSL_*` in `scripts/tool-versions.env`, Apache-2.0). Every salt,
PGP session key and padding byte comes from `pg_strong_random`, which the
engine routes to the host's WASI `random` interface. `gen_random_uuid()` is
built into PostgreSQL and works without the extension. Other contrib modules
are not included. The WIT interface does not change.

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

- `js/adapter.ts`: the `SqlDatabase` adapter published on npm (`bun run build:adapter`).
- `js/wit.d.ts`: generated TypeScript view of the `database` interface.
- `src/lib.rs`: public WIT resources and connection lifecycle.
- `src/pgwire.rs`: PostgreSQL message encoding and typed rows, over memory.
- `src/engine.rs`: persistent filesystem setup and exclusive engine access.
- `engine/bridge.wat`: private canonical ABI bridge to the core engine.
- `engine/build-pgcrypto.sh`: builds OpenSSL libcrypto and pgcrypto in the engine container and generates pgcrypto's static `dlsym` table; `scripts/patch-engine-source.ts` links both into the engine.
- `scripts/prepare-engine.ts`: pinned engine preparation and componentization (all build scripts are Bun TypeScript; see `scripts/`).
- `wit/deps/pglite-engine/engine.wit`: internal interface, composed away at build.

Engine provenance and modifications are described in `engine/NOTICE`.
