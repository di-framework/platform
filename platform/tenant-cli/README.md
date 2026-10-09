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
`src/client/sse.ts`.

## Registry

Each tenant gets its own OCI registry component in its namespace (platform#83, decision in
platform#52). Nothing is minted: you log in to the registry with your own identity. Use your
identity-server access token or a `dik_` API key as the Basic password (the username is ignored).
The registry asks the tenant controller's `GET /v1/auth/whoami` who the caller is: a developer may
push and pull, a viewer may only pull.

`GET /v1/deploy/registry` (viewer or developer) returns `RegistryInfo`: the registry `url` (an
origin: scheme + host[:port], no path), an optional `repositoryPrefix`, `auth` (`basic-identity`)
and a fixed `username` hint. Until #55/#83 serve it, the endpoint answers 501.

Log in against the host of `url`, not the full URL, then push to
`<host>/<repositoryPrefix>/<name>:<tag>`:

```text
oras login <host>
docker login <host>
oras push <host>/<repositoryPrefix>/<name>:<tag> ...
```

An `http:` origin means plain HTTP: pass `oras --plain-http` or `wash --insecure`. The registry is
expected over HTTPS through the gateway, since the Basic password is an identity credential.

Identity access tokens expire, so a stored `docker login` stops working; a `dik_` API key suits CI.

## Commands

```text
login --controller <url> [--account <tenant>] [--api-key <key>]
logout | whoami
deploy preview|apply --env <prod|staging> --bundle <file>
logs --service <name> --env <env> [--deployment <id>] [--follow] [--since <dur>] [--tail <n>]
services create <keyvalue|messaging|blobstore|postgres|egress> --name <name> --env <env> [--class] [--storage] [--memory] [--cpu] [--deletion-policy] [--destination]
deployments list|stats --env <env> [--service <name>]
deployments rollback --service <name> --env <env> [--to <id>]
secrets|vars list|set|update|unset <name> --env <env> [--from-file <path|->]
proxy --service <name> --env <env> [--port <n>]
init [name] [--dir <path>] [--name <name>] [--force]
```

Shared flags: `--env`, `--json`, `--account` (or `DI_TENANT_ACCOUNT`, or the only login on disk).
There is no token argument. Secret and var values come from `--from-file` or stdin (`-`), so they
stay out of shell history. `init` writes a minimal di-framework seed and creates no platform
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

## What the pilot does not do yet

- Building the component and rendering the bundle: `deploy` sends a bundle file. The CLI-side
  build that produces it is shared with `cli-plugin-platform` and is the next step.
- The controller: `../tenant-auth` serves `services create` and `services proxy`; operations it
  does not implement yet answer 501. The controller grows the endpoints behind this contract, importing the generated routes from `src/api/generated`.
- The `proxy` session URL is an HTTP passthrough the controller serves outside the document (`/v1/services/<service>/proxy/<session>/...`); WebSocket is not supported yet. The session URL takes its origin from the Host the caller reached (the controller has no configured public URL); the passthrough uses a 60 s idle timeout, keeps relative `Location` redirects under the session URL, and marks every request as external with `X-Forwarded-*` so workload control paths stay closed.
