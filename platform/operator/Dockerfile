# platform-operator: the operator binary, Node.js and npm (the platform program is TypeScript), the
# Pulumi CLI the Automation API drives, and the install project for the default platform version
# with its Pulumi plugins (#431). Build from platform/operator.
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
# The install project's Pulumi resource plugins, from Pulumi's plugin host (where the CLI would
# download them), each checked against the sha256 in project/plugins.txt. The layout is Pulumi's
# plugin cache: the installer links each one into $PULUMI_HOME/plugins.
RUN set -eu; \
    grep -v '^#' internal/installer/project/plugins.txt > /tmp/plugins; \
    mkdir -p /opt/platform-operator/pulumi-plugins; \
    while read -r name version arch sum; do \
      [ "$arch" = "$TARGETARCH" ] || continue; \
      tgz="pulumi-resource-${name}-v${version}-linux-${arch}.tar.gz"; \
      curl --proto '=https' --tlsv1.2 -fsSL -o "/tmp/$tgz" "https://get.pulumi.com/releases/plugins/$tgz"; \
      echo "$sum  /tmp/$tgz" | sha256sum -c -; \
      dir="/opt/platform-operator/pulumi-plugins/resource-${name}-v${version}"; \
      mkdir -p "$dir"; \
      tar -xzf "/tmp/$tgz" -C "$dir"; \
      test -x "$dir/pulumi-resource-${name}"; \
      rm "/tmp/$tgz"; \
    done < /tmp/plugins; \
    ls /opt/platform-operator/pulumi-plugins

# The install project for the default platform version (project/package.json): every package
# checked against the lockfile's integrity. Install scripts are skipped: the only ones download
# Pulumi plugins (baked above) or print notices.
FROM node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b AS project
ARG TARGETARCH
WORKDIR /opt/platform-operator/project
COPY internal/installer/project/package.json internal/installer/project/package-lock.json ./
COPY internal/installer/project/plugins.txt /tmp/plugins.txt
RUN npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier
# Every Pulumi provider package installed must have its plugin baked, at the same version.
RUN set -eu; \
    for pkg in node_modules/@pulumi/*; do \
      name="${pkg##*/}"; \
      [ "$name" != pulumi ] || continue; \
      version="$(node -p "require('./$pkg/package.json').version")"; \
      if ! grep -Eq "^$name $version $TARGETARCH [0-9a-f]{64}\$" /tmp/plugins.txt; then \
        echo "plugins.txt bakes no plugin for @pulumi/$name@$version on $TARGETARCH" >&2; exit 1; \
      fi; \
    done

FROM node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b
COPY --from=build /opt/pulumi /opt/pulumi
COPY --from=build /opt/platform-operator/pulumi-plugins /opt/platform-operator/pulumi-plugins
COPY --from=project /opt/platform-operator/project /opt/platform-operator/project
COPY --from=build /platform-operator /usr/local/bin/platform-operator
ENV PATH=/opt/pulumi:$PATH \
    PULUMI_SKIP_UPDATE_CHECK=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN /opt/pulumi/pulumi version
USER node
ENTRYPOINT ["/usr/local/bin/platform-operator"]
