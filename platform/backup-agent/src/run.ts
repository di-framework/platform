import { createHash } from 'node:crypto';
import { backupVolume, probePlacement, restoreVolume } from './volume.ts';

export const TERMINATION_LIMIT = 4096;

export const BACKUP_KINDS = [
  'postgres',
  'redis',
  'nats',
  'gc',
  'probe-empty',
  'restore-postgres',
  'restore-redis',
  'restore-nats',
  'workload-volume',
  'restore-workload-volume',
  'probe-placement',
] as const;

export type BackupKind = (typeof BACKUP_KINDS)[number];

export interface Termination {
  ok: boolean;
  digest?: string;
  bytes?: number;
  objectKey?: string;
  tool?: string;
  format?: string;
  error?: string;
  /** Workload volumes (#232). */
  fileCount?: number;
  encfsKcv?: string;
  imageDigest?: string;
  replacedPath?: string;
  /** A restore that stopped part-way: the staging directory it left, relative to the root. */
  restoringPath?: string;
}

export interface AgentRequest {
  kind: BackupKind;
  host: string;
  port: string;
  bucket: string;
  prefix: string;
  workdir: string;
  terminationLog: string;
  gcKeys: string;
  endpoint: string;
  region: string;
  pgUser: string;
  pgDatabase: string;
  destinationType?: 's3' | 'pvc';
  pvcMountPath?: string;
  /** workload-volume: the read-only hostPath mount of the volume. */
  sourceDir?: string;
  workloadName?: string;
  storageKey?: string;
  sourceImage?: string;
  /** UTC stamp the operator chose; it names the backup and any `.replaced-` directory. */
  stamp?: string;
  /** restore-workload-volume: the read-write mount of `<root>/di-tenants/<uid>/workloads`. */
  targetRoot?: string;
  force?: boolean;
  /** The KCV the restored marker must carry, when the operator names one. */
  expectedKcv?: string;
  /** probe-placement: directories that must exist on this node, `:`-separated. */
  probePaths?: string;
}

export interface TreeEntry {
  /** Relative to the scanned root, `/`-separated. */
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mode: number;
  mtimeMs: number;
  /** Userspace cannot set ctime: with ino it tells a rewritten file from an untouched one. */
  ctimeMs: number;
  ino: number;
  uid: number;
  gid: number;
}

/** One end of {@link AgentIo.pipe}: a command's stdout/stdin, or a file. */
export type PipeEnd = { argv: string[]; env?: Record<string, string> } | { file: string };

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AgentIo {
  exec(
    argv: string[],
    opts?: { input?: string; env?: Record<string, string> },
  ): Promise<ExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** Delete one file (never a directory). A missing file is not an error. */
  unlink(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Every entry under `root`, depth first, links not followed. */
  scan(root: string): Promise<TreeEntry[]>;
  /** Hex sha256 of a file, streamed. */
  hash(path: string): Promise<string>;
  /** Entry names directly in `path`. */
  list(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  /** Set the owner of one entry, never following a link. */
  chown(path: string, uid: number, gid: number): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
  /**
   * Stream `from` into `to` (or nowhere), showing every chunk to `inspect` on the way. Nothing
   * is buffered whole: a volume can be far larger than the Job's memory. A non-zero code, or
   * `inspect` throwing, fails the pipe.
   */
  pipe(
    from: PipeEnd,
    to: PipeEnd | undefined,
    inspect: (chunk: Uint8Array) => void,
  ): Promise<{ code: number; stderr: string }>;
}

export function encodeTermination(value: Termination): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= TERMINATION_LIMIT) return json;
  const error = (value.ok ? 'ResultTooLarge' : (value.error ?? 'Failed')).slice(0, 180);
  return JSON.stringify({ ok: false, error });
}

