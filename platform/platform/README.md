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

Each `tenants` entry is a Tenant CR: `name` is the CR name and every other key is its
`spec`. For example, `tenants: [{ name: identity, runtime: { coreInstances: 300 } }]`.

### Tenant host core instances

`spec.runtime.coreInstances` (integer, `1`–`10000`, default `100`) sets
`WASH_CORE_INSTANCES` on the tenant's hostgroup Deployment. The CRD schema enforces the
bounds, and `pulumi up` rejects an out-of-range `tenants[].runtime.coreInstances` before
it reaches the cluster. Changing the value changes the host pod template, so it rolls the
tenant host.

Do not `kubectl set env` the hostgroup Deployment. An Update like that takes ownership of
the env value away from `di-platform-controller`, and every later server-side apply
of that Deployment fails with 409, which blocks the whole apply (not only the env field;
see `docs/hostgroup-409-diagnosis.md`). The controller never force-applies. To clear a
hand edit that already exists, run this procedure once per Deployment. For `identity`
(live value `300`):

> **Warning (rollout):** step 1 is the controller's first successful apply on
> `hostgroup-tenant-identity` since 2026-10-07. It lands the #104 `strategy` and any
> pod-template changes accumulated since, so identity's single host may roll once.

```sh
T=identity
OWNERS='.metadata.managedFields[] | select([.fieldsV1 | .. | objects | select(has("k:{\"name\":\"WASH_CORE_INSTANCES\"}")) | .["k:{\"name\":\"WASH_CORE_INSTANCES\"}"] | has("f:value")] | any) | .manager'
```

1. If this `pulumi up` also upgrades the package past #123, first run it with `coreInstances`
   unset (see "Upgrading to a version that adds a Tenant spec field"), then set identity's
   `coreInstances: 300` in the `di-framework-kube:tenants` config
   (`tenants: [{ name: identity, runtime: { coreInstances: 300 } }]`) and run `pulumi up`.
   On a cluster that has the `kubectl set env` hand edit, the first `pulumi up` (with
   `coreInstances` unset) makes the controller declare `"100"` against the live `300`. That
   still 409s, so the Tenant stays not Ready and nothing rolls back. This is expected until
   the second `pulumi up` sets 300.
2. Wait until the Tenant is `Ready=True` and `di-platform-controller` owns `f:value` on the
   `WASH_CORE_INSTANCES` env entry. Do not continue until both hold:

   ```sh
   kubectl get tenant $T -o json | jq -r '.status.conditions[] | select(.type=="Ready") | .status'   # True
   kubectl get deploy hostgroup-tenant-$T -n di-runtime-$T --show-managed-fields -o json | jq -r "$OWNERS"
   # must list di-platform-controller (and still kubectl-set)
   ```

3. Remove the stale `kubectl-set` entry. The two `test` ops make the patch atomic: it
   applies only if that index still holds the `kubectl-set` `Update` entry.

   ```sh
   i=$(kubectl get deploy hostgroup-tenant-$T -n di-runtime-$T --show-managed-fields -o json \
     | jq '.metadata.managedFields | map(.manager=="kubectl-set" and .operation=="Update") | index(true)')
   if [ "$i" = null ]; then echo "no kubectl-set entry; nothing to remove"; else
     kubectl patch deploy hostgroup-tenant-$T -n di-runtime-$T --type=json \
       -p "[{\"op\":\"test\",\"path\":\"/metadata/managedFields/$i/manager\",\"value\":\"kubectl-set\"},{\"op\":\"test\",\"path\":\"/metadata/managedFields/$i/operation\",\"value\":\"Update\"},{\"op\":\"remove\",\"path\":\"/metadata/managedFields/$i\"}]"
   fi
   ```

4. Re-check that only `di-platform-controller` owns the value:

   ```sh
   kubectl get deploy hostgroup-tenant-$T -n di-runtime-$T --show-managed-fields -o json | jq -r "$OWNERS"
   # must print exactly: di-platform-controller
   ```

The order matters. If step 3 runs before the controller owns the value (step 2), removing
`kubectl-set` leaves `WASH_CORE_INSTANCES` unowned, and the next apply sets `"100"`,
rolling the host back from 300.

#### Upgrading to a version that adds a Tenant spec field

`pulumi up` cannot add a Tenant spec field to the CRD and set it on an existing Tenant in
one update. The preview dry-runs the Tenant against the live CRD schema, before the CRD
is updated, and fails with:

```text
failed to create typed patch object (/identity; platform.di-framework.dev/v1alpha1, Kind=Tenant): .spec.runtime.coreInstances: field not declared in schema
```

The provider cannot skip that dry-run for one resource without force-applying or changing
the field manager, so upgrade in two steps. This order applies to any new Tenant field:
first run `pulumi up` with the new package and the field unset (this updates the CRD
schema, controller and tenant-auth image), then set the field (for example
`runtime.coreInstances`) and run `pulumi up` again.

#### Upgrading to exact plain-HTTP registries for tenant hosts (#149)

Before this change, `insecureRegistry` gave tenant hosts `--allow-insecure-registries`, so
they pulled every registry over plain HTTP. Tenant hosts now get one `--insecure-registry` per
allowlisted registry and pull everything else over TLS. Check three things before `pulumi up`:

- **Existing-cluster installs with `insecureRegistry`.** The existing entrypoint installs no
  platform registry, so its allowlist is empty unless you set `insecureRegistries`. List every
  plain-HTTP registry that tenant workload references use, as `host:port` with no scheme or path,
  spelled exactly as the references spell it (wash matches case-sensitively and does not add a
  default port). For example, kube's examples registry is pulled as
  `examples-registry.<ns>.svc.cluster.local:5000/examples`, so the entry is
  `examples-registry.<ns>.svc.cluster.local:5000`:

  ```sh
  pulumi config set --path 'insecureRegistries[0]' examples-registry.<ns>.svc.cluster.local:5000
  ```

  Set it before or with the upgrade. Without it, tenant workloads from those registries fail to
  pull. Local installs need nothing: they allowlist the platform registry themselves.
- **`tenantHostImage` overrides.** Tenant hosts get `--insecure-registry` whenever the allowlist is
  not empty, which is always the case on a local install. The image must be built with wash patch
  0002, for example the published
  `ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:d88158b0b09edd9fc3e79d787762697c60f65baf134d895529e85d6c47cd80ad`
  or the matching `wasi-tls-exclusive` digest in `platform/tenant-host/README.md`. Older images
  reject the argument and the tenant hosts crash-loop. `createPlatform` refuses the known older
  default, `…@sha256:ee89fd4bce4f9f35f4cd09c63d3cbdd07bea3071b5d372f82c9f49b9741c3669`, with an error
  naming the image; it cannot recognise other pre-0002 builds of your own. Unset `tenantHostImage`
  to use the default.
- **Tenant hosts roll once.** The default host image, the host args and, on insecure installs,
  the mounted controller CA all change, so each tenant host group restarts on the upgrade.

#### Upgrading to tenant hosts that trust the controller CA for `wasi:http` (#113)

- **Tenant hosts with a registry roll once.** When `tenantAuth.registry` is set, each tenant
  host group that already mounts the controller CA (`platform.di-framework.dev/registry-ca-sha256`
  on its pod template) gains `--http-client-ca-path=/registry-ca/ca.crt` in its args, so it
  restarts once on the upgrade. Host groups without a registry keep the same template and do not
  roll. A single-host tenant such as `identity` (`maxSurge: 0, maxUnavailable: 1`) is unavailable
  while its one host restarts, so plan the upgrade for a quiet window.

#### Upgrading to TLS on the controller's whoami listener (#113)

The tenant registry now calls `https://tenant-controller.di-runtime-<tenant>.svc:8789` instead of
`http://…:8789`. Two independently versioned parts change: the tenant controller image
(`tenantAuth.image`), which now serves TLS on `8789`, and the platform package, which renders the
registry's `https://` URL. Neither has to wait for the other:

- **New controller image, registry config still `http://`.** The whoami listener serves TLS and
  plain HTTP on the same port, chosen by the connection's first byte, so the old config keeps
  working. The host pull token is accepted on that listener over either protocol, and still
  nowhere else.
- **New platform, controller image still serving plain HTTP only.** The registry's whoami calls
  fail (a TLS handshake against a plain listener), so the registry answers every request that
  needs authorization, host pulls included, with `503` until the controller runs an image from
  this release.

So upgrade in this order:

1. Set `tenantAuth.image` to the tenant-auth digest from this release and run `pulumi up` with
   the platform package you already have. The controller Deployment rolls; nothing else changes.
