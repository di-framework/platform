#!/bin/sh
# Runs the agent image with exactly the security context the operator gives workload-volume Jobs
# (#232): root with every capability dropped except
#   backup:  DAC_READ_SEARCH
#   restore: CHOWN, DAC_OVERRIDE
# a read-only root filesystem, the default seccomp profile, and a source owned by the host uid
# (65532) with mode 0700. Each set is also run one capability short, to show it is needed.
#
#   IMAGE=localhost/di-backup-agent:captest ENGINE=podman sh scripts/capabilities.sh
#
# Volumes are container volumes, so ownership and modes behave as on a Linux node.
set -eu

IMAGE=${IMAGE:-localhost/di-backup-agent:captest}
ENGINE=${ENGINE:-podman}
run_id=$$
src="cap-src-$run_id"
claim="cap-claim-$run_id"
workloads="cap-workloads-$run_id"
out="cap-out-$run_id"
s3="cap-s3-$run_id"
fail=0

cleanup() {
  "$ENGINE" rm -f "$s3" >/dev/null 2>&1 || true
  "$ENGINE" volume rm -f "$src" "$claim" "$workloads" "$out" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for volume in "$src" "$claim" "$workloads" "$out"; do "$ENGINE" volume create "$volume" >/dev/null; done

# Setup with every capability: a pglite-like tree owned by the host uid, unreadable to others.
"$ENGINE" run --rm --entrypoint sh -v "$src:/source" -v "$workloads:/workloads" "$IMAGE" -c '
  set -e
  mkdir -p /source/pglite/base/1 /source/pglite/empty
  head -c 8192 /dev/urandom > /source/pglite/base/1/1259
  printf "17\n" > /source/pglite/PG_VERSION
  printf "DIENCFS1\000\021\042\063\104\125\146\167\210\231\252\273\314\335\356\377\000\000\000\000\000\000\000\000" > /source/.di-encfs
  chown -R 65532:65532 /source
  chmod -R go-rwx /source
  chmod 0700 /source
  mkdir -p /workloads/identity
  echo old > /workloads/identity/stale
  chown -R 65532:65532 /workloads/identity
  chmod 0700 /workloads/identity
'

# As in the Job: the root (and /tmp) is read-only; only /scratch, the volume and the claim are not.
# podman mounts a tmpfs on /tmp under --read-only unless told not to; docker never does.
readonly_tmp=""
[ "$(basename "$ENGINE")" = podman ] && readonly_tmp="--read-only-tmpfs=false"
common="--rm --user 0:0 --read-only $readonly_tmp --tmpfs /scratch --cap-drop ALL
  --security-opt no-new-privileges -e HOME=/scratch -e TMPDIR=/scratch
  -e RCLONE_CONFIG=/scratch/rclone.conf -e BACKUP_WORKDIR=/scratch
  -e TERMINATION_LOG=/out/termination -e BACKUP_DESTINATION_TYPE=pvc
  -e BACKUP_PVC_MOUNT_PATH=/backup-pvc -e BACKUP_OBJECT_PREFIX=w/identity/uid/20261013T000000Z
  -e BACKUP_WORKLOAD_NAME=identity -e BACKUP_STORAGE_KEY=identity
  -e BACKUP_STAMP=2026-10-13T00:00:00.000Z -v $claim:/backup-pvc -v $out:/out"

result() {
  "$ENGINE" run --rm --entrypoint cat -v "$out:/out" "$IMAGE" /out/termination
}

expect() {
  label=$1
  wanted=$2
  shift 2
  # shellcheck disable=SC2086
  "$ENGINE" run $common "$@" "$IMAGE" >/dev/null 2>&1 && code=0 || code=$?
  got=$(result)
  case "$got" in
    *"$wanted"*) echo "ok   $label: $got" ;;
    *) echo "FAIL $label (exit $code): $got"; fail=1 ;;
  esac
}

# shellcheck disable=SC2086
if "$ENGINE" run $common --entrypoint sh "$IMAGE" -c 'touch /tmp/x' >/dev/null 2>&1; then
  echo "FAIL /tmp is writable: the run would not prove the agent needs only /scratch"; fail=1
else
  echo "ok   /tmp is read-only; only /scratch, the volume and the claim are writable"
fi