export function sha256Prefixed(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function rcloneEnv(
  request: Pick<AgentRequest, 'endpoint' | 'region'>,
): Record<string, string> {
  const env: Record<string, string> = {
    // Provider AWS forces virtual-host style. Other keeps path style.
    // Unsigned payload avoids the SDK checksum trailer, which HTTP endpoints reject.
    RCLONE_S3_PROVIDER: request.endpoint ? 'Other' : 'AWS',
    RCLONE_S3_ENV_AUTH: 'true',
    RCLONE_S3_REGION: request.region || 'us-east-1',
    RCLONE_LOG_LEVEL: 'ERROR',
  };
  if (request.endpoint) {
    env.RCLONE_S3_ENDPOINT = request.endpoint;
    env.RCLONE_S3_FORCE_PATH_STYLE = 'true';
    env.RCLONE_S3_USE_UNSIGNED_PAYLOAD = 'true';
    env.RCLONE_S3_DISABLE_CHECKSUM = 'true';
    env.AWS_REQUEST_CHECKSUM_CALCULATION = 'when_required';
    env.AWS_RESPONSE_CHECKSUM_VALIDATION = 'when_required';
  }
  return env;
}

export function parseRequest(env: Record<string, string | undefined>): AgentRequest | Termination {
  const kind = env.BACKUP_KIND ?? '';
  if (!BACKUP_KINDS.includes(kind as BackupKind)) {
    return { ok: false, error: 'UnknownKind' };
  }
  return {
    kind: kind as BackupKind,
    host: env.BACKUP_HOST ?? '',
    port: env.BACKUP_PORT ?? '',
    bucket: env.BACKUP_BUCKET ?? '',
    prefix: (env.BACKUP_OBJECT_PREFIX ?? '').replace(/^\/+|\/+$/g, ''),
    workdir: env.BACKUP_WORKDIR ?? '/tmp',
    terminationLog: env.TERMINATION_LOG ?? '/dev/termination-log',
    gcKeys: env.BACKUP_GC_KEYS ?? '',
    endpoint: env.BACKUP_ENDPOINT ?? '',
    region: env.BACKUP_REGION ?? 'us-east-1',
    pgUser: env.PGUSER ?? 'app',
    pgDatabase: env.PGDATABASE ?? 'app',
    destinationType: env.BACKUP_DESTINATION_TYPE === 'pvc' ? 'pvc' : 's3',
    pvcMountPath: env.BACKUP_PVC_MOUNT_PATH,
    sourceDir: env.BACKUP_SOURCE_DIR,
    workloadName: env.BACKUP_WORKLOAD_NAME,
    storageKey: env.BACKUP_STORAGE_KEY,
    sourceImage: env.BACKUP_SOURCE_IMAGE,
    stamp: env.BACKUP_STAMP,
    targetRoot: env.BACKUP_TARGET_ROOT,
    force: env.BACKUP_FORCE === 'true',
    expectedKcv: env.BACKUP_EXPECTED_KCV || undefined,
    probePaths: env.BACKUP_PROBE_PATHS,
  };
}

export function remote(request: AgentRequest, name: string): string {
  const key = request.prefix ? `${request.prefix}/${name}` : name;
  return `:s3:${request.bucket}/${key}`;
}

export function objectKey(request: AgentRequest, name: string): string {
  return request.prefix ? `${request.prefix}/${name}` : name;
}

export async function finish(io: AgentIo, log: string, value: Termination): Promise<number> {
  await io.writeFile(log, encodeTermination(value));
  return value.ok ? 0 : 1;
}

async function copyToS3(
  io: AgentIo,
  request: AgentRequest,
  file: string,
  name: string,
): Promise<ExecResult> {
  return io.exec(['rclone', 'copyto', file, remote(request, name)], { env: rcloneEnv(request) });
}

/** Object keys come from Backup status. Refuse anything that could leave the claim. */
export function safeKey(key: string): boolean {
  return (
    !!key && !key.startsWith('/') && !key.split('/').some((part) => part === '..' || part === '.')
  );
}

export function pvcPath(request: AgentRequest, name: string): string | undefined {
  const key = objectKey(request, name);
  if (!request.pvcMountPath || !safeKey(key)) return undefined;
  return `${request.pvcMountPath}/${key}`;
}

/**
 * Copy with `cp`, not through memory: a dump can be several GiB and the Job has 128Mi. The file
 * lands under a `.partial` name and is renamed into place, so a reader never sees half of it.
 */
async function copyToPvc(
  io: AgentIo,
  request: AgentRequest,
  file: string,
  name: string,
): Promise<ExecResult> {
  const target = pvcPath(request, name);
  if (!target) return { code: 1, stdout: '', stderr: 'PvcPathInvalid' };
  try {
    await io.mkdir(target.slice(0, target.lastIndexOf('/')));
  } catch (err) {
    return { code: 1, stdout: '', stderr: String(err) };
  }
  const partial = `${target}.partial`;
  const discard = async (result: ExecResult): Promise<ExecResult> => {
    await io.unlink(partial).catch(() => undefined);
    return result;
  };
  const copied = await io.exec(['cp', file, partial]);
  if (copied.code !== 0) return discard(copied);
  // Flush the copy to disk before the rename, so a node crash cannot leave a renamed empty file.
  const flushed = await io.exec(['sync', partial]);
  if (flushed.code !== 0) return discard(flushed);
  const moved = await io.exec(['mv', '-f', partial, target]);
  if (moved.code !== 0) return discard(moved);
  // Make the rename itself durable. Best effort: some `sync` builds only flush everything.
  await io.exec(['sync', target.slice(0, target.lastIndexOf('/'))]);
  return moved;
}

function manifest(tool: string, format: string, digest: string): string {
  return JSON.stringify({
    apiVersion: 'platform.di-framework.dev/v1alpha1',
    kind: 'BackupManifest',
    tool,
    format,
    digest,
  });
}

async function uploadDump(
  io: AgentIo,
  request: AgentRequest,
  file: string,
  name: string,
  tool: string,
  format: string,
): Promise<number> {
  const bytes = await io.readFile(file);
  const digest = sha256Prefixed(bytes);
  const meta = `${request.workdir}/manifest.json`;
  await io.writeFile(meta, manifest(tool, format, digest));
  const data = await put(io, request, file, name);
  if (data.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'UploadFailed' });
  const side = await put(io, request, meta, 'manifest.json');
  if (side.code !== 0) {
    // No manifest means no objectKey on the Backup, so retention would never reclaim the data.
    const orphan = request.destinationType === 'pvc' ? pvcPath(request, name) : undefined;
    if (orphan) await io.unlink(orphan).catch(() => undefined);
    return finish(io, request.terminationLog, { ok: false, error: 'UploadFailed' });
  }
  return finish(io, request.terminationLog, {
    ok: true,
    digest,
    bytes: bytes.byteLength,
    objectKey: objectKey(request, name),
    tool,
    format,
  });
}

