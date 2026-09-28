# di-framework:sqlite — SQLite WebAssembly component

A Rust WebAssembly component that bundles SQLite (amalgamation 3.53.2) and
exposes it to other components through the `di-framework:sqlite@0.1.0` WIT
package. Database files live on the WASI filesystem the host preopens for the
component (a mounted volume), using rollback journals with `synchronous=FULL`.

It exists so the QuickJS-based di-framework application component (built by
`componentize-qjs` in `@di-framework/cli-plugin-platform`) can persist actor
state, queue jobs and migration bookkeeping without a native SQLite in the JS
runtime: the JS component *imports* `di-framework:sqlite/database`, this
component *exports* it, and `wac plug` wires them into one component.

```
┌──────────────────────────────┐   di-framework:sqlite/database   ┌────────────────────────────┐
│ app.wasm (componentize-qjs)  │ ───────── import ──────────────▶ │ di-framework-sqlite.wasm   │
│  imports wasi:http, ...      │                                  │  exports database, types   │
└──────────────────────────────┘                                  │  imports wasi:filesystem,  │
                 └────────────── wac plug ────────────────────────┤          wasi:clocks, cli  │
                                    │                             └────────────────────────────┘
                                    ▼
                          composed.wasm  (only wasi:* / wasmcloud:* imports remain)
```

## Layout

```
packages/di-framework-sqlite-component/
├── Cargo.toml, Cargo.lock        pinned crates (rusqlite 0.40.2, libsqlite3-sys 0.38.2, wit-bindgen 0.61.1, cc 1.4.5)
├── rust-toolchain.toml           Rust 1.97.1 + wasm32-wasip2 (honoured by rustup)
├── .cargo/config.toml            default target + C toolchain env + SQLite compile flags
├── build.rs                      compiles csrc/wasi-vfs.c with the same wasi-sdk clang
├── csrc/wasi-vfs.c               SQLite VFS over wasi-libc (see "Persistence model")
├── wit/world.wit                 di-framework:sqlite@0.1.0
├── src/lib.rs                    the component (exports database + types)
├── scripts/
│   ├── tool-versions.env         every pinned version + SHA-256
│   ├── install-tools.sh          checksum-verified installer for wasm-tools, wac, wasi-sdk (+ optional rustup)
│   ├── env.sh                    puts .tools/ on PATH and exports build env (sourceable)
│   ├── build.sh                  cargo build + validate + stage dist/
│   ├── compose.sh                wac plug <consumer> with the provider
│   └── smoke.sh                  end-to-end test under wasmtime
├── tests/smoke-consumer/         wasip2 command component importing the interface (used by smoke.sh)
├── Makefile                      thin wrapper around the scripts
└── dist/  (generated)            di-framework-sqlite.wasm, .wit, BUILD-INFO.txt, SHA256SUMS
```

## Building

```sh
cd packages/di-framework-sqlite-component

make tools        # wasm-tools 1.258.0, wac 0.11.0, wasi-sdk 34.0 -> .tools/ (SHA-256 verified)
make tools-rust   # only if you have no rustup: hermetic rustup + Rust 1.97.1 + wasm32-wasip2 -> .tools/
make build        # -> dist/di-framework-sqlite.wasm (~1.2 MB)
make smoke        # compose with tests/smoke-consumer and run under wasmtime (needs `wasmtime` on PATH)
```

`make build` runs `scripts/build.sh`, which is:

```sh
. scripts/env.sh                                     # PATH, CC_wasm32_wasip2, LIBSQLITE3_FLAGS, RUSTFLAGS
cargo build --locked --release --target wasm32-wasip2 -p di-framework-sqlite-component
wasm-tools validate --features all dist/di-framework-sqlite.wasm
wasm-tools component wit dist/di-framework-sqlite.wasm > dist/di-framework-sqlite.wit
```

Requirements: a C compiler that targets `wasm32-wasip2` with wasi-libc headers
(the pinned wasi-sdk; Apple clang has no wasm backend), Rust 1.97.1 with the
`wasm32-wasip2` std, `wasm-tools`. `rustc` on `wasm32-wasip2` emits a component
directly (via `wasm-component-ld`), so no `wasm-tools component new` step is
needed. Builds are deterministic: `--remap-path-prefix` strips absolute paths
and `dist/SHA256SUMS` is identical across clean rebuilds on the same toolchain.

### Pinning and checksums

`scripts/tool-versions.env` is the single source of truth. `install-tools.sh`
downloads release assets from GitHub / static.rust-lang.org, compares the
SHA-256 against the pinned value **before** unpacking or executing anything,
and aborts on mismatch. Hashes are recorded for macOS (arm64, x86_64) and Linux
(x86_64, aarch64). To upgrade: bump the version, download the new assets,
`shasum -a 256`, update the file, rebuild, run `make smoke`.

