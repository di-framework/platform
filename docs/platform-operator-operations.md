# Operate platform instances

Day-two tasks for instances of the [platform operator](platform-operator.md): upgrades, repair,
deletion, host-namespace isolation, failures and target resync. Field and reason names are listed in the
[PlatformInstance reference](platform-instance-reference.md). This page describes release **6.0.30**.

## How the operator reconciles

For each instance the operator adds its finalizer, creates the target, then installs and repairs:

1. **Target.** It creates the host namespace `pi-<namespace>-<name>-<hash>`, applies the host-namespace
   `NetworkPolicy` objects and the cluster-scoped admission policy, installs vCluster from the chart
   embedded in the operator, waits for its control plane, its kubeconfig Secret and its API, and stores
   the instance's kubeconfig in `<name>-kubeconfig`. Every reconcile checks the host namespace and the
   release's objects (`statefulset/vcluster`, `service/vcluster`, `service/vcluster-headless`) and
   re-applies the stored release when one is missing.
2. **Install.** On a first install, a version change, any spec change or a retry after a failed install,
   it writes a Pulumi project pinning `@di-framework/platform@<spec.version>`, sets the config and runs
   `up`. When `spec.version` matches the operator image's baked default platform version (**6.0.30** in
   `v6.0.30`), `pulumi up` runs directly from the pre-installed package cache and Pulumi resource plugins
   without downloading from `registry.npmjs.org` or `get.pulumi.com`. One install or repair is cancelled
   after `--install-timeout` (30 minutes by default) and retried. An instance has at most one Pulumi
   operation in flight.
3. **Repair.** Every `--repair-interval` (30 minutes by default) a Ready instance gets `refresh` then
   `up`, which puts back hand-deleted or edited resources. `status.lastRepair` records when the last one
   finished.

## Upgrade an instance

Change `spec.version` to another exact `@di-framework/platform` version:

```bash
kubectl -n team-a patch pi one --type merge -p '{"spec":{"version":"<version>"}}'
kubectl get pi -A
```

The next reconcile installs the new version with `Installed` reason `VersionChanged` (or `Retry` if
the previous install failed: a retry takes precedence over a version change). While the upgrade
runs, `kubectl get pi` shows the requested version under **Version** and the previous one under
**Installed**; the Headlamp plugin shows both too. `status.installedVersion` changes only once the install
succeeds.

Any other spec change (`tenants`, `users`, `tenantAuth`, `tenantHostImage`) installs with reason
`SpecChanged`. Settings removed from the spec are removed from the stack config too. Keep in mind:

- `spec.target` and `spec.platform.storageRoot` can't change after creation.
- `spec.platform.networkPolicyEngine: kube-router` is rejected by CRD admission (`XValidation`) on
  `vcluster` targets: the vCluster virtual cluster has no dedicated nodes for kube-router's DaemonSet,
  and a second kube-router on the host node would conflict with the host cluster's CNI enforcement.
  `vcluster` instances use `existing`. An instance stored with `kube-router` before the rule can still
  be updated while it keeps that value, and once switched to `existing` cannot switch back.
- The vCluster values are applied at creation only. Changing them means recreating the instance.
- The tenant host image doesn't move on its own. An empty `tenantHostImage` keeps the image recorded in
  `status.applied.tenantHostImage`, so upgrading the instance or the operator doesn't restart the tenant
  hosts. To move it, set `tenantHostImage` (for example together with the `spec.version` change); that
  rolls the tenant hosts.
- A new instance with an empty `tenantHostImage` needs a `spec.version` whose package approves the
  operator's default host image (from `6.0.20`); otherwise the install stops with
  `TenantHostImageUnsupported`.

### Upgrade the operator

Upgrade the chart to the new release. The CRD sits in the chart's templates, so `helm upgrade` upgrades
it too, and the passphrase is reused from the cluster:

```bash
helm upgrade platform-operator oci://ghcr.io/di-framework/charts/platform-operator \
  --version <release> --namespace platform-operator
```

An operator upgrade doesn't upgrade instances: each keeps its `spec.version`. A repair after the operator
moves to a newer vCluster chart re-applies each instance's stored release with the chart and values it
was installed with, so it is not a vCluster upgrade.

