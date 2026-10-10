SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := build

.PHONY: build publish test
build:
	PUSH=false cargo run --locked -p tenant-auth-image

publish:
	PUSH=true SMOKE_CHECK=true cargo run --locked -p tenant-auth-image

test:
	bun test
