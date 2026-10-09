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
- `src/lib.rs`: calls `auth::require_access` instead of `auth::require_basic`.
- `wit/world.wit`: adds `import wasi:http/client@0.3.0` and
  `wasi:clocks/monotonic-clock@0.3.0`.
- `wit/deps/`: the resolved WIT dependencies (`wkg wit fetch`, digests in
  `wkg.lock`) are committed so the build needs no registry access;
  `wit-overrides/secrets` is upstream's in-repo `wit/secrets/wit` at the same
  commit (`wkg.toml` points at it).
- `Makefile`, `scripts/build.sh`, `rust-toolchain.toml`, `package.json`,
  `package.test.ts`, `.wash/config.yaml` (dev config): di-framework build and
  test wiring, matching `sqlite-component` / `pglite-component`.

## Authorization

Clients log in with HTTP Basic. The **password** is the caller's own
credential (an identity-server access token or a `dik_` API key); the username
is ignored, so `docker login -u anything -p <token>` works. For every request,
including the `GET /v2/` probe, the registry:

1. Rejects a missing, non-Basic or empty-password `Authorization` header with
   `401` and `WWW-Authenticate: Basic realm="di-framework-tenant-registry"`.
2. Calls `GET <tenant-controller-url>/v1/auth/whoami` with
   `Authorization: Bearer <password>`.
3. Maps the operation by method: `GET` / `HEAD` (pull, existence checks, tag
   listing, referrers, the `/v2/` probe) need **read**; `POST` / `PUT` /
   `PATCH` / `DELETE` (uploads, mounts, manifest pushes, deletes) and any other
   method need **write**.
4. Allows read for `viewer` and `developer`, write for `developer` only. A
   `viewer` attempting a write gets `403 DENIED`.

Positive answers are cached for 30 s, at most 256 entries, keyed by the
SHA-256 of the credential (never the raw token); expired entries are evicted
first, then the one closest to expiry. Negative answers are never cached.

It **fails closed**: if `tenant-controller-url` is missing or malformed, the
controller is unreachable, or it answers anything other than a 2xx with a
`viewer` / `developer` role, the request gets the `401` challenge.

### Configuration

| Key                     | Source                                      | Example                                          |
| ----------------------- | ------------------------------------------- | ------------------------------------------------ |
| `tenant-controller-url` | `wasmcloud:secrets` (bind-time config)      | `http://tenant-auth-controller.acme.svc:8080`    |

The URL is read through the same `wasmcloud:secrets` `store` + `reveal`
imports upstream already used for its credentials, so the component's import
surface grows only by `wasi:http/client` and the monotonic clock; no
`wasi:config` host plugin is required. An optional path prefix is kept
(`https://host/prefix` calls `/prefix/v1/auth/whoami`).

### Why plain HTTP inside the namespace