### Rotate the tenant-auth client secret

Change the value in the Secret `clientSecretRef` names. The next repair (at most one repair interval)
rewrites `platform-operator-tenant-auth` inside the instance, and the platform controller copies it into
`tenant-console-oauth` in each tenant's runtime namespace. The consoles keep the old secret until they
restart; once `tenant-console-oauth` holds the new value, restart them with the instance's kubeconfig:

```bash
kubectl --kubeconfig instance.kubeconfig -n di-runtime-<tenant> rollout restart deployment/tenant-console
```

## Host-namespace isolation

vCluster syncs the platform's `NetworkPolicy` objects into the instance's host namespace
(`pi-<namespace>-<name>-<hash>`), where the host cluster's policy engine enforces them (including narrowed
`/32` or `/128` Kubernetes API server endpoint egress rather than broad `0.0.0.0/0` RFC1918 egress). To
isolate the vCluster control plane, CoreDNS, and initial bootstrap traffic, the operator reconciles these
scoped ingress `NetworkPolicy` objects in every `vcluster` instance's host namespace (labelled
`app.kubernetes.io/managed-by: platform-operator`):

- `platform-operator-deny-ingress`: default ingress deny selecting every pod in the host namespace.
- `platform-operator-allow-control-plane`: allows the instance's synced pods to reach the vCluster control
  plane on TCP port 8443 (`svc/vcluster:443` and `vcluster-node-*` kubelet port `10250`), while synced
  pods use the platform's narrowed `/32` or `/128` Kubernetes API server endpoint egress rules.
- `platform-operator-allow-dns`: allows the instance's synced pods to reach the instance's CoreDNS
  (`k8s-app=kube-dns` in virtual `kube-system`) on UDP and TCP port 53.
- `platform-operator-allow-platform-nats`: allows the platform namespace's `hostgroup` and
  `runtime-operator` pods (`vcluster.loft.sh/namespace=wasmcloud`) to reach NATS (`wasmcloud.com/name=nats`)
  on TCP port 4222 so the initial wasmcloud Helm release becomes Ready before the platform's own
  `di-platform-nats` policy is created.
- `platform-operator-allow-issuer` (only when `spec.platform.tenantAuth.issuerUpstream` names a namespace
  other than `wasmcloud`, `kube-system`, or `di-*`): allows `tenant-auth` pods
  (`platform.di-framework.dev/component=tenant-auth`) and `di-platform-controller`
  (`vcluster.loft.sh/namespace=wasmcloud`) to reach pods in the `issuerUpstream` namespace on its port
  and `issuerUpstreamPodPort`.
- `platform-operator-allow-same-namespace`: allows the vCluster control plane pods
  (`app=vcluster,release=vcluster` without `vcluster.loft.sh/managed-by`) to reach every pod in the host
  namespace for webhook calls, probes, and control-plane traffic.
- `platform-operator-allow-operator`: allows the operator's own namespace to reach the vCluster API on
  TCP port 8443.

## Delete and Retain

`spec.deletionPolicy` decides what `kubectl delete pi` does. You can change it on a live instance before
deleting it.

| | `Delete` (default) | `Retain` |
| --- | --- | --- |
| vCluster and its host namespace | Uninstalled and deleted, with the vCluster's data volume and everything the platform installed | Left in place |
| Install state | Dropped (no Pulumi `destroy`) | Kept |
| Default `storageRoot` on the node | Removed by a cleanup Job | Kept |
| Custom `spec.platform.storageRoot` | Never removed; remove it yourself | Kept |
| A new instance with the same namespace and name | Starts empty | Picks up the vCluster, data, state and `storageRoot` again |

The platform keeps tenant data (registry blobs, tenant volumes, PGlite `PGDATA`) in node `hostPath`s
under the instance's `storageRoot`, so deleting the vCluster alone doesn't remove it. With `Delete`, once
the target is gone, the operator runs a Job `pi-storage-cleanup-<name hash>-<uid hash>` in the cleanup
namespace that removes exactly `<storageRootBase>/<namespace>/<name>`. The finalizer holds until the Job
succeeds.

