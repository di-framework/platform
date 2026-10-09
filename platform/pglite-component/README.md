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

## Use from an application

The application imports `di-framework:pglite/database@0.1.0`. For a JavaScript
component built with the framework's component toolchain:

```ts
import { open } from 'di-framework:pglite/database@0.1.0';

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

Compose the application with the provider:

```sh
make compose APP=path/to/app.wasm OUT=path/to/app.composed.wasm
mkdir -p ./data
wasmtime run --dir ./data::/data path/to/app.composed.wasm
```

That invocation is for a command component; serve HTTP components using your
normal host while granting the same filesystem preopen. The final component
requires WASI filesystem, clocks, streams, CLI and randomness interfaces, plus
standardized WebAssembly exception handling for PostgreSQL error recovery.

The public interface retains `exec`, `run`, `query`, `first`, transactions,
savepoints, `rows-affected`, `close`, and `server-version`. PostgreSQL parameters
use `$1`, `$2`, etc. `server-version()` reports the bundled engine without
opening a database. Only the `template1` database is currently supported;
other `open-options.database` values are rejected. Requests must fit the engine's
input buffer; each serialized result is limited to 64 MiB and stays in memory.
Larger results return a PostgreSQL program-limit error. Signal-based statement
timeouts are unavailable in this WASI engine: nonzero `statement-timeout-ms`
options fail explicitly. Use host execution limits for runaway queries.

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
- `scripts/prepare-engine.py`: pinned engine preparation and componentization.
- `wit/deps/pglite-engine/engine.wit`: internal interface, composed away at build.

Engine provenance and modifications are described in `engine/NOTICE`.
