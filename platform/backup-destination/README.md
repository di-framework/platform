# `@di-framework/backup-destination`

Helm chart and operator for backing up wasmCloud tenant backing services. Install it with Pulumi's Helm release provider into a tenant namespace the platform controller has created (`di-tenant-<name>`). The release sets `createNamespace: false`. It does not create that namespace or `di-runtime-<name>`.

`installBackupDestination` is the install. `prototype/` is a stack that points at a `di-framework-kube` kubeconfig, declares the tenant through `createPlatform`, and installs RustFS plus this chart with `kubernetes.helm.v3.Release`.

```sh
bun platform/backup-destination/scripts/prototype.ts
```

The operator pod serves an HTML console on `di-backup-console:8080` and creates backup-agent Jobs in `di-runtime-<name>`. The console can start a backup or request a restore into an empty BackingService. It does not show Secret values.

`existingSecret` selects a Secret you create. `accessKeyId` and `secretAccessKey` render Secret `di-backup-s3` and are only for a private demo; those values stay in Helm release history.

## Backup Destinations

Backups can be stored in S3 or to a PersistentVolumeClaim (PVC).

### S3 Destinations (recommended)

S3 is the recommended destination. It provides durability, geographic distribution, and protection against node loss. Configure with `existingSecret` or the demo credentials above.

### PVC Destinations

PVCs can be used as local backup destinations via `existingClaimName` (reference an existing PVC) or `volumeClaimTemplate` (create a new PVC with a storageClass and size). The backup agent mounts the PVC and writes data with the same directory layout as S3.

**Node loss risk:** PVCs are bound to specific nodes. If a node is lost, backups stored on that node's PVC become inaccessible unless the storage is replicated or durable across zones. For production workloads that require durable backups, use S3 instead.

The packages stay private. Image tags `di-framework/backup-destination:dev` and `di-framework/backup-agent:dev` are imported into Kubesolo (`imagePullPolicy: Never`), not published to GHCR.
