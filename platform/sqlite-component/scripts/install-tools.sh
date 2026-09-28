#!/usr/bin/env bash
# Install the pinned, checksum-verified toolchain for the di-framework:sqlite
# component into a local tools directory (default: <package>/.tools).
#
#   scripts/install-tools.sh            # wasm-tools + wac + wasi-sdk
#   scripts/install-tools.sh --wac-only # composition only (uses the prebuilt provider)
#   scripts/install-tools.sh --rust     # ...plus a hermetic rustup toolchain
#                                       # (only needed when `rustup` is absent)
#
# Environment:
#   DF_SQLITE_TOOLS_DIR   where to install (default <package>/.tools)
#   WASI_SDK_PATH         if set and it contains bin/clang, wasi-sdk is not downloaded
#
# Every download is verified against scripts/tool-versions.env before use.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tool-versions.env
. "$PKG_DIR/scripts/tool-versions.env"

TOOLS_DIR="${DF_SQLITE_TOOLS_DIR:-$PKG_DIR/.tools}"
BIN_DIR="$TOOLS_DIR/bin"
CACHE_DIR="$TOOLS_DIR/cache"
WITH_RUST=0
WAC_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --rust) WITH_RUST=1 ;;
    --wac-only) WAC_ONLY=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$BIN_DIR" "$CACHE_DIR"

log() { printf '[install-tools] %s\n' "$*" >&2; }
die() { printf '[install-tools] error: %s\n' "$*" >&2; exit 1; }

# --- platform detection -----------------------------------------------------
uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s" in
  Darwin) os=macos ;;
  Linux)  os=linux ;;
  *) die "unsupported OS: $uname_s" ;;
esac
case "$uname_m" in
  arm64|aarch64) arch=aarch64; wasi_arch=arm64 ;;
  x86_64|amd64)  arch=x86_64;  wasi_arch=x86_64 ;;
  *) die "unsupported architecture: $uname_m" ;;
esac
case "$os" in
  macos) rust_triple="${arch}-apple-darwin"; wac_triple="${arch}-apple-darwin" ;;
  linux) rust_triple="${arch}-unknown-linux-gnu"; wac_triple="${arch}-unknown-linux-musl" ;;
esac

# --- helpers ----------------------------------------------------------------
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else die "need shasum or sha256sum"; fi
}

# fetch <url> <dest> <expected-sha256>
fetch() {
  local url="$1" dest="$2" expected="$3" actual
  [ -n "$expected" ] || die "no pinned checksum for $(basename "$dest") on this platform; see scripts/tool-versions.env"
  if [ -f "$dest" ]; then
    actual="$(sha256_of "$dest")"
    if [ "$actual" = "$expected" ]; then log "cached  $(basename "$dest")"; return 0; fi
    log "cached $(basename "$dest") has wrong checksum; re-downloading"
    rm -f "$dest"
  fi
  log "fetch   $url"
  curl --fail --location --silent --show-error --retry 3 --output "$dest.part" "$url"
  actual="$(sha256_of "$dest.part")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$dest.part"
    die "checksum mismatch for $(basename "$dest"): expected $expected, got $actual"
  fi
  mv "$dest.part" "$dest"
  log "verified $(basename "$dest") sha256=$expected"
}

# indirect lookup of a variable named like WASM_TOOLS_SHA256_aarch64_macos
lookup() { eval "printf '%s' \"\${$1:-}\""; }

# --- wasm-tools ----------------------------------------------------------------
install_wasm_tools() {
  local name="wasm-tools-${WASM_TOOLS_VERSION}-${arch}-${os}"
  local tgz="$CACHE_DIR/$name.tar.gz"
  if [ -x "$BIN_DIR/wasm-tools" ] && "$BIN_DIR/wasm-tools" --version 2>/dev/null | grep -q "wasm-tools ${WASM_TOOLS_VERSION}"; then
    log "ok      wasm-tools ${WASM_TOOLS_VERSION}"; return 0
  fi
  fetch "https://github.com/bytecodealliance/wasm-tools/releases/download/v${WASM_TOOLS_VERSION}/${name}.tar.gz" \
    "$tgz" "$(lookup "WASM_TOOLS_SHA256_${arch}_${os}")"
  tar -xzf "$tgz" -C "$CACHE_DIR" "$name/wasm-tools"
  install -m 0755 "$CACHE_DIR/$name/wasm-tools" "$BIN_DIR/wasm-tools"
  rm -rf "$CACHE_DIR/$name"
  log "installed wasm-tools -> $BIN_DIR/wasm-tools"
}