The tenant controller serves HTTPS with a private CA. A component's outgoing
`wasi:http` request is made by the host (wash 2.x, wasmtime-wasi-http over
hyper + rustls), which verifies the server against the **host's** trust roots;
`wasi:http/types` has no per-request field for a custom CA, and the wasi-tls
work tracked for the tenant host (#81) concerns TLS the guest terminates or
originates itself over `wasi:sockets`, not the host's HTTP client. So
`https://` only works when the tenant's private CA is installed in every
tenant host's trust store, which couples the host image to each tenant's CA.

Chosen: the registry calls the controller over plain HTTP on its in-namespace
Service address (`http://<controller-service>.<namespace>.svc:<port>`). The
bearer credential then never leaves the tenant's namespace; `:reconcile` must
expose that HTTP port only on the cluster network and restrict it with a
NetworkPolicy to the tenant's host pods. Clients still reach the registry
itself over TLS through the gateway (`:reconcile` / #58 `:routes`). If the
CA is later trusted by the host, an `https://` URL works with no code change.

### Build and test

```shell
make test     # cargo test: role -> ops, cache TTL/bound/hash keys, fail-closed (fake controller)
make lint     # cargo fmt --check + clippy -D warnings
make build    # dist/di-framework-oci-registry.wasm (+ .wit, BUILD-INFO.txt, SHA256SUMS)
bun test platform/oci-registry   # artifact + provenance checks
```

`make build` needs rustup (honours `rust-toolchain.toml`: Rust 1.97.1,
`wasm32-wasip2`) and `wasm-tools`. CI builds and tests it in `.github/workflows/ci.yml`.
Nothing is published from here yet.

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
  built-in `wasmcloud:secrets` plugin that delivers the registry's Basic auth
  credentials from bind-time config.
- Optional, for the walkthrough: [`oras`](https://oras.land/docs/installation)

## Running with wash

```shell
wash dev
```

This builds the component and serves it on [http://localhost:8000](http://localhost:8000),
wiring up an HTTP server and the async blobstore host plugin.

The `dev.host_interfaces` entries in `.wash/config.yaml` route the blobstore
import to the **filesystem** backend rooted at `tmp/blobstore` (so registry
contents persist across `wash dev` restarts) and supply the Basic auth
credentials through the built-in `wasmcloud:secrets` plugin — without the
secrets entry, the registry denies every request:

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
4. `wasmcloud:secrets` (`store` + `reveal`) to supply `tenant-controller-url`,
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
$ oras push --plain-http 127.0.0.1:8000/myrepo/artifact:v1 hello.txt:text/plain
...
Pushed [registry] 127.0.0.1:8000/myrepo/artifact:v1
Digest: sha256:...

# List tags
$ oras repo tags --plain-http 127.0.0.1:8000/myrepo/artifact
v1

# Pull it back into a clean directory
$ mkdir /tmp/pulled && cd /tmp/pulled
$ oras pull --plain-http 127.0.0.1:8000/myrepo/artifact:v1
$ cat hello.txt
hello oci world
```

## Serving Wasm components

Because it's a spec-compliant registry, this component can host `.wasm`
components as OCI artifacts — i.e. act as a component registry for the wasmCloud
toolchain. Push a built component with `wash oci push`, then pull it back with
any OCI client:

```console
# Push a built component to this registry (--insecure = plain HTTP, no auth)
$ wash oci push --insecure \
    localhost:8000/library/oci-registry:0.1.0 \
    target/wasm32-wasip2/release/oci_registry.wasm
OCI command executed successfully.

# Pull it back — wash, wkg, and oras all consume it, byte-for-byte identical
$ wash oci pull --insecure localhost:8000/library/oci-registry:0.1.0   # -> /tmp/component.wasm
$ wkg  oci pull localhost:8000/library/oci-registry:0.1.0 --insecure localhost:8000 -o out.wasm
$ oras pull --plain-http localhost:8000/library/oci-registry:0.1.0
```

`wash oci push` stores a canonical Wasm OCI artifact — verify what the registry
is serving:

```console
$ curl -s localhost:8000/v2/library/oci-registry/manifests/0.1.0 | jq '{config: .config.mediaType, layer: .layers[0].mediaType, size: .layers[0].size}'
{
  "config": "application/vnd.wasm.config.v0+json",
  "layer": "application/wasm",
  "size": 373980
}

$ curl -s localhost:8000/v2/library/oci-registry/tags/list
{"name":"library/oci-registry","tags":["0.1.0"]}
```

The layer digest equals the `sha256` of the original `.wasm`, so the component
round-trips through the registry unchanged.

> To have a wasmCloud host *run* a component straight from this registry,
> reference `localhost:8000/library/...:<tag>` as the `image` in a wadm manifest.
> The host must be configured to allow the insecure (plain-HTTP, no-auth)
> registry, otherwise it refuses the pull.

## Try it with `curl`

```console
# API version check
$ curl -i http://127.0.0.1:8000/v2/
HTTP/1.1 200 OK
docker-distribution-api-version: registry/2.0

# Monolithic blob upload: initiate, then PUT with the digest
$ BLOB='example blob'
$ DIGEST="sha256:$(printf '%s' "$BLOB" | shasum -a 256 | cut -d' ' -f1)"
$ LOC=$(curl -s -D - -o /dev/null -X POST \
    http://127.0.0.1:8000/v2/demo/blobs/uploads/ \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="location"{print $2}')
$ curl -i -X PUT "http://127.0.0.1:8000${LOC}?digest=${DIGEST}" --data-binary "$BLOB"
HTTP/1.1 201 Created
docker-content-digest: sha256:...

# Pull the blob back
$ curl "http://127.0.0.1:8000/v2/demo/blobs/${DIGEST}"
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
