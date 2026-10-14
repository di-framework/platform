import { createHash, randomBytes } from 'node:crypto';

/**
 * NATS accounts on each tenant's `di-nats` (#159).
 *
 * Tenant workloads reach `di-nats` through the host's data NATS client, so whatever lives in the
 * account that client lands in is reachable to them through raw `$JS.API.*` and `$O.*` requests
 * (and through a mirror or source of `OBJ_*`, which subject permissions do not stop). The registry
 * runs on the same host pods, so a NetworkPolicy cannot separate the two either. Its object store
 * therefore lives in its own account:
 *
 * - `TENANT` holds the default traffic. Clients that send no credentials (the host data client,
 *   tenant keyvalue and messaging, `di-bs-` / `di-binding-` blobstore entries) log in as its
 *   `no_auth_user`, so nothing changes for them. JetStream of the server's global account (`$G`)
 *   is not available once accounts are configured, so the existing store directory of `$G` is
 *   renamed to `TENANT` before the server starts (see {@link JETSTREAM_ACCOUNT_INIT_SCRIPT}).
 * - `REGISTRY` holds the registry's object store. Its one user's password is generated per tenant
 *   into the {@link REGISTRY_NATS_SECRET} Secret, handed to nats-server through an environment
 *   variable and to the tenant hosts as a read-only file mount. The registry's blobstore entry
 *   names those files (`user_file`, `password_file`, wash patch 0003).
 * - The registry's object store moves from `TENANT` to `REGISTRY` once, through
 *   {@link REGISTRY_NATS_MIGRATION_JOB}. The entry switches to the credentials only after that
 *   Job succeeded, which the platform controller records in {@link REGISTRY_NATS_MIGRATION}.
 */

/** The account anonymous clients (the host data client) land in. */
export const NATS_TENANT_ACCOUNT = 'TENANT';
/** The `no_auth_user` of {@link NATS_TENANT_ACCOUNT}. It has no password and nothing logs in as it. */
export const NATS_TENANT_USER = 'tenant';
/** The registry's account. */
export const NATS_REGISTRY_ACCOUNT = 'REGISTRY';
/** The one user of {@link NATS_REGISTRY_ACCOUNT}. */
export const REGISTRY_NATS_USER = 'registry';
/**
 * The registry user's credentials in `di-runtime-<tenant>`, a `kubernetes.io/basic-auth` Secret
 * (`username`, `password`) the platform controller generates. Delete it to rotate.
 */
export const REGISTRY_NATS_SECRET = 'di-nats-registry';
/**
 * Where the tenant hosts see {@link REGISTRY_NATS_SECRET}. Fixed: admission pins the registry
 * blobstore entry's `user_file` and `password_file` to exactly these files, since the host reads
 * any file it can and sends it as the password.
 */
export const REGISTRY_NATS_MOUNT = '/var/run/secrets/di-framework/registry-nats';
export const REGISTRY_NATS_USER_FILE = `${REGISTRY_NATS_MOUNT}/username`;
export const REGISTRY_NATS_PASSWORD_FILE = `${REGISTRY_NATS_MOUNT}/password`;
/** The host pod volume carrying {@link REGISTRY_NATS_SECRET}. */
export const REGISTRY_NATS_VOLUME = 'registry-nats';
/** The `di-nats` container's environment variable the server config reads the password from. */
export const REGISTRY_NATS_PASSWORD_ENV = 'DI_NATS_REGISTRY_PASSWORD';
/**
 * Pod template annotation on `di-nats` and the tenant hosts: a digest of the registry password, so
 * a rotation restarts the server (which reads the variable at start) and the hosts (whose pooled
 * blobstore connection would otherwise reconnect with the old password).
 */
export const REGISTRY_NATS_AUTH_ANNOTATION = 'platform.di-framework.dev/registry-nats-auth-sha256';
/**
 * Marker ConfigMap in `di-runtime-<tenant>`: `state: complete` once the registry's object store is
 * in {@link NATS_REGISTRY_ACCOUNT}. Written by the platform controller; delete it only together
 * with the store (see the README).
 */
export const REGISTRY_NATS_MIGRATION = 'di-nats-registry-migration';
/** The one-shot Job that moves the registry's object store into its account. */
export const REGISTRY_NATS_MIGRATION_JOB = 'di-nats-registry-migrate';
/** `platform.di-framework.dev/component` of the Job's pod, admitted to `di-nats` on 4222. */
export const REGISTRY_NATS_MIGRATION_COMPONENT = 'nats-migration';
/** nats-box 0.20.0 (nats CLI 0.5.0), the multi-arch index. */
export const NATS_BOX_IMAGE =
  'docker.io/natsio/nats-box:0.20.0@sha256:d2f04223f40e016f77922a8115d34b0cd5fad2ec10b19b39316ae92d07f3d295';
/** The migration Job's container limits, added to the runtime quota while the Job exists. */
export const REGISTRY_NATS_MIGRATION_LIMITS = { cpu: '250m', memory: '128Mi' } as const;
/**
 * How long the migration Job may take, from its start, before it ends `Failed`
 * (`DeadlineExceeded`): also bounds a pod the quota or the scheduler never admits.
 */
