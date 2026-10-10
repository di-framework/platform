# Tenant OCI registry (`platform/oci-registry`)

Per-tenant OCI registry component for the di-framework platform (#83
`:component`, decision on #52). Each tenant gets its own registry in its
namespace; the tenant controller decides who may pull and push.

## Provenance

Vendored from [wasmCloud `examples/oci-registry`](https://github.com/wasmCloud/wasmCloud/tree/ee52f49e88e1f9fe4cf001bd232e0bbc6b52bcb3/examples/oci-registry)
at commit `ee52f49e88e1f9fe4cf001bd232e0bbc6b52bcb3`, Copyright the wasmCloud
Team, licensed under Apache-2.0 (see [`LICENSE`](./LICENSE), copied from the
upstream repository root). The upstream README follows below, adjusted only
where the auth model changed; [`conformance.md`](./conformance.md) is
unchanged.

di-framework changes against that commit:

- `src/auth.rs`: rewritten. The shared `registry-username` / `registry-password`
  Basic credential is replaced by a callback to the tenant controller.
- `src/controller.rs`: new. Calls `GET /v1/auth/whoami` over outgoing
  `wasi:http/client@0.3.0`.
- `src/lib.rs`: calls `auth::require_access` instead of `auth::require_basic`,
  and rejects invalid names, digests, tags and session ids before any storage
  access (`src/validate.rs`).
- `src/validate.rs`: new (security fix, a candidate to send upstream). Repository
  names, digests (`algorithm:encoded`, lowercase hex of the right length for
  `sha256` / `sha512`), tags and upload session ids are checked against the
  distribution-spec grammar before they become object keys, so `..` and other
  separators never reach the blobstore. Violations get `400` with the spec's
  codes (`NAME_INVALID`, `DIGEST_INVALID`, `TAG_INVALID`,
  `BLOB_UPLOAD_INVALID`). Upstream built keys from the raw path.
- `src/manifests.rs`: a manifest `subject` digest is indexed as a referrer only
  when it is a valid digest (it becomes part of a key).
- `wit/world.wit`: adds `import wasi:http/client@0.3.0` and
  `wasi:clocks/monotonic-clock@0.3.0`.
- `wit/deps/`: the resolved WIT dependencies (`wkg wit fetch`, digests in
  `wkg.lock`) are committed so the build needs no registry access;
  `wit-overrides/secrets` is upstream's in-repo `wit/secrets/wit` at the same
  commit (`wkg.toml` points at it).
- `Makefile`, `scripts/build.sh`, `rust-toolchain.toml`, `package.json`,
  `package.test.ts`, `.wash/config.yaml` (dev config): di-framework build and
  test wiring, matching `sqlite-component` / `pglite-component`.
- `.github/workflows/oci-registry-component.yml` (repository root): publishes
  the built component to GHCR (see [Publishing](#publishing)).

## Authorization

Clients log in with HTTP Basic. The **password** is the caller's own
credential (an identity-server access token or a `dik_` API key); the username
is ignored, so `docker login -u anything -p <token>` works. For every request,
including the `GET /v2/` probe, the registry:

1. Rejects a missing, non-Basic or empty-password `Authorization` header with
   `401` and `WWW-Authenticate: Basic realm="di-framework-tenant-registry"`.
2. Calls `GET <tenant-controller-url>/v1/auth/whoami` with
   `Authorization: Bearer <password>`. The call has a 2 s connect, 5 s
   first-byte and 5 s between-bytes timeout (`wasi:http` request options), and
   the guest also abandons it after 12 s by the monotonic clock in case the
   host ignores those options. A timeout denies (`401`).
3. Requires a 2xx body shaped like the contract's `Principal` (`user`,
   `account`, `role`, `via`) whose `account` equals the bind-time `tenant`
   key. A principal from another tenant's controller is denied.
4. Maps the operation by method: `GET` / `HEAD` (pull, existence checks, tag
   listing, referrers, the `/v2/` probe) need **read**; `POST` / `PUT` /
   `PATCH` / `DELETE` (uploads, mounts, manifest pushes, deletes) and any other
   method need **write**.
5. Allows read for `viewer` and `developer`, write for `developer` only. A
   `viewer` attempting a write gets `403 DENIED`.

Positive answers are cached for 30 s, at most 256 entries, keyed by the
SHA-256 of the credential (never the raw token); expired entries are evicted
first, then the one closest to expiry. Negative answers are never cached.
The cache is shared by every request one component instance serves and is
borrowed only for a single lookup or insert, never across the controller call,
so parallel layer pushes in one instance reuse each other's answers. Whether
wash reuses a component instance across requests (or instantiates one per
request, as the plain wasmtime-wasi-http proxy pattern does) has not been
verified for the tenant host; if it instantiates per request, the cache never
hits and every request calls the controller.

**Revocation window.** The 30 s registry cache stacks on the controller's own
caches (membership 15 s, identity claims 60 s; API keys are not cached there).
Worst cases before a revoked credential stops working at the registry:

| Change                                                   | Worst case |
| -------------------------------------------------------- | ---------- |
| API-key revocation or expiry                             | about 30 s |
| User or tenant suspension, or membership removal         | about 45 s |
| Identity-token revocation at the issuer                  | about 90 s |

`POST /v1/auth/logout` on the controller does not clear the registry's cache.

It **fails closed**: if `tenant-controller-url` or `tenant` is missing or
malformed, the controller is unreachable or too slow, or it answers anything
other than a 2xx `Principal` for this tenant with a `viewer` / `developer`
role, the request gets the `401` challenge.

### Configuration

| Key                     | Source                                 | Example                                              |
| ----------------------- | -------------------------------------- | ---------------------------------------------------- |
| `tenant-controller-url` | `wasmcloud:secrets` (bind-time config) | `https://tenant-controller.di-runtime-acme.svc:8788` |
| `tenant`                | `wasmcloud:secrets` (bind-time config) | `acme`                                               |

`https://` is accepted for any host. Plain `http://` is accepted only for
cluster-local hosts (`*.svc`, `*.svc.cluster.local`) and loopback (for
`wash dev`); any other `http://` URL denies every request, so a typo cannot
send tokens off-cluster in cleartext.

Both values are read through the same `wasmcloud:secrets` `store` + `reveal`
imports upstream already used for its credentials, so the component's import
surface grows only by `wasi:http/client` and the monotonic clock; no
`wasi:config` host plugin is required. An optional path prefix is kept
(`https://host/prefix` calls `/prefix/v1/auth/whoami`).

### Plain HTTP to the controller

The tenant controller serves HTTPS with a private CA. A component's outgoing
`wasi:http` request is made by the host (wash 2.x, wasmtime-wasi-http over
hyper + rustls), which verifies the server against the **host's** trust roots;
`wasi:http/types` has no per-request field for a custom CA, and the wasi-tls
work tracked for the tenant host (#81) concerns TLS the guest terminates or
originates itself over `wasi:sockets`, not the host's HTTP client. So
`https://` only works when the tenant's private CA is installed in every
tenant host's trust store, which couples the host image to each tenant's CA.

The component accepts either. `:reconcile` (platform#83) uses plain HTTP to a
separate controller listener, `http://tenant-controller.di-runtime-<tenant>.svc:8789`,
which serves only `GET /v1/auth/whoami`; a NetworkPolicy admits only the
tenant's host pods to it (see the `tenantAuth` section of
`platform/platform/README.md`). The credential crosses the pod network in
**cleartext** there: a namespace is not a network boundary. The hop from the
controller's TLS registry front to the host is plain HTTP too, so the Basic
credential is cleartext on the pod network before the registry sees it. Both
hops stay cleartext unless the cluster encrypts pod traffic (CNI WireGuard or
mesh mTLS); off-cluster, users reach the registry only over TLS. Once the
tenant host is confirmed to accept an extra trust root, an `https://` URL
works with no code change.

A bracketed IPv6 authority counts as cluster-local only when it is loopback
and is followed by nothing or by `:<digits>`; `http://[::1]evil.example` and
the like are rejected.

### Build and test

```shell
make test     # cargo test: role -> ops, cache TTL/bound/hash keys, fail-closed (fake controller)
make lint     # cargo fmt --check + clippy -D warnings
make build    # dist/di-framework-oci-registry.wasm (+ .wit, BUILD-INFO.txt, SHA256SUMS)
bun test platform/oci-registry   # artifact + provenance checks
```

`make build` needs rustup (honours `rust-toolchain.toml`: Rust 1.97.1,
`wasm32-wasip2`) and `wasm-tools`. CI builds and tests it in `.github/workflows/ci.yml`.
The wasi:http path (`TenantController::whoami`) is exercised only by a real
host; there is no `wash dev` integration test against a stub controller yet.

### Publishing

`.github/workflows/oci-registry-component.yml` is dispatch-only and publishes
only from `main`. It runs `make -C platform/oci-registry test build` and
pushes `dist/di-framework-oci-registry.wasm` to
`ghcr.io/di-framework/oci-registry` in the Wasm OCI layout that `wkg` and
`wash oci push` produce: one `application/wasm` layer and an
`application/vnd.wasm.config.v0+json` config carrying `created`,
`architecture: "wasm"`, `os: "wasip2"`, `layerDigests` and the `component`
field (the world's `imports` and `exports`, read from the WIT `make build`
recovers from the component), which the CNCF Wasm OCI layout requires for
`wasip2`. The image is tagged with the
commit SHA, and the job summary prints the manifest digest. The workflow has
not been run yet.

Pin deployments by digest, never by tag:

```
ghcr.io/di-framework/oci-registry@sha256:<digest from the job summary>
```

The SHA tag is informational; only the digest is stable. The tenancy reconcile
takes the pin from the platform config `tenantAuth.registry.component`, so set
the digest there when you publish.

---

# OCI Registry (upstream README)

A minimal [OCI Distribution Spec][oci-dist] (v2) registry implemented as a single
**wasip3** WebAssembly component. 

This component exports `wasi:http/handler@0.3.0` to serve
the registry API and stores every blob, manifest, and tag through the async,
native-stream [`wasmcloud:blobstore@0.1.0`][wasmcloud-blobstore] interface, so it
runs against any blobstore backend (in-memory, filesystem, NATS, …) without code
changes.

The registry implementation this component provides is spec compliant and can be used as a drop-in target for real clients such as
[`oras`][oras] and `docker`/`podman`: blob CRUD, manifest CRUD, resumable
uploads, tag listing, and the referrers API.

[oci-dist]: https://github.com/opencontainers/distribution-spec/blob/main/spec.md
[oras]: https://oras.land
[wasmcloud-blobstore]: https://github.com/wasmCloud/wasmCloud/pull/5297

## Prerequisites

- `cargo` (Rust 2024 edition)
- `wash` 2.7.0 or later — stock releases build and run wasip3 components,
  enable the async `wasmcloud:blobstore` backend by default, and ship the
  built-in `wasmcloud:secrets` plugin that delivers the registry's
  controller URL and tenant from bind-time config.
- Optional, for the walkthrough: [`oras`](https://oras.land/docs/installation)

## Running with wash

```shell
wash dev
```

This builds the component and serves it on [http://localhost:8000](http://localhost:8000),
wiring up an HTTP server and the async blobstore host plugin.

The `dev.host_interfaces` entries in `.wash/config.yaml` route the blobstore
import to the **filesystem** backend rooted at `tmp/blobstore` (so registry
contents persist across `wash dev` restarts) and supply the tenant controller
URL and tenant through the built-in `wasmcloud:secrets` plugin — without the
secrets entry, the registry denies every request. Every request needs Basic
credentials whose password the controller accepts (the examples below use
`$TOKEN`, an access token or `dik_` API key for the tenant):

```yaml
dev:
  host_interfaces:
    - namespace: wasmcloud
      package: blobstore
      interfaces: [blobstore]
      version: "0.1.0"
      config:
        backend: filesystem    # omit this entry to use in-memory
        root: tmp/blobstore
    - namespace: wasmcloud
      package: secrets
      interfaces: [store, reveal]
      config:
        tenant-controller-url: http://127.0.0.1:8080
        tenant: dev
```

## Building

```shell
wash build
```

`wash build` runs the `cargo build --target wasm32-wasip2` from `.wash/config.yaml`;
the linker componentizes the result into a wasip3 component (imports
`wasmcloud:blobstore/*@0.1.0`, exports `wasi:http/handler@0.3.0`).

## Required Capabilities

1. `wasi:http` to receive registry requests (wasip3 `handler@0.3.0`)
2. `wasmcloud:blobstore` to persist blobs, manifests, and tags
3. `wasi:random` to mint upload-session identifiers
4. `wasmcloud:secrets` (`store` + `reveal`) to supply `tenant-controller-url` and `tenant`,
   served by the built-in `wasmcloud:secrets` plugin from bind-time config
5. `wasi:http/client` to call the tenant controller's `/v1/auth/whoami`
6. `wasi:clocks/monotonic-clock` for the authorization cache TTL

## Supported endpoints

| Operation         | Method   | Path                                            |
| ----------------- | -------- | ----------------------------------------------- |
| API version check | `GET`    | `/v2/`                                           |
| Initiate upload   | `POST`   | `/v2/<name>/blobs/uploads/`                       |
| Cross-repo mount  | `POST`   | `/v2/<name>/blobs/uploads/?mount=<digest>&from=<repo>` |
| Upload a chunk    | `PATCH`  | `/v2/<name>/blobs/uploads/<session>`             |
| Complete upload   | `PUT`    | `/v2/<name>/blobs/uploads/<session>?digest=<d>`  |
| Pull a blob       | `GET`    | `/v2/<name>/blobs/<digest>`                       |
| Check a blob      | `HEAD`   | `/v2/<name>/blobs/<digest>`                       |
| Delete a blob     | `DELETE` | `/v2/<name>/blobs/<digest>`                       |
| Push a manifest   | `PUT`    | `/v2/<name>/manifests/<reference>`               |
| Pull a manifest   | `GET`    | `/v2/<name>/manifests/<reference>`               |
| Check a manifest  | `HEAD`   | `/v2/<name>/manifests/<reference>`               |
| Delete a manifest | `DELETE` | `/v2/<name>/manifests/<reference>`               |
| List tags         | `GET`    | `/v2/<name>/tags/list[?n=&last=]`                 |
| List referrers    | `GET`    | `/v2/<name>/referrers/<digest>[?artifactType=]`   |

`<name>` may contain slashes (e.g. `library/nginx`). A `<reference>` is either a
tag or a `sha256:<hex>` digest. Both monolithic (single `PUT`) and chunked
(`PATCH` then `PUT`) blob uploads are supported, and uploaded content is verified
against the client-supplied digest before it is committed.

A few protocol details that the conformance suite exercises:

- **Chunked uploads** honor `Content-Range`: a chunk whose start offset doesn't
  match the current session length (out-of-order or replayed) is rejected with
  `416 Range Not Satisfiable`.
- **Tag listing** supports `n` (page size) and `last` (resume after a tag), and
  emits a `Link: ...; rel="next"` header when results are truncated.
- **Referrers**: pushing a manifest with a `subject` field indexes it (and sets
  the `OCI-Subject` response header); `GET .../referrers/<digest>` returns an OCI
  image index of the referring descriptors, filterable by `artifactType`.
- **Cross-repository mount**: `POST .../uploads/?mount=<digest>&from=<repo>`
  copies an existing blob into the target repository without re-uploading,
  returning `201` (or `202` with a normal upload session if the source blob
  isn't found). Automatic content discovery (`?mount=` without `from`) is not
  implemented — that variant returns a `202` upload session.
- Deleting a manifest by digest removes the content; deleting by tag only removes
  that tag (other tags pointing at the same digest are left intact).

## Try it with `oras`

```console
# Push an artifact
$ echo 'hello oci world' > hello.txt
$ oras push --plain-http -u x -p "$TOKEN" 127.0.0.1:8000/myrepo/artifact:v1 hello.txt:text/plain
...
Pushed [registry] 127.0.0.1:8000/myrepo/artifact:v1
Digest: sha256:...

# List tags
$ oras repo tags --plain-http -u x -p "$TOKEN" 127.0.0.1:8000/myrepo/artifact
v1

# Pull it back into a clean directory
$ mkdir /tmp/pulled && cd /tmp/pulled
$ oras pull --plain-http -u x -p "$TOKEN" 127.0.0.1:8000/myrepo/artifact:v1
$ cat hello.txt
hello oci world
```

## Serving Wasm components

Because it's a spec-compliant registry, this component can host `.wasm`
components as OCI artifacts — i.e. act as a component registry for the wasmCloud
toolchain. Push a built component with `wash oci push`, then pull it back with
any OCI client:

```console
# Push a built component to this registry (--insecure = plain HTTP; the
# password is your controller credential)
$ wash oci push --insecure --user x --password "$TOKEN" \
    localhost:8000/library/oci-registry:0.1.0 \
    target/wasm32-wasip2/release/oci_registry.wasm
OCI command executed successfully.

# Pull it back — wash, wkg, and oras all consume it, byte-for-byte identical
$ wash oci pull --insecure --user x --password "$TOKEN" localhost:8000/library/oci-registry:0.1.0   # -> /tmp/component.wasm
$ wkg  oci pull localhost:8000/library/oci-registry:0.1.0 --insecure localhost:8000 -o out.wasm
$ oras pull --plain-http -u x -p "$TOKEN" localhost:8000/library/oci-registry:0.1.0
```

`wash oci push` stores a canonical Wasm OCI artifact — verify what the registry
is serving:

```console
$ curl -s -u "x:$TOKEN" localhost:8000/v2/library/oci-registry/manifests/0.1.0 | jq '{config: .config.mediaType, layer: .layers[0].mediaType, size: .layers[0].size}'
{
  "config": "application/vnd.wasm.config.v0+json",
  "layer": "application/wasm",
  "size": 373980
}

$ curl -s -u "x:$TOKEN" localhost:8000/v2/library/oci-registry/tags/list
{"name":"library/oci-registry","tags":["0.1.0"]}
```

The layer digest equals the `sha256` of the original `.wasm`, so the component
round-trips through the registry unchanged.

> To have a wasmCloud host *run* a component straight from this registry,
> reference `localhost:8000/library/...:<tag>` as the `image` in a wadm manifest.
> The host must be configured to allow the insecure (plain-HTTP) registry and
> given credentials for it, otherwise it refuses the pull.

## Try it with `curl`

```console
# API version check
$ curl -i -u "x:$TOKEN" http://127.0.0.1:8000/v2/
HTTP/1.1 200 OK
docker-distribution-api-version: registry/2.0

# Monolithic blob upload: initiate, then PUT with the digest
$ BLOB='example blob'
$ DIGEST="sha256:$(printf '%s' "$BLOB" | shasum -a 256 | cut -d' ' -f1)"
$ LOC=$(curl -s -u "x:$TOKEN" -D - -o /dev/null -X POST \
    http://127.0.0.1:8000/v2/demo/blobs/uploads/ \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="location"{print $2}')
$ curl -i -u "x:$TOKEN" -X PUT "http://127.0.0.1:8000${LOC}?digest=${DIGEST}" --data-binary "$BLOB"
HTTP/1.1 201 Created
docker-content-digest: sha256:...

# Pull the blob back
$ curl -u "x:$TOKEN" "http://127.0.0.1:8000/v2/demo/blobs/${DIGEST}"
example blob
```

## How it works

Every object lives in one blobstore container (`oci-registry`), keyed by
repository name:

| Kind             | Object key                              |
| ---------------- | --------------------------------------- |
| Blob             | `<name>/blobs/sha256_<hex>`             |
| Manifest content | `<name>/manifests/sha256_<hex>`         |
| Manifest type    | `<name>/manifests/sha256_<hex>.mediatype` |
| Tag → digest     | `<name>/tags/<tag>`                      |
| Upload session   | `<name>/uploads/<session-id>`           |
| Referrer         | `<name>/referrers/<subject>/<manifest>` |

Digests contain a `:` separator that is not portable across all blobstore
backends, so it is replaced with `_` in object keys. Blobs are content-addressed
and scoped per repository; tags are small pointer objects holding the digest they
resolve to, and each referrer is a stored descriptor keyed by its subject.

## Conformance

This example passes the official OCI distribution-spec conformance suite across
all four categories (pull, push, content discovery, content management). See
[`conformance.md`](./conformance.md) for how to build and run the suite against
this registry.

## Limitations

- Authentication is HTTP Basic only, enforced on every request (including the
  `/v2/` version probe) and decided by the tenant controller (see
  [Authorization](#authorization)). Token auth (the OCI auth flow real
  registries use) is not implemented.
- **Streaming** takes advantage of the native `wasmcloud:blobstore` `stream<u8>`
  bodies where it can: blob **pulls** (`GET`) pipe the blobstore `get-data`
  stream straight into the HTTP response, and **monolithic** blob pushes stream
  the request body into the blobstore while hashing it, so neither holds the
  layer in memory. Two paths still buffer: **manifests** (small JSON that must be
  hashed and parsed for `subject`/referrers) and **chunked `PATCH`** uploads —
  `wasmcloud:blobstore` has no append, so each chunk rewrites the whole session
  object and the finalizing `PUT` streams that buffered prefix first.
- Cross-repository mount requires an explicit `from` repository; automatic
  content discovery (`?mount=` without `from`) is not implemented and returns a
  normal upload session.