# --- wac -------------------------------------------------------------------------
install_wac() {
  local name="wac-cli-${wac_triple}"
  local bin="$CACHE_DIR/$name-${WAC_VERSION}"
  if [ -x "$BIN_DIR/wac" ] && "$BIN_DIR/wac" --version 2>/dev/null | grep -q "wac-cli ${WAC_VERSION}"; then
    log "ok      wac ${WAC_VERSION}"; return 0
  fi
  fetch "https://github.com/bytecodealliance/wac/releases/download/v${WAC_VERSION}/${name}" \
    "$bin" "$(lookup "WAC_SHA256_${wac_triple//-/_}")"
  install -m 0755 "$bin" "$BIN_DIR/wac"
  log "installed wac -> $BIN_DIR/wac"
}

# --- wasi-sdk ------------------------------------------------------------------
install_wasi_sdk() {
  if [ -n "${WASI_SDK_PATH:-}" ] && [ -x "$WASI_SDK_PATH/bin/clang" ]; then
    log "ok      wasi-sdk from WASI_SDK_PATH=$WASI_SDK_PATH (not downloaded; version not checked)"
    return 0
  fi
  local dest="$TOOLS_DIR/wasi-sdk"
  # VERSION's first line is the bare version, e.g. "34.0".
  if [ -x "$dest/bin/clang" ] && [ -f "$dest/VERSION" ] && [ "$(head -n1 "$dest/VERSION" | tr -d '[:space:]')" = "$WASI_SDK_VERSION" ]; then
    log "ok      wasi-sdk ${WASI_SDK_VERSION}"; return 0
  fi
  local name="wasi-sdk-${WASI_SDK_VERSION}-${wasi_arch}-${os}"
  local tgz="$CACHE_DIR/$name.tar.gz"
  fetch "https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_TAG}/${name}.tar.gz" \
    "$tgz" "$(lookup "WASI_SDK_SHA256_${wasi_arch}_${os}")"
  rm -rf "$dest" "$CACHE_DIR/$name"
  tar -xzf "$tgz" -C "$CACHE_DIR"
  mv "$CACHE_DIR/$name" "$dest"
  log "installed wasi-sdk -> $dest"
}

# --- rust (optional, hermetic) -------------------------------------------------
install_rust() {
  export RUSTUP_HOME="$TOOLS_DIR/rustup"
  export CARGO_HOME="$TOOLS_DIR/cargo"
  if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    local init="$CACHE_DIR/rustup-init-${RUSTUP_VERSION}-${rust_triple}"
    fetch "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rust_triple}/rustup-init" \
      "$init" "$(lookup "RUSTUP_INIT_SHA256_${rust_triple//-/_}")"
    chmod 0755 "$init"
    log "installing rustup ${RUSTUP_VERSION} into $TOOLS_DIR (no PATH changes)"
    # A system Rust (e.g. /usr/local/bin/rustc) may coexist; this install is
    # fully contained in $TOOLS_DIR and never touches PATH or the home dir.
    RUSTUP_INIT_SKIP_PATH_CHECK=yes "$init" -y --quiet --no-modify-path --profile minimal --default-toolchain none
  fi
  # rustup verifies every component against the signed channel manifest.
  "$CARGO_HOME/bin/rustup" toolchain install "$RUST_TOOLCHAIN" --profile minimal --target "$RUST_TARGET" --no-self-update
  log "ok      rust ${RUST_TOOLCHAIN} + ${RUST_TARGET} (RUSTUP_HOME=$RUSTUP_HOME)"
}

if [ "$WAC_ONLY" = 1 ]; then
  install_wac
  exit 0
fi

install_wasm_tools
install_wac
install_wasi_sdk
if [ "$WITH_RUST" = 1 ]; then install_rust; fi

cat >&2 <<EOF
[install-tools] done. Tools directory: $TOOLS_DIR
  export PATH="$BIN_DIR:\$PATH"
  export WASI_SDK_PATH="${WASI_SDK_PATH:-$TOOLS_DIR/wasi-sdk}"
EOF
if [ "$WITH_RUST" = 1 ]; then
  cat >&2 <<EOF
  export RUSTUP_HOME="$TOOLS_DIR/rustup" CARGO_HOME="$TOOLS_DIR/cargo"
  export PATH="$TOOLS_DIR/cargo/bin:\$PATH"
EOF
fi