export const REGISTRY_NATS_MIGRATION_DEADLINE_SECONDS = 3600;
/** The registry's blobstore container (`CONTAINER_NAME` in `platform/oci-registry/src/storage.rs`). */
export const REGISTRY_BUCKET = 'oci-registry';

/**
 * The registry password: a letter, then 32 random bytes in base64url. nats-server parses an
 * environment variable it substitutes as a config value, so the value must not read as a number,
 * a size (`1MB`), a boolean or start with `-`; a leading letter and base64url never do.
 */
export const REGISTRY_NATS_PASSWORD = /^[A-Za-z][A-Za-z0-9_-]{43}$/;
export function newRegistryNatsPassword(): string {
  return `r${randomBytes(32).toString('base64url')}`;
}
/** The {@link REGISTRY_NATS_AUTH_ANNOTATION} value. */
export function registryNatsAuthDigest(password: string): string {
  return createHash('sha256').update(`di-nats-registry\0${password}`).digest('hex');
}
/** The {@link REGISTRY_NATS_SECRET} data (base64). */
export function registryNatsSecretData(password: string): Record<string, string> {
  const base64 = (text: string) => Buffer.from(text).toString('base64');
  return { username: base64(REGISTRY_NATS_USER), password: base64(password) };
}

/**
 * Published tenant host images known to carry wash patch 0003 (#330), by multi-arch index digest
 * (their `dev.di-framework.wash.patches` labels list `0003-nats-blobstore-credentials.patch`;
 * the publish run is named per entry where known). Fail closed: on any other image, a tag-only reference
 * or an unknown digest included, the registry stays anonymous in {@link NATS_TENANT_ACCOUNT} and
 * the controller logs a warning, since a host without 0003 ignores `user_file` / `password_file`
 * and would show the registry an empty store. The tenant host pin PR (scripts/pin-artifact.ts,
 * #346) appends each later published build whose patch set includes 0003; entries are never
 * removed, since existing installs may still run them.
 */
export const NATS_CREDENTIALS_HOST_IMAGE_DIGESTS: readonly string[] = [
  // ghcr.io/di-framework/wash:2.8.0-wasi-tls (publish run 38613407365)
  'sha256:e27812beefa4ff8ad7a6ae6f5c64eaf67d6d4719ed36c5880bda6106e24b84ab',
  // ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive (publish run 38613407365)
  'sha256:da38d84b52a6327e02febe7172a466f628b1d923944ebf50171f1df630ec37a9',
  // ghcr.io/di-framework/wash:2.8.0-wasi-tls (publish run 38628447091)
  'sha256:805a47c0050a90e8dcf22de8e844da91da38b2d8f2da26170ace7c624af76584',
  // ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive (publish run 38628447091)
  'sha256:933d26ec01dade4af7e0d10b877c9afad5371256147cf6db4aff42ecd0c28ec2',
];
/** Whether `hostImage` is pinned to one of {@link NATS_CREDENTIALS_HOST_IMAGE_DIGESTS}. */
export function hostImageSupportsNatsCredentials(hostImage: string): boolean {
  const at = hostImage.lastIndexOf('@');
  return at > 0 && NATS_CREDENTIALS_HOST_IMAGE_DIGESTS.includes(hostImage.slice(at + 1));
}

/**
 * Accounts of the `di-nats` server config. {@link NATS_REGISTRY_ACCOUNT} is listed only while the
 * registry has its own account; the password is substituted from {@link REGISTRY_NATS_PASSWORD_ENV}
 * when the server starts, so the ConfigMap never holds it.
 */
export function natsAccountsConfig(registry: boolean): string[] {
  return [
    'accounts {',
    `  ${NATS_TENANT_ACCOUNT} {`,
    '    jetstream: enabled',
    `    users: [ { user: "${NATS_TENANT_USER}" } ]`,
    '  }',
    ...(registry
      ? [
          `  ${NATS_REGISTRY_ACCOUNT} {`,
          '    jetstream: enabled',
          `    users: [ { user: "${REGISTRY_NATS_USER}", password: $${REGISTRY_NATS_PASSWORD_ENV} } ]`,
          '  }',
        ]
      : []),
    '}',
    `no_auth_user: "${NATS_TENANT_USER}"`,
  ];
}

/**
 * Init step of `di-nats`, run before the server starts: JetStream keeps one directory per account
 * under `<store_dir>/jetstream`. Clients without credentials used the global account (`$G`) until
 * accounts were configured; they now land in {@link NATS_TENANT_ACCOUNT}, so its directory takes
 * over `$G`'s once. When both exist (a downgrade that skipped the documented rename back, say)
 * the step fails, so `di-nats` does not start and silently serve the older of the two stores.
 */
export const JETSTREAM_ACCOUNT_INIT_SCRIPT = `set -eu
store=/data/jetstream
if [ -d "$store/\\$G" ]; then
  if [ -e "$store/${NATS_TENANT_ACCOUNT}" ]; then
    echo "di-nats: both $store/\\$G and $store/${NATS_TENANT_ACCOUNT} exist; keep the one to serve and move the other away (see the platform README)" >&2
    exit 1
  else
    mv "$store/\\$G" "$store/${NATS_TENANT_ACCOUNT}"
    echo "di-nats: moved the JetStream store of the global account to ${NATS_TENANT_ACCOUNT}"
  fi
fi
`;

