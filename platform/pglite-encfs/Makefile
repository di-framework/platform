# pglite-encfs: encrypting wasi:filesystem layer for the pglite component
#
#   make tools          install the pinned wasm-tools + wac (shared with ../pglite-component)
#   make build          release build -> dist/pglite-encfs.wasm (+ .wit, BUILD-INFO.txt, SHA256SUMS)
#   make unit           rustfmt, clippy (host + Wasm) and the host unit tests
#   make smoke          compose with ../pglite-component/dist/di-framework-pglite.wasm and the
#                       pglite smoke consumer, run the encryption matrix under wasmtime
#                       (pglite from PGLITE_ENCFS_PGLITE_WASM, else `make -C ../pglite-component build`)
#   make compose PGLITE=path/to/di-framework-pglite.wasm OUT=path/to/pglite-enc.wasm
#   make wit            print the WIT recovered from the built component
#   make clean          remove target/ and dist/
#
# Rust comes from rust-toolchain.toml through rustup; the scripts are Bun TypeScript.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := build

PGLITE ?= ../pglite-component/dist/di-framework-pglite.wasm
OUT ?= dist/pglite-enc.wasm

.PHONY: tools build unit smoke compose wit clean

tools:
	$(MAKE) -C ../pglite-component tools

build:
	bun scripts/build.ts

unit:
	bun scripts/unit.ts

smoke: build
	bun scripts/smoke.ts

compose: build
	PATH="$(abspath ../pglite-component/.tools/bin):$$PATH" wac plug --plug dist/pglite-encfs.wasm "$(PGLITE)" -o "$(OUT)"
	@echo "encrypted provider: $(OUT)"

wit:
	wasm-tools component wit dist/pglite-encfs.wasm

clean:
	rm -rf target dist
