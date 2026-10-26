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
      httpNodePort: 0
      httpEndpoint: http://apps.example:30080   # public base URL; reported in status.endpoints.http
  deletionPolicy: Delete   # or Retain
```

`kubectl get pi -A` shows the requested and installed versions and the phase. The instance's admin
kubeconfig is in the Secret named by `status.kubeconfigSecretRef` (`<name>-kubeconfig`, key `kubeconfig`).

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
  version: 6.0.17
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
| `tenants[]` (`name`, `suspended`, `deletionPolicy`, `runtime.{replicas,coreInstances}`, `resources.{cpu,memory,workloads,backingServices,serviceBindings,apiKeys}`) | `tenants` | Always set (`[]` when empty). At most 32; names are unique, 1-40 lowercase letters, digits and hyphens, starting with a letter. |
| `users[]` (`name`, `suspended`, `memberships[].{tenant,role}`) | `users` | Always set (`[]` when empty). At most 256; each membership names an entry of `tenants`, once, as `developer` or `viewer`. |
| `tenantAuth.image`, `issuer`, `issuerUpstream`, `issuerUpstreamPodPort`, `issuerIp`, `consolePublicUrl`, `controllerPublicUrl`, `registry.{component,publicUrl,limits}` | `tenantAuth.<same>` | `image` and `registry.component` are pinned by digest. `issuer`, `clientId` and `clientSecretRef` go together. |
| `tenantAuth.clientId` | `tenantAuth.oauthClient.id` | |
| `tenantAuth.clientSecretRef.{name,key}` | `tenantAuth.oauthClient.secretName` | See below. |
| `tenantHostImage` | `tenantHostImage` | Empty uses the pinned exclusive host variant, `ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@sha256:...` (the PGlite exclusive-PGDATA workloads need it; the image pin PR moves it), not the platform's own default. Immutable after creation. |
| `tenantHostImagePullPolicy` | `tenantHostImagePullPolicy` | `Always`, `IfNotPresent` or `Never`; unset leaves the platform's default. |

**The client secret is never inline.** `clientSecretRef` names a Secret and key in the PlatformInstance's
namespace. On every install and repair the operator reads it and sets it as the encrypted stack config key
`tenantAuthClientSecret`; the instance's Pulumi program writes it to the Secret `platform-operator-tenant-auth`
(key `clientSecret`) in the platform namespace inside the instance, and `tenantAuth.oauthClient.secretName`
names that Secret. A missing Secret or key stops the install with `Installed=False`,
reason `TenantAuthSecretUnavailable`, and is retried with backoff. A changed Secret value is applied by the next
repair (the operator doesn't watch the Secret).

**Changes.** A change to `tenants`, `users` or `tenantAuth` is a spec change, so the next reconcile installs
(`Installed` reason `SpecChanged`) with the new config. Settings removed from the spec (`tenantAuth`,
`tenantHostImagePullPolicy`) are removed from the stack config too. A repair with an unchanged spec sets the
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
`Installed` and `Ready` conditions, each with a readable reason and message. While the target isn't ready,
`TargetReady` is `False` with `ControlPlanePending` (the vCluster StatefulSet isn't ready), `Repairing` (a
missing release object is being recreated), `RolledBack` (a failed or interrupted repair was rolled back),
`KubeconfigPending` (vCluster's kubeconfig Secret doesn't exist yet) or `TargetUnreachable` (the Secret
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
API or its kubelet port. The platform's own synced policies keep isolating its tenant namespaces as before.

What it doesn't:

- **Egress** is not restricted here; it stays as the platform's synced policies set it (DNS to the host's
  `kube-system/kube-dns` on 53 among it).
- **The HTTP gateway.** The platform's synced `di-platform-gateway` policy admits its HTTP port from any
  source, with no peers, so that `gateway.httpNodePort` traffic from outside the cluster arrives. Policies add
  up, so the default deny doesn't close it, and pods of other instances can reach the gateway pods too, as anyone
  can through the NodePort. The NodePort path itself needs no host-namespace rule.
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

## Running it

The image (`Dockerfile`) carries the operator, Node.js, npm and the Pulumi CLI, for linux/amd64 and
linux/arm64. `.github/workflows/platform-operator-image.yml` publishes it from main and opens a PR that pins
this reference and the chart's `image.digest` (`chart/values.yaml`) to the new digest:

```text
ghcr.io/di-framework/platform-operator@sha256:c4fccc01f5eab3c4d0b4b2878c55688ee3ec1f7e2c1a3be922cadf5e3ab69ecb
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
  NetworkPolicy.
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

```sh
make generate   # DeepCopy, CRD and ClusterRole from the markers
make test
make build
```

The Helm chart is in [`chart/`](chart/README.md). The Headlamp plugin
([`headlamp-plugin/`](headlamp-plugin/README.md)) is released with the platform: each release attaches
its tarball to the GitHub release and lists it on Artifact Hub, and the chart's Headlamp plugin manager
installs it from there (#435). The Layer 4 proof is tracked separately in the platform operator epic.
