import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentIo,
  type AgentRequest,
  type ExecResult,
  encodeTermination,
  parseRequest,
  rcloneEnv,
  runAgent,
  sha256Prefixed,
} from '../src/run.ts';

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    kind: 'postgres',
    host: 'db.internal',
    port: '5432',
    bucket: 'tenant-alpha-backups',
    prefix: 'di-framework/alpha/orders/uid/20260927T020012Z',
    workdir: '/work',
    terminationLog: '/work/termination',
    gcKeys: '',
    endpoint: '',
    region: 'us-east-1',
    pgUser: 'app',
    pgDatabase: 'app',
    ...overrides,
  };
}

function harness(
  script: (argv: string[], opts?: { input?: string; env?: Record<string, string> }) => ExecResult,
) {
  const files = new Map<string, Uint8Array>();
  const calls: { argv: string[]; env?: Record<string, string>; input?: string }[] = [];
  const io: AgentIo = {
    async exec(argv, opts) {
      calls.push({ argv, env: opts?.env, input: opts?.input });
      return script(argv, opts);
    },
    async readFile(path) {
      const value = files.get(path);
      if (!value) throw new Error(`missing ${path}`);
      return value;
    },
    async writeFile(path, data) {
      files.set(path, typeof data === 'string' ? Buffer.from(data) : Buffer.from(data));
    },
    async remove(path) {
      files.delete(path);
    },
    async mkdir(path) {
      files.set(`${path}/.dir`, Buffer.from(''));
    },
  };
  return { io, files, calls };
}

function ok(): ExecResult {
  return { code: 0, stdout: '', stderr: '' };
}

function wrote(files: Map<string, Uint8Array>, path: string): string {
  return Buffer.from(files.get(path) ?? []).toString('utf8');
}

describe('termination and request parsing', () => {
  test('hashes bytes and keeps a short termination record', () => {
    expect(sha256Prefixed(Buffer.from('payload'))).toMatch(/^sha256:[0-9a-f]{64}$/);
    const huge = encodeTermination({
      ok: true,
      error: 'x'.repeat(5000),
      objectKey: 'k'.repeat(5000),
    });
    expect(Buffer.byteLength(huge)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(huge)).toEqual({ ok: false, error: 'ResultTooLarge' });
    const failed = encodeTermination({ ok: false, error: 'e'.repeat(5000) });
    expect(JSON.parse(failed).error).toHaveLength(180);
    const unnamed = encodeTermination({ ok: false, objectKey: 'k'.repeat(5000) });
    expect(JSON.parse(unnamed).error).toBe('Failed');
  });

  test('rejects an unknown kind and trims the object prefix', () => {
    expect(parseRequest({ BACKUP_KIND: 'mysql' })).toEqual({ ok: false, error: 'UnknownKind' });
    const parsed = parseRequest({
      BACKUP_KIND: 'gc',
      BACKUP_OBJECT_PREFIX: '/di-framework/alpha/',
      BACKUP_WORKDIR: '/var/tmp',
      TERMINATION_LOG: '/log',
    });
    expect(parsed).toMatchObject({
      kind: 'gc',
      prefix: 'di-framework/alpha',
      workdir: '/var/tmp',
      terminationLog: '/log',
      region: 'us-east-1',
      pgUser: 'app',
      pgDatabase: 'app',
    });
  });

  test('rclone env enables path-style only when an endpoint is set', () => {
    expect(rcloneEnv({ endpoint: '', region: '' })).toMatchObject({
      RCLONE_S3_PROVIDER: 'AWS',
      RCLONE_S3_ENV_AUTH: 'true',
      RCLONE_S3_REGION: 'us-east-1',
    });
    expect(rcloneEnv({ endpoint: '', region: '' }).RCLONE_S3_ENDPOINT).toBeUndefined();
    expect(rcloneEnv({ endpoint: 'http://rustfs.svc:9000', region: 'us-east-1' })).toMatchObject({
      RCLONE_S3_PROVIDER: 'Other',
      RCLONE_S3_ENDPOINT: 'http://rustfs.svc:9000',
      RCLONE_S3_FORCE_PATH_STYLE: 'true',
      RCLONE_S3_USE_UNSIGNED_PAYLOAD: 'true',
      RCLONE_S3_DISABLE_CHECKSUM: 'true',
      AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
      AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
    });
  });
});

