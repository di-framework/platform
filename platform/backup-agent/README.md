# `@di-framework/backup-agent`

Job image used by the tenant backup operator. It does not talk to the Kubernetes API. The operator starts one Job per dump, restore, emptiness probe, or retention deletion, and reads the JSON this process writes to `/dev/termination-log`.

`BACKUP_KIND` is `postgres`, `redis`, `nats`, `gc`, `probe-empty`, `restore-postgres`, `restore-redis`, `restore-nats`, `workload-volume`, `restore-workload-volume`, or `probe-placement`. Postgres uses `pg_dump -Fc` and `pg_restore`. Redis uses `redis-cli --rdb` and an RDB-to-RESP pipe. NATS uses `nats account backup` / `account restore`. Objects are uploaded with rclone to the bucket in `BACKUP_BUCKET` under `BACKUP_OBJECT_PREFIX`. With `BACKUP_DESTINATION_TYPE=pvc` they are copied (`cp` to a `.partial` name, then renamed) under the same prefix in the claim mounted at `BACKUP_PVC_MOUNT_PATH`; no bucket or credentials are needed. Keys that are absolute or contain `.` or `..` segments are refused.

A restore first waits for the target with a read-only probe (`psql -c 'SELECT 1'`, `redis-cli PING`, `nats account info`), then runs the restore exactly once. The record's error code says whether anything was written:

- `RestorePrepareFailed`: the downloaded file could not be prepared (the `rdb` conversion or `tar -xf` failed) before the target was contacted. Nothing was written.
- `TargetUnreachable`: the probe never succeeded, because the target was unreachable or rejected the login. Nothing was written; `detail` tells the two apart (`Connection refused` against `password authentication failed`, `NOAUTH`, `Authorization Violation`).
- `RestoreFailed`: the restore itself ran and failed, so the target may hold part of the data.

Each can carry `detail` (at most 300 characters), and the operator copies it into the restore's status message. For probes, `tar` and `nats account restore` it is the last line the tool printed that carries the cause (indented hint lines, such as psql's "Is the server running", are skipped). Steps that see tenant data hold it back: for `pg_restore` only its own `pg_restore: ...` lines count (never the `DETAIL:` lines that quote rows); for `redis-cli --pipe` it is only the server's error code (such as `ERR` or `WRONGTYPE`) plus the `errors: N, replies: M` summary, because the server's error replies echo the tenant's keys and values; a failed `rdb` conversion carries no `detail`.

S3 credentials arrive as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`. They are not written to the termination record or placed on argv. `http://` endpoints are only for `*.svc.cluster.local` and `localhost`; the operator rejects anything else before creating the Job.

The image pins PostgreSQL 18.3 client tools, Redis 7.4.5 `redis-cli`, NATS CLI 0.5.0, rclone 1.71.0, and `rdbtools` 0.1.15 (MIT). Build it with:

```sh
docker build -t di-framework/backup-agent:dev platform/backup-agent
```

A published `ghcr.io/di-framework/backup-agent` digest is not part of this package yet.

`workload-volume` reads the read-only mount in `BACKUP_SOURCE_DIR` once. It accepts regular files and directories only. `tar` (numeric owners) streams through a reader that hashes each file on its way to the destination (`rclone rcat` with a part size that fits the volume, or a `.partial` file on the claim), so the manifest describes the archived bytes. It writes `data.tar`, `SHA256SUMS` and `manifest.json`: the stamp, image digest, counts, per-file sha256, size, mode and owner, the encfs KCV (bytes 8..24 of `.di-encfs`) and the directory's mode, and `dataDirectories`: every PostgreSQL data directory in the volume (#492), found from entry names alone, which encfs leaves in the clear. A data directory is a directory holding a regular `PG_VERSION` file; the record gives its `path`, whether it is `complete` (`global/pg_control` is a regular file too, which is what pglite-component requires to boot), its `applicationDatabase` (`postgres` when the `di-framework-database` marker is present, else the legacy `template1`) and `pgVersion`, the content of `PG_VERSION` in a plaintext volume and null where it is ciphertext. An incomplete directory is backed up and recorded as such, never refused. The termination record carries the count as `dataDirectories`. If the tree changed while it was read (size, mtime, ctime, inode or mode), it fails with `SourceChanged`. `restore-workload-volume` writes into `BACKUP_TARGET_ROOT/BACKUP_STORAGE_KEY`:
- it refuses a non-empty directory unless `BACKUP_FORCE=true`, which moves the old entries to `<key>.replaced-<stamp>`. A directory it cannot read is `TargetUnreadable`, never "empty";
- it lists the archive before extracting and refuses any member the manifest does not name as a file (with its size) or a directory (`ArchiveRejected`);
- it verifies the manifest, the sums, every hash, the marker's mode and KCV (and `BACKUP_EXPECTED_KCV` when set), and that the data directories it finds in the extracted tree are the ones the manifest records (`ContentMismatch` otherwise), in a staging directory before anything moves;
- it gives every entry the owner the manifest recorded (65532 for older manifests). A move that stops part-way reports `replacedPath` and `restoringPath`.

`probe-placement` checks that each `:`-separated path in `BACKUP_PROBE_PATHS` is a directory; the operator runs it on the volume's node before stopping anything.

`scripts/capabilities.sh` runs the image with the exact Job security contexts (`--cap-drop ALL`, `DAC_READ_SEARCH` for a backup, `CHOWN` and `DAC_OVERRIDE` for a restore, read-only root) against a 0700 source owned by 65532, and once with one capability fewer.

Neither kind decrypts anything.
