#!/usr/bin/env bash
# Compose a real consumer with the embedded engine; no listener or network grant.
# Check SQL semantics, then restart against the same filesystem, including a
# runtime exit with an uncommitted transaction. Never use a deployment data dir.
set -euo pipefail
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PKG_DIR"
. "$PKG_DIR/scripts/env.sh"
command -v wasmtime >/dev/null
cargo build --locked --release --target "$RUST_TARGET" -p pglite-smoke-consumer
mkdir -p target/smoke
COMPOSED=target/smoke/composed.wasm
scripts/compose.sh "target/$RUST_TARGET/release/pglite-smoke-consumer.wasm" "$COMPOSED"
wasm-tools component wit "$COMPOSED" > target/smoke/composed.wit
if grep -Eq 'import (wasi:sockets|di-framework:pglite)' target/smoke/composed.wit; then
  echo 'unexpected socket or unresolved database/engine import' >&2
  exit 1
fi
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/df-pglite-smoke.XXXXXX")"
trap 'rm -rf "$DATA_DIR"' EXIT
run() {
  local mode="$1" marker="$2"
  shift 2
  if ! wasmtime run "$@" --env "PGLITE_SMOKE_MODE=$mode" "$COMPOSED" > "target/smoke/$mode.log" 2>&1; then
    tail -80 "target/smoke/$mode.log" >&2
    exit 1
  fi
  grep -q "^$marker$" "target/smoke/$mode.log"
  echo "[smoke] $marker"
}
run no-mount 'no mount ok'
run write 'smoke ok' --dir "$DATA_DIR::/data"
[[ -s "$DATA_DIR/pglite/data/PG_VERSION" ]]
[[ -s "$DATA_DIR/pglite/data/global/pg_control" ]]
run read 'restart ok' --dir "$DATA_DIR::/data"
run abrupt 'abrupt ok' --dir "$DATA_DIR::/data"
run read 'restart ok' --dir "$DATA_DIR::/data"
echo '[smoke] persistent embedded PGlite passed without networking'
