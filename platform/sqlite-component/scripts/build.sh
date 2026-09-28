#!/usr/bin/env bash
# Build the di-framework:sqlite component and stage release artifacts in dist/.
#
#   scripts/build.sh            # release build -> dist/di-framework-sqlite.wasm
#   scripts/build.sh --debug    # debug build (larger, with panic messages)
#
# Produces:
#   dist/di-framework-sqlite.wasm   the component (exports di-framework:sqlite/database@0.1.0)
#   dist/di-framework-sqlite.wit    WIT as recovered from the binary (wasm-tools component wit)
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
[ -n "${CC_wasm32_wasip2:-}" ] && [ -x "$CC_wasm32_wasip2" ] \
  || die "wasi-sdk clang not found. Run scripts/install-tools.sh (or set WASI_SDK_PATH)"
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
    && [ -d "$(rustc --print target-libdir --target "$RUST_TARGET")" ] \
    || die "rust-std for $RUST_TARGET is not installed and rustup is unavailable; run scripts/install-tools.sh --rust"
fi

log "rustc:      $(rustc --version)"
log "clang:      $("$CC_wasm32_wasip2" --version | head -n1)"
log "wasm-tools: $(wasm-tools --version)"
log "profile:    $PROFILE"

# --- build ----------------------------------------------------------------------
cargo build --locked --profile "$PROFILE" --target "$RUST_TARGET" -p di-framework-sqlite-component

WASM_IN="target/$RUST_TARGET/$PROFILE_DIR/di_framework_sqlite.wasm"
[ -f "$WASM_IN" ] || die "expected output missing: $WASM_IN"

# --- validate + stage ---------------------------------------------------------
mkdir -p dist
WASM_OUT="dist/di-framework-sqlite.wasm"
cp "$WASM_IN" "$WASM_OUT"

wasm-tools validate --features all "$WASM_OUT"
wasm-tools component wit "$WASM_OUT" > dist/di-framework-sqlite.wit

grep -q 'export di-framework:sqlite/database@0.1.0' dist/di-framework-sqlite.wit \
  || die "component does not export di-framework:sqlite/database@0.1.0 (see dist/di-framework-sqlite.wit)"

{
  echo "component:       di-framework:sqlite@0.1.0"
  echo "profile:         $PROFILE"
  echo "built:           $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "rustc:           $(rustc --version)"
  echo "target:          $RUST_TARGET"
  echo "wasi-sdk:        $(head -n1 "${WASI_SDK_PATH:-/nonexistent}/VERSION" 2>/dev/null || echo "external ($CC_wasm32_wasip2)")"
  echo "wasm-tools:      $(wasm-tools --version)"
  echo "rusqlite:        $RUSQLITE_VERSION"
  echo "libsqlite3-sys:  $LIBSQLITE3_SYS_VERSION (SQLite $SQLITE_AMALGAMATION_VERSION)"
  echo "wit-bindgen:     $WIT_BINDGEN_VERSION"
  echo "LIBSQLITE3_FLAGS: $LIBSQLITE3_FLAGS"
  echo "CFLAGS_wasm32_wasip2: $CFLAGS_wasm32_wasip2"
  echo "size:            $(wc -c < "$WASM_OUT" | tr -d ' ') bytes"
} > dist/BUILD-INFO.txt

(cd dist && shasum -a 256 di-framework-sqlite.wasm di-framework-sqlite.wit > SHA256SUMS)

log "ok: $WASM_OUT ($(wc -c < "$WASM_OUT" | tr -d ' ') bytes)"
log "imports/exports:"
wasm-tools component wit "$WASM_OUT" | sed -n '/^world root/,/^}/p' >&2