Rust itself is pinned by `rust-toolchain.toml` (rustup verifies components
against the signed channel manifest). Crates are pinned with `=` in
`Cargo.toml` and locked in `Cargo.lock`; `--locked` refuses to drift.

### Environment overrides

| Variable | Meaning |
| --- | --- |
| `DF_SQLITE_TOOLS_DIR` | where `install-tools.sh` installs (default `.tools/`) |
| `WASI_SDK_PATH` | use an existing wasi-sdk instead of downloading |
| `CC_wasm32_wasip2`, `AR_wasm32_wasip2`, `CFLAGS_wasm32_wasip2` | C toolchain for `sqlite3.c` + `wasi-vfs.c` |
| `LIBSQLITE3_FLAGS` | extra `-D` flags for the amalgamation (see `.cargo/config.toml`) |

## WIT interface (`di-framework:sqlite@0.1.0`)

Full text in [`wit/world.wit`](wit/world.wit). Summary:

**`types`**
- `value`: `null | integer(s64) | real(f64) | text(string) | blob(list<u8>)`
- `row = list<tuple<string, value>>` — column name / value pairs, in column order
- `error`: `open-failed(string) | closed | invalid-sql(string) | invalid-params(string) | execution-failed(sqlite-error) | value-conversion-failed(string) | busy | invalid-transaction-state(string) | other(string)`
- `sqlite-error { code, extended-code, message }` — e.g. `19`/`1555` for a primary-key violation
- `open-options { create?, read-only?, synchronous?, journal-mode?, busy-timeout-ms?, foreign-keys? }`
- enums `sync-mode { off, normal, full }`, `journal-mode { delete, persist, memory }`, `transaction-behavior { deferred, immediate, exclusive }`

**`database`**
- `open(path, option<open-options>) -> result<connection, error>`
- `sqlite-version() -> string`
- `resource connection`
  - `exec(sql)` — multi-statement batch, no params, no results (DDL / migrations / pragmas)
  - `run(sql, params) -> u64` — one statement, returns `changes`
  - `query(sql, params) -> list<row>`
  - `first(sql, params) -> option<row>`
  - `begin(option<transaction-behavior>)` (default `immediate`), `commit()`, `rollback()`
  - `savepoint(name)`, `release-savepoint(name)`, `rollback-to-savepoint(name)` — nesting
  - `in-transaction() -> bool`, `changes() -> u64`, `last-insert-rowid() -> s64`
  - `close()`

**Worlds**: `sqlite-provider { export types; export database; }` (this component)
and `imports { import types; import database; }` (consumers).

Defaults applied by `open` when options are omitted: `journal_mode=DELETE`,
`synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`. `open` verifies the
journal mode SQLite reports matches the request and fails otherwise.

## Persistence model

- **Rollback journal, not WAL.** WAL requires shared memory and file locks; the
  WASI filesystem offers neither. `sqlite3.c` is compiled with
  `-DSQLITE_OMIT_WAL`, so `PRAGMA journal_mode=WAL` is a silent no-op and the
  connection stays on `delete`. Offered modes: `delete` (default), `persist`,
  `memory` (tests only).
- **`synchronous=FULL` by default** (`-DSQLITE_DEFAULT_SYNCHRONOUS=2` and set
  again at open). Every commit fsyncs the journal and the database through
  `wasi:filesystem/types.descriptor.sync`. `normal` is available via
  `open-options` for lower-durability workloads.
- **Single writer.** The VFS does no locking. One connection per file inside
  the component, and one component instance per file on the host — the
  wasmCloud plugin enforces `replicas: 1` for actor workloads
  (`WASMCLOUD_ACTORS_REPLICA_CONSTRAINT`).
- **Paths are guest paths inside a preopen.** The Kubernetes manifest mounts a
  PVC at `mountPath` (default `/data/actors`) and exposes the same path to the
  guest; open `/data/actors/<db>.sqlite`. Paths outside any preopen fail with
  `open-failed`.
- **No temp files.** `-DSQLITE_TEMP_STORE=3` and `-DSQLITE_STMTJRNL_SPILL=-1`
  keep temp tables, sorters and statement journals in memory.

### The VFS (`csrc/wasi-vfs.c`)

`libsqlite3-sys` ships a `wasm32-wasi-vfs` feature whose C file is a 2010-era
copy of SQLite's `demovfs.c`. It is **not** used here because:

1. its `xFileControl` returns `SQLITE_OK` for every opcode; since SQLite 3.7.x
   `PRAGMA` first asks the VFS via `SQLITE_FCNTL_PRAGMA`, and an `OK` answer
   means "handled" — so *every PRAGMA becomes a no-op* (`journal_mode`,
   `synchronous`, `user_version`, ...);
2. `xTruncate` is a no-op (unsafe for any journal mode but DELETE; VACUUM never
   shrinks the file);
3. `xRandomness` returns no entropy; `xDelete` scans past the end of its buffer.

