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

## How it reconciles

1. **Finalizer.** Added before anything is created, so a delete never orphans a cluster.
2. **Target.** Creates the host namespace `pi-<namespace>-<name>-<hash>` (the hash of `<namespace>/<name>`
   keeps `team-a/one` and `team/a-one` apart; dots become dashes and long names are cut to fit), annotated
   `platform.di-framework.dev/instance: <namespace>/<name>`. The operator refuses to install into a namespace
   whose annotation names anyone else, and on delete leaves such a namespace alone and releases the
   finalizer. It installs vCluster from the embedded, digest-checked
   chart (0.37.3), then waits for its control plane and kubeconfig Secret. A release left `failed` or
   `pending-install` (an install that errored or was interrupted) is removed and installed again, with
   backoff, so an install that fails every time doesn't cycle every poll. The
   kubeconfig is rewritten to the in-cluster Service address and stored in the instance's Secret.
3. **Install.** On first install, a version change, any spec change or a retry after a failed install (which
   refreshes first), it writes a Pulumi project for the
   instance (`package.json` pinning `@di-framework/platform@<version>`, an `index.ts` re-exporting the
   existing entrypoint), sets the config and runs `up`. One install or repair is cancelled after
   `--install-timeout` (30 minutes by default) and retried, so a hung run doesn't hold a worker.
4. **Repair.** Every `--repair-interval` (30 minutes by default) a Ready instance gets `refresh` then `up`,
   which puts back hand-deleted or edited resources. Between repairs, an installed instance whose target
   answers again after a blip goes straight back to `Ready`.
5. **Delete.** `Delete` uninstalls the vCluster and deletes its host namespace (and so the vCluster's data
   volume and everything the platform installed), drops the instance's install state without a `destroy`,
   then releases the finalizer. **Tenant data under `storageRoot` (the platform's registry and tenant
   volumes, node `hostPath`s) stays on the node**, and a new PlatformInstance with the same namespace and name
   gets the same default `storageRoot` and finds it. Remove `<storage-root-base>/<namespace>/<name>` by hand
   when that data must go; an operator-run cleanup is follow-up work. `Retain` releases the finalizer and
   leaves the vCluster, its data and the install state, so a new PlatformInstance with the same name and
   namespace picks them up again.

`spec.target` and `spec.platform.storageRoot` can't change after creation, and names are at most 63
characters.

Status carries `phase` (`Provisioning`, `Installing`, `Ready`, `Failed`, `Deleting`) and the `TargetReady`,
`Installed` and `Ready` conditions, each with a readable reason and message.

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

## Running it

The image (`Dockerfile`) carries the operator, Node.js, npm and the Pulumi CLI, for linux/amd64 and
linux/arm64. `.github/workflows/platform-operator-image.yml` publishes it from main and opens a PR that pins
this reference to the new digest:

```text
ghcr.io/di-framework/platform-operator@sha256:<pending first publish>
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

The operator caches only the Secrets it labels (`app.kubernetes.io/managed-by: platform-operator`, its
instances' kubeconfig Secrets) and reads other Secrets and Services straight from the API server, so it never
holds the cluster's Helm release Secrets in memory.

```sh
make generate   # DeepCopy, CRD and ClusterRole from the markers
make test
make build
```

Packaging (Helm chart, Headlamp plugin) and the Layer 4 proof are tracked separately in
the platform operator epic.
