# @di-framework/tenant-auth

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
  members, and Secrets in its own namespace for API keys. It cannot read tenant Secrets.
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

**Secrets.** One ordinary Secret per secret and environment:

- name `<name>.<env>` (for example `db-password.prod`), where `<name>` is a DNS-1123 label that
  is not a managed name (`di-binding-*`, `di-bs-*`; see `isManagedSecretName`);
- labels `platform.di-framework.dev/config: secret`, `platform.di-framework.dev/env: <env>` and
  `platform.di-framework.dev/secret: <name>`;
- a single data key, the environment variable name of the secret: `<name>` upper-cased with `-`
  replaced by `_` (`db-password` becomes `DB_PASSWORD`);
- annotation `platform.di-framework.dev/updated-at` with the RFC 3339 time of the last write.

The endpoints only touch Secrets that carry the `config: secret` label; values never leave the
controller on read.

**WorkloadDeployment references.** For a bundle deployed to `<env>`, every component of the
rendered WorkloadDeployment gets, under `localResources.environment`:

```yaml
configFrom:
  - name: di-vars-<env>         # every var of the environment
secretFrom:
  - name: <secret>.<env>        # one entry per name in the bundle's `secrets`
```

so each var and each referenced secret reaches the component as an environment variable. A
bundle that names a secret without a `<secret>.<env>` Secret labelled as above is rejected.

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