function requireTarget(request: AgentRequest): string | undefined {
  if (!request.host || !request.port) return 'MissingTarget';
  if (request.destinationType === 'pvc') return request.pvcMountPath ? undefined : 'MissingClaim';
  if (!request.bucket) return 'MissingBucket';
  return undefined;
}

// `no servers available` is how the nats CLI reports a connection it could not open (#388).
const CONNECT_FAILURE =
  /could not connect|connection refused|timeout expired|name or service not known|temporary failure in name resolution|i\/o timeout|no servers available/i;
const CONNECT_ATTEMPTS = 8;

/**
 * kube-router programs a new pod into the source ipset after the container starts, so a Job's
 * first connection to a backing service can be refused. Only failures to connect are retried.
 */
async function execConnected(
  io: AgentIo,
  argv: string[],
  opts?: { input?: string },
): Promise<ExecResult> {
  let result: ExecResult = { code: 1, stdout: '', stderr: '' };
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    result = await io.exec(argv, opts);
    if (result.code === 0 || !CONNECT_FAILURE.test(`${result.stderr}\n${result.stdout}`))
      return result;
    if (attempt < CONNECT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return result;
}

/**
 * Restores are not idempotent (a rerun appends again), so they never go through `execConnected`:
 * a read-only probe waits for the connection, then the restore runs exactly once.
 */
async function probeConnected(io: AgentIo, argv: string[]): Promise<boolean> {
  return (await execConnected(io, argv)).code === 0;
}

async function dumpPostgres(io: AgentIo, request: AgentRequest): Promise<number> {
  const file = `${request.workdir}/data.dump`;
  const result = await execConnected(io, [
    'pg_dump',
    '-h',
    request.host,
    '-p',
    request.port,
    '-U',
    request.pgUser,
    '-d',
    request.pgDatabase,
    '-Fc',
    '--no-owner',
    '--no-acl',
    '-f',
    file,
  ]);
  if (result.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'DumpFailed' });
  return uploadDump(io, request, file, 'data.dump', 'pg_dump', 'custom');
}