`csrc/wasi-vfs.c` is the same public-domain design with those fixed
(`SQLITE_NOTFOUND`, `ftruncate`, `getentropy`, `pread`/`pwrite`, ms-precision
`xCurrentTimeInt64`) and is compiled by `build.rs` against
`libsqlite3-sys`'s exported `sqlite3.h`. `sqlite3.c` is built with
`-DSQLITE_OS_OTHER=1` so it calls our `sqlite3_os_init`. `make smoke` asserts
that `PRAGMA journal_mode` really returns `delete` and that no `-wal` or stale
`-journal` file is left behind.

## Consuming from the JS component

1. **WIT**: copy `wit/world.wit` to
   `cli-extensions/packages/di-framework-cli-plugin-platform/assets/wit/deps/di-framework-sqlite/package.wit`
   and add `import di-framework:sqlite/database@0.1.0;` to the generated guest
   world (`sqliteProjectRequirements()` in `src/wit.ts` does this).
2. **JS**: `componentize-qjs`/jco expose the import as an ES module:

   ```ts
   import { open } from 'di-framework:sqlite/database@0.1.0';

   const db = open('/data/actors/orders.sqlite', undefined); // options optional
   db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
   db.run('INSERT OR REPLACE INTO kv VALUES (?1, ?2)', [
     { tag: 'text', val: 'a' },
     { tag: 'text', val: JSON.stringify({ n: 1 }) },
   ]);
   const row = db.first('SELECT v FROM kv WHERE k = ?1', [{ tag: 'text', val: 'a' }]);
   // row: [['v', { tag: 'text', val: '{"n":1}' }]] | undefined

   db.begin(undefined);            // BEGIN IMMEDIATE
   try { /* ... */ db.commit(); } catch (e) { db.rollback(); throw e; }
   ```

   `result<_, error>` failures surface as thrown `ComponentError`s whose
   `payload` is the `error` variant (`{ tag: 'execution-failed', val: { code, extendedCode, message } }`).
   `integer` values are `bigint`s. A `MigrationDatabase.transaction(fn)` wrapper
   maps to `begin`/`commit`/`rollback` (or `savepoint` when already inside one).
3. **Compose** after componentize:

   ```sh
   scripts/compose.sh path/to/app.wasm path/to/app.composed.wasm  # = wac plug --plug dist/di-framework-sqlite.wasm app.wasm -o ...
   ```

   `wac plug` connects every export of the provider to the matching import of
   the app; the composed component keeps only `wasi:*`/`wasmcloud:*` imports
   for the host. `compose.sh` fails if `di-framework:sqlite/database` is still
   imported afterwards.
4. **Ship the artifact**: the plugin package build runs `make publish-asset`,
   which builds the provider from source and copies the WASM, recovered WIT,
   build metadata, and checksums into
   `cli-extensions/packages/di-framework-cli-plugin-platform/dist/assets/sqlite/`. These generated
   files ship in the npm package and are ignored by Git. No prebuilt provider is
   checked into the source tree.

### WASI version note

This component targets `wasm32-wasip2` (imports `wasi:*@0.2.9`), the only
stable Rust component target. The plugin's JS component targets WASI 0.3.0.
`wac plug` composes them fine — the composed component then imports both
`wasi:filesystem@0.2.9` (for SQLite) and the 0.3.0 interfaces (for the app) —
but the *host* must provide both. wasmtime does (p2 and p3 linkers coexist);
verify this on the wasmCloud host version you deploy to. When a stable
`wasm32-wasip3` Rust target lands, changing `RUST_TARGET` in
`scripts/tool-versions.env` and `.cargo/config.toml` is the only change needed
here.

## Verification

`make smoke` builds `tests/smoke-consumer` (a `wasip2` command component that
imports the interface), composes it with the provider using the pinned `wac`,
and runs it under `wasmtime run --dir <tmp>::/data`. It checks: pragma
defaults (`delete`/FULL/foreign keys), WAL is compiled out, DDL via `exec`,
all `value` kinds round-trip, `changes`/`last-insert-rowid`, error mapping
(constraint code 19/1555, syntax → `invalid-sql`, arity → `invalid-params`,
multi-statement → `invalid-sql`, `commit` without `begin` →
`invalid-transaction-state`), transactions, savepoints and rollback, `close`,
reopening read-only (`SQLITE_READONLY` = 8), `open-failed` for missing
directories and paths outside the preopen, `:memory:`, and finally that the
`.sqlite` file exists on the host with no `-journal`/`-wal` left over.

## Known limitations / follow-ups

- Synchronous interface (no `async func`/streams); fine for the small result
  sets the framework issues, and matches `bun:sqlite`-style drivers.
- `row` repeats column names per row; switch to a `{columns, rows}` record if
  large result sets ever matter.
- No prepared-statement cache across calls (each `run`/`query` prepares once).
- `wasmtime` used by `make smoke` is not pinned by this package.
