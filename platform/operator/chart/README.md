# platform-operator chart

Installs the [platform operator](../README.md): the `PlatformInstance` CRD, the operator Deployment and
its RBAC, the operator's Pulumi state claim and passphrase Secret, and optionally Headlamp.

```sh
helm install platform-operator oci://ghcr.io/di-framework/charts/platform-operator \
  --version <release> --namespace platform-operator --create-namespace
```

The chart installs once per cluster: the `PlatformInstance` CRD is cluster-scoped and the generated
ClusterRole is always named `platform-operator`, whatever the release name.

## The passphrase, and `helm template`, Argo CD and GitOps

The passphrase Secret encrypts the secrets in the operator's Pulumi state. If it ever changes, every
existing instance's state becomes unreadable at the operator's next restart, permanently.

- **`passphrase.existingSecret` set:** the chart creates no Secret and mounts that one (key
  `passphrase`). This is required whenever the chart is rendered without a cluster: `helm template`,
  client-side `helm install/upgrade --dry-run`, Argo CD (which always renders with `helm template`),
  and other GitOps tools.

  ```sh
  kubectl -n platform-operator create secret generic platform-operator-passphrase \
    --from-literal=passphrase="$(openssl rand -base64 36)"
  helm template platform-operator <chart> -n platform-operator \
    --set passphrase.existingSecret=platform-operator-passphrase
  ```

- **`passphrase.existingSecret` empty (the default):** the chart reads the cluster with `lookup`. When
  its Secret exists, the passphrase is reused unchanged; one is generated only on a first install,
  when neither the Secret nor the state claim exists. If the state claim exists but the Secret is
  gone, or the Secret has no `passphrase` key, the render fails: restore the Secret, or set
  `passphrase.existingSecret` to one holding the original passphrase. A render
  that cannot see the cluster (an empty lookup of the `kube-system` namespace) **fails** with a message
  pointing here, instead of generating a fresh passphrase that would overwrite the live one when
  applied. `helm install`, `helm upgrade` and `--dry-run=server` see the cluster and work.

- **`state.existingClaim` requires `passphrase.existingSecret`.** The chart can't know the passphrase of
  state in a claim it didn't create, and can't tell an empty claim from a used one, so it refuses to
  render a claim of yours without a Secret of yours. For an empty claim, create the Secret with a new
  passphrase as above; for a claim with state, use the original passphrase.

Every `v*` release publishes the chart at the release's version (the Release workflow's `chart` job).
The chart's own `version` and `appVersion` in `Chart.yaml` are placeholders that packaging replaces.

## Permissions: cluster-admin

The chart binds two ClusterRoles to the operator's ServiceAccount:

- `platform-operator`, generated from `config/rbac/role.yaml`: what the controller itself uses.
- **`cluster-admin`, required in v1alpha1** (`rbac.clusterAdmin: true`, the default). The operator installs the vCluster chart with Helm in each
  instance's host namespace, and that chart creates RBAC, workloads and Services. Kubernetes only lets
  Helm grant permissions it already holds, so the operator needs every permission the vCluster chart
  grants. Narrowing this is follow-up work. Set `rbac.clusterAdmin=false` only when you bind the
  operator's ServiceAccount to an equivalent role yourself.

Install the chart only on a cluster where a cluster-admin operator is acceptable. Instance owners are
trusted in v1alpha1 (see the epic).

## Pod Security: the release namespace must allow hostPath

