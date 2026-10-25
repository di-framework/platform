# platform-operator chart

Installs the [platform operator](../README.md): the `PlatformInstance` CRD, the operator Deployment and
its RBAC, the operator's Pulumi state claim and passphrase Secret, and optionally Headlamp.

```sh
helm install platform-operator oci://ghcr.io/di-framework/charts/platform-operator \
  --version <release> --namespace platform-operator --create-namespace
```

Every `v*` release publishes the chart at the release's version (the Release workflow's `chart` job).
The chart's own `version` and `appVersion` in `Chart.yaml` are placeholders that packaging replaces.

## Permissions: cluster-admin

The chart binds two ClusterRoles to the operator's ServiceAccount:

- `platform-operator`, generated from `config/rbac/role.yaml`: what the controller itself uses.
- **`cluster-admin`, required in v1alpha1.** The operator installs the vCluster chart with Helm in each
  instance's host namespace, and that chart creates RBAC, workloads and Services. Kubernetes only lets
  Helm grant permissions it already holds, so the operator needs every permission the vCluster chart
  grants. Narrowing this is follow-up work.

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

The CRD sits in `templates/` rather than `crds/` so `helm upgrade` upgrades it: Helm never upgrades
CRDs in `crds/`. `make generate` in `platform/operator` writes `templates/crd.yaml` and
`templates/clusterrole.yaml` from `config/`, and `make check` fails when they drift.

## Values

| Value | Default | Flag |
| --- | --- | --- |
| `image.repository` | `ghcr.io/di-framework/platform-operator` | |
| `image.digest` | placeholder until the image pin PR (#271) sets it | |
| `replicaCount` | `1` | |
| `leaderElect` | `true` | `--leader-elect` |
| `storageRootBase` | `/var/lib/kubesolo/instances` | `--storage-root-base` |
| `installTimeout` | `30m` | `--install-timeout` |
| `repairInterval` | `30m` | `--repair-interval` |
| `targetPoll` | `10s` | `--target-poll` |
| `maxConcurrentInstalls` | `2` | `--max-concurrent-installs` |
| `cleanupNamespace` | empty: the release namespace | `--cleanup-namespace` (only when set) |
| `extraArgs` | `[]` | any other flag, such as `--zap-log-level=debug` |
| `state.size`, `state.storageClassName`, `state.existingClaim` | `10Gi`, default class, none | `--state-dir` |
| `passphrase.existingSecret` | none (generated) | `--passphrase-file` |
| `resources` | 100m / 256Mi requests, 2Gi memory limit | |
| `headlamp.enabled` | `false` | |

The image is always pulled by digest. The vCluster chart version, its values and the platform version
are not chart values: the operator embeds the digest-checked vCluster chart and its KubeSolo defaults,
and each `PlatformInstance` names its own `spec.version`.

The pod runs as the image's `node` user (uid 1000) with a read-only root filesystem; `/home/node` (npm's
cache and Pulumi's plugins) and `/tmp` are emptyDirs.

## Headlamp

`headlamp.enabled=true` installs the upstream Headlamp chart (0.46.0, vendored in `charts/` and recorded
in `Chart.lock`); everything under `headlamp` is passed to it. Upstream binds Headlamp's own
ServiceAccount to `cluster-admin` by default (`headlamp.clusterRoleBinding`); users still sign in with
their own token unless `headlamp.config.unsafeUseServiceAccountToken` is set.

The PlatformInstance plugin (#273) is installed through Headlamp's plugin manager sidecar. Until it is
published, `headlamp.pluginsManager` is a documented stub in `values.yaml`.
