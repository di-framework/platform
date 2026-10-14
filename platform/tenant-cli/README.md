# @di-framework/tenant-cli

Pilot of the tenant CLI that never speaks Kubernetes. It holds one credential per account, an
identity-server token or a tenant API key, and every action is a call to the tenant controller's
OpenAPI contract. Kubeconfigs exist only inside the controller. The cut-over criterion and the
command set are platform issue #40; the prototype it starts from is `../tenant-auth`.

## The contract is the shared artifact

`api/v1/openapi.yaml` is committed and generated, never edited:

```text
src/api/contracts/*-v1.codegen.ts   manifests (operations, paths, schemas)
src/api/schemas.ts                  JSON schemas published under components.schemas
src/api/handlers.ts                 the server side; every operation answers 501 in the pilot
src/api/generated/**                @di-framework/codegen output: typed routes and validators
api/v1/openapi.yaml                 emitted from the generated @Endpoint metadata
src/client/schema.d.ts              openapi-typescript output
src/client/index.ts                 the typed client; its paths are checked against `paths`
src/client/sse.ts                   the one hand-written transport: text/event-stream framing
```

```sh
bun run generate        # di-framework generate, then the document, then the client types
bun test                # includes a drift check: the committed document must match the manifests
```

An operation added to a manifest shows up in the document and in `paths`; a path the client
references that is no longer in the contract fails `tsc`. That is the whole drift story.

Streaming operations (`logs`) are SSE: each `log` event's `data` is one `LogEvent` as JSON, and
`end` closes the stream. The spec names this in the operation description; the framing itself is
`src/client/sse.ts`. `logs` requires `env` (`prod` or `staging`), as the contract says: the
controller answers 400 without it and streams only that environment's lines (platform#106).

## Using the client

`@di-framework/tenant-cli/client` is the published entry point: the typed `/v1` client
(`createClient`, `ControllerError`, `events`, and the request/response types). It ships compiled
(`dist`, with `.d.ts`), so consumers need no `.ts` import support. The package also installs the
`di-tenant` command, which requires Bun (its shebang is `bun`).

The `./src/api/*` export is workspace-internal: `../tenant-auth` uses it inside this repository, and it
is not usable from the npm package (`src` is not published).

```ts
import { createClient } from '@di-framework/tenant-cli/client';

const info = await createClient({ baseUrl: 'https://controller.example' }).authInfo();
```

`api/v1/openapi.yaml` ships alongside as the contract. `bun run build` produces `dist`.

### Test fixtures

`@di-framework/tenant-cli/testing` exports `deployBundle(overrides?)`: a complete, valid
`DeployBundle` as the CLI renders it, fresh on every call. The tenant controller's deploy tests and
other consumers of the deploy contract import it so both sides agree on the shape. Pin it to the
same version as `./client`. It is a separate entry so test code stays out of `./client`, and it has
no runtime dependencies.

```ts
import { deployBundle } from '@di-framework/tenant-cli/testing';

const bundle = deployBundle({ env: 'staging' });
```

## Registry