2. Upgrade the platform package and run `pulumi up` again. The `di-tenant-registry`
   WorkloadDeployment's `tenant-controller-url` becomes `https://…:8789`; the controller,
   NetworkPolicies and hosts do not change for it.

In one `pulumi up` that changes both, the registry can call a controller pod that the rollout has
not replaced yet: registry requests get `503` until the new pod is ready, then recover on their
own. Tenant hosts that predate #113's `--http-client-ca-path` roll in the same
update (see
[Upgrading to tenant hosts that trust the controller CA for `wasi:http`](#upgrading-to-tenant-hosts-that-trust-the-controller-ca-for-wasihttp-113));
until a host has restarted with it, the registry on that host cannot verify the controller and
answers `503` the same way. NetworkPolicy and the registry's egress allowlist name the same host
and port as before, so they do not change. To refuse plain HTTP on `8789` once every registry
uses `https://`, run the controller with `TENANT_CONTROLLER_WHOAMI_TLS_ONLY=true`; the platform
does not set it yet.

#### Upgrading to tenant-auth URLs derived from `routeUrlPattern` (#128)

- **Who is affected.** Installs with config `tenantAuth` set, at least one of
  `tenantAuth.consolePublicUrl`, `tenantAuth.controllerPublicUrl` or (with a registry)
  `tenantAuth.registry.publicUrl` unset, and a routable `routeUrlPattern`
  (`http://{host}.{tenant}.localhost[:<port>]`). That is every local install, whose entrypoint
  always sets the pattern, and every existing-cluster install whose pattern is set or derived
  from a loopback `http://` `httpEndpoint`. Installs without `tenantAuth`, with all of these
  URLs set, or with any other pattern keep their URLs. On the first `pulumi up` with this
  version, the unset URLs change for every Tenant, existing ones included (`<port>` is the
  gateway port, `28180` on a default local install):
  - Console: `http://127.0.0.1:8787` becomes `http://console.<tenant>.localhost:<port>`, so its
    OAuth callback becomes `http://console.<tenant>.localhost:<port>/oidc/callback`.
  - Controller: users and CLIs are shown `https://controller.<tenant>.localhost:<port>` instead
    of `https://127.0.0.1:8788`. The controller certificate is reissued with that name; it still
    covers `127.0.0.1`, so existing port-forward kubeconfigs keep working.
  - Registry: users log in to `https://registry.<tenant>.localhost:<port>` instead of
    `https://127.0.0.1:8790`.
  - Workload hosts: the gateway routes `console.<tenant>.localhost`,
    `controller.<tenant>.localhost` and `registry.<tenant>.localhost` to the tenant's console,
    controller and registry front, so a tenant workload served on one of those route hosts is
    no longer reachable there. Move it to another host first.
- **To adopt the new URLs**, register `http://console.<tenant>.localhost:<port>/oidc/callback`
  for every tenant as a redirect URI on the shared OAuth client (`tenantAuth.oauthClient.id`)
  before `pulumi up`. Until it is registered, console login fails for that tenant.
- **To keep the previous `127.0.0.1` URLs**, set them explicitly before upgrading (skip the
  registry line without `tenantAuth.registry`):

  ```bash
  pulumi config set --path tenantAuth.consolePublicUrl http://127.0.0.1:8787
  pulumi config set --path tenantAuth.controllerPublicUrl https://127.0.0.1:8788
  pulumi config set --path tenantAuth.registry.publicUrl https://127.0.0.1:8790
  ```

#### Upgrading to a registry in its own NATS account (#159)

Until this version the tenant registry's blobs and manifests lived in the object store
`OBJ_oci-registry` on the shared, unauthenticated `di-nats`, in the same account as the hosts'
data client. A tenant workload could reach them with raw `$JS.API.*` / `$O.*` requests or a mirror
of the stream, bypassing the registry's push authorization. Subject permissions cannot close that
(a mirror or source copies the stream), and the registry runs on the same host pods as the
workloads, so a NetworkPolicy cannot either. The registry now has its own NATS account.

**What changes on `pulumi up`**

- Every tenant's `di-nats` gets accounts. Clients without credentials log in as the `no_auth_user`
  of `TENANT`, so host plugins and tenant keyvalue, messaging and blobstore keep working unchanged.
  JetStream data of the server's default (`$G`) account is not available once accounts exist, so
  a new init step of `di-nats` renames `<storageRoot>/di-tenants/<tenant uid>/di-nats/jetstream/$G`
  to `.../jetstream/TENANT` before the server starts. It runs once and never overwrites an existing
  `TENANT` directory. If both exist (for example after a downgrade that skipped the rename back),
  the step fails and `di-nats` does not start (`Init:CrashLoopBackOff`), rather than serving one of
  the two stores silently: keep the one that holds the current data and move the other out of
  `jetstream/`. `di-nats` restarts once.
- The platform default host image moves to the `wasi-tls` build with wash patch 0003
  (`ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:e27812be…`), so tenant hosts roll once.
- With `tenantAuth.registry`, on a host image known to carry wash patch 0003 (below), each tenant
  also gets:
  - Secret `di-nats-registry` in `di-runtime-<tenant>` (`kubernetes.io/basic-auth`, user
    `registry`, a random password the platform controller generates). `di-nats` reads the password
    from the environment (`DI_NATS_REGISTRY_PASSWORD`); the ConfigMap never holds it.
  - The `REGISTRY` account on `di-nats`, and a read-only mount of the Secret in the tenant host pods
    at `/var/run/secrets/di-framework/registry-nats` (`username`, `password`). Tenant hosts roll
    once. Guest volumes cannot reach it: admission admits workload `hostPath` volumes only under
    `/var/lib/di-framework/workloads/<key>`, for the controller too.
  - Once the store has moved (below), the registry's blobstore entry gains
    `user_file: /var/run/secrets/di-framework/registry-nats/username` and
    `password_file: /var/run/secrets/di-framework/registry-nats/password`. Admission admits these two
    keys only from the platform controller, only on the registry's entry, only together, and only
    with exactly these values; `di-bs-*` and `di-binding-*` ConfigMaps and Secrets can never carry
    them.
  - Who can read the password: the platform controller, which writes it, and the tenant
    controller (tenant-auth), whose `tenant-controller-keys` Role reads every Secret in
    `di-runtime-<tenant>` because its API-key Secrets have generated names that `resourceNames`
    cannot list. Both are platform components already in the registry's trust path (the tenant
    controller authorizes every registry request); tenant users and workloads cannot read it.

**The one-time move of the registry store**

The existing `OBJ_oci-registry` is in `TENANT` after the rename, so the registry would see an empty
store if it switched to `REGISTRY` at once. The controller therefore switches it only after a
one-shot Job has moved the store:

1. While `di-nats` and the tenant hosts roll out with the new account and mount, the registry keeps
   running anonymously against its store in `TENANT`.
2. Once both are rolled out, the controller stops the registry (`di-tenant-registry` replicas 0).
   It creates no Job in that pass. `TenantAuthReady` is `False` with reason `RegistryMigrating`.
3. On a later pass, once it sees the registry stopped (the WorkloadDeployment's status is current
   and counts no replica, every WorkloadReplicaSet of it is at zero, and none of their Workloads is
   left), it creates Job `di-nats-registry-migrate` in `di-runtime-<tenant>`
   (`natsio/nats-box:0.20.0`, pinned by digest) and raises `di-runtime-quota` by the Job's limits
   (`250m` CPU, `128Mi`) while the Job exists. The Job refuses to run unless the anonymous login
   is in `TENANT` and the registry login in `REGISTRY`, copies every live object whose name, size
   and SHA-256 are not already in the destination, lists both stores again and fails unless every
   object matches by size and digest, then deletes the source store and writes the marker key
   `registry-object-store=complete` in KV bucket `di-platform-migrations` of `REGISTRY`.
4. When the Job succeeded, the controller writes ConfigMap `di-nats-registry-migration`
   (`state: complete`), restarts the registry with the credential files, stops rendering the Job
   (Kubernetes removes it a day after it finished) and lowers the quota again.

From the moment the Job exists (or the marker says the move is done), the registry never runs
anonymously again, whatever happens to the host image or a password rotation in between: it stays
stopped until it can log in to `REGISTRY`, so it never recreates `OBJ_oci-registry` in `TENANT`.

Running workloads are not affected while the registry is stopped, but pushes and host pulls from
the tenant registry fail until it is back (a restarted host cannot pull tenant images meanwhile).
The time is about one copy of the store over the pod network. The copy needs free JetStream file
storage of at least the store's size under `runtimeNats.maxFileStore`; if the Job fails with
`insufficient resources`, raise the cap. The Job retries 10 times within one hour
(`activeDeadlineSeconds: 3600`, which also ends a Job whose pod the quota or the scheduler never
admits). When it fails, `TenantAuthReady` says `RegistryMigrationFailed` with the Job's reason
(`BackoffLimitExceeded`, `DeadlineExceeded`) and the registry stays stopped. Read its logs
(`kubectl -n di-runtime-<tenant> logs job/di-nats-registry-migrate`) and events, fix the cause and
delete the Job; the controller recreates it. Every step is safe to repeat: a rerun copies only what
is missing, and a run after the move exits at the marker. A tenant without a registry store only
writes the marker.

**How to verify**

```sh
kubectl -n di-runtime-<tenant> get configmap di-nats-registry-migration -o jsonpath='{.data.state}'  # complete
kubectl -n di-runtime-<tenant> logs job/di-nats-registry-migrate   # "verified N objects ... by size and SHA-256"
kubectl -n di-tenant-<tenant> get workloaddeployment di-tenant-registry \
  -o jsonpath='{.spec.template.spec.hostInterfaces[?(@.package=="blobstore")].config}'  # has user_file/password_file
# Anonymous clients (what a tenant workload gets) no longer see the store:
kubectl -n di-runtime-<tenant> port-forward deploy/di-nats 4222 &
nats --server nats://127.0.0.1:4222 stream ls --names   # no OBJ_oci-registry
nats --server nats://127.0.0.1:4222 account info        # Account: TENANT
```

Then push and pull an image through the registry as usual.

**Password rotation.** Delete Secret `di-nats-registry`; the controller generates a new password.
The pod templates of `di-nats` and the tenant hosts carry a digest of the password
(`platform.di-framework.dev/registry-nats-auth-sha256`), so `di-nats` restarts with the new password
and the hosts roll. The host reads the credential files only when it opens a connection: a pooled
blobstore connection that stays open keeps the password it read and, after the server restarted,
fails to reconnect until a new connection is opened, which happens once the pooled one idled for 5
minutes or the host restarted. The host roll is that restart, so the registry recovers when its host
has rolled. Until then registry requests fail.

**Ordering with the tenant host image.** The credential keys need wash patch 0003
(`platform/tenant-host`); a host without it ignores them, connects anonymously, lands in `TENANT`
and would show the registry an empty store. The controller therefore fails closed: it uses the
credentials only on host images pinned by digest to a build known to carry 0003
(`NATS_CREDENTIALS_HOST_IMAGE_DIGESTS` in `src/tenancy/registry-nats.ts`, today the `wasi-tls`
and `wasi-tls-exclusive` builds pinned in #336). On any other `tenantHostImage` (an earlier build,
an image of your own, or a tag without a digest) a registry that has not moved stays anonymous in
`TENANT`, with no `REGISTRY` account, Secret, mount or Job, and the controller logs a warning once,
as does `pulumi up` when `tenantAuth.registry` is set. A registry that already moved stays stopped
on such an image (`TenantAuthReady` reason `RegistryHostImageUnsupported`) until `tenantHostImage`
is a known 0003 build again. A custom image carrying 0003 has to be added to that list.

So: keep `tenantHostImage` unset (the new default carries 0003), or set it to one of the two pinned
digests from `platform/tenant-host/README.md`, and run `pulumi up`; the move above happens for each
tenant on its own.

Downgrading the platform package below this version needs the rename undone (stop `di-nats`, move
`jetstream/TENANT` back to `jetstream/$G`); the registry's store stays in `jetstream/REGISTRY` and
is not visible to an older version. Upgrading again with both directories present stops `di-nats`
at its init step (see above).

### Tenant removal and namespace retention

Each `tenants` entry takes `deletionPolicy` (`Retain` or `Delete`, default `Retain`). The
controller reads the policy from the Tenant object on the cluster when that object is deleted,
not from your config at that moment.

- `Retain`: the controller scales the workload to zero and keeps the `di-tenant-<name>` and
  `di-runtime-<name>` namespaces. It removes the Tenant's finalizer only after the tenant's host
  pods are gone, terminating ones included, so the runtime operator can still clear their
  finalizers (#245). Finished pods (`Succeeded` or `Failed`, such as evicted ones) do not count.
  While it waits, the Tenant's `Ready` condition is `False` with reason `WaitingForHostPods` and
  names the pods. If a pod stays there (for example on an unreachable node), check it with
  `kubectl get pods -n di-runtime-<name> -o wide`, then bring the node back or remove it from
  the cluster, or as a last resort run
  `kubectl delete pod -n di-runtime-<name> <pod> --grace-period=0 --force`. A pod that still
  lists `runtime.wasmcloud.dev/pod-host-finalizer` after that is waiting for the runtime
  operator; make sure it is running, since it clears the finalizer while the Tenant exists.
- `Delete`: the controller deletes both namespaces, and with them their PVCs (subject to the
  StorageClass reclaim policy). It does not remove the on-disk tenant data directories: backend
  data lives in tenant-UID hostPath directories under the storage root, which namespace deletion
  does not erase.

Kept namespaces stay labelled with the old Tenant UID. A new Tenant with the same name is not
adopted over them and does not pick the old data back up, so re-adding a name after a Retain
removal means deleting the kept namespaces first (below).

When `up` or a preview removes a tenant whose live policy is `Retain` (or unset), it prints a
warning naming the kept `di-tenant-<name>` and `di-runtime-<name>` namespaces and how to remove
them. The check reads the cluster with the program's kubeconfig.

Removing a tenant and its namespaces takes two `up` runs, because once the entry is gone
nothing carries the new policy to the Tenant object:

1. Set `deletionPolicy: Delete` on the entry and run `up`. Wait for the Tenant to report `Ready`.
2. Remove the entry from `tenants` and run `up` again.

```sh
pulumi config set --path 'tenants[0].deletionPolicy' Delete
```

With `di-framework-kube up --platform-config`, the same setting is JSON:
`{"tenants":[{"name":"alpha","deletionPolicy":"Delete"}]}` (the allowlist checks only top-level
keys, so it passes).

A tenant already removed under `Retain` has no Tenant object left to patch. Remove its
namespaces by hand after checking the installation and owner labels:

```sh
kubectl get ns di-tenant-alpha di-runtime-alpha --show-labels
kubectl delete namespace di-tenant-alpha di-runtime-alpha
```

## Existing-cluster configuration

`kubeconfig` is required (a local file path); `context`, `namespace`, `release`,
`chart`, `chartVersion`, `httpNodePort`, `timeoutSeconds`, `insecureRegistry`, `insecureRegistries`,
`storageRoot`, `networkPolicyEngine`, `kubernetesEndpoint`, `httpEndpoint`, `routeUrlPattern`,
`egressAllowedDestinations`, `routeAliases` (see [Gateway route aliases](#gateway-route-aliases)),
`runtimeNats` (see [Runtime NATS storage caps](#runtime-nats-storage-caps)),
and administrator `values` are optional. `tenants`, `users`,
`tenantHostImage`, and `tenantHostImagePullPolicy` use the same declarations as the
local entrypoint. NodePort zero makes the HTTP gateway ClusterIP. Registry installation is off
for existing clusters. `insecureRegistry` gives the platform host group
`--allow-insecure-registries`; tenant hosts get `--insecure-registry` only for each
`insecureRegistries` entry (a list of `host[:port]`, spelled exactly as workload references spell
the registry, requires `insecureRegistry`), so their other pulls stay TLS (#149). Shared hosts are disabled regardless of values overrides. Set `networkPolicyEngine`
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
deleting the user, or suspending, deleting or removing the tenant deletes the matching
Secret and so invalidates the token.

A membership is first granted once its Tenant is `Ready` for its current generation. After
that, a Tenant that is merely not Ready (reconciling a new generation, or failing to
reconcile) keeps the membership's RoleBindings and token Secret, and the User stays
`Ready`, so `pulumi up` still reads the token during an upgrade. A role change still applies
to the kept bindings.

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

The API server URL comes from the `apiServer` argument of `createPlatform`. When
`apiServer` is set, `kubeconfig` is now required too: the program uses it to read the token
Secrets, and `createPlatform` throws without it. Both entrypoints already pass it. The
local entrypoint passes its loopback `https://127.0.0.1:<apiPort>`. The existing-cluster
entrypoint uses `kubernetesEndpoint` (set by `di-framework-kube`) and otherwise the
server of the admin kubeconfig's selected `context` (or `current-context`). When
neither resolves to an `https://` URL, `kubeconfigs` is omitted. Previews do not read
token Secrets, so `kubeconfigs` is only known after `pulumi up`.

During `pulumi up`, each token Secret is read only after its User is applied and Ready. The
program polls the Kubernetes API, using the same admin kubeconfig and context as the
Kubernetes provider (the `kubeconfig` and `kubeContext` arguments of `createPlatform`, which
both entrypoints set; `$KUBECONFIG` is never consulted), until the Secret has `data.token`.
This covers an upgrade where the User is already Ready and the upgraded controller has not
yet recreated the Secret. A missing Secret, a Secret without a token and every read failure
(HTTP status, auth, TLS, connection) are retried with backoff for up to 5 minutes, each
request limited to 10 seconds. Then `pulumi up` fails with `Timed out after 300000 ms waiting
for Secret wasmcloud/di-user-<user>-<tenant>-token to have data.token (last observation: ...)`,
where the observation is `Secret not found (HTTP 404)`, `Secret exists without data.token`,
an HTTP status or a connection error code; it never includes a Secret body. A Secret that
never appears usually means the Tenant or User is not Ready or the controller is not
running; check `kubectl get users.platform.di-framework.dev,tenants.platform.di-framework.dev` (both are cluster-scoped, so no `-n`). If the admin kubeconfig uses an
`exec` credential plugin, that plugin runs for these reads as it does for the provider.

## Requirements

Node.js 22.19 or newer (`engines.node`). `@kubernetes/client-node` 2 loads ES modules through
`require`, and its `undici` 8 dependency declares `>=22.19`. Pulumi runs this package under
whatever `node` is on `PATH`; `di-framework-kube` does not pin a version.

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

The controller writes tenant RBAC without `escalate` (#115): its ClusterRole holds
every rule of every Role it writes, and grants `bind` only on the fixed-name Roles
it binds (`CONTROLLER_BOUND_ROLES` in `src/tenancy/install.ts`). TokenRequest
(`serviceaccounts/token` `create`), which each `di-tenant-controller-<tenant>` Role
grants, is held only in the platform namespace through the `<installation>-controller`
Role and RoleBinding. It binds no Role to itself (#321). `tests/controller-rbac.test.ts`
checks this against the rendered objects, and against every Role, binding and request the
controller sends while it reconciles tenants with a registry, suspended tenants and tenants
without members. `tests/tenancy-install.test.ts` checks the install wiring.

Holding those rules gives the controller these grants directly, in every namespace:

- `pods/log` `get`: the `di-runtime-viewer` and `di-runtime-developer` Roles grant
  it to members (it also serves the logs projection).
- `pods/portforward` `create`: `di-runtime-developer` grants it.
- `events` `get`, `list`, `watch`: every tenant viewer and developer Role grants it.
- `get`, `list`, `watch` on runtime `workloads`, `workloadreplicasets` and `artifacts`:
  `di-developer` and `di-viewer` grant it.
- `update` on `workloaddeployments`: `di-developer` grants it (the controller itself
  writes only with server-side apply).
- `create` and `delete` on `backingservices` and `servicebindings`: `di-developer`
  grants them.

Before #115 each of these was already reachable through `escalate`.

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
- **Removing a tenant** from config: Pulumi updates the wasmCloud Helm release before it
  deletes the Tenant, and the runtime operator must keep watching `di-runtime-<tenant>` to
  release its host pods' finalizers while the controller drains the tenant (#227). So on
  `pulumi up` the operator's `hostNamespaces` list the declared tenants plus every Tenant of
  the installation that still exists, read with the admin `kubeconfig`. The namespace stops
  being watched on the next `up`, after the Tenant is gone. Under either `deletionPolicy` the
  Tenant is removed once its host pods are gone (`Retain` keeps only the namespaces and data),
  so a retained namespace is not watched. The Tenants are listed once per `up` or preview and
  that one list serves both this and the `Retain` removal warning (#245). A preview reads it
  too, so its diff shows the namespaces the `up` will apply, and an info line appears only for
  a tenant that is actually being removed; if a preview cannot list the Tenants, it warns and
  shows the declared tenants only. When the kubeconfig is not known yet (a first preview of a
  cluster this program creates), the preview shows the values as unknown. The Tenant list is
  retried up to three times (0.5 s, 1 s, 2 s apart,
  and no retry starts more than 15 s after the first attempt) on HTTP 429/5xx and connection
  errors, including undici's `UND_ERR_SOCKET`/`UND_ERR_CONNECT_TIMEOUT` and Bun's
  `ConnectionRefused`-style codes; a failure that remains fails `up` with `Cannot list
  the Tenants of installation <name> ... (#227): <HTTP status or error code>`. An error without
  either, such as an unusable kubeconfig, names its class and what to check in the kubeconfig
  (#245).
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

### BackingService storage

A Redis or NATS `BackingService` keeps its data on the node in a hostPath directory mounted at
`/data` in `di-bs-<service-name>`. A new BackingService uses
`<storageRoot>/di-tenants/<tenant uid>/bs-<service-name>`, where `storageRoot` defaults to
`/var/lib/k0s` when unset.

On every reconcile the controller reads the live `di-bs-<service-name>` Deployment. When that
Deployment belongs to the same BackingService UID and already mounts a hostPath for its `data`
volume, the controller keeps that exact path, so existing data stays reachable. The
storage-root path is used only when there is no live Deployment yet (or it has no `data`
hostPath).

- A BackingService created before this behaviour, or under a different `storageRoot`, keeps its
  original path (for example `/var/lib/k0s/...` on a node whose storage root is now
  `/var/lib/kubesolo`) until it is deleted and recreated. Recreating it starts empty under the
  current storage root; copy the data across first if it must be kept.
- Storage-root discovery reads every `<root>/di-tenants/<uid>` hostPath in the cluster and
  refuses when it finds more than one root. A leftover verification BackingService with a stray
  path causes that ambiguity; delete it (`deletionPolicy: Delete`) to clear it.

### Runtime NATS storage caps

Each tenant's `di-nats` keeps its JetStream store on the node at
`<storageRoot>/di-tenants/<tenant uid>/di-nats`, a host path no ResourceQuota covers. The tenant
registry's images (#83) and the hosts' default blobstore live there, so the server caps it (#160).
The controller renders ConfigMap `di-nats-config` in `di-runtime-<tenant>` and runs `di-nats` with
`-c /etc/nats/nats.conf`:

```text
port: 4222
jetstream {
  store_dir: "/data"
  max_file_store: <bytes>
  max_memory_store: <bytes>
}
accounts {
  TENANT {
    jetstream: enabled
    users: [ { user: "tenant" } ]
  }
  REGISTRY {                       # only with tenantAuth.registry, on a host image with wash patch 0003
    jetstream: enabled
    users: [ { user: "registry", password: $DI_NATS_REGISTRY_PASSWORD } ]
  }
}
no_auth_user: "tenant"
```

Clients without credentials (the hosts' data client, so every workload's default messaging,
keyvalue and blobstore) land in `TENANT`; the tenant registry logs in to `REGISTRY` (#159). Both
accounts share the caps below.

| `runtimeNats` key | Default | Rule |
| --- | --- | --- |
| `maxFileStore` | `10Gi` | At least `1Mi` |
| `maxMemoryStore` | `32Mi` | At least `1Mi`, at most `64Mi` (half the container's `128Mi` memory limit) |

The memory cap stops at half the container limit because nats-server needs the other half for
itself (connections, buffers, file-store caches). With that headroom a full memory store is
refused by JetStream with `insufficient resources` instead of getting the pod OOM-killed.

Values are binary quantities: a positive integer number of bytes, optionally suffixed `Ki`,
`Mi`, `Gi` or `Ti` (decimal units such as `10GB` are refused). The caps apply to every tenant
of the installation:

```sh
pulumi config set --path runtimeNats.maxFileStore 20Gi
```

An invalid value fails `createPlatform` before any resource. The pod template carries the
config's SHA-256 (`platform.di-framework.dev/nats-config-sha256`), so changing a cap restarts
`di-nats` (the Deployment is `Recreate`; the hosts reconnect).

Upgrading keeps the same store directory, so existing streams and object stores are recovered
as before. The cap never deletes data. Every stream is recovered, including one whose own
`max_bytes` is larger than the cap; nats-server logs no error for either.

If a tenant's store already holds more than the cap (an upgrade, or a cap lowered below usage):

- Reads keep working: stream reads, KV gets, object-store and blobstore gets, registry pulls.
- Every write is refused with `10023 insufficient resources`, **deletes included**. An
  object-store, KV or blobstore delete is a publish of a delete marker, so it is refused like any
  other write. The registry cannot free space by deleting images, and workloads cannot free
  space through `wasmcloud:blobstore` either.
- Recovery is an operator step: raise `maxFileStore` above current usage (the config change
  restarts `di-nats`), or remove data with admin stream operations, `nats stream purge <stream>`
  or `nats stream rm <stream>`, which JetStream still accepts over the cap. Writes resume once
  usage is below the cap.

When usage reaches the cap through normal writes instead, it stays below the cap: the write
that would cross it is refused, and deletes still work, so the registry frees space by deleting
images. Before lowering a cap, check usage on the node with
`du -sh <storageRoot>/di-tenants/<tenant uid>/di-nats/jetstream`.

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

The controller publishes one ConfigMap per projection key in each tenant namespace,
labeled `di-framework.dev/projection=logs` and `di-framework.dev/application=<app>`,
with the newest 200 lines in `data.lines`, the WorkloadDeployment and /v1 environment
of each line in `data.deployments` and `data.envs` (JSON arrays aligned with the
lines; the env is `""` outside /v1), and the newest host failure per
WorkloadDeployment in `data.failures`.

- A WorkloadDeployment `/v1/deploy` rendered (named `<service>-<env>`, labeled
  `di-framework.dev/application=<service>` and `platform.di-framework.dev/env=<env>`,
  env `prod` or `staging`) is keyed by service and env: `di-logs-<service>.<env>`,
  which also carries the env label. Staging and prod never share a ConfigMap.
- Any other workload (for example one the CLI deployed) is keyed by its console
  application: `di-logs-<app>`, without an env label. That name never contains a dot,
  so a CLI workload whose application equals a /v1 service name gets its own
  ConfigMap and never mixes into the service's logs.
- Migration: before this keying, staging and prod of a /v1 service shared
  `di-logs-<service>`. On its next poll the controller starts each
  `di-logs-<service>.<env>` from the lines and failure that ConfigMap recorded for
  `<service>-<env>`, then deletes the shared one. When a live CLI application still
  owns that key, the shared ConfigMap is kept and rewritten in the same pass without
  the lines of /v1 deployments, so no line is served twice. Lines published before
  deployments were recorded cannot be attributed to an env and are not carried over.
- Each ConfigMap write or delete is attempted on its own: one refused (for example at
  the `count/configmaps` quota) is logged and retried on the next poll without
  holding back the other projections, and a shared ConfigMap is not pruned or deleted
  until its lines have been taken over.

- Source: the `hostgroup-<tenant>` pod logs. The controller's ClusterRole holds
  `pods/log get` cluster-wide (#115), because the runtime viewer and developer Roles
  it writes grant it. The per-tenant `di-platform-log-reader` Role and binding are no
  longer written (#321). The host keeps `automountServiceAccountToken: false`.
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

#### Gateway route aliases

An administrator can point a public `<route-host>.<tenant>` pair at another tenant's route host
(#217). Set it with the top-level config key `routeAliases`, an object from source to target:

```yaml
# Pulumi.<stack>.yaml
config:
  di-framework-kube:routeAliases:
    identity.identity: identity.identity-pg
```

or `pulumi config set --path 'routeAliases["identity.identity"]' identity.identity-pg`.
`createPlatform` also takes `routeAliases` in `PlatformArgs`, which wins over config. Only the
top-level key is read: a `gateway` key (nested `gateway.routeAliases`, or the literal dotted key)
fails the deploy instead of being ignored. Tenants cannot see or change aliases.

`Host: identity.identity.localhost:28280` then reaches
`di-http.di-runtime-identity-pg.svc.cluster.local` with `Host: identity`, and
`X-Forwarded-Host` still carries the original `identity.identity.localhost:28280`, so a workload
that derives URLs (an OAuth `iss`, redirects) from it keeps the public name. The target tenant
must serve the same route-host workload (`identity` here); the gateway rewrites only the tenant.

Validation runs in `pulumi up`, before any resource changes, and an invalid map fails the deploy:

- the value is an object whose values are strings; anything else (a nested object, an array,
  non-JSON) is refused;
- both sides are `<route-host>.<tenant>`: the tenant is the last label and a valid tenant name,
  the route host is one or more strict DNS-1123 labels (`a-z`, `0-9`, `-`, no `_`, at most 63
  characters each). Host routing itself still accepts `_`, so such a host cannot be aliased;
- neither side's route host is `console`, `controller`, `registry`, or a route host configured
  through `tenantAuth`;
- the target tenant is declared in `tenants`. Tenants the platform does not declare are not known
  at install, so they cannot be targets;
- no chains or cycles: a target cannot be another alias's source. A self-alias is a no-op;
- sources are case-insensitive, so two sources differing only in case are refused.

The deployed map is lower-cased with sorted keys, so reordering or re-casing keys changes nothing.
Aliases apply to plain HTTP tenant routes only. The console, controller and registry routes and
TLS passthrough (routed by SNI) never consult them. If the gateway is ever handed an unusable alias
(a malformed target or a reserved target), it fails closed with `502` for that host and never falls
back to the original tenant. If its `routeAliases` is not an object (a string, an array, `null`),
the gateway refuses to start and logs why, rather than failing every tenant route.

**Cutover and rollback.** For the identity cutover, declare `identity-pg` in `tenants`, deploy the
identity workload there, then add `identity.identity: identity.identity-pg` and run `pulumi up`. To
roll back, remove the alias and run `pulumi up` again; the original route returns. Each change
updates the gateway's `GATEWAY_CONFIG` and its `di-framework.dev/config-hash` annotation, so the
`di-platform-gateway` pod rolls. The switch takes effect when that rollout completes
(`kubectl rollout status deploy/di-platform-gateway -n <namespace>`). The roll is meant to drop
no requests (#223):

- The rollout surges (`maxSurge: 1`, `maxUnavailable: 0`, `minReadySeconds: 5`), so the old pod
  keeps routing until the new one has been Ready for 5 s.
- The old pod's `preStop` hook then sleeps 10 s while it still serves, so the Service endpoint
  removal reaches every node's proxy before its listener closes. During those seconds both pods
  may answer, so for about 10–15 s after the rollout completes some requests still use the old
  routing.
- On SIGTERM the gateway stops accepting connections and closes idle keep-alive connections. It
  answers requests already in flight with `Connection: close` and lets them finish. That includes
  a request whose headers are only partly received and, with tenant-auth routes set, a connection
  still being classified. It keeps upgraded (WebSocket) tunnels and TLS passthrough pipes open.
  It waits up to 20 s, then closes whatever is left and exits. The 35 s termination grace period
  covers the sleep and the drain.

Switching is near-immediate, not instant. A WebSocket or passthrough connection opened before the
switch keeps its old route until it closes or the 20 s drain bound ends it. No pooled upstream
connection outlives the old pod. A client that reuses a keep-alive connection just as the old pod
closes it as idle can still see that connection reset; HTTP clients normally retry such a request
on a new connection. A connection opened before SIGTERM that has not sent its request yet is kept
and answered with `Connection: close`, or closed at the 20 s bound.

Upgrading to the release that adds the annotation rolls the gateway once, and so does upgrading
to the release that adds this drain.

**`di-framework-kube up` does not pass this key yet.** Its `platform.json` allowlist rejects
`routeAliases` (`unsupported platform config key`), and every `up` rebuilds the stack config from
that allowlist, so an alias set by hand with `pulumi config set` is wiped by the next `up`, which
silently rolls a cutover back. Until di-framework/kube#9 ships, set aliases with `pulumi up` on the
stack directly and do not run `di-framework-kube up` in between. Once it ships, put the same
object in `platform.json` as `"routeAliases": { "identity.identity": "identity.identity-pg" }`.

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
(`platform/tenant-auth`, #58). This is the supported deploy path; the earlier manual deploy
script is removed:

```yaml
tenantAuth:
  image: ghcr.io/di-framework/tenant-auth@sha256:c88a07a550dba1b53da12d000da7b102f07e3c20c91aac84249b845812a1fc4c   # required, pinned by digest
  issuer: http://identity.acme.localhost:28180               # identity-server, as pods and browsers name it
  oauthClient: { id: access, secretName: tenant-auth-oauth } # Secret in the platform namespace; key `clientSecret`
  issuerUpstream: di-platform-gateway.wasmcloud.svc.cluster.local:80  # optional, for a loopback issuer
  issuerUpstreamPodPort: 8080                                # optional, the pod port behind it
  issuerIp: 192.0.2.7                                        # optional, when pods cannot resolve the issuer
  consolePublicUrl: http://console.{tenant}.localhost:28180  # optional; default derived from routeUrlPattern, else http://127.0.0.1:8787
  controllerPublicUrl: https://controller.{tenant}.localhost:28180  # optional; default derived from routeUrlPattern, else https://127.0.0.1:8788
  registry:                                                  # optional: each tenant's own OCI registry (#83)
    component: ghcr.io/di-framework/oci-registry@sha256:a10d111afa7ca8041f80ccb7ca4e7dd498bbaf4502ddcb0e6d163e234e8e8cfc  # required, pinned by digest
    publicUrl: https://registry.{tenant}.localhost:28180     # optional; default derived from routeUrlPattern, else https://127.0.0.1:8790
    limits:                                                  # optional; each field optional, defaults shown
      maxBodyBytes: 536870912                                # TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES
      upstreamTimeoutMs: 60000                               # TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS
      maxConcurrent: 16                                      # TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT
      uploadIdleTimeoutMs: 60000                             # TENANT_CONTROLLER_REGISTRY_UPLOAD_IDLE_TIMEOUT_MS
```

- Placement and quota: both run in `di-runtime-<tenant>`, next to the `di-http` Service the
  controller proxies to, and `di-runtime-quota` grows by their limits (`500m` CPU, `448Mi`
  memory, sidecar included), so `spec.resources` stays the tenant's budget for the host and
  backing services. The tenant step keeps the base quota; only the tenant-auth step raises it,
  right before it applies the pair, and it lowers it again if the pair does not exist after a
  failed apply. Quota changes do not evict running pods.
- OAuth client: until per-tenant clients (#59), every console shares one confidential client.
  An administrator stores its secret in a Secret in the platform namespace; the reconcile
  copies it into `tenant-console-oauth` in each runtime namespace. The controller never reads
  the identity directory. Until that Secret exists the console Deployment cannot start.
- RBAC: `di-tenant-controller-<tenant>` lets the controller ServiceAccount create tokens only
  for `di-user-<member>` of the tenant's active (not suspended, not deleted) members. The list
  is recomputed from the User CRs on every reconcile; with no members the Role has no rule.
  The ClusterRole `di-tenant-controller-<tenant>` grants `get` on the tenant's own `Tenant` and on
  the same members' `User`s by name, and no `list` (#321). With no members it has no `users` rule.
  The members are also published, as a JSON array under `members`, in ConfigMap
  `tenant-controller-members` in the runtime namespace, which the tenant controller reads for
  `/-/members`. A suspended tenant keeps the roles and loses the bindings. `tenant-controller-secret-reader` in
  `di-tenant-<tenant>` lets it `get`/`list` Secrets there, because tenant developers can only
  write them (#112); writes still go through as the calling user.
- Network: `tenant-auth-egress` adds egress to the API server endpoints (EndpointSlice
  `default/kubernetes`, `/32` or `/128`), the issuer (upstream namespace or IP), the tenant's
  host group on 9191 (`di-http`'s pod port) and DNS. The pair is not selected by
  `di-tenant-network`; `tenant-auth-network` gives it the same egress that policy gives the
  tenant's other pods, and admits only the console to the controller's `8788` and, with a
  registry, only the tenant's host pods to the whoami listener (`8789`) and the pull listener
  (`8791`). Tenant workloads no
  longer reach the console or the controller from inside the cluster. The pair leaves
  `di-tenant-network` only once its own `tenant-auth-network` exists, so on an upgrade (or when
  the tenant-auth step fails before that policy) it keeps the broad policy until the next poll.
- Credentials: no pod automounts a ServiceAccount token. The controller container alone gets
  a projected token; the issuer-proxy sidecar (`alpine/socat`, pinned by digest) has none.
- TLS: the platform controller generates a per-tenant P-256 CA (`CA:TRUE, pathlen:0`, valid ten
  years) and a leaf it signs (`CA:FALSE`, server auth, 365 days) for `tenant-controller` and the host
  of `controllerPublicUrl`. The leaf, its key and `ca.crt` are in Secret `tenant-controller-tls`; the
  console and the hosts pin only the CA, from ConfigMap `tenant-controller-ca`. The CA key is in
  Secret `tenant-controller-ca-key` in the same runtime namespace. No pod mounts it and no tenant
  member role can read it, but the tenant controller's ServiceAccount can: its
  `tenant-controller-keys` Role (for API-key Secrets) grants `get`, `list`, `create` and `delete`
  on every Secret in that namespace, because API-key Secrets have generated names. The
  `<installation>-tenant-controller-secrets` admission policy (#321) limits its writes: it may
  create and delete only `di-apikey-<16 hex>` Secrets labelled
  `platform.di-framework.dev/api-key: "true"` with its own tenant, and update none. It can no
  longer delete `tenant-controller-ca-key`, `tenant-controller-tls`, `tenant-console-oauth` or
  the registry pull Secret. Its reads are not narrowed.
  The leaf is replaced 30 days before it expires, when its names change, or when it no longer
  verifies against the stored CA. The leaf's `notAfter` never passes the CA's. The CA is
  replaced only when one of these holds:
  - it expires within 90 days;
  - its key is missing or does not match it;
  - `ca.crt` is missing from `tenant-controller-tls`, for example because that Secret was
    deleted.

  A leaf renewal therefore keeps the CA, so hosts do not roll and
  kubeconfigs the console issued stay valid; the leaf digest in both pod templates rolls the pair.
  A Secret from before the CA existed (one `CA:TRUE` certificate, no `ca.crt`) is replaced once.
- Routes: when the platform gateway is published (`routeUrlPattern`), a public URL whose host is
  `<label>.{tenant}.localhost` on the gateway port is routed through it, so a new Tenant gets a
  reachable console and controller with no script. `createPlatform` derives every public URL
  left unset from `routeUrlPattern` (#128), before any resource is created: with
  `routeUrlPattern: http://{host}.{tenant}.localhost:28180` the defaults are
  `consolePublicUrl: http://console.{tenant}.localhost:28180`,
  `controllerPublicUrl: https://controller.{tenant}.localhost:28180` and, with a registry,
  `registry.publicUrl: https://registry.{tenant}.localhost:28180` (a pattern without a port
  gives the console no port and the TLS hosts `:80`, the gateway's own). An explicit URL always
  wins, including a `127.0.0.1` one that keeps that host on a port-forward. Only an
  `http://{host}.{tenant}.localhost[:<port>]` pattern is derived from, since only those hosts
  are routed to the pair; with any other pattern (`https://`, another domain) the unset URLs
  keep the `127.0.0.1` defaults, as before, and `createPlatform` logs a warning naming them.
  The console's public URL is the one its OAuth redirects use, so the shared OAuth client must
  accept the derived console callback; see
  [Upgrading to tenant-auth URLs derived from `routeUrlPattern`](#upgrading-to-tenant-auth-urls-derived-from-routeurlpattern-128).
  The console route is
  plain HTTP to `tenant-console:8787` with the original `Host`. The controller route is TLS
  passthrough: the gateway reads only the SNI name and pipes the connection to
  `tenant-controller:8788`, so the controller's own certificate (covering the public host) and
  the CA the console embeds in kubeconfigs still verify end to end; plain HTTP to the controller
  host gets `400`. The routed URLs are added to `di-platform-routes` as `consoleUrl` and
  `controllerUrl`. Policies `tenant-console-gateway` and `tenant-controller-gateway` admit only
  the gateway pods, each to its own port, and the gateway's egress gains only those two ports
  in this installation's tenant namespaces. A routed label takes that host away from tenant
  workloads (`console.<tenant>.localhost` no longer reaches `di-http`). Explicit `127.0.0.1`
  URLs, other hosts, and any URL while no gateway is published (the `127.0.0.1` defaults then
  apply) stay unrouted. A gateway-shaped URL the gateway cannot route (wrong scheme, port, or a
  host shared by both) is reported on `TenantAuthReady` with reason `RouteError`; `Ready` is
  unaffected. The routes are config, not per-Tenant objects: the gateway policies carry the
  `tenant-auth` component label and are removed with the rest of the pair.
- Registry (`tenantAuth.registry`, #83): each tenant gets the `platform/oci-registry` component
  as WorkloadDeployment `di-tenant-registry` in `di-tenant-<tenant>`, on the tenant's own hosts.
  Its storage is the unnamed `wasmcloud:blobstore` with the NATS backend on the tenant's `di-nats`
  (JetStream on the tenant's host path, capped by
  [`runtimeNats.maxFileStore`](#runtime-nats-storage-caps)), in its own NATS account `REGISTRY`
  that tenant workloads cannot reach (#159, see
  [Upgrading to a registry in its own NATS account](#upgrading-to-a-registry-in-its-own-nats-account-159)). Its `wasmcloud:secrets`
  bind-time config names the tenant and the controller's whoami-only listener,
  `https://tenant-controller.di-runtime-<tenant>.svc:8789` (#113). The listener serves the
  controller certificate, which always names `tenant-controller.di-runtime-<tenant>.svc`, and the
  tenant hosts trust the tenant CA for the components' outgoing `wasi:http`
  (`--http-client-ca-path`), so the registry verifies it like any other TLS server and the user's
  credential no longer crosses the pod network in cleartext on this hop. The listener serves
  nothing but `GET /v1/auth/whoami` (same answer as `8788`, problem+json errors). It also answers
  plain HTTP on the same port, for a registry whose config still names `http://` while an upgrade
  rolls out (see
  [Upgrading to TLS on the controller's whoami listener](#upgrading-to-tls-on-the-controllers-whoami-listener-113)).
  The hop from the registry front (`8790`) to the tenant host is still plain HTTP. Admission admits `wasmcloud:secrets` from the platform controller
  only, so a tenant cannot repoint the callback; the component's only egress is that URL
  (`allowedHosts`), and the egress reconcile leaves it alone.
  - Reservation: the front sends every registry user's Basic credentials to whatever serves the
    registry host on the tenant's `di-http`, so policy `<installation>-reserved-workloads`
    (CREATE, UPDATE and DELETE) denies `di-user-*` ServiceAccounts, and therefore `/v1/deploy`,
    any change to `di-tenant-registry` or to a WorkloadDeployment labelled
    `platform.di-framework.dev/component: tenant-auth` (on the new or the old object), and any
    WorkloadDeployment whose `wasi:http` `config.host` is the registry host in any case, with a
    trailing dot or a port. The host is rendered from `registry.publicUrl` (default `registry`)
    and reserved even while no registry is configured. Other deletes by tenant users and every
    request of the platform controller pass. `/v1/deploy` also refuses a `<service>-<env>` equal
    to the registry host with `422`.
    Admission checks only writes, so a workload that already claimed the host (created before
    the policy, or before a `registry.publicUrl` change moved the registry to its host) would
    keep its route, and wash picks randomly among claimants. Each reconcile therefore lists the
    tenant's WorkloadDeployments; while any workload other than the platform's
    `di-tenant-registry` claims the host through `wasi:http` `config.host` or `host-aliases`
    (in any case), the registry is not served and `TenantAuthReady` is `False` with reason
    `RegistryHostConflict`, naming the workload. Deleting it clears the conflict on the next
    poll.
  - TLS and routing: users reach the registry at `publicUrl` through the controller's registry
    front (`8790`), a TLS listener with the controller certificate (which also names the
    registry's public host) that forwards every request to `di-http` with `Host: <label>`.
    A `publicUrl` of `https://<label>.{tenant}.localhost` on the gateway port is routed: the
    gateway passes TLS whose SNI is that host through to the front, exactly as for the
    controller, and answers plain HTTP for it with `400`. The gateway knows the registry's
    HTTP host whenever a registry is configured, so that `400` holds even when users reach the
    registry by port-forward (`kubectl port-forward svc/tenant-controller 8790`, the default
    `https://127.0.0.1:8790` when no gateway is published). Credentials therefore never cross plain HTTP off-cluster; the
    front-to-host and registry-to-controller hops are plain HTTP on the pod network, as the
    gateway-to-host hop already is. The alternative, terminating TLS at the gateway, would put
    every tenant's private key in the platform namespace; TLS passthrough keeps keys per tenant.
    Clients must trust the tenant's CA (ConfigMap `tenant-controller-ca`), as for the controller.
    The default `publicUrl` needs `pods/portforward` in `di-runtime-<tenant>`, which only
    `di-runtime-developer` has, so viewers cannot pull through it; with a published gateway, use
    the routed `https://registry.{tenant}.localhost:<gateway port>` instead.
  - Front enablement: the controller is rendered with the registry front
    (`TENANT_CONTROLLER_REGISTRY_FRONT_PORT`) and `TENANT_CONTROLLER_REGISTRY_URL` only while
    the tenant is not suspended and no other WorkloadDeployment claims the registry host.
    Registry readiness is not part of the gate, so a registry rollout or blip never restarts the
    controller: while `di-tenant-registry` is not `Ready` the front relays whatever the tenant
    host answers for a request to a host it has no route for (502 only when `di-http` cannot be
    reached, 504 when its response headers time out), and `TenantAuthReady` reports
    `Provisioning`. Tenant users cannot create a claimant (admission);
    one written by any other requester (an operator, a CD service account) is detected on the
    next reconcile (polled every 3 s), which closes the front, so it can receive credentials for
    at most that poll plus the controller's `Recreate` rollout. Opening or closing the front
    rolls the controller pod.
  - Limits: the front is reachable without credentials (the component authenticates). A request
    without Basic credentials gets the registry's own challenge (`401`,
    `WWW-Authenticate: Basic realm="di-framework-tenant-registry"`) from the front, so
    `docker login` and `oras login` work and such requests take no slot. Otherwise it allows 16
    requests at once (`503` beyond), bodies up to 512 MiB (`413`), an upload that delivers no
    byte for 60 s is cut off (`408`), and once the body is forwarded in full the registry has
    60 s for its response headers (`504`); a steady upload of any length succeeds. A 120 s
    socket idle timeout that data flow resets also applies. Tune them with
    `tenantAuth.registry.limits` (rendered as the `TENANT_CONTROLLER_REGISTRY_*` env above; a
    hand edit of the Deployment is reverted). There is no per-client limit: the front sees the
    gateway as the peer of every routed connection, so a per-IP cap would be a global one. An
    authenticating client can still hold slots up to these bounds. A client that disconnects
    aborts the upstream request. Error answers carry no upstream detail.
  - `TENANT_CONTROLLER_REGISTRY_URL` on the controller is `publicUrl` with `{tenant}` replaced,
    so `GET /v1/deploy/registry` returns it while the registry is served. Policy `tenant-registry-gateway` admits only the
    gateway to `8790`, and the gateway's egress gains that port.
  - Quota: the registry adds one WorkloadDeployment to `di-tenant-quota`, raised in the
    tenant-auth step right before the registry is applied and kept only while it exists, so the
    tenant keeps all of `spec.resources.workloads`. It runs on the tenant host, so the runtime
    quota is unchanged.
  - Status: the registry's readiness (its WorkloadDeployment `Ready` condition) and problems are
    reported on `TenantAuthReady`, never on `Ready`. A `publicUrl` the gateway cannot route is a
    `RouteError` there.
  - Unsetting `tenantAuth.registry` deletes the workload and gives the quota slot back; the
    controller's extra listeners and env go with the next rollout.
  - RBAC: the platform controller's ClusterRole grants `create` and `delete` on
    `workloaddeployments` for the registry (its server-side apply is authorized as `create`
    while it does not exist). Roll the ClusterRole before the new controller (`pulumi up`
    applies both; a hand-rolled upgrade must apply the ClusterRole first), or the registry
    reports `403` on `TenantAuthReady` until it does.
  - RBAC without `escalate` (#115): apply the `<installation>-controller` Role and
    RoleBinding in the platform namespace first, then the ClusterRole (`pulumi up` orders
    them). A ClusterRole without `escalate` applied before the Role lets the update of
    each `di-tenant-controller-<tenant>` Role, and of the RoleBinding of the same name
    (written without `bind`), fail with `403` on `TenantAuthReady` until the next poll
    after the Role exists. Tenant Roles and bindings are unchanged.
  - Tenant controller RBAC (#321): `di-tenant-controller-<tenant>` no longer lets the tenant
    controller list `User`s, so `/-/members` needs a tenant-auth image that reads
    `tenant-controller-members`. Upgrade the `tenantAuth.image` pin together with the platform:
    an older image answers `/-/members` with an error until it is replaced (login and API
    keys keep working). A newer image on an older platform falls back to listing `User`s.
    Suspended members are no longer shown in `/-/members`, because the tenant controller can
    no longer read their `User`.
  - Log reader (#321): the controller no longer writes the per-tenant `di-platform-log-reader`
    Role and RoleBinding in `di-runtime-<tenant>`, and no longer has `bind` on that name.
    Existing ones stay until the tenant is deleted; they grant only `pods/log` `get` to the
    controller, which already holds it cluster-wide. To remove them by hand:
    `kubectl delete role,rolebinding -A -l platform.di-framework.dev/installation=<installation> --field-selector metadata.name=di-platform-log-reader`.
  - Host pull (`#83:host-pull`): the tenant's hosts pull workload components from the tenant
    registry with a namespace-scoped host credential.
    - Reference: users push to `publicUrl`; workloads reference the same repository as
      `tenant-registry.di-runtime-<tenant>.svc/<repository>[:tag|@digest]` (no port). `/v1/deploy`
      refuses an image on the public origin and names this reference instead.
    - Path: Service `tenant-registry` in `di-runtime-<tenant>` points at the controller's
      pull-only listener (`TENANT_CONTROLLER_REGISTRY_PULL_PORT=8791`), which is the registry front
      restricted to `GET`/`HEAD` (`405` otherwise), so nothing can be pushed or deleted through it.
      It forwards to `di-http` with `Host: <registry label>` like the front, and is open only while
      the front is (same suspension and `RegistryHostConflict` gate). It has its own concurrency
      pool (the front's `registryMaxConcurrent` slots are not shared) and never forwards a request
      body (capped at 1 KiB by the listener). `tenant-auth-network` admits only the tenant's host
      pods to `8789` and `8791`; the hosts already reach the runtime namespace through
      `di-tenant-network`, so pulls never leave the tenant's namespaces. NetworkPolicy does not
      apply to `kubectl port-forward`: `di-runtime-developer` grants `pods/portforward`, so a
      developer can reach `8789` and `8791` directly. That yields nothing without a credential:
      the registry still authorizes every request through whoami, and no file is served.
    - Startup (#197): after a host starts or restarts, its workloads pull while `di-tenant-registry`
      on the same host is still starting. The pull listener waits for the registry instead of
      failing the pull (which wash would only retry about a minute later): a refused connection or
      the host's empty `404` for a `Host` no workload serves yet is retried with a 250 ms to 2 s
      backoff, for at most `TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS` (default 30 s). Any answer
      from the registry itself, a `404 BLOB_UNKNOWN` included, is returned at once, and the public
      front never waits. The wait delays only that one pull, so nothing blocks the host that serves
      the registry. A waiting pull gives its pool slot back between attempts, so pulls waiting out
      a host restart do not turn the others away; one that finds no free slot before its wait is
      over is answered `503`. Each attempt gets the full upstream header timeout, so the wait is
      not cut short by it.
    - Framing (#197): the front and the pull listener run on `node:http`, which writes the
      registry's `Content-Length` on a blob `GET` as is; `Bun.serve` re-framed every streamed body
      as chunked, and oras then stalled behind the unread body over `kubectl port-forward`. A `HEAD`
      gets its `Content-Length` from the registry's `docker-content-length`.
    - Credential: Secret `di-tenant-registry-pull` in `di-runtime-<tenant>` holds a random
      32-byte token (`token`) and a Docker config for `tenant-registry.di-runtime-<tenant>.svc`
      (`config.json`, Basic `tenant-host:<token>`). The platform controller generates it and keeps
      it across reconciles; delete the Secret to rotate it. The host mounts `config.json` as
      `DOCKER_CONFIG=/registry-auth`, which wash reads on every pull; the controller mounts `token`
      next to its certificate and reads it on every call. A rotation therefore needs no restart
      beyond the kubelet's Secret sync and the registry's short positive whoami cache. The
      controller's whoami listener, and only it (the main listener never does), answers
      `Bearer <token>` as `{user: system:tenant-host, role: viewer, via: host-pull}`, and the
      registry (`role_from_body`) caps `via: host-pull` at viewer whatever role is claimed, so the
      credential allows pulls only. The public registry front (`8790`) refuses the token as a Basic
      password with the registry's `401` challenge, without forwarding, so it works only through
      the pull listener. It is not a user's identity token, and tenant users cannot
      read it: `di-runtime-*` roles grant no Secret access and no `pods/exec`, the host pod spec
      holds only a Secret volume reference, and Wasm guests see no host files outside their
      preopened storage.
    - TLS: by default the pull listener serves the controller leaf certificate (whose SANs now include
      `tenant-registry.di-runtime-<tenant>.svc[.cluster.local]`) on Service port 443, and the hosts
      trust the tenant CA that signed it through `--oci-ca-path=/registry-ca/ca.crt` from ConfigMap
      `tenant-controller-ca`. A CA:TRUE end-entity certificate is rejected by wash (rustls), hence the split.
      The same file is passed as `--http-client-ca-path`, so the components' outgoing `wasi:http`
      trusts the tenant CA on top of the default webpki roots (#113): the registry calls the
      controller's whoami listener over `https://`. Other HTTPS egress still trusts the webpki roots and now also
      accepts a certificate issued by the tenant CA for any name, the same scope
      `--oci-ca-path` already gives OCI pulls. The CA has no name constraints; #170 tracks the
      CA follow-ups.
      wash loads both once at start, so the host template carries
      `platform.di-framework.dev/registry-ca-sha256` and a CA replacement (not a leaf renewal) rolls the hosts on
      the next poll. The listener is TLS with `insecureRegistry` too (#149): only the platform host
      group runs `--allow-insecure-registries`. Tenant hosts instead get one
      `--insecure-registry <host:port>` (wash patch 0002) per plain-HTTP registry: the platform
      registry as workload references spell it (`registry.pull`,
      `di-framework-registry.<namespace>.svc.cluster.local:5000`, when the install has one) and each
      `insecureRegistries` entry. wash matches these exactly (case-sensitive, no default port), so
      every other pull, this listener and GHCR included, stays TLS.
    - Rollout: the hosts are wired (env, volumes, CA) from desired state: while
      `tenantAuth.registry` is set, the registry WorkloadDeployment exists and the tenant is not
      suspended, whether or not the pull Secret exists at that moment. The Secret volume is
      optional, so a host started mid-rotation pulls anonymously until the kubelet syncs it, and
      deleting the Secret to rotate the token leaves the host template unchanged. Over TLS the
      template keeps the last known CA digest while `tenant-controller-ca` is missing, so only a
      different CA rolls the hosts. The first wiring, a CA renewal, and unsetting the registry
      each roll the hosts once. A failed lookup of that wiring is reported on `TenantAuthReady`
      (`HostPullError`, or appended to the message of an earlier failure reason such as
      `RegistryHostConflict` or `RouteError`, which is kept) and leaves the hosts as they were.
      Unsetting
      `tenantAuth.registry` also deletes the pull Secret and Service.
    - Alternative not taken: anonymous pull restricted by NetworkPolicy to the tenant's host pods.
      The registry authorizes every request through whoami, so it would need an
      unauthenticated bypass in `platform/oci-registry` keyed on something the component cannot
      verify (it does not see the peer address, and a `Host` value can be sent by any pod that
      reaches `di-http`, including tenant workloads and, unless reserved, the gateway). Its only
      gate would be NetworkPolicy, which some CNIs do not enforce; the credential still holds
      there. wash supports both per-component `imagePullSecret` (materialized by the operator from
      the workload's namespace, where developers can write Secrets) and a host-wide Docker
      config; the host Docker config keeps the credential out of every namespace tenant users can
      write.
- The controller Deployment stays at one replica with `Recreate`: proxy sessions live in its
  memory. A new image digest rolls both pods.
- Status: problems here are reported on the Tenant's `TenantAuthReady` condition. Ready, and
  with it every member's access, does not depend on the controller or console. Tenant-auth
  reconciles even when the tenant's own objects fail to apply (such as a hostgroup conflict);
  then two conditions are reported: `Ready` False with reason `ReconcileError` and the
  conflict text, and `TenantAuthReady` for the pair itself.
- Cleanup: deleting the Tenant deletes the cluster-scoped and platform-namespace objects too;
  unsetting `tenantAuth` removes every object labelled `platform.di-framework.dev/component:
  tenant-auth` (the registry WorkloadDeployment included) and the quota addition.

The reconcile does not adopt objects that the removed manual deploy script created (they carry
the component and tenant labels but not the installation label; `TenantAuthReady` reports
`Refusing to adopt`). Delete them first: in `di-runtime-<tenant>` the Deployments, Services,
ServiceAccounts, Role and RoleBinding `tenant-controller-keys`, NetworkPolicy, Secrets
`tenant-controller-tls`, `tenant-controller-ca-key` and `tenant-console-oauth`, and ConfigMaps `tenant-controller-ca`,
`tenant-controller-members` and `tenant-auth-bundle`; in `di-tenant-<tenant>` the Role and RoleBinding
`tenant-controller-secret-reader`; in the platform namespace the Role and RoleBinding
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
import { Postgres, PlatformBinding } from '@di-framework/bindings';

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
