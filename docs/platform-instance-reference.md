# PlatformInstance reference

`PlatformInstance` is one isolated copy of the di-framework platform, reconciled by the
[platform operator](platform-operator.md).

The field tables on this page are generated from the CRD of platform release **v6.0.30**,
[`platform/operator/config/crd/platform.di-framework.dev_platforminstances.yaml`](https://github.com/di-framework/platform/blob/v6.0.30/platform/operator/config/crd/platform.di-framework.dev_platforminstances.yaml).
The condition reasons come from the operator's source at the same tag
([`api/v1alpha1/platforminstance_types.go`](https://github.com/di-framework/platform/blob/v6.0.30/platform/operator/api/v1alpha1/platforminstance_types.go),
[`internal/controller`](https://github.com/di-framework/platform/tree/v6.0.30/platform/operator/internal/controller),
[`internal/plan`](https://github.com/di-framework/platform/blob/v6.0.30/platform/operator/internal/plan/plan.go))
and its [README](https://github.com/di-framework/platform/blob/v6.0.30/platform/operator/README.md).
Check the CRD of your installed release when it differs.

| Property | Value |
| --- | --- |
| Group / version | `platform.di-framework.dev/v1alpha1` |
| Kind | `PlatformInstance` (list `PlatformInstanceList`) |
| Plural / singular / short name | `platforminstances` / `platforminstance` / `pi` |
| Scope | Namespaced |
| Subresources | `status` |
| Name | at most 63 characters (`name must be at most 63 characters`) |
| Finalizer | `platform.di-framework.dev/instance`, added before anything is created and removed only by the operator |

`kubectl get pi` prints these columns:

| Column | Source |
| --- | --- |
| Version | `.spec.version` |
| Installed | `.status.installedVersion` |
| Phase | `.status.phase` |
| Age | `.metadata.creationTimestamp` |

## spec

`target` and `version` are required. `target` and `platform.storageRoot` are fixed at creation: the
operator would otherwise lose track of the cluster and data it made. `platform.networkPolicyEngine: kube-router`
is refused on the `vcluster` target by an XValidation CEL rule.

| Field | Type | Required | Default | Validation | Description |
| --- | --- | --- | --- | --- | --- |
| `version` | string | yes | | pattern `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$` | Exact `@di-framework/platform` package version to install, for example `6.0.30`. Ranges are not accepted. When `spec.version` matches the operator image's baked default (`6.0.30` in `v6.0.30`), `pulumi up` runs from the image's pre-installed package and plugin cache without outbound npm or Pulumi plugin downloads; see [Outbound traffic](platform-operator.md#outbound-traffic). |
| `target.type` | string | yes | | enum `vcluster`; immutable (`target is immutable`) | Target kind (mode). Only `vcluster` is supported in v1alpha1. With `vcluster`, new `PlatformInstance` objects cannot set `spec.platform.networkPolicyEngine: kube-router` (`vcluster` instances use `existing`, enforced by the host cluster's CNI). |
| `deletionPolicy` | string | | `Delete` | enum `Delete`, `Retain` | What deleting the instance does. See [Delete and Retain](platform-operator-operations.md#delete-and-retain). |
| `platform` | object | | | see [spec.platform](#spec-platform) | Platform settings the operator passes to the install. |

## spec.platform

Each tenancy field is the platform's config key of the same name, passed through as JSON. One CEL rule
applies to `spec.platform` (`every users[].memberships[].tenant must name an entry of tenants`), and a
CEL transition rule on `spec` rejects `networkPolicyEngine: kube-router` on `vcluster` targets.

| Field | Type | Default | Validation | Description |
| --- | --- | --- | --- | --- |
| `networkPolicyEngine` | string | `existing` | enum `existing`, `kube-router`; XValidation rejects `kube-router` on `vcluster` | `existing`: the target enforces NetworkPolicy (for `vcluster`, the host cluster's CNI enforces synced policies). `kube-router`: the platform runs its own policy controller. On `vcluster`, new instances cannot set `kube-router` and existing instances cannot switch to it, because vCluster has no dedicated nodes for kube-router's DaemonSet and a second kube-router on the host node would conflict with the host CNI's iptables/ipset chains. An instance created with `kube-router` before this rule can be updated while it keeps `kube-router`; once switched to `existing`, it cannot switch back. |
| `storageRoot` | string | operator default `<storageRootBase>/<namespace>/<name>` | immutable (`platform.storageRoot is immutable`) | Node path under which the platform keeps tenant data. Empty uses the operator's per-instance default, which `deletionPolicy: Delete` removes. A path set here is never removed by the operator. |
| `gateway.httpNodePort` | int32 | `0` | 0-32767 | Publishes the gateway on this NodePort. Zero keeps it ClusterIP. |
| `gateway.httpEndpoint` | string | | pattern `^https?://` | Gateway's public base URL, for example `http://apps.example:30080`. The platform derives route URLs from it, and `status.endpoints.http` reports it. |
| `tenants[]` | array | | at most 32; map list keyed by `name` | The platform's `tenants`. See [tenants](#spec-platform-tenants). |
| `users[]` | array | | at most 128; map list keyed by `name` | The platform's `users` and their memberships. See [users](#spec-platform-users). |
| `tenantAuth` | object | | see [tenantAuth](#spec-platform-tenantauth) | Enables the per-tenant console and `/v1` API against an OIDC issuer. Unset, tenants get no console. |
| `tenantHostImage` | string | the recorded `status.applied.tenantHostImage` | max 512; pattern `^[^\s@]+(@sha256:[0-9a-f]{64})?$` | The platform's `tenantHostImage`. A change is applied by the next install and restarts the tenant hosts. Empty keeps the recorded image. A new instance records the operator's pinned exclusive host variant (`ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive` by digest), which the `spec.version` package must list as an approved host build. An instance installed before this field existed keeps the platform's own default. |
| `tenantHostImagePullPolicy` | string | the platform's default, `IfNotPresent` | enum `Always`, `IfNotPresent`, `Never` | The platform's `tenantHostImagePullPolicy`. |

### tenants[]

The bounds are the platform Tenant CRD's. A change on a Ready instance is applied by the install the
spec change starts.

| Field | Type | Required | Validation | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | max 40; pattern `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`; unique | 1-40 lowercase letters, digits and hyphens, starting with a letter. |
| `suspended` | boolean | | | Suspends the tenant. |
| `deletionPolicy` | string | | enum `Retain`, `Delete` | What removing the tenant does to its data. The platform's default applies when unset. |
| `runtime.replicas` | int32 | | 1-10 | Tenant host replicas. |
| `runtime.coreInstances` | int32 | | 1-10000 | `WASH_CORE_INSTANCES` for the tenant host (platform default 100). |
| `resources.cpu` | string | | max 32; pattern `^[0-9]+(\.[0-9]+)?(m\|Ki\|Mi\|Gi\|Ti)?$` | CPU quota, a quantity such as `500m` or `1.5`. |
| `resources.memory` | string | | max 32; same pattern as `cpu` | Memory quota, such as `512Mi`. |
| `resources.workloads` | int32 | | 1-1000 | Workload quota. |
| `resources.backingServices` | int32 | | 1-100 | Backing-service quota. |
| `resources.serviceBindings` | int32 | | 1-400 | Service-binding quota. |
| `resources.apiKeys` | int32 | | 1-10000 | API-key quota. |

### users[]

| Field | Type | Required | Validation | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | max 40; pattern `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`; unique | 1-40 lowercase letters, digits and hyphens, starting with a letter. |
| `suspended` | boolean | | | Blocks the user's access. |
| `memberships[]` | array | yes | at most 16; map list keyed by `tenant` | The tenants the user belongs to, one entry per tenant. |
| `memberships[].tenant` | string | yes | max 40; must name an entry of `tenants` | Tenant name. |
| `memberships[].role` | string | yes | enum `developer`, `viewer` | The user's role in that tenant. |

### tenantAuth

`image` is required. A CEL rule requires `issuer`, `clientId` and `clientSecretRef` together
(`tenantAuth needs issuer, clientId and clientSecretRef together`). `{tenant}` in a public URL is
replaced with the tenant name.

| Field | Platform config | Type | Validation | Description |
| --- | --- | --- | --- | --- |
| `image` | `tenantAuth.image` | string | required; max 512; pattern `^[^@\s]+@sha256:[0-9a-f]{64}$` | The tenant-auth image, pinned by digest. |
| `issuer` | `tenantAuth.issuer` | string | max 2048; pattern `^https?://` | OIDC issuer URL, as both pods and browsers name it. |
| `clientId` | `tenantAuth.oauthClient.id` | string | 1-253 characters | The console's confidential OAuth client. |
| `clientSecretRef.name` | `tenantAuth.oauthClient.secretName` (see below) | string | required in the ref; 1-253 characters | Secret in the PlatformInstance's namespace holding the OAuth client secret. |
| `clientSecretRef.key` | | string | required in the ref; 1-253 characters | Key in that Secret. |
| `issuerUpstream` | `tenantAuth.issuerUpstream` | string | max 512 | In-cluster `<service>.<namespace>[.svc...]:<port>` a sidecar forwards a loopback issuer's port to. |
| `issuerUpstreamPodPort` | `tenantAuth.issuerUpstreamPodPort` | int32 | 1-65535 | Pod port behind `issuerUpstream`. |
| `issuerIp` | `tenantAuth.issuerIp` | string | max 15 | The issuer's IPv4 when pods cannot resolve its hostname. |
| `consolePublicUrl` | `tenantAuth.consolePublicUrl` | string | max 2048; pattern `^https?://` | Browser-visible console URL. |
| `controllerPublicUrl` | `tenantAuth.controllerPublicUrl` | string | max 2048; pattern `^https?://` | Controller URL shown to users and CLIs. |
| `registry.component` | `tenantAuth.registry.component` | string | required in `registry`; max 512; pattern `^[^@\s]+@sha256:[0-9a-f]{64}$` | The oci-registry component, pinned by digest. Deploys each tenant's own OCI registry. |
| `registry.publicUrl` | `tenantAuth.registry.publicUrl` | string | max 2048; pattern `^https?://` | Registry origin users log in to. |
| `registry.limits.maxBodyBytes` | `tenantAuth.registry.limits` | int64 | minimum 1 | Bounds the controller's registry front. |
| `registry.limits.maxConcurrent` | `tenantAuth.registry.limits` | int64 | minimum 1 | |
| `registry.limits.uploadIdleTimeoutMs` | `tenantAuth.registry.limits` | int64 | minimum 1 | |
| `registry.limits.upstreamTimeoutMs` | `tenantAuth.registry.limits` | int64 | minimum 1 | |

The client secret is never inline. On every install and repair the operator reads the referenced key and
writes it, through the encrypted stack config, to the Secret `platform-operator-tenant-auth` (key
`clientSecret`) in the platform namespace inside the instance; `tenantAuth.oauthClient.secretName` names
that Secret. The value never reaches the CR, its status, events or the operator log.

## status

| Field | Type | Description |
| --- | --- | --- |
| `phase` | string | Coarse lifecycle state: `Pending`, `Provisioning`, `Installing`, `Ready`, `Failed`, `Deleting`. |
| `observedGeneration` | int64 | The generation the status describes. |
| `installedVersion` | string | Platform version the last successful install applied. |
| `endpoints.kubernetes` | string | The instance's Kubernetes endpoint, from the install's outputs. |
| `endpoints.http` | string | The gateway's public base URL, from the install's outputs (`spec.platform.gateway.httpEndpoint`). |
| `kubeconfigSecretRef.name` | string | Secret in the PlatformInstance's namespace holding the instance's admin kubeconfig under the key `kubeconfig` (`<name>-kubeconfig`). Kept while that Secret exists. |
| `applied` | object | What the last successful install applied. See [status.applied](#status-applied). |
| `lastRepair` | date-time | When the last periodic refresh and up finished. |
| `target` | object | What the operator recorded about the target cluster. See [status.target](#status-target). |
| `conditions[]` | array | Standard `metav1.Condition` entries keyed by `type`, each with `status`, `reason`, `message`, `lastTransitionTime` and `observedGeneration`. See [Conditions](#conditions). |

### status.applied

| Field | Type | Description |
| --- | --- | --- |
| `generation` | int64 | The `metadata.generation` whose settings were applied. Required. |
| `tenants` | int32 | Number of applied tenants. Required. |
| `users` | int32 | Number of applied users. Required. |
| `tenantAuthIssuer` | string | The applied `tenantAuth` issuer; empty without `tenantAuth`. |
| `tenantHostImage` | string | The applied tenant host image; empty means the platform's own default. With `spec.platform.tenantHostImage` empty, later installs keep using it. |

### status.target

| Field | Type | Description |
| --- | --- | --- |
| `serviceUID` | string | UID of the vCluster's `service/vcluster` when the platform was last installed or resynced. vCluster makes that Service the owner of every object it syncs into the host namespace, so a different UID means the synced state was garbage-collected and the instance needs a [resync](platform-operator-operations.md#owner-service-resync). |
| `resyncServiceUID` | string | Set while a resync is running: the UID of the `service/vcluster` it restarted the vCluster control plane for. A resync after the host namespace was deleted starts with the marker `"host-namespace-deleted"` instead, while the namespace terminates and until the vCluster created again in its place has a `service/vcluster`; the field then holds that Service's UID. |
| `resyncStarted` | date-time | When the running resync restarted the vCluster control plane (or started after host namespace deletion). |
| `resyncCause` | string | Set while a resync that follows the loss of the target cluster is running: the reason that started it, such as `HostNamespaceDeleted` (describing the automatic target resync, with `Ready` and `TargetReady` messages prefixed by `host namespace was deleted` until the instance is `Ready` again, when it is cleared). A resync after a deleted `service/vcluster` leaves `resyncCause` empty. |

## Conditions

| Type | True when |
| --- | --- |
| `TargetReady` | The target cluster answers with a kubeconfig. |
| `Installed` | The platform at `spec.version` is installed. |
| `ConfigApplied` | An install applied the spec's platform settings (tenants, users, `tenantAuth`, tenant host image) of the generation `status.applied` names. |
| `Ready` | The instance is usable at `spec.version`. |
| `OwnerServiceProtected` | The admission policy that protects the vCluster's `service/vcluster` is installed. |

When an install, an uninstall or a cleanup fails, the failing condition and `Ready` both get the same
`False` reason and message, and `phase` becomes `Failed` (unless the instance is being deleted).

| Condition | Status | Reason | Meaning |
| --- | --- | --- | --- |
| `TargetReady` | True | `Ready` | The target cluster answers. |
| `TargetReady` | False | `Creating` | The vCluster release was just installed; the control plane comes up next. The first reason a new instance shows, with `Ready=False`, `TargetPending` and `phase: Provisioning`. |
| `TargetReady` | False | `ControlPlanePending` | The vCluster StatefulSet isn't ready. |
| `TargetReady` | False | `KubeconfigPending` | vCluster's kubeconfig Secret doesn't exist yet. |
| `TargetReady` | False | `KubeconfigMissing` | The Secret existed and was deleted; a resync starts. |
| `TargetReady` | False | `HostNamespaceDeleted` | The host namespace (`pi-<namespace>-<name>-<hash>`) of an instance that had a vCluster is terminating or was deleted out of band, along with the vCluster and its data. The operator emits a `Warning` Event (`HostNamespaceDeleted`), drops the lost cluster's install state, records `status.target.resyncServiceUID: "host-namespace-deleted"` and `status.target.resyncCause: "HostNamespaceDeleted"`, recreates the namespace and vCluster once the old namespace is gone, and runs a fresh `pulumi up`. |
| `TargetReady` | False | `HostNamespaceTerminating` | The host namespace of an instance that never had a vCluster is terminating; it is created again once it is gone. |
| `TargetReady` | False | `Repairing` | A missing release object is being recreated. |
| `TargetReady` | False | `RolledBack` | A failed or interrupted repair was rolled back to the last deployed revision. |
| `TargetReady` | False | `Resyncing` | A resync is running: the owner Service was replaced, the host namespace was deleted and is being recreated, or it continues one started by `KubeconfigMissing`. |
| `TargetReady` | False | `TargetUnreachable` | The Secret exists but the vCluster API, named in the message, failed 3 consecutive checks; or a resync has waited more than three repair intervals. |
| `TargetReady` | False | `TargetError` | Ensuring the target failed without a reason of its own (for example the vCluster Helm install failed, or a release left `pending-install` or `failed` at revision 1 was removed to install again); the message names the step and the error, and the operator retries with backoff. `phase` becomes `Failed`. |
| `TargetReady` | False | `TargetDeleteFailed` | Deleting the target failed during deletion. |
| `Installed` | True | `FirstInstall`, `VersionChanged`, `SpecChanged`, `Retry`, `RepairDue`, `Resync` | Why the last successful install or repair ran. |
| `Installed` | False | `InstallFailed` | The install or repair failed; the message names the step, version and error. |
| `Installed` | False | `TenantAuthSecretUnavailable` | `tenantAuth.clientSecretRef` names a Secret or key that can't be read. |
| `Installed` | False | `TenantHostImageUnsupported` | `tenantHostImage` is empty and the `spec.version` package doesn't approve the operator's default host image. |
| `Installed` | False | `InvalidStorageRoot` | A custom `storageRoot` overlaps the operator's `--storage-root-base`; nothing is installed. |
| `Installed` | False | `UninstallFailed` | Dropping the install state failed during deletion. |
| `Installed` | False | `StorageCleanupFailed` | Removing the default `storageRoot` after a `Delete` failed. |
| `ConfigApplied` | True | `Applied` | The message names the generation, tenant and user counts and the issuer. |
| `ConfigApplied` | False | `TenantAuthSecretUnavailable`, `TenantHostImageUnsupported` | Same as on `Installed`. |
| `Ready` | True | `Ready` | The instance is ready. |
| `Ready` | False | `TargetPending` | Waiting for the target cluster. |
| `Ready` | False | `HostNamespaceDeleted` | A resync after the instance's host namespace was deleted out of band is in progress (`status.target.resyncCause` is `HostNamespaceDeleted`). |
| `Ready` | False | `WaitingForStorageCleanup` | A deleted instance waits for its cleanup Job or pod, named in the message, to terminate. |
| `OwnerServiceProtected` | True | `AdmissionPolicyInstalled` | An admission policy denies deleting `service/vcluster`. |
| `OwnerServiceProtected` | False | `AdmissionPolicyUnavailable` | The API server has no admission policies; a `Warning` Event of the same reason is emitted. |

[Operate platform instances](platform-operator-operations.md#when-an-instance-fails) says what to do
for each failure.

## Annotations

| Annotation | Target object | Set by | Meaning |
| --- | --- | --- | --- |
| `platform.di-framework.dev/skip-storage-cleanup` | `PlatformInstance` | you | `"true"` makes `deletionPolicy: Delete` leave the default `storageRoot` on the node. |
| `platform.di-framework.dev/storage-cleaned` | `PlatformInstance` | operator | The instance UID once its default `storageRoot` was removed; any other value is ignored. |
| `platform.di-framework.dev/storage-cleanup-failures` | `PlatformInstance` | operator | Count of failed cleanup Jobs, for the retry backoff. |
| `platform.di-framework.dev/instance` | Host `Namespace` | operator | `<namespace>/<name>` of the `PlatformInstance` that owns `pi-<namespace>-<name>-<hash>`. |
| `platform.di-framework.dev/resync-restart` | Host `Namespace` | operator | `<service uid>/<pod uid>` recorded before deleting `vcluster-0` for a resync (and cleared once the status write or restart completes), so a reconcile whose status write failed does not restart the control plane a second time. |
