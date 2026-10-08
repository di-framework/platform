# di-framework:pglite — Postgres wire-protocol provider component

A Rust WebAssembly component that exposes Postgres-compatible databases to
other components through the `di-framework:pglite@0.1.0` WIT package. It owns
connections and configuration — speaking pgwire (startup handshake with
cleartext/MD5 auth, simple protocol for `exec`, extended protocol for
parameterized `run`/`query`/`first`) over `wasi:sockets` TCP with a
poll-driven blocking shim, no async runtime.

It mirrors `di-framework:sqlite@0.1.0` on purpose (same `value`/`row`/`error`
shapes plus `boolean`, same connection lifecycle) so consumers switch between
the SQLite and PGlite providers with minimal code changes. Differences from
SQLite: parameters bind to `$1`, `$2`, … (not `?`); `open` takes a connection
target (`""` for provider defaults, or `host:port[/database]`); `busy` is
replaced by `connection-lost`; version is `server-version()`.

```
┌──────────────────────────────┐   di-framework:pglite/database   ┌────────────────────────────┐
│ app.wasm (guest)             │ ───────── import ──────────────▶ │ di-framework-pglite.wasm   │
│  imports pglite/database     │                                  │  exports database, types   │
└──────────────────────────────┘                                  │  imports wasi:sockets, cli │
                 └────────────── wac plug ────────────────────────┤   (TCP pgwire to server)   │
                                    │                             └────────────────────────────┘
                                    ▼
                          composed.wasm                                        ╲
                                                               pgwire ════════▶ Postgres
                                                          (PGlite sidecar in dev,
                                                           managed Postgres in prod)
```

The provider holds no database engine itself: in dev it dials the native
PGlite sidecar on a host-reachable address (a `wash dev` guest has isolated
loopback, so the sidecar binds `0.0.0.0` and `PGHOST` is the host LAN IP); in
prod it dials any Postgres-compatible endpoint.

## Layout

```
platform/pglite-component/
├── Cargo.toml, Cargo.lock        pinned crates (wit-bindgen 0.61.1, md5 0.7.0)
├── rust-toolchain.toml           Rust 1.97.1 + wasm32-wasip2 (honoured by rustup)
├── wit/world.wit                 di-framework:pglite@0.1.0 (+ deps/ for wasi 0.2.0)
├── src/{lib,config,pgwire,sock}.rs   the component (exports database + types)
├── scripts/
│   ├── tool-versions.env         every pinned version + SHA-256 (tracks sqlite-component)
│   ├── install-tools.sh          checksum-verified installer for wasm-tools, wac (+ optional rustup)
│   ├── env.sh                    puts .tools/ on PATH (sourceable)
│   ├── build.sh                  cargo build + validate + stage dist/
│   ├── compose.sh                wac plug <consumer> with the provider
│   ├── smoke.sh                  compose with tests/smoke-consumer, run under wasmtime
│   └── fake-pgwire.py            scripted pgwire server for smoke.sh (no Postgres needed)
├── tests/smoke-consumer/         wasip2 command component importing the interface (used by smoke.sh)
├── Makefile                      thin wrapper around the scripts
└── dist/  (generated)            di-framework-pglite.wasm, .wit, BUILD-INFO.txt, SHA256SUMS
```

## Building

```sh
cd platform/pglite-component

make tools        # wasm-tools 1.258.0, wac 0.11.0 -> .tools/ (SHA-256 verified)
make tools-rust   # only if you have no rustup: hermetic rustup + Rust 1.97.1 + wasm32-wasip2 -> .tools/
make build        # -> dist/di-framework-pglite.wasm
make smoke        # compose + run against the scripted server (needs `wasmtime`, `python3` on PATH)
bun test          # package checks (dist artifacts + WIT surface)
```

No wasi-sdk is needed (unlike the sqlite provider): this crate is pure Rust.

## Configuration

Only the provider reads these (from `wasi:cli/environment`); the guest
passes `""` to `open` to select the provider's configured default, or
`host:port[/database]` to override the target. `open-options.database`
overrides the database name per connection.

| Variable     | Default       |
| ------------ | ------------- |
| `PGHOST`     | `127.0.0.1`   |
| `PGPORT`     | `5432`        |
| `PGUSER`     | `postgres`    |
| `PGPASSWORD` | `password`    |
| `PGDATABASE` | `template1`   |

## Testing

* `cargo test -p di-framework-pglite-component`: unit tests for target
  parsing (`config.rs`), `CommandComplete` tag counts, SQLSTATE→error
  mapping, and OID→`value` decoding (`pgwire.rs`). No server needed.
* `make smoke`: full handshake + query flow through `scripts/fake-pgwire.py`,
  which splits replies across writes — covering the partial-read path
  (`fill()` must request only what is missing, never a fixed-size chunk).
* Live verification (PGlite sidecar / real Postgres) stays in the app's
  `wash dev` loop: `POST /task` → guest WIT import → provider pgwire query.

## Relationship to sqlite-component

Tool versions (`wasm-tools`, `wac`, Rust) are deliberately pinned in lockstep
with `../sqlite-component/scripts/tool-versions.env`. The next integration
step (not in this scaffold) is the CLI half: `DI_PGLITE_*` requirements in
`@di-framework/cli-plugin-platform` (`wit.ts`/`build.ts`, mirroring
`composeSqliteProvider`) plus a `Pglite` binding class in `@di-framework/bindings`.
