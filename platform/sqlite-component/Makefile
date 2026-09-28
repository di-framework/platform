# di-framework:sqlite@0.1.0 component
#
#   make tools          install pinned wasm-tools, wac, wasi-sdk into .tools/ (checksum-verified)
#   make tools-rust     ...plus a hermetic rustup + Rust 1.97.1 + wasm32-wasip2 (if you lack rustup)
#   make build          release build -> dist/di-framework-sqlite.wasm (+ .wit, BUILD-INFO.txt, SHA256SUMS)
#   make debug          debug build
#   make smoke          build tests/smoke-consumer, `wac plug` it with the provider, run under wasmtime
#   make wit            print the WIT recovered from the built component
#   make check          cargo check for the wasm target (still compiles sqlite3.c via build.rs)
#   make compose APP=path/to/app.wasm OUT=path/to/composed.wasm
#   make publish-asset  copy dist/ artifacts into ../di-framework-cli-plugin-wasmcloud/dist/assets/sqlite/
#   make clean          remove target/ and dist/
#   make distclean      ...and .tools/
#
# All scripts read scripts/tool-versions.env; bump versions + checksums there.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := build

PKG_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
TOOLS_DIR ?= $(PKG_DIR)/.tools
export DF_SQLITE_TOOLS_DIR := $(TOOLS_DIR)

PLUGIN_ASSET_DIR ?= $(PKG_DIR)/dist

.PHONY: tools tools-rust build debug smoke wit check compose publish-asset versions clean distclean

tools:
	scripts/install-tools.sh

tools-rust:
	scripts/install-tools.sh --rust

build:
	scripts/build.sh

debug:
	scripts/build.sh --debug

smoke: build
	scripts/smoke.sh

wit:
	. scripts/env.sh && wasm-tools component wit dist/di-framework-sqlite.wasm

check:
	. scripts/env.sh && cargo check --locked --target "$$RUST_TARGET" -p di-framework-sqlite-component

compose:
	@[ -n "$(APP)" ] && [ -n "$(OUT)" ] || { echo "usage: make compose APP=app.wasm OUT=composed.wasm"; exit 2; }
	scripts/compose.sh "$(APP)" "$(OUT)"

publish-asset: build
	mkdir -p "$(PLUGIN_ASSET_DIR)"
	cp dist/di-framework-sqlite.wasm dist/di-framework-sqlite.wit dist/BUILD-INFO.txt dist/SHA256SUMS "$(PLUGIN_ASSET_DIR)/"
	@echo "copied provider artifacts to $(PLUGIN_ASSET_DIR)"

versions:
	@grep -E '^[A-Z_0-9]+=[^ ]+$$' scripts/tool-versions.env | grep -v SHA256

clean:
	rm -rf target dist

distclean: clean
	rm -rf "$(TOOLS_DIR)"
