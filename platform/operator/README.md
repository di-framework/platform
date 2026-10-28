# platform-operator

A Go operator that turns a namespaced `PlatformInstance` (`platform.di-framework.dev/v1alpha1`) into a
running, isolated copy of the di-framework platform. v1alpha1 has one target: a vCluster on the operator's
own cluster. The install is the platform's existing-cluster program (`@di-framework/platform/existing`),
run through the Pulumi Automation API.

```yaml
apiVersion: platform.di-framework.dev/v1alpha1
kind: PlatformInstance
metadata:
  name: one
  namespace: team-a
spec:
  version: 6.0.17          # exact @di-framework/platform version
  target:
    type: vcluster
  platform:                # optional
    networkPolicyEngine: existing
    gateway:
      httpNodePort: 30080                        # publishes the gateway; 0 keeps it in-instance only
      httpEndpoint: http://apps.example:30080   # public base URL; reported in status.endpoints.http
  deletionPolicy: Delete   # or Retain
```

`kubectl get pi -A` shows the requested and installed versions and the phase. The instance's admin
kubeconfig is in the Secret named by `status.kubeconfigSecretRef` (`<name>-kubeconfig`, key `kubeconfig`).

## Network policy engine

`spec.platform.networkPolicyEngine: existing` (the default) is the supported value on KubeSolo, and the only one
a new instance accepts. The vCluster syncs the instance's NetworkPolicies to the host, and the host's policy
engine (kube-router on KubeSolo) enforces them alongside the operator's
[host-namespace policies](#host-namespace-isolation). `kube-router` would install a second kube-router inside
the vCluster. Its pods run on the host's node and program the same iptables and ipset chains as the host's
kube-router, so the two race and can undo the host's enforcement of the instance's policies (#456).

The CRD refuses `kube-router` for the `vcluster` target (the only target in v1alpha1) with a CEL rule:
`kubectl apply` and the Headlamp form fail with "platform.networkPolicyEngine kube-router is not supported on
the vcluster target ... Use existing". An instance stored with `kube-router` before the rule keeps working and
can still be updated while it keeps the value; the rule only stops a new instance from choosing it and an
existing one from switching to it. Moving such an instance to `existing` puts it on the supported setup; it
can't switch back.

## Tenancy settings

`spec.platform` also carries the instance's tenants, users, `tenantAuth` and tenant host image, so an instance
comes up with a working console and `/v1` API without touching the operator's stack config:

```yaml
apiVersion: v1
kind: Secret
metadata: { name: tenant-auth-oauth, namespace: team-a }
stringData: { clientSecret: <the console's OAuth client secret> }
---
apiVersion: platform.di-framework.dev/v1alpha1
kind: PlatformInstance
metadata: { name: one, namespace: team-a }
spec:
  version: 6.0.20
  target: { type: vcluster }
  platform:
    tenants:
      - name: acme
    users:
      - name: dev
        memberships: [{ tenant: acme, role: developer }]
    tenantAuth:
      image: ghcr.io/di-framework/tenant-auth@sha256:<digest>
      issuer: https://id.example
      clientId: console
      clientSecretRef: { name: tenant-auth-oauth, key: clientSecret }
      registry: { component: ghcr.io/di-framework/oci-registry@sha256:<digest> }
```

Each field is the platform's config key of the same name (see `platform/platform/README.md`), passed through
as JSON:

| `spec.platform` | Platform config | Notes |
| --- | --- | --- |
| `tenants[]` (`name`, `suspended`, `deletionPolicy`, `runtime.{replicas,coreInstances}`, `resources.{cpu,memory,workloads,backingServices,serviceBindings,apiKeys}`) | `tenants` | Always set (`[]` when empty). At most 32; names are unique, 1-40 lowercase letters, digits and hyphens, starting with a letter. The bounds are the platform Tenant CRD's: `replicas` 1-10, `coreInstances` 1-10000, `workloads` 1-1000, `backingServices` 1-100, `serviceBindings` 1-400, `apiKeys` 1-10000, and `cpu`/`memory` are quantities (`500m`, `1.5`, `512Mi`). |
| `users[]` (`name`, `suspended`, `memberships[].{tenant,role}`) | `users` | Always set (`[]` when empty). At most 128, each with at most 16 memberships (so the membership rule stays within the apiserver's CEL cost limit); each membership names an entry of `tenants`, once, as `developer` or `viewer`. |
| `tenantAuth.image`, `issuer`, `issuerUpstream`, `issuerUpstreamPodPort`, `issuerIp`, `consolePublicUrl`, `controllerPublicUrl`, `registry.{component,publicUrl,limits}` | `tenantAuth.<same>` | `image` and `registry.component` are pinned by digest. `issuer`, `clientId` and `clientSecretRef` go together. |
| `tenantAuth.clientId` | `tenantAuth.oauthClient.id` | |
| `tenantAuth.clientSecretRef.{name,key}` | `tenantAuth.oauthClient.secretName` | See below. |
| `tenantHostImage` | `tenantHostImage` | Can change: the next install applies it and restarts the tenant hosts. Empty keeps the image the instance was first installed with, recorded in `status.applied.tenantHostImage` (see below). |
| `tenantHostImagePullPolicy` | `tenantHostImagePullPolicy` | `Always`, `IfNotPresent` or `Never`; unset leaves the platform's default. |

**The client secret is never inline.** `clientSecretRef` names a Secret and key in the PlatformInstance's
namespace. On every install and repair the operator reads it and sets it as the encrypted stack config key
`tenantAuthClientSecret`; the instance's Pulumi program writes it to the Secret `platform-operator-tenant-auth`
(key `clientSecret`) in the platform namespace inside the instance, and `tenantAuth.oauthClient.secretName`
names that Secret. A missing Secret or key stops the install with `Installed=False`,
reason `TenantAuthSecretUnavailable` (and `ConfigApplied=False` with the same reason), and is retried with
backoff. The operator doesn't watch the Secret, so creating a missing one is picked up by the next retry (the
backoff reaches about 16 minutes), not at once. On an installed instance, a repair that finds the source
Secret gone also sets `phase: Failed` and `Ready=False` until the Secret is back: that means the instance
can't be reconciled to its spec, not that it is down. Nothing is removed, and the platform keeps serving
with the last applied client secret.

**Rotating the client secret.** Change the value in the source Secret. The next repair (at most one
`--repair-interval`, 30 minutes by default) rewrites `platform-operator-tenant-auth`, and the platform
controller copies it into `tenant-console-oauth` in each tenant's runtime namespace. The consoles read it from
their environment at start, so each keeps the old secret until it restarts. Once `tenant-console-oauth`
holds the new value, restart them with the instance's kubeconfig (`status.kubeconfigSecretRef`):

```sh
kubectl --kubeconfig instance.kubeconfig -n di-runtime-<tenant> rollout restart deployment/tenant-console
```

**The tenant host image.** An explicit `tenantHostImage` is applied as set, and changing it (for example
together with a `spec.version` upgrade) is a spec change that rolls the tenant hosts. Left empty:

- A **new instance** gets the operator's pinned exclusive host variant,
  `ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@sha256:...` (the PGlite exclusive-PGDATA workloads need
  it; the image pin PR moves it), at its first install. That image is recorded in
  `status.applied.tenantHostImage`, and later installs and repairs keep using it, so upgrading the operator
  never moves it or restarts the hosts. To move it, set the field. Before that first install uses the
  default, the operator checks that the installed `@di-framework/platform@<spec.version>` lists its digest
  as an approved host build (`NATS_CREDENTIALS_HOST_IMAGE_DIGESTS` in `dist/tenancy/registry-nats.js`, which
  gives a tenant registry its own NATS account). The default's pin PR adds the digest to that list, so it
  is approved from the next platform release on (today's default from `6.0.20`). When the package doesn't
  list it, nothing is applied and the install stops with `Installed=False` and `ConfigApplied=False`, reason
  `TenantHostImageUnsupported`, naming the digest and the version. Set `tenantHostImage` or a newer
  `spec.version`. An explicit or recorded image isn't checked.
- An **instance installed before the operator managed the host image** (`Installed` with no
  `status.applied`) keeps the platform's own default: the operator doesn't set the key (and removes a
  hand-set one), records it as empty, and keeps doing so, so its hosts don't restart on the operator upgrade.

Clearing the field after it was set keeps the last applied image; nothing reverts to a default on its own.

**Changes.** A change to `tenants`, `users`, `tenantAuth` or `tenantHostImage` is a spec change, so the next reconcile installs
(`Installed` reason `SpecChanged`) with the new config. Settings removed from the spec (`tenantAuth`,
`tenantHostImagePullPolicy`) are removed from the stack config too, as is `tenantHostImage` when the applied
image is the platform's own default. A repair with an unchanged spec sets the
same config, so its `up` changes nothing. `status.applied` reports what the last install applied (the
generation, the number of tenants and users, the `tenantAuth` issuer and the tenant host image), and the
`ConfigApplied` condition says the same in words.

The rest of the install stays operator-owned: the platform namespace (`wasmcloud`), the `storageRoot` layout,
the Kubernetes endpoint and the kubeconfig.

## How it reconciles

1. **Finalizer.** Added before anything is created, so a delete never orphans a cluster.
2. **Target.** Creates the host namespace `pi-<namespace>-<name>-<hash>` (the hash of `<namespace>/<name>`
   keeps `team-a/one` and `team/a-one` apart; dots become dashes and long names are cut to fit), annotated
   `platform.di-framework.dev/instance: <namespace>/<name>`. The operator refuses to install into a namespace
   whose annotation names anyone else, and on delete leaves such a namespace alone and releases the
   finalizer. It installs vCluster from the embedded, digest-checked
   chart (0.37.3), then waits for its control plane, its kubeconfig Secret and its API. A release left
   `pending-install`, or `failed` at revision 1 (an install that errored or was interrupted), is removed and
   installed again, with backoff, so an install that fails every time doesn't cycle every poll. A later
   revision left `failed` or `pending-*` (a repair that errored or was interrupted) is never uninstalled: it
   is rolled back to the last deployed revision (`TargetReady=False/RolledBack`), and the next round repairs
   again. The kubeconfig is rewritten to the in-cluster Service address and stored in the instance's Secret.
   Every reconcile (a poll, a repair) checks the release's host-namespace objects (`statefulset/vcluster`,
   `service/vcluster`, `service/vcluster-headless`): when one is missing it re-applies the stored release
   exactly, with the chart and values it was installed with (not the operator's embedded chart, so a repair
   after the operator moves to a newer vCluster chart is not an upgrade), which recreates it and leaves the
   rest unchanged. An intact release is not re-applied. The vCluster's data PVC belongs to the StatefulSet,
   which recreates it with its pod; the kubeconfig Secrets are rewritten every round.
3. **Install.** On first install, a version change, any spec change or a retry after a failed install (which
   refreshes first), it writes a Pulumi project for the
   instance (`package.json` pinning `@di-framework/platform@<version>`, an `index.ts` re-exporting the
   existing entrypoint, plus the `tenantAuth` client secret Secret, see above), sets the config and runs `up`. One install or repair is cancelled after
   `--install-timeout` (30 minutes by default) and retried, so a hung run doesn't hold a worker.
4. **Repair.** Every `--repair-interval` (30 minutes by default) a Ready instance gets `refresh` then `up`,
   which puts back hand-deleted or edited resources. Between repairs, an installed instance whose target
   answers again after a blip goes straight back to `Ready`.
5. **Delete.** `Delete` uninstalls the vCluster and deletes its host namespace (and so the vCluster's data
   volume and everything the platform installed), drops the instance's install state without a `destroy`,
   then removes the instance's default `storageRoot` from the node (see below), then releases the finalizer.
   A new PlatformInstance with the same namespace and name starts empty. `Retain` releases the finalizer and
   leaves the vCluster, its data, the install state and the `storageRoot`, so a new PlatformInstance with the
   same name and namespace picks them up again.

`spec.target` and `spec.platform.storageRoot` can't change after creation, and names are at most 63
characters.

Status carries `phase` (`Provisioning`, `Installing`, `Ready`, `Failed`, `Deleting`) and the `TargetReady`,
`Installed` and `Ready` conditions (and `OwnerServiceProtected`, see [Destructive operations](#destructive-operations)), each with a readable reason and message. While the target isn't ready,
`TargetReady` is `False` with `ControlPlanePending` (the vCluster StatefulSet isn't ready), `Repairing` (a
missing release object is being recreated), `RolledBack` (a failed or interrupted repair was rolled back),
`KubeconfigPending` (vCluster's kubeconfig Secret doesn't exist yet), `KubeconfigMissing` (the Secret
existed and was deleted; a resync starts), `Resyncing` (see [Destructive operations](#destructive-operations))
or `TargetUnreachable` (the Secret
exists but the vCluster API, named in the message, failed 3 consecutive checks; a single failed check
changes nothing). While the instance's kubeconfig Secret exists, `kubeconfigSecretRef` keeps pointing at it.

### Tenant data after Delete

The platform keeps tenant data (registry blobs, tenant volumes, pglite `PGDATA`) in node `hostPath`s under
the instance's `storageRoot`, so deleting the vCluster doesn't remove it. With `deletionPolicy: Delete`, once
the target is gone the operator runs a short-lived Job (`pi-storage-cleanup-<name hash>-<uid hash>`, in
`--cleanup-namespace`) that mounts only `--storage-root-base` from the node (hostPath type
`DirectoryOrCreate`) and removes exactly `<namespace>/<name>` under it with `rm -rf`. The path is checked
first (no empty parts, no `..`, no `/`, an absolute, clean base other than `/`, which the operator also checks
at startup). A fixed `sh` script gets the base, `<namespace>/<name>` and `<namespace>` as quoted positional
arguments, never interpolated. It changes into the base (and stops if it can't), refuses a symlink at
`<namespace>` (`rm` would follow it out of the instance's directory), and runs `rm -rf --` on the relative
path. A symlink at `<name>` is removed, not followed. A symlinked `--storage-root-base` can't be detected from
inside the pod: kubelet resolves it on the node when it mounts the hostPath, so the cleanup acts on the link's
target. Point `--storage-root-base` at the real directory. The script also refuses a symlinked base, but that
is defense in depth for runs outside a pod, not a guarantee. The image is busybox pinned by digest. On a fresh node where the
base doesn't exist yet, kubelet creates it empty and the cleanup succeeds trivially, since nothing was written
on this node. The pod runs as root, since tenant data is
owned by other UIDs, but with every capability dropped except `DAC_OVERRIDE` and `FOWNER` (what `rm` needs
for other users' directories and sticky directories), no privilege escalation, a read-only root filesystem,
the `RuntimeDefault` seccomp profile and small resource requests and limits. The finalizer holds until the Job
succeeds.

- **Each Job belongs to one incarnation of the instance.** It carries the instance UID. A Job or pod of an
  earlier instance with the same `<namespace>/<name>` is deleted unread before a new one starts, so a
  recreated instance never trusts, or is cleaned by, its predecessor's Job.
- **Nothing outlives the release.** Whatever releases the finalizer (a finished cleanup, the skip annotation,
  `Retain`, a custom root), the operator first deletes the instance's cleanup Jobs and their pods and waits
  until they are gone. While it waits, `Ready` is `False` with reason `WaitingForStorageCleanup`, naming the
  Job or pod. A pod stuck `Terminating` (for example `rm` blocked in uninterruptible IO) holds the instance;
  the last resort is `kubectl -n <cleanup-namespace> delete pod <pod> --force --grace-period=0`. The `rm` may
  still be running on the node after that.
- **Success is recorded per incarnation.** The `platform.di-framework.dev/storage-cleaned` annotation holds
  the instance UID; any other value (`"true"`, a UID copied from another manifest) is ignored.
- **A custom `spec.platform.storageRoot` is never removed.** The operator didn't create that path and can't
  know what else lives there. Remove it yourself when its data must go. A custom root that a cleanup could
  reach is rejected before its first install (`Installed` False, reason `InvalidStorageRoot`): a root inside
  `--storage-root-base` (including inside some `<base>/<namespace>/<name>`), `/`, or a root whose
  `di-tenants` or `di-framework` tree contains the base. A root that only contains the base, such as the
  platform's own `/var/lib/kubesolo`, is fine: the platform writes only under `<root>/di-tenants` and
  `<root>/di-framework`. An instance that has installed is never failed by this check.
- **A failed cleanup** (the Job fails, for example on a symlink, or its pod can't start within 5 minutes)
  sets `Installed` to `False` with reason
  `StorageCleanupFailed` and a message naming the path and the attempt, and deletes the failed Job. The next
  Job starts after an exponential backoff: 10s after the first failure, doubling per failure, at most 5
  minutes. The failures are counted in the instance's `platform.di-framework.dev/storage-cleanup-failures`
  annotation. The finalizer stays meanwhile.
- **The way out**, when the node can't run the cleanup: annotate the instance with
  `platform.di-framework.dev/skip-storage-cleanup: "true"` (or set `deletionPolicy: Retain`). Any running
  cleanup Job is stopped, the finalizer is then released and the directory stays on the node.
- **Single node only** (as all of v1alpha1); multi-node is out of scope. The Job isn't pinned to a node. On
  one node it runs where the data is. On more than one node it may run on a node without the data and succeed,
  so the instance is released while its data stays on the original node: the cleanup fails open (nothing is
  removed that shouldn't be), and a successful cleanup proves nothing there.
- **A wrong base also fails open.** The cleanup removes `<namespace>/<name>` under the `--storage-root-base`
  the operator runs with now. If the flag changed since the instance installed, or the base is wrong for this
  node, the Job removes an absent path (creating an empty base if needed) and reports cleaned, while the data
  stays where it was written. Nothing is removed that shouldn't be; remove the old directory yourself.

### One install per instance

controller-runtime never reconciles the same key twice at once, and leader election (on by default) runs one
operator. So an instance has at most one Pulumi operation in flight, and a lock found on its stack was left by
a crashed operator. The installer then cancels it (or, where the file backend can't cancel, removes the stack's
lock files), refreshes, and retries the update once.

### State

The default `storageRoot` is `--storage-root-base` (`/var/lib/kubesolo/instances`) `/<namespace>/<name>`.

`--state-dir` (the operator's PVC) holds, per instance, `<namespace>.<name>/project` (the Pulumi project and
its `node_modules`) and `<namespace>.<name>/state` (a file backend of its own, so locks never cross instances).
Losing the volume means Pulumi forgets what it installed: back it up. `--passphrase-file` encrypts the state's
secrets; keep it in a Secret.

## vCluster instance defaults

`internal/targets/vcluster/defaults.go` holds the chart values every instance gets. They are the values the
proving-grounds Layer 3 suite passed with inside a vCluster on KubeSolo (`testdata/layer3-pass-values.yaml`; a
test keeps the two identical):

- the OSS build (`loft-sh/vcluster-oss`);
- NetworkPolicies synced to the host, whose single policy engine enforces them (the platform runs with
  `networkPolicyEngine: existing` inside);
- standard cluster DNS: CoreDNS labelled `k8s-app=kube-dns` and listening on 53, because the platform's DNS
  egress policies allow exactly that, and vCluster's default (`vcluster-kube-dns` on 1053) is dropped;
- CoreDNS forwarding to the host's `kube-system/kube-dns`, because KubeSolo nodes have an empty `resolv.conf`.

The values are applied **at creation only**. A later chart upgrade doesn't carry a changed CoreDNS config to
the host-side synced ConfigMap, so changing them means recreating the instance.

## Host-namespace isolation

vCluster syncs the platform's NetworkPolicies to the host, but those cover the tenant namespaces, not the
instance's `wasmcloud` namespace, its CoreDNS or the vCluster control plane. So the operator owns three
NetworkPolicies in every instance host namespace (`pi-<namespace>-<name>-<hash>`), labelled
`app.kubernetes.io/managed-by: platform-operator` (#452):

- `platform-operator-deny-ingress`: every pod in the namespace is selected for ingress, so nothing gets in that
  no policy allows;
- `platform-operator-allow-same-namespace`: pods of the same host namespace get in, which covers the instance's
  own synced pods, its CoreDNS, and its vCluster control plane reaching synced pods and serving the kubelet port
  (10250) of its `vcluster-node-*` Services;
- `platform-operator-allow-operator`: the operator's own namespace gets
  in to the vCluster API (`app=vcluster` pods, port 8443 behind `svc/vcluster:443`), for the target check and
  the installs.

The target applies them on every reconcile, before the vCluster is installed, so a deleted or edited policy is
back by the next round (and so by the next repair); an unchanged one is not written.

What this isolates: pods of another instance, and pods in any other host namespace, can't reach this
instance's `wasmcloud` services (NATS, host group, runtime-operator, `wasmcloud-http`), its CoreDNS, its vCluster
API or its kubelet port. The platform's own synced policies name their peers by namespace (platform #462), so they keep isolating its tenant namespaces and admit no other instance.

What it doesn't:

- **Egress** is not restricted here; it stays as the platform's synced policies set it (DNS to the host's
  `kube-system/kube-dns` on 53 among it).
- **The HTTP gateway, when published.** With `gateway.httpNodePort` set, the platform's synced
  `di-platform-gateway` policy admits its HTTP port from any source, with no peers, so NodePort traffic from
  outside the cluster arrives. Policies add up, so the default deny doesn't close it, and pods of other instances
  can reach the gateway pods too, as anyone can through the NodePort. With `httpNodePort: 0` the policy admits
  only the instance's platform and tenant namespaces (platform #457), so nothing outside the instance, an
  ingress controller included, reaches the gateway; a public `httpEndpoint` then needs a NodePort.
- **Other in-cluster clients of the vCluster API.** Only the operator's namespace is admitted to port 8443.
  Anything else in the cluster that uses an instance kubeconfig must run in that namespace or use
  `kubectl port-forward`, which goes through the kubelet and the container runtime into the pod and so isn't
  subject to NetworkPolicy (the proxy certificate names `127.0.0.1` and `localhost` for it). That covers the
  instance's kubeconfig Secret and the tenant kubeconfigs the platform exports, which carry the same
  in-cluster `https://vcluster.<host namespace>.svc:443` server. Host-level scrapers in other namespaces
  (Prometheus or ServiceMonitors for NATS, CoreDNS `:9153` and the like) are blocked too.
- **Traffic from the node itself.** Traffic that originates on the node (kubelet probes, a client on the
  node) is admitted by kube-router's local-node rule. NodePort traffic from outside keeps its source address
  (the NAT happens after the policy check) and is admitted only by a rule with no peers, such as the
  gateway's.

## Destructive operations

vCluster (0.37.3) sets the `ownerReferences` of **every object it syncs into the host namespace** to the
instance's `service/vcluster`: the synced pods, Services, ConfigMaps, Secrets (the platform's
`wasmcloud-*-tls` among them), NetworkPolicies and its own kubeconfig Secret `vc-vcluster`. Deleting that
Service makes the garbage collector delete all of them, vCluster then deletes the virtual copies of the
Secrets and ConfigMaps, and `vc-vcluster` is only written again when the syncer restarts (#466).

The way to remove `service/vcluster` is to delete the PlatformInstance (or, for an instance whose operator
is gone, its host namespace). Don't delete the Service on its own.

### The admission policy

The operator installs a cluster-scoped `ValidatingAdmissionPolicy` and binding,
`platform-operator-protect-vcluster-service` (`admissionregistration.k8s.io/v1`, Kubernetes 1.30 or later;
verified on KubeSolo v1.2.0, which ships Kubernetes v1.35.7 and serves it, with the operator's ServiceAccount
`platform-operator`),
that denies `DELETE` of a Service named `vcluster` in a namespace labelled
`platform.di-framework.dev/host-namespace=true`. The operator labels every host namespace it creates, and
labels an existing one on its next reconcile. The delete is allowed for the operator's own user (looked up at
start with a `SelfSubjectReview` and logged; `helm uninstall` runs as it when a PlatformInstance is deleted)
and while the namespace is terminating (the namespace controller removing its contents).

A deleted or edited policy or binding comes back on the instance's next reconcile (a target poll, a watch
event or the next repair), not immediately; until then the Service is unprotected. On an API server without
admission policies the operator logs it, emits a `Warning` Event `AdmissionPolicyUnavailable` on each
PlatformInstance, sets `OwnerServiceProtected=False/AdmissionPolicyUnavailable` and carries on; otherwise
`OwnerServiceProtected` is `True`.

The policy and binding are created by the operator, not by its chart, so `helm uninstall` of the operator
leaves them. Remove them by hand once no instance is left:

```sh
kubectl delete validatingadmissionpolicybinding platform-operator-protect-vcluster-service
kubectl delete validatingadmissionpolicy platform-operator-protect-vcluster-service
```

### Resync when the policy was bypassed

The operator records the Service's uid in `status.target.serviceUID` at the first install. When the uid
differs on a later reconcile, or `vc-vcluster` is missing on an instance that had it, the operator:

1. re-applies the Helm release if the Service is gone (#453), and in the same round
2. deletes `vcluster-0`, which its StatefulSet recreates, so the syncer writes `vc-vcluster` again and syncs
   back the virtual objects that still exist (`TargetReady=False/Resyncing`, or `KubeconfigMissing` for the
   round that starts it; `status.target.resyncServiceUID` and `resyncStarted` describe the running resync);
3. waits for the control plane, the Secret and the API, then runs the platform install at once (not at the
   next repair). First it runs `helm uninstall` inside the instance on the platform's Helm Release (the
   runtime-operator chart; name and namespace, `wasmcloud`, read from the install state; a release already
   gone is fine). Its Helm record lives inside the instance and survived, so without that a refresh finds
   it and `up` has nothing to do, and a Pulumi replace creates before it deletes, which Helm refuses for
   the same release name. Then a refresh drops the Release from the state and `up` installs the chart
   again, which recreates the chart-rendered `wasmcloud-*-tls` Secrets; the other Pulumi-managed objects
   come back through the refresh. A failed install keeps the resync pending and is retried: the retry finds
   the Release already gone from the state (the earlier refresh dropped it), skips the uninstall and runs
   the refresh and `up` again. An `up` that leaves no such Release in the state is an error. Helm's
   uninstall doesn't wait for the old release's objects to be gone before the `up` installs the chart again;
   Layer 4 (gate 4.10) checks that the reinstall comes up cleanly.

A resync still waiting (for the control plane, the Secret or the API) more than three repair intervals
after it started, measured from `status.target.resyncStarted`, is reported as
`TargetReady=False/TargetUnreachable`, naming the stage it is waiting at.

An unchanged uid changes nothing.

#### What a resync doesn't bring back

A resync restores what the platform installs: the vCluster release, the platform's Helm Release and the
objects its Pulumi program manages. The platform's own controllers also write some synced objects again on
their next pass (the tenancy controller reissues `tenant-controller-tls` from its CA, for example). Every other
ConfigMap and Secret inside the instance that vCluster synced to the host was garbage-collected with its host
copy, and vCluster deleted the virtual copy too, so it is gone in both places and nothing outside the platform
creates it again. vCluster (0.37.3, as the operator installs it) syncs only the ConfigMaps and Secrets a pod
uses (`sync.toHost.configMaps.all` and `secrets.all` are `false`), so only those are lost; one no pod uses
isn't affected:

- **ConfigMaps and Secrets that pods use and that you or your tenants created inside the instance**, with `kubectl` against an
  instance or tenant kubeconfig, with your own Helm charts or manifests, or by any controller other than the
  platform. Pods that mount one stay in `ContainerCreating` (`MountVolume.SetUp failed … configmap … not
  found`) until it is applied again, and whatever depends on those pods stays down with them. Layer 4 run 4
  (v6.0.22) saw this with an OIDC issuer that ran inside the instance: its ConfigMap was gone after every
  owner-Service resync, the issuer pod never started, and tenant-console, which waits for OIDC discovery of
  `tenantAuth.issuer`, kept restarting until the ConfigMap was applied again.
- **Secrets that a component inside the instance generated at runtime and that a pod mounts** (a workload's
  own keys or credentials, for example). They aren't in any chart or Pulumi program: they are lost for good,
  and whatever they protected (issued tokens, sessions) has to be issued again.

So:

- Keep what the platform depends on outside the instance: run the OIDC issuer named by `tenantAuth.issuer`
  (and any other service the platform or your tenants need) in the host cluster or elsewhere, not inside the
  instance. The tenant-auth OAuth client secret is safe: the operator reads it from `clientSecretRef` in the
  PlatformInstance's namespace and the Pulumi program writes the copy, `platform-operator-tenant-auth`, again.
- Keep the manifests for anything you create inside an instance, and apply them again once the resync is
  done (`Ready=True`, with `Installed` at reason `Resync`).

Deleting only `vc-vcluster` (`KubeconfigMissing`) restarts the syncer without touching `service/vcluster`, so
nothing is garbage-collected and nothing else is lost. The admission policy above makes the owner-Service
path a bypass-only one; this section describes what happens when it is bypassed.

## Running it

The image (`Dockerfile`) carries the operator, Node.js, npm and the Pulumi CLI, for linux/amd64 and
linux/arm64. `.github/workflows/platform-operator-image.yml` publishes it from main and opens a PR that pins
this reference and the chart's `image.digest` (`chart/values.yaml`) to the new digest:

```text
ghcr.io/di-framework/platform-operator@sha256:d7ba6f1642cbdd18b9b23912b85f0f1e859924cf9b7b6b1a4c366fac3bba9e4d
```

Each publish is also tagged with its commit SHA and `src-<hash>` (the hash of its inputs); only the digest is
immutable. The image doesn't yet carry the pinned `@di-framework/platform` package or the Pulumi Kubernetes
provider plugin, so each instance's first install downloads both. Baking them in is tracked in #431.

The first publish creates the `platform-operator` GHCR package as private. An org admin must make it public
once (Package settings, then Change visibility), because Layer 4 (#274) pulls the image anonymously.

The operator needs:

- **cluster-admin.** The vCluster chart creates RBAC, workloads and Services in each instance namespace, and
  Helm needs every permission it grants. `config/rbac/role.yaml` lists what the controller itself uses;
  narrowing the chart's needs is follow-up work.
- **a host policy engine.** Instances run with `networkPolicyEngine: existing`, so the host cluster must enforce
  NetworkPolicy (see [Network policy engine](#network-policy-engine)).
- **egress to npm, the Pulumi plugin host and the platform's images**, since each install runs `npm install`
  and fetches the Pulumi Kubernetes provider plugin.
- **its own namespace**, which every instance host namespace admits to the vCluster API (see
  [Host-namespace isolation](#host-namespace-isolation)): read from its service account, or
  `--cleanup-namespace` when run outside a cluster.
- **a namespace that admits a `hostPath` pod** for the storage cleanup Job: `--cleanup-namespace`, which
  defaults to the operator's own namespace (read from its service account). Run outside a cluster, set it.

The operator caches only the Secrets it labels (`app.kubernetes.io/managed-by: platform-operator`, its
instances' kubeconfig Secrets) and reads other Secrets, Services and its cleanup Jobs straight from the API
server, so it never holds the cluster's Helm release Secrets in memory.

Two consequences of `tenantAuth.clientSecretRef`:

- **Who can make the operator read a Secret.** Anyone who may create or edit a PlatformInstance in a namespace
  can have the operator read any key of any Secret in that namespace and copy it into the instance. The
  reference is limited to the instance's own namespace for that reason; grant PlatformInstance write access
  only to those who may read that namespace's Secrets.
- **The value on the command line.** The Pulumi Automation API sets secret config with
  `pulumi config set-all --secret`, so the client secret is on that command's argv, visible in the operator
  container's `/proc` while it runs. It never reaches the CR, its status, events or the operator log.

```sh
make generate   # DeepCopy, CRD and ClusterRole from the markers
make test
make build
```

The Helm chart is in [`chart/`](chart/README.md). The Headlamp plugin
([`headlamp-plugin/`](headlamp-plugin/README.md)) is released with the platform: each release attaches
its tarball to the GitHub release and lists it on Artifact Hub, and the chart's Headlamp plugin manager
installs it from there (#435). The Layer 4 proof is tracked separately in the platform operator epic.
