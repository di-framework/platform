# Tenant host image (wash 2.8.0 + wasi:tls)

Runtime image for tenant host groups (`tenant-<name>` Deployments in `di-runtime-<name>`). It is
`wash` from wasmCloud tag `v2.8.0` (commit `5c4ec4a3d008b3f401d9e763515f434deebc9936`) built with the
opt-in `wasi-tls` cargo feature, a per-registry insecure allowlist for OCI registries, and
credentials for NATS blobstore entries.

The stock `ghcr.io/wasmcloud/wash:2.8.0` image is a default-features build. Its host world has no
`wasi:tls`, so a component that imports `wasi:tls/client@0.3.0-draft` (the node:tls shim, for example
the meshtastic `mesh-collector`) fails with `service did not properly execute`. With this image the host
links `wasi:tls/client,types@0.3.0-draft` alongside the default interfaces.

## Variants and patches

[`variants`](variants) is the one table that maps an image tag to the patches applied to the pinned
source, in order. The Dockerfile fails a build whose `WASH_PATCHES` is not exactly the set listed for
its `IMAGE_VERSION`, the publish workflow takes the set from it, and the patch-check workflow runs one
job per row. Both variants carry 0002 and 0003:

| Tag | Patches (in order) | Use |
| --- | --- | --- |
| `ghcr.io/di-framework/wash:2.8.0-wasi-tls` (canonical, the build default) | `0002-insecure-registry-allowlist.patch` `0003-nats-blobstore-credentials.patch` | Every tenant host, including local Kubesolo/k0s clusters that pull from the in-cluster plain-HTTP registry. |
| `ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive` | `0001-exclusive-instance.patch` `0002-insecure-registry-allowlist.patch` `0003-nats-blobstore-credentials.patch` | Only stacks that need exclusive instances (pglite on a persistent directory), by setting `tenantHostImage`. |

- **0002-insecure-registry-allowlist.patch** (#149, #175) adds `wash host --insecure-registry
  <host[:port]>` and the `WASH_INSECURE_REGISTRIES` environment variable: a per-registry plain-HTTP
  allowlist. See [Insecure registry allowlist](#insecure-registry-allowlist).
- **0003-nats-blobstore-credentials.patch** (#330) lets a NATS blobstore entry authenticate with a
  user and password read from files in the host pod (`user_file`, `password_file`). See
  [NATS blobstore credentials](#nats-blobstore-credentials).
- **0001-exclusive-instance.patch** (#136) adds the exclusive queueing pool policy, opted into per
  component with `localResources.config` key `di-framework.dev/exclusive-instance: "true"`. See
  [Exclusive instances](#exclusive-instances-wasi-tls-exclusive).

## Insecure registry allowlist

`--allow-insecure-registries` switches every OCI pull to plain HTTP, GHCR included (#171). 0002 adds
a selective alternative: registries named with `--insecure-registry` (repeatable, comma-delimited) or
`WASH_INSECURE_REGISTRIES` (comma-delimited) are pulled over plain HTTP, and every other registry
stays on HTTPS. It applies to workload components, washlet artifacts and host component plugins.
`--allow-insecure-registries` still wins when both are given (the host logs a warning). At startup
the host logs the effective allowlist.

```sh
wash host --insecure-registry di-framework-registry.wasmcloud.svc.cluster.local:5000
WASH_INSECURE_REGISTRIES=di-framework-registry.wasmcloud.svc.cluster.local:5000,localhost:5000 wash host
```

Entries are `host[:port]`. Surrounding whitespace is trimmed; an empty entry (for example from a
trailing comma), an entry with a scheme (`http://reg:5000`), a path or embedded whitespace is
rejected when the host starts.

**Matching is exact.** The allowlist is oci-client 0.17's `ClientProtocol::HttpsExcept`, which
compares each entry with the reference's `Reference::resolve_registry()` as a plain string:

- case-sensitive;
- no default-port normalisation: `reg` does not match `reg:80` or `reg:443`;
- no name resolution: `reg:5000` does not match `reg.ns.svc.cluster.local:5000` or the registry's IP;
- `docker.io` references resolve to `index.docker.io`.

So pass the registry exactly as workload references spell it. The local stack's pull address is
`di-framework-registry.<namespace>.svc.cluster.local:5000` (`registry.pull` in
`platform/platform/src/local.ts`), so that is the entry to pass for it; references written as
`di-framework-registry:5000/...` need that short spelling listed too.

## NATS blobstore credentials

Stock wash 2.8.0 opens a NATS blobstore entry's connection (`backend: nats`, `NatsBlobProvider` in
`crates/wash-runtime/src/plugin/wasi_blobstore/multiplexed/nats.rs`) from `url` alone. async-nats 0.49.1 does not send a user and password embedded in the url, so the
connection is always anonymous. Isolating one entry's data with NATS accounts (#159) needs that
entry to log in as its own user. 0003 adds two optional keys to the entry config:

