# Tenant host image (wash 2.8.0 + wasi:tls)

Runtime image for tenant host groups (`tenant-<name>` Deployments in `di-runtime-<name>`). It is
`wash` from wasmCloud tag `v2.8.0` (commit `5c4ec4a3d008b3f401d9e763515f434deebc9936`) built with the
opt-in `wasi-tls` cargo feature.

The stock `ghcr.io/wasmcloud/wash:2.8.0` image is a default-features build. Its host world has no
`wasi:tls`, so a component that imports `wasi:tls/client@0.3.0-draft` (the node:tls shim, for example
the meshtastic `mesh-collector`) fails with `service did not properly execute`. With this image the host
links `wasi:tls/client,types@0.3.0-draft` alongside the default interfaces.

## What is built

- Source: `git clone --branch v2.8.0`, then the build fails unless `HEAD` is the pinned commit.
  The clone is its own layer. `GIT_TERMINAL_PROMPT=0` keeps a credential prompt from hanging CI.
- Patch: `postgres-invocation-lease.patch` is applied with `git apply --check` and then `git apply`
  after the clone, so a patch edit does not download wasmCloud again. The build also requires
  `release_store_lease` to be present in `http_p3.rs`. The patch keeps
  one postgres connection for the invocation across `BEGIN` / `COMMIT` / `ROLLBACK`, and releases
  that lease when the HTTP call finishes, including when the guest stops before `COMMIT`.
  Queries outside a transaction keep upstream's bounded row channel. A query on the leased
  connection is buffered so the connection can be returned before the guest reads, and that
  buffer stops at 4096 rows or 8 MiB.
- Feature: `wasi-tls` is declared by the `wash` crate (`wasi-tls = ["wash-runtime/wasi-tls"]`), which
  enables `wasmtime-wasi-tls` (p3, rustls) in `wash-runtime`. Default features (`wasi-webgpu`,
  `wasm_component_model_implements`) stay on, matching upstream's `CARGO_FEATURES` build argument.
- Toolchain: Rust 1.96.0 (what `rust-toolchain.toml` pins at the tag), `cargo build --locked`.
  The builder is the official `rust:1.96.0-bookworm` image, the same choice as
  `platform-examples/deploy/tenant-host/Containerfile`. Upstream's builder is
  `cgr.dev/chainguard/rust:latest-dev`, which does not stay on 1.96.0.
- Runtime: the same Chainguard `wolfi-base` + `git` layout as upstream's image, binary at
  `/usr/local/bin/wash`, entrypoint `wash`. Base images are pinned by digest. Both digests are
  multi-arch indexes, so the publish workflow can build `linux/amd64` and `linux/arm64`.
  The image build runs `wash --version` as uid 65532 and fails if wolfi cannot execute the binary.
- User: `65532:65532`, `HOME=/tmp`, workdir `/tmp`. The hostgroup Deployment sets the same uid/gid,
  a read-only root filesystem, `HOME=/tmp`, and writable `/tmp` and `/oci-cache` volumes.

## Build

```sh
podman build -t localhost/di-framework/wash:2.8.0-wasi-tls platform/tenant-host
podman run --rm localhost/di-framework/wash:2.8.0-wasi-tls --version
```

`docker build` works the same way (BuildKit is needed for the cache mounts). A cold arm64 build took
about 10 minutes on 16 cores; the cargo registry and target directory are cache mounts, so rebuilds are
faster. The target cache is keyed by architecture, and the registry cache is locked, so an amd64 and
arm64 build can run together without sharing one `target` directory. The result is about 165 MB, the
same as the stock image.

At startup the host logs `Host provides interfaces` with `wasi:tls/types,client@0.3.0-draft` in the
list (the stock image lists the same interfaces without it), followed by one expected
`WARN wasi-tls is enabled but no TLS provider was set; falling back to wasmtime-wasi-tls default`:
`wash host` has no option to set a provider, so connections use the `wasmtime-wasi-tls` rustls default.

## Publish

Reference: `ghcr.io/di-framework/wash:2.8.0-wasi-tls`

The **Publish tenant host image** workflow
([`.github/workflows/tenant-host-image.yml`](../../.github/workflows/tenant-host-image.yml))
builds `linux/amd64` and `linux/arm64`. It runs when
`.github/workflows/tenant-host-image.yml`, `platform/tenant-host/Dockerfile`, or
`platform/tenant-host/postgres-invocation-lease.patch` changes: on a pull request, and on a
push to `main`. A push to `main` publishes the tag. A pull request builds the image and does
not push. The publish job authenticates with the workflow `GITHUB_TOKEN` (`packages: write`).

The tag is mutable. The workflow summary prints the multi-arch index digest; pin
`tenantHostImage` to `ghcr.io/di-framework/wash:2.8.0-wasi-tls@<digest>`. The platform default
`hostImage` stays `ghcr.io/wasmcloud/wash:2.8.0` until a published digest is selected for it.

That GHCR tag is not published yet. The first run needs the `di-framework` org to allow
GitHub Actions to publish packages. Merging this workflow to `main` is that first run, because
the workflow file itself is one of the paths that starts it.

For a local Kubesolo/k0s cluster, push to the platform registry (`di-framework-registry` in
`wasmcloud`, plain HTTP, ClusterIP) through its port-forward. With a remote podman machine, `127.0.0.1`
inside the VM is not the workstation; use `host.containers.internal`, which resolves to it:

```sh
kubectl -n wasmcloud port-forward svc/di-framework-registry 25000:5000 &
podman push --tls-verify=false localhost/di-framework/wash:2.8.0-wasi-tls \
  host.containers.internal:25000/di-framework/wash:2.8.0-wasi-tls   # 127.0.0.1:25000 without a VM
```

The node's containerd, not the pod, pulls the image. It resolves names with the node's DNS and only
falls back to plain HTTP for loopback registries, so on Kubesolo:

| Image reference | Result |
| --- | --- |
| `di-framework-registry.wasmcloud.svc.cluster.local:5000/…` | no such host (cluster DNS is not used) |
| `<ClusterIP>:5000/…` or `<node IP>:<nodePort>/…` | `server gave HTTP response to HTTPS client` |
| `127.0.0.1:<nodePort>/…` | pulled |

The registry Service is ClusterIP, so a node-pullable reference needs a NodePort Service in front of it
(then `tenantHostImage = "127.0.0.1:<nodePort>/di-framework/wash:2.8.0-wasi-tls"`), a containerd
`hosts.toml` that marks the registry as plain HTTP, or the published GHCR image.

## Use it for tenant hosts

Set the platform config used by the stack (`tenantHostImage` / `tenantHostImagePullPolicy`):

```sh
pulumi config set tenantHostImage ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:<index-digest>
pulumi config set tenantHostImagePullPolicy IfNotPresent
```

or, with `di-framework-kube`, in the `--platform-config` JSON:

```json
{
  "tenantHostImage": "ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:<index-digest>",
  "tenantHostImagePullPolicy": "IfNotPresent"
}
```

`<index-digest>` is the multi-arch index digest from the publish workflow summary.

Use `Never` with an image loaded straight into the node, and `Always` for a mutable local tag you
rebuild. The setting applies to every tenant host group.
