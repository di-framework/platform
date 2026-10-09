#!/usr/bin/env bash
# Build the di-framework:pglite component and stage release artifacts in dist/.
#
#   scripts/build.sh            # release build -> dist/di-framework-pglite.wasm
#   scripts/build.sh --debug    # debug build (larger, with panic messages)
#
# Produces:
#   dist/di-framework-pglite.wasm   the component (exports di-framework:pglite/database@0.1.0)
#   dist/di-framework-pglite.wit    WIT as recovered from the binary (wasm-tools component wit)
#   dist/BUILD-INFO.txt             toolchain versions used
#   dist/SHA256SUMS                 checksums of the above
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PKG_DIR"
# shellcheck source=env.sh
. "$PKG_DIR/scripts/env.sh"

PROFILE=release
PROFILE_DIR=release
for arg in "$@"; do
  case "$arg" in
    --debug) PROFILE=dev; PROFILE_DIR=debug ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[build] %s\n' "$*" >&2; }
die() { printf '[build] error: %s\n' "$*" >&2; exit 1; }

# --- preflight ------------------------------------------------------------------
command -v cargo >/dev/null 2>&1 || die "cargo not found. Install rustup (https://rustup.rs) or run: scripts/install-tools.sh --rust"
command -v python3 >/dev/null || die "python3 is required to prepare the engine"
command -v wac >/dev/null || die "wac is required; run scripts/install-tools.sh"
command -v wasm-tools >/dev/null 2>&1 || die "wasm-tools not found. Run scripts/install-tools.sh"

if command -v rustup >/dev/null 2>&1; then
  # rust-toolchain.toml selects the channel; make sure the target exists.
  if ! rustup target list --installed --toolchain "$RUST_TOOLCHAIN" 2>/dev/null | grep -qx "$RUST_TARGET"; then
    log "installing $RUST_TARGET for $RUST_TOOLCHAIN via rustup"
    rustup target add "$RUST_TARGET" --toolchain "$RUST_TOOLCHAIN"
  fi
else
  # Plain rustc without rustup: rust-toolchain.toml is ignored; check versions by hand.
  rustc --version | grep -q "rustc $RUST_TOOLCHAIN" || log "warning: rustc is not $RUST_TOOLCHAIN ($(rustc --version)); artifact will differ from the pinned build"
  rustc --print target-libdir --target "$RUST_TARGET" >/dev/null 2>&1 \
    && [[ -d "$(rustc --print target-libdir --target "$RUST_TARGET")" ]] \
    || die "rust-std for $RUST_TARGET is not installed and rustup is unavailable; run scripts/install-tools.sh --rust"
fi

log "rustc:      $(rustc --version)"
log "wasm-tools: $(wasm-tools --version)"
log "profile:    $PROFILE"

# --- build ----------------------------------------------------------------------
python3 scripts/prepare-engine.py
cargo build --locked --profile "$PROFILE" --target "$RUST_TARGET" -p di-framework-pglite-component

WASM_IN="target/$RUST_TARGET/$PROFILE_DIR/pglite_provider.wasm"
[[ -f "$WASM_IN" ]] || die "expected output missing: $WASM_IN"

# --- validate + stage ---------------------------------------------------------
mkdir -p dist
WASM_OUT="dist/di-framework-pglite.wasm"
wac plug --plug target/engine/engine.wasm "$WASM_IN" -o "$WASM_OUT"

wasm-tools validate --features all "$WASM_OUT"
wasm-tools component wit "$WASM_OUT" > dist/di-framework-pglite.wit

grep -q 'export di-framework:pglite/database@0.1.0' dist/di-framework-pglite.wit \
  || die "component does not export di-framework:pglite/database@0.1.0 (see dist/di-framework-pglite.wit)"

if grep -Eq 'import (wasi:sockets|di-framework:pglite-engine)' dist/di-framework-pglite.wit; then
  die "unexpected socket or unresolved engine import in bundled provider"
fi
cat engine/NOTICE engine/POSTGRESQL-COPYRIGHT engine/PGLITE-BINDINGS-LICENSE engine/WASMTIME-LICENSE > dist/THIRD-PARTY-NOTICES.txt

{
  echo "component:       di-framework:pglite@0.1.0"
  echo "profile:         $PROFILE"
  echo "built:           $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "rustc:           $(rustc --version)"
  echo "target:          $RUST_TARGET"
  echo "wasm-tools:      $(wasm-tools --version)"
  echo "wit-bindgen:     $WIT_BINDGEN_VERSION"
  echo "md5:             $MD5_VERSION"
  echo "engine:          PostgreSQL 17.5, persistent WASI filesystem"
  echo "engine-source:   https://github.com/moznion/wasipg/tree/$PGLITE_SOURCE_REF"
  echo "adapter-sha256:  $PGLITE_ADAPTER_SHA256"
  echo "engine-sha256:   $(shasum -a 256 target/engine/engine.core.wasm | cut -d' ' -f1)"
  echo "size:            $(wc -c < "$WASM_OUT" | tr -d ' ') bytes"
} > dist/BUILD-INFO.txt

(cd dist && shasum -a 256 di-framework-pglite.wasm di-framework-pglite.wit THIRD-PARTY-NOTICES.txt > SHA256SUMS)

log "ok: $WASM_OUT ($(wc -c < "$WASM_OUT" | tr -d ' ') bytes)"
log "imports/exports:"
wasm-tools component wit "$WASM_OUT" | sed -n '/^world root/,/^}/p' >&2
