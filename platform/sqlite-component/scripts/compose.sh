#!/usr/bin/env bash
# Compose a consumer component (typically the componentize-qjs output of a
# di-framework app) with the SQLite provider using the pinned `wac`.
#
#   scripts/compose.sh <app.wasm> <out.wasm> [provider.wasm]
#
# The consumer must *import* `di-framework:sqlite/database@0.1.0`; the provider
# (default dist/di-framework-sqlite.wasm) exports it. `wac plug` wires the
# export into the import and leaves every other import (wasi:*, wasmcloud:*)
# on the composed component for the host to satisfy.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=env.sh
. "$PKG_DIR/scripts/env.sh"

[ $# -ge 2 ] || { sed -n '2,11p' "$0"; exit 2; }
APP="$1"; OUT="$2"; PROVIDER="${3:-$PKG_DIR/dist/di-framework-sqlite.wasm}"

command -v wac >/dev/null 2>&1 || { echo "wac not found; run scripts/install-tools.sh" >&2; exit 1; }
command -v wasm-tools >/dev/null 2>&1 || { echo "wasm-tools not found; run scripts/install-tools.sh" >&2; exit 1; }
[ -f "$APP" ] || { echo "consumer component not found: $APP" >&2; exit 1; }
[ -f "$PROVIDER" ] || { echo "provider component not found: $PROVIDER (run make build)" >&2; exit 1; }

wac --version >&2
wac plug --plug "$PROVIDER" "$APP" -o "$OUT"
wasm-tools validate --features all "$OUT"

if wasm-tools component wit "$OUT" | grep -q 'import di-framework:sqlite/database@0.1.0'; then
  echo "[compose] error: $OUT still imports di-framework:sqlite/database@0.1.0; plug did not apply" >&2
  exit 1
fi
echo "[compose] ok: $OUT" >&2
wasm-tools component wit "$OUT" | sed -n '/^world root/,/^}/p' >&2
