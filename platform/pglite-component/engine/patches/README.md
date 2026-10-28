# Engine source patches

`postgresql-17.11-wasi.patch` turns upstream PostgreSQL into the WASI engine source. It is ElectricSQL's PGlite WASI port (the `postgres-pglite` branch `REL_17_5_WASM-pglite`) replayed onto upstream `REL_17_11`.

| | |
|---|---|
| Base | [postgres/postgres](https://github.com/postgres/postgres) tag `REL_17_11`, commit `083ac033419f690758508e08c1736089384bbee8` (pinned in `scripts/tool-versions.env`) |
| Changes | [electric-sql/postgres-pglite](https://github.com/electric-sql/postgres-pglite) merge base `5e2f3df4` (upstream `REL_17_5`) → `REL_17_5_WASM-pglite` (`2194acf3`) |
| Size | 118 files: 79 modified, 39 added (`wasm-build.sh`, `wasm-build/`, `pglite-wasm/`, `src/template/wasi`, …). No binary files. |

Why: Electric's newer branches (`REL_17_7_pglite`, `REL_18_*-pglite`) are Emscripten-only and dropped the WASI build, and no WASI branch exists past 17.5. Replaying the 17.5 WASI changes onto the upstream release keeps every PostgreSQL 17 security fix (#383). PostgreSQL 18 is tracked in #401.

## How the build uses it

`scripts/build-engine.ts` (`prepareEngineTree`) builds the tree from scratch for every engine source build:

1. Shallow-fetch `POSTGRES_SOURCE_TAG` from `POSTGRES_SOURCE_REPO` and refuse it unless it resolves to `POSTGRES_SOURCE_COMMIT`.
2. `git apply` this patch.
3. `git apply` the pinned wasipg recipe's `build/patches/*.patch` (sjlj error recovery), in name order.
4. Run `scripts/patch-engine-source.ts` from the recipe's `build.sh`: the reply buffer, session defaults, pgcrypto wiring, the bounded dlopen table and two glue fixes for 17.11 (`SplitGUCList`, `pg_malloc_mul`/`pg_realloc_mul`).

Each `git apply` runs `--check` first. A patch that no longer applies stops the build with a message naming the patch and the base, followed by git's own output.

`make check-engine-patch` runs steps 1–4 (and the pgcrypto source edits) without the container build. It takes about 30 seconds.

## Bumping the PostgreSQL 17 release

1. Set `POSTGRES_SOURCE_TAG` and `POSTGRES_SOURCE_COMMIT` in `scripts/tool-versions.env`. The tag must point at the commit; use `git ls-remote https://github.com/postgres/postgres.git refs/tags/REL_17_<n>`.
2. Run `make check-engine-patch`. If it passes, the patch still applies. Rename the file and the version strings only if you want the new number in them.
3. If it fails, regenerate the patch with a three-way replay of Electric's original diff:

   ```sh
   git clone --filter=blob:none https://github.com/postgres/postgres.git pg && cd pg
   git fetch https://github.com/electric-sql/postgres-pglite 2194acf356e9b7bf7cff29c4ed4bd6b82b93895d
   git diff --binary REL_17_5 FETCH_HEAD > /tmp/electric-wasi-17.5.diff
   git switch --detach REL_17_<n>
   git apply --3way --whitespace=nowarn /tmp/electric-wasi-17.5.diff   # resolve any conflicts
   git add -A && git diff --cached REL_17_<n> > ../postgresql-17.<n>-wasi.patch
   ```

   Keep the header block of the existing file, and update `ENGINE_SOURCE_PATCH` in `scripts/build-engine.ts`.
4. Run `make smoke` and `make reproducible`. Upstream security fixes can break the WASI glue without a textual conflict: 17.10 and 17.11 needed the two glue fixes in `patch-engine-source.ts`. Only a full build shows that.

## License

This patch is a diff against PostgreSQL and `postgres-pglite` source. It is governed by the PostgreSQL License (`../POSTGRESQL-COPYRIGHT`), not by this repository's MIT / Apache-2.0 grant:

    Portions Copyright (c) 1996-2026, PostgreSQL Global Development Group
    Portions Copyright (c) 1994, The Regents of the University of California
