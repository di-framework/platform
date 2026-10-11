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
- Patches: none by default. The `wasi-tls-exclusive` variant applies `0001-exclusive-instance.patch` (see [Exclusive instances](#exclusive-instances-wasi-tls-exclusive)). The patch is `git diff` output against the pinned commit; the build runs `git apply --check` and fails if it does not apply. Pull requests that touch this directory apply it to the pinned commit and run its tests (`.github/workflows/tenant-host-patch-check.yml`).
- Limitation: the host still runs upstream wash 2.8.0 postgres behavior for non-exclusive workloads. Connections are not pinned per invocation, and `BEGIN` ... `COMMIT` across separate queries is not guaranteed to use one connection, for named and unnamed imports alike. Guests should use autocommit or a single batched statement, as the identity guest does (issue #39).
- Feature: `wasi-tls` is declared by the `wash` crate (`wasi-tls = ["wash-runtime/wasi-tls"]`), which
  enables `wasmtime-wasi-tls` (p3, rustls) in `wash-runtime`. Default features (`wasi-webgpu`,
  `wasm_component_model_implements`) stay on, matching upstream's `CARGO_FEATURES` build argument.
- Toolchain: Rust 1.96.0 (what `rust-toolchain.toml` pins at the tag), `cargo build --locked`.
- Runtime: the same Chainguard `wolfi-base` + `git` layout as upstream's image, binary at
  `/usr/local/bin/wash`, entrypoint `wash`. Base images are pinned by digest.
- User: `65532:65532`, `HOME=/tmp`, workdir `/tmp`. The hostgroup Deployment sets the same uid/gid, a read-only root filesystem, `HOME=/tmp`, and writable `/tmp` and `/oci-cache` volumes. The image build runs `wash --version` as that user and fails if wolfi cannot execute the binary.

## Exclusive instances (`wasi-tls-exclusive`)

Why the "no patches" stance changed (#136). Stock wash 2.8.0 serves a call "from a store of its own"
when a component's warm pool is saturated, and while a retired instance drains it builds a
replacement beside it (`crates/wash-runtime/src/engine/instance_pool.rs` at the pinned commit). A
component that owns state tolerating exactly one opener, such as the embedded PostgreSQL in
`di-framework:pglite` on its persistent directory, would be opened twice. Configuration cannot turn
that off, so the variant carries a patch.

**Opting in.** Set an entry on the component's `localResources.config`:

```yaml
components:
  - name: pglite
    localResources:
      config:
        di-framework.dev/exclusive-instance: "true"
```

The runtime operator copies `localResources.config` to the host verbatim, so this needs no change to
the WorkloadDeployment CRD, the proto or the operator. `maxConcurrency: 1` was not used: it is already
what a pooled component gets by default, so it cannot say "exclusive" without changing the meaning of
workloads that set it today. Platform admission accepts only `"true"` or `"false"` for this key
(`workloadExclusiveInstanceAllowed`, mirrored in the workloads CEL policy); the host treats any other
value as `true`. The entry is also visible to the guest through `wasi:config/store`, like any
`localResources.config` entry. Components without it behave exactly as on stock wash.

**What the patch does.** An exclusive component has one warm instance serving one call at a time
(`poolSize` and `maxConcurrency` are ignored; `maxInvocations` is honoured). The guarantee is made
below the pool, with two FIFO gates per exclusive component:

- A call permit is taken before a call is offered to the pool. Callers queue in arrival order and
  hold the permit until the call's in-flight slot on the warm instance is released, so the instance
  is idle when the next caller is admitted. A replacement instance is created only by the caller
  holding the permit, so racing first calls build one instance.
- A store lease is taken before any store holding the component is built, on every path (warm
  instance, a fallback store, a service, messaging), and is released when that store is dropped. A
  retired, trapped or timed-out instance keeps its lease until its store is gone, so the replacement
  waits for it.

A call has one deadline for both gates together: `WASH_EXCLUSIVE_WAIT_TIMEOUT_SECS` (default 600),
counted from when the call joins the line, covering the wait for the call permit and the wait for the
store lease. A call that cannot get both within it fails with an error; it is never served from a
store of its own. (The call's own execution timeout, such as `WASH_HTTP_RESPONSE_TIMEOUT_SECS`, then
applies as for any call.) A call that traps or times out retires the instance, and calls queued
behind it are served by the replacement.

**Supported layout.** An exclusive component must not be linked (imported) by another component of
the workload, and the host refuses to load a workload where it is, with an error naming both. Every
store of an importer instantiates its exporters, so an importer would hold the exclusive
component's lease for as long as the importer lives and its other calls could not queue. Compose
the pieces with `wac plug` and mark the composed component exclusive. A single exclusive component
that imports only host interfaces (keyvalue, config, logging and so on) loads and is serialised
normally.

Consequences. Calls to an exclusive component are serialised, so its throughput is one call at a
time. Waiting calls hold their request open for up to the wait timeout.

**Where a refusal shows up.** The WorkloadDeployment only reports not ready, with the Sync condition
`workload is not operational: WORKLOAD_STATE_ERROR`; the operator does not carry the start error
into the status. The reason ("component 'X' imports 'Y', which is marked exclusive ... `wac plug`")
is in the tenant host log under `failed to start workload`.

The opt-in applies to components only. The service ignores it, so platform admission rejects the key
on `service.localResources.config`.

**Scope.** This is one host process. The opt-in is read from workload components only. The
optional `host-component-plugins` feature (off in this image) builds its plugin stores from host
configuration, outside `localResources.config`, so those stores take no lease and are not covered. The tenant host Deployment's rollout must not overlap pods:
`maxSurge: 0, maxUnavailable: 1` (#104), or a second pod would open the same directory. The
persistent directory is a `hostPath`, so it is per node; there is no overlap protection across nodes,
and a pod rescheduled to another node sees a different directory.

**Image.** Published under its own tag, `ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive`, with
`org.opencontainers.image.version=2.8.0-wasi-tls-exclusive` and
`dev.di-framework.wash.patches=0001-exclusive-instance.patch`. It never moves the canonical
`2.8.0-wasi-tls` tag, and `DEFAULT_HOST_IMAGE` stays on the canonical digest. Use it only by setting
`tenantHostImage` (digest-pinned) on a stack that needs it until it is proven.

**Tests.** `crates/wash-runtime/src/engine/instance_pool/exclusive_tests.rs` in the patch runs real
concurrent calls through the dispatch path against real stores and counts live stores. It covers
saturation, FIFO order, the creation race, a trap, a timed-out call, drain with a call in flight,
rotation by `maxInvocations`, the shared deadline and cancellation of a queued caller. Each asserts
at most one live store, and the drain, rotation and timed-out tests hold the old store's teardown
open to show the replacement is not built until it is released.
`tests/integration_exclusive_topology.rs` (needs the prebuilt test fixtures) covers the layout rule
and a lone exclusive component loading and queueing real requests (it does not measure
serialization; the live-store tests do). Run them against a checkout of the pinned commit with the patch applied:

```sh
git clone https://github.com/wasmCloud/wasmCloud /tmp/wasmcloud && cd /tmp/wasmcloud
git checkout 5c4ec4a3d008b3f401d9e763515f434deebc9936
git apply /path/to/platform/tenant-host/0001-exclusive-instance.patch
cargo test -p wash-runtime --features wasi-tls --lib -- instance_pool instance_driver wire_
```

## Build

```sh
podman build -t localhost/di-framework/wash:2.8.0-wasi-tls platform/tenant-host
podman run --rm localhost/di-framework/wash:2.8.0-wasi-tls --version

# the exclusive variant
podman build -t localhost/di-framework/wash:2.8.0-wasi-tls-exclusive \
  --build-arg WASH_PATCHES=0001-exclusive-instance.patch \
  --build-arg IMAGE_VERSION=2.8.0-wasi-tls-exclusive platform/tenant-host
```

The build fails if `WASH_PATCHES` and `IMAGE_VERSION` disagree (patches under the canonical version,
or a patched version with no patches).

`docker build` works the same way (BuildKit is needed for the cache mounts). A cold arm64 build took
about 10 minutes on 16 cores; the cargo registry and target directory are cache mounts, so rebuilds are
faster. The release link uses `lld`. The result is about 165 MB, the same as the stock image.

At startup the host logs `Host provides interfaces` with `wasi:tls/types,client@0.3.0-draft` in the
list (the stock image lists the same interfaces without it), followed by one expected
`WARN wasi-tls is enabled but no TLS provider was set; falling back to wasmtime-wasi-tls default`:
`wash host` has no option to set a provider, so connections use the `wasmtime-wasi-tls` rustls default.

## Publish

Reference: `ghcr.io/di-framework/wash:2.8.0-wasi-tls` (stock source), or
`ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive` (with the exclusive-instance patch).

The **Publish tenant host image** workflow
([`.github/workflows/tenant-host-image.yml`](../../.github/workflows/tenant-host-image.yml))
takes a `variant` input, `wasi-tls` (default) or `wasi-tls-exclusive`; the exclusive build has to
be selected explicitly. Each variant pushes only its
own tag; a patched build cannot be published on the canonical tag. It builds `linux/amd64` and
`linux/arm64` on native runners (`ubuntu-24.04` and `ubuntu-24.04-arm`)
at the same time, then pushes the multi-arch tag. It does not emulate arm64. Each arch also pushes
a cache manifest per variant, `ghcr.io/di-framework/wash:buildcache-<tag>-amd64` and `-arm64`, with
`mode=max`. That manifest records which layer blob in GHCR matches each Dockerfile step, including
the builder stage, and the next build imports it. The wash tag itself is not the cache: inline
metadata on an image only covers the final stage. It is `workflow_dispatch` only, the
same explicit publish step this repo uses for npm releases: a maintainer runs it from the Actions
tab after the workflow file is on `main`
(`https://github.com/di-framework/platform/actions/workflows/tenant-host-image.yml`).
The job authenticates with the workflow `GITHUB_TOKEN` (`packages: write`).

The tags are mutable. The platform default `hostImage` is the published canonical (unpatched) index:

`ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:ee89fd4bce4f9f35f4cd09c63d3cbdd07bea3071b5d372f82c9f49b9741c3669`

The currently pinned image was published before the patch was dropped, so it still contains the unnamed-import lease until a maintainer republishes and the pin is updated.

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