Each tenant gets its own OCI registry component in its namespace (platform#83, decision in
platform#52). Nothing is minted: you log in to the registry with your own identity. Use your
identity-server access token or a `dik_` API key as the Basic password (the username is ignored).
The registry asks the tenant controller's `GET /v1/auth/whoami` who the caller is: a developer may
push and pull, a viewer may only pull.

`GET /v1/deploy/registry` (viewer or developer) returns `RegistryInfo`: the registry `url` (an
origin: scheme + host[:port], no path), an optional `repositoryPrefix`, `auth` (`basic-identity`)
and a fixed `username` hint (`token`). The tenant controller reads the origin from
`TENANT_CONTROLLER_REGISTRY_URL` (`{tenant}` is replaced by the tenant), which the platform sets
when its `tenantAuth.registry` config is present; otherwise the endpoint answers 503
`no registry is configured for this tenant`. While a registry is configured but not served (a
host conflict or a suspended tenant) it answers 503 `the tenant registry is not available; see
the Tenant's TenantAuthReady condition`. The origin must be `https://`; plain `http://` is
accepted only for loopback (`localhost`, `127.0.0.0/8`, `[::1]`) and in-cluster hosts (`*.svc`,
`*.svc.cluster.local`).

`di-tenant registry` prints the URL, the login host, and the push prefix. `di-tenant registry
login` logs in with the credential you are already logged in with (an identity token is
refreshed first, so the stored copy gets its full lifetime); it never prints the token or key:

```text
di-tenant registry                       # url, login host, push prefix
di-tenant registry login                 # checks GET <url>/v2/, then writes the Docker config
di-tenant registry login --with podman   # or docker / oras: the password goes to its stdin
di-tenant registry logout                # undoes the last registry login, no controller call
```

Before any credential is sent, the URL the controller returned is checked at least as strictly
as the controller's own rule: a bare `https:` origin (no userinfo, path, query, or fragment), or
`http:` only for loopback and `*.svc` / `*.svc.cluster.local` hosts. On top of that, the host must
be a DNS name of letter, digit, and hyphen labels (no `_`, no trailing dot), an IPv4 address, or a
bracketed IPv6 address, so a few names the controller accepts are refused here. The `/v2/` check
does not follow redirects.

Without `--with`, `registry login` stores `token:<credential>` for the host under `auths` in the
Docker config (`--config <file>`, else `$DOCKER_CONFIG/config.json`, else
`~/.docker/config.json`), keeping every other entry, with mode `0600`. docker, oras, and helm read
that file; podman reads it through `--authfile` or `REGISTRY_AUTH_FILE`. If the file names a
`credsStore` or `credHelpers` entry for the host, docker consults the helper instead, so use
`--with docker`. With `--with`, the tool runs
`login --username=token --password-stdin [--plain-http | --tls-verify=false] -- <host>` (the
plain-HTTP switch for oras or podman on an `http:` origin only).

`registry login` records the host and where it stored the login with the account, plus the
sha256 of the Docker config entry it wrote. Docker keys entries by host alone and tenants often
share one (`127.0.0.1:<port>`), so a logout removes the entry only while it still matches that
fingerprint; if another account's `registry login` or your own `docker login` replaced it, the
entry is kept with a warning.

- `registry logout` removes the recorded login without a controller call, so it works after a
  login has expired. For a `--with` login it runs `<tool> logout -- <host>`, which removes
  whatever that tool holds for the host.
- `registry logout --host <host> [--config <file> | --with <tool>]` removes the entry for that
  host whatever it holds.
- `logout` removes the recorded Docker config entry (same fingerprint rule), since it holds the
  same token or key. It never runs `<tool> logout` for a `--with` login, because that cannot be
  checked; it prints the command to run instead.
- A login stored through a Docker credential helper (`credsStore`) is the helper's to remove.

By hand, log in against the host of `url`, not the full URL, then push to
`<host>/<repositoryPrefix>/<name>:<tag>`:

```text
oras login <host>
docker login <host>
oras push <host>/<repositoryPrefix>/<name>:<tag> ...
```

An `http:` origin means plain HTTP (loopback or in-cluster only): pass `oras --plain-http` or
`wash --insecure`. The platform serves the registry over HTTPS through the gateway, since the Basic
password is an identity credential. Its certificate is the tenant controller's, so trust the
tenant's CA (ConfigMap `tenant-controller-ca`) as you do for the controller. `di-tenant` itself
uses the CA stored with the login (see [Controller CA](#controller-ca)) for the `/v2/` check;
the push tools need their own trust, for example `oras --ca-file`,
`/etc/docker/certs.d/<host>/ca.crt`, or `~/.config/containers/certs.d/<host>/ca.crt` for podman.

Identity access tokens expire, so a stored `docker login` stops working; a `dik_` API key suits CI.

### Which reference a workload uses

Push to the registry's public origin (`url` above), but reference the same repository on the
in-cluster pull host in the workload you deploy: tenant hosts pull from
`tenant-registry.di-runtime-<tenant>.svc` (no port), with a platform-managed pull credential, not
from the public origin, which is a gateway or port-forward address the hosts cannot use. Both
names serve the same repositories:

```text
oras push registry.acme.localhost:28180/web:1.0.0 ...            # push (your credential)
# workload component image:
tenant-registry.di-runtime-acme.svc/web@sha256:<digest>           # pull (the tenant's hosts)
```

`/v1/deploy` and `/v1/deploy/preview` refuse (`422`) a bundle whose component or service image
names the public origin, and the problem `detail` gives the in-cluster reference to use instead.

## Commands

```text
login --controller <url> [--account <tenant>] [--api-key <key>] [--ca-file <pem> | --no-ca] [--no-browser]
logout | whoami
deploy preview|apply --env <prod|staging> --bundle <file>
logs --service <name> --env <env> [--deployment <id>] [--follow] [--since <dur>] [--tail <n>]
services create <keyvalue|messaging|blobstore|postgres|egress> --name <name> --env <env> [--class] [--storage] [--memory] [--cpu] [--deletion-policy] [--destination]
deployments list|stats --env <env> [--service <name>]
deployments rollback --service <name> --env <env> [--to <id>]
secrets|vars list|set|update|unset <name> --env <env> [--from-file <path|->]
registry [info] | registry login [--config <file> | --with <docker|podman|oras>]
registry logout [--host <host>] [--config <file> | --with <docker|podman|oras>]
proxy --service <name> --env <env> [--port <n>]
init [name] [--dir <path>] [--name <name>] [--force]
```

Shared flags: `--env`, `--json`, `--account` (or `DI_TENANT_ACCOUNT`, or the only login on disk).
There is no token argument. Secret and var values come from `--from-file` or stdin (`-`), so they
stay out of shell history. `secrets unset` fails with 409 while a deployed workload injects the
secret; `vars unset` succeeds but prints `warning: …` naming the deployed workloads that inject
the env's vars (platform#100). `init` writes a minimal di-framework seed and creates no platform
resources.

## Login

`login --controller <url>` asks the controller's one public operation (`GET /v1/auth/info`) for
the account, the identity issuer, and the public client id, then runs the RFC 8252 flow: a
loopback listener on a free port is the redirect URI, the browser signs in at the issuer, and the
code comes back with the PKCE verifier and `client_id` only, no secret. The identity server must
register that client (`AUTH_CLI_CLIENT_ID`; loopback redirects match on any port). The tokens are
stored under `$DI_FRAMEWORK_HOME/credentials.json` with the issuer and client id; a token within a
minute of expiry is refreshed before the next command, and `logout` revokes the refresh token at
the issuer and tells the controller. `--api-key` skips the browser; `--no-browser` prints the URL
instead of opening it.

## Controller CA

The tenant controller serves TLS with a certificate from the tenant's own CA (ConfigMap
`tenant-controller-ca`, key `ca.crt`). `login --ca-file <ca.crt>` trusts it, on top of the public
roots, for every call to that controller and for the registry check. The CA is stored with the
credential as `controller.certificateAuthorityData` (base64 PEM, the field the console writes),
so later commands need no flag, and a later `login` to the same controller URL keeps it. After the
CA rotates, log in again with the new `--ca-file`, or with `--no-ca` to drop the stored CA and
rely on the system roots or `NODE_EXTRA_CA_CERTS`. Identity issuer calls do not use it.
`NODE_EXTRA_CA_CERTS=<ca.crt>` still works process-wide. A certificate chain that is not trusted
fails with a `tls:` error that names both options; an expired or revoked certificate does not
get that hint.

## What the pilot does not do yet

- Building the component and rendering the bundle: `deploy` sends a bundle file. The CLI-side
  build that produces it is shared with `cli-plugin-platform` and is the next step.
- The controller: `../tenant-auth` serves `services create` and `services proxy`; operations it
  does not implement yet answer 501. The controller grows the endpoints behind this contract, importing the generated routes from `src/api/generated`.
- The `proxy` session URL is an HTTP passthrough the controller serves outside the document (`/v1/services/<service>/proxy/<session>/...`); WebSocket is not supported yet. The session URL takes its origin from the Host the caller reached (the controller has no configured public URL); the passthrough uses a 60 s idle timeout, keeps relative `Location` redirects under the session URL, and marks every request as external with `X-Forwarded-*` so workload control paths stay closed. It sends `Host: <service>-<env>` (the session's env), the host the deploy lane sets as `config.host` on the bundle's `wasi:http` host interface; a bundle must leave `config.host` out or set it to that value.
