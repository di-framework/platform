# `@di-framework/backup-agent`

Job image used by the tenant backup operator. It does not talk to the Kubernetes API. The operator starts one Job per dump, restore, emptiness probe, or retention deletion, and reads the JSON this process writes to `/dev/termination-log`.

`BACKUP_KIND` is `postgres`, `redis`, `nats`, `gc`, `probe-empty`, `restore-postgres`, `restore-redis`, `restore-nats`, `workload-volume`, or `restore-workload-volume`. Postgres uses `pg_dump -Fc` and `pg_restore`. Redis uses `redis-cli --rdb` and an RDB-to-RESP pipe. NATS uses `nats account backup` / `account restore`. Objects are uploaded with rclone to the bucket in `BACKUP_BUCKET` under `BACKUP_OBJECT_PREFIX`. With `BACKUP_DESTINATION_TYPE=pvc` they are copied (`cp` to a `.partial` name, then renamed) under the same prefix in the claim mounted at `BACKUP_PVC_MOUNT_PATH`; no bucket or credentials are needed. Keys that are absolute or contain `.` or `..` segments are refused.

S3 credentials arrive as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`. They are not written to the termination record or placed on argv. `http://` endpoints are only for `*.svc.cluster.local` and `localhost`; the operator rejects anything else before creating the Job.

The image pins PostgreSQL 18.3 client tools, Redis 7.4.5 `redis-cli`, NATS CLI 0.5.0, rclone 1.71.0, and `rdbtools` 0.1.15 (MIT). Build it with:

```sh
docker build -t di-framework/backup-agent:dev platform/backup-agent
```

A published `ghcr.io/di-framework/backup-agent` digest is not part of this package yet.

`workload-volume` reads the read-only mount in `BACKUP_SOURCE_DIR`. It accepts regular files and directories only. It writes `data.tar` (GNU tar, numeric owners), `SHA256SUMS` and `manifest.json` (stamp, image digest, file count, per-file sha256, and the encfs KCV, bytes 8..24 of `.di-encfs`). If the tree changed while it was read, it fails with `SourceChanged`. `restore-workload-volume` writes into `BACKUP_TARGET_ROOT/BACKUP_STORAGE_KEY`:
- it refuses a non-empty directory unless `BACKUP_FORCE=true`, which moves the old entries to `<key>.replaced-<stamp>`;
- it verifies the manifest, the sums, every hash and the KCV (and `BACKUP_EXPECTED_KCV` when set) in a staging directory before anything moves;
- it chowns the result to 65532.

Neither kind decrypts anything.
