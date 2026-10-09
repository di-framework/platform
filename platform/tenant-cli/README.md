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

## Using the client

`@di-framework/tenant-cli/client` is the published entry point: the typed `/v1` client
(`createClient`, `ControllerError`, `events`, and the request/response types). It ships compiled
(`dist`, with `.d.ts`), so consumers need no `.ts` import support. The package also installs the
`di-tenant` command.

```ts
import { createClient } from '@di-framework/tenant-cli/client';

const info = await createClient({ baseUrl: 'https://controller.example' }).authInfo();
```

`api/v1/openapi.yaml` ships alongside as the contract. `bun run build` produces `dist`.

## Commands

```text
login --controller <url> [--account <tenant>] [--api-key <key>]
logout | whoami
deploy preview|apply --env <prod|staging> --bundle <file>
logs --service <name> --env <env> [--deployment <id>] [--follow] [--since <dur>] [--tail <n>]
services create <http|cron|worker> --name <name> --env <env> [--port] [--route] [--schedule] [--command]
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
- The controller: every operation answers 501. `../tenant-auth`'s controller grows the
  endpoints behind this contract, importing the generated routes from `src/api/generated`.
- The `proxy` tunnel transport (WebSocket) is described outside the document.
