# Tenant host image (wash 2.8.0 + wasi:tls)

Runtime image for tenant host groups (`tenant-<name>` Deployments in `di-runtime-<name>`). It is
`wash` from wasmCloud tag `v2.8.0` (commit `5c4ec4a3d008b3f401d9e763515f434deebc9936`) built with the
opt-in `wasi-tls` cargo feature.

The stock `ghcr.io/wasmcloud/wash:2.8.0` image is a default-features build. Its host world has no
`wasi:tls`, so a component that imports `wasi:tls/client@0.3.0-draft` (the node:tls shim, for example
the meshtastic `mesh-collector`) fails with `service did not properly execute`. With this image the host
links `wasi:tls/client,types@0.3.0-draft` alongside the default interfaces.

## What is built

- Source: `git clone --branch v2.8.0` in its own layer, then the build fails unless `HEAD` is the pinned commit. `GIT_TERMINAL_PROMPT=0` keeps a credential prompt from hanging CI.
- Patch: `postgres-invocation-lease.patch` is applied with `git apply --check` and then `git apply`, so a patch edit does not download wasmCloud again. The build also requires `release_store_lease` in `http_p3.rs`. The patch keeps
  one postgres connection for the invocation across `BEGIN` / `COMMIT` / `ROLLBACK`, and releases
  that lease when the HTTP call finishes, including when the guest stops before `COMMIT`.
  Queries outside a transaction keep upstream's bounded row channel. A query on the leased
  connection is buffered so the connection can be returned before the guest reads, and that
  buffer stops at 4096 rows or 8 MiB.
- Feature: `wasi-tls` is declared by the `wash` crate (`wasi-tls = ["wash-runtime/wasi-tls"]`), which
  enables `wasmtime-wasi-tls` (p3, rustls) in `wash-runtime`. Default features (`wasi-webgpu`,
  `wasm_component_model_implements`) stay on, matching upstream's `CARGO_FEATURES` build argument.
- Toolchain: Rust 1.96.0 (what `rust-toolchain.toml` pins at the tag), `cargo build --locked`.
- Runtime: the same Chainguard `wolfi-base` + `git` layout as upstream's image, binary at
  `/usr/local/bin/wash`, entrypoint `wash`. Base images are pinned by digest.
- User: `65532:65532`, `HOME=/tmp`, workdir `/tmp`. The hostgroup Deployment sets the same uid/gid, a read-only root filesystem, `HOME=/tmp`, and writable `/tmp` and `/oci-cache` volumes. The image build runs `wash --version` as that user and fails if wolfi cannot execute the binary.

## Build

```sh
podman build -t localhost/di-framework/wash:2.8.0-wasi-tls platform/tenant-host
podman run --rm localhost/di-framework/wash:2.8.0-wasi-tls --version
```

`docker build` works the same way (BuildKit is needed for the cache mounts). A cold arm64 build took
about 10 minutes on 16 cores; the cargo registry and target directory are cache mounts, so rebuilds are
faster. The release link uses `lld`. The result is about 165 MB, the same as the stock image.

At startup the host logs `Host provides interfaces` with `wasi:tls/types,client@0.3.0-draft` in the
list (the stock image lists the same interfaces without it), followed by one expected
`WARN wasi-tls is enabled but no TLS provider was set; falling back to wasmtime-wasi-tls default`:
`wash host` has no option to set a provider, so connections use the `wasmtime-wasi-tls` rustls default.

## Publish

Reference: `ghcr.io/di-framework/wash:2.8.0-wasi-tls`

The **Publish tenant host image** workflow
([`.github/workflows/tenant-host-image.yml`](../../.github/workflows/tenant-host-image.yml))
builds `linux/amd64` and `linux/arm64` on native runners (`ubuntu-24.04` and `ubuntu-24.04-arm`)
at the same time, then pushes the multi-arch tag. It does not emulate arm64. Each arch also pushes
a cache manifest, `ghcr.io/di-framework/wash:buildcache-amd64` and `:buildcache-arm64`, with
`mode=max`. That manifest records which layer blob in GHCR matches each Dockerfile step, including
the builder stage, and the next build imports it. The wash tag itself is not the cache: inline
metadata on an image only covers the final stage. It is `workflow_dispatch` only, the
same explicit publish step this repo uses for npm releases: a maintainer runs it from the Actions
tab after the workflow file is on `main`
(`https://github.com/di-framework/platform/actions/workflows/tenant-host-image.yml`).
The job authenticates with the workflow `GITHUB_TOKEN` (`packages: write`).

The tag is mutable. The platform default `hostImage` is the published index:

`ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:ee89fd4bce4f9f35f4cd09c63d3cbdd07bea3071b5d372f82c9f49b9741c3669`

`tenantHostImage` overrides it. The workflow summary prints the digest of each later publish.

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
pulumi config set tenantHostImage ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:ee89fd4bce4f9f35f4cd09c63d3cbdd07bea3071b5d372f82c9f49b9741c3669
pulumi config set tenantHostImagePullPolicy IfNotPresent
```

or, with `di-framework-kube`, in the `--platform-config` JSON:

```json
{
  "tenantHostImage": "ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:ee89fd4bce4f9f35f4cd09c63d3cbdd07bea3071b5d372f82c9f49b9741c3669",
  "tenantHostImagePullPolicy": "IfNotPresent"
}
```

`<index-digest>` is the multi-arch index digest from the publish workflow summary.

Use `Never` with an image loaded straight into the node, and `Always` for a mutable local tag you
rebuild. The setting applies to every tenant host group.
