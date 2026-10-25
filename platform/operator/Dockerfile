# platform-operator: the operator binary, Node.js and npm (the platform program is TypeScript) and the
# Pulumi CLI the Automation API drives. Build from platform/operator.
FROM --platform=$BUILDPLATFORM golang:1.26@sha256:672c944cfd07599b5f1bb179869270cdc94c6254e41db4d431259693cb286b82 AS build
ARG TARGETOS TARGETARCH
# Pulumi CLI, matching the Automation API SDK in go.mod. Digests from pulumi-3.270.0-checksums.txt.
ARG PULUMI_VERSION=3.270.0
ARG PULUMI_SHA256_arm64=b41f199a161aba4843312d4cda3143024fa6fbd73229d4149f572a1788f84bda
ARG PULUMI_SHA256_amd64=d05899c251cb0413a9a2304f23229218c46852a61256913f34f08ebc27266139
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags '-s -w' -o /platform-operator ./cmd/platform-operator
# Redirects stay on HTTPS (--proto), and the archive must match the published digest.
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) arch=arm64; sum=$PULUMI_SHA256_arm64 ;; \
      amd64) arch=x64; sum=$PULUMI_SHA256_amd64 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl --proto '=https' --tlsv1.2 -fsSL -o /tmp/pulumi.tgz \
      "https://get.pulumi.com/releases/sdk/pulumi-v${PULUMI_VERSION}-linux-${arch}.tar.gz"; \
    echo "$sum  /tmp/pulumi.tgz" | sha256sum -c -; \
    tar -xzf /tmp/pulumi.tgz -C /opt

FROM node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b
COPY --from=build /opt/pulumi /opt/pulumi
COPY --from=build /platform-operator /usr/local/bin/platform-operator
ENV PATH=/opt/pulumi:$PATH \
    PULUMI_SKIP_UPDATE_CHECK=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN /opt/pulumi/pulumi version
USER node
ENTRYPOINT ["/usr/local/bin/platform-operator"]
