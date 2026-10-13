# `@di-framework/backup-destination`

Helm chart and operator for backing up wasmCloud tenant backing services and workload volumes. Install it with Pulumi's Helm release provider into a tenant namespace the platform controller has created (`di-tenant-<name>`). The release sets `createNamespace: false`. It does not create that namespace or `di-runtime-<name>`.

`installBackupDestination` is the install. `prototype/` is a stack that points at a `di-framework-kube` kubeconfig, declares the tenant through `createPlatform`, and installs RustFS plus this chart with `kubernetes.helm.v3.Release`.

```sh
bun platform/backup-destination/scripts/prototype.ts
```

The operator pod serves an HTML console on `di-backup-console:8080` and creates backup-agent Jobs in `di-runtime-<name>`. The console can start a backup or request a restore into an empty BackingService. It does not show Secret values.

`existingSecret` selects a Secret you create. `accessKeyId` and `secretAccessKey` render Secret `di-backup-s3` and are only for a private demo; those values stay in Helm release history.

## Destinations

`type` picks where backups go: `s3` (the default), `pvc`, or `both`. Each destination is its own `BackupDestination` with its own status; they share retention. `schedule` is required and has no default; it applies to every destination the release renders. Set a five-field UTC cron (`0 2 * * *` is nightly at 02:00), or `none` to take only on-demand backups (console **Backup now** or the backup-now annotation). The chart refuses to render without it, and refuses anything else. A `BackupDestination` without a schedule (or with `none`) never runs scheduled backups: the operator sets condition `Scheduled=False`, reason `NoSchedule`, and logs it once. With a cron it sets `Scheduled=True`; a schedule the operator cannot parse (such as `60 * * * *`) sets `Scheduled=False`, reason `InvalidSchedule`, and never fires. The chart and `installBackupDestination` reject those too. With `both`, `default` is the S3 destination and `pvc` the claim. Agent Jobs run one at a time across all destinations. Every destination writes the same layout: `<prefix>/<service>/<uid>/<UTC stamp>/` with the data and `manifest.json` (the sha256 is in the manifest and the Backup status), and retention deletes from either kind the same way. A restore reads from the destination that holds the source backup.

### S3

Configure `bucket` plus `existingSecret`, or the demo credentials above. The operator copies the keys into Secret `di-backup-destination` in `di-runtime-<name>`, so a tenant can have only one S3 destination.

### PVC

Set `existingClaimName` to a claim that already exists in `di-runtime-<name>` (agent Jobs run there and a pod can only mount a claim in its own namespace), or `volumeClaimTemplate.size` (and optionally `storageClassName`) for the chart to create claim `di-backup-pvc` there. The chart creates that claim with `helm.sh/resource-policy: keep`, so uninstalling the release leaves the claim and its backups in place; delete it yourself when you no longer need them. A PVC destination needs no credentials and no egress.

**A PVC on the same node or VM as the data does not protect against losing that node.** With a node-local storage class such as `local-path`, the backups live on the same disk as the BackingService data. Use it for fast local restores, and add an S3 destination (`type: both`) for an off-host copy.

A missing claim is detected early: the operator lists claims in `di-runtime-<name>` and sets the PVC destination to `ClaimMissing` without starting a Job, so a misspelled `existingClaimName` cannot hold up S3 backups. `prefix` must not contain `.` or `..` segments (the CRD rejects it) and is at most 1024 characters. A leading `/` is still accepted and ignored. The prefix must keep at least one non-empty segment, for S3 too, so a new destination cannot write at the bucket root (`prefix: "/"`): leave `prefix` empty for the default `di-framework/<name>`, or name a segment such as `backups`. One rule for both kinds keeps retention and the PVC sweep inside a tree the destination owns. Retention deletes single files and removes the emptied stamp, UID, and service directories. It also removes `*.partial` files and manifest-less data files older than a day, which a killed Job leaves behind. That sweep stays inside `<mount>/<prefix>` at `<service>/<uid>/<stamp>/` depth, never follows symlinks, and skips `lost+found`. It runs only when retention has something to delete, so a claim that fills with leftovers before then is reclaimed on the next retention pass.

## Upgrading

Helm and Pulumi install `chart/crds/` on first install only and never upgrade it, and the CRD is cluster scoped and shared by every tenant release. Before upgrading an existing cluster to this chart, apply the CRD yourself:

```sh
kubectl apply --server-side -f platform/backup-destination/chart/crds/backups.yaml
```

Without it the old schema rejects `type` and `existingClaimName` and still requires `bucket`; S3-only releases keep working. Existing destinations read back as `type: s3`.

