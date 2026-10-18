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
  deletionPolicy: Delete   # or Retain
```

`kubectl get pi -A` shows the requested and installed versions and the phase. The instance's admin
kubeconfig is in the Secret named by `status.kubeconfigSecretRef` (`<name>-kubeconfig`, key `kubeconfig`).

## How it reconciles

1. **Finalizer.** Added before anything is created, so a delete never orphans a cluster.
2. **Target.** Installs vCluster from the embedded, digest-checked chart (0.37.3) into the host namespace
   `pi-<namespace>-<name>`, then waits for its control plane and kubeconfig Secret. The kubeconfig is rewritten
   to the in-cluster Service address and stored in the instance's Secret.
3. **Install.** On first install, a version change or any spec change, it writes a Pulumi project for the
   instance (`package.json` pinning `@di-framework/platform@<version>`, an `index.ts` re-exporting the
   existing entrypoint), sets the config and runs `up`.
4. **Repair.** Every `--repair-interval` (30 minutes by default) a Ready instance gets `refresh` then `up`,
   which puts back hand-deleted or edited resources.
5. **Delete.** `Delete` destroys the platform install, uninstalls the vCluster and deletes its host namespace
   (and so its data volume), then releases the finalizer. `Retain` releases the finalizer and leaves the
   vCluster, its data and the install state, so a new PlatformInstance with the same name and namespace picks
   them up again.

Status carries `phase` (`Provisioning`, `Installing`, `Ready`, `Failed`, `Deleting`) and the `TargetReady`,
`Installed` and `Ready` conditions, each with a readable reason and message.

### One install per instance

controller-runtime never reconciles the same key twice at once, and leader election (on by default) runs one
operator. So an instance has at most one Pulumi operation in flight, and a lock found on its stack was left by
a crashed operator. The installer then cancels it (or, where the file backend can't cancel, removes the stack's
lock files), refreshes, and retries the update once.

### State

`--state-dir` (the operator's PVC) holds, per instance, `<namespace>.<name>/project` (the Pulumi project and
its `node_modules`) and `<namespace>.<name>/state` (a file backend of its own, so locks never cross instances).
Losing the volume means Pulumi forgets what it installed: back it up. `--passphrase-file` encrypts the state's
secrets; keep it in a Secret.

## vCluster instance defaults

`internal/target/vcluster/defaults.go` holds the chart values every instance gets. They are the values the
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

The image (`Dockerfile`) carries the operator, Node.js, npm and the Pulumi CLI. It needs:

- **cluster-admin.** The vCluster chart creates RBAC, workloads and Services in each instance namespace, and
  Helm needs every permission it grants. `config/rbac/role.yaml` lists what the controller itself uses;
  narrowing the chart's needs is follow-up work.
- **a host policy engine.** Instances run with `networkPolicyEngine: existing`, so the host cluster must enforce
  NetworkPolicy.
- **egress to npm and the platform's images**, since each install runs `npm install`.

```sh
make generate   # DeepCopy, CRD and ClusterRole from the markers
make test
make build
```

Packaging (image publish and pin, Helm chart, Headlamp plugin) and the Layer 4 proof are tracked separately in
the platform operator epic.
