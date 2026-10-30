# @di-framework/tenant-auth

## Local Rust image tooling

From the repository root, `cargo run --locked -p tenant-auth-image` builds the
image into local storage. Set `SMOKE_CHECK=true` to check both bundled entry
points. `PUSH=true` additionally publishes the image; `make publish` in this
directory enables both publishing and the smoke check.

The tool uses `oci-builder` from the `oci-lib` Git tag `v0.1.10`, declared in the root workspace.
The library handles the macOS guest and entitlement. The consumer does not
patch the guest, TLS, or MTU. Its signature policy accepts unsigned Bun base
images and local storage images, with HTTPS verification enabled.

Registry defaults: `DI_OCI_REGISTRY=ghcr.io`,
`DI_OCI_REPOSITORY=di-framework/tenant-auth`, and `DI_OCI_TAG` defaults to Git
HEAD. Set `DI_OCI_USERNAME`/`DI_OCI_PASSWORD`, `GHCR_USERNAME`/`GHCR_TOKEN`, or
`GITHUB_ACTOR`/`GITHUB_TOKEN` for publication. Successful pushes write
`dist/publish-report.json` with the immutable manifest digest.

`cargo build` compiles the tool; image operations run only when the executable
is invoked. CI builds and smoke-checks on native Linux amd64 and arm64 runners;
the publish workflow (on each push to `main` that changes its inputs) combines their manifests into an OCI index.

Per-tenant access for the platform without sharing cluster credentials. One **controller** and
one **console** run per tenant, in the tenant's namespace. Users hold only identity-server tokens
or tenant API keys; Kubernetes tokens never leave the controller.

The package provides a tenant controller and console that run **inside the cluster**, in the
tenant's runtime namespace. The platform controller's tenant reconcile deploys both when platform
config `tenantAuth` is set; see "Tenant controller and console" in `platform/platform/README.md`.
The tenant CLI is `di-tenant` in `@di-framework/tenant-cli`.

## Model

```
 CLI / kubectl ──bearer: identity token or API key──► tenant controller ──bearer: user's SA token──► kube-apiserver
                                                       │  UserInfo + User CR membership              (existing RBAC,
                                                       │  path policy: tenant namespaces only          quotas, admission)
 browser ──────────────────────────────────────────► tenant console ──as the user──► controller
                                                       OIDC relying party to identity-server
```

* **Controller** (`src/controller.ts`): an authenticating reverse proxy in front of the Kubernetes
  API. It resolves the bearer (identity-server access token via UserInfo, or `dik_…` API key),
  requires an organization membership *and* a platform `User` CR membership for its tenant, mints
  a short-lived token for `di-user-<user>` through TokenRequest and caches it, and forwards only
  requests whose path stays inside `di-tenant-<t>` and `di-runtime-<t>` (plus discovery and
  self-subject reviews so kubectl works). Permissions are the user's own, so developer and viewer
  roles, quotas, and admission policies apply unchanged. It also owns API keys (`/-/keys`), the
  member list (`/-/members`), and `/-/whoami`. It needs no OAuth client secret.
* **Console** (`src/console.ts`): the OIDC relying party. It signs users in and
  renders overview, logs, members, and API-key pages by calling the controller as the user. It
  also serves `/cli/*` token endpoints (info, exchange, refresh, logout); no client in this repo
  uses them now that the prototype CLI is removed. It holds no cluster credential.
* **CLI** (`di-tenant` in `@di-framework/tenant-cli`): `login` runs the browser flow and stores a
  JSON credential (tokens and metadata, mode 0600) under `~/.di-framework`. It talks to the tenant
  controller only. See `platform/tenant-cli/README.md` for commands and flags.