- **A failed cleanup** sets `Installed=False` with reason `StorageCleanupFailed` and a message naming
  the path, then retries after a backoff starting at 10 seconds and doubling up to 5 minutes.
- **The way out**, when the node can't run the cleanup: annotate the instance, or switch it to `Retain`.
  Any running cleanup Job is stopped, the finalizer is released and the directory stays on the node.

  ```bash
  kubectl -n team-a annotate pi one platform.di-framework.dev/skip-storage-cleanup=true
  ```

- **`Ready=False`, reason `WaitingForStorageCleanup`**: before releasing the finalizer the operator waits
  for the instance's cleanup Jobs and pods to be gone. A pod stuck `Terminating` holds the instance; the
  last resort is `kubectl -n <cleanup-namespace> delete pod <pod> --force --grace-period=0`.
- The cleanup assumes a single node and the current `--storage-root-base`. If either is wrong, it fails
  open: it removes nothing it shouldn't, reports cleaned, and the data stays where it was written.

## When an instance fails

When the target, an install or a cleanup fails, the failing condition and `Ready` carry the same reason
and message, and `phase` becomes `Failed`, except while the instance is being deleted: a failed cleanup
or uninstall leaves it in `Deleting`. Read them with:

```bash
kubectl -n team-a get pi one -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}: {.message}{"\n"}{end}'
```