async function dumpRedis(io: AgentIo, request: AgentRequest): Promise<number> {
  const file = `${request.workdir}/dump.rdb`;
  const result = await execConnected(io, [
    'redis-cli',
    '-h',
    request.host,
    '-p',
    request.port,
    '--rdb',
    file,
  ]);
  if (result.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'DumpFailed' });
  return uploadDump(io, request, file, 'dump.rdb', 'redis-cli', 'rdb');
}

function streamNames(stdout: string): string[] | 'empty' {
  const trimmed = stdout.trim();
  if (!trimmed || /no streams/i.test(trimmed)) return 'empty';
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) =>
        typeof item === 'string' ? item : String((item as { name?: string }).name ?? ''),
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function dumpNats(io: AgentIo, request: AgentRequest): Promise<number> {
  const server = `${request.host}:${request.port}`;
  const listed = await execConnected(io, ['nats', '--server', server, 'stream', 'ls', '--json']);
  if (listed.code !== 0 && !/no streams/i.test(`${listed.stdout}\n${listed.stderr}`)) {
    return finish(io, request.terminationLog, { ok: false, error: 'DumpFailed' });
  }
  const names = listed.code === 0 ? streamNames(listed.stdout) : 'empty';
  if (names !== 'empty') {
    for (const name of names) {
      const info = await io.exec(['nats', '--server', server, 'stream', 'info', name, '--json']);
      if (info.code !== 0) {
        return finish(io, request.terminationLog, { ok: false, error: 'DumpFailed' });
      }
      if (/"storage"\s*:\s*"memory"/i.test(info.stdout)) {
        return finish(io, request.terminationLog, { ok: false, error: 'MemoryStoreUnsupported' });
      }
    }
  }
  const dir = `${request.workdir}/js-backup`;
  await io.mkdir(dir);
  const backup = await execConnected(io, [
    'nats',
    '--server',
    server,
    'account',
    'backup',
    '--consumers',
    dir,
  ]);
  if (backup.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'DumpFailed' });
  const archive = `${request.workdir}/js-backup.tar`;
  const tar = await io.exec(['tar', '-C', request.workdir, '-cf', archive, 'js-backup']);
  if (tar.code !== 0) return finish(io, request.terminationLog, { ok: false, error: 'DumpFailed' });
  await io.remove(dir);
  return uploadDump(io, request, archive, 'js-backup.tar', 'nats', 'account-backup');
}

