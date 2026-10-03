# Tenant host image: wash 2.8.0 built with the opt-in `wasi-tls` feature.
# The stock ghcr.io/wasmcloud/wash:2.8.0 image is a default-features build, so components that import
# wasi:tls/client@0.3.0-draft (the node:tls shim) fail to start on it. This mirrors upstream's Dockerfile
# at the same tag (Chainguard wolfi-base runtime, git, /usr/local/bin/wash entrypoint) with the feature on.
# Maintainers publish ghcr.io/di-framework/wash:2.8.0-wasi-tls with
# .github/workflows/tenant-host-image.yml (workflow_dispatch). Pin consumers by digest.
ARG WASMCLOUD_TAG=v2.8.0
ARG WASMCLOUD_COMMIT=5c4ec4a3d008b3f401d9e763515f434deebc9936

# rust-toolchain.toml at the tag pins 1.96.0.
FROM docker.io/library/rust:1.96.0-bookworm@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc AS build
ARG WASMCLOUD_TAG
ARG WASMCLOUD_COMMIT
RUN apt-get update \
  && apt-get install -y --no-install-recommends protobuf-compiler libprotobuf-dev \
  && rm -rf /var/lib/apt/lists/*
COPY postgres-invocation-lease.patch /tmp/postgres-invocation-lease.patch
RUN git clone --depth 1 --branch "${WASMCLOUD_TAG}" https://github.com/wasmCloud/wasmCloud /src \
  && test "$(git -C /src rev-parse HEAD)" = "${WASMCLOUD_COMMIT}" \
  && git -C /src apply /tmp/postgres-invocation-lease.patch
WORKDIR /src
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
LABEL org.opencontainers.image.source="https://github.com/di-framework/platform" \
      org.opencontainers.image.description="wash ${WASMCLOUD_TAG} with wasi:tls (wasmCloud ${WASMCLOUD_COMMIT})" \
      org.opencontainers.image.version="2.8.0-wasi-tls"
RUN apk add --no-cache git
COPY --from=build /out/wash /usr/local/bin/wash
# The tenant hostgroup Deployment sets uid/gid 65532 and a read-only root filesystem itself; this default
# only keeps standalone `podman run` from running as root.
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/wash"]