describe('backup-agent kinds', () => {
  test('postgres dump uploads the custom dump and never puts the password on argv', async () => {
    const { io, files, calls } = harness((argv) => {
      if (argv[0] === 'pg_dump') {
        files.set(argv[argv.indexOf('-f') + 1] ?? '', Buffer.from('dump-bytes'));
        return ok();
      }
      return ok();
    });
    expect(await runAgent(request(), io)).toBe(0);
    const record = JSON.parse(wrote(files, '/work/termination')) as {
      ok: boolean;
      objectKey: string;
    };
    expect(record.ok).toBe(true);
    expect(record.objectKey).toBe('di-framework/alpha/orders/uid/20260927T020012Z/data.dump');
    const argv = calls.flatMap((call) => call.argv).join(' ');
    expect(argv).toContain('pg_dump');
    expect(argv).toContain('--no-owner');
    expect(argv).not.toContain('secret');
    expect(
      calls.some((call) => call.argv[0] === 'rclone' && call.env?.RCLONE_S3_ENV_AUTH === 'true'),
    ).toBe(true);
  });

  test('postgres retries a refused connection before reporting dump failure', async () => {
    const refused = harness(() => ({ code: 1, stdout: '', stderr: 'connection refused' }));
    expect(await runAgent(request(), refused.io)).toBe(1);
    expect(wrote(refused.files, '/work/termination')).toContain('DumpFailed');
    expect(refused.calls.filter((call) => call.argv[0] === 'pg_dump')).toHaveLength(8);
  }, 20000);

  test('postgres reports a dump failure and a missing target', async () => {
    const failed = harness(() => ({ code: 1, stdout: '', stderr: 'no' }));
    expect(await runAgent(request(), failed.io)).toBe(1);
    expect(wrote(failed.files, '/work/termination')).toContain('DumpFailed');
    const missing = harness(() => ok());
    expect(await runAgent(request({ host: '' }), missing.io)).toBe(1);
    expect(wrote(missing.files, '/work/termination')).toContain('MissingTarget');
    const upload = harness((argv) => {
      if (argv[0] === 'pg_dump') {
        upload.files.set(argv[argv.indexOf('-f') + 1] ?? '', Buffer.from('x'));
        return ok();
      }
      return { code: 1, stdout: '', stderr: 's3' };
    });
    expect(await runAgent(request(), upload.io)).toBe(1);
    expect(wrote(upload.files, '/work/termination')).toContain('UploadFailed');
  });

  test('manifest upload failure is separate from the data upload', async () => {
    let copies = 0;
    const { io, files } = harness((argv) => {
      if (argv[0] === 'pg_dump') {
        files.set(argv[argv.indexOf('-f') + 1] ?? '', Buffer.from('x'));
        return ok();
      }
      copies += 1;
      return copies === 1 ? ok() : { code: 1, stdout: '', stderr: 'manifest' };
    });
    expect(await runAgent(request({ prefix: '' }), io)).toBe(1);
    expect(wrote(files, '/work/termination')).toContain('UploadFailed');
  });

  test('redis dump uses --rdb', async () => {
    const { io, files, calls } = harness((argv) => {
      if (argv.includes('--rdb')) {
        files.set(argv[argv.indexOf('--rdb') + 1] ?? '', Buffer.from('rdb'));
      }
      return ok();
    });
    expect(await runAgent(request({ kind: 'redis', port: '6379' }), io)).toBe(0);
    expect(calls[0]?.argv).toContain('--rdb');
    expect(wrote(files, '/work/termination')).toContain('dump.rdb');
    const failed = harness(() => ({ code: 1, stdout: '', stderr: '' }));
    expect(await runAgent(request({ kind: 'redis', port: '6379' }), failed.io)).toBe(1);
  });

  test('nats dumps file-backed streams and rejects memory storage', async () => {
    const archive = (files: Map<string, Uint8Array>, argv: string[]) => {
      if (argv[0] === 'tar' && argv.includes('-cf')) {
        files.set(argv[argv.indexOf('-cf') + 1] ?? '', Buffer.from('tar-bytes'));
      }
      return ok();
    };
    const success = harness((argv) => {
      if (argv.includes('ls')) return { code: 0, stdout: '[{"name":"orders"}, ""]', stderr: '' };
      if (argv.includes('info')) return { code: 0, stdout: '{"storage":"file"}', stderr: '' };
      return archive(success.files, argv);
    });
    expect(await runAgent(request({ kind: 'nats', port: '4222' }), success.io)).toBe(0);

    const named = harness((argv) => {
      if (argv.includes('ls')) return { code: 0, stdout: '[{"name":"orders"}]', stderr: '' };
      if (argv.includes('info')) return { code: 0, stdout: '{"storage":"file"}', stderr: '' };
      return archive(named.files, argv);
    });
    expect(await runAgent(request({ kind: 'nats', port: '4222' }), named.io)).toBe(0);
    expect(wrote(named.files, '/work/termination')).toContain('js-backup.tar');

    const memory = harness((argv) => {
      if (argv.includes('ls')) return { code: 0, stdout: '["mem"]', stderr: '' };
      if (argv.includes('info')) return { code: 0, stdout: '{"storage":"memory"}', stderr: '' };
      return ok();
    });
    expect(await runAgent(request({ kind: 'nats', port: '4222' }), memory.io)).toBe(1);
    expect(wrote(memory.files, '/work/termination')).toContain('MemoryStoreUnsupported');

    const empty = harness((argv) => {
      if (argv.includes('ls')) return { code: 0, stdout: 'No Streams defined', stderr: '' };
      return archive(empty.files, argv);
    });
    expect(await runAgent(request({ kind: 'nats', port: '4222' }), empty.io)).toBe(0);

    const down = harness(() => ({ code: 1, stdout: '', stderr: 'offline' }));
    expect(await runAgent(request({ kind: 'nats', port: '4222' }), down.io)).toBe(1);

    const noStreams = harness((argv) =>
      argv.includes('ls')
        ? { code: 1, stdout: '', stderr: 'no streams' }
        : archive(noStreams.files, argv),
    );
    expect(await runAgent(request({ kind: 'nats', port: '4222' }), noStreams.io)).toBe(0);

    const infoFailed = harness((argv) =>
      argv.includes('ls')
        ? { code: 0, stdout: '["s"]', stderr: '' }
        : { code: 1, stdout: '', stderr: 'info' },
    );
    expect(await runAgent(request({ kind: 'nats', port: '4222' }), infoFailed.io)).toBe(1);

    const backupFailed = harness((argv) => {
      if (argv.includes('ls')) return { code: 0, stdout: '[]', stderr: '' };
      if (argv.includes('backup')) return { code: 1, stdout: '', stderr: 'backup' };
      return ok();
    });
    expect(await runAgent(request({ kind: 'nats', port: '4222' }), backupFailed.io)).toBe(1);

    const tarFailed = harness((argv) => {
      if (argv.includes('ls')) return { code: 0, stdout: '{', stderr: '' };
      if (argv[0] === 'tar') return { code: 1, stdout: '', stderr: 'tar' };
      return ok();
    });
    expect(await runAgent(request({ kind: 'nats', port: '4222' }), tarFailed.io)).toBe(1);

    const objectList = harness((argv) => {
      if (argv.includes('ls')) return { code: 0, stdout: '{"streams":[]}', stderr: '' };
      return archive(objectList.files, argv);
    });
    expect(await runAgent(request({ kind: 'nats', port: '4222' }), objectList.io)).toBe(0);
  });

  test('probe-empty follows the service port', async () => {
    const postgres = harness(() => ({ code: 0, stdout: '0\n', stderr: '' }));
    expect(await runAgent(request({ kind: 'probe-empty' }), postgres.io)).toBe(0);
    const filled = harness(() => ({ code: 0, stdout: '2\n', stderr: '' }));
    expect(await runAgent(request({ kind: 'probe-empty' }), filled.io)).toBe(1);
    expect(wrote(filled.files, '/work/termination')).toContain('TargetNotEmpty');
    const redis = harness(() => ({ code: 0, stdout: '0', stderr: '' }));
    expect(await runAgent(request({ kind: 'probe-empty', port: '6379' }), redis.io)).toBe(0);
    const nats = harness(() => ({ code: 0, stdout: '[]', stderr: '' }));
    expect(await runAgent(request({ kind: 'probe-empty', port: '4222' }), nats.io)).toBe(0);
    const named = harness(() => ({ code: 0, stdout: '["orders"]', stderr: '' }));
    expect(await runAgent(request({ kind: 'probe-empty', port: '4222' }), named.io)).toBe(1);
    const quiet = harness(() => ({ code: 1, stdout: '', stderr: 'no streams' }));
    expect(await runAgent(request({ kind: 'probe-empty', port: '4222' }), quiet.io)).toBe(0);
    const unknown = harness(() => ok());
    expect(await runAgent(request({ kind: 'probe-empty', port: '1' }), unknown.io)).toBe(1);
    expect(wrote(unknown.files, '/work/termination')).toContain('UnknownProbe');
    const offline = harness(() => ({ code: 1, stdout: '', stderr: 'down' }));
    expect(await runAgent(request({ kind: 'probe-empty' }), offline.io)).toBe(1);
    expect(wrote(offline.files, '/work/termination')).toContain('ProbeFailed');
    const missing = harness(() => ok());
    expect(await runAgent(request({ kind: 'probe-empty', host: '' }), missing.io)).toBe(1);
  });

  test('restores postgres, redis, and nats', async () => {
    const postgres = harness(() => ok());
    expect(await runAgent(request({ kind: 'restore-postgres' }), postgres.io)).toBe(0);
    expect(postgres.calls.some((call) => call.argv[0] === 'pg_restore')).toBe(true);
    const broken = harness((argv) =>
      argv[0] === 'pg_restore' ? { code: 1, stdout: '', stderr: 'restore' } : ok(),
    );
    expect(await runAgent(request({ kind: 'restore-postgres' }), broken.io)).toBe(1);

    const redis = harness((argv) =>
      argv[0] === 'rdb' ? { code: 0, stdout: '*1\r\n', stderr: '' } : ok(),
    );
    expect(await runAgent(request({ kind: 'restore-redis', port: '6379' }), redis.io)).toBe(0);
    expect(
      redis.calls.some((call) => call.argv.includes('--pipe') && call.input === '*1\r\n'),
    ).toBe(true);
    expect(redis.files.has('/work/dump.rdb')).toBe(false);
    const convert = harness((argv) =>
      argv[0] === 'rdb' ? { code: 1, stdout: '', stderr: 'rdb' } : ok(),
    );
    expect(await runAgent(request({ kind: 'restore-redis', port: '6379' }), convert.io)).toBe(1);
    const pipe = harness((argv) =>
      argv.includes('--pipe')
        ? { code: 1, stdout: '', stderr: 'pipe' }
        : { code: 0, stdout: 'RESP', stderr: '' },
    );
    expect(await runAgent(request({ kind: 'restore-redis', port: '6379' }), pipe.io)).toBe(1);

    const nats = harness(() => ok());
    expect(await runAgent(request({ kind: 'restore-nats', port: '4222' }), nats.io)).toBe(0);
    expect(nats.calls.some((call) => call.argv.includes('restore'))).toBe(true);
    expect(nats.files.has('/work/js-backup.tar')).toBe(false);
    const extract = harness((argv) =>
      argv[0] === 'tar' ? { code: 1, stdout: '', stderr: 'tar' } : ok(),
    );
    expect(await runAgent(request({ kind: 'restore-nats', port: '4222' }), extract.io)).toBe(1);
    const account = harness((argv) =>
      argv.includes('restore') ? { code: 1, stdout: '', stderr: 'restore' } : ok(),
    );
    expect(await runAgent(request({ kind: 'restore-nats', port: '4222' }), account.io)).toBe(1);
    const missing = harness(() => ({ code: 1, stdout: '', stderr: 'missing' }));
    expect(await runAgent(request({ kind: 'restore-postgres' }), missing.io)).toBe(1);
    expect(wrote(missing.files, '/work/termination')).toContain('DownloadFailed');
  });

  test('gc deletes listed keys and skips a blank list', async () => {
    const { io, calls, files } = harness(() => ok());
    expect(
      await runAgent(request({ kind: 'gc', gcKeys: 'a/data.dump\n\n b/data.dump \n' }), io),
    ).toBe(0);
    expect(calls.map((call) => call.argv.at(-1))).toEqual([
      ':s3:tenant-alpha-backups/a/data.dump',
      ':s3:tenant-alpha-backups/b/data.dump',
    ]);
    const none = harness(() => ok());
    expect(await runAgent(request({ kind: 'gc', gcKeys: '\n' }), none.io)).toBe(0);
    expect(none.calls).toHaveLength(0);
    const failed = harness(() => ({ code: 1, stdout: '', stderr: 'denied' }));
    expect(await runAgent(request({ kind: 'gc', gcKeys: 'a' }), failed.io)).toBe(1);
    expect(wrote(failed.files, '/work/termination')).toContain('GcFailed');
    const bucket = harness(() => ok());
    expect(await runAgent(request({ kind: 'gc', bucket: '' }), bucket.io)).toBe(1);
    expect(wrote(files, '/work/termination')).toContain('"format":"delete"');
  });
});

