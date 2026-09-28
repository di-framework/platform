# `@di-framework/backup-destination`

Helm chart and operator for backing up wasmCloud tenant backing services. Install it with Pulumi's Helm release provider into a tenant namespace the platform controller has created (`di-tenant-<name>`). The release sets `createNamespace: false`. It does not create that namespace or `di-runtime-<name>`.

`installBackupDestination` is the install. `prototype/` is a stack that points at a `di-framework-kube` kubeconfig, declares the tenant through `createPlatform`, and installs RustFS plus this chart with `kubernetes.helm.v3.Release`.

```sh
bun platform/backup-destination/scripts/prototype.ts
```

The operator pod serves an HTML console on `di-backup-console:8080` and creates backup-agent Jobs in `di-runtime-<name>`. The console can start a backup or request a restore into an empty BackingService. It does not show Secret values.

`existingSecret` selects a Secret you create. `accessKeyId` and `secretAccessKey` render Secret `di-backup-s3` and are only for a private demo; those values stay in Helm release history.

The packages stay private. Image tags `di-framework/backup-destination:dev` and `di-framework/backup-agent:dev` are imported into Kubesolo (`imagePullPolicy: Never`), not published to GHCR.
