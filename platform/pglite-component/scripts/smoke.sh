#!/usr/bin/env bash
# End-to-end smoke test:
#   1. build tests/smoke-consumer (a wasip2 command component that *imports*
#      di-framework:pglite/database@0.1.0),
#   2. compose it with dist/di-framework-pglite.wasm using the pinned wac,
#   3. start the scripted pgwire server (scripts/fake-pgwire.py) on 127.0.0.1,
#   4. run the composed component under wasmtime with PGHOST/PGPORT/…
#      pointing at the fake, and assert it prints `smoke ok`.
#
# The fake answers the startup handshake plus just enough of the simple and
# extended protocols for the consumer's flow (SHOW server_version, DDL,
# INSERT … RETURNING, SELECT, UPDATE, transactions, one InvalidSql). It sends
# replies split across writes, so this also covers the provider's partial-read
# path (the `fill()` regression: reads must request only what is missing,
# never a fixed-size chunk). Requires `wasmtime` and `python3` on PATH
# (neither is pinned by this package).
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PKG_DIR"
# shellcheck source=env.sh
. "$PKG_DIR/scripts/env.sh"

log() { printf '[smoke] %s\n' "$*" >&2; }
die() { printf '[smoke] error: %s\n' "$*" >&2; exit 1; }

command -v wasmtime >/dev/null 2>&1 || die "wasmtime not found on PATH (brew install wasmtime / https://wasmtime.dev)"
command -v python3 >/dev/null 2>&1 || die "python3 not found on PATH"
[ -f dist/di-framework-pglite.wasm ] || die "dist/di-framework-pglite.wasm missing; run scripts/build.sh first"

log "building smoke consumer"
cargo build --locked --release --target "$RUST_TARGET" -p pglite-smoke-consumer
CONSUMER="target/$RUST_TARGET/release/pglite-smoke-consumer.wasm"

wasm-tools component wit "$CONSUMER" | grep -q 'import di-framework:pglite/database@0.1.0' \
  || die "consumer does not import di-framework:pglite/database@0.1.0"

mkdir -p target/smoke
COMPOSED="target/smoke/composed.wasm"
scripts/compose.sh "$CONSUMER" "$COMPOSED" dist/di-framework-pglite.wasm

PORT_FILE="$(mktemp "${TMPDIR:-/tmp}/df-pglite-smoke-port.XXXXXX")"
trap 'rm -f "$PORT_FILE"' EXIT
python3 scripts/fake-pgwire.py --port-file "$PORT_FILE" &
FAKE_PID=$!
# shellcheck disable=SC2064
trap "kill $FAKE_PID 2>/dev/null; rm -f '$PORT_FILE'" EXIT

PGPORT=""
for _ in $(seq 1 100); do
  if [ -s "$PORT_FILE" ]; then PGPORT="$(cat "$PORT_FILE")"; break; fi
  sleep 0.05
done
[ -n "$PGPORT" ] || die "fake pgwire server did not report a port"

log "running under wasmtime against fake pgwire on 127.0.0.1:$PGPORT"
# `-S inherit-network=y`: wasmtime denies guest TCP by default; the provider
# needs the host network to dial the (fake) pgwire server.
wasmtime run \
  -S inherit-network=y \
  --env "PGHOST=127.0.0.1" \
  --env "PGPORT=$PGPORT" \
  --env "PGUSER=postgres" \
  --env "PGPASSWORD=secretpw123" \
  --env "PGDATABASE=template1" \
  "$COMPOSED" > target/smoke/output.txt 2>&1 || {
    cat target/smoke/output.txt >&2
    die "composed component failed (output above)"
  }
cat target/smoke/output.txt >&2
grep -q '^smoke ok$' target/smoke/output.txt || die "missing 'smoke ok' in output"
log "ok: provider handshake + query flow passed through the scripted server"
