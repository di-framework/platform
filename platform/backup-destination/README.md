# `@di-framework/backup-destination`

Helm chart and operator for backing up wasmCloud tenant backing services and workload volumes. Install it with Pulumi's Helm release provider into a tenant namespace the platform controller has created (`di-tenant-<name>`). The release sets `createNamespace: false`. It does not create that namespace or `di-runtime-<name>`.

`installBackupDestination` is the install. `prototype/` is a stack that points at a `di-framework-kube` kubeconfig, declares the tenant through `createPlatform`, and installs RustFS plus this chart with `kubernetes.helm.v3.Release`.

```sh
bun platform/backup-destination/scripts/prototype.ts
```

The operator pod serves an HTML console on `di-backup-console:8080` and creates backup-agent Jobs in `di-runtime-<name>`. The console can start a backup or request a restore into an empty BackingService. It does not show Secret values.

`existingSecret` selects a Secret you create. `accessKeyId` and `secretAccessKey` render Secret `di-backup-s3` and are only for a private demo; those values stay in Helm release history.

## Destinations

`type` picks where backups go: `s3` (the default), `pvc`, or `both`. Each destination is its own `BackupDestination` with its own status; they share retention. `schedule` applies to an S3 destination (default `0 2 * * *`) and to a PVC destination only when set; a PVC destination without a schedule never runs scheduled backups and only takes on-demand ones (backup-now annotation). With `both`, `default` is the S3 destination and `pvc` the claim. Agent Jobs run one at a time across all destinations. Every destination writes the same layout: `<prefix>/<service>/<uid>/<UTC stamp>/` with the data and `manifest.json` (the sha256 is in the manifest and the Backup status), and retention deletes from either kind the same way. A restore reads from the destination that holds the source backup.

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

## Workload volumes

A WorkloadDeployment with platform storage (`di-framework.dev/persistent-storage: "true"`) keeps its state in `<storageRoot>/di-tenants/<tenant uid>/workloads/<key>` on the node that runs the tenant host. An example is the encrypted pglite identity guest. List it as a `workload-volume` source on a destination to back that directory up:

```yaml
sources:
  - workloadName: identity
    schedule: "30 3 * * *"   # UTC cron; omit for on-demand backups only
    retention:               # omit to keep every backup
      keepLast: 7
      daily: 7
      weekly: 4
      monthly: 6
      failed: 5
    destination: pvc         # s3 or pvc; required only with type: both
```

The chart renders each entry into `BackupDestination.spec.sources`. Set `storageRoot` to the platform's storage root (the chart default `/var/lib/kubesolo` matches Kubesolo).

**There is no default schedule and no default retention.**
- **Schedule.** A source without `schedule` is never backed up on a schedule. "Back up now" on the console, or a `Backup` you create, still works. A schedule seen for the first time starts counting from that moment: it never fires for a time before it was set. A run missed while the destination was suspended or busy happens once, when it can.
- **Retention.** A source without a rule keeps every backup.
  - **Successful backups.** A backup is kept when any rule keeps it: it is one of the newest `keepLast`, or it is the newest backup of one of the newest `daily` UTC days, `weekly` ISO weeks or `monthly` UTC months that have a backup. As soon as one of these four rules is set, every successful backup no rule keeps is deleted, objects included.
  - **Failed attempts.** `failed` keeps that many of the newest failed attempts and deletes the older records.
  - **Retention never deletes a backup a restore is reading.** Removing a source from the list deletes none of its backups.
  - BackingService dumps keep their own `retentionSuccessful` and never touch workload-volume backups.

### A cold copy

1. The operator records `spec.replicas` of every WorkloadDeployment that shares the volume (members sharing `di-framework.dev/workload`) in the Backup's `status.volume`. Then it scales them to 0 through the `scale` subresource.
2. It waits until none of them has a `Workload` left, for up to `scaleDownTimeoutSeconds` (default 300).
3. It runs a Job on the node whose tenant host mounts that exact path. The Job is pinned with node affinity and mounts the directory read-only. It runs as root with only `DAC_READ_SEARCH`, so it can read the host uid's files.
4. The agent records every regular file's sha256, size and mode. It refuses links and devices. It writes `data.tar`, `SHA256SUMS` and `manifest.json` (written last) under `<prefix>/workload-volumes/<name>/<uid>/<UTC stamp>/` on the S3 or PVC destination.
   - The manifest holds the UTC stamp, the image and its digest (when the image is pinned by digest), the file and directory counts, and the bytes.
   - When the volume has a `.di-encfs` marker, the manifest also holds the encfs KCV: bytes 8..24 of the marker, as hex.
   - If anything in the volume changed during the copy, the backup fails with `SourceChanged`.
   - Ciphertext is copied as stored. Nothing is decrypted, and no Secret is read.
5. The operator gives every recorded WorkloadDeployment its replicas back on success, on failure, on a scale-down timeout, on a copy timeout (`copyTimeoutSeconds`, default 3600), when the Job disappears, and when the destination is suspended or deleted. The terminal status is written only after the replicas are back. Every step is in status, so an operator restart carries on where it stopped.

The workload is down from the scale-down to the scale-up. `Backup.status.volume.scaleDownSeconds`, `BackupDestination.status.sources[].lastScaleDownSeconds` and the console show how long that was.

### Restore

Create a `BackupRestore` with `targetWorkloadName` (the console has a form). The operator scales the target and its members to 0, waits, and runs a Job pinned to the target's node. That Job mounts the tenant's `workloads` directory read-write, with `CHOWN`, `DAC_OVERRIDE` and `FOWNER`. The agent:
- refuses a non-empty target unless `force: true`. With `force`, the old entries move to `<key>.replaced-<stamp>` next to it. The entries move, not the directory, because the tenant host has the directory itself mounted;
- extracts into a staging directory next to the target;
- checks that `SHA256SUMS` matches the manifest, that every file and directory matches it (nothing missing, nothing extra), and every sha256;
- checks that the restored marker's KCV equals the manifest's;
- with `expectedKcv`, also requires that value. Restoring over data whose marker carries a different KCV is refused unless `expectedKcv` names the backup's KCV;
- moves the files into place and hands them to uid 65532.

Then the replicas come back, whatever the outcome.

### Permissions

The operator's Role in `di-tenant-<name>` adds:
- `get`/`list` on `workloaddeployments`, `workloadreplicasets` and `workloads`;
- `get`/`patch` on `workloaddeployments/scale` only.

In `di-runtime-<name>` it adds `get` on the one Deployment `hostgroup-tenant-<name>`, whose owner-uid label names the tenant directory. There is no ClusterRole. The operator reads only the S3 credentials Secret its destination names; it no longer lists Secrets.

**Limits.**
- The copy is cold: the workload is unavailable while it runs.
- With a node-local PVC destination, the claim must be usable on the workload's node; with `local-path` that is the same node. Otherwise the Job never schedules and fails with `CopyTimeout`, and the replicas come back.
- Live copies need a pglite/encfs snapshot API and are out of scope.

The packages stay private. Image tags `di-framework/backup-destination:dev` and `di-framework/backup-agent:dev` are imported into Kubesolo (`imagePullPolicy: Never`), not published to GHCR.
