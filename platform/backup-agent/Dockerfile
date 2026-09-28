# Job image for tenant backing-service dumps and restores.
# Publish is still local (`di-framework/backup-agent:dev`); GHCR digest pinning is a follow-on.
FROM oven/bun:1.2.21 AS build
WORKDIR /src
COPY package.json ./
COPY src ./src
RUN bun build --compile ./src/main.ts --outfile /out/backup-agent

FROM redis:7.4.5 AS rediscli

FROM postgres:18.3-bookworm
ARG TARGETARCH
ARG NATS_VERSION=0.5.0
ARG RCLONE_VERSION=1.71.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-pip unzip \
  && pip3 install --break-system-packages rdbtools==0.1.15 \
  && rm -rf /var/lib/apt/lists/* \
  && case "$TARGETARCH" in \
       amd64) NATS_SHA=d9fc93e9e9ab0310deff7e719a8a0da6f9d66f26d473f039aaee70155507aecc; \
              RCLONE_SHA=3ddbcfd535ef2e6eb00cd006831766537f1fef1c8baeed1ee4632e7bcc699e93 ;; \
       arm64) NATS_SHA=39496b0e332ba8d1b7dcbac2019c7d1e7a7f0d0ccefef9da547e9d6eeed408c8; \
              RCLONE_SHA=b710ac2ded37261d2cc6ab046dcd644828944524cf1ee7c2b17dd746f0fd8684 ;; \
       *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/nats.zip "https://github.com/nats-io/natscli/releases/download/v${NATS_VERSION}/nats-${NATS_VERSION}-linux-${TARGETARCH}.zip" \
  && echo "${NATS_SHA}  /tmp/nats.zip" | sha256sum -c - \
  && unzip -jo /tmp/nats.zip -d /usr/local/bin \
  && curl -fsSL -o /tmp/rclone.zip "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${TARGETARCH}.zip" \
  && echo "${RCLONE_SHA}  /tmp/rclone.zip" | sha256sum -c - \
  && unzip -jo /tmp/rclone.zip "rclone-v${RCLONE_VERSION}-linux-${TARGETARCH}/rclone" -d /usr/local/bin \
  && chmod 755 /usr/local/bin/nats /usr/local/bin/rclone \
  && rm -rf /tmp/nats.zip /tmp/rclone.zip
COPY --from=rediscli /usr/local/bin/redis-cli /usr/local/bin/redis-cli
COPY --from=build /out/backup-agent /usr/local/bin/backup-agent
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/backup-agent"]
