# @di-framework/platform

Shared TypeScript/Pulumi infrastructure for the wasmCloud CLI extension and
`di-framework-kube`. This package owns the operator, Tenant/User CRDs, backing-service
CRD contracts, controller, admission policies, tenant namespace declarations, and
HTTP entrypoint. Application WorkloadDeployments remain owned by application
deployment tooling.

- `@di-framework/platform/local` provisions the isolated k0s cluster (in Docker,
  or Podman with `containerCli: podman`), registry, and platform used by generated
  CLI projects.
- `@di-framework/platform/existing` reads Pulumi configuration and installs the
  platform on a caller-owned cluster. `di-framework-kube` uses this entrypoint.
- `createPlatform(args)` installs the shared Kubernetes resources with a supplied
  Kubernetes provider. It does not create a cluster or select a Pulumi backend.

Generated projects pin the installed package version. Upgrades are explicit.
The CLI and kube must use the same project/backend/stack when operating the same
installation; sharing source code does not permit two stacks to own its resources.
The kube entrypoint claims cluster ownership before provisioning and refuses
unmanaged legacy installations. Other consumers must enforce equivalent ownership.

## Local configuration

`apiPort`, `registryPort`, and `httpPort` (defaults `26443`, `25000`, `28180`)
choose the distinct loopback host ports. `containerCli` (default `docker`) names
the container engine command used for every network, volume, container, `exec`,
and `logs` call; set it to `podman` or another Docker-compatible CLI. It must be a
plain command name or path (letters, digits, `.`, `_`, `/`, `+`, `-`; not starting
with `-`). Ownership checks use only inspect templates both Docker and Podman
support. Choose it before the first `pulumi up`; to switch engines, destroy the
platform and deploy again (this removes cluster state).

`registryMirrors` (default: none) gives the k0s containerd pull-through mirrors.
It maps a registry host to an ordered list of mirror URLs, for example
`pulumi config set --path 'registryMirrors["docker.io"][0]' https://mirror.gcr.io`
or `registryMirrors: { "docker.io": ["https://mirror.gcr.io"] }` in the stack file.
Before k0s starts, the container writes `/etc/k0s/containerd.d/di-framework-registry-mirrors.toml`
(pointing the CRI image service at `/etc/containerd/certs.d`) and one
`/etc/containerd/certs.d/<registry>/hosts.toml` per registry. containerd tries the
mirrors in order for pulls and falls back to the upstream registry
(`https://registry-1.docker.io` for `docker.io`, `https://<registry>` otherwise).
Keys must be lowercase host names or `host:port`. Mirrors must be `http://` or
`https://` URLs with a lowercase host, an optional port, and an optional path of
letters, digits, `.`, `_`, `~`, and `-`. Credentials, queries, quotes, whitespace,
and shell metacharacters are rejected. File contents reach the container through
environment variables and are never interpolated into a shell command. When the
setting is unset or `{}`, the generated commands are the same as without it. Set it
before the first `pulumi up`; changing it later means destroying and redeploying the
platform.

`tenants`, `users`, and the other platform settings are shared with the
existing-cluster entrypoint.

## Existing-cluster configuration

