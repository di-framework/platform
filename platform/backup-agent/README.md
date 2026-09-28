# `@di-framework/backup-agent`

Job image used by the tenant backup operator. It does not talk to the Kubernetes API. The operator starts one Job per dump, restore, emptiness probe, or retention deletion, and reads the JSON this process writes to `/dev/termination-log`.

`BACKUP_KIND` is `postgres`, `redis`, `nats`, `gc`, `probe-empty`, `restore-postgres`, `restore-redis`, or `restore-nats`. Postgres uses `pg_dump -Fc` and `pg_restore`. Redis uses `redis-cli --rdb` and an RDB-to-RESP pipe. NATS uses `nats account backup` / `account restore`. Objects are uploaded with rclone to the bucket in `BACKUP_BUCKET` under `BACKUP_OBJECT_PREFIX`.

S3 credentials arrive as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`. They are not written to the termination record or placed on argv. `http://` endpoints are only for `*.svc.cluster.local` and `localhost`; the operator rejects anything else before creating the Job.

The image pins PostgreSQL 18.3 client tools, Redis 7.4.5 `redis-cli`, NATS CLI 0.5.0, rclone 1.71.0, and `rdbtools` 0.1.15 (MIT). Build it with:

```sh
docker build -t di-framework/backup-agent:dev platform/backup-agent
```

A published `ghcr.io/di-framework/backup-agent` digest is not part of this package yet.