async function probe(io: AgentIo, request: AgentRequest): Promise<number> {
  if (!request.host || !request.port) {
    return finish(io, request.terminationLog, { ok: false, error: 'MissingTarget' });
  }
  let result: ExecResult;
  if (request.port === '5432') {
    result = await execConnected(io, [
      'psql',
      '-h',
      request.host,
      '-p',
      request.port,
      '-U',
      request.pgUser,
      '-d',
      request.pgDatabase,
      '-Atqc',
      "SELECT count(*) FROM pg_tables WHERE schemaname='public'",
    ]);
  } else if (request.port === '6379') {
    result = await execConnected(io, [
      'redis-cli',
      '-h',
      request.host,
      '-p',
      request.port,
      'DBSIZE',
    ]);
  } else if (request.port === '4222') {
    result = await execConnected(io, [
      'nats',
      '--server',
      `${request.host}:${request.port}`,
      'stream',
      'ls',
      '--json',
    ]);
  } else {
    return finish(io, request.terminationLog, { ok: false, error: 'UnknownProbe' });
  }
  if (result.code !== 0 && !/no streams/i.test(`${result.stdout}\n${result.stderr}`)) {
    return finish(io, request.terminationLog, { ok: false, error: 'ProbeFailed' });
  }
  const listed = request.port === '4222' ? streamNames(result.stdout) : undefined;
  const empty =
    request.port === '4222'
      ? listed === 'empty' || listed?.length === 0 || /no streams/i.test(result.stderr)
      : result.stdout.trim() === '0';
  if (!empty) return finish(io, request.terminationLog, { ok: false, error: 'TargetNotEmpty' });
  return finish(io, request.terminationLog, {
    ok: true,
    tool: 'probe-empty',
    format: request.port,
  });
}

/** Store a local file as `<prefix>/<name>` on the destination. */
export function put(
  io: AgentIo,
  request: AgentRequest,
  file: string,
  name: string,
): Promise<ExecResult> {
  return request.destinationType === 'pvc'
    ? copyToPvc(io, request, file, name)
    : copyToS3(io, request, file, name);
}

/** Fetch `<prefix>/<name>` from the destination into a local file. */
export async function get(
  io: AgentIo,
  request: AgentRequest,
  name: string,
  file: string,
): Promise<ExecResult> {
  if (request.destinationType !== 'pvc') {
    return io.exec(['rclone', 'copyto', remote(request, name), file], { env: rcloneEnv(request) });
  }
  const source = pvcPath(request, name);
  if (!source) return { code: 1, stdout: '', stderr: 'PvcPathInvalid' };
  return io.exec(['cp', source, file]);
}

async function download(
  io: AgentIo,
  request: AgentRequest,
  name: string,
  file: string,
): Promise<number | undefined> {
  const result = await get(io, request, name, file);
  if (result.stderr === 'PvcPathInvalid')
    return finish(io, request.terminationLog, { ok: false, error: 'PvcPathInvalid' });
  if (result.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'DownloadFailed' });
  return undefined;
}

async function restorePostgres(io: AgentIo, request: AgentRequest): Promise<number> {
  const file = `${request.workdir}/data.dump`;
  const failed = await download(io, request, 'data.dump', file);
  if (failed !== undefined) return failed;
  const reachable = await probeConnected(io, [
    'psql',
    '-h',
    request.host,
    '-p',
    request.port,
    '-U',
    request.pgUser,
    '-d',
    request.pgDatabase,
    '-c',
    'SELECT 1',
  ]);
  if (!reachable) return finish(io, request.terminationLog, { ok: false, error: 'RestoreFailed' });
  const result = await io.exec([
    'pg_restore',
    '-h',
    request.host,
    '-p',
    request.port,
    '-U',
    request.pgUser,
    '-d',
    request.pgDatabase,
    '--no-owner',
    '--no-acl',
    file,
  ]);
  if (result.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'RestoreFailed' });
  return finish(io, request.terminationLog, { ok: true, tool: 'pg_restore', format: 'custom' });
}