`kubeconfig` is required (a local file path); `context`, `namespace`, `release`,
`chart`, `chartVersion`, `httpNodePort`, `timeoutSeconds`, `insecureRegistry`,
`storageRoot`, `networkPolicyEngine`, `kubernetesEndpoint`, `httpEndpoint`, `routeUrlPattern`,
`egressAllowedDestinations`, and administrator `values` are optional. `tenants`, `users`,
`tenantHostImage`, and `tenantHostImagePullPolicy` use the same declarations as the
local entrypoint. NodePort zero makes the HTTP gateway ClusterIP. Registry installation is off
for existing clusters. Shared hosts are disabled regardless of values overrides. Set `networkPolicyEngine`
to `kube-router` to install the pinned v2.10.0 policy-only controller on clusters
without policy enforcement; `existing` leaves policy enforcement to the caller.
Managed Kubesolo enables it by default. This mode preserves the existing CNI and
service proxy ([upstream guide](https://www.kube-router.io/docs/user-guide/)).

Kubeconfig contents are a secret Pulumi input. The controller's compiled JavaScript
(`backing-services.js`, `resources.js`, `backing-service-reconcile.js`,
`service-binding-reconcile.js`, `controller.js`) is loaded from this package into a
ConfigMap; there is no copied TypeScript implementation in generated projects,
runtime transpilation, or custom image build.

Tenant storage currently uses local host paths. The caller must select a persistent
storage root and a cluster that enforces NetworkPolicy and the generated admission
policies. Default roots are `/var/lib/k0s` for local and `/var/lib/kubesolo` for the
existing-cluster entrypoint. Retained tenant namespaces/data survive resource
cleanup, but destroying the local cluster removes its volumes.

## Tenant user kubeconfigs

For each declared user and membership, the controller creates a long-lived
ServiceAccount token Secret `di-user-<user>-<tenant>-token` (type
`kubernetes.io/service-account-token`) in the platform namespace, owned and labelled
like the user's other resources. A User reports `Ready` only after Kubernetes has
populated every one of its token Secrets. Removing a membership, suspending or
deleting the user, or suspending the tenant deletes the matching Secret and so
invalidates the token.

After each User is Ready, `createPlatform` reads its token Secrets and builds one
kubeconfig per membership: the API server and cluster CA (`ca.crt` from the token
Secret), the token as the only credential, and a context whose namespace is
`di-tenant-<tenant>`. The result is the secret output
`kubeconfigs: { [tenant]: { [user]: string } }`, exported by both entrypoints.
Write one to a file with:

```sh
pulumi stack output kubeconfigs --show-secrets | jq -r '.meshtastic.dev' > tenant.kubeconfig
chmod 600 tenant.kubeconfig
```

The kubeconfig grants exactly the user's tenant role: `developer` users can manage
tenant workloads and services, `viewer` users get read-only access. The token
does not expire; rotate it by deleting the Secret (the controller recreates it)
and running `pulumi up` again.

The API server URL comes from the `apiServer` argument of `createPlatform`. The
local entrypoint passes its loopback `https://127.0.0.1:<apiPort>`. The existing-cluster
entrypoint uses `kubernetesEndpoint` (set by `di-framework-kube`) and otherwise the
server of the admin kubeconfig's selected `context` (or `current-context`). When
neither resolves to an `https://` URL, `kubeconfigs` is omitted. Previews do not read
token Secrets, so `kubeconfigs` is only known after `pulumi up`. When upgrading an
installation whose Users are already Ready, Pulumi does not wait on unchanged Users,
so the first `pulumi up` can read a token Secret before the upgraded controller has
created it; run `pulumi up` again once it has.

## Development

```sh
bun run build
bun test
npm pack
```

Build before running Pulumi mock tests, which exercise the compiled artifact.
For local cross-repository verification, pass an absolute `file:` tarball to
`di-framework-kube up --platform-package`. Publish this package before releasing
consumers that pin its version.

Existing CLI projects retain their copied implementation until explicitly updated.
To migrate, preserve the project name, backend, stack, and configuration; replace
`index.ts` with the generated package import and add the exact package dependency.
Run `pulumi preview` and verify existing resources retain their identities before
applying. The local entrypoint preserves prior logical resource names. Old copied
`tenancy.ts` and `tenancy/` files are no longer imported and can be removed after
reviewing any local customization.

## Backing services

Platform install ships the three backing-service CRDs (`BackingServiceClass`,
`BackingService`, `ServiceBinding`) with OpenAPI schemas and status subresources,
seeds the approved default classes, and extends the controller ClusterRole to
watch those resources. Tenant RBAC, ValidatingAdmissionPolicy, ResourceQuota
counts, and backend NetworkPolicy isolation for bindings are enforced here (#452).
Redis/NATS reconciliation and binding projection use this install path. The
upcoming release adds dedicated PostgreSQL instances, persistent storage, and
workload-managed associations; see [Dedicated PostgreSQL](#dedicated-postgresql-upcoming-release).

Schemas and helpers live in `src/tenancy/backing-services.ts` and are included in the
platform `crds` export from `src/tenancy/resources.ts`. Class seeding and controller
script packaging live in `src/tenancy/install.ts`. Per-tick Redis/NATS provisioning
for independently requested services lives in `src/tenancy/backing-service-reconcile.ts`
and is driven from the controller tick loop. Admission helpers and policies live
in `src/tenancy/admission.ts`. ServiceBinding projection lives in
`src/tenancy/service-binding-reconcile.ts`. PostgreSQL provisioning, credentials,
bootstrap and storage helpers live in `src/tenancy/postgres.ts`.

### Controller-managed name prefixes (stable for #450/#451)

| Prefix / name | Kind | Owner | Purpose |
| --- | --- | --- | --- |
| `di-bs-*` | ConfigMap (and optional Secret) | Controller (#450) | Per-`BackingService` host plugin config (`url`, `backend`, …) |
| `di-binding-*` | Secret / ConfigMap | Controller (#451) | Binding-projected credentials and overlays for named `hostInterfaces` |
| `di-tenant-stock` | ConfigMap | Tenant controller | Transitional shared warehouse Redis path |

Admission allowlists these names on `configFrom` / `secretFrom`. Arbitrary
user-owned ConfigMaps/Secrets cannot be used to inject endpoints or credentials
into managed keyvalue/messaging/postgres host interfaces. Tenant users cannot create/update/delete
objects with these names (fail-closed ValidatingAdmissionPolicy).

### Network isolation and port-forward

Backend pods labeled `platform.di-framework.dev/component=backing-service`
(stock Redis/NATS and independently provisioned Redis/NATS/PostgreSQL instances)
accept ingress only from the tenant hostgroup. `allowSharedHosts` remains
`false` in generated Helm values. **Port-forward caveat:** `di-runtime-developer`
still grants `pods/portforward` so developers can reach runtime pods (including
backends) from their kubeconfig — consistent with the within-tenant Secret access
model, not a claim of developer-proof network isolation.

### Installation ownership and lifecycle

- **CRDs** are installed before any class or tenant CRs. Pulumi marks CRDs
  `retainOnDelete` so destroying or upgrading the stack does not cascade-delete
  existing `BackingService` / `ServiceBinding` instances if the cluster remains.
  PostgreSQL retention and recovery are described below.
- **Default classes** `keyvalue-redis`, `messaging-nats`, `blobstore-nats`, `postgres-dedicated`,
  and `egress-public` are platform-owned
  cluster CRs (installation label, `visibility: AllTenants`, `default: true`).
  Override with Pulumi config `backingServiceClasses`, or disable seeding with
  `seedDefaultBackingClasses: false`. `egress-public` approves the Pulumi config list
  `egressAllowedDestinations` (`host:port` / `*.suffix:port`, default `[]`, which approves nothing).
- **Controller scripts** are TypeScript sources compiled by `tsc` into
  `dist/tenancy/*.js` (`egress`, `backing-services`, `resources`, `backing-service-reconcile`,
  `service-binding-reconcile`, `postgres`, `controller`). Pulumi loads those compiled files into
  the controller ConfigMap; `resources.js` requires `./backing-services` (which requires
  `./egress`) at runtime,
  and `controller.js` requires `resources.js`, `backing-service-reconcile.js`, and
  `service-binding-reconcile.js` and `postgres.js`. There is no runtime `transpileModule` or
  PLATFORM_TS_ASSETS allowlist for these modules.
- Scheduler/control-plane NATS remains distinct from application messaging
  `BackingService` instances.
- **Blobstore** services (`blobstore-nats`) run the same JetStream NATS image as messaging.
  A `ServiceBinding` with `capability: blobstore` projects ConfigMap `di-binding-<binding>` with
  `backend: nats` and `url` only. The workload host interface stays unnamed and selects the
  store with `configFrom`; each guest container is its own object store bucket. Without a
  binding, the unnamed interface keeps the host default store.
- Per-tenant **runtime data-plane NATS** (`di-nats`, hostgroup `--data-nats-url`) is
  Tenant-reconciled infrastructure — not an application `BackingService`. Application
  messaging instances are named `di-bs-<service-name>` and owned by BackingService UIDs.

### Egress

Tenant guests reach the network only through an approved egress grant. Tenant hosts run
with `--socket-egress=enforce`, and admission denies `allowedHosts` and
`allowedIpNameLookups` from tenant users.

- The platform administrator lists what may be reached in the `egress-public` class:
  Pulumi config `egressAllowedDestinations`, for example
  `["mqtt.meshtastic.org:1883", "*.example.com:443"]`. Every entry needs a port.
- A tenant creates a `BackingService` with `type: egress` and `spec.destinations`
  (`host`, `*.suffix`, `host:port` or `*.suffix:port`). Nothing is provisioned. The service
  is Ready when the class covers every destination; a destination without a port is
  approved for each policy port that covers its name. `status.approved` lists the resolved
  `host:port` entries. Otherwise Ready is False with reason `NotApproved`, naming the
  destinations the class does not cover.
- A `ServiceBinding` with `capability: egress` and `workloadName: <WorkloadDeployment>`
  grants that workload the approved entries (`bindingName` is free; the CLI uses `egress`).
  On each tick the controller merge-patches every guest of the WorkloadDeployment
  (`components[].localResources` and `service.localResources`) under field manager
  `di-platform-egress`, and removes the fields again when no Ready binding grants them. A
  redeploy that replaces the component list gets them back on the next tick.
- The controller also keeps NetworkPolicy `di-tenant-egress` in `di-runtime-<tenant>`: the
  tenant host pods may reach public IPv4 addresses (not 10/8, 172.16/12, 192.168/16,
  169.254/16, 127/8) on the union of approved TCP ports. It is deleted with the last grant.
- A tenant update may carry the controller's `allowedHosts` / `allowedIpNameLookups`
  forward unchanged, or drop them. It cannot add or change them.

What the patch contains follows what wash 2.8 checks under `--socket-egress=enforce`:

| Guest call | wash check | Patch entry |
| --- | --- | --- |
| `wasi:sockets` name lookup | name against `allowedIpNameLookups` | each approved name (`*.suffix` kept) |
| `wasi:sockets` TCP connect | address against `allowedHosts`; only `*` or a literal `ip:port` can match | `<ipv4>:<port>` for each public IPv4 the controller resolves for an exact name |
| `wasi:http` request | URI against `allowedHosts` | `host:port`, plus `https://host` for 443 and `http://host` for 80 (a portless URI does not match `host:443`) |

The controller resolves names through the cluster resolver on each tick and patches only
when the answer changes; a failed lookup keeps the last answer. Wildcard destinations
grant lookups and HTTP only, since no address can be listed for them. IPv6 is not granted.

### Console log projection

The controller publishes one ConfigMap per console application in each tenant
namespace, `di-logs-<app>`, labeled `di-framework.dev/projection=logs` and
`di-framework.dev/application=<app>`, with the newest 200 lines in `data.lines` and
the newest host failure per WorkloadDeployment in `data.failures`.

- Source: the `hostgroup-<tenant>` pod logs, read through a per-tenant
  `di-platform-log-reader` Role (`pods/log get` in the runtime namespace only). The
  host keeps `automountServiceAccountToken: false`.
- Guest lines come only from the wash `wasi:logging` TracingLogger. Each ends with
  `workload.name` and `workload.namespace`; the namespace must be the tenant's, and
  the name maps to a `di-framework`-managed WorkloadDeployment. Its
  `di-framework.dev/workload` label (else `di-framework.dev/application`) is the
  console application, so `mesh-collector` and `mesh-site` publish to `mesh`.
  Raw guest stdout/stderr carries no attribution and is dropped.
- Host failures are kept too: WARN/ERROR lines the host emits inside a
  `workload_start{workload_id=… workload.name="…" workload.namespace="…"}` span, such
  as `service did not properly execute` or `failed to start workload … reason="…"`.
  They are attributed from the span fields only (the outermost span must be
  `workload_start` with both fields, nested spans that repeat them must agree, and
  `wasi:logging` lines never count), so message text cannot pick the workload. They
  are written as `<timestamp> <LEVEL> host: <message>` into the same ring.
- The ring reserves room for host lines so a chatty guest cannot push failures out
  within seconds: the newest 50 host lines are kept, guest lines fill the rest of
  the 200 newest first, and only then older host lines. Lines stay in timestamp
  order. Each poll re-merges with the published `data.lines`, so this also holds
  after a controller restart. A guest message that itself starts with `host:` is
  written as `(guest) host: …` and never counts as a host line.
- Service crashes are kept too. wash 2.8 runs the service supervisor loop in an
  uninstrumented task, so lines such as `P3 service execution failed …`,
  `max restarts reached, P3 service will not be restarted`, `failed to instantiate P3
  service` and the plain and trigger service variants carry no span. Such a line is
  attributed to the most recently started service in the same log read: the newest
  `Starting workload` line (inside a `workload_start` span, this tenant's namespace)
  of a WorkloadDeployment with `spec.template.spec.service` whose `workload_stop` has
  not followed. Without one the line is dropped. One host pod serves one tenant, so
  this cannot attribute across tenants; its limit is that two services starting at
  the same moment can be confused. When the raw panic block right before the line
  carries a JS `Exception { message: Some("…") }`, the failure reads
  `P3 service execution failed: <exception message>` (redacted, 500 characters).
  Each read starts two minutes before the previous cursor, so a crash logged just
  after a poll still sees its start; already published lines are not repeated.
- `data.failures` holds the newest host failure per WorkloadDeployment of the
  application, as JSON keyed by the WorkloadDeployment name:
  `{ "workload": "<host workload.name>", "time": "…", "level": "WARN|ERROR", "message": "…" }`.
  The host `workload.name` is `<currentReplicaSet name>-<suffix>`, so a deployment is
  failing when `failures[name].workload` starts with `status.currentReplicaSet.name-`;
  an entry from an older replica set is history. A later WARN about the same host
  workload (`max restarts reached`) does not replace its ERROR. A `Starting workload`
  line for the deployment with a different host workload name, later than the
  recorded failure, removes the entry (for example after the host retries the same
  replica set with a new suffix and that start succeeds). Timestamps are compared,
  so re-reading an older start never removes a newer failure, and the start may
  arrive in a later read than the failure. When no entries remain, `data.failures`
  is dropped. Entries of deployments that left the
  application are dropped on the next write, so the key stays bounded by its member
  count.
- A restarted controller resumes after the newest published line, so lines are not
  repeated. Failures are merged newest-wins by deployment from everything it re-reads,
  so none are lost, including ones older than that line.
- `di-framework.dev/logs: "false"` on a WorkloadDeployment (written by the CLI for
  `"logs": false`) stops its `wasi:logging` lines from being published. Its host
  failure lines and `data.failures` entry are still published: they are platform
  diagnostics about the workload, not guest output, and the console needs them for
  status.
- Lines and failure messages are redacted (bearer tokens, `key=value` secrets, URL
  credentials, long tokens) and cut to 500 characters before they are written. Host
  messages can echo guest text (for example a `reason`), so they get the same
  treatment.
- No `projection=signals` ConfigMap is written. An application with no attributed
  lines has no ConfigMap, which the console shows as unpublished.
- Tenant users cannot create, change, or delete any ConfigMap carrying
  `di-framework.dev/projection`. `di-viewer` can read it.

### Persistent workload storage

A tenant workload asks for a directory with the annotation
`di-framework.dev/persistent-storage: "true"` (optionally
`di-framework.dev/storage-mount: /data/actors`; the default guest path is `/data`).
It carries no `volumes`, `volumeMounts`, or host paths.

- The directory is `<storageRoot>/di-tenants/<tenant uid>/workloads/<key>`, where `<key>`
  is the `di-framework.dev/workload` label (else `di-framework.dev/application`).
  Members of one workload share it; every other workload gets its own.
- The controller mounts each directory into `hostgroup-<tenant>` (`DirectoryOrCreate`)
  at `/var/lib/di-framework/workloads/<key>`. A root `storage-owner` init container
  runs `chown 65532:65532` on those mount points only (not recursively); the host stays
  uid 65532 with a read-only root. Adding or removing a key rolls the host pod.
- The controller then merge-patches the WorkloadDeployment (field manager
  `di-platform-storage`) with one `hostPath` volume at that host path and a
  `volumeMounts` preopen at the guest path.
- Admission still denies `volumes` and `volumeMounts` from tenant users. Only the
  controller ServiceAccount may set them; a tenant update may carry the controller's
  volumes forward unchanged and mount only those.
- Persistent storage needs a single tenant runtime replica (`spec.runtime.replicas: 1`).
  With more, no directory is injected and the controller logs why.
- When a workload goes away its volume is dropped from the host; the data stays on the node.
- A redeploy that rewrites the component list drops the preopen until the next
  controller tick (about 3 s) puts it back.

### Tenant HTTP gateway

The published HTTP port (NodePort `httpNodePort`, 30180 locally) belongs to the
`di-platform-gateway` Deployment in the platform namespace, a small Node reverse proxy
(`gateway.js`, loaded from this package into a ConfigMap and run on the controller's
`node:22.18.0-alpine3.22` image). `wasmcloud-http` stays as the default host group's
ClusterIP backend.

- `Host: <route-host>.<tenant>.localhost[:port]` goes to
  `di-http.di-runtime-<tenant>.svc.cluster.local:80` with `Host: <route-host>`. The tenant
  is the label right before `.localhost` and must be a valid tenant name; the route host
  is everything before it (it may contain dots). Routing uses the whole name, never a
  fixed list of hosts.
- Every other Host (including `localhost` and `127.0.0.1`) goes to
  `wasmcloud-http.<namespace>.svc.cluster.local:80` with the Host unchanged.
- A missing or malformed Host, or an absolute-form request target, gets `400`. Upstream
  connection failures get `502`, an upstream silent for 60 s before responding `504`.
  Bodies stream both ways and `Upgrade` (WebSocket) requests pass through.
- `X-Forwarded-For`, `X-Forwarded-Host` (the original Host) and `X-Forwarded-Proto` are
  always overwritten and `Forwarded` is dropped. Deployed workloads set
  `DI_CONTROL_REJECT_FORWARDED=1`, so their `/_di/*` control paths stay unreachable from
  outside.
- Isolation: the tenant comes only from the Host name. Tenant runtimes still admit only
  their own namespaces (`di-tenant-network`); a separate `di-tenant-gateway` policy in
  each `di-runtime-<tenant>` admits the gateway pods, and only them, to the host group on
  9191. The gateway's own policy limits its egress to cluster DNS and host group port 9191
  in this installation's namespaces. The pod runs as non-root with a read-only root, drops
  all capabilities and mounts no ServiceAccount token.

`routeUrlPattern` (`http://{host}.{tenant}.localhost:<httpPort>`) is exported by the local
entrypoint and returned by `createPlatform`. The existing-cluster entrypoint takes it from
config `routeUrlPattern`, else derives it from `httpEndpoint` when that is an `http://`
`127.0.0.1`/`localhost` URL, else leaves it unset. When it is set the controller writes
ConfigMap `di-platform-routes` into each `di-tenant-<tenant>` namespace with
`data.urlTemplate` = the pattern with `{tenant}` filled in (for example
`http://{host}.meshtastic.localhost:28180`), and removes it once the pattern is unset.
`di-viewer` and `di-developer` can read it; tenant users cannot write it. No ConfigMap
means no gateway URL is known.

### Tenant controller and console

With config `tenantAuth` set, the tenant reconcile deploys each tenant's controller and console
(`platform/tenant-auth`, #58) and `deploy-local.ts` is no longer needed for them:

```yaml
tenantAuth:
  image: ghcr.io/di-framework/tenant-auth@sha256:<digest>   # required, pinned by digest
  issuer: http://identity.acme.localhost:28180               # identity-server, as pods and browsers name it
  oauthClient: { id: access, secretName: tenant-auth-oauth } # Secret in the platform namespace; key `clientSecret`
  issuerUpstream: di-platform-gateway.wasmcloud.svc.cluster.local:80  # optional, for a loopback issuer
  issuerUpstreamPodPort: 8080                                # optional, the pod port behind it
  issuerIp: 192.0.2.7                                        # optional, when pods cannot resolve the issuer
  consolePublicUrl: http://console.{tenant}.localhost:28180  # optional; default http://127.0.0.1:8787
  controllerPublicUrl: https://127.0.0.1:8788                # optional
```

- Placement and quota: both run in `di-runtime-<tenant>`, next to the `di-http` Service the
  controller proxies to, and `di-runtime-quota` grows by their limits (`500m` CPU, `448Mi`
  memory, sidecar included), so `spec.resources` stays the tenant's budget for the host and
  backing services.
- OAuth client: until per-tenant clients (#59), every console shares one confidential client.
  An administrator stores its secret in a Secret in the platform namespace; the reconcile
  copies it into `tenant-console-oauth` in each runtime namespace. The controller never reads
  the identity directory. Until that Secret exists the console Deployment cannot start.
- RBAC: `di-tenant-controller-<tenant>` lets the controller ServiceAccount create tokens only
  for `di-user-<member>` of the tenant's active (not suspended, not deleted) members. The list
  is recomputed from the User CRs on every reconcile; with no members the Role has no rule.
  A suspended tenant keeps the roles and loses the bindings. `tenant-controller-secrets` in
  `di-tenant-<tenant>` lets it `get`/`list` Secrets there, because tenant developers can only
  write them (#112); writes still go through as the calling user.
- Network: `tenant-auth-egress` adds egress to the API server endpoints (EndpointSlice
  `default/kubernetes`, `/32` or `/128`), the issuer (upstream namespace or IP), the tenant's
  host group on 9191 (`di-http`'s pod port) and DNS, on top of what `di-tenant-network`
  already allows every pod in the namespace.
- Credentials: no pod automounts a ServiceAccount token. The controller container alone gets
  a projected token; the issuer-proxy sidecar (`alpine/socat`, pinned by digest) has none.
- TLS: the platform controller generates a self-signed P-256 certificate for
  `tenant-controller` and the host of `controllerPublicUrl` (Secret `tenant-controller-tls`;
  the console pins it from ConfigMap `tenant-controller-ca`). It is replaced 30 days before it
  expires or when its names change, and the certificate digest in both pod templates rolls
  the pair. Kubeconfigs the console issued before a renewal embed the old CA and stop working;
  download a new one.
- The controller Deployment stays at one replica with `Recreate`: proxy sessions live in its
  memory. A new image digest rolls both pods.
- Status: problems here are reported on the Tenant's `TenantAuthReady` condition. Ready, and
  with it every member's access, does not depend on the controller or console.
- Cleanup: deleting the Tenant deletes the cluster-scoped and platform-namespace objects too;
  unsetting `tenantAuth` removes every object labelled `platform.di-framework.dev/component:
  tenant-auth` and the quota addition.

The reconcile does not adopt objects that `deploy-local.ts` created (`TenantAuthReady` reports
`Refusing to adopt`). Delete them first: in `di-runtime-<tenant>` the Deployments, Services,
ServiceAccounts, Role and RoleBinding `tenant-controller-keys`, NetworkPolicy, Secrets
`tenant-controller-tls` and `tenant-console-oauth`, and ConfigMaps `tenant-controller-ca` and
`tenant-auth-bundle`; in the platform namespace the Role and RoleBinding
`di-tenant-controller-<tenant>`; and the cluster-scoped ClusterRole and ClusterRoleBinding
`di-tenant-controller-<tenant>`.

### Contract

This section defines the v1alpha1 shape for independently requestable application
backing services.

### Resources (`platform.di-framework.dev/v1alpha1`)

| Kind | Scope | Owner |
| --- | --- | --- |
| `BackingServiceClass` | Cluster | Platform administrator |
| `BackingService` | Namespaced (`di-tenant-<name>`) | Tenant developer |
| `ServiceBinding` | Namespaced (`di-tenant-<name>`) | Tenant developer |

**BackingServiceClass** selects a capability and an approved implementation:

- `spec.type`: `keyvalue` \| `messaging` \| `blobstore` \| `postgres` \| `egress`
- `spec.provider`: `redis` \| `nats` \| `postgres` \| `platform`
- v1 compatibility is fixed: `keyvalue`+`redis`, `messaging`+`nats`, `blobstore`+`nats`, `postgres`+`postgres`, `egress`+`platform` (CEL + TypeScript helpers)
- `spec.egress.allowedDestinations` (egress only): `host:port` / `*.suffix:port` entries; an
  egress class takes no sizing or storage class
- `spec.parametersSchema` / `spec.defaults`: typed sizing only (`storage`, `memory`, `cpu`);
  no images, endpoints, hostPaths, or free-form infrastructure knobs
- `spec.visibility`: `AllTenants` \| `SelectedTenants` (requires `allowedTenants`)
- `spec.default`: at most one default class per `type`; default names are
  `keyvalue-redis`, `messaging-nats`, `blobstore-nats`, `postgres-dedicated`, and `egress-public`
- `spec.storageClassName`: optional PostgreSQL PVC storage class; omission uses the cluster default
- Immutable after create: `type`, `provider`
- Status: `Ready` condition and `observedGeneration` only

**BackingService** is the tenant's request for a provisioned capability:

- `spec.type` required; `spec.className` optional (empty → platform default for that type)
- `spec.parameters` may override class defaults for sizing fields only
- `spec.deletionPolicy`: `Retain` (default) \| `Delete` — controls data/PV retention when
  the PostgreSQL service is deleted
- `spec.destinations` (egress only, required there): `host`, `*.suffix`, `host:port`, or
  `*.suffix:port`; `status.approved` lists the approved `host:port` entries
- Immutable: `type`; `className` once set/resolved
- Status conditions: `Ready`, `Provisioning`, `Failed`, `Deleting`, plus
  `observedGeneration`, `classRef`, `runtimeNamespace`, and an `endpoint` summary
  (`host`, `port`, `capability`). Status **never** contains credentials, passwords,
  tokens, connection URLs with auth material, or secret names that encode secrets.

Ownership and installation labels come from the tenant namespace and controller-managed
labels (`platform.di-framework.dev/installation`, owner UID, tenant). Users cannot
spoof cross-tenant ownership by writing labels on the object.

**ServiceBinding** associates a declared application binding with a compatible service:

- `spec.serviceName`: `BackingService` in the **same** namespace (cross-tenant refs rejected)
- `spec.bindingName`: declared application binding (e.g. `stock`, `sync`) → named
  `hostInterfaces[].name`
- `spec.capability`: must match the referenced service's `type`
- `spec.workloadName` is optional documentation/diagnostics only; **authorization is
  tenant-level in v1**, not per workload. Egress bindings require it: it names the
  WorkloadDeployment that receives the grant
- Multiple bindings may share one `BackingService` (warehouse `receive` / `take` /
  `sync` sharing `stock`)
- Status: `Ready` \| `Failed` \| `Deleting`, `observedGeneration`, and
  `serviceRef` (`name`/`uid`/`generation`); never credentials

### Authorization (tenant boundary)

**Decision for v1: the authorization boundary is the tenant, not a user or workload.**

Rationale from the #445 model already shipping in this platform:

- Tenant developers already have Secret CRUD in `di-tenant-<name>` and port-forward
  access to runtime pods. Claiming per-user or per-workload credential isolation
  would contradict that access.
- Redis `prefix` values are naming conventions for key layout, **not** an
  authorization boundary.
- Therefore this API does **not** claim per-user or per-workload credential isolation.

Who may:

| Actor | May |
| --- | --- |
| Platform admin | Manage `BackingServiceClass`; controllers provision infrastructure |
| Tenant developer | Create/update/delete `BackingService` and `ServiceBinding` in their tenant namespace only |
| Tenant viewer | get/list status of those resources |
| Anyone | Cross-tenant references are **rejected**; namespace ownership is source of truth |

Direct Kubernetes API submissions are authorized the same as the CLI: tenant
Roles grant developers edit / viewers read on `BackingService` and
`ServiceBinding`, and ValidatingAdmissionPolicy rejects cross-tenant label
spoofing, unknown classes (fail-closed to approved defaults), cross-namespace
`serviceName` tricks, and forged hostInterface backend selection.

Protected delivery means controller-owned generated ConfigMaps/Secrets that tenants
cannot forge or mutate to bypass provisioning — **not** secrecy from tenant
developers who can already read Secrets in their namespace.

### Runtime feasibility (wasmCloud 2.8+/2.9 hostInterfaces)

Verified against the wasmCloud Host Interface Configuration Reference:

- Named `hostInterfaces` entries are **required** for independent Redis/NATS backend
  selection. Unnamed `wasi:keyvalue` and unnamed `wasmcloud:messaging` entries ignore
  backend-selection keys on stock hosts.
- Config merge order: inline `config` ← `configFrom` ← `secretFrom` (later wins).
- Keyvalue Redis (named entry): `backend=redis`, `url` required, `prefix` optional
  (layout only, not auth).
- Messaging NATS (named entry): `backend=nats`, `url` required; subscriptions /
  consumer groups remain workload-owned configuration.
- `secretFrom` delivers credentials to the host plugin. Kubernetes Secrets in the
  tenant namespace remain readable by developers.
- Scheduler/control-plane NATS (TLS, host `wasmcloudNatsUrl` / `--scheduler-nats-url`)
  is **distinct** from application messaging `BackingService` NATS. Never conflate
  them with application backends, the registry, or the operator.

**API implication:** each `ServiceBinding` resolves to a **named** hostInterface whose
name is `spec.bindingName`. Controllers generate protected config references; do not
rely on unnamed interfaces for multi-service selection (#451). Managed PostgreSQL
uses two entries named `<bindingName>-query` and `<bindingName>-prepared`.

### ServiceBinding projection (#451)

The controller reconciles each `ServiceBinding` into a tenant-namespace ConfigMap
named **`di-binding-<bindingName>`** (and optionally a Secret
`di-binding-<bindingName>-creds` when credential keys exist on the service connection
Secret). Admission (#452) already blocks tenant create/update/delete of these names.

Projected ConfigMap keys (never copied into CR status or controller logs):

| Capability | Keys | Notes |
| --- | --- | --- |
| `keyvalue` (Redis) | `backend=redis`, `url`, `prefix=<bindingName>:` | `prefix` is key layout only, not auth |
| `messaging` (NATS) | `backend=nats`, `url` | Subscriptions / consumer groups stay on the workload |

`url` is derived from the referenced `BackingService` `status.endpoint` (Ready required).
Application messaging uses `di-bs-<service>` endpoints — **not** runtime data-plane
`di-nats`. Independent NATS instances are selected by giving each binding a distinct
`bindingName` and a named hostInterface that `configFrom`s the matching projection.

**WorkloadDeployment shape** (CLI/deploy decorator wiring is #455; controllers provide
the projected resources today):

```yaml
hostInterfaces:
  - name: stock          # == ServiceBinding.spec.bindingName
    namespace: wasmcloud
    package: keyvalue
    configFrom:
      - name: di-binding-stock
  - name: sync
    namespace: wasmcloud
    package: messaging
    configFrom:
      - name: di-binding-sync
    # optional workload-owned subscription knobs in `config:` only
```

Multiple `ServiceBinding` objects may share one `bindingName` (warehouse components
sharing `stock`) when they agree on `serviceName` + `capability`. Projection ownership
is deterministic (lexicographically first live binding UID). Deleting the last peer
removes the ConfigMap/Secret; credential rotation or endpoint changes update the
projection on the next reconcile. Status is `Ready` \| `Failed` \| `Deleting` with
`serviceRef` only — never passwords, tokens, or URLs with auth material.

### Distinguishing application vs control-plane dependencies

| Concern | Resource |
| --- | --- |
| Application Redis / app NATS | `BackingService` → `di-bs-<name>` Deployment/Service in `di-runtime-<tenant>` |
| Runtime data-plane NATS | Tenant reconcile → fixed `di-nats` (host `--data-nats-url`); not a BackingService |
| Scheduler NATS, OCI registry, wasmCloud operator, tenant host pool | Platform / tenant runtime provisioning (not `BackingService`) |
| Transitional warehouse Redis | Tenant reconcile still creates `di-redis` + `di-tenant-stock` until #456 |

Today's tenant controller still provisions per-tenant Redis/NATS deployments and the
`di-tenant-stock` ConfigMap as a transitional warehouse path. Later issues replace
that with explicit `BackingService` / `ServiceBinding` objects **without silent data
loss**: migration (#456) must retain volumes when `deletionPolicy: Retain` and must
not delete hostPath/PV data when swapping the ConfigMap for binding-projected config.

### Versioning and validation

- Group/version matches Tenant/User: `platform.di-framework.dev/v1alpha1`.
- CEL `x-kubernetes-validations` cover immutable `type`/`provider`/`className`,
  type↔provider compatibility, and `SelectedTenants` requiring `allowedTenants`.
- Same-namespace service existence and capability match against the live service
  are enforced by controllers (#450/#451); admission rejects cross-namespace
  `serviceName` forms and unknown `className` values fail-closed against approved
  defaults. Unique default-per-type and forge-resistant `di-bs-` / `di-binding-`
  config names are enforced in admission (#452); TypeScript helpers encode the same
  rules for unit tests and reconciler use.

## Dedicated PostgreSQL (upcoming release)

The upcoming framework release adds the `postgres` capability and the default
`postgres-dedicated` class. Each BackingService owns one PostgreSQL 18 instance,
one PVC, and application credentials. Defaults are **1Gi storage, 512Mi memory,
and 250m CPU**. Multiple applications may share a service; distinct services have
separate databases, volumes, and passwords.

Update the platform package and apply its existing Pulumi stack before using
these APIs. Update the application CLI extension and `@di-framework/bindings`
together. Managed named imports require `@di-framework/componentize-qjs`
`0.4.4-di.3` or later; the CLI installs the compiler dependency.

### Create and bind

```bash
di-framework platform service create postgres --name orders --target alpha \
  --storage 1Gi --memory 512Mi --cpu 250m --wait --timeout 180
di-framework platform service create postgres --name audit --target alpha --wait
```

Declare the bindings in `src/bindings.ts` (or the project's configured bindings file):

```typescript
import { Postgres, WasmCloudBinding } from '@di-framework/bindings';

@WasmCloudBinding('orders-db', { serviceName: 'orders' })
export class OrdersDatabase extends Postgres {}

@WasmCloudBinding('audit-db', { serviceName: 'audit' })
export class AuditDatabase extends Postgres {}
```

Deploy with `di-framework platform deploy --target alpha`. The CLI validates the
same-namespace references, creates deterministic ServiceBindings for that workload,
and waits for their readiness before applying the WorkloadDeployment. Inferred
workload members use the same binding discovery. Obsolete associations are removed
after a successful rollout and when a workload is destroyed. Another workload using
the same binding keeps the shared projection alive. A shared binding name must refer
to the same service and capability throughout the tenant.

Each binding imports its own `<binding>-query` and `<binding>-prepared` interfaces;
PostgreSQL types remain shared. Each named host interface references the protected
`di-binding-<binding>-creds` Secret containing its complete connection URL. The
controller keeps administrator credentials exclusively in the runtime namespace.
The application connects to database `app` as its non-superuser owner `app`.

`serviceName` currently supports PostgreSQL only. It cannot be combined with
`secretFrom`, `configFrom`, or `config`. Managed binding names are DNS labels of at
most 54 characters; service names are at most 40. Existing decorators without
`serviceName` retain their existing configuration behavior.

### Storage and readiness

Managed local platforms install Rancher Local Path Provisioner **v0.0.34**, with
data under `/var/lib/k0s/di-postgres` inside the persistent k0s Docker volume.
Existing clusters need a working default StorageClass, or an administrator can set
`spec.storageClassName` on `postgres-dedicated` before creating services:

```bash
kubectl patch backingserviceclass postgres-dedicated --type merge \
  -p '{"spec":{"storageClassName":"fast-ssd"}}'
```

A provisioned PVC keeps its selected StorageClass even if the class definition
changes. Storage cannot shrink. Expansion requires a StorageClass with
`allowVolumeExpansion: true`; local-path does not support expansion. Requested
capacity participates in Kubernetes quota accounting, but **local-path does not
enforce that capacity on disk**. CPU and memory requests and limits apply to each
instance. Backend NetworkPolicy permits tenant hostgroup ingress.

Readiness authenticates to the application database and runs `SELECT 1` after
idempotent startup bootstrap. `StoragePending` points to PVC/provisioner or scheduling
problems; `Initializing` waits for bootstrap; `InitializationFailed` points to runtime
pod logs. A `CredentialsMissing` failure requires restoring the original runtime
Secret. The controller never generates replacement passwords for an existing PVC.
Suspending the tenant stops the instance and preserves its PVC and credentials;
resuming uses both again.

### Delete and recover

Deletion blocks while any ServiceBinding references the service. Its status lists
the blocking associations, existing connections remain available, and new
associations are refused. Remove the binding from application source and redeploy,
or destroy the consuming workload. Remove manually created ServiceBindings with
`kubectl delete servicebinding <name> -n di-tenant-alpha`.

After all associations are removed, the controller stops PostgreSQL and waits for
its pods to terminate:

- **Retain** (default): removes serving resources, keeps the PVC and both runtime
  credential Secrets for administrator recovery.
- **Delete**: removes serving resources, credentials, and the PVC, and waits for
  completion before releasing the BackingService finalizer. Physical volume
  reclamation follows the StorageClass reclaim policy.

Select deletion policy at creation with `--deletion-policy Delete`, or update it
before deletion:

```bash
kubectl patch backingservice audit -n di-tenant-alpha --type merge \
  -p '{"spec":{"deletionPolicy":"Delete"}}'
di-framework platform service delete audit --target alpha
```

Persistent resource names include a hash of the BackingService UID. Recreating
`orders` creates fresh storage and credentials, so it cannot silently inherit a
retained database. Administrators can find retained resources by service label:

```bash
kubectl get pvc,secret -n di-runtime-alpha \
  -l platform.di-framework.dev/service=orders
```

For recovery, identify the retained PVC and matching `-auth` Secret from the same
UID generation. Mount that PVC into an administrator-managed PostgreSQL 18 recovery
pod at `/var/lib/postgresql`, set `PGDATA=/var/lib/postgresql/18/docker`, and use
`envFrom.secretRef.name` with the retained `-auth` Secret. Use `pg_dump -U app -d app`
with `PGPASSWORD=$APP_PASSWORD` inside that pod to export data, then restore into a
new service. Do not mount the retained PVC concurrently with another PostgreSQL
instance. Back up recovery credentials securely alongside database backups.

For example, replace `RETAINED_PVC` and `RETAINED_AUTH_SECRET` below with names
from the same retained generation, then apply this recovery pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: orders-recovery
  namespace: di-runtime-alpha
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  containers:
    - name: postgres
      image: postgres:18.3-bookworm
      resources:
        requests: {cpu: 250m, memory: 512Mi}
        limits: {cpu: 250m, memory: 512Mi}
      envFrom:
        - secretRef:
            name: RETAINED_AUTH_SECRET
      env:
        - name: PGDATA
          value: /var/lib/postgresql/18/docker
      volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql
      readinessProbe:
        exec:
          command: [pg_isready, -h, 127.0.0.1, -U, app, -d, app]
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: RETAINED_PVC
```

```bash
kubectl wait pod/orders-recovery -n di-runtime-alpha --for=condition=Ready --timeout=180s
kubectl exec -n di-runtime-alpha orders-recovery -- \
  bash -c 'PGPASSWORD="$APP_PASSWORD" pg_dump -h 127.0.0.1 -U app -d app -Fc' > orders.dump
kubectl delete pod orders-recovery -n di-runtime-alpha --wait=true
```

Restore `orders.dump` with `pg_restore --no-owner` into the new service's `app`
database using its application credentials. Keep the retained PVC and credentials
until the restored data has been verified.

Retention is not a backup: deleting the runtime namespace or the underlying
platform volume can still destroy retained data and credentials. Initial support
provides one instance with authenticated internal connections. Automated backups,
replication, TLS provisioning, major-version upgrades, and credential rotation
remain future work.


### Verify on an isolated cluster

After building the packages and installing a local platform with a registry and a
ready tenant, run the opt-in scenario from the framework repository:

```bash
DI_POSTGRES_KUBECONFIG=/path/to/validation.kubeconfig \
DI_POSTGRES_REGISTRY_PUSH=127.0.0.1:29500/validation \
DI_POSTGRES_REGISTRY_PULL=di-framework-registry.wasmcloud.svc.cluster.local:5000/validation \
DI_POSTGRES_HTTP=http://127.0.0.1:29580 \
DI_POSTGRES_TENANT=alpha \
bun scripts/verify-postgres-live.ts
```

Supply registry and HTTP port forwards when needed. The script creates uniquely
named services and workloads, verifies independent databases and credentials,
sharing, persistence, admission, deletion blocking, both deletion policies and
recreation, then removes its resources. A failed run leaves its resources for
inspection; use a disposable validation cluster.