| Key | Value |
| --- | --- |
| `user_file` | Absolute path, inside the host pod, of a file holding the NATS user. |
| `password_file` | Absolute path, inside the host pod, of a file holding the password. |

```yaml
hostInterfaces:
  - namespace: wasmcloud
    package: blobstore
    interfaces: [blobstore, container, types]
    config:
      backend: nats
      url: nats://di-nats.di-runtime-acme.svc.cluster.local:4222
      user_file: /var/run/secrets/di-framework/registry-nats/username
      password_file: /var/run/secrets/di-framework/registry-nats/password
```

- The config holds only paths. The platform mounts the Secret into the host pod (for example a
  `kubernetes.io/basic-auth` Secret, whose `username` and `password` keys become the two files), and
  the host reads the files when it opens the connection. The values never pass through the entry
  config, the WorkloadDeployment or the operator.
- Both keys or neither. One without the other, an empty value or a relative path fails the bind with
  an error naming the key. A file that cannot be read or is empty fails it too; the error names the
  key and the path, never the contents.
- One trailing line ending (`\n` or `\r\n`) is dropped from each file, so a file written by `echo`
  works; anything else, including spaces, is kept.
- Pooling: entries share a connection only when `url` and both paths are equal. An entry with
  credentials never shares a connection with an entry without them (or with other files), and an
  entry with invalid credential keys is never pooled, so it fails instead of reusing another
  entry's connection. The files are read once per connection, and async-nats reconnects with the
  values it read then. A rotated Secret is used by the next connection, after the pooled one has
  gone unused for the pool's idle period (5 minutes by default) or the host restarts.
- Without the keys nothing changes: the entry connects with `async_nats::ConnectOptions::default()`,
  which is what stock wash's `async_nats::connect(url)` uses, and is pooled by `url` as before.
- Not supported: NATS `.creds` (JWT) and nkey files. Both need async-nats' `nkeys` feature, which the
  pinned wash does not enable; turning it on would change `Cargo.lock`, and `--locked` builds would
  need the patch to carry that. User and password is what NATS accounts in a server config use.