/**
 * The migration Job's script (nats-box: busybox sh, jq, nats CLI). It moves the registry's object
 * store `OBJ_oci-registry` from {@link NATS_TENANT_ACCOUNT} (anonymous) to
 * {@link NATS_REGISTRY_ACCOUNT} (`REGISTRY_USER` / `REGISTRY_PASSWORD`):
 *
 * 1. Refuses to run unless the anonymous login is in `TENANT` and the registry login in
 *    `REGISTRY`, so the source can never be the destination.
 * 2. Exits at once when the marker key `registry-object-store` in the `di-platform-migrations`
 *    KV bucket of `REGISTRY` says `complete`.
 * 3. Copies every live object whose name, size and SHA-256 digest is not already in the
 *    destination, one at a time through a temporary file.
 * 4. Lists both stores again and fails unless every source object is in the destination with the
 *    same size and digest (NATS computes the digest on put, so equal digests mean equal bytes).
 * 5. Deletes the source store, then writes the marker.
 *
 * Every step is safe to repeat: a rerun after a failure copies only what is missing, and a rerun
 * after step 5 stops at step 2 (or, if the marker write failed, finds no source and writes it).
 * The password is passed to the CLI through its environment, never on a command line or in output.
 */
export const REGISTRY_NATS_MIGRATION_SCRIPT = `set -euo pipefail
bucket=${REGISTRY_BUCKET}
stream="OBJ_$bucket"
marker_bucket=di-platform-migrations
marker_key=registry-object-store
tab="$(printf '\\t')"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "registry migration: $*" >&2; exit 1; }
src() { env -u NATS_USER -u NATS_PASSWORD nats "$@"; }
dst() { NATS_USER="$REGISTRY_USER" NATS_PASSWORD="$REGISTRY_PASSWORD" nats "$@"; }
account() { "$@" account info | sed -n 's/^ *Account: \\([^ ]*\\) .*/\\1/p'; }
has_stream() { printf '%s\\n' "$1" | grep -qxF "$2"; }
# Live objects of the store as sorted "name<TAB>size<TAB>digest" lines.
objects() {
  "$1" stream subjects "$stream" "\\$O.$bucket.M.>" --json | jq -r 'keys[]' > "$work/subjects"
  while read -r subject; do
    "$1" stream get "$stream" --last-for "$subject" --json |
      jq -r '.data | @base64d | fromjson | select(.deleted != true) | [.name, (.size | tostring), .digest] | @tsv'
  done < "$work/subjects" | sort
}

[ "$(account src)" = ${NATS_TENANT_ACCOUNT} ] || fail "the anonymous login is not in the ${NATS_TENANT_ACCOUNT} account"
[ "$(account dst)" = ${NATS_REGISTRY_ACCOUNT} ] || fail "the registry login is not in the ${NATS_REGISTRY_ACCOUNT} account"

dst_streams="$(dst stream ls --names)"
if has_stream "$dst_streams" "KV_$marker_bucket" &&
  [ "$(dst kv get "$marker_bucket" "$marker_key" --raw 2>/dev/null || true)" = complete ]; then
  echo "registry migration: already complete"
  exit 0
fi

src_streams="$(src stream ls --names)"
if has_stream "$src_streams" "$stream"; then
  has_stream "$dst_streams" "$stream" || dst object add "$bucket" >/dev/null
  objects src > "$work/source"
  objects dst > "$work/destination"
  copied=0
  while IFS="$tab" read -r name size digest; do
    grep -qxF "$name$tab$size$tab$digest" "$work/destination" && continue
    rm -f "$work/object"
    src object get "$bucket" "$name" -O "$work/object" --no-progress -f >/dev/null
    dst object put "$bucket" "$work/object" --name "$name" --no-progress -f >/dev/null
    copied=$((copied + 1))
  done < "$work/source"
  rm -f "$work/object"
  objects src > "$work/source"
  objects dst > "$work/destination"
  missing="$(comm -23 "$work/source" "$work/destination" | wc -l)"
  [ "$missing" -eq 0 ] || fail "$missing objects differ between the source and the destination"
  total="$(wc -l < "$work/source")"
  bytes="$(awk -F "$tab" '{ s += $2 } END { print s + 0 }' "$work/source")"
  echo "registry migration: copied $copied, verified $total objects ($bytes bytes) by size and SHA-256"
  src object rm "$bucket" -f >/dev/null
  ! has_stream "$(src stream ls --names)" "$stream" || fail "the source store is still there"
  echo "registry migration: deleted the source store"
else
  echo "registry migration: no source store"
fi

has_stream "$(dst stream ls --names)" "KV_$marker_bucket" || dst kv add "$marker_bucket" >/dev/null
dst kv put "$marker_bucket" "$marker_key" complete >/dev/null
echo "registry migration: complete"
`;
