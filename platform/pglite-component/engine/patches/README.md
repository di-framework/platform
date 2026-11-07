# Engine source patches

`postgresql-18.6-wasi.patch` turns upstream PostgreSQL into the WASI engine source. It is ElectricSQL's PGlite WASI port (the `postgres-pglite` branch `REL_17_5_WASM-pglite`) replayed onto upstream `REL_18_6` (#401).

| | |
|---|---|
| Base | [postgres/postgres](https://github.com/postgres/postgres) tag `REL_18_6`, commit `724edf9bde9d356724ad384a2e196edc3c9f80f7` (pinned in `scripts/tool-versions.env`) |
| Changes | [electric-sql/postgres-pglite](https://github.com/electric-sql/postgres-pglite) merge base `5e2f3df4` (upstream `REL_17_5`) → `REL_17_5_WASM-pglite` (`2194acf3`), adapted for PostgreSQL 18 (`InitializeWaitEventSupport`, `IOMETHOD_SYNC` default, single-user child slots / fast-path locks / no-op `set_max_safe_fds`, `ShutdownXLOG` `before_shmem_exit` index 5 after `pgaio_init_backend`, variable-length cancel keys, `PG_MODULE_MAGIC_EXT`, `setrlimit`, `parse_dispatch_option`, bootstrap checksums) |
| Size | 119 files: 80 modified, 39 added (`wasm-build.sh`, `wasm-build/`, `pglite-wasm/`, `src/template/wasi`, …). No binary files. |

Why: Electric's newer branches (`REL_17_7_pglite`, `REL_18_*-pglite`) are Emscripten-only and dropped the WASI build, and no WASI branch exists past 17.5. Replaying the 17.5 WASI changes onto the upstream release keeps every PostgreSQL 18 security fix (#383, #401).

## How the build uses it

`scripts/build-engine.ts` (`prepareEngineTree`) builds the tree from scratch for every engine source build:

1. Shallow-fetch `POSTGRES_SOURCE_TAG` from `POSTGRES_SOURCE_REPO` and refuse it unless it resolves to `POSTGRES_SOURCE_COMMIT`.
2. `git apply` this patch.
3. `git apply` the pinned wasipg recipe's `build/patches/*.patch` (sjlj error recovery), in name order.
4. Run `scripts/patch-engine-source.ts` from the recipe's `build.sh`: the reply buffer, session defaults, pgcrypto wiring, the bounded dlopen table and two glue fixes (`SplitGUCList`, `pg_malloc_mul`/`pg_realloc_mul`).

Each `git apply` runs `--check` first. A patch that no longer applies stops the build with a message naming the patch and the base, followed by git's own output.

`make check-engine-patch` runs steps 1–4 (and the pgcrypto source edits) without the container build. It takes about 30 seconds.

## Bumping the PostgreSQL 18 release

1. Set `POSTGRES_SOURCE_TAG` and `POSTGRES_SOURCE_COMMIT` in `scripts/tool-versions.env`. The tag must point at the commit; use `git ls-remote https://github.com/postgres/postgres.git refs/tags/REL_18_<n>`.
2. Run `make check-engine-patch`. If it passes, the patch still applies. Rename the file and the version strings only if you want the new number in them.
3. If it fails, regenerate the patch with a three-way replay against the previous patch:

   ```sh
   git clone --filter=blob:none https://github.com/postgres/postgres.git pg && cd pg
   git switch --detach REL_18_<n>
   git apply --3way --whitespace=nowarn ../postgresql-18.6-wasi.patch   # resolve any conflicts
   git add -A && git diff --cached REL_18_<n> > ../postgresql-18.<n>-wasi.patch
   ```

   Keep the header block of the existing file, and update `ENGINE_SOURCE_PATCH` in `scripts/build-engine.ts`.
4. Run `make smoke` and `make reproducible`. Upstream security fixes can break the WASI glue without a textual conflict. Only a full build shows that.

## License

This patch is a diff against PostgreSQL and `postgres-pglite` source. It is governed by the PostgreSQL License (`../POSTGRESQL-COPYRIGHT`), not by this repository's MIT / Apache-2.0 grant:

    Portions Copyright (c) 1996-2026, PostgreSQL Global Development Group
    Portions Copyright (c) 1994, The Regents of the University of California
