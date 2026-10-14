# Tenant host image: wash 2.8.0 built with the opt-in `wasi-tls` feature.
# The stock ghcr.io/wasmcloud/wash:2.8.0 image is a default-features build, so components that import
# wasi:tls/client@0.3.0-draft (the node:tls shim) fail to start on it. This mirrors upstream's Dockerfile
# at the same tag (Chainguard wolfi-base runtime, git, /usr/local/bin/wash entrypoint) with the feature on.
# .github/workflows/tenant-host-image.yml publishes it on each push to main that changes this directory
# (workflow_dispatch reruns it). Pin consumers by digest.
#
# Variants. `variants` in this directory is the one tag -> patch set table; the build fails unless
# WASH_PATCHES is exactly the set it lists for IMAGE_VERSION, so a mislabelled image cannot be built:
#   2.8.0-wasi-tls            0002-insecure-registry-allowlist.patch 0003-nats-blobstore-credentials.patch
#                             (#149, #175, #330; the canonical default)
#   2.8.0-wasi-tls-exclusive  0001-exclusive-instance.patch 0002-insecure-registry-allowlist.patch
#                             0003-nats-blobstore-credentials.patch (#136)
# The defaults below are the canonical row, so a plain `podman build` builds the canonical image.
ARG WASMCLOUD_TAG=v2.8.0
ARG WASMCLOUD_COMMIT=5c4ec4a3d008b3f401d9e763515f434deebc9936
ARG WASH_PATCHES="0002-insecure-registry-allowlist.patch 0003-nats-blobstore-credentials.patch"
ARG IMAGE_VERSION=2.8.0-wasi-tls

# rust-toolchain.toml at the tag pins 1.96.0. Pinned by digest alone (rust:1.96.0-bookworm): a tag
# next to a digest is ignored by the runtime and flagged by Sonar.
FROM docker.io/library/rust@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc AS build
ARG WASMCLOUD_TAG
ARG WASMCLOUD_COMMIT
ARG WASH_PATCHES
ARG IMAGE_VERSION
# Fail fast unless WASH_PATCHES is exactly the patch set `variants` lists for IMAGE_VERSION (same
# patches, same order; runs of whitespace are ignored), so a mislabelled image is never published.
COPY variants /tenant-host/variants
RUN set -eu; \
    if ! expected="$(awk -v tag="${IMAGE_VERSION}" '$1 == tag { $1 = ""; sub(/^ +/, ""); print; found = 1 } END { exit !found }' /tenant-host/variants)"; then \
      echo "IMAGE_VERSION ${IMAGE_VERSION} is not a variant listed in platform/tenant-host/variants" >&2; \
      exit 1; \
    fi; \
    actual="$(echo ${WASH_PATCHES})"; \
    if [ "${actual}" != "${expected}" ]; then \
      echo "WASH_PATCHES '${actual}' does not match the patch set for ${IMAGE_VERSION}: '${expected}'" >&2; \
      exit 1; \
    fi
RUN apt-get update \
  && apt-get install -y --no-install-recommends protobuf-compiler libprotobuf-dev lld \
  && rm -rf /var/lib/apt/lists/*
# lld links the wasmtime-sized release binary much faster than GNU ld.
ENV RUSTFLAGS="-C link-arg=-fuse-ld=lld"
# Clone the tag, then fail unless HEAD is the pinned commit. A moved tag fails the build.
# GIT_TERMINAL_PROMPT stops a missing credential from hanging the publish job.
RUN GIT_TERMINAL_PROMPT=0 git clone --depth 1 --quiet --branch "${WASMCLOUD_TAG}" https://github.com/wasmCloud/wasmCloud /src \
  && test "$(git -C /src rev-parse HEAD)" = "${WASMCLOUD_COMMIT}"
WORKDIR /src
# Apply the variant's patches in order. They are `git diff` output against the pinned commit,
# checked in CI (.github/workflows/tenant-host-patch-check.yml). `--check` first so a patch that no
# longer applies fails the build with the file name, not half-applied.
COPY *.patch /patches/
RUN set -eu; \
    for patch in ${WASH_PATCHES}; do \
      git apply --check "/patches/${patch}"; \
      git apply "/patches/${patch}"; \
    done
# `wasi-tls` is defined by crates/wash (forwarding to wash-runtime/wasi-tls) and is added on top of the
# default features, exactly like upstream's CARGO_FEATURES build argument.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release -p wash --bin wash --features wasi-tls \
  && install -D -m 0755 target/release/wash /out/wash

FROM cgr.dev/chainguard/wolfi-base@sha256:d59fd2d1d21e913b12a8d56064e9aaf61f818289bd18b17132a0c4fde2358cea
ARG WASMCLOUD_TAG
ARG WASMCLOUD_COMMIT
ARG WASH_PATCHES
ARG IMAGE_VERSION
LABEL org.opencontainers.image.source="https://github.com/di-framework/platform" \
      org.opencontainers.image.description="wash ${WASMCLOUD_TAG} with wasi:tls (wasmCloud ${WASMCLOUD_COMMIT}); patches: ${WASH_PATCHES:-none}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      dev.di-framework.wash.patches="${WASH_PATCHES}"
RUN apk add --no-cache git
COPY --from=build /out/wash /usr/local/bin/wash
# The hostgroup Deployment runs uid/gid 65532 with a read-only root, HOME=/tmp, and writable
# /tmp and /oci-cache. Set the same home and workdir here so `podman run` does not run as root
# and wash does not try to write under /home/nonroot on a read-only root.
ENV HOME=/tmp
WORKDIR /tmp
USER 65532:65532
# Fail the build when this wolfi userspace cannot execute the binary (glibc mismatch).
RUN ["/usr/local/bin/wash", "--version"]
ENTRYPOINT ["/usr/local/bin/wash"]