| Condition and reason | What it means | What to do |
| --- | --- | --- |
| `TargetReady=False`, `Creating`, `ControlPlanePending` or `KubeconfigPending` | The vCluster release was just installed (`Creating`, the first reason a new instance shows) or is still coming up. | Wait; the target is polled every `targetPoll` (10 seconds by default). |
| `TargetReady=False`, `TargetUnreachable` | The vCluster API, named in the message, failed 3 consecutive checks, or a resync has waited more than three repair intervals at the stage the message names. | Check the vCluster pods in the host namespace. An installed instance goes straight back to `Ready` once the target answers. |
| `TargetReady=False`, `Repairing` | A missing release object is being recreated from the stored release. | Nothing; it clears on its own. |
| `TargetReady=False`, `RolledBack` | A repair of the vCluster release failed or was interrupted and was rolled back to the last deployed revision. | Nothing; the next round repairs again. |
| `TargetReady=False`, `TargetError` | Ensuring the target failed; the message names the step and the error. Examples: the vCluster Helm install failed (`install vcluster 0.37.3: …`), the host namespace belongs to another instance, applying the NetworkPolicies or the admission policy failed, or a rollback failed. A release left `pending-install` or `failed` at revision 1 is removed and installed again ("removed it to install again"). | Read the message; check the vCluster release (`helm -n <host-namespace> list -a`) and pods in the host namespace. The operator retries with backoff. |
| `TargetReady=False`, `KubeconfigMissing` or `Resyncing` | The owner Service or the vCluster's kubeconfig Secret was lost, or a host-namespace resync is in progress. | See [Owner-Service resync](#owner-service-resync) and [Host-namespace deletion resync](#host-namespace-deletion-resync). |
| `TargetReady=False`, `HostNamespaceDeleted` (also on `Ready`) | The instance's host namespace (`pi-<namespace>-<name>-<hash>`) is terminating or was deleted out of band. | Wait for the automatic resync to recreate the namespace, vCluster and platform install, then re-apply any user-created in-instance manifests. See [Host-namespace deletion resync](#host-namespace-deletion-resync). |
| `TargetReady=False`, `HostNamespaceTerminating` | The host namespace of an instance that never had a vCluster is terminating. | Wait for the namespace to finish terminating; the operator creates it again once it is gone. |
| `Installed=False`, `InstallFailed` | The Pulumi install or repair failed; the message names the step, the version and the error. | Fix the cause the message names; an install at a non-default `spec.version` needs egress to `registry.npmjs.org` and the Pulumi plugin host. The operator retries with reason `Retry` and refreshes first. |
| `Installed=False`, `TenantAuthSecretUnavailable` (also on `ConfigApplied`) | The Secret or key `tenantAuth.clientSecretRef` names can't be read. | Create it in the instance's namespace. The operator doesn't watch Secrets: the next retry picks it up, and the backoff reaches about 16 minutes. On an installed instance the platform keeps serving with the last applied secret meanwhile. |
| `Installed=False`, `TenantHostImageUnsupported` (also on `ConfigApplied`) | `tenantHostImage` is empty and the `spec.version` package doesn't approve the operator's default host image. Nothing was applied. | Set `spec.platform.tenantHostImage`, or a newer `spec.version`. |
| `Installed=False`, `InvalidStorageRoot` | A custom `storageRoot` that a cleanup could reach (inside `--storage-root-base`, `/`, or containing the base in its `di-tenants` or `di-framework` tree). Checked before the first install only. | `storageRoot` is immutable: recreate the instance with another root, or none. |
| `Installed=False`, `StorageCleanupFailed` | Removing the default `storageRoot` after a `Delete` failed. | See [Delete and Retain](#delete-and-retain). |
| `OwnerServiceProtected=False`, `AdmissionPolicyUnavailable` | The API server has no `ValidatingAdmissionPolicy`; `service/vcluster` is unprotected. | Use Kubernetes 1.30 or later. The instance keeps working meanwhile. |

To see what the operator itself did, read its log; add `--set extraArgs={--zap-log-level=debug}` to the
chart for more detail.

```bash
kubectl -n platform-operator logs deployment/platform-operator
```

## Owner-Service resync

vCluster sets the owner of every object it syncs into the host namespace (the synced pods, Services,
ConfigMaps, Secrets such as the platform's `wasmcloud-*-tls`, NetworkPolicies and its own kubeconfig
Secret `vc-vcluster`) to the instance's `service/vcluster`. Deleting that Service makes the garbage
collector delete all of them. **Don't delete `service/vcluster` or the host namespace**; to remove an
instance, delete the `PlatformInstance`.

The operator protects `service/vcluster` with the cluster-scoped `ValidatingAdmissionPolicy`
`platform-operator-protect-vcluster-service`, which denies deleting a Service named `vcluster` in a
namespace labelled `platform.di-framework.dev/host-namespace=true`, except by the operator's own user or
while the namespace is terminating. A deleted or edited policy comes back on the instance's next
reconcile.

If `service/vcluster` is lost anyway, the operator notices: it records the Service's UID in
`status.target.serviceUID` at the first install, and when the UID differs on a later reconcile, or
`vc-vcluster` is missing, it resyncs:

1. It re-applies the vCluster release if the Service is gone.
2. It records `platform.di-framework.dev/resync-restart: <service uid>/<pod uid>` on the host namespace
   (so a reconcile whose status write failed does not restart the control plane a second time), then
   deletes `vcluster-0`, which its StatefulSet recreates so the syncer writes `vc-vcluster` again and
   syncs back to the host the virtual objects that survived. Not everything did: see
   [What a resync doesn't bring back](#what-a-resync-doesnt-bring-back). `TargetReady` is `False` with `Resyncing` (or
   `KubeconfigMissing` on the round that starts a resync because `vc-vcluster` was missing);
   `status.target.resyncServiceUID` and `resyncStarted` describe the running resync. The
   `platform.di-framework.dev/resync-restart` annotation is cleared once the status records the resync or
   the restarted syncer has written `vc-vcluster`.
3. Once the control plane, the Secret and the API answer, it reinstalls the platform at once, not at the
   next repair: it uninstalls the surviving `wasmcloud` Helm Release inside the vCluster, refreshes the
   stack state, and runs `pulumi up` to reinstall the chart and recreate the chart-rendered
   `wasmcloud-*-tls` Secrets. That install reports `Installed` reason `Resync`. A failed reinstall keeps
   the resync pending and is retried.

### Host-namespace deletion resync

In addition to watching the owner `Service` UID, the controller watches host namespaces
(`platform.di-framework.dev/host-namespace=true`) and checks on every reconcile whether the target's host
namespace (`pi-<namespace>-<name>-<hash>`) still exists or is terminating:

- **If the host namespace of an instance that had a vCluster was deleted out of band or is terminating**,
  the vCluster and its data volume are gone with it. The operator immediately sets `TargetReady=False`
  and `Ready=False` with reason `HostNamespaceDeleted`, emits a `Warning` Event (`HostNamespaceDeleted`),
  drops the lost cluster's Pulumi install state (which held the old cluster's credentials), and records
  `status.target.resyncServiceUID: "host-namespace-deleted"` and
  `status.target.resyncCause: "HostNamespaceDeleted"`. Once the terminating namespace is gone, the
  operator recreates the host namespace and installs a fresh vCluster (`TargetReady=False` with reason
  `Resyncing` and `Ready=False` with reason `HostNamespaceDeleted`, both messages prefixed with
  `host namespace was deleted`), transitions `status.target.resyncServiceUID` to the new
  `service/vcluster` UID, and runs a fresh `pulumi up` (`Installed` reason `Resync`). Once the install
  succeeds, `Ready` returns to `True` and `status.target.resyncCause` is cleared.