async function restoreRedis(io: AgentIo, request: AgentRequest): Promise<number> {
  const rdb = `${request.workdir}/dump.rdb`;
  const resp = `${request.workdir}/dump.resp`;
  const failed = await download(io, request, 'dump.rdb', rdb);
  if (failed !== undefined) return failed;
  const converted = await io.exec(['rdb', '--command', 'protocol', rdb]);
  if (converted.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'RestoreFailed' });
  await io.writeFile(resp, converted.stdout);
  await io.remove(rdb);
  const reachable = await probeConnected(io, [
    'redis-cli',
    '-h',
    request.host,
    '-p',
    request.port,
    'PING',
  ]);
  if (!reachable) return finish(io, request.terminationLog, { ok: false, error: 'RestoreFailed' });
  const loaded = await io.exec(['redis-cli', '-h', request.host, '-p', request.port, '--pipe'], {
    input: converted.stdout,
  });
  if (loaded.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'RestoreFailed' });
  return finish(io, request.terminationLog, { ok: true, tool: 'redis-cli', format: 'resp' });
}

async function restoreNats(io: AgentIo, request: AgentRequest): Promise<number> {
  const archive = `${request.workdir}/js-backup.tar`;
  const failed = await download(io, request, 'js-backup.tar', archive);
  if (failed !== undefined) return failed;
  const extracted = await io.exec(['tar', '-C', request.workdir, '-xf', archive]);
  if (extracted.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'RestoreFailed' });
  await io.remove(archive);
  const server = `${request.host}:${request.port}`;
  const reachable = await probeConnected(io, ['nats', '--server', server, 'account', 'info']);
  if (!reachable) return finish(io, request.terminationLog, { ok: false, error: 'RestoreFailed' });
  const restored = await io.exec([
    'nats',
    '--server',
    server,
    'account',
    'restore',
    `${request.workdir}/js-backup`,
  ]);
  if (restored.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'RestoreFailed' });
  return finish(io, request.terminationLog, { ok: true, tool: 'nats', format: 'account-backup' });
}

/** Leftovers older than this are from a dead Job, not a running one. */
const STALE_MINUTES = '1440';

/**
 * Pods killed mid-copy leave `*.partial` files and data files without a manifest. Neither has
 * an objectKey on a Backup, so retention cannot name them. Best effort: a failed sweep never
 * fails the gc.
 *
 * The sweep stays inside the destination's own tree: `<mount>/<prefix>`, files exactly at
 * `<service>/<uid>/<stamp>/<file>` depth. It never follows symlinks and skips `lost+found`.
 */
const SWEEP_SCRIPT = `
root="$1"; minutes="$2"; mount="$3"
[ -d "$root" ] && [ ! -L "$root" ] || exit 0
# Refuse the claim root itself, and any root that resolves outside the mount (symlinked segment).
real=$(cd "$root" 2>/dev/null && pwd -P) || exit 0
base=$(cd "$mount" 2>/dev/null && pwd -P) || exit 0
[ "$real" != "$base" ] || exit 0
case "$real" in "$base"/*) ;; *) exit 0 ;; esac
root="$real"
find "$root" -mindepth 4 -maxdepth 4 -type f ! -path "$root/lost+found/*" -mmin +"$minutes" |
while IFS= read -r f; do
  case "$f" in
    *.partial) rm -f "$f" ;;
    */manifest.json) ;;
    *) [ -e "$(dirname "$f")/manifest.json" ] || rm -f "$f" ;;
  esac
done
`;

export async function sweepPvc(
  io: AgentIo,
  mount: string,
  prefixes: Iterable<string>,
): Promise<void> {
  for (const prefix of prefixes) {
    const clean = prefix.split('/').filter(Boolean).join('/');
    if (!clean) continue; // never sweep the claim root
    await io.exec(['sh', '-c', SWEEP_SCRIPT, 'sweep', `${mount}/${clean}`, STALE_MINUTES, mount]);
  }
}