backup="-e BACKUP_KIND=workload-volume -e BACKUP_SOURCE_DIR=/source -v $src:/source:ro"
restore="-e BACKUP_KIND=restore-workload-volume -e BACKUP_TARGET_ROOT=/workloads -v $workloads:/workloads"

# shellcheck disable=SC2086
expect 'backup without DAC_READ_SEARCH is refused' '"error":"SourceUnreadable"' $backup
# shellcheck disable=SC2086
expect 'backup with DAC_READ_SEARCH only' '"ok":true' $backup --cap-add DAC_READ_SEARCH
# shellcheck disable=SC2086
expect 'restore without DAC_OVERRIDE is refused' '"ok":false' $restore -e BACKUP_FORCE=true --cap-add CHOWN
# shellcheck disable=SC2086
expect 'restore without CHOWN fails on ownership' '"error":"OwnershipFailed"' $restore -e BACKUP_FORCE=true \
  -e BACKUP_STAMP=2026-10-13T00:00:01.000Z --cap-add DAC_OVERRIDE
"$ENGINE" run --rm --entrypoint sh -v "$workloads:/workloads" "$IMAGE" -c '
  rm -rf /workloads/identity/* /workloads/identity/.di-encfs /workloads/identity.*
  echo old > /workloads/identity/stale; chown -R 65532:65532 /workloads/identity'
# shellcheck disable=SC2086
expect 'restore with CHOWN and DAC_OVERRIDE only' '"replacedPath":"identity.replaced-' $restore \
  -e BACKUP_FORCE=true -e BACKUP_STAMP=2026-10-13T00:00:02.000Z --cap-add CHOWN --cap-add DAC_OVERRIDE

# The restored tree equals the source, byte for byte, owned by the host uid.
"$ENGINE" run --rm --entrypoint sh -v "$src:/source:ro" -v "$workloads:/workloads:ro" "$IMAGE" -c '
  cd /source && find . -type f -exec sha256sum {} + | sort > /tmp/a
  cd /workloads/identity && find . -type f -exec sha256sum {} + | sort > /tmp/b
  cmp /tmp/a /tmp/b
  test -z "$(find /workloads/identity ! -uid 65532)"
  stat -c "%a %u:%g" /workloads/identity/pglite/PG_VERSION
' && echo "ok   restored tree matches the source and is owned by 65532" ||
  { echo "FAIL restored tree differs"; fail=1; }

# The S3 path: tar streams through the agent into `rclone rcat`, and back through `rclone cat`.
# rclone's own S3 server stands in for the bucket.
"$ENGINE" run -d --name "$s3" --entrypoint sh "$IMAGE" -c \
  'mkdir -p /data/bkt && exec rclone serve s3 /data --auth-key AKIACAPABILITYTEST,capability-test-secret-key --addr 127.0.0.1:9000' >/dev/null
sleep 2
s3env="--network container:$s3 -e BACKUP_DESTINATION_TYPE=s3 -e BACKUP_BUCKET=bkt
  -e BACKUP_ENDPOINT=http://localhost:9000 -e AWS_ACCESS_KEY_ID=AKIACAPABILITYTEST -e AWS_SECRET_ACCESS_KEY=capability-test-secret-key"
"$ENGINE" run --rm --entrypoint sh -v "$workloads:/workloads" "$IMAGE" -c '
  rm -rf /workloads/identity/* /workloads/identity/.di-encfs /workloads/identity.*'
# shellcheck disable=SC2086
expect 'S3 backup with DAC_READ_SEARCH only' '"ok":true' $backup $s3env --cap-add DAC_READ_SEARCH
# shellcheck disable=SC2086
expect 'S3 restore with CHOWN and DAC_OVERRIDE only' '"ok":true' $restore $s3env \
  -e BACKUP_STAMP=2026-10-13T00:00:03.000Z --cap-add CHOWN --cap-add DAC_OVERRIDE
"$ENGINE" run --rm --entrypoint sh -v "$src:/source:ro" -v "$workloads:/workloads:ro" "$IMAGE" -c '
  cd /source && find . -type f -exec sha256sum {} + | sort > /tmp/a
  cd /workloads/identity && find . -type f -exec sha256sum {} + | sort > /tmp/b
  cmp /tmp/a /tmp/b && test -z "$(find /workloads/identity ! -uid 65532)"
' && echo "ok   S3 round trip matches the source and is owned by 65532" ||
  { echo "FAIL S3 round trip differs"; fail=1; }

exit "$fail"
