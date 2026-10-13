# `@di-framework/backup-destination`

Helm chart and operator for backing up wasmCloud tenant backing services. Install it with Pulumi's Helm release provider into a tenant namespace the platform controller has created (`di-tenant-<name>`). The release sets `createNamespace: false`. It does not create that namespace or `di-runtime-<name>`.

`installBackupDestination` is the install. `prototype/` is a stack that points at a `di-framework-kube` kubeconfig, declares the tenant through `createPlatform`, and installs RustFS plus this chart with `kubernetes.helm.v3.Release`.

```sh
bun platform/backup-destination/scripts/prototype.ts
```

The operator pod serves an HTML console on `di-backup-console:8080` and creates backup-agent Jobs in `di-runtime-<name>`. The console can start a backup or request a restore into an empty BackingService. It does not show Secret values.

`existingSecret` selects a Secret you create. `accessKeyId` and `secretAccessKey` render Secret `di-backup-s3` and are only for a private demo; those values stay in Helm release history.

## Destinations

`type` picks where backups go: `s3` (the default), `pvc`, or `both`. Each destination is its own `BackupDestination` with its own status; the chart gives them the same `schedule` and retention. With `both`, `default` is the S3 destination and `pvc` the claim. Agent Jobs run one at a time across all destinations. Every destination writes the same layout: `<prefix>/<service>/<uid>/<UTC stamp>/` with the data and `manifest.json` (the sha256 is in the manifest and the Backup status), and retention deletes from either kind the same way. A restore reads from the destination that holds the source backup.

### S3

Configure `bucket` plus `existingSecret`, or the demo credentials above. The operator copies the keys into Secret `di-backup-destination` in `di-runtime-<name>`, so a tenant can have only one S3 destination.

### PVC

Set `existingClaimName` to a claim that already exists in `di-runtime-<name>` (agent Jobs run there and a pod can only mount a claim in its own namespace), or `volumeClaimTemplate.size` (and optionally `storageClassName`) for the chart to create claim `di-backup-pvc` there. The chart creates that claim with `helm.sh/resource-policy: keep`, so uninstalling the release leaves the claim and its backups in place; delete it yourself when you no longer need them. A PVC destination needs no credentials and no egress.

**A PVC on the same node or VM as the data does not protect against losing that node.** With a node-local storage class such as `local-path`, the backups live on the same disk as the BackingService data. Use it for fast local restores, and add an S3 destination (`type: both`) for an off-host copy.

A missing claim is detected early: the operator lists claims in `di-runtime-<name>` and sets the PVC destination to `ClaimMissing` without starting a Job, so a misspelled `existingClaimName` cannot hold up S3 backups. `prefix` must not contain `.` or `..` segments (the CRD rejects it) and is at most 1024 characters. A leading `/` is still accepted and ignored. Retention deletes single files and removes the emptied stamp, UID, and service directories. It also removes `*.partial` files and manifest-less data files older than a day, which a killed Job leaves behind. That sweep stays inside `<mount>/<prefix>` at `<service>/<uid>/<stamp>/` depth, never follows symlinks, and skips `lost+found`. It runs only when retention has something to delete, so a claim that fills with leftovers before then is reclaimed on the next retention pass.

## Upgrading

Helm and Pulumi install `chart/crds/` on first install only and never upgrade it, and the CRD is cluster scoped and shared by every tenant release. Before upgrading an existing cluster to this chart, apply the CRD yourself:

```sh
kubectl apply --server-side -f platform/backup-destination/chart/crds/backups.yaml
```

Without it the old schema rejects `type` and `existingClaimName` and still requires `bucket`; S3-only releases keep working. Existing destinations read back as `type: s3`.

A `BackupDestination`'s `type` is immutable. The S3 destination is always named `default` and the PVC destination always `pvc`, so a release can move from `type: s3` to `type: both` (adds `pvc`) without touching `default`. Moving from `s3` to `pvc` only: go through `both` first. If you then drop S3 (`type: pvc`), Helm deletes `default`; its existing Backups keep their `destinationName` and fall back to the first remaining destination, which does not hold their data, so keep `both` while those backups matter. A tenant can have only one S3 destination; if more exist, the oldest by creation time holds the runtime credentials and the others report `ConfigInvalid`. The operator needs `list` on `persistentvolumeclaims` in `di-runtime-<name>` (in the chart's runtime Role) for the claim check.

The packages stay private. Image tags `di-framework/backup-destination:dev` and `di-framework/backup-agent:dev` are imported into Kubesolo (`imagePullPolicy: Never`), not published to GHCR.