* **API keys**: `dik_<id>_<secret>`, SHA-256 hash stored as a Secret in `di-apikeys-<t>`, a
  namespace that holds only keys and that tenant users cannot read (#379). Keys made before
  #379 are in `di-runtime-<t>`; the controller also reads them there until the platform reports
  them moved (`status.apiKeysMigrated` on the Tenant). A key is a bearer token in its own right and acts as its creator,
  only in its tenant. Revocation is deletion.
* **Revocation points**: expiry (identity access tokens are 10 min; refresh rotates), console
  logout (revokes the refresh token), key revoke, and the `User` CR: suspending it deletes the
  ServiceAccount, so even cached tokens fail; the controller re-mints once on a 401 so a
  reinstated user recovers without a restart.
* **Audit**: one JSON line per login, refresh, logout, token mint, proxied request, key event,
  and denial. Tokens and keys never appear.

## Image

The controller and console ship as one container image, `ghcr.io/di-framework/tenant-auth`, built by
`platform/tenant-auth/Dockerfile` (context: the repository root). It bundles both entry points with
`bun build --target bun` onto a stock `oven/bun` 1.4 Alpine base (itself pinned by digest) and runs as uid
1000 on a read-only root. The Deployment picks the process with `command`:

* controller: `bun /app/controller.js` (HTTPS, default `:8788`)
* console: `bun /app/console.js` (HTTP, default `:8787`)

A container image was chosen over an OCI bundle on a stock Bun image because Kubernetes pulls and
verifies it natively by digest, with no init step or volume plugin, and one digest pins both the code
and the runtime. The tenant reconcile's Deployments therefore:

* mount no code (it is in the image);
* keep a `/tmp` emptyDir (the root filesystem is read-only);
* set `TENANT_CONTROLLER_HOST=0.0.0.0` and `TENANT_CONSOLE_HOST=0.0.0.0`;
* mount the TLS certificate and key (`TENANT_CONTROLLER_TLS_CERT`, `TENANT_CONTROLLER_TLS_KEY`);
* roll when the image digest changes.

The `Publish tenant-auth image` workflow publishes it by itself on each push to `main` that changes
one of its input paths, unless `ghcr.io/di-framework/tenant-auth:src-<hash>` (a hash of those
committed inputs, `scripts/source-check.ts`) already exists. A manual run (`workflow_dispatch`)
always builds. The workflow summary prints the reference, and a bot PR (`bot/pin-tenant-auth`,
`chore: pin tenant-auth to <digest>`) updates the digest below and in `platform/platform/README.md`.
GitHub does not run workflows on a PR that `GITHUB_TOKEN` opened, so a maintainer has to start its
checks (close and reopen it) before merging. **Pin consumers by digest**, never by tag. Latest
published:

```yaml
image: ghcr.io/di-framework/tenant-auth@sha256:872780d5c65c30224deecf1256342a419a9dc5e08f8623c70907f7b2851ecd43
```

Publishing needs the organization to allow Actions to write packages (issue #13).

## Deploy

The platform controller's tenant reconcile deploys the controller and console for every Tenant
once platform config `tenantAuth` names the image (by digest), the issuer and the console's OAuth
client Secret. It owns the ServiceAccounts, RBAC, NetworkPolicy, controller certificates,
Deployments, Services and gateway routes, and reports problems on the Tenant's `TenantAuthReady`
condition. The fields, the objects it creates, and the migration from objects created by hand are
in "Tenant controller and console" in `platform/platform/README.md`. To reach the pair without
gateway routes:

```sh
kubectl -n di-runtime-acme port-forward svc/tenant-controller 8788:8788 &
kubectl -n di-runtime-acme port-forward svc/tenant-console 8787:8787 &
```

The earlier manual deploy script (#58) is removed; use the reconcile, or run the pieces outside
the cluster as described below.

Why `di-runtime-<t>` and not `di-tenant-<t>`: developers can edit any Secret or ConfigMap in the
tenant namespace that the admission policy does not reserve by name, so there they could read the
console's client secret. The controller's code runs from the image, not a mount. In the runtime
namespace tenant users only have pods and logs. Moving to `di-tenant-<t>` needs the
`backend-config` admission policy to reserve the `tenant-auth-*` and `tenant-controller-*` names.

Local identity-server: a developer's browser can only be relied on to reach `localhost`, and Bun
resolves every `*.localhost` name to loopback regardless of `/etc/hosts`. With a loopback issuer,
`tenantAuth.issuerUpstream` (or `issuerIp`) gives each pod a `socat` sidecar that forwards the
issuer port to where identity-server really listens. With a resolvable issuer hostname,
`issuerIp` becomes a `hostAliases` entry instead; with a real DNS name neither is needed.

### identity-server as a platform guest

With the identity-server Wasm guest deployed to tenant `identity` (`di-framework platform deploy
identity`, Postgres BackingService `directory`, runtime secrets loaded into
`identity_runtime_secret`, gateway route `identity.identity.localhost`), the console and
controller point at it with platform config:

```yaml
tenantAuth:
  image: ghcr.io/di-framework/tenant-auth@sha256:872780d5c65c30224deecf1256342a419a9dc5e08f8623c70907f7b2851ecd43
  issuer: http://identity.identity.localhost:28280
  issuerUpstream: di-platform-gateway.wasmcloud.svc.cluster.local:80
  issuerUpstreamPodPort: 8080
  oauthClient: { id: access, secretName: tenant-auth-oauth } # key `clientSecret`: the AUTH_ACCESS_CLIENT_SECRET row
```

The `.localhost` issuer makes Bun use loopback, so the sidecar forwards the port to the platform
gateway, which routes by `Host`. A new image digest rolls both pods.

`GET /v1/services/:service/logs` streams a service's projected log lines as server-sent events.
`env` selects the environment: the platform projects each /v1 deployment into its own
`di-logs-<service>.<env>` ConfigMap and records each line's deployment and env
(`data.deployments`, `data.envs`). Lines of a workload outside /v1 whose application label equals
the service name are never served. During the move from the ConfigMap staging and prod shared
before (`di-logs-<service>`), its lines are still read, each in the env of its recorded deployment;
lines published before deployments were recorded are served in every env.

Verified on `authproto` on 2026-10-09 with the guest from identity-server `main` (Argon2 in the
composed `pqc-subtle` component) and the tenant CLI pilot in `platform/tenant-cli`:

- `GET /v1/auth/info` on the controller returns the guest issuer and `clientId: tenant-cli`.
- `di-tenant login --controller https://127.0.0.1:8788 --account acme --no-browser` printed the
  authorize URL at the guest; the browser sign-in as `alice` (a bootstrap user of the guest's
  directory) plus consent landed on the loopback page, and the CLI stored the credential. `whoami`
  answered `alice (developer) in acme via identity`.
- kubectl with the identity token against the controller: `kubectl auth whoami` reported
  `system:serviceaccount:wasmcloud:di-user-alice`; `get pods -n di-runtime-acme` listed the
  tenant's pods; `get pods -n wasmcloud` and `get nodes` were refused with `outside account acme`.
- `logout` revoked at the guest: the old access token then got 401 from `/userinfo` and the
  refresh token `invalid_grant` from `/oauth2/token`. The credential file was emptied.
- The identity host logged no errors and no request got a 503 during the flow.

`wasmcloud:postgres@0.2.0` gives the guest `query` calls with no connection affinity: the host's
Postgres plugin serves the guest's named import from a pool, one free connection per call, so a
`BEGIN` on one call never covers the next. (No shipped tenant host image pins a connection per
invocation: the invocation-lease patch was dropped, #63, #13.) The identity guest
therefore runs in autocommit and keeps every single-use and last-owner rule in one statement; see
"Transaction semantics on wasmCloud" in identity-server's `docs/guest-http-api.md`. Nothing on
the platform side changed for this.

Setup, in order: deploy the guest, load the runtime secret rows (issuer, JWK, access client
redirect `<console>/oidc/callback`, bootstrap organization and users, which the guest creates the
table for on first boot), then let the first request finish bootstrap. The guest hashes the
bootstrap passwords with Argon2id in a composed Wasm component (milliseconds per hash since
identity-server#47; it was about 30 s per hash in QuickJS before) and stores a fingerprint, so
later boots skip the hashing. If a boot ever outlives the gateway's 60 s timeout again, make one
direct request through the tenant's `di-http` service (`Host: identity`) and wait for it.

## Run the pieces outside the cluster

Needs a cluster from `di-framework-kube up --platform-config …` with a tenant and users, and
identity-server with an organization of the same slug, users with the same logins, and a browser
client whose redirect URI is `<console>/oidc/callback`.

```sh
# controller (TLS strongly recommended: kubectl sends the bearer to this address)
TENANT_CONTROLLER_TENANT=acme TENANT_CONTROLLER_KUBECONFIG="$(di-framework-kube kubeconfig --name <i>)" \
TENANT_CONTROLLER_TLS_CERT=controller.crt TENANT_CONTROLLER_TLS_KEY=controller.key bun src/controller.ts

# console
TENANT_CONSOLE_TENANT=acme TENANT_CONSOLE_CLIENT_ID=tenant-auth TENANT_CONSOLE_CLIENT_SECRET=… \
TENANT_CONSOLE_CONTROLLER_URL=https://localhost:8788 TENANT_CONSOLE_CONTROLLER_CA=controller.crt bun src/console.ts
```

`bun run start` runs the controller and `bun run start:console` the console.

The runtime variables below are frozen: deployments (#58) depend on these names and defaults, so
renaming or removing one is a breaking change.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TENANT_CONTROLLER_TENANT` / `TENANT_CONSOLE_TENANT` | required | The tenant this pair serves |
| `TENANT_CONTROLLER_KUBECONFIG` | none (in-cluster ServiceAccount) | Kubeconfig the controller uses; unset, it uses its own ServiceAccount |
| `TENANT_CONTROLLER_CONTEXT` | the kubeconfig's `current-context` | Context selected from that kubeconfig |
| `TENANT_CONTROLLER_PLATFORM_NAMESPACE` | `wasmcloud` | Where `di-user-*` ServiceAccounts live |
| `TENANT_CONTROLLER_ISSUER` / `TENANT_CONSOLE_ISSUER` | `http://localhost:4180` | identity-server |
| `TENANT_CONTROLLER_TLS_CERT`, `_TLS_KEY` | none | Serve HTTPS |
| `TENANT_CONTROLLER_TOKEN_TTL` | `3600` | Lifetime of the ServiceAccount tokens it forwards with |
| `TENANT_CONTROLLER_CLI_CLIENT_ID` | `tenant-cli` | The identity server's public native client that `GET /v1/auth/info` names for the tenant CLI |
| `TENANT_CONSOLE_CLIENT_ID`, `_CLIENT_SECRET` | `tenant-auth`, required | The console's confidential OAuth client |
| `TENANT_CONSOLE_CONTROLLER_URL`, `_CONTROLLER_CA` | `https://localhost:8788` | How the console reaches the controller |
| `TENANT_CONSOLE_CONTROLLER_PUBLIC_URL` | `TENANT_CONSOLE_CONTROLLER_URL` | Controller URL the console shows to users and CLIs |
| `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT_HTTPS` | set by Kubernetes, `443` | In-cluster API server when no kubeconfig is given |
| `TENANT_CONTROLLER_HOST`, `TENANT_CONTROLLER_PORT` | `127.0.0.1`, `8788` | Controller listen address |
| `TENANT_CONTROLLER_WHOAMI_PORT` | none | Listener serving only `GET /v1/auth/whoami` (problem+json errors), for the tenant registry's callback (platform#83). TLS only, with the `TENANT_CONTROLLER_TLS_CERT` certificate (platform#113): it requires `TENANT_CONTROLLER_TLS_CERT` and `_TLS_KEY` (the controller refuses to start without them), and a plain-HTTP connection is closed without an answer. At most 256 connections at once; a caller has 30 s from sending until the answer starts |
| `TENANT_CONTROLLER_REGISTRY_FRONT_PORT` | none | TLS listener (the controller certificate) that forwards every request, credentials included, to the tenant hosts as the registry (platform#83) |
| `TENANT_CONTROLLER_REGISTRY_HOST` | `registry` | `Host` the registry front sends: the registry workload's `wasi:http` host; `/v1/deploy` refuses a `<service>-<env>` equal to it |
| `TENANT_CONTROLLER_REGISTRY_PULL_PORT` | none | The tenant hosts' pull-only listener (platform#83 `:host-pull`): the registry front for `GET`/`HEAD` only (`405` otherwise). NetworkPolicy admits only the tenant host pods |
| `TENANT_CONTROLLER_REGISTRY_PULL_TLS` | `true` | `false` serves the pull listener over plain HTTP. The platform never sets it: tenant hosts pull this listener over TLS and allow plain HTTP only for the registries named with `--insecure-registry` (platform#149) |
| `TENANT_CONTROLLER_REGISTRY_PULL_HOST` | none | In-cluster registry host workloads reference (`tenant-registry.di-runtime-<tenant>.svc`); `/v1/deploy` refuses a guest image on the public registry origin and names this host instead |
| `TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE` | none | File holding the host pull token. The whoami listener (only) answers `Bearer <token>` as `{user: system:tenant-host, role: viewer, via: host-pull}`, so the registry allows pulls and nothing else. Read on every call, so a rotated token applies without a restart |
| `TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES` | `536870912` (512 MiB) | Largest request body the registry front accepts; larger is `413` |
| `TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS` | `60000` | Wait for the registry's response headers, counted from when the request body has been forwarded in full; then `504` |
| `TENANT_CONTROLLER_REGISTRY_UPLOAD_IDLE_TIMEOUT_MS` | `60000` | How long an upload may deliver no byte while the front waits for one; then `408`. A steady upload of any length succeeds |
| `TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT` | `16` | Registry front requests at once; more are `503`. Requests without Basic credentials get the registry's `401` challenge at the front and take no slot |
| `TENANT_CONTROLLER_REGISTRY_URL` | none | Registry origin `GET /v1/deploy/registry` returns; `{tenant}` is replaced. https, or http only for loopback and `*.svc` hosts |
| `TENANT_CONSOLE_HOST`, `TENANT_CONSOLE_PORT` | `127.0.0.1`, `8787` | Console listen address |
| `TENANT_CONSOLE_PUBLIC_URL` | `http://<TENANT_CONSOLE_HOST>:<TENANT_CONSOLE_PORT>` | Browser-visible console URL |

CLI: `di-tenant` in `@di-framework/tenant-cli`; see `platform/tenant-cli/README.md` for commands and flags.

## Secrets and vars storage contract

`/v1/secrets` and `/v1/vars` (platform#53) store tenant configuration in `di-tenant-<tenant>`,
written with the caller's own identity. The deploy lane (platform#55) injects them as follows.

**Vars.** One ConfigMap per environment:

- name `di-vars-<env>` (`di-vars-prod`, `di-vars-staging`);
- labels `platform.di-framework.dev/config: vars` and `platform.di-framework.dev/env: <env>`;
- one data key per var, named like an environment variable (`^[A-Za-z_][A-Za-z0-9_]*$`), holding
  its value;
- annotation `platform.di-framework.dev/updated-at`: a JSON object mapping each var name to the
  RFC 3339 time it was last written.

The name `di-vars-<env>` is reserved by this contract. If a ConfigMap of that name exists without
the `config: vars` label, the endpoints refuse to write it (409); they never adopt it.

**Secrets.** One ordinary Secret per secret and environment:

- name `<name>.<env>` (for example `db-password.prod`), where `<name>` is a DNS-1123 label that
  starts with a letter (`^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$`, so the derived environment variable
  name is valid) and is not a managed name (`di-binding-*`, `di-bs-*`; see `isManagedSecretName`);
- labels `platform.di-framework.dev/config: secret`, `platform.di-framework.dev/env: <env>` and
  `platform.di-framework.dev/secret: <name>`;
- a single data key, the environment variable name of the secret: `<name>` upper-cased with `-`
  replaced by `_` (`db-password` becomes `DB_PASSWORD`);
- annotation `platform.di-framework.dev/updated-at` with the RFC 3339 time of the last write.

The endpoints only touch Secrets that carry the `config: secret` label; values never leave the
controller on read. Writes carry the `resourceVersion` they read (replace and delete), so a
concurrent write, or a create that races another, is a 409 `changed concurrently; retry`.

**Write-only for developers (#112).** The `di-developer` Role grants Secrets `create`, `update`
and `delete` only: no `get`, `list` or `watch`, and no `patch`, whose response returns the whole
object. Viewers have no Secret access. Every Secret read the endpoints and deploy need (the list
of names and update times, the `resourceVersion` read before replace and delete, the existence
and label checks, the var/secret clash checks) runs as the tenant controller's own ServiceAccount;
every Secret write runs as the calling user, as a `POST` create or a `PUT` full replace, never a
`PATCH`. No response or log carries Secret data. Those controller reads ask for metadata only
(`PartialObjectMetadata`/`PartialObjectMetadataList`), so Secret values never reach the
controller process, and a 401/403 on them is a controller error (502, detail in the audit as
`request.failed`), not a denial of the caller.

A Secret `DELETE` answers with the object, data included. The platform's `tenant-secret-delete`
ValidatingAdmissionPolicy therefore refuses, for `di-user-*` ServiceAccounts, every Secret delete
that could answer without removing it: `dryRun`, `propagationPolicy` `Orphan` or `Foreground`
(or `orphanDependents`), and a Secret that already has finalizers or a `deletionTimestamp`. The
controller's kubectl proxy replaces the body of a successful Secret `DELETE` with a bare `Status`.
The proxy makes its path policy and this redaction on one canonical path, which is also the path
it forwards: each segment is percent-decoded once (`%73ecrets` is `secrets`), and a path with an
empty segment (`//secrets`), a malformed escape, or a segment decoding to `.`, `..`, or text with
`/` (`secrets%2Fname`), `\`, `%` (double encoding) or a control character is refused with 403.
The redaction is defense in depth only: tenant users also receive a token kubeconfig for their
ServiceAccount and can reach the API server without the proxy, so the admission policies above
are what keep Secret values from being returned.

Developers replace Secrets they cannot read, so the `tenant-secret-update` policy guards every
Secret `UPDATE` by a `di-user-*` ServiceAccount (`stringData` is already folded into `data` when
it runs). It denies, with these exact messages (cli-plugin-platform matches them to map the
console's Secret reassignment errors):

| Case | Message | CLI status |
| --- | --- | --- |
| the target is platform-managed (`di-binding-*`, `di-bs-*`) | `tenant users cannot update platform-managed di-binding-*/di-bs-* Secrets` | 403 |
| the update drops a key the Secret already has | `tenant users may update a Secret only if it keeps every existing data key` | 409 |

Same-key replaces (the `/v1` secret set and update, the CLI `<workload>-control` Secret, the app's
`<workload>-secrets` Secret) and
updates that add keys stay allowed. Match by substring: a managed name may also trip the older
`backend-config` message first.

Write-only stops direct reads, not use: a developer can still deploy a workload that injects a
tenant Secret of the env (`secretFrom`) and have it print the value in a response or a log.
Managed `di-bs-*`/`di-binding-*` credentials stay blocked from injection by the workload policy.

**One name, one source.** A var and a secret that map to the same environment variable name in
the same environment are a conflict. The endpoints refuse it at write time with 409: setting a
var named like an existing secret's environment variable, or a secret whose environment variable
is an existing var. The deploy lane (platform#55) must still reject a bundle that meets such a
pair (for example one created out of band) with 422; it never picks a precedence.

**Unset and deployed workloads (platform#100).** Deleting a Secret a running workload injects
stops its replicas from being placed (`Config=False … Secret "<name>.<env>" not found`); removing
a var only drops that key from the workload's environment, since the vars ConfigMap stays. So
before an unset, the endpoints list the tenant's WorkloadDeployments as the caller and look at
every guest's `localResources.environment` (`components[*]` and `service`):

- `DELETE /v1/secrets/<name>?env=<env>` is **refused** with 409 when any of them lists
  `<name>.<env>` in `secretFrom`. The problem+json `detail` names them, sorted (`secret
  verify-token is referenced by deployed workloads in staging: greeter-staging; …`), and nothing
  is deleted. It succeeds (204) once nothing references it: destroy the workload, or redeploy it
  without the secret in `secrets`.
- `DELETE /v1/vars/<NAME>?env=<env>` **succeeds with a warning**. It answers 200 with a `VarUnset`
  body, `{ "warnings": [...] }`: when any workload lists `di-vars-<env>` in `configFrom`, one
  `{ "code": "referenced", "detail": "...", "deployments": [...] }` entry names them, sorted;
  otherwise `warnings` is empty. Workloads inject the whole ConfigMap, not single keys, so every
  var of that env counts as referenced while such a workload exists. `di-tenant vars unset`
  prints each warning to stderr as `warning: <detail>`.

A name that does not exist is still a 404 first, and set and update are never affected. The
check reads the live objects, so a workload applied out of band counts too; a failed read is a
502 (a denied one a 403) that leaves the secret or vars unchanged. The check is best-effort, not
transactional: Kubernetes has no transaction across the Secret and the WorkloadDeployments. A
deploy that already read the secret before the unset listed workloads, and applies its
WorkloadDeployment after that list but before the delete, still lands and then fails with
`Config=False`. A deploy that reads after the delete is refused by its own existence check (422).
An emptied vars ConfigMap is kept with no keys (platform#98).

**HTTP host and labels (platform#101, #103).** A service's HTTP host is `<service>-<env>`
(for example `greeter-staging`, `greeter-prod`), the WorkloadDeployment's own name, in every env.
The deploy lane sets `config.host: <service>-<env>` on the `wasi:http` host interface (keeping
its other `config` keys) and answers 422 to a bundle that sets a different `config.host`; leave
it out or set it to that value. The proxy passthrough sends `Host: <service>-<env>` using the
session's env. The WorkloadDeployment carries `app.kubernetes.io/managed-by: di-framework`,
`app.kubernetes.io/name: <service>-<env>` (as cli-plugin-platform renders it) and
`di-framework.dev/application: <service>` (the log projection key); ServiceBindings carry only
`managed-by` plus the service and env labels.

**WorkloadDeployment references (deploy lane, platform#55).** For a bundle deployed to `<env>`,
the deploy lane sets the label `platform.di-framework.dev/env: <env>` on the WorkloadDeployment
and **must** inject the same entries into every one of these paths:

- `spec.template.spec.components[].localResources.environment` (every component);
- `spec.template.spec.service.localResources.environment`, when the rendered WorkloadDeployment
  has a `service`, so the HTTP service and the components see the same config.

```yaml
configFrom:
  - name: di-vars-<env>         # every var of the environment
secretFrom:
  - name: <secret>.<env>        # one entry per name in the bundle's `secrets`
```

so each var and each referenced secret reaches the workload as an environment variable. A bundle
that names a secret with no `<secret>.<env>` Secret, or one without the labels above, is rejected
with 422 (the same status as the var/secret conflict).

**Reference rule for the tenant admission policy (platform#88).** This restricts what a
WorkloadDeployment may *reference*; it does not restrict which Secrets or ConfigMaps tenants may
create. On a WorkloadDeployment in `di-tenant-<t>`, every
`spec.template.spec.components[].localResources.environment` and
`spec.template.spec.service.localResources.environment` may reference only:

- `configFrom[].name` equal to `di-vars-<env>`;
- `secretFrom[].name` matching `^[a-z]([-a-z0-9]{0,61}[a-z0-9])?\.<env>$` (the `<name>` rule
  above, then `.<env>`), where the part before the dot is not a managed name
  (`isManagedSecretName`: `di-binding-*`, `di-bs-*`);
- a WorkloadDeployment may also reference exactly two Secrets named after itself, regardless of
  the env label, unless that name is managed (platform#203):
  - `<its own metadata.name>-control`: the control Secret cli-plugin-platform renders for HTTP
    workloads under `localResources.environment`. It holds only the CLI's control credentials
    (`DI_CONTROL_TOKEN`, `DI_CONTROL_IDENTITY`), and the CLI owns and rotates it on every deploy.
  - `<its own metadata.name>-secrets`: the app's runtime secrets (for example signing keys or
    `DI_PGLITE_KEY`). The app's own tooling writes it; the CLI never touches it.

  No other `<metadata.name>-*` name is allowed, and neither Secret of another workload is;
- no `imagePullSecret` (component or service) may be a managed name (`di-binding-*`, `di-bs-*`).

`<env>` is the value of the WorkloadDeployment's `platform.di-framework.dev/env` label: the
`.<env>` suffix of every referenced Secret and the `di-vars-<env>` name must equal it. Prod and
staging share the namespace, so the suffix alone cannot tell which environment a workload runs
in. A WorkloadDeployment without that label, or with a value other than `prod` or `staging` (for
example one applied with kubectl), may reference neither a `di-vars-*` ConfigMap nor a tenant
Secret.

## Deploy history

`/v1/deploy` and `/v1/deployments/rollback` store each deploy as a revision ConfigMap
`di-deploy-<service>-<env>.<n>` in the tenant namespace (labels `deploy-revision: <n>`,
service and env; annotations `revision-state` and `component`, plus `data.bundle` and its
sha256 in `data.digest`). Within a service/env the integer `<n>` alone orders revisions and
picks the rollback target; across services the list orders by `created-at`, then name. Lists
read metadata only (`PartialObjectMetadataList`); rollback fetches the one bundle it re-applies.
A rollback revision also carries the `rollback-of` annotation naming the revision it restores,
which `/v1` lists expose as `rollbackOf` when it is a valid revision id.

A deploy runs in this order: prune, reserve the revision as `pending` (on a 409 it takes the
next `<n>`, at most `RESERVE_ATTEMPTS` times, then answers 409), apply, mark it `live` and the
one it replaced `replaced`. A failed apply marks it `failed`. `deployments` lists `pending` and
`failed` revisions with that status; `stats` does not count them, and rollback never targets
them. Once the apply succeeded, a failure to mark the revisions is logged as
`deploy.history-mark-failed` and the deploy still answers 202.

**The workload names the running revision.** The deploy sets the annotation
`platform.di-framework.dev/revision: <service>-<env>.<n>` on the WorkloadDeployment it applies
(bundles cannot set it: they may only pass `app.di-framework.dev/` keys through). The running
revision of a service/env is the one its live WorkloadDeployment names, whatever the
ConfigMap marks say: list, stats and the default rollback target use it. A `pending` revision
the workload names reads as `live`, and any other `live` revision as `replaced`, so history
repairs itself after a crash between apply and mark and after out-of-order concurrent applies.
Reads only report the repair (viewers stay read-only); the next deploy writes it. A revision
repaired to `replaced` went live, but no deploy observed how its rollout ended: unless a status
was recorded, it lists as `rolling`, and the repair writes that status.

The namespace quota allows `count/configmaps: 100`, shared with `di-vars-<env>`, the `di-logs-*`
projections (one per /v1 service and env; see "Console log projection" in the platform README)
and `kube-root-ca.crt`, so history is bounded (constants in `src/v1/deploy.ts`):

* `HISTORY_PER_SERVICE_ENV = 10` revisions per service and env.
* `HISTORY_TENANT_BUDGET = 40` revisions in the tenant, evicting the oldest across services
  first. A revision a WorkloadDeployment runs is never evicted; the last revision of a
  destroyed or renamed service is.

If the revisions running workloads alone fill the budget (40 or more running workloads, only
possible when a tenant's `spec.resources.workloads` quota is at least 40), a deploy of a service
that runs no revision answers 507 before anything is applied. A deploy or rollback of a service
that runs one still goes ahead: the revision it replaces becomes evictable, and the next deploy
prunes it. Each such deploy holds one revision over the budget meanwhile, so K concurrent
redeploys can briefly reach 40 + K revisions; the `count/configmaps: 100` quota still bounds
them. Pruning happens before the revision is created. If the quota still refuses it (403
`exceeded quota`), the deploy answers 507 before anything is applied. Revisions edited by hand
out of this shape (non-integer label, name not matching the labels, bad `component`
annotation, unknown state) are skipped and logged as `deploy.revision-skipped`. A rollback
target whose `data.bundle` does not match `data.digest`, or is not a complete bundle, is a 422;
one a concurrent deploy pruned after the history was read is a 404.

## Removing deployments and services (platform#98)

Both operations are developer-only (viewers get 403) and run as the caller.

* `DELETE /v1/deployments/<service>?env=<env>` removes the service from that env: first its
  WorkloadDeployment `<service>-<env>` (running or not, so the workload is deleted before what
  it binds), then its ServiceBindings (the deploy labels and the `<service>-<env>-` prefix),
  then every revision ConfigMap `di-deploy-<service>-<env>.<n>`, including ones edited out of
  shape. It answers 204, or 404 when the env has none of them, and audits `deployment.removed`.
  The other env and the BackingServices the service bound are left alone. An object a
  concurrent call already deleted counts as deleted. The removal is not transactional: a deploy
  of the same service and env that is in flight (it reserved its revision before the removal
  deleted the history, and applies its workload after the removal deleted the workload) leaves
  a running workload with no history; its revision mark fails and is logged as
  `deploy.history-mark-failed`. Running the removal again deletes that workload and anything it
  bound.
* `DELETE /v1/services/<name>?env=<env>` deletes a BackingService. It is **refused** with 409
  while any ServiceBinding in the tenant names it in `spec.serviceName`, whatever its
  `deletionPolicy`; the `detail` names the binders, sorted (`<service>-<env>` for a deployed
  binding, the binding's own name for one applied out of band). Remove those deployments first.
  A service whose env annotation names the other env is a 404, as is a missing one; a service
  created without `/v1` (no annotation) can be deleted from either env. It answers 204 and
  audits `service.deleted` with the `deletionPolicy`. `deletionPolicy` decides only what the
  platform does with the service's data and storage afterwards: `Retain` (the default) keeps
  them, `Delete` removes them.

Unsetting the last var still leaves an empty `di-vars-<env>` ConfigMap, unchanged by this
issue: workloads deployed while it existed list it in `configFrom`, and deleting it would stop
their replicas from being placed, as a deleted secret does (platform#100 above).

## HTTP surface

Controller: `GET /-/healthz` (open); `GET /-/whoami`, `GET|POST /-/keys`, `DELETE /-/keys/:id`,
`GET /-/members` (bearer); everything else is proxied to the API server under the path policy.

Errors under `/v1/` are RFC 9457 `application/problem+json`, including the authentication refusals
raised before dispatch (platform#97): a missing or rejected credential is `401` with
`WWW-Authenticate: Bearer realm="di-framework-tenant"` (plus `error="invalid_token"` only when a
non-empty bearer token was sent; another scheme or an empty `Bearer` gets the bare challenge, as
RFC 6750 §3.1 asks), and a suspended account or a caller without a membership is `403`. An
identity or cluster outage is a `502` with a fixed detail. The detail never quotes the
credential. `/-/` and the Kubernetes proxy keep the Kubernetes `Status` body.

Console: `GET /login` (+ `cli_callback`, `cli_state`), `GET /oidc/callback`, `GET /logout`,
`GET /cli/info`, `POST /cli/exchange`, `POST /cli/refresh`, `POST /cli/logout` (unused by any client in this repo now that the prototype CLI is removed); pages `/`,
`/logs/:deployment` (lines of one WorkloadDeployment; the overview groups deployments by application and env), `/members`, `/keys`, `POST /keys`, `POST /keys/:id/revoke`.

Issuer outages (platform#489): the console and the controller both start serving before OIDC
discovery succeeds and retry it in the background (backoff doubling from 1 s to 30 s, without a
retry budget), so an unreachable issuer no longer crash-loops either pod. While discovery is
pending, `GET /healthz` (console) and `GET /-/healthz` (controller) answer `200` with
`discoveryReady: false`, so the pod stays Ready; each failed attempt logs a `discovery.failed`
line and success logs `discovery.succeeded`. On the console, `/cli/info` and the landing page
(with a "Sign-in is unavailable" notice) keep working, and the routes that need the issuer
(`/login`, `/cli/refresh`, and `/cli/logout` with a refresh token) answer `503` with
`Retry-After`; `/cli/refresh` does not report the login as expired. Once the issuer answers, the same process recovers without a restart.

## Verified against `di-framework-kube` (instance `authproto`, tenant `acme`)

With both services running as pods in `di-runtime-acme` and reached over port-forward: kubectl identifies as `system:serviceaccount:wasmcloud:di-user-alice` through the controller;
reads and writes in `di-tenant-acme` work; pods in `di-runtime-acme` list; `wasmcloud`,
cluster-scoped lists, and `User` CRs are refused by the controller before RBAC; RBAC still
decides inside the tenant; an expired access token is refreshed through the console; an API key
logs in from a second home and reaches the cluster; its Secret is unreadable by the user through
the proxy; suspending the user cuts access and unsuspending restores it; revoking the key and
logging out both stop access.

## Known gaps

* Console sessions, login flows, and the controller's token cache are in memory.
* The controller and console use `Recreate` strategy because a surge pod would not fit the
  runtime quota after platform components.
* The sidecar container can start after the app, which costs one restart; an init ordering or
  a startup probe would avoid it.
* `/-/members` reads the memberships the platform publishes in ConfigMap
  `tenant-controller-members` under `entries` (name, role and suspended each), suspended members
  included, and reads no `User` (platform#321). An entry without a boolean `suspended`, a known
  role or a name fails the request instead of showing a suspended member as active. A ConfigMap
  from an older platform has only `members` (active names): each `User` is then read by name, the
  controller may read only those, and suspended members are not shown. On a platform without that
  ConfigMap it lists every `User` instead.
* No WebSocket or SPDY upgrade through the proxy, so `kubectl port-forward` and `exec` do not
  work; logs with `--follow` stream fine.
* Login ↔ `User` name matching is by convention; a `spec.identity` field would make it explicit.
* Two concurrent first requests for a user can mint two tokens; harmless but wasteful.
* Server-rendered HTML; the PatternFly console in `cli-plugin-platform` is the intended UI.
