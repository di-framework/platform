import { createHash } from 'node:crypto';

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
}

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
  mkdir(path: string): Promise<void>;
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
  };
}

function remote(request: AgentRequest, name: string): string {
  const key = request.prefix ? `${request.prefix}/${name}` : name;
  return `:s3:${request.bucket}/${key}`;
}

function objectKey(request: AgentRequest, name: string): string {
  return request.prefix ? `${request.prefix}/${name}` : name;
}

async function finish(io: AgentIo, log: string, value: Termination): Promise<number> {
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
  const data = await copyToS3(io, request, file, name);
  if (data.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'UploadFailed' });
  const side = await copyToS3(io, request, meta, 'manifest.json');
  if (side.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'UploadFailed' });
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
  if (!request.bucket) return 'MissingBucket';
  return undefined;
}

const CONNECT_FAILURE =
  /could not connect|connection refused|timeout expired|name or service not known|temporary failure in name resolution|i\/o timeout/i;
const CONNECT_ATTEMPTS = 8;

/** kube-router programs a new pod into the source ipset after the container starts. */
async function execConnected(io: AgentIo, argv: string[]): Promise<ExecResult> {
  let result: ExecResult = { code: 1, stdout: '', stderr: '' };
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    result = await io.exec(argv);
    if (result.code === 0 || !CONNECT_FAILURE.test(`${result.stderr}\n${result.stdout}`))
      return result;
    if (attempt < CONNECT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return result;
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
    result = await io.exec([
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
    result = await io.exec(['redis-cli', '-h', request.host, '-p', request.port, 'DBSIZE']);
  } else if (request.port === '4222') {
    result = await io.exec([
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

async function download(
  io: AgentIo,
  request: AgentRequest,
  name: string,
  file: string,
): Promise<number | undefined> {
  const result = await io.exec(['rclone', 'copyto', remote(request, name), file], {
    env: rcloneEnv(request),
  });
  if (result.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'DownloadFailed' });
  return undefined;
}

async function restorePostgres(io: AgentIo, request: AgentRequest): Promise<number> {
  const file = `${request.workdir}/data.dump`;
  const failed = await download(io, request, 'data.dump', file);
  if (failed !== undefined) return failed;
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
  const restored = await io.exec([
    'nats',
    '--server',
    `${request.host}:${request.port}`,
    'account',
    'restore',
    `${request.workdir}/js-backup`,
  ]);
  if (restored.code !== 0)
    return finish(io, request.terminationLog, { ok: false, error: 'RestoreFailed' });
  return finish(io, request.terminationLog, { ok: true, tool: 'nats', format: 'account-backup' });
}

async function gc(io: AgentIo, request: AgentRequest): Promise<number> {
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
    if (result.code !== 0)
      return finish(io, request.terminationLog, { ok: false, error: 'GcFailed' });
  }
  return finish(io, request.terminationLog, { ok: true, tool: 'rclone', format: 'delete' });
}

export async function runAgent(request: AgentRequest, io: AgentIo): Promise<number> {
  if (request.kind !== 'gc' && request.kind !== 'probe-empty') {
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
  }
}