/** A key is `<prefix>/<service>/<uid>/<stamp>/<file>`; the prefix is what remains after those 4. */
function keyPrefix(key: string): string | undefined {
  const parts = key.split('/');
  return parts.length >= 4 ? parts.slice(0, -4).filter(Boolean).join('/') : undefined;
}

async function gcPvc(io: AgentIo, request: AgentRequest): Promise<number> {
  if (!request.pvcMountPath) {
    return finish(io, request.terminationLog, { ok: false, error: 'PvcMountPathNotSet' });
  }
  const keys = request.gcKeys
    .split('\n')
    .map((key) => key.trim())
    .filter(Boolean);
  if (!keys.every(safeKey)) {
    return finish(io, request.terminationLog, { ok: false, error: 'PvcPathInvalid' });
  }
  const prefixes = new Set<string>();
  for (const key of keys) {
    const prefix = keyPrefix(key);
    if (prefix !== undefined) prefixes.add(prefix);
  }
  await sweepPvc(io, request.pvcMountPath, prefixes);
  const directories = new Set<string>();
  for (const key of keys) {
    try {
      await io.unlink(`${request.pvcMountPath}/${key}`);
    } catch (_err) {
      return finish(io, request.terminationLog, { ok: false, error: 'GcFailed' });
    }
    // Every ancestor below the claim root, deepest first: `<source>/<uid>/<stamp>` and up.
    const parts = key.split('/').slice(0, -1);
    for (let depth = parts.length; depth > 0; depth--) {
      directories.add(parts.slice(0, depth).join('/'));
    }
  }
  // rmdir refuses a non-empty directory, so only emptied ones go.
  const deepestFirst = [...directories].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const directory of deepestFirst) {
    await io.exec(['rmdir', `${request.pvcMountPath}/${directory}`]);
  }
  return finish(io, request.terminationLog, { ok: true, tool: 'rm', format: 'delete' });
}

const RCLONE_NOT_FOUND = 4;

async function gc(io: AgentIo, request: AgentRequest): Promise<number> {
  if (request.destinationType === 'pvc') {
    return gcPvc(io, request);
  }
  if (!request.bucket)
    return finish(io, request.terminationLog, { ok: false, error: 'MissingBucket' });
  const keys = request.gcKeys
    .split('\n')
    .map((key) => key.trim())
    .filter(Boolean);
  for (const key of keys) {
    const result = await io.exec(['rclone', 'deletefile', `:s3:${request.bucket}/${key}`], {
      env: rcloneEnv(request),
    });
    // Exit 4 is rclone's "file not found": already deleted, or never written by a failed copy.
    if (result.code !== 0 && result.code !== RCLONE_NOT_FOUND)
      return finish(io, request.terminationLog, { ok: false, error: 'GcFailed' });
  }
  return finish(io, request.terminationLog, { ok: true, tool: 'rclone', format: 'delete' });
}

const SERVICE_KINDS: readonly BackupKind[] = [
  'postgres',
  'redis',
  'nats',
  'restore-postgres',
  'restore-redis',
  'restore-nats',
];

export async function runAgent(request: AgentRequest, io: AgentIo): Promise<number> {
  if (SERVICE_KINDS.includes(request.kind)) {
    const missing = requireTarget(request);
    if (missing) return finish(io, request.terminationLog, { ok: false, error: missing });
  }
  switch (request.kind) {
    case 'postgres':
      return dumpPostgres(io, request);
    case 'redis':
      return dumpRedis(io, request);
    case 'nats':
      return dumpNats(io, request);
    case 'gc':
      return gc(io, request);
    case 'probe-empty':
      return probe(io, request);
    case 'restore-postgres':
      return restorePostgres(io, request);
    case 'restore-redis':
      return restoreRedis(io, request);
    case 'restore-nats':
      return restoreNats(io, request);
    case 'workload-volume':
      return backupVolume(io, request);
    case 'restore-workload-volume':
      return restoreVolume(io, request);
    case 'probe-placement':
      return probePlacement(io, request);
  }
}
