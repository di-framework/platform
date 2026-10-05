# Tenant host image: wash 2.8.0 built with the opt-in `wasi-tls` feature.
# The stock ghcr.io/wasmcloud/wash:2.8.0 image is a default-features build, so components that import
# wasi:tls/client@0.3.0-draft (the node:tls shim) fail to start on it.
#
# Runtime matches upstream's Dockerfile at this tag: Chainguard wolfi-base, git, and
# /usr/local/bin/wash. The builder follows platform-examples/deploy/tenant-host/Containerfile
# (Rust 1.96.0 bookworm) rather than upstream's cgr.dev/chainguard/rust:latest-dev, because
# rust-toolchain.toml at the tag pins 1.96.0 and the public Chainguard tag is a floating toolchain.
# .github/workflows/tenant-host-image.yml publishes ghcr.io/di-framework/wash:2.8.0-wasi-tls
# on a push to main that changes this Dockerfile, the postgres patch, or the workflow.
# Pull requests build the image and do not push. Pin consumers by digest.
ARG WASMCLOUD_TAG=v2.8.0
ARG WASMCLOUD_COMMIT=5c4ec4a3d008b3f401d9e763515f434deebc9936

# rust-toolchain.toml at the tag pins 1.96.0. The digest is a multi-arch index (amd64 and arm64).
FROM docker.io/library/rust:1.96.0-bookworm@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc AS build
ARG WASMCLOUD_TAG
ARG WASMCLOUD_COMMIT
RUN apt-get update \
  && apt-get install -y --no-install-recommends protobuf-compiler libprotobuf-dev \
  && rm -rf /var/lib/apt/lists/*
# Clone the tag, then fail unless HEAD is the pinned commit. A moved tag fails the build.
# GIT_TERMINAL_PROMPT stops a missing credential from hanging the publish job.
RUN GIT_TERMINAL_PROMPT=0 git clone --depth 1 --quiet --branch "${WASMCLOUD_TAG}" https://github.com/wasmCloud/wasmCloud /src \
  && test "$(git -C /src rev-parse HEAD)" = "${WASMCLOUD_COMMIT}"
# The patch is its own layer so editing it does not clone wasmCloud again.
COPY postgres-invocation-lease.patch /tmp/postgres-invocation-lease.patch
RUN git -C /src apply --check /tmp/postgres-invocation-lease.patch \
  && git -C /src apply /tmp/postgres-invocation-lease.patch \
  && grep -q release_store_lease /src/crates/wash-runtime/src/host/http_p3.rs \
  && rm /tmp/postgres-invocation-lease.patch
WORKDIR /src
# `wasi-tls` is defined by crates/wash (forwarding to wash-runtime/wasi-tls) and is added on top of the
# default features, exactly like upstream's CARGO_FEATURES build argument.
# The publish workflow builds amd64 and arm64 at the same time. A shared target directory
# mixes the two platforms, so that cache is keyed by TARGETARCH. The registry is
# arch-independent and locked so the two builds do not write it together.
ARG TARGETARCH
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/target,id=cargo-target-${TARGETARCH},sharing=locked \
    cargo build --locked --release -p wash --bin wash --features wasi-tls \
  && install -D -m 0755 target/release/wash /out/wash

FROM cgr.dev/chainguard/wolfi-base@sha256:d59fd2d1d21e913b12a8d56064e9aaf61f818289bd18b17132a0c4fde2358cea
ARG WASMCLOUD_TAG
ARG WASMCLOUD_COMMIT
LABEL org.opencontainers.image.source="https://github.com/di-framework/platform" \
      org.opencontainers.image.description="wash ${WASMCLOUD_TAG} with wasi:tls (wasmCloud ${WASMCLOUD_COMMIT})" \
      org.opencontainers.image.version="2.8.0-wasi-tls"
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
