# Platform backing services

With the local platform release, tenant developers request Redis, NATS, blobstore, dedicated PostgreSQL, and egress
services through `di-framework platform service`. `@di-framework/platform` publishes from
[di-framework/platform](https://github.com/di-framework/platform) and installs their Kubernetes
APIs, provisions the backends, and projects connection configuration for bindings. The CLI
commands live in `@di-framework/cli-plugin-platform` from
[di-framework/cli-extensions](https://github.com/di-framework/cli-extensions).

Redis and NATS requests, and the `BackingService` / `ServiceBinding` APIs, landed in **5.3.6**.
Dedicated PostgreSQL and `Postgres` `serviceName` wiring ship in **6.0**. Blobstore, egress,
tenant kubeconfigs, and the gateway are in the published **6.x** line, current release
**6.0.30** (`@di-framework/bindings` **6.0.30**), with `@di-framework/cli-plugin-platform`
**6.3.0**. `di-framework-kube` installs `@di-framework/platform@6.0.29` by default unless you
pass `--platform-package`.

## Resources and capabilities

| Resource | Scope | Purpose |
| --- | --- | --- |
| `BackingServiceClass` | Cluster | Administrator-owned provider, sizing defaults, limits, and tenant visibility. |
| `BackingService` | Tenant namespace | Request `keyvalue` (Redis), `messaging` (NATS), `blobstore`, `postgres`, or `egress`. |
| `ServiceBinding` | Tenant namespace | Associate a binding name with a service and create protected host configuration. |

All three use `apiVersion: platform.di-framework.dev/v1alpha1`. The release adds their
installation, reconciliation, tenant RBAC, admission policies, quotas, and backend network
policies, together with the `service create`, `list`, `get`, `delete`, and `classes` commands.

For tenant `alpha`, requests and binding projections live in `di-tenant-alpha`. Backend
Deployments, Services, and connection Secrets live in `di-runtime-alpha`. A service named
`stock` gets resources named `di-bs-stock` and a connection Secret named `di-bs-stock-conn`.

## Prepare the platform and target

Use `@di-framework/platform` **6.0.30**, `@di-framework/bindings` **6.0.30**, and
`@di-framework/cli-plugin-platform` **6.3.0**.
Updating application packages alone does not update the platform controller or CRDs.
An administrator must update the platform package and apply the existing Pulumi stack. For
an extension-managed project:

```bash
cd deploy/platform
npm install --save-exact @di-framework/platform@6.0.30
pulumi preview --stack dev
```

Then run `di-framework platform cluster up local --yes` from the workspace root. Keep
the existing project, backend, stack, and tenant declarations. For a kube-managed installation,
select the platform package through [kube's existing instance](kube.md#build-and-start-the-platform);
avoid creating a second stack for the same cluster.

The administrator must have declared the tenant and granted the caller a developer membership.
The controller issues a ServiceAccount token per membership; the platform secret output
`kubeconfigs` provides tenant kubeconfigs after `pulumi up`. See
[tenant kubeconfigs](platform.md#tenant-kubeconfigs-and-http-gateway). Distribute the tenant
credential, never the admin kubeconfig. The kube CLI does not yet re-export that output.

Service commands use `kubectl` with the credentials resolved from the selected
[`di-framework.deploy.toml` target](platform.md#deployment-manifest). They create custom
resources through the Kubernetes API; the platform controller provisions the backend.
For an external target, use the caller's tenant kubeconfig:

```toml
default-target = "alpha"

[targets.alpha]
kubeconfig = "${KUBECONFIG}"
tenant = "alpha"
registry = "registry.example.test/team"
```

The target schema includes a registry even when running only service commands. Service commands
do not publish an application image. `--target`, `--namespace`, and `--context` select the
connection; omitting `--namespace` uses the target's namespace. With a managed target, explicitly
select the tenant namespace if the platform outputs point to the platform namespace.

## Create and inspect a service

```bash
di-framework platform service classes --target alpha
di-framework platform service create keyvalue --name stock --target alpha --wait
di-framework platform service create messaging --name events --target alpha --wait
di-framework platform service list --target alpha
di-framework platform service get stock --target alpha --json
```

| Capability | Default class | Provider | Default sizing |
| --- | --- | --- | --- |
| `keyvalue` | `keyvalue-redis` | Redis | `128Mi` memory, `250m` CPU, `1Gi` storage parameter |
| `messaging` | `messaging-nats` | NATS with JetStream | `128Mi` memory, `250m` CPU, `1Gi` storage parameter |
| `blobstore` | `blobstore-nats` | NATS JetStream object store | `128Mi` memory, `250m` CPU, `1Gi` storage parameter |
| `postgres` | `postgres-dedicated` | PostgreSQL 18 | `512Mi` memory, `250m` CPU, `1Gi` PVC |
| `egress` | `egress-public` | Approved outbound destinations | No backend instance |

Names contain lowercase letters and digits separated by hyphens, start with a letter, and have
at most 40 characters. `create` requires a type and `--name`; it rejects an existing name.
Use `--class`, `--memory`, `--cpu`, and `--storage` to request class-approved settings:

```bash
di-framework platform service create keyvalue --name cache --target alpha \
  --class keyvalue-redis --memory 256Mi --cpu 500m --storage 2Gi \
  --deletion-policy Retain --wait --timeout 180
```

`--wait` polls the Ready condition every two seconds; its default timeout is 120 seconds.
Without it, successful creation means the API accepted the request. `get` and `list` report
readiness and endpoint summaries. A failed class lookup or invalid sizing reports `Failed`;
a Deployment that is still starting reports `Provisioning`. Fix the request or platform
configuration and let the controller retry.

`classes` attempts to read cluster classes and falls back to the built-in defaults when none
are returned or the query fails. Tenant roles do not grant cluster-wide class access. A fallback
listing does not prove those classes are installed or that the caller can use them.

### Class configuration and limits

Platform installation seeds `keyvalue-redis`, `messaging-nats`, `blobstore-nats`,
`postgres-dedicated`, and `egress-public` by
default. The Pulumi `seedDefaultBackingClasses` setting disables automatic seeding when
`false`; `backingServiceClasses` supplies named class declarations that replace matching
defaults or add classes. Classes support `AllTenants` and `SelectedTenants` visibility; the
latter uses `allowedTenants`.

5.3.6 admission accepted only `keyvalue-redis` and `messaging-nats`. 6.0 also accepts
`postgres-dedicated`; the local platform release adds `blobstore-nats` and `egress-public`.
Adding another class name still does not make it usable by tenant
requests. Administrators can adjust the approved classes' sizing and visibility while
retaining their names.

Default class bounds are `64Mi`–`2Gi` memory, `50m`–`2` CPU, and `256Mi`–`20Gi` for the storage
parameter. Requests must also fit the tenant's CPU and memory budget. Tenant resource settings
`backingServices` and `serviceBindings` cap custom-resource counts, with defaults of 10 and 40.
Runtime ResourceQuota also covers compute and declares a `50Gi` storage-request budget.

Redis and NATS backends currently use node-local hostPath storage. Their storage parameter is
validated, but does not allocate a PVC or enforce a filesystem size limit. PostgreSQL uses a PVC. The storage-request quota does not
limit bytes written to those host paths.

## Project a binding

Create a `ServiceBinding` in the same namespace as its `BackingService`. Save this as
`stock-binding.yaml` and apply it with the same kubeconfig used by the target:

```yaml
apiVersion: platform.di-framework.dev/v1alpha1
kind: ServiceBinding
metadata:
  name: warehouse-stock
  namespace: di-tenant-alpha
spec:
  serviceName: stock
  bindingName: stock
  capability: keyvalue
```

```bash
kubectl apply -f stock-binding.yaml
kubectl -n di-tenant-alpha get servicebindings.platform.di-framework.dev warehouse-stock -o yaml
kubectl -n di-tenant-alpha get configmap di-binding-stock
```

There is no ServiceBinding create command in 5.3.6. The controller checks that the referenced
service exists in the same namespace, matches the capability, and is Ready with an endpoint.
Unresolved or conflicting bindings report `Failed` and are retried on later reconciliations.

The controller creates `di-binding-<bindingName>` in the tenant namespace:

| Capability | ConfigMap keys |
| --- | --- |
| `keyvalue` | `backend=redis`, `url`, `prefix=<bindingName>:` |
| `messaging` | `backend=nats`, `url` |

When the backend connection contains supported credential fields, they are projected into a
separate `di-binding-<bindingName>-creds` Secret. Default Redis/NATS provisioning does not
configure backend authentication, so that Secret may be absent. CR status contains references
and readiness, never credential values.

Multiple ServiceBindings can share a `bindingName` when they agree on `serviceName` and
`capability`. The controller retains the shared projection while any matching binding remains,
including when the elected owner is removed. Deleting the last binding removes its projection;
it does not delete the BackingService. Endpoint and credential changes are reconciled into the
projection.

### Workload integration boundary

The projected configuration is intended for a **named** wasmCloud host interface. This fragment
shows the host-side contract for `stock`; it is not a complete deployable workload:

```yaml
hostInterfaces:
  - name: stock
    namespace: wasmcloud
    package: keyvalue
    configFrom:
      - name: di-binding-stock
    # Add secretFrom only when di-binding-stock-creds exists.
```

A messaging entry uses `package: messaging` and its own binding name. Subscription options stay
in the workload's inline `config`.

**Redis and NATS decorator wiring is not included in 5.3.6 or 6.0.** Creating those services
and bindings does not modify an existing workload or change its guest imports. The
[QuickJS native binding path](platform.md#host-interface-discovery) still emits unnamed provider
requirements for those capabilities. End-to-end named-backend deployment wiring is tracked in
[issue #455](https://github.com/di-framework/di-framework/issues/455).

PostgreSQL is the exception in 6.0: a `Postgres` binding with `serviceName` makes
`platform deploy` create the `ServiceBinding`, wait until it is ready, and apply the workload.
See [Dedicated PostgreSQL](#dedicated-postgresql).

The Kubernetes `ServiceBinding` resource is also separate from the in-process
[`@ServiceBinding` decorator](https://docs.di-framework.dev/service-bindings.html).

## Blobstore

Create a NATS JetStream object store using the default `blobstore-nats` class:

```bash
di-framework platform service create blobstore --name catalog --wait
```

Bind it in the console or apply a ServiceBinding with the tenant kubeconfig:

```yaml
apiVersion: platform.di-framework.dev/v1alpha1
kind: ServiceBinding
metadata:
  name: catalog-objects
  namespace: di-tenant-alpha
spec:
  serviceName: catalog
  bindingName: objects
  capability: blobstore
```

The guest selects the projected configuration while the host interface stays unnamed:

```typescript
import { Blobstore, PlatformBinding } from '@di-framework/bindings';

@PlatformBinding('objects', { configFrom: 'di-binding-objects' })
export class Objects extends Blobstore {}
```

(`@WasmCloudBinding` remains exported as a deprecated alias of `@PlatformBinding` for backward
compatibility.)

Each guest container is its own bucket. Without `configFrom`, wash 2.8 gives each component a
private in-memory store. Members that share objects must bind a created service; `serviceName`
on a binding decorator remains PostgreSQL-only. The
[platform example](https://docs.di-framework.dev/deployment.html#one-command-local-platform-example) shares `mesh-objects`
between the collector and site. NATS blobstore needs more than the `128Mi` default under write
churn; that example requests `512Mi` (`--memory 512Mi` when creating a service manually).

## Egress

Request destinations with repeatable `--destination`:

```bash
di-framework platform service create egress --name outbound \
  --destination api.example.com:443 --destination '*.example.org'
di-framework platform service get outbound
```

Accepted forms are `host`, `*.suffix`, `host:port`, and `*.suffix:port`. Platform
`egressAllowedDestinations` controls approval; its empty default approves nothing. `get` shows
requested destinations, approved `host:port` entries, and Ready. Bind the service through a
ServiceBinding with `capability: egress`, `bindingName: egress`, and `workloadName` identifying
the WorkloadDeployment, or use the console Bindings tab for a single-part application. The
console create form does not collect destinations and therefore omits egress.

On a tenant target, deploy turns `allowedIpNameLookups` into `<deployment>-egress` and its
ServiceBinding, refuses to adopt resources it did not create, and updates or removes its own
requests as configuration changes. An unapproved request does not fail deploy; outbound remains
blocked until approval. See [tenant egress and TLS](platform.md#tenant-egress-and-tls) for the
allow-list mapping and tenant host requirements.

## Tenant restrictions

The tenant is the authorization boundary. Developer memberships can create, update, and delete
BackingServices and ServiceBindings in their tenant namespace; viewers can read them. Classes
remain administrator-owned. `workloadName` on a ServiceBinding is descriptive and does not grant
per-workload access; a Redis prefix is a key-naming convention, not authorization.

Kubernetes admission control checks requests before accepting them. Platform policies enforce
ownership labels, approved classes, and same-namespace service references. Tenant workloads may
use restricted `wasi` HTTP/config interfaces and `wasmcloud` keyvalue/messaging/blobstore/PostgreSQL interfaces with
controller-managed references. Arbitrary backend URLs, user-supplied backend references, and
host-volume mounts are rejected. Stock keyvalue and default NATS retain transitional exceptions;
the stock ConfigMap cannot select a messaging backend.

Tenant users cannot mutate the reserved `di-bs-*`, `di-binding-*`, and `di-tenant-stock`
ConfigMaps/Secrets. Tenant Secrets in `di-tenant-<name>` are **write-only** for tenant developers
(`create`, `update`, `patch`, and `delete` only — no `get`, `list`, or `watch`). `ServiceBinding`
metadata and status expose only the projected Secret *name* (`status.secretName`), never Secret
values, while the runtime reads Secret values using the runtime and operator ServiceAccounts in
`di-runtime-<name>` and `di-operator-<name>`. Backend network policies allow
ingress from the tenant hostgroup and require an enforcing network-policy engine; tenant
developers still have runtime pod `portforward` access, so backends are not isolated from other
developers within the same tenant. Shared hosts remain disabled.

## Deletion and existing data

```bash
di-framework platform service delete cache --target alpha
```

`spec.deletionPolicy` defaults to `Retain`:

- **Retain:** scale backend Deployments to zero and wait for the observed shutdown before
  releasing the service finalizer. Backend resources and hostPath data remain.
- **Delete:** request removal of owned Deployments, Services, and connection Secrets, then
  release the finalizer. This does not erase hostPath data or wait for all resource deletion
  to finish.

Tenant suspension scales backends down and reports `Suspended`. Do not treat `service delete`
as a data purge or a check that no application still depends on the service. Deleting a binding
revokes its projected configuration; workload rollout and data migration are separate operations.

Application NATS instances use `di-bs-<name>`. The fixed `di-nats` is the runtime data plane and
is managed by the tenant controller. Existing warehouse `di-redis` / `di-tenant-stock` resources
remain transitional; 5.3.6 does not migrate their data into newly requested services. Full
retention/cleanup and warehouse migration are tracked in
[issue #453](https://github.com/di-framework/di-framework/issues/453) and
[issue #456](https://github.com/di-framework/di-framework/issues/456).

## Troubleshooting

| Result | Check |
| --- | --- |
| `WASMCLOUD_SERVICE_UNAUTHORIZED` | The target kubeconfig, namespace, and tenant membership. |
| `WASMCLOUD_SERVICE_ALREADY_EXISTS` | Inspect the existing service or choose a new name. |
| `WASMCLOUD_SERVICE_NOT_READY` | Inspect service conditions, class visibility/sizing, and Deployment readiness; increase `--timeout` only if provisioning is still progressing. |
| `WASMCLOUD_SERVICE_PROVISIONING_FAILED` | Read the service's failure condition and correct the request or platform configuration. |
| Binding reports `Failed` | Check same-namespace service existence/readiness, matching capability, and conflicting bindings with the same `bindingName`. |
| Resource name cannot be adopted | Existing resources belong to another service UID; inspect retained resources before reusing a deleted service name. |

## Dedicated PostgreSQL

`@di-framework/platform` **6.0** adds the `postgres` capability and the default
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
import { PlatformBinding, Postgres } from '@di-framework/bindings';

@PlatformBinding('orders-db', { serviceName: 'orders' })
export class OrdersDatabase extends Postgres {}

@PlatformBinding('audit-db', { serviceName: 'audit' })
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

### Transaction semantics

`wasmcloud:postgres@0.2.0` provides `query` and `queryBatch` with no transaction handle. Named
and unnamed imports alike are served from a per-credential connection pool with no connection
affinity across separate `query` calls: sending `BEGIN` in one `query` call does not pin a
connection for the next statement, and a subsequent `COMMIT` can land on a different pooled
connection while leaving the first connection `idle in transaction`.

Keep atomic invariants inside a single statement:

- a conditional `UPDATE … RETURNING`
- a data-modifying CTE (`WITH … INSERT / UPDATE / DELETE`)
- `INSERT … SELECT … WHERE NOT EXISTS`

When using `@di-framework/repo`, open the binding with `openPostgresDatabase` from
`@di-framework/bindings/postgres`:

```typescript
import { openPostgresDatabase } from '@di-framework/bindings/postgres';

const db = openPostgresDatabase(ordersDatabase);
await db.atomicBatch([
  { sql: 'INSERT INTO ledger (account, delta) VALUES (?, ?)', params: ['acct-1', -50] },
  { sql: 'UPDATE balances SET amount = amount - 50 WHERE account = ?', params: ['acct-1'] },
]);
```

`openPostgresDatabase` returns an `AutocommitDatabase` where each statement executes as its own
transaction and `transaction(fn)` runs `fn` on the same autocommit handle without sending `BEGIN`,
`COMMIT`, or `ROLLBACK` (`FOR UPDATE` and advisory locks last only for the statement that carries
them). For write-only multi-statement sequences that do not read between statements, `atomicBatch`
renders parameter literals safely and submits the script as a single `queryBatch` call, which the
host executes on one pooled client as a single implicit PostgreSQL transaction that rolls back
cleanly on error.

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
