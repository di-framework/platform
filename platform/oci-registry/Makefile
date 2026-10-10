# di-framework tenant OCI registry component (vendored wasmCloud examples/oci-registry)
#
#   make build    release build -> dist/di-framework-oci-registry.wasm (+ .wit, BUILD-INFO.txt, SHA256SUMS)
#   make debug    debug build
#   make test     cargo test (auth mapping, cache, fail-closed) against a fake controller
#   make lint     cargo fmt --check + clippy
#   make wit      print the WIT recovered from the built component
#   make clean    remove target/ and dist/

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := build

# rustup's proxies first, so rust-toolchain.toml selects the pinned toolchain.
export PATH := $(or $(CARGO_HOME),$(HOME)/.cargo)/bin:$(PATH)

.PHONY: build debug publish-local test lint wit clean

build:
	PUSH=false cargo run --locked --manifest-path build-support/Cargo.toml

publish-local:
	PUSH=true cargo run --locked --manifest-path build-support/Cargo.toml

debug:
	scripts/build.sh --debug

test:
	cargo test --locked

lint:
	cargo fmt --check
	cargo clippy --locked --all-targets -- -D warnings

wit:
	wasm-tools component wit dist/di-framework-oci-registry.wasm

clean:
	rm -rf target dist