**Breaking (#250): `schedule` has no default.** Earlier charts rendered `schedule: "0 2 * * *"` for S3 when the value was unset, and the operator also fell back to it. Both fallbacks are gone, so `helm upgrade` of a release that never set `schedule` now fails with `schedule is required: ...` instead of silently stopping backups. Set it explicitly on upgrade:

```sh
# Keep the old nightly backups (what an unset schedule used to mean)
helm upgrade backups platform/backup-destination/chart -n di-tenant-<name> --reuse-values --set-string schedule='0 2 * * *'
# Or take only on-demand backups
helm upgrade backups platform/backup-destination/chart -n di-tenant-<name> --reuse-values --set-string schedule=none
```

With Pulumi, `installBackupDestination` now requires `install.schedule` (`'0 2 * * *'` or `'none'`). The same goes for every workload-volume source: each entry in `sources` needs its own `schedule` (a cron or `none`), and the CRD accepts `none` for both the destination and its sources. An existing `BackupDestination` object without `spec.schedule` (for example one applied by hand) stops taking scheduled backups after the operator upgrade and reports `Scheduled=False`, reason `NoSchedule`; list the destinations that are `NoSchedule` or `InvalidSchedule` with:

```sh
kubectl get backupdestinations -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {.status.conditions[?(@.type=="Scheduled")].reason}{"\n"}{end}' | grep -E 'NoSchedule|InvalidSchedule'
```

A `BackupDestination`'s `type` is immutable. The S3 destination is always named `default` and the PVC destination always `pvc`, so a release can move from `type: s3` to `type: both` (adds `pvc`) without touching `default`. Moving from `s3` to `pvc` only: go through `both` first. If you then drop S3 (`type: pvc`), Helm deletes `default`; its existing Backups keep their `destinationName` and fall back to the first remaining destination, which does not hold their data, so keep `both` while those backups matter. A tenant can have only one S3 destination; if more exist, the oldest by creation time holds the runtime credentials and the others report `ConfigInvalid`. The operator needs `list` on `persistentvolumeclaims` in `di-runtime-<name>` (in the chart's runtime Role) for the claim check.

## Workload volumes

A WorkloadDeployment with platform storage (`di-framework.dev/persistent-storage: "true"`) keeps its state in `<storageRoot>/di-tenants/<tenant uid>/workloads/<key>` on the node that runs the tenant host. An example is the encrypted pglite identity guest. List it as a `workload-volume` source on a destination to back that directory up:

```yaml
sources:
  - workloadName: identity
    schedule: "30 3 * * *"   # required: UTC cron, or "none" for on-demand backups only
    retention:               # omit to keep every backup
      keepLast: 7
      daily: 7
      weekly: 4
      monthly: 6
      failed: 5
    destination: pvc         # s3 or pvc; required only with type: both
```

Optional per source: `scaleDownTimeoutSeconds` (default 300), `copyTimeoutSeconds` (default 3600), `startTimeoutSeconds` (default 120: how long the placement probe, then the copy Job, may take to start), `suspend`, and `resources` for the copy Job (default requests 50m/64Mi, limits 100m/128Mi; that default always fits, because a stopped workload frees no quota). A larger limit shortens the downtime of a large volume when the tenant has headroom.

The chart renders each entry into `BackupDestination.spec.sources`. Leave `storageRoot` empty (the default): the operator then takes the root from the path the tenant host pods mount, which always matches the platform's `storageRoot`. When you set it (Kubesolo: `/var/lib/kubesolo`, k0s: `/var/lib/k0s`), the host pods must mount exactly that path, or the backup fails with `VolumeNotMounted` and nothing is stopped.

