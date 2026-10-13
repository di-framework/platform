# `@di-framework/backup-agent`

Job image used by the tenant backup operator. It does not talk to the Kubernetes API. The operator starts one Job per dump, restore, emptiness probe, or retention deletion, and reads the JSON this process writes to `/dev/termination-log`.

`BACKUP_KIND` is `postgres`, `redis`, `nats`, `gc`, `probe-empty`, `restore-postgres`, `restore-redis`, `restore-nats`, `workload-volume`, `restore-workload-volume`, or `probe-placement`. Postgres uses `pg_dump -Fc` and `pg_restore`. Redis uses `redis-cli --rdb` and an RDB-to-RESP pipe. NATS uses `nats account backup` / `account restore`. Objects are uploaded with rclone to the bucket in `BACKUP_BUCKET` under `BACKUP_OBJECT_PREFIX`. With `BACKUP_DESTINATION_TYPE=pvc` they are copied (`cp` to a `.partial` name, then renamed) under the same prefix in the claim mounted at `BACKUP_PVC_MOUNT_PATH`; no bucket or credentials are needed. Keys that are absolute or contain `.` or `..` segments are refused.

S3 credentials arrive as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`. They are not written to the termination record or placed on argv. `http://` endpoints are only for `*.svc.cluster.local` and `localhost`; the operator rejects anything else before creating the Job.

The image pins PostgreSQL 18.3 client tools, Redis 7.4.5 `redis-cli`, NATS CLI 0.5.0, rclone 1.71.0, and `rdbtools` 0.1.15 (MIT). Build it with:

```sh
docker build -t di-framework/backup-agent:dev platform/backup-agent
```

A published `ghcr.io/di-framework/backup-agent` digest is not part of this package yet.

`workload-volume` reads the read-only mount in `BACKUP_SOURCE_DIR` once. It accepts regular files and directories only. `tar` (numeric owners) streams through a reader that hashes each file on its way to the destination (`rclone rcat` with a part size that fits the volume, or a `.partial` file on the claim), so the manifest describes the archived bytes. It writes `data.tar`, `SHA256SUMS` and `manifest.json`: the stamp, image digest, counts, per-file sha256, size, mode and owner, and the encfs KCV (bytes 8..24 of `.di-encfs`). If the tree changed while it was read (size, mtime, ctime, inode or mode), it fails with `SourceChanged`. `restore-workload-volume` writes into `BACKUP_TARGET_ROOT/BACKUP_STORAGE_KEY`:
- it refuses a non-empty directory unless `BACKUP_FORCE=true`, which moves the old entries to `<key>.replaced-<stamp>`. A directory it cannot read is `TargetUnreadable`, never "empty";
- it lists the archive before extracting and refuses any member the manifest does not name as a file (with its size) or a directory (`ArchiveRejected`);
- it verifies the manifest, the sums, every hash and the KCV (and `BACKUP_EXPECTED_KCV` when set) in a staging directory before anything moves;
- it gives every entry the owner the manifest recorded (65532 for older manifests). A move that stops part-way reports `replacedPath` and `restoringPath`.

`probe-placement` checks that each `:`-separated path in `BACKUP_PROBE_PATHS` is a directory; the operator runs it on the volume's node before stopping anything.

`scripts/capabilities.sh` runs the image with the exact Job security contexts (`--cap-drop ALL`, `DAC_READ_SEARCH` for a backup, `CHOWN` and `DAC_OVERRIDE` for a restore, read-only root) against a 0700 source owned by 65532, and once with one capability fewer.

Neither kind decrypts anything.