test('the process entrypoint writes a termination record via stub tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-agent-'));
  try {
    const bin = join(root, 'bin');
    const { mkdir, chmod } = await import('node:fs/promises');
    await mkdir(bin);
    await writeFile(
      join(bin, 'pg_dump'),
      '#!/bin/sh\nwhile [ "$1" != "-f" ]; do shift; done; shift; printf payload > "$1"\n',
    );
    await writeFile(join(bin, 'rclone'), '#!/bin/sh\nexit 0\n');
    await chmod(join(bin, 'pg_dump'), 0o755);
    await chmod(join(bin, 'rclone'), 0o755);
    const log = join(root, 'termination');
    const child = Bun.spawn([process.execPath, 'src/main.ts'], {
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        BACKUP_KIND: 'postgres',
        BACKUP_HOST: 'db',
        BACKUP_PORT: '5432',
        BACKUP_BUCKET: 'bucket',
        BACKUP_OBJECT_PREFIX: 'prefix',
        BACKUP_WORKDIR: root,
        TERMINATION_LOG: log,
        PGPASSWORD: 'super-secret-password',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await child.exited;
    const record = JSON.parse(await readFile(log, 'utf8')) as { ok: boolean; tool: string };
    expect(code).toBe(0);
    expect(record.ok).toBe(true);
    expect(record.tool).toBe('pg_dump');
    expect(JSON.stringify(record)).not.toContain('super-secret-password');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