**There is no default schedule and no default retention.**
- **Schedule.** Every source needs `schedule` (#250): a five-field UTC cron, or `none` for on-demand backups only. The chart and `installBackupDestination` refuse a source without one; a `BackupDestination` applied by hand with a source that has no `schedule` is treated like `none` (`scheduleStatus: OnDemand`). Either way it is never backed up on a schedule, and "Back up now" on the console, or a `Backup` you create, still works.
  - A schedule is armed when it is first seen, when it changes, and when the source is unsuspended. It never fires for a time before that, so an edit or an unsuspend never stops a workload at once.
  - A fire while a backup of the same source is still queued or running is skipped, and the console answers 409 to a second "Back up now". A workload is never stopped twice for one request.
  - The CRD accepts `none` or five fields of numbers, `*`, ranges, steps and lists. A value out of range (`99 * * * *`) shows `scheduleStatus: InvalidSchedule` in `status.sources[]` and on the console, and never runs. A run missed while the destination was busy happens once, when it can.
- **Retention.** A source without a rule keeps every backup.
  - **Successful backups.** A backup is kept when any rule keeps it: it is one of the newest `keepLast`, or it is the newest backup of one of the newest `daily` UTC days, `weekly` ISO weeks or `monthly` UTC months that have a backup. As soon as one of these four rules is set, every successful backup no rule keeps is deleted, objects included.
  - **Failed attempts.** `failed` keeps that many of the newest failed attempts and deletes the older records. A failed copy that recorded no object key is pruned by its object prefix, so objects it may have written are not orphaned.
  - **Retention never deletes a backup a restore is reading.** Removing a source from the list deletes none of its backups.
  - BackingService dumps keep their own `retentionSuccessful` and never touch workload-volume backups.

### A cold copy

Each step is written to the Backup's `status.volume` before the next action, so an operator restart carries on where it stopped.

1. **Placing.** The operator finds the one node that holds the volume. Every tenant host pod mounts every storage directory of the tenant, so the hosts that mount this path (ready, starting or terminating) are the only places its instances can have written. If they span more than one node, the backup fails with `VolumeAmbiguous` and nothing is stopped. It then runs a short probe Job on that node, which mounts the hostPath and the destination claim (no credentials, non-root, no capabilities). Only when the probe succeeds does anything stop. A probe that fails, or does not finish within `startTimeoutSeconds`, ends the backup (`PlacementFailed`, `PlacementTimeout`) with no downtime. A misplaced claim, a full quota, or an image that cannot be pulled therefore costs nothing.
2. **ScalingDown.** It records `spec.replicas` of every WorkloadDeployment that shares the volume (members sharing `di-framework.dev/workload`). The record goes in `status.volume.members` and in the held-replicas ledger, the ConfigMap `di-backup-held-replicas` in `di-runtime-<name>`. Then it scales them to 0 through the `scale` subresource. It waits until none of them has a `Workload` left, for up to `scaleDownTimeoutSeconds`. If the volume moved to another node meanwhile, the backup fails with `VolumeMoved`.
3. **Copying.** It runs the copy Job on that node, pinned with node affinity, mounting the directory read-only.
   - The Job runs as root with only `DAC_READ_SEARCH`, a read-only root filesystem and the `RuntimeDefault` seccomp profile.
   - A Job that does not start within `startTimeoutSeconds` is stopped, and the replicas come back at once (`CopyNotStarted`).
   - The agent reads the volume once: `tar` streams through a reader that hashes every file on its way to the destination, so the manifest describes the archived bytes. It refuses links and devices, and it writes `data.tar`, `SHA256SUMS` and `manifest.json` (last) under `<prefix>/workload-volumes/<name>/<uid>/<UTC stamp>/`.
   - The manifest holds the UTC stamp, the image and its digest (when pinned by digest), the counts, the bytes, the owner of every entry, and the encfs KCV (bytes 8..24 of `.di-encfs`) when the volume has a marker.
   - If anything in the volume changed during the copy (size, mtime, ctime, inode or mode), the backup fails with `SourceChanged`.
   - On S3 the part size grows with the volume, so a stream is never cut off at 10,000 parts.
   - Ciphertext is copied as stored. Nothing is decrypted, and no Secret is read.
4. **ScalingUp.** The outcome is recorded first. Then every member still at 0 gets its replicas back, the ledger entries go, and only then is the terminal status written. A member somebody raised meanwhile keeps their count. This happens on success, on failure, on every timeout, when the Job disappears, when the destination is suspended or deleted, and when the Backup is deleted. If a Job had to be stopped, the replicas wait (at most 120 s) until its pod is gone, so a restore can never run beside the workload.

The workload is down from the scale-down to the scale-up. `Backup.status.volume.scaleDownSeconds`, `BackupDestination.status.sources[].lastScaleDownSeconds` and the console show how long that was.

### Replicas always come back

- **Unknown is not empty.** If the workload lists, the tenant host Deployment or the ledger cannot be read, the volume state is unknown for that tick. No volume step runs and nothing terminal is written, and the next tick retries. A member is skipped only on a 404 from the scale write itself.
- **Deleting a running Backup or BackupRestore** is safe. It carries the finalizer `platform.di-framework.dev/restore-replicas` from the moment it starts, and the operator treats deletion as "finish now": stop the Job, give the replicas back, then drop the finalizer.
- **The ledger outlives the request.** If a running request vanishes anyway (finalizer stripped by hand), a sweeper gives every entry it held back from the ledger. A new copy never starts while a member is still held, so it never records 0 as the replicas to give back.
- **The ledger is out of tenant reach.** It lives in the runtime namespace `di-runtime-<name>`, where tenant roles only read pods, services and events. (Tenant developers can edit ConfigMaps in `di-tenant-<name>`, so a ledger there could steer the operator's `scale` writes.) A ledger an earlier build left in the tenant namespace is ignored; delete it at will. The sweeper still checks every entry and drops, without scaling, any entry the operator could not have written:
  - the workload is not a source of the entry's (existing) BackupDestination, nor a member sharing a source's volume;
  - it is platform-reserved: `di-tenant-registry`, or labelled `platform.di-framework.dev/component=tenant-auth`;
  - the replicas are not a whole number from 0 to 100, the holder is not `Backup/<name>` or `BackupRestore/<name>`, or the timestamp does not parse.

  A workload that a running request holds by its own status is left to that request, whatever its entry says.
- **Only sources stop.** A Backup or BackupRestore whose workload is not a source of its destination ends `NotASource`, and one that would stop a platform-reserved workload (by name, or by sharing its volume) ends `WorkloadReserved`, both before anything stops.
- **One reconciler.** The operator Deployment uses `Recreate`, ticks never overlap, and only the holder of the Lease `di-backup-operator` reconciles. Every status and ledger write carries a `resourceVersion` precondition, so a stale reconciler cannot overwrite a newer result. Job and scheduled-Backup names are derived from the request (or the fire time), so a repeated create is a harmless 409.
- **Jobs belong to one object.** Probe, copy and restore Job names include a short hash of the request's `metadata.uid`, and the Jobs carry it in the label `platform.di-framework.dev/backup-uid`. A request deleted and re-applied under the same name (a GitOps sync, a retry with `force: true`) therefore runs new Jobs instead of taking over the result of the old ones, which are kept for 7 days. A 409 on a create counts as success only when the existing Job carries the same uid. A Job of another object under the recorded name is never adopted or stopped: the request ends `JobConflict` and its replicas come back.

### Restore

Create a `BackupRestore` with `targetWorkloadName` (the console has a form). An `expectedKcv` that differs from the KCV the backup recorded is refused before anything stops (`KcvMismatch`). The operator places, stops, and runs the restore Job on the target's node like a copy. That Job mounts the tenant's `workloads` directory read-write, as root with only `CHOWN` and `DAC_OVERRIDE`. The agent:
- refuses a non-empty target unless `force: true`, and refuses a target it cannot read (`TargetUnreadable`) instead of treating it as empty. With `force`, the old entries move to `<key>.replaced-<stamp>` next to it. The entries move, not the directory, because the tenant host has the directory itself mounted;
- checks that `SHA256SUMS` matches the manifest;
- lists the archive before extracting anything: any member that is not a regular file or directory named by the manifest with its size is refused (`ArchiveRejected`);
- extracts into `<key>.restoring-<stamp>` next to the target, and checks that every file and directory matches the manifest (nothing missing, nothing extra), every sha256, and the marker's KCV;
- with `expectedKcv`, also requires that value. Restoring over data whose marker carries a different KCV is refused unless `expectedKcv` names the backup's KCV;
- moves the files into place and gives every entry the owner the manifest recorded. Backups taken before owners were recorded get the host uid 65532.

Then the replicas come back, whatever the outcome. If replicas were raised while the restore ran, it reports `ScaledDuringRestore`; the restored data is in place.

**Leftover directories.** Nothing old is ever deleted for you.
- `<key>.replaced-<stamp>` holds the data a forced restore replaced. Its name is in `status.volume.replacedPath`.
- A restore that failed part-way leaves `<key>.restoring-<stamp>`, named in `status.volume.restoringPath`, and the replaced data if any.

Both sit in `<storageRoot>/di-tenants/<tenant uid>/workloads/` on the node and hold ciphertext. Once the workload runs well, remove them on the node, for example with a short Job pinned to the node that mounts that directory.

### Permissions

The operator's Role in `di-tenant-<name>` adds:
- `get`/`list` on `workloaddeployments`, `workloadreplicasets` and `workloads`;
- `get`/`patch` on `workloaddeployments/scale` only. The WorkloadDeployment itself is never written. Platform admission re-validates every update to it, and the spec stays out of reach;
- `get`/`patch` on the Lease `di-backup-operator`, by name, plus `create` (`create` cannot be limited by name). It has no ConfigMap access here;
- `get` on the one S3 credentials Secret the chart's destination names. It no longer lists Secrets. A destination created by hand that names another Secret reports `CredentialsInvalid`.

In `di-runtime-<name>` it adds `get` on the one Deployment `hostgroup-tenant-<name>`, whose owner-uid label names the tenant directory, and `get`/`patch` on the ConfigMap `di-backup-held-replicas` by name plus `create`. There is no ClusterRole.

Run `sh ../backup-agent/scripts/capabilities.sh` to check the Job security contexts in a container: each capability set is run as granted, and once with one capability fewer.

**Limits.**
- The copy is cold: the workload is unavailable while it runs.
- With a node-local PVC destination, the claim must be usable on the workload's node; with `local-path` that is the same node. The placement probe finds out before anything stops.
- Images pinned by tag record `imageDigest: null`; the copy Job gets no registry access to resolve them.
- Live copies need a pglite/encfs snapshot API and are out of scope.

The packages stay private. Image tags `di-framework/backup-destination:dev` and `di-framework/backup-agent:dev` are imported into Kubesolo (`imagePullPolicy: Never`), not published to GHCR.
