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
the dispatch-only publish workflow combines their manifests into an OCI index.

Per-tenant access for the platform without sharing cluster credentials. One **controller** and
one **console** run per tenant, in the tenant's namespace. Users hold only identity-server tokens
or tenant API keys; Kubernetes tokens never leave the controller.

The package provides a tenant controller and console that run **inside the cluster**, in the
tenant's runtime namespace. Both are deployed by `scripts/deploy-local.ts` (which stands in for the
platform controller's tenant reconcile). The tenant CLI is `di-tenant` in `@di-framework/tenant-cli`.

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
* **API keys**: `dik_<id>_<secret>`, SHA-256 hash stored as a Secret in `di-runtime-<t>`, which
  tenant users cannot read. A key is a bearer token in its own right and acts as its creator,
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
and the runtime. It will replace the ConfigMap bundle when `:reconcile` lands. `:reconcile` must:

* drop the `/app` ConfigMap mount (the code is in the image);
* keep the `/tmp` emptyDir (the root filesystem is read-only);
* set `TENANT_CONTROLLER_HOST=0.0.0.0` and `TENANT_CONSOLE_HOST=0.0.0.0`;
* mount the TLS certificate and key (`TENANT_CONTROLLER_TLS_CERT`, `TENANT_CONTROLLER_TLS_KEY`);
* use the image digest in place of the `bundle-digest` annotation.

Maintainers publish it with the `Publish tenant-auth image` workflow (`workflow_dispatch`); the
workflow summary prints the reference. **Pin consumers by digest**, never by tag:

```yaml
image: ghcr.io/di-framework/tenant-auth@sha256:<digest from the workflow summary>
```

