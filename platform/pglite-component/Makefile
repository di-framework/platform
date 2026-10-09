# di-framework:pglite@0.1.0 component
#
#   make tools          install pinned wasm-tools + wac into .tools/ (checksum-verified)
#   make tools-rust     ...plus a hermetic rustup + Rust 1.97.1 + wasm32-wasip2 (if you lack rustup)
#   make build          release build -> dist/di-framework-pglite.wasm (+ .wit, BUILD-INFO.txt, SHA256SUMS)
#   make debug          debug build
#   make smoke          build tests/smoke-consumer, `wac plug` it with the provider,
#                       run under wasmtime with persistent storage and no networking
#   make wit            print the WIT recovered from the built component
#   make check          cargo check for the wasm target
#   make compose APP=path/to/app.wasm OUT=path/to/composed.wasm
#   make publish-asset  copy dist/ artifacts into the CLI plugin assets dir
#   make clean          remove target/ and dist/
#   make distclean      ...and .tools/
#
# All build scripts are Bun TypeScript in scripts/ and read
# scripts/tool-versions.env; bump versions + checksums there.
# The engine source build uses its own pinned WASI SDK in Docker/Podman.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := build

PKG_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
TOOLS_DIR ?= $(PKG_DIR)/.tools
export DF_PGLITE_TOOLS_DIR := $(TOOLS_DIR)

PLUGIN_ASSET_DIR ?= $(PKG_DIR)/dist

.PHONY: tools tools-rust build debug smoke wit check compose publish-asset versions clean distclean

tools:
	bun scripts/install-tools.ts

tools-rust:
	bun scripts/install-tools.ts --rust

build:
	bun scripts/build.ts

debug:
	bun scripts/build.ts --debug

smoke: build
	bun scripts/smoke.ts

wit:
	bun scripts/wit.ts

check:
	bun scripts/check.ts

compose:
	bun scripts/compose.ts "$(APP)" "$(OUT)"

publish-asset: build
	mkdir -p "$(PLUGIN_ASSET_DIR)"
	cp dist/di-framework-pglite.wasm dist/di-framework-pglite.wit dist/BUILD-INFO.txt dist/SHA256SUMS dist/THIRD-PARTY-NOTICES.txt "$(PLUGIN_ASSET_DIR)/"
	@echo "copied provider artifacts to $(PLUGIN_ASSET_DIR)"

versions:
	@grep -E '^[A-Z_0-9]+=[^ ]+$$' scripts/tool-versions.env | grep -v SHA256

clean:
	rm -rf target dist

distclean: clean
	rm -rf "$(TOOLS_DIR)"
