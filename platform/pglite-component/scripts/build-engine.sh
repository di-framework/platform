#!/usr/bin/env bash
# Build the PostgreSQL WASI engine with real setjmp/longjmp error recovery.
# Docker/Podman is used only to compile; the resulting component needs neither.
set -euo pipefail
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$PKG_DIR/scripts/tool-versions.env"
ENGINE_DIR="$PKG_DIR/target/engine"
SOURCE_DIR="$ENGINE_DIR/source"
mkdir -p "$ENGINE_DIR"
STAMP="$(cat "$0" "$PKG_DIR/scripts/tool-versions.env" "$PKG_DIR/scripts/patch-engine-source.py" "$PKG_DIR/engine/reply-buffer.c" | shasum -a 256 | cut -d' ' -f1)"
if [ -f "$ENGINE_DIR/source-stamp" ] && [ "$(cat "$ENGINE_DIR/source-stamp")" = "$STAMP" ] && [ -s "$ENGINE_DIR/pglite-source.tar.xz" ]; then
  exit 0
fi
command -v docker >/dev/null || { echo 'engine build needs Docker or a Docker-compatible Podman context' >&2; exit 1; }
# Respect an explicitly selected context. Do not change the user's global one.
if [ -z "${DOCKER_CONTEXT:-}" ] && ! docker info >/dev/null 2>&1; then
  if docker --context podman info >/dev/null 2>&1; then export DOCKER_CONTEXT=podman; fi
fi
docker info >/dev/null
if [ ! -d "$SOURCE_DIR/.git" ]; then
  mkdir -p "$SOURCE_DIR"
  git -C "$SOURCE_DIR" init -q
  git -C "$SOURCE_DIR" remote add origin https://github.com/moznion/wasipg.git
fi
git -C "$SOURCE_DIR" fetch --depth 1 origin "$PGLITE_SOURCE_REF"
git -C "$SOURCE_DIR" checkout FETCH_HEAD -- build NOTICE LICENSE
# Keep the upstream build recipe, adapting file transfer for remote container
# daemons and omitting its Go-specific pristine-database packaging step.
python3 - "$SOURCE_DIR" "$PGLITE_SDK_SHA256_X86_64" "$PGLITE_WASI_SDK_SHA256_X86_64" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
p = root / 'build/versions.env'
s = p.read_text().replace('SDK_SHA256_X86_64=__FILLED_BY_FIRST_BUILD__', 'SDK_SHA256_X86_64=' + sys.argv[2]).replace('WASI_SDK_OVERLAY_SHA256_X86_64=__FILLED_BY_FIRST_BUILD__', 'WASI_SDK_OVERLAY_SHA256_X86_64=' + sys.argv[3])
p.write_text(s)
p = root / 'build/build.sh'
s = p.read_text().replace('docker build -t', 'docker build --load -t')
s = s.replace('IMG=wasipg-builder:', 'python3 "$DF_PGLITE_SOURCE_PATCH" "$SRC"\n\nIMG=wasipg-builder:')
start = s.index('docker run --rm')
s = s[:start] + '''CONTAINER="df-pglite-engine-build-$$"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT
docker create --name "$CONTAINER" \\
  ${VOLARGS[@]+"${VOLARGS[@]}"} \\
  -e WASI=true -e CI=true -e SJLJ=true -e DEBUG=false \\
  -e PG_VERSION=17.5 -e PG_BRANCH=REL_17_5_WASM -e SDKROOT=/tmp/sdk \\
  -e GETZIC=false -e ZIC=/usr/sbin/zic -w /workspace \\
  "$IMG" bash -c './wasm-build.sh; /pack.sh'
docker cp "$SRC/." "$CONTAINER:/workspace"
docker cp pack.sh "$CONTAINER:/pack.sh"
docker start -a "$CONTAINER"
status="$(docker inspect --format '{{.State.ExitCode}}' "$CONTAINER")"
[ "$status" = 0 ] || exit "$status"
docker cp "$CONTAINER:/tmp/sdk/dist/." out/
cp ../NOTICE out/NOTICE
'''
p.write_text(s)
PY
# Do not reuse shared upstream FAST volumes: clean source builds avoid stale
# objects compiled with a different compiler or recovery configuration.
DF_PGLITE_SOURCE_PATCH="$PKG_DIR/scripts/patch-engine-source.py" FAST=false bash "$SOURCE_DIR/build/build.sh"
cp "$SOURCE_DIR/build/out/pglite-wasi.tar.xz" "$ENGINE_DIR/pglite-source.tar.xz"
printf '%s' "$STAMP" > "$ENGINE_DIR/source-stamp"
