# Platform

`@di-framework/cli-plugin-platform` is a [CLI extension](https://docs.di-framework.dev/cli.html#extensions) that builds a
di-framework HTTP application into a WASI 0.3 WebAssembly component, serves it locally, and
deploys it from a workspace manifest.

The extension publishes from
[di-framework/cli-extensions](https://github.com/di-framework/cli-extensions). Managed cluster
lifecycle is `platform cluster up` and `platform cluster destroy`.

```bash
di-framework extensions install platform
```

`@di-framework/platform` **6.0.30**, `@di-framework/bindings` **6.0.30**, and
`@di-framework/cli-plugin-platform` **6.3.0** include tenant kubeconfigs, the HTTP gateway,
controller-backed deployment targets, blobstore, egress, per-tenant runtime operators, and the
console behavior described below. `di-framework-kube` installs `@di-framework/platform@6.0.29`
by default unless you pass `--platform-package @di-framework/platform@6.0.30`. See
[Kubernetes with di-framework-kube](kube.md).

The extension mounts one command group:

```text
di-framework platform
├── build
├── dev
├── deploy
├── destroy
├── login
├── logout
├── whoami
├── logs
├── secrets
│   ├── list
│   ├── set
│   ├── update
│   └── unset
├── vars
│   ├── list
│   ├── set
│   ├── update
│   └── unset
├── console
├── service
│   ├── create
│   ├── list
│   ├── get
│   ├── delete
│   └── classes
├── cluster
│   ├── init
│   ├── up
│   └── destroy
└── doctor
```

| Command | Purpose |
| --- | --- |
| `build [--bundle <out.json>]` | Bundle the application entry and componentize it for WASI HTTP, or build, push, and write a controller-compatible `DeployBundle` JSON file with `--bundle`. |
| `dev` | Build, then serve locally with wasmtime, wash, or jco. |
| `deploy [name] [--preview]` | Build, publish, and apply a wasmCloud `WorkloadDeployment` for a project, or preview the deployment plan on controller-backed targets with `--preview`. |
| `destroy [name]` | Remove that project's generated `WorkloadDeployment` and `Service` (or delete the controller deployment). Never tears down the platform. |
| `login` / `logout` / `whoami` | Log in to a tenant controller over `/v1` (OIDC browser PKCE or `--api-key`), revoke a stored credential, or display the authenticated principal and role. |
| `logs [service]` | Read or follow service logs from the tenant controller over `/v1` (`--env`, `--deployment`, `--follow`, `--since`, `--tail`). |
| `secrets <list\|set\|update\|unset> [name]` | List, set, update, or unset environment secrets via the tenant controller `/v1` API (`--env`, `--from-file`, `--value`). |
| `vars <list\|set\|update\|unset> [name]` | List, set, update, or unset environment variables via the tenant controller `/v1` API (`--env`, `--from-file`, `--value`). |
| `service create <keyvalue\|messaging\|blobstore\|postgres\|egress> --name <name>` | Request Redis, NATS, blobstore, dedicated PostgreSQL, or approved egress in a tenant namespace. |
| `console [--port <port>]` | Open the tenant control panel on loopback. |
| `service list` / `service get <name>` | Inspect BackingService readiness, class, and endpoint summaries. |
| `service delete <name>` | Delete the BackingService request according to its retention policy. |
| `service classes` | Discover cluster classes, with a fallback to built-in defaults. |
| `cluster init` | Generate `deploy/platform` from extension templates and register it as the default `local` target. |
| `cluster up [<target>]` | Provision a managed platform target (`pulumi up`: k0s, registry, wasmCloud operator). |
| `cluster destroy [<target>]` | Tear down a managed platform target (`pulumi destroy`) only. |
| `doctor` | Check the project and local toolchain for wasmCloud readiness. |

`--target` is optional for `build --bundle`, `deploy`, `destroy`, `login`, `logout`, `whoami`,
`logs`, `secrets`, `vars`, `console`, `service`, `cluster up`, and `cluster destroy` when
`default-target` is set. Cluster commands also accept a positional target.

Run these commands directly. Do not wrap them in `package.json` scripts.

As with every extension, the commands follow the [CLI contract](https://docs.di-framework.dev/cli.html): the same help forms,
`--json` envelope, and exit-status table apply.

## Backing services

`@di-framework/platform` **6.x** provisions independent Redis, NATS, blobstore, dedicated
PostgreSQL, and approved egress from tenant `BackingService` requests and projects
`ServiceBinding` configuration into protected ConfigMaps and Secrets. Use `platform service` to
create and inspect requests. The controller owns provisioning; CLI commands use the target
kubeconfig and Kubernetes RBAC.

Dedicated PostgreSQL requests and `serviceName` wiring on a `Postgres` binding are supported;
blobstore uses `configFrom`. See [Platform backing services](backing-services.md).

## Project convention

A component project is marked by `di-framework.config.json` in the project root:

```json
{
  "name": "my-app",
  "entry": "src/app.ts",
  "output": "dist/my-app.wasm"
}
```

The configured `name` is the only project identity. `name` and `entry` are required; `output`
defaults to `dist/<name>.wasm`. Both paths must stay inside the project directory. There is no
`apps` classifier and no required `apps/` directory — projects may live in any layout.

The entry module default-exports a Fetch-compatible handler: a
`(request: Request) => Response | Promise<Response>` function or an object with such a `fetch`
method. A `@di-framework/http` `TypedRouter` works as-is.

The extension owns the WebAssembly/WASI boundary. `build` bundles the entry behind a
WASI-HTTP-to-Web-Fetch adapter exporting `wasi:http/handler@0.3.0`. It generates the guest world
and `wit.lock.json` from the application's WIT requirements, then componentizes with
`@di-framework/componentize-qjs`. This wasmtime-48 fork supports the imported async functions
used by native service bindings. Set `DI_FRAMEWORK_COMPONENTIZE_QJS` to override the resolved CLI.
Intermediate build state lives in the disposable `.di-framework/` directory; the finished
component is written to the configured `output` path. JSON `data` contains `application`,
`component`, `entry`, and `profile`.

Logs are on by default. To opt out in `di-framework.config.json`:

```json
{ "name": "quiet-app", "entry": "src/app.ts", "logs": false }
```

`logs` must be a boolean and applies per workload member. With `false`, build emits no
`wasi:logging` import and deploy sets annotation `di-framework.dev/logs: "false"`. Guest console
lines are not published. Host WARN/ERROR lines for that workload still are, including a failed
start; the console still marks the failure. Omitting the flag or setting `true` keeps logs on.

## Native service bindings

Install `@di-framework/bindings` alongside core and HTTP. `@di-framework/bindings` and
`@di-framework/platform` publish from
[di-framework/platform](https://github.com/di-framework/platform). The
[kube example workspace](kube.md#deploy-the-examples) links DI Framework **6** packages from
sibling checkouts for local verification. Declare exported binding classes in `src/bindings.ts`, or select another file with
`"bindings": "src/services/bindings.ts"` in the project configuration:

```typescript
import { Container } from '@di-framework/core/decorators';
import { Config, PlatformBinding, Postgres } from '@di-framework/bindings';

@PlatformBinding('orders-database', {
  config: { database: 'orders' },
  secretFrom: 'orders-database-binding',
})
@Container()
export class OrdersDatabase extends Postgres {}

@PlatformBinding('app-config', {
  config: { greeting: 'Hello' },
  configFrom: 'orders-config',
})
@Container()
export class AppConfig extends Config {}
```

These host capabilities are not [private service bindings](https://docs.di-framework.dev/service-bindings.html)
(`@ExportService` / `@ServiceBinding`). Application-authored bindings are an in-process DI
contract inside one component; native bindings are WIT imports generated from `@PlatformBinding`
classes (`@WasmCloudBinding` remains exported as a deprecated alias for backward compatibility).

Resolve these classes through `useContainer().resolve(...)` or inject them with `@Component`.
The build discovers the declarations statically, creates real WIT imports in
`.di-framework/guests.js`, and initializes those guests before application evaluation. This
includes services resolved at module startup.

| Class | WIT capability | Version |
| --- | --- | --- |
| `Postgres` | `wasmcloud:postgres` | `0.2.0` |
| `KeyValue` | `wasmcloud:keyvalue` | `0.2.0` |
| `Blobstore` | `wasmcloud:blobstore` | `0.1.0` |
| `Messaging` | `wasmcloud:messaging` | `0.3.0` |
| `Config` | `wasi:config` | `0.2.0-rc.1` |
| `Secrets` | `wasmcloud:secrets` | `2.1.0` |
| `OutgoingHttp` | `wasi:http/client` | `0.3.0` |

These WIT package versions are independent of both the framework version and the WASI 0.3
component-model preview. The bindings consume services. The platform can provision Redis and
NATS, blobstore, and dedicated PostgreSQL through [BackingService requests](backing-services.md).
Application host configuration must match the guest imports.
`configFrom` references a ConfigMap and `secretFrom` references a Kubernetes Secret. For capabilities that use a Secret,
an omitted `secretFrom` defaults to `<application>-<binding>`. Keep credentials out of inline
`config` and project files.

For PostgreSQL, configure the native host's connection through `WASH_POSTGRES_URL` and select
the database with the binding's `config.database`. A Secret reference on the binding alone
does not configure that host connection. See the [working PostgreSQL example](kube.md#postgresql-binding)
for provisioning and verification. Tag query parameters and decode result cells with
[`@di-framework/repo/postgres`](https://docs.di-framework.dev/repositories.html#wasmcloud-postgresql-values). The host binds
parameters in binary, so an untagged value is rejected when the column type differs.

### Host interface discovery

QuickJS emits unlabeled WIT imports. The extension omits `hostInterfaces[].name` for
PostgreSQL, key-value, blobstore, messaging, and secrets so the host selects the provider route
that can link those imports. Binding names still select the guest and configuration overlay.
Unnamed config and outgoing HTTP requirements also retain their class's `config`, `configFrom`,
and `secretFrom` overlays.

HTTP ingress and outgoing requirements share one unnamed host declaration per WIT version.
The runtime links HTTP `client` and key-value `types` internally, so they remain in guest WIT
imports but are omitted from host discovery.

The kube examples verify one binding of each kind. Multiple labeled, independently
credentialed backends are outside that verification; the QuickJS PostgreSQL path uses the
host connection and does not support separate credentials per named binding.

## Node compatibility and permissions

The plugin uses unenv plus WASI-backed implementations for the Node APIs below. This is a
compatibility layer inside QuickJS, with a different filesystem and process model from Node.

| API | Guest behavior |
| --- | --- |
| `node:path`, `Buffer` | Provided through the Node compatibility preset. |
| `node:fs` | In-memory except under the storage mount (`/data`, or `DI_STORAGE_DIR`), which uses the host preopen. Missing files report `ENOENT`; selected project config files are seeded at build time. |
| `process`, `node:module` | Guest-shaped environment and working directory; `createRequire` reports `MODULE_NOT_FOUND`. |
| `node:net`, `node:dgram` | TCP, UDP, and name lookup over WASI 0.3 sockets. |
| `node:http` | HTTP/1.1 over the TCP implementation, including chunked request and response bodies and upgrade support. |
| `node:crypto` | WASI randomness, hashes, HMAC, and a Web Crypto subset including HKDF, AES-GCM, and ECDH P-256. |
| `node:timers`, global timers | WASI monotonic clock; cancellation, refresh, and ref/unref flags. Flags do not control process lifetime in a component. |
| `node:async_hooks` | AsyncLocalStorage context scopes and binding; transformed Promise continuations and timer callbacks retain context. |
| `node:tls` | Client `connect` / `TLSSocket` over `wasi:tls/client@0.3.0-draft`, including STARTTLS on an existing `node:net` socket. Requires a TLS-enabled host. Guest `createServer` is unsupported. |
| `node:https` | HTTP/1.1 `request` / `get` and an Agent over the TLS implementation; requests wait for verified `secureConnect` before sending. Incoming HTTPS terminates at host ingress. |
| `node:child_process` | Remains an unenv mock. |
| Fetch globals | `Request`, `Response`, `URL`, `URLSearchParams`, `Headers`, and `FormData` when the host global is missing or incomplete. `URLSearchParams` treats `+` as a space, and `set`, `append`, and `delete` write back to `URL.search`. `FormData` supports `request.formData()` and `multipart/form-data` posts, including file parts. `Headers` provides `keys`, `values`, and `getSetCookie`. Guest `POST` bodies complete on the WASI HTTP 0.3 body future. |

Text encoding and Fetch globals initialize before application imports. The bundler lowers
async functions and `for await` loops to instrumented Promise continuations; native
async-generator bodies and dynamically evaluated async code are not instrumented.

The filesystem seed includes `.json`, `.yaml`, `.yml`, `.toml`, and `.env` files from the
project, subject to size limits and excluded directories. These become component content:
use runtime bindings for secrets. Markdown skill files are not automatically seeded.

WASI DNS lookups require an explicit project allowlist:

```json
{
  "name": "socket-app",
  "entry": "src/app.ts",
  "allowedIpNameLookups": ["echo.wasmcloud.svc.cluster.local"]
}
```

On targets without a `hostgroup`, deploy writes this list to
`localResources.allowedIpNameLookups`. Tenant targets request platform-approved egress instead
(see below). Omission leaves default denial in place. Socket, clock, randomness, and TLS imports
are runtime WASI capabilities, not wasmCloud `hostInterfaces`.

TLS requires a host with the opt-in `wasi-tls` feature: Wasmtime 48 with
`-S tls=y,inherit-network=y,allow-ip-name-lookup=y`, or a TLS-enabled wash-runtime. Importing
`node:tls` or `node:https` adds `wasi:tls/client@0.3.0-draft` to the component world. A host
without TLS cannot instantiate that component. Certificate chain and server-name verification
use the host trust store; guest `ca` / client certificates, `rejectUnauthorized: false`, custom
identity checks, TLS versions/ciphers, ALPN, sessions, and certificate inspection throw.
Use `servername` when connecting by address to a DNS-named service.

HTTPS responses without `Content-Length` or chunked encoding finish only when the peer closes.
`options.timeout` is an inactivity notification and does not cancel the request; destroy it in
the `timeout` handler:

```typescript
import { get } from 'node:https';

const req = get('https://example.com/', { timeout: 10_000 }, (res) => {
  res.on('data', (chunk) => console.log(chunk.toString()));
  res.on('error', (error) => console.error(error));
});
req.on('timeout', () => req.destroy(new Error('HTTPS request timed out')));
req.on('error', (error) => console.error(error));
```

### Tenant egress and TLS

Native `OutgoingHttp` requests separately require the destination in the workload component's
`localResources.allowedHosts`. The binding does not grant egress access. For the
admin-namespace fixture, the
[kube deployment helper](kube.md#outgoing-http-permissions) patches that field after deployment.

On a tenant target (`hostgroup` set), deploy does not write `allowedHosts` or
`allowedIpNameLookups` onto the WorkloadDeployment. It turns project `allowedIpNameLookups` into
BackingService `<deployment>-egress` (`spec.type: egress`) and a ServiceBinding. The controller
patches both allow-lists after approval through platform `egressAllowedDestinations` (empty
approves nothing). `"*"` is rejected. Deploy succeeds when the service is `NotApproved`, but
outbound connections remain blocked until approved. See [Egress](backing-services.md#egress).

Stock `ghcr.io/wasmcloud/wash:<version>` has no `wasi:tls` provider. The default tenant host
image is `ghcr.io/di-framework/wash:2.8.0-wasi-tls` (pinned by digest by `@di-framework/platform`),
with pull policy `IfNotPresent`. `tenantHostImage` overrides that reference. For workloads that
require single-instance execution (`di-framework.dev/exclusive-instance: "true"`, such as embedded
PGlite), set `tenantHostImage` to the `ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive` digest
published with the platform release.
`di-framework-kube up` writes the same canonical default digest when the platform config omits
`tenantHostImage`. The [platform-examples](https://docs.di-framework.dev/deployment.html#one-command-local-platform-example) stack
still builds wash and pushes that image into its cluster registry. Deploy warns rather than fails
when the tenant host image tag lacks `wasi-tls`.

Tenant hosts never receive blanket `--allow-insecure-registries`. Instead, platform configuration
accepts `insecureRegistries` — an array of exact `<host>[:<port>]` entries (with no scheme or
path) passed per host via `--allow-insecure-registry` / `--insecure-registry` to the wash host so
plain-HTTP registries are allowed per-host while TLS verification remains enabled for all other
registries. Local installs automatically allowlist the in-cluster platform registry
(`di-framework-registry.<namespace>.svc.cluster.local:5000`); existing-cluster installs require
`insecureRegistry: true` alongside `insecureRegistries`. `createPlatform` rejects legacy
pre-allowlist host digests when an insecure-registry allowlist is active.

## Local development

```bash
di-framework platform dev [--host <address>] [--port <port>]
```

`dev` rebuilds the component and listens on `127.0.0.1:8000` by default. It selects wasmtime
from PATH first, then wash, then jco. Use wasmtime 46+ for this path; TLS-importing components
need Wasmtime 48. Set `DI_FRAMEWORK_WASMCLOUD_DEV_RUNNER` to `wasmtime`, `wash`, or `jco` to
select a runner explicitly. Tool output streams to the terminal until the server stops. The
command uses the nearest `di-framework.config.json` above the working directory.

The wasmtime runner uses `serve -S cli -S p3 -S config`, supporting WASI HTTP and unlabeled
`wasi:config`. When the generated WIT lock imports `wasi:tls`, `dev` also passes
`-S tls=y,inherit-network=y,allow-ip-name-lookup=y`. Other runners need their own TLS-enabled
host configuration. wasmCloud-only imports such as PostgreSQL require wash or a wasmCloud host.
For wash, the extension writes `.di-framework/wash-dev.yaml` with the address, host interfaces,
and async component proposal, then invokes `wash dev --user-config`.
`WASMCLOUD_POSTGRES_URL` supplies `dev.postgres_url` for that local runner.

## Deployment manifest

Deployment topology lives in `di-framework.deploy.toml` at the workspace root. The CLI finds it by
walking upward from the current directory. The file describes **targets**, not applications: it must
not declare an `apps` table.

```toml
default-target = "local"

[targets.local]
platform = "deploy/platform"
stack = "dev"

[targets.development]
kubeconfig = "${KUBECONFIG}"
context = "team-development"
namespace = "wasmcloud"

[targets.development.registry]
push = "https://registry.example.com/team"
pull = "registry.internal.example.com/team"
insecure = false

[targets.warehouse]
kubeconfig = "${WAREHOUSE_KUBECONFIG}"
tenant = "warehouse"
registry = "registry.example.com/warehouse"

[targets.acme]
account = "acme"
controller = "https://acme.controller.localhost:28180"
env = "prod"
```

- `di-framework platform deploy` with no name uses the nearest `di-framework.config.json`.
- `di-framework platform deploy greeter` recursively discovers projects under the workspace
  (skipping `.git`, `node_modules`, `.di-framework`, and generated output such as `dist/` and
  `coverage/` by default) and matches the configured `name`. Duplicate names fail with every
  conflicting path (`WASMCLOUD_DUPLICATE_PROJECT`).
- `--target <name>` selects a declared target; without it the CLI uses `default-target`.
- `${VAR}` interpolation fails with `WASMCLOUD_ENV_UNSET` if the variable is unset or empty. Do not
  put credentials in the manifest.

Optional `[discovery]` `include` / `exclude` glob lists refine the search. Directories `.git`,
`node_modules`, and `.di-framework` are always skipped.

A missing or malformed manifest reports `WASMCLOUD_DEPLOY_MANIFEST_NOT_FOUND` or
`WASMCLOUD_DEPLOY_MANIFEST_INVALID` and exits `2`.

### Targets and tenants

A target is one `[targets.<name>]` table: a managed Pulumi stack (`platform` + `stack`), an
external cluster connection (`kubeconfig` + `registry` + `tenant` or `namespace`), or a tenant
controller target (`account` + `controller` or `domain` + `env`).
A tenant is the platform isolation unit: workload namespace `di-tenant-<t>`, runtime namespace
`di-runtime-<t>`, operator namespace `di-operator-<t>`, API-key namespace `di-apikeys-<t>`, and
host group `tenant-<t>`. One tenant can have several targets, for example one per user or
environment. A target points at no tenant or exactly one.

`tenant = "<t>"` fills `namespace = "di-tenant-<t>"` and `hostgroup = "tenant-<t>"`; explicit
`namespace` or `hostgroup` overrides the fill-in. An external target needs `kubeconfig`,
`registry`, and either `tenant` or `namespace`. The `development` example above remains an
admin/plain-cluster target.

### Managed Pulumi target

A managed target has `platform` (a directory inside the workspace that contains `Pulumi.yaml`) and
an optional `stack` (default `dev`). It must not mix those fields with kubeconfig or controller fields.

From the workspace root, generate a local Pulumi project for k0s, a local OCI registry, and
the wasmCloud platform:

```bash
di-framework platform cluster init
```

`cluster init` writes `deploy/platform` and creates or updates `di-framework.deploy.toml` so
`local` is a managed target (`platform = "deploy/platform"`, `stack = "dev"`). Existing files are
left alone unless you pass `--force` / `-f`. When it finishes it prints the exact start command:

```text
di-framework platform cluster up --yes
```

The generated `index.ts` imports `@di-framework/platform/local`; its `package.json` pins the
installed shared-package version. The implementation lives in that package, including the
operator, Tenant/User and backing-service CRDs, controller, and admission policies. Generated
projects no longer copy `tenancy.ts` or its controller sources. [Kube](kube.md) consumes the same implementation
through `@di-framework/platform/existing`, with Kubesolo supplying the cluster.

`cluster up` runs `pulumi install` automatically for the generated project. Its default
loopback ports are Kubernetes `26443`, registry `25000`, and HTTP `28180`; configure `apiPort`,
`registryPort`, or `httpPort` in the generated Pulumi stack to choose different ports.

The generated Pulumi project provisions only platform concerns. It must not contain application
names, component builds, Kubernetes Services for apps, or `WorkloadDeployment` objects.

Choose the local engine before the first `pulumi up`: `containerCli` defaults to `docker`
and accepts `podman` or another Docker-compatible CLI. In `deploy/platform`, for example:

```bash
cd deploy/platform
pulumi config set containerCli podman
pulumi config set --path 'registryMirrors["docker.io"][0]' https://mirror.gcr.io
```

`registryMirrors` maps registry hosts to ordered mirror URLs. containerd tries those mirrors
in order, then falls back upstream. Set mirrors before the first `pulumi up` too. Switching
engines or changing mirrors requires destroying and deploying the platform again, removing
cluster state. Declare a tenant and user in that same stack, then start from the workspace root:

```bash
pulumi config set --path 'tenants[0].name' meshtastic
pulumi config set --path 'users[0].name' dev
pulumi config set --path 'users[0].memberships[0].tenant' meshtastic
pulumi config set --path 'users[0].memberships[0].role' developer
cd ../..
di-framework platform cluster up --yes
```

The local entrypoint creates container-engine resources for k0s, its network, and persistent volumes.
Once k0s yields a kubeconfig, the shared implementation provisions the registry as a Kubernetes
Deployment and Service and installs the operator through Pulumi `kubernetes.helm.v3.Release`
(`oci://ghcr.io/wasmcloud/charts/runtime-operator`). Kube's existing-cluster profile leaves
registry provisioning to the caller or example helpers.

#### Platform configuration and runtime isolation

Both platform entrypoints validate configuration up front (`validatePlatformConfig`) before
creating cluster or Kubernetes resources:

- **Gateway `routeAliases`:** Maps vanity or cutover `<route-host>.<tenant>` hostnames to
  `<route-host>.<target-tenant>` through the HTTP gateway while preserving `X-Forwarded-Host`, so
  applications that derive redirect or issuer URLs keep the public hostname. Reserved route hosts
  (`console`, `controller`, `registry`) and alias chains are rejected.
- **Runtime NATS storage caps (`runtimeNats`):** Caps each tenant's `di-nats` JetStream store in
  `di-runtime-<t>` via `maxFileStore` (default `2Gi` / `10Gi` depending on profile) and
  `maxMemoryStore` (default `256Mi` / `32Mi`).
- **Scheduler NATS bus and per-tenant operators:** The platform runs `di-scheduler-nats` in
  `wasmcloud` (`nats.enabled=false` on the Helm chart) with per-tenant NATS accounts (`T_<UID8>` /
  `T_di-tenant-<t>`) and zero cross-account imports or exports. Each tenant gets a dedicated
  `runtime-operator` in `di-operator-<t>` watching only `di-tenant-<t>` and managing hosts only in
  `di-runtime-<t>`, while the chart's operator watches only `wasmcloud`. Tenant `wash-host` pods
  connect with `--scheduler-nats-url` and `--scheduler-nats-creds` (and per-tenant TLS
  certificates rotated through a current/next CA bundle) and run with
  `automountServiceAccountToken: false` (no Kubernetes ServiceAccount token). Adding or removing a
  tenant never restarts the platform operator.
- **Tenant deletion policy and 7-step removal (`R1`–`R7`):** Each `tenants[]` entry accepts
  `deletionPolicy` (`Retain`, the default, or `Delete`). When a Tenant is deleted, the controller
  executes a 7-step removal state machine (`R1` revokes the tenant host scheduler identity; `R2`
  scales tenant workloads and host pods to zero while keeping the tenant operator running to clear
  host finalizers; `R3` deletes workloads under `Delete` or scales the tenant operator to zero and
  strips workload/artifact finalizers under `Retain`; `R4` drops the tenant operator scheduler
  account; `R5` deletes the operator RoleBindings, host identity Secret, and `di-operator-<t>`;
  `R6` deletes or retains `di-tenant-<t>`, `di-runtime-<t>`, and `di-apikeys-<t>`; `R7` removes
  the Tenant finalizer). If any step does not complete within its deadline (5–15 minutes), the
  Tenant reports `RemovalStuck=True` with the step ID (`R1`–`R7`) and pending resources.
  Re-adding a tenant whose namespaces were kept by `Retain` fails with `Exists` because
  kept namespaces retain the previous Tenant UID and are never silently adopted; delete or adopt
  the kept namespaces out of band before re-creating the tenant.

Keep the project name, backend, stack, and configuration when upgrading an older generated
project to the package import. Review `pulumi preview` before applying and migrate any local
customizations from the old copied files. The shared local entrypoint preserves the previous
logical resource names. Do not point a second stack at resources already owned by another
platform installation.

The CLI reads a small output contract from `pulumi stack output --json`:

| Output | Required | Meaning |
| --- | --- | --- |
| `kubeconfig` | yes | kubeconfig YAML or a filesystem path |
| `namespace` | yes | Kubernetes namespace for workloads |
| `registry` | yes | OCI registry prefix, or `{ push, pull, insecure }` transport object |
| `context` | no | kubectl context |
| `kubeconfigs` | no | Secret tenant credentials: `{ [tenant]: { [user]: string } }`. |
| `routeUrlPattern` | no | Tenant gateway URL template. |
| `endpoints.http` / `endpoints.kubernetes` / `endpoints.registry` | no | optional URLs |

Provision and tear down that stack explicitly. Application `destroy` never runs `pulumi destroy`.

```bash
di-framework platform cluster up --yes
di-framework platform cluster destroy --yes
```

`--yes` skips the Pulumi confirmation prompt on `cluster up` and `cluster destroy`.

The extension's Pulumi environment defaults, applied without changing the caller's environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PULUMI_BACKEND_URL` | `file://~` | Local file backend unless a backend is configured. |
| `PULUMI_CONFIG_PASSPHRASE` | `local-dev` | Local development fallback when unset. |

These are the extension's local-development defaults. Kube uses its own per-instance backend
and generated passphrase; see [platform state and ownership](kube.md#platform-state-and-ownership).

A managed target whose platform directory has no `Pulumi.yaml` reports `WASMCLOUD_PLATFORM_NOT_FOUND`.
A stack that has not been deployed, or whose outputs do not match the contract, reports
`WASMCLOUD_PLATFORM_NOT_READY` or `WASMCLOUD_PLATFORM_OUTPUT_INVALID`.

### Existing cluster

When kubeconfig and a registry are already available, declare an **external** target with only
access information: `kubeconfig`, `registry`, and either `tenant` or `namespace`, plus optional
`context` and `hostgroup`. Deploy:

```bash
export KUBECONFIG="$HOME/.kube/config"
di-framework platform deploy greeter --target development
```

External and managed fields are mutually exclusive. An incomplete target reports
`WASMCLOUD_DEPLOY_MANIFEST_INVALID`.

The registry object separates the address used by ORAS to push from the address used by the
cluster to pull. A string registry remains supported. An `http://` push URL or `insecure = true`
enables ORAS plain HTTP for that target. See [Kubernetes with di-framework-kube](kube.md) for
an external-target workflow using a loopback publisher and an in-cluster registry service.

### Controller targets

When a tenant runs the per-tenant controller and registry (`tenantAuth`), declare a
controller-backed target in `di-framework.deploy.toml` with `account`, `controller` (or `domain`
to derive `https://<account>.controller.<domain>`), and optional `env` (`"prod"` or `"staging"`,
default `"prod"`):

```toml
default-target = "acme"

[targets.acme]
account = "acme"
controller = "https://acme.controller.localhost:28180"
env = "prod"
```

Controller-backed targets talk only to the tenant controller `/v1` API and the tenant registry, so
they need no `kubeconfig` or `kubectl`:

```bash
di-framework platform login --target acme --ca-file ./tenant-ca.crt
di-framework platform whoami --target acme
di-framework platform build --bundle dist/greeter.bundle.json --target acme --env prod
di-framework platform deploy greeter --target acme --preview
di-framework platform deploy greeter --target acme --env prod
di-framework platform logs greeter --target acme --env prod --follow
di-framework platform secrets set api-key --from-file ./api-key.txt --target acme --env prod
di-framework platform vars set LOG_LEVEL --value info --target acme --env prod
di-framework platform logout --target acme
```

`login` authenticates via OIDC browser PKCE (or `--api-key <key>`) and stores credentials for the
tenant account. `build --bundle <out.json>` builds the component, pushes it to the tenant registry
advertised by `GET /v1/deploy/registry`, and writes a `DeployBundle` JSON document. `deploy`
submits that bundle to `POST /v1/deploy` (or `POST /v1/deploy/preview` when `--preview` is passed).
`secrets <list|set|update|unset>` and `vars <list|set|update|unset>` manage per-environment
configuration over `/v1`, and `logs` streams or queries service logs from the controller.

## Tenant kubeconfigs and HTTP gateway

The controller writes a long-lived ServiceAccount token Secret per user membership. After
`pulumi up`, both platform entrypoints export secret `kubeconfigs`; previews do not read token
Secrets. Upgrading an installation whose users are already Ready can require a second
`pulumi up` after the controller creates their Secrets. From the platform stack directory,
write only the intended user's tenant credential (requires `jq`):

```bash
pulumi stack output kubeconfigs --show-secrets | jq -r '.meshtastic.dev' > tenant.kubeconfig
chmod 600 tenant.kubeconfig
```

Set `KUBECONFIG` to the absolute path of that file. From the application workspace, declare
an external tenant target in `di-framework.deploy.toml` (use the platform registry output):

```toml
default-target = "meshtastic"

[targets.meshtastic]
kubeconfig = "${KUBECONFIG}"
tenant = "meshtastic"

[targets.meshtastic.registry]
push = "http://127.0.0.1:25000"
pull = "di-framework-registry.wasmcloud.svc.cluster.local:5000"
insecure = true
```
Do not distribute the admin kubeconfig. These credentials use ServiceAccount tokens, not an
identity provider. `di-framework-kube` does not yet re-export `kubeconfigs` or `routeUrlPattern`;
use the platform stack directly for credentials.

Tenant HTTP uses the gateway on the published HTTP port, without a port-forward of `svc/di-http`.
`routeUrlPattern` defaults locally to `http://{host}.{tenant}.localhost:<httpPort>`; the CLI local
port is **28180**, for example `http://mesh-site.meshtastic.localhost:28180/`. `*.localhost`
resolves to loopback. The controller publishes ConfigMap `di-platform-routes` with
`data.urlTemplate` in each tenant namespace. Other Host values still reach the default host
group. Gateway requests cannot reach `/_di/*` (`DI_CONTROL_REJECT_FORWARDED=1`). Kube's default
HTTP port remains **28080**; see its [release limitation](kube.md#tenant-http-gateway).

## Console

With a tenant target selected as `default-target`:

```bash
di-framework platform console
di-framework platform console --port 8790
```

The console is a loopback control panel for one tenant credential, with no login. It refuses
the platform admin kubeconfig. A viewer sees the same screens and cannot change them. Without
`--port`, the OS picks a free port; the process prints `Console listening on <url>`, including
when stdout is redirected. `--port 8790` pins the port.

Applications show workloads of services and components, route links to the gateway URL,
environment, bindings, and logs. Routes can be turned on or off without rebuilding. Bindings
“Class” means the backing-service class (for example `blobstore-nats`), not the capability.
Refresh reloads the open application; the service list polls until Ready. When setting an
environment variable, choose the part that receives it. On a narrow window, choosing a section
closes the navigation. The dashboard and Logs show host start failures and mark failed workloads.
The create form omits egress because it does not collect destinations; bind egress from the
Bindings tab for single-part applications only.

## Control HTTP

Deployed HTTP workloads always get a Kubernetes Secret with `DI_CONTROL_TOKEN` and
`DI_CONTROL_IDENTITY` (the workload name). CronJobs send `Authorization: Bearer` from that
secret. Queue retry requires the `admin` role; cron invoke, actor invoke, and queue
list / enqueue / inspect require `invoke`. A `DI_CONTROL_TOKEN` identity has both roles.

Unconfigured local/dev (no token and no `DI_CONTROL_IDENTITIES`) may **invoke** only.
Anonymous access never has `admin`. Client-supplied `callerId` on actor invoke is ignored;
the caller is the authenticated control identity.

Deployed control paths (`/_di/*`, `/_actors/*`) are not reachable through public ingress.
Workloads set `DI_CONTROL_REJECT_FORWARDED=1` and `DI_CONTROL_HTTP_HOST` to the ClusterIP DNS
name. Requests with `X-Forwarded-*` return 404. Local/dev leaves those unset, so auth still
applies but the host filter does not.

See [PR #430](https://github.com/di-framework/di-framework/pull/430) and
[PR #431](https://github.com/di-framework/di-framework/pull/431) for the control-plane design.

### Write-only workload control Secrets

When an application stores additional environment secrets in `<deployment>-control` (including
framework keys such as `DI_AI_CONTROL_KEY`, `DI_PGLITE_KEY`, and `DI_PGLITE_KEY_PREVIOUS`),
declare those key names in `di-framework.config.json`:

```json
{
  "name": "orders",
  "entry": "src/app.ts",
  "controlSecretKeys": ["DI_AI_CONTROL_KEY", "DI_PGLITE_KEY", "DI_PGLITE_KEY_PREVIOUS"]
}
```

Tenant developers have write-only Secret RBAC in `di-tenant-<name>` (`create`, `update`, `patch`,
`delete`; no `get`, `list`, or `watch`). Because a tenant developer kubeconfig cannot read existing
Secret values, `platform deploy` updates `<deployment>-control` using create-or-patch (and dry-run
admission checks against `tenant-secret-update`) without calling `get`. Once declared application
keys are present in `<deployment>-control`, `platform deploy` preserves the existing Secret instead
of overwriting those keys.

## Scheduled jobs

`di-framework platform build` discovers `@Cron(...)` methods with a string or numeric literal
and writes `.di-framework/cron.json` plus an invoker. Deploy applies one Kubernetes
`batch/v1` CronJob per job. The workload sets `DI_CRON_MODE=external` so in-component timers do
not fire. Generated workloads use `replicas: 1`.

Scheduled-only projects (`"ingress": false`) still export `wasi:http/handler` and still get a
ClusterIP Service so CronJobs can POST to `/_di/cron/{jobId}/invoke`. Public ingress is omitted.
The default export must expose the DI container (`export { container }` or
`export default { container }`). Failed or skipped jobs return HTTP 500 with a generic
`Cron job failed` body so the CronJob does not record success. See [Control HTTP](#control-http).

`destroy` deletes `WorkloadDeployment,service,cronjob` labeled
`app.kubernetes.io/name=<witName>`. `dev` and `doctor` do not generate or check CronJobs.

See [Scheduling](https://docs.di-framework.dev/scheduling.html) for expressions, overlap, and `invokeCronJob`.

## Queue workers

Build discovers `@QueueHandler('name', { numeric options })`. A project is a queue worker when
handlers exist and either `applicationType` is `"worker"` or the sources have no HTTP controller
decorators.

Generated guests import WASI SQLite, export `wasi:http/handler`, and `pump()` jobs on control
HTTP (`/_di/queues/`) rather than starting poll loops. Public ingress is omitted. The workload
uses `replicas: 1`, `deployPolicy: Recreate`, and `QUEUE_DB_PATH=/data/queue.db`. Targets
without a `hostgroup` use the `storage` pool and hostPath; tenant targets use
[platform-managed workload storage](#deployed-storage). A ClusterIP Service still exists for control routes. Queue retry
requires `admin`; see [Control HTTP](#control-http).

See [Queues](https://docs.di-framework.dev/queues.html#platform-workers).

## Static assets

The extension does not scan `.static()` mounts. Package files on the build host with
`packageStaticAssets` from native `@di-framework/http`, then `registerStaticAssets` or pass
`package:` into `.static()` so the guest can serve bytes without the source directory. See
[HTTP static assets](https://docs.di-framework.dev/http-router.html#static-assets).

## Actors

Carry a local actor into a **single-host** wasmCloud workload. Mailboxes live in the guest.
SQLite files live on platform-managed tenant storage, or a hostPath volume for targets without
a `hostgroup`. Multi-host relocation is not implemented; see
[remote actors](https://docs.di-framework.dev/actors-distributed.html) for the out-of-band ownership protocol.

The [wasmcloud-actor-counter example](https://github.com/di-framework/examples/tree/main/platform/wasmcloud-actor-counter)
sets `"actors": true` in `di-framework.config.json` and reuses the local `CounterActor`.

### Build

`di-framework platform build` scans `@Actor` / `@ActorMethod` and writes `.di-framework/actors.js`:

```javascript
storage = new SqliteActorStorage({
  baseDir: resolveStorageDir(), // ACTOR_STORAGE_DIR || DI_STORAGE_DIR || './.actors'
  fileLocking: false,
});
runtime = new ActorRuntime({ storage });
runtime.register(CounterActor, { name, namespace });
export async function dispatchActorInvocation(actorType, actorKey, method, args = [])
```

Inside the guest, `SqliteActorStorage` is `WasmSqliteActorStorage` (`wasmcloud` export
condition). `fileLocking` is ignored. Exclusive write is a **deployment** constraint
(`replicas: 1`), not a VFS lock. `DI_SQLITE_BACKEND=wasm`.

Migrations declared on `@Actor({ migrations })` stay on the imported class; there is no separate
migration artifact. They still run before activation. A failed migration blocks the actor and
rejects invocations.

### Private invocation

Control path `POST /_actors/invoke`. Other HTTP routes are not intercepted by actor headers.
`callerId` is the authenticated control identity; a client-supplied `callerId` is ignored.
See [Control HTTP](#control-http). Error JSON uses stable `error.name`; handler text is
`'Actor invocation failed'` (no stacks).

### Deployed storage

Generated `WorkloadDeployment` on a target without a `hostgroup`:

- `spec.replicas: 1` (any other value throws `WASMCLOUD_STORAGE_REPLICA_CONSTRAINT`)
- `deployPolicy: Recreate` — drain in-flight calls and release the volume before the new
  version starts (not a Kubernetes `strategy: { type: Recreate }` field)
- `hostSelector.hostgroup: storage`
- hostPath `/var/lib/di-framework/storage/<wit-name>` mounted at `/data/actors`
- Env: `ACTOR_STORAGE_DIR=/data/actors`

On a tenant target (`hostgroup` set), actors, queues, workers, and `persistentStorage: true`
do not ship a hostPath. The controller creates
`<storageRoot>/di-tenants/<tenant uid>/workloads/<workload>`, shared by members of one
`di-framework.dev/workload` and private to that tenant. The host preopen mounts this directory
for guest filesystem access; actor storage remains at `/data/actors`. `replicas: 1` and
`deployPolicy: Recreate` still apply. Targets without a `hostgroup` keep the host path under
`/var/lib/di-framework/storage` on the `storage` pool.

There is no PersistentVolumeClaim for workload storage. Process restart on the same directory
keeps SQLite files.
**Host loss loses the files** unless the operator backs that directory. Multi-replica and
multi-host failover are not supported with this storage.

```bash
di-framework platform build
di-framework platform deploy
# restart the workload and call the same actor key — count is unchanged if the volume survived
```

Upgrade/drain: Recreate waits for the old replica to exit so the new one can open `/data/actors`.
Migration failure: the actor refuses activation; inspect `failedMigration` locally with
`di-framework actor inspect` against a copied DB, or read control error names.

## Application deploy and destroy

```bash
di-framework platform deploy [name] [--target <name>] [--yes]
di-framework platform destroy [name] [--target <name>] [--yes]
```

For the selected project the extension:

1. Builds the component.
2. Publishes it with `oras` under a stable reference derived from canonical build and deployment
   inputs (`<registry>/<wit-name>:sha256-<deployment-digest>`). The component-byte digest is reported
   separately because componentization snapshots can vary for identical inputs.
3. Derives a wasmCloud `WorkloadDeployment` and Kubernetes `Service` (written under
   `.di-framework/deploy/`, not checked in).
4. Configures HTTP ingress with the project name as its Host value, applies the resources with
   `kubectl`, and waits until the workload is ready.

For the generated Pulumi platform, call an app with
`curl -H 'Host: greeter' http://127.0.0.1:28180/`. This curl selects the default host group; tenant workloads use the
`{host}.{tenant}.localhost` gateway URL. The kube platform uses port `28080` by default.
Readiness does not prove a service binding works: follow deployment with requests that exercise
the actual backend, as in the [kube smoke checks](kube.md#verification).

`destroy` deletes only those generated resources for that application on the selected target. It
must never run `pulumi destroy`. `--yes` is accepted for compatibility; application deploy and
destroy do not prompt.

The generated Kubernetes objects are an implementation detail. Do not treat them as application
configuration.

## Doctor

```bash
di-framework platform doctor
```

`doctor` verifies the project loads and probes the local toolchain: Bun, Node.js,
`@di-framework/core` and `@di-framework/http` resolvable from the project, Pulumi, Docker or Podman, kubectl,
and oras. JSON `data` lists every check with its result; any failed check exits `1`.

Bun runs the CLI, but `jco` itself requires a real Node.js installation on `PATH` — `build`, `dev`,
and `deploy` report `WASMCLOUD_NODE_REQUIRED` without it. Pulumi and Docker or Podman are needed for
`cluster up` and `cluster destroy`. kubectl and oras are needed for application `deploy` and
`destroy`.

## Next steps

- [CLI](https://docs.di-framework.dev/cli.html) - The canonical command tree and the extensions mechanism
- [HTTP Router](https://docs.di-framework.dev/http-router.html) - Fetch-compatible routing and host-side static asset packaging
- [Private service bindings](https://docs.di-framework.dev/service-bindings.html) - In-process named contracts, not host WIT imports
- [Scheduling](https://docs.di-framework.dev/scheduling.html) - `@Cron` discovery, CronJobs, and `DI_CRON_MODE=external`
- [Queues](https://docs.di-framework.dev/queues.html) - Durable workers without public ingress
- [Actors](https://docs.di-framework.dev/actors.html) - Local runtime reused by wasmCloud guests
- [Remote actors](https://docs.di-framework.dev/actors-distributed.html) - Ownership protocol (not wasmCloud multi-host routing)
- [Installation](https://docs.di-framework.dev/installation.html) - Core package and CLI setup
- [Kubernetes with di-framework-kube](kube.md) - Local cluster and verified service-binding examples
