#!/usr/bin/env bash
# Build the tenant OCI registry component and stage release artifacts in dist/.
#
#   scripts/build.sh            # release build -> dist/di-framework-oci-registry.wasm
#   scripts/build.sh --debug    # debug build
#
# Produces:
#   dist/di-framework-oci-registry.wasm  the component (exports wasi:http/handler@0.3.0)
#   dist/di-framework-oci-registry.wit   WIT recovered from the binary
#   dist/BUILD-INFO.txt                  toolchain versions and upstream source
#   dist/SHA256SUMS                      checksums of the above
#
# Needs cargo (rustup honours rust-toolchain.toml) and wasm-tools on PATH; CI
# gets wasm-tools from platform/sqlite-component/scripts/install-tools.sh.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PKG_DIR"

RUST_TARGET=wasm32-wasip2
UPSTREAM_COMMIT=ee52f49e88e1f9fe4cf001bd232e0bbc6b52bcb3
PROFILE=release
PROFILE_DIR=release
for arg in "$@"; do
  case "$arg" in
    --debug) PROFILE=dev; PROFILE_DIR=debug ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[build] %s\n' "$*" >&2; }
die() { printf '[build] error: %s\n' "$*" >&2; exit 1; }

# Prefer rustup's proxies over a standalone toolchain so rust-toolchain.toml applies.
if [ -d "${CARGO_HOME:-$HOME/.cargo}/bin" ]; then
  export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
fi
command -v cargo >/dev/null 2>&1 || die "cargo not found. Install rustup (https://rustup.rs)"
command -v wasm-tools >/dev/null 2>&1 || die "wasm-tools not found. Run platform/sqlite-component/scripts/install-tools.sh"

log "rustc:      $(rustc --version)"
log "wasm-tools: $(wasm-tools --version)"
log "profile:    $PROFILE"

cargo build --locked --profile "$PROFILE" --target "$RUST_TARGET"

WASM_IN="target/$RUST_TARGET/$PROFILE_DIR/oci_registry.wasm"
[ -f "$WASM_IN" ] || die "expected output missing: $WASM_IN"

mkdir -p dist
WASM_OUT="dist/di-framework-oci-registry.wasm"
cp "$WASM_IN" "$WASM_OUT"
wasm-tools validate --features all "$WASM_OUT"
wasm-tools component wit "$WASM_OUT" > dist/di-framework-oci-registry.wit

for line in 'export wasi:http/handler@0.3.0' 'import wasi:http/client@0.3.0' 'import wasmcloud:blobstore/container@0.1.0'; do
  grep -q "$line" dist/di-framework-oci-registry.wit || die "built WIT lacks '$line'"
done

{
  echo "component:       di-framework tenant OCI registry"
  echo "upstream:        wasmCloud/wasmCloud examples/oci-registry @ $UPSTREAM_COMMIT"
  echo "profile:         $PROFILE"
  echo "built:           $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "rustc:           $(rustc --version)"
  echo "target:          $RUST_TARGET"
  echo "wasm-tools:      $(wasm-tools --version)"
} > dist/BUILD-INFO.txt

(cd dist && shasum -a 256 di-framework-oci-registry.wasm di-framework-oci-registry.wit BUILD-INFO.txt > SHA256SUMS)
log "ok $(head -n1 dist/SHA256SUMS)"
