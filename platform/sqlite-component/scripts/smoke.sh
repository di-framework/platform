#!/usr/bin/env bash
# End-to-end smoke test:
#   1. build tests/smoke-consumer (a wasip2 command component that *imports*
#      di-framework:sqlite/database@0.1.0),
#   2. compose it with dist/di-framework-sqlite.wasm using the pinned wac,
#   3. run the result under wasmtime with a host directory preopened at /data
#      (the same shape as the wasmCloud volume mount), and
#   4. assert the database file survived on the host side.
#
# Requires `wasmtime` on PATH (not pinned by this package; any 30+ release
# that speaks wasi@0.2.x works). Everything else comes from scripts/env.sh.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PKG_DIR"
# shellcheck source=env.sh
. "$PKG_DIR/scripts/env.sh"

log() { printf '[smoke] %s\n' "$*" >&2; }
die() { printf '[smoke] error: %s\n' "$*" >&2; exit 1; }

command -v wasmtime >/dev/null 2>&1 || die "wasmtime not found on PATH (brew install wasmtime / https://wasmtime.dev)"
[ -f dist/di-framework-sqlite.wasm ] || die "dist/di-framework-sqlite.wasm missing; run scripts/build.sh first"

log "building smoke consumer"
cargo build --locked --release --target "$RUST_TARGET" -p sqlite-smoke-consumer
CONSUMER="target/$RUST_TARGET/release/sqlite-smoke-consumer.wasm"

wasm-tools component wit "$CONSUMER" | grep -q 'import di-framework:sqlite/database@0.1.0' \
  || die "consumer does not import di-framework:sqlite/database@0.1.0"

mkdir -p target/smoke
COMPOSED="target/smoke/composed.wasm"
scripts/compose.sh "$CONSUMER" "$COMPOSED" dist/di-framework-sqlite.wasm

DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/df-sqlite-smoke.XXXXXX")"
trap 'rm -rf "$DATA_DIR"' EXIT
log "running under wasmtime with $DATA_DIR preopened as /data"
wasmtime run --dir "$DATA_DIR::/data" "$COMPOSED"

[ -s "$DATA_DIR/smoke.sqlite" ] || die "smoke.sqlite was not persisted to the host directory"
[ ! -e "$DATA_DIR/smoke.sqlite-journal" ] || die "stale rollback journal left behind"
[ ! -e "$DATA_DIR/smoke.sqlite-wal" ] || die "a WAL file appeared; WAL must be compiled out"
head -c 16 "$DATA_DIR/smoke.sqlite" | grep -q 'SQLite format 3' || die "smoke.sqlite is not a SQLite database"
log "ok: $(wc -c < "$DATA_DIR/smoke.sqlite" | tr -d ' ') byte database persisted through the WASI preopen"