When an instance with `deletionPolicy: Delete` is deleted, the operator removes its default
`storageRoot` with a Job that mounts `storageRootBase` from the node through `hostPath` (#426). The Job
runs in the operator's own namespace (the release namespace, read from the pod) unless
`cleanupNamespace` names another, so Pod Security admission must allow privileged pods there:

```sh
kubectl label namespace platform-operator pod-security.kubernetes.io/enforce=privileged --overwrite
```

## What `helm uninstall` leaves

`helm uninstall` removes the Deployment, the ServiceAccount and the RBAC. It keeps, through
`helm.sh/resource-policy: keep`:

- the `PlatformInstance` CRD, and so every instance (deleting the CRD would delete them all);
- the state claim `<fullname>-state` (Pulumi's record of what each instance has installed);
- the passphrase Secret `<fullname>-passphrase`, which encrypts the secrets in that state.

`<fullname>` is the release name when it contains `platform-operator` (so `platform-operator-state`
for the install above), else `<release>-platform-operator`.

Install again with the same release name and namespace and the chart adopts all three; the passphrase is
reused, never regenerated (`lookup`). To remove them, delete them by hand after deleting the instances
you no longer want.

Every `PlatformInstance` carries the `platform.di-framework.dev/instance` finalizer, which only the
operator removes. While the operator is uninstalled, deleting an instance (or the CRD) hangs until the
operator is installed again; delete instances before uninstalling if you mean to remove them.

The CRD sits in `templates/` rather than `crds/` so `helm upgrade` upgrades it: Helm never upgrades
CRDs in `crds/`. `make generate` in `platform/operator` writes `templates/crd.yaml` and
`templates/clusterrole.yaml` from `config/`, and `make check` fails when they drift.

## Values

| Value | Default | Flag |
| --- | --- | --- |
| `image.repository` | `ghcr.io/di-framework/platform-operator` | |
| `image.digest` | placeholder until the image pin PR (#271) sets it; must match `sha256:<64 hex>` | |
| `replicaCount` | `1`; more than 1 requires `leaderElect` | |
| `leaderElect` | `true` | `--leader-elect` |
| `storageRootBase` | `/var/lib/kubesolo/instances` | `--storage-root-base` |
| `installTimeout` | `30m` | `--install-timeout` |
| `repairInterval` | `30m` | `--repair-interval` |
| `targetPoll` | `10s` | `--target-poll` |
| `maxConcurrentInstalls` | `2` | `--max-concurrent-installs` |
| `cleanupNamespace` | empty: the release namespace | `--cleanup-namespace` (only when set) |
| `extraArgs` | `[]` | any other flag, such as `--zap-log-level=debug` |
| `state.size`, `state.storageClassName` | `10Gi`, default class | `--state-dir` |
| `state.existingClaim` | none; requires `passphrase.existingSecret` | `--state-dir` |
| `passphrase.existingSecret` | none (generated; offline renders fail) | `--passphrase-file` |
| `rbac.clusterAdmin` | `true` | |
| `resources` | 100m / 256Mi / 1Gi ephemeral requests, 2Gi memory / 6Gi ephemeral limits | |
| `emptyDirSizeLimit.home`, `emptyDirSizeLimit.tmp` | `4Gi`, `1Gi` | |
| `headlamp.enabled` | `false` | |

The image is always pulled by digest. The vCluster chart version, its values and the platform version
are not chart values: the operator embeds the digest-checked vCluster chart and its KubeSolo defaults,
and each `PlatformInstance` names its own `spec.version`.

The pod runs as the image's `node` user (uid 1000) with a read-only root filesystem; `/home/node` (npm's
cache and Pulumi's plugins) and `/tmp` are size-limited emptyDirs.

The state claim is `ReadWriteOnce`. On a multi-node cluster a standby replica on another node stays in
`ContainerCreating` (Multi-Attach) rather than waiting on the leader-election Lease; keep one replica or
use a `ReadWriteMany` class.

## Headlamp

`headlamp.enabled=true` installs the upstream Headlamp chart (0.46.0, vendored in `charts/` and recorded
in `Chart.lock`); everything under `headlamp` is passed to it. Upstream binds Headlamp's own
ServiceAccount to `cluster-admin` by default (`headlamp.clusterRoleBinding`); users still sign in with
their own token unless `headlamp.config.unsafeUseServiceAccountToken` is set.

The PlatformInstance plugin (#273) is installed through Headlamp's plugin manager sidecar, which is on
by default (`headlamp.pluginsManager.enabled`) and takes effect once `headlamp.enabled=true`. Its
`configContent` names the plugin's Artifact Hub package
(<https://artifacthub.io/packages/headlamp/di-framework-platform/di-framework-platform>) at the plugin
version, which is the platform release version: each release PR rewrites that `version:` line (#435).
pluginctl downloads the tarball attached to the GitHub release and checks its sha256, so the sidecar
needs egress to npm, artifacthub.io and github.com. Its `pluginctl` version and its `node` base image
(by digest) are pinned rather than upstream's `latest` and `lts-alpine`.