- Who may set the keys is decided by admission, not by the host: whoever can write an entry's
  config can name any file the host can read. Platform admission (#159) admits them only from the
  platform controller, only on the tenant registry's inline entry, only together, and only with
  exactly `/var/run/secrets/di-framework/registry-nats/username` and `.../password`, the read-only
  mount of the registry's credentials Secret; `di-bs-*` / `di-binding-*` config never carries them.
  See the platform README, "Upgrading to a registry in its own NATS account".
- Scope: only the `backend: nats` provider of the multiplexed blobstore plugins (`wasi:blobstore`
  and `wasmcloud:blobstore`). The host's own NATS blobstore plugin, which uses the `wash host` data
  NATS connection, and the NATS keyvalue and messaging backends are unchanged.

## What is built

- Source: `git clone --branch v2.8.0` in its own layer, then the build fails unless `HEAD` is the pinned commit. `GIT_TERMINAL_PROMPT=0` keeps a credential prompt from hanging CI.
- Patches: the variant's set from [`variants`](variants), applied in order after cloning (see
  [Variants and patches](#variants-and-patches)). Each is `git diff` output against the pinned
  commit; the build runs `git apply --check` first and fails if it does not apply. Pull requests that
  touch this directory apply each variant's set to the pinned commit and run the patch tests
  (`.github/workflows/tenant-host-patch-check.yml`).
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
below the pool, with two FIFO gates per exclusive component, shared across workloads on the host
(see [Across revisions](#across-revisions)):

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

<a id="across-revisions"></a>**Across revisions (#152).** A `Recreate` rollout starts the next revision
of a workload 5–25 ms before the old one stops, and each revision is a separate workload with its
own pools. The gates therefore are not per pool: the host keeps one registry of them, and a
component gets its gates from it when the workload is resolved, after its volume mounts are
canonicalized. The key is:

- with volume mounts: the canonical host paths of the component's mounts (sorted, duplicates
  removed). Any component on the host with the same set of mounts shares the gates, whatever its
  workload, namespace or revision;
- with no mount: the workload's namespace plus the component's name.

So the new revision's first call queues behind the old revision. Its first store waits, within the
same `WASH_EXCLUSIVE_WAIT_TIMEOUT_SECS` deadline, until the old revision's store is dropped. A store
lease keeps its gate alive, so a store that outlives its workload (a call still finishing) still
holds the next revision back. Stopping a workload drops its warm instances and stops its exclusive
components admitting calls. A call of the old revision that was queued, or arrives late, fails with
an error instead of opening the component again, so the new revision waits only for calls already
in flight. This holds for every path that opens the component: the pooled calls, linked calls and
the stores built through `new_store` (p2 HTTP and the messaging plugins), which check the stopped
flag before and after waiting for the store lease (a store with no exclusive component waits for no
lease and skips the second check). A registry entry goes away once no pool, permit or store refers
to its gates.

When a component attaches a gate that is already live, the host logs it at info level:
`exclusive component's gate is already live`, with the component, its namespace and `keyed_by`
(`volume mounts`, or `namespace and name (no volume mount)`). This is expected once per rollout,
because the new revision resolves while the old one is still stopping; that log line is where the
new revision starts waiting behind the old one.

Limits of the guarantee:

- Mounts are compared as whole sets. Two exclusive components whose mounts only partly overlap get
  separate gates, so do not give the same directory to two different exclusive components.
- The same applies across revisions of one component: if the next revision changes its mount set
  (for example `{/data}` becomes `{/data, /cache}`, or it mounts a parent or child directory), it
  gets a new gate and the 5-25 ms overlap with the old revision is back for that rollout. Keep
  the mount set of an exclusive component the same across revisions. The `pglite` component mounts
  only `/data`, so it is not affected.
- The registry lives in one wash host process. Two host processes on the same node that mount the
  same hostPath (for example a revision scheduled onto a different host pod) do not share a gate.
- Two exclusive components with the same mounts (or the same name and namespace and no mounts) can
  never both be serving: the one that starts second waits for the first to stop and fails once the
  wait times out. With no mount the key is only the namespace and the name, so an unrelated
  workload that reuses them is held back the same way. The host does not tell this apart from a
  rollout: both log the same info line, with `keyed_by` set to `namespace and name (no volume
  mount)`, so give an exclusive component a volume mount (or a unique name) to rule it out.

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
`dev.di-framework.wash.patches=0001-exclusive-instance.patch 0002-insecure-registry-allowlist.patch 0003-nats-blobstore-credentials.patch`
(0001 stacked with the allowlist and NATS blobstore credential patches every variant carries). It never moves the canonical
`2.8.0-wasi-tls` tag, and `DEFAULT_HOST_IMAGE` stays on the canonical digest. Use it only by setting
`tenantHostImage` (digest-pinned) on a stack that needs it until it is proven.

**Tests.** `crates/wash-runtime/src/engine/instance_pool/exclusive_tests.rs` in the patch runs real
concurrent calls through the dispatch path against real stores and counts live stores. It covers
saturation, FIFO order, the creation race, a trap, a timed-out call, drain with a call in flight,
rotation by `maxInvocations`, the shared deadline and cancellation of a queued caller. Each asserts
at most one live store, and the drain, rotation and timed-out tests hold the old store's teardown
open to show the replacement is not built until it is released. The cross-revision tests build
workloads the way the host does (`Engine::initialize_workload`, then `resolve`) and stop them the
way `workload_stop` does. They cover these cases:

- two revisions mounting one host path share a gate: the second's first call waits until the first
  is stopped, a late call to the stopped one is refused, and the registry entry is dead once both
  are gone;
- different host paths run side by side;
- with no mount, the same namespace and name share a gate, and different namespaces do not;
- a store that outlives its workload still holds the next revision back;
- a caller queued on the shared call permit when the workload is stopped is refused once admitted
  and builds nothing, and an instance being built during the stop is dropped instead of installed,
  so the next revision proceeds;
- a store requested through `new_store` for a stopped workload is refused, and so is one that was
  already waiting on the store lease when the workload stopped (the check after the wait);
- a symlink to the old revision's directory shares its gate (the key is the canonical path).
`tests/integration_exclusive_topology.rs` (needs the prebuilt test fixtures) covers the layout rule,
a lone exclusive component loading and queueing real requests (it does not measure
serialization; the live-store tests do), a new revision waiting for the old one on the same host
path, and what a caller sees of an HTTP trap: the trap fails only its own call, and the calls queued
behind it are served by a fresh instance, never the faulted one. At the pinned wasmtime a guest
trap ends the instance's event loop, so the pool reaps the instance whatever else happens. The HTTP
handler's `trapped` flag covers a trap reported to a task that survives it; its retirement
(`PoolSlot::finish`) is unit-tested in `exclusive_tests.rs`. The patch-check workflow builds the
fixtures and runs each of these tests by name. See [Tests](#tests) for the commands.

## Tests

The patch-check workflow runs these for every row of [`variants`](variants). Locally, against a
checkout of the pinned commit:

```sh
git clone https://github.com/wasmCloud/wasmCloud /tmp/wasmcloud && cd /tmp/wasmcloud
git checkout 5c4ec4a3d008b3f401d9e763515f434deebc9936
P=/path/to/platform/tenant-host

# canonical (2.8.0-wasi-tls): 0002 then 0003
git apply "$P/0002-insecure-registry-allowlist.patch" && git apply "$P/0003-nats-blobstore-credentials.patch"
cargo test -p wash-runtime --features wasi-tls --lib -- insecure_registr client_protocol test_image_pull_secret_to_oci_config nats_blobstore_
cargo test -p wash --features wasi-tls,host-component-plugins --lib -- insecure_registry

# exclusive (2.8.0-wasi-tls-exclusive), on a clean checkout: 0001, 0002, then 0003
git checkout -- . && git clean -fd
git apply "$P/0001-exclusive-instance.patch" && git apply "$P/0002-insecure-registry-allowlist.patch"
git apply "$P/0003-nats-blobstore-credentials.patch"
cargo test -p wash-runtime --features wasi-tls --lib -- insecure_registr client_protocol test_image_pull_secret_to_oci_config nats_blobstore_ instance_pool instance_driver wire_
cargo test -p wash --features wasi-tls,host-component-plugins --lib -- insecure_registry

# exclusive only: the topology tests need the wasm fixtures. The toolchain's bundled
# wasm-component-ld (0.5.22 in 1.96.0) cannot link keyvalue-implements, so link with 0.5.24.
cargo install --locked --root /tmp/wasm-component-ld/0.5.24 wasm-component-ld@0.5.24
CARGO_TARGET_WASM32_WASIP2_LINKER=/tmp/wasm-component-ld/0.5.24/bin/wasm-component-ld cargo xtask build-fixtures
cargo test -p wash-runtime --features wasi-tls --test integration_exclusive_topology
```

0002's tests cover protocol selection (an allowlisted `host:port` is pulled over HTTP and anything
else over HTTPS, checked against a loopback listener; `--allow-insecure-registries` makes every pull
HTTP), the allowlist reaching the washlet's pull config, and `wash host` parsing of repeated flags,
the comma-delimited `WASH_INSECURE_REGISTRIES`, trimming, and rejected entries. 0003's tests
(`nats_blobstore_`) cover parsing the credential keys (neither, both, one alone, empty, relative),
pool keys (unchanged without credentials, separated by credentials, invalid entries unpooled),
reading the files (line ending, empty and missing files, errors without contents), and the `CONNECT`
a fake NATS server on a loopback listener receives: the user and password from the files, or none
without the keys. CI also runs
`cargo fmt --all -- --check`, clippy `-D warnings` for `-p wash` and `-p wash-runtime`, and
`cargo check -p wash --features wasi-tls,host-component-plugins`.

## Build

```sh
podman build -t localhost/di-framework/wash:2.8.0-wasi-tls platform/tenant-host
podman run --rm localhost/di-framework/wash:2.8.0-wasi-tls --version

# the exclusive variant
podman build -t localhost/di-framework/wash:2.8.0-wasi-tls-exclusive \
  --build-arg "WASH_PATCHES=0001-exclusive-instance.patch 0002-insecure-registry-allowlist.patch 0003-nats-blobstore-credentials.patch" \
  --build-arg IMAGE_VERSION=2.8.0-wasi-tls-exclusive platform/tenant-host
```

The defaults are the canonical row. The build fails unless `WASH_PATCHES` is exactly the patch set
[`variants`](variants) lists for `IMAGE_VERSION` (same patches, same order), and fails for an
`IMAGE_VERSION` that is not listed.

`docker build` works the same way (BuildKit is needed for the cache mounts). A cold arm64 build took
about 10 minutes on 16 cores; the cargo registry and target directory are cache mounts, so rebuilds are
faster. The release link uses `lld`. The result is about 165 MB, the same as the stock image.

At startup the host logs `Host provides interfaces` with `wasi:tls/types,client@0.3.0-draft` in the
list (the stock image lists the same interfaces without it), followed by one expected
`WARN wasi-tls is enabled but no TLS provider was set; falling back to wasmtime-wasi-tls default`:
`wash host` has no option to set a provider, so connections use the `wasmtime-wasi-tls` rustls default.

## Publish

Reference: `ghcr.io/di-framework/wash:2.8.0-wasi-tls` (0002 and 0003), or
`ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive` (0001, 0002 and 0003).

The **Publish tenant host image** workflow
([`.github/workflows/tenant-host-image.yml`](../../.github/workflows/tenant-host-image.yml))
runs by itself on every push to `main` that changes `platform/tenant-host/**` (including
[`variants`](variants)) or the workflow, and then builds every variant listed in `variants`,
`wasi-tls` and `wasi-tls-exclusive`. A manual run (`workflow_dispatch`) takes a `variant` input,
`wasi-tls` (default) or `wasi-tls-exclusive`; the exclusive build has to be selected explicitly,
and a dispatch always builds. Each variant pushes only its
own tag, with the patch set its resolver job reads from [`variants`](variants); a set that does not
match the tag fails the Dockerfile check, so neither tag can be published with the other's patches. It builds `linux/amd64` and
`linux/arm64` on native runners (`ubuntu-24.04` and `ubuntu-24.04-arm`)
at the same time, then pushes the multi-arch tag. It does not emulate arm64. Each arch also pushes
a cache manifest per variant, `ghcr.io/di-framework/wash:buildcache-<tag>-amd64` and `-arm64`, with
`mode=max`. That manifest records which layer blob in GHCR matches each Dockerfile step, including
the builder stage, and the next build imports it. The wash tag itself is not the cache: inline
metadata on an image only covers the final stage.

On a push, the first job hashes the committed input files (the workflow's `paths:` filter, salted
with the variant name; `scripts/source-check.ts`) and skips any variant whose
`ghcr.io/di-framework/wash:src-<hash>` tag already exists, so an unrelated commit publishes nothing.
A publish adds `src-<hash>` to the same multi-arch index as the variant tag. The jobs that push
authenticate with the workflow `GITHUB_TOKEN` (`packages: write`). After a publish, a separate job
(`contents: write`, `pull-requests: write`, `packages: read`) opens or updates one PR, `bot/pin-wash`. It reads each
variant's digest from its `src-<hash>` tag for the current source and updates every published
variant's row in the table below with `scripts/pin-artifact.ts`, so a run that built only one
variant never drops the other's pending pin. The pin job also runs when a push publishes nothing
because its source is already published, for example after a revert to an older source, or after
a pin PR was closed unmerged: it re-pins that source and opens no PR when `main` already has it. On
the same path the `realign` job points the moving `2.8.0-<variant>` tag back at that source's
`src-<hash>` digest (`scripts/retag.sh`, which leaves a tag that is already there alone).

A push run is stale when the inputs on `main` (the same filtered, hashed files) differ from its
own; an unrelated newer commit does not make it stale. A stale run publishes and pins nothing,
because the run for the newer source does both. The check runs in `check-source`, again right
before `merge` moves the tags (so "Re-run failed jobs" on an older run is caught too), and in the
pin step, and the build job checks it too, so a stale re-run leaves the `buildcache-*` tags alone.
A dispatch always builds. Each variant merges on its own, so one variant's failed build
does not hold back the other; to publish and pin the failed variant, dispatch the workflow for it.
GitHub does not run workflows on a PR that
`GITHUB_TOKEN` opened, so a maintainer has to start its checks (close and reopen it) before merging.

Latest published images (multi-arch index digests; the bot PR keeps this table current):

| Variant | Image |
| --- | --- |
| `wasi-tls` | `ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:76c78e4a5888b48eb9abd89f02c5f58c5aa5bcd0a7d2fefe72b323a17ea43d77` |
| `wasi-tls-exclusive` | `ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@sha256:ef510b78221d5b5c7edef7203d8837b8cae35a31535376b2b034e689f909d2ab` |

The same pin PR (`scripts/pin-artifact.ts`, #346) also updates the platform code that names host
builds, from the [`variants`](variants) table: the canonical variant (its first row) moves the
platform default (`DEFAULT_HOST_IMAGE` in `platform/platform/src/index.ts`) and the mentions of it
below, and every variant whose patch set includes 0003 appends its digest to
`NATS_CREDENTIALS_HOST_IMAGE_DIGESTS` (`platform/platform/src/tenancy/registry-nats.ts`). Older
digests stay listed, since existing installs may still run them.

An install that does not set `tenantHostImage` moves its tenant hosts to the new build on the first
deploy of a platform release that contains a merged canonical pin; to hold a build, set
`tenantHostImage` to its digest. The allowlist is under `platform/platform/src/tenancy/`, an input of
the tenant-auth image, so merging a host pin PR that extends it also publishes tenant-auth and opens
a second bot PR, `bot/pin-tenant-auth`.

The tags are mutable. The platform default `hostImage` is pinned to the canonical index built with
0002 and 0003 (and without the unnamed-import lease, #13). The platform lets a tenant registry use
its NATS credentials only on host images it knows carry 0003 (`NATS_CREDENTIALS_HOST_IMAGE_DIGESTS`):

`ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:76c78e4a5888b48eb9abd89f02c5f58c5aa5bcd0a7d2fefe72b323a17ea43d77`

`tenantHostImage` overrides it. The workflow summary prints the digest of each later publish.
Tenant hosts never run `--allow-insecure-registries`; with `insecureRegistry` they get
`--insecure-registry di-framework-registry.<namespace>.svc.cluster.local:5000` (the platform
registry, as `registry.pull` spells it) plus each `insecureRegistries` entry (#149). An override
image must therefore include 0002.

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
pulumi config set tenantHostImage ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:76c78e4a5888b48eb9abd89f02c5f58c5aa5bcd0a7d2fefe72b323a17ea43d77
pulumi config set tenantHostImagePullPolicy IfNotPresent
```

or, with `di-framework-kube`, in the `--platform-config` JSON:

```json
{
  "tenantHostImage": "ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:76c78e4a5888b48eb9abd89f02c5f58c5aa5bcd0a7d2fefe72b323a17ea43d77",
  "tenantHostImagePullPolicy": "IfNotPresent"
}
```

`<index-digest>` is the multi-arch index digest from the publish workflow summary.

Use `Never` with an image loaded straight into the node, and `Always` for a mutable local tag you
rebuild. The setting applies to every tenant host group.