- **If the host namespace of an instance that never had a vCluster is terminating**, `TargetReady` is
  `False` with reason `HostNamespaceTerminating` until the namespace finishes terminating and is created
  again.

A resync still waiting more than three repair intervals after `resyncStarted` is reported as
`TargetReady=False`, `TargetUnreachable`, naming the stage it waits at.

### What a resync doesn't bring back

A resync restores what the platform installs: the vCluster release, the platform's Helm Release and the
objects its Pulumi program manages. The platform's own controllers also write some synced objects again
on their next pass (the tenancy controller reissues `tenant-controller-tls` from its CA, for example).
Every other ConfigMap and Secret inside the instance that vCluster synced to the host was
garbage-collected with its host copy, and vCluster deleted the virtual copy too, so it is gone in both
places and nothing outside the platform creates it again. vCluster (0.37.3, as the operator installs it)
syncs only the ConfigMaps and Secrets a pod uses (`sync.toHost.configMaps.all` and `secrets.all` are
`false`), so only those are lost; one no pod uses isn't affected:

- **ConfigMaps and Secrets that pods use and that you or your tenants created inside the instance**,
  with `kubectl` against an instance or tenant kubeconfig, with your own Helm charts or manifests, or by
  any controller other than the platform. Pods that mount one stay in `ContainerCreating`
  (`MountVolume.SetUp failed … configmap … not found`) until it is applied again, and whatever depends
  on those pods stays down with them. For example, an OIDC issuer run inside the instance loses its
  ConfigMap, the issuer pod never starts, and tenant-console, which waits for OIDC discovery of
  `tenantAuth.issuer`, keeps restarting until the ConfigMap is applied again.
- **Secrets that a component inside the instance generated at runtime and that a pod mounts** (a
  workload's own keys or credentials, for example). They aren't in any chart or Pulumi program: they are
  lost for good, and whatever they protected (issued tokens, sessions) has to be issued again.

So:

- Keep what the platform depends on outside the instance: run the OIDC issuer named by
  `tenantAuth.issuer` (and any other service the platform or your tenants need) in the host cluster or
  elsewhere, not inside the instance. The tenant-auth OAuth client secret is safe: the operator reads it
  from `clientSecretRef` in the PlatformInstance's namespace and the Pulumi program writes the copy,
  `platform-operator-tenant-auth`, again.
- Keep the manifests for anything you create inside an instance, and apply them again once the resync
  is done (`Ready=True`, with `Installed` at reason `Resync`).

Deleting only `vc-vcluster` (`KubeconfigMissing`) restarts the syncer without touching
`service/vcluster`, so nothing is garbage-collected and nothing else is lost. The admission policy above
makes losing the owner Service possible only when the policy is bypassed or unavailable; this section
describes what happens then.

## Back up the operator state

The state claim (`platform-operator-state` for the default release name) holds each instance's Pulumi
project and file backend. Losing it means Pulumi forgets what it installed: back it up, and keep the
passphrase Secret `platform-operator-passphrase` with it. Without the original passphrase the state is
unreadable.