Publishing needs the organization to allow Actions to write packages (issue #13).

## Deploy into a local cluster

```sh
bun scripts/deploy-local.ts --tenant acme \
  --kubeconfig "$(di-framework-kube kubeconfig --name <instance>)" \
  --issuer http://localhost:4180 --issuer-ip <this machine's LAN IP> \
  --client-secret <the console's OAuth client secret>
kubectl -n di-runtime-acme port-forward svc/tenant-controller 8788:8788 &
kubectl -n di-runtime-acme port-forward svc/tenant-console 8787:8787 &
```

The script bundles both entrypoints with `Bun.build`, ships them in a ConfigMap (as
`di-platform-controller` does), generates a private certificate for the controller, and applies:

* ServiceAccounts `tenant-controller` and `tenant-console` in `di-runtime-<t>`.
* RBAC for the controller only: `get` its own `Tenant`, `get`/`list` `User` CRs, `create`
  `serviceaccounts/token` in the platform namespace restricted by `resourceNames` to the tenant's
  members, Secrets in its own namespace for API keys, and `get`/`list` on Secrets in
  `di-tenant-<t>` (#112) so `/v1` can check tenant Secret names, labels and resourceVersions that
  developers are not allowed to read. It never returns or logs Secret data.
* A NetworkPolicy adding egress to the API server and the issuer; the tenant policy otherwise
  allows only tenant namespaces, DNS, and public `:443`.
* Deployments (strategy `Recreate`, 200m CPU limits) and ClusterIP Services.

Why `di-runtime-<t>` and not `di-tenant-<t>`: developers can edit any Secret or ConfigMap in the
tenant namespace that the admission policy does not reserve by name, so there they could replace
the controller's code or read the console's client secret. In the runtime namespace tenant users
only have pods and logs. Moving to `di-tenant-<t>` needs the `backend-config` admission policy
to reserve the `tenant-auth-*` and `tenant-controller-*` names.

Local identity-server: a developer's browser can only be relied on to reach `localhost`, and Bun
resolves every `*.localhost` name to loopback regardless of `/etc/hosts`, so with
`--issuer http://localhost:4180 --issuer-ip <ip>` each pod gets a `socat` sidecar that forwards
`127.0.0.1:4180` to the machine. With a resolvable issuer hostname the same flag becomes a
`hostAliases` entry instead; with a real DNS name neither is needed.

### identity-server as a platform guest

With the identity-server Wasm guest deployed to tenant `identity` (`di-framework platform deploy
identity`, Postgres BackingService `directory`, runtime secrets loaded into
`identity_runtime_secret`, gateway route `identity.identity.localhost`), the console and
controller point at it with:

```sh
bun scripts/deploy-local.ts --tenant acme ... \
  --issuer http://identity.identity.localhost:28280 \
  --issuer-upstream di-platform-gateway.wasmcloud.svc.cluster.local:80 \
  --client-id access --client-secret <AUTH_ACCESS_CLIENT_SECRET row>
```

The `.localhost` issuer makes Bun use loopback, so the sidecar forwards the port to the platform
gateway, which routes by `Host`. A redeploy with new code rolls both pods: the pod template
carries a digest of the bundle, because a ConfigMap update alone leaves the running processes on
the old code.

`GET /v1/services/:service/logs` streams a service's projected log lines as server-sent events.
Logs are scoped to the tenant namespace, not to an environment: `env` is accepted and ignored,
because the log projection carries no environment label.

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
`BEGIN` on one call never covers the next. (The invocation-lease patch in `platform/tenant-host`
pins a connection only for the unnamed import, which this guest does not use.) The identity guest
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
TENANT_CONSOLE_CONTROLLER_URL=https://127.0.0.1:8788 TENANT_CONSOLE_CONTROLLER_CA=controller.crt bun src/console.ts
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
| `TENANT_CONSOLE_CONTROLLER_URL`, `_CONTROLLER_CA` | `https://127.0.0.1:8788` | How the console reaches the controller |
| `TENANT_CONSOLE_CONTROLLER_PUBLIC_URL` | `TENANT_CONSOLE_CONTROLLER_URL` | Controller URL the console shows to users and CLIs |
| `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT_HTTPS` | set by Kubernetes, `443` | In-cluster API server when no kubeconfig is given |
| `TENANT_CONTROLLER_HOST`, `TENANT_CONTROLLER_PORT` | `127.0.0.1`, `8788` | Controller listen address |
| `TENANT_CONTROLLER_WHOAMI_PORT` | none | Plain-HTTP listener serving only `GET /v1/auth/whoami` (problem+json errors), for the tenant registry's callback (platform#83) |
| `TENANT_CONTROLLER_REGISTRY_FRONT_PORT` | none | TLS listener (the controller certificate) that forwards every request, credentials included, to the tenant hosts as the registry (platform#83) |
| `TENANT_CONTROLLER_REGISTRY_HOST` | `registry` | `Host` the registry front sends: the registry workload's `wasi:http` host; `/v1/deploy` refuses a `<service>-<env>` equal to it |
| `TENANT_CONTROLLER_REGISTRY_PULL_PORT` | none | The tenant hosts' pull-only listener (platform#83 `:host-pull`): the registry front for `GET`/`HEAD` only (`405` otherwise). NetworkPolicy admits only the tenant host pods |
| `TENANT_CONTROLLER_REGISTRY_PULL_TLS` | `true` | `false` serves the pull listener over plain HTTP, for platforms whose hosts run `--allow-insecure-registries` (every wash pull is then plain HTTP) |
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

Developers replace Secrets they cannot read, so the `tenant-secret-update` policy guards every
Secret `UPDATE` by a `di-user-*` ServiceAccount (`stringData` is already folded into `data` when
it runs). It denies, with these exact messages (cli-plugin-platform matches them to map the
console's Secret reassignment errors):

| Case | Message | CLI status |
| --- | --- | --- |
| the target is platform-managed (`di-binding-*`, `di-bs-*`) | `tenant users cannot update platform-managed di-binding-*/di-bs-* Secrets` | 403 |
| the update drops a key the Secret already has | `tenant users may update a Secret only if it keeps every existing data key` | 409 |

Same-key replaces (the `/v1` secret set and update, the CLI `<workload>-control` Secret) and
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
- a WorkloadDeployment may also reference `secretFrom: <its own metadata.name>-control` (the
  control Secret cli-plugin-platform renders for HTTP workloads under
  `localResources.environment`), regardless of the env label, unless that name is managed;
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
Reads only report the repair (viewers stay read-only); the next deploy writes it.

The namespace quota allows `count/configmaps: 100`, shared with `di-vars-<env>`, the `di-logs-*`
projections and `kube-root-ca.crt`, so history is bounded (constants in `src/v1/deploy.ts`):

* `HISTORY_PER_SERVICE_ENV = 10` revisions per service and env.
* `HISTORY_TENANT_BUDGET = 40` revisions in the tenant, evicting the oldest across services
  first. A revision a WorkloadDeployment runs is never evicted; the last revision of a
  destroyed or renamed service is.

If the revisions running workloads alone fill the budget (only possible when a tenant's
`spec.resources.workloads` quota is above 40), the deploy answers 507 before anything is
applied. Pruning happens before the revision is created. If the quota still refuses it (403
`exceeded quota`), the deploy answers 507 before anything is applied. Revisions edited by hand
out of this shape (non-integer label, name not matching the labels, bad `component`
annotation, unknown state) are skipped and logged as `deploy.revision-skipped`. A rollback
target whose `data.bundle` does not match `data.digest`, or is not a complete bundle, is a 422.

## HTTP surface

Controller: `GET /-/healthz` (open); `GET /-/whoami`, `GET|POST /-/keys`, `DELETE /-/keys/:id`,
`GET /-/members` (bearer); everything else is proxied to the API server under the path policy.

Console: `GET /login` (+ `cli_callback`, `cli_state`), `GET /oidc/callback`, `GET /logout`,
`GET /cli/info`, `POST /cli/exchange`, `POST /cli/refresh`, `POST /cli/logout` (unused by any client in this repo now that the prototype CLI is removed); pages `/`,
`/logs/:app`, `/members`, `/keys`, `POST /keys`, `POST /keys/:id/revoke`.

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
* The `resourceNames` list of members in the TokenRequest Role is computed at deploy time; the
  platform controller must keep it current on membership changes.
* The pair takes CPU from the tenant runtime quota (`di-runtime-quota`, 2 CPU limits total with
  the hosts already using 1.5), hence the small limits and `Recreate`; the reconcile should size
  the quota to include platform components.
* The sidecar container can start after the app, which costs one restart; an init ordering or
  a startup probe would avoid it.
* `/-/members` lists all `User` CRs and filters; a projected per-tenant member list would avoid
  exposing other tenants' memberships to the controller.
* No WebSocket or SPDY upgrade through the proxy, so `kubectl port-forward` and `exec` do not
  work; logs with `--follow` stream fine.
* Login ↔ `User` name matching is by convention; a `spec.identity` field would make it explicit.
* Two concurrent first requests for a user can mint two tokens; harmless but wasteful.
* Server-rendered HTML; the PatternFly console in `cli-plugin-platform` is the intended UI.
