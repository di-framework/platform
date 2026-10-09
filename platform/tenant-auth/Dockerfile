# Tenant-auth image: the tenant controller and console bundled for Bun on a stock oven/bun base.
# Build with the repository root as the context:
#   docker build -f platform/tenant-auth/Dockerfile .
# Maintainers publish ghcr.io/di-framework/tenant-auth with
# .github/workflows/tenant-auth-image.yml (workflow_dispatch). Pin consumers by digest.
# One image carries both entry points; the Deployment picks one with `command`:
#   bun /app/controller.js    (HTTPS on TENANT_CONTROLLER_PORT, default 8788)
#   bun /app/console.js       (HTTP on TENANT_CONSOLE_PORT, default 8787)
# Both run as the base image's `bun` user (uid/gid 1000) and work on a read-only root with a
# writable /tmp. The environment contract is frozen in platform/tenant-auth/README.md.
FROM --platform=$BUILDPLATFORM docker.io/oven/bun:1.3-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --filter '@di-framework/tenant-auth'
RUN bun build --target bun --outdir /out \
    platform/tenant-auth/src/controller.ts platform/tenant-auth/src/console.ts

FROM docker.io/oven/bun:1.3-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
LABEL org.opencontainers.image.source="https://github.com/di-framework/platform" \
      org.opencontainers.image.description="di-framework tenant-auth controller and console"
COPY --from=build /out/controller.js /out/console.js /app/
ENV TMPDIR=/tmp
WORKDIR /app
USER 1000:1000
CMD ["bun", "/app/controller.js"]
