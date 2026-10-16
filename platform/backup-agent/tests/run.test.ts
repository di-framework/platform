import { describe, expect, spyOn, test } from 'bun:test';
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
  safeKey,
  sha256Prefixed,
  sweepPvc,
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
    async unlink(path) {
      files.delete(path);
    },
    async mkdir(path) {
      files.set(`${path}/.dir`, Buffer.from(''));
    },
    async scan() {
      return [];
    },
    async hash() {
      return '';
    },
    async list() {
      return [];
    },
    async rename() {},
    async chown() {},
    async isDirectory(path) {
      return files.has(`${path}/.dir`);
    },
    async pipe() {
      return { code: 0, stderr: '' };
    },
  };
  return { io, files, calls };
}

function ok(): ExecResult {
  return { code: 0, stdout: '', stderr: '' };
}

/** `cp`, `mv`, and `rmdir` against the in-memory files of {@link harness}. */
function fsTools(files: Map<string, Uint8Array>) {
  return (argv: string[]): ExecResult => {
    const [tool, ...args] = argv;
    if (tool === 'cp' || tool === 'mv') {
      const [from, to] = args.filter((arg) => !arg.startsWith('-'));
      const value = files.get(from ?? '');
      if (!value || !to) return { code: 1, stdout: '', stderr: 'No such file' };
      files.set(to, value);
      if (tool === 'mv') files.delete(from ?? '');
    }
    return ok();
  };
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
    const pvc = parseRequest({
      BACKUP_KIND: 'postgres',
      BACKUP_DESTINATION_TYPE: 'pvc',
      BACKUP_PVC_MOUNT_PATH: '/mnt/backup',
    });
    expect(pvc).toMatchObject({
      kind: 'postgres',
      destinationType: 'pvc',
      pvcMountPath: '/mnt/backup',
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
    // The agent waits 1 s between attempts; record the waits instead of sleeping through them.
    const waits: (number | undefined)[] = [];
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      waits.push(delay);
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout);
    try {
      const refused = harness(() => ({ code: 1, stdout: '', stderr: 'connection refused' }));
      expect(await runAgent(request(), refused.io)).toBe(1);
      expect(wrote(refused.files, '/work/termination')).toContain('DumpFailed');
      expect(refused.calls.filter((call) => call.argv[0] === 'pg_dump')).toHaveLength(8);
    } finally {
      timer.mockRestore();
    }
    expect(waits).toEqual(new Array(7).fill(1000));
  });

  test('probes, nats dumps and restores retry a connection the policy has not admitted yet', async () => {
    // A new pod's first connections are refused until its network policy is programmed (#388).
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void) => {
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout);
    const archive = (files: Map<string, Uint8Array>, argv: string[]) => {
      if (argv[0] === 'tar' && argv.includes('-cf')) {
        files.set(argv[argv.indexOf('-cf') + 1] ?? '', Buffer.from('tar-bytes'));
      }
      return ok();
    };
    const refusedFirst = (tool: string, then: (argv: string[]) => ExecResult, times = 2) => {
      let refused = 0;
      return (argv: string[]) => {
        if (argv[0] === tool && refused < times) {
          refused += 1;
          return {
            code: 1,
            stdout: '',
            stderr:
              tool === 'nats'
                ? 'nats: error: setup failed: nats: no servers available for connection'
                : 'could not connect to server: Connection refused',
          };
        }
        return then(argv);
      };
    };
    try {
      for (const [port, tool, stdout] of [
        ['5432', 'psql', '0\n'],
        ['6379', 'redis-cli', '0'],
        ['4222', 'nats', '[]'],
      ] as const) {
        const probe = harness(refusedFirst(tool, () => ({ code: 0, stdout, stderr: '' })));
        expect(await runAgent(request({ kind: 'probe-empty', port }), probe.io)).toBe(0);
        expect(probe.calls.filter((call) => call.argv[0] === tool)).toHaveLength(3);
      }

      const dump = harness(
        refusedFirst('nats', (argv) =>
          argv.includes('ls') ? { code: 0, stdout: '[]', stderr: '' } : archive(dump.files, argv),
        ),
      );
      expect(await runAgent(request({ kind: 'nats', port: '4222' }), dump.io)).toBe(0);
      expect(dump.calls.filter((call) => call.argv.includes('ls'))).toHaveLength(3);

      // Restores wait with a read-only probe, then run exactly once.
      const restore = harness(refusedFirst('psql', () => ok()));
      expect(await runAgent(request({ kind: 'restore-postgres' }), restore.io)).toBe(0);
      expect(restore.calls.filter((call) => call.argv[0] === 'psql')).toHaveLength(3);
      expect(restore.calls.filter((call) => call.argv[0] === 'pg_restore')).toHaveLength(1);

      const redis = harness(
        refusedFirst('redis-cli', (argv) =>
          argv[0] === 'rdb' ? { code: 0, stdout: 'RESP', stderr: '' } : ok(),
        ),
      );
      expect(await runAgent(request({ kind: 'restore-redis', port: '6379' }), redis.io)).toBe(0);
      const redisCalls = redis.calls.filter((call) => call.argv[0] === 'redis-cli');
      expect(redisCalls.filter((call) => call.argv.includes('PING'))).toHaveLength(3);
      const pipes = redisCalls.filter((call) => call.argv.includes('--pipe'));
      expect(pipes).toHaveLength(1);
      expect(pipes[0]?.input).toBe('RESP');

      const nats = harness(refusedFirst('nats', () => ok()));
      expect(await runAgent(request({ kind: 'restore-nats', port: '4222' }), nats.io)).toBe(0);
      expect(nats.calls.filter((call) => call.argv.includes('info'))).toHaveLength(3);
      expect(nats.calls.filter((call) => call.argv.includes('restore'))).toHaveLength(1);

      // Other failures are not retried.
      const denied = harness(() => ({ code: 1, stdout: '', stderr: 'Authorization Violation' }));
      expect(await runAgent(request({ kind: 'probe-empty', port: '4222' }), denied.io)).toBe(1);
      expect(denied.calls).toHaveLength(1);
    } finally {
      timer.mockRestore();
    }
  });

  test('a restore that fails with connection-like output is never run again', async () => {
    const partial = {
      code: 1,
      stdout: '',
      stderr:
        'pg_restore: error: connection to server failed: Connection refused\nCommand was: REFRESH',
    };
    const postgres = harness((argv) => (argv[0] === 'pg_restore' ? partial : ok()));
    expect(await runAgent(request({ kind: 'restore-postgres' }), postgres.io)).toBe(1);
    expect(postgres.calls.filter((call) => call.argv[0] === 'pg_restore')).toHaveLength(1);
    const redis = harness((argv) =>
      argv[0] === 'rdb'
        ? { code: 0, stdout: 'RESP', stderr: '' }
        : argv.includes('--pipe')
          ? { code: 1, stdout: 'Could not connect to Redis', stderr: '' }
          : ok(),
    );
    expect(await runAgent(request({ kind: 'restore-redis', port: '6379' }), redis.io)).toBe(1);
    expect(redis.calls.filter((call) => call.argv.includes('--pipe'))).toHaveLength(1);
    const nats = harness((argv) =>
      argv.includes('restore') ? { code: 1, stdout: '', stderr: 'could not connect' } : ok(),
    );
    expect(await runAgent(request({ kind: 'restore-nats', port: '4222' }), nats.io)).toBe(1);
    expect(nats.calls.filter((call) => call.argv.includes('restore'))).toHaveLength(1);
  });

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
    // rclone exit 4 (file not found): already gone, or never written by a failed copy.
    const gone = harness(() => ({ code: 4, stdout: '', stderr: 'object not found' }));
    expect(await runAgent(request({ kind: 'gc', gcKeys: 'a\nb' }), gone.io)).toBe(0);
    expect(gone.calls).toHaveLength(2);
    const bucket = harness(() => ok());
    expect(await runAgent(request({ kind: 'gc', bucket: '' }), bucket.io)).toBe(1);
    expect(wrote(files, '/work/termination')).toContain('"format":"delete"');
  });

  test('PVC destination dumps through a .partial name, restores, and gcs', async () => {
    const pvc = { destinationType: 'pvc' as const, pvcMountPath: '/mnt/backup', bucket: '' };
    const stamp = '/mnt/backup/di-framework/alpha/orders/uid/20260927T020012Z';
    const postgres = harness((argv) => {
      if (argv[0] === 'pg_dump') {
        postgres.files.set(argv[argv.indexOf('-f') + 1] ?? '', Buffer.from('dump data'));
      }
      return fsTools(postgres.files)(argv);
    });
    expect(await runAgent(request({ kind: 'postgres', ...pvc }), postgres.io)).toBe(0);
    const record = JSON.parse(wrote(postgres.files, '/work/termination')) as {
      ok: boolean;
      objectKey: string;
    };
    expect(record.ok).toBe(true);
    expect(record.objectKey).toBe('di-framework/alpha/orders/uid/20260927T020012Z/data.dump');
    expect(wrote(postgres.files, `${stamp}/data.dump`)).toBe('dump data');
    expect(wrote(postgres.files, `${stamp}/manifest.json`)).toContain('BackupManifest');
    expect([...postgres.files.keys()].some((key) => key.endsWith('.partial'))).toBe(false);
    expect(postgres.calls.some((call) => call.argv[0] === 'rclone')).toBe(false);

    const restore = harness((argv) => fsTools(restore.files)(argv));
    restore.files.set(`${stamp}/data.dump`, Buffer.from('dump data'));
    expect(await runAgent(request({ kind: 'restore-postgres', ...pvc }), restore.io)).toBe(0);
    expect(wrote(restore.files, '/work/data.dump')).toBe('dump data');

    const gc = harness((argv) => fsTools(gc.files)(argv));
    gc.files.set(`${stamp}/data.dump`, Buffer.from('x'));
    const keys = `${stamp.slice('/mnt/backup/'.length)}/data.dump\ntop-level`;
    expect(await runAgent(request({ kind: 'gc', gcKeys: keys, ...pvc }), gc.io)).toBe(0);
    expect(gc.files.has(`${stamp}/data.dump`)).toBe(false);
    const rmdirs = gc.calls.map((call) => call.argv.join(' ')).filter((c) => c.startsWith('rmdir'));
    // Stamp first, then each emptied parent up to (not including) the claim root.
    expect(rmdirs).toEqual(
      [`rmdir ${stamp}`, '/uid', '/orders', '/alpha', '/di-framework'].map((tail, i) =>
        i === 0
          ? `rmdir ${stamp}`
          : `rmdir ${stamp.slice(0, stamp.lastIndexOf(tail) + tail.length)}`,
      ),
    );
    expect(
      gc.calls.some(
        (call) => call.argv[0] === 'sh' && call.argv[4] === '/mnt/backup/di-framework/alpha',
      ),
    ).toBe(true);
    expect(JSON.parse(wrote(gc.files, '/work/termination')).tool).toBe('rm');
  });

  test('a failed PVC copy removes the .partial and the orphan data file', async () => {
    const pvc = { destinationType: 'pvc' as const, pvcMountPath: '/mnt/backup', bucket: '' };
    const stamp = '/mnt/backup/di-framework/alpha/orders/uid/20260927T020012Z';
    const run = async (fail: (argv: string[]) => boolean) => {
      const h = harness((argv) => {
        if (argv[0] === 'pg_dump')
          h.files.set(argv[argv.indexOf('-f') + 1] ?? '', Buffer.from('d'));
        if (fail(argv)) {
          // cp wrote part of the file before failing
          if (argv[0] === 'cp') h.files.set(argv[2] ?? '', Buffer.from('half'));
          return { code: 1, stdout: '', stderr: 'No space left on device' };
        }
        return fsTools(h.files)(argv);
      });
      const code = await runAgent(request({ kind: 'postgres', ...pvc }), h.io);
      return { h, code };
    };
    const cp = await run((argv) => argv[0] === 'cp' && argv[1] === '/work/data.dump');
    expect(cp.code).toBe(1);
    expect([...cp.h.files.keys()].filter((k) => k.startsWith(stamp))).toEqual([`${stamp}/.dir`]);
    const sync = await run((argv) => argv[0] === 'sync' && argv[1]?.endsWith('.partial') === true);
    expect(sync.code).toBe(1);
    expect([...sync.h.files.keys()].some((k) => k.endsWith('.partial'))).toBe(false);
    const mv = await run((argv) => argv[0] === 'mv');
    expect(mv.code).toBe(1);
    expect([...mv.h.files.keys()].some((k) => k.endsWith('.partial'))).toBe(false);
    const manifestFails = await run(
      (argv) => argv[0] === 'cp' && argv[1] === '/work/manifest.json',
    );
    expect(manifestFails.code).toBe(1);
    expect(manifestFails.h.files.has(`${stamp}/data.dump`)).toBe(false);
    expect(wrote(manifestFails.h.files, '/work/termination')).toContain('UploadFailed');
  });

  test('PVC gc unlinks files only and fails when unlink fails', async () => {
    const pvc = { destinationType: 'pvc' as const, pvcMountPath: '/mnt/backup', bucket: '' };
    const h = harness(() => ok());
    h.io.unlink = async () => {
      throw new Error('EISDIR');
    };
    expect(await runAgent(request({ kind: 'gc', gcKeys: 'a/b/c', ...pvc }), h.io)).toBe(1);
    expect(wrote(h.files, '/work/termination')).toContain('GcFailed');
  });

  test('PVC paths fail closed', async () => {
    const pvc = { destinationType: 'pvc' as const, pvcMountPath: '/mnt/backup', bucket: '' };
    const unmounted = harness(() => ok());
    expect(await runAgent(request({ ...pvc, pvcMountPath: undefined }), unmounted.io)).toBe(1);
    expect(wrote(unmounted.files, '/work/termination')).toContain('MissingClaim');

    const escaping = harness((argv) => {
      if (argv[0] === 'pg_dump') escaping.files.set('/work/data.dump', Buffer.from('d'));
      return ok();
    });
    expect(await runAgent(request({ ...pvc, prefix: '../outside' }), escaping.io)).toBe(1);
    expect(wrote(escaping.files, '/work/termination')).toContain('UploadFailed');

    for (const failing of ['cp', 'mv', 'mkdir']) {
      const broken = harness((argv) => {
        if (argv[0] === 'pg_dump') broken.files.set('/work/data.dump', Buffer.from('d'));
        if (argv[0] === failing) return { code: 1, stdout: '', stderr: failing };
        return ok();
      });
      if (failing === 'mkdir') {
        broken.io.mkdir = async () => {
          throw new Error('read-only claim');
        };
      }
      expect(await runAgent(request(pvc), broken.io)).toBe(1);
      expect(wrote(broken.files, '/work/termination')).toContain('UploadFailed');
    }
    const secondCopy = harness((argv) => {
      if (argv[0] === 'pg_dump') secondCopy.files.set('/work/data.dump', Buffer.from('d'));
      const copies = secondCopy.calls.filter((call) => call.argv[0] === 'cp').length;
      return argv[0] === 'cp' && copies === 2 ? { code: 1, stdout: '', stderr: '' } : ok();
    });
    expect(await runAgent(request(pvc), secondCopy.io)).toBe(1);

    const missing = harness((argv) => fsTools(missing.files)(argv));
    expect(await runAgent(request({ kind: 'restore-redis', ...pvc }), missing.io)).toBe(1);
    expect(wrote(missing.files, '/work/termination')).toContain('DownloadFailed');
    const outside = harness(() => ok());
    expect(
      await runAgent(request({ kind: 'restore-nats', ...pvc, prefix: '/etc' }), outside.io),
    ).toBe(1);
    expect(wrote(outside.files, '/work/termination')).toContain('PvcPathInvalid');
    const noMount = harness(() => ok());
    expect(
      await runAgent(
        request({ kind: 'restore-postgres', ...pvc, pvcMountPath: undefined }),
        noMount.io,
      ),
    ).toBe(1);

    for (const keys of ['../escape', '/abs', 'a/./b']) {
      const gc = harness(() => ok());
      expect(await runAgent(request({ kind: 'gc', gcKeys: keys, ...pvc }), gc.io)).toBe(1);
      expect(wrote(gc.files, '/work/termination')).toContain('PvcPathInvalid');
    }
    const gcUnmounted = harness(() => ok());
    expect(
      await runAgent(
        request({ kind: 'gc', gcKeys: 'k', ...pvc, pvcMountPath: undefined }),
        gcUnmounted.io,
      ),
    ).toBe(1);
    expect(wrote(gcUnmounted.files, '/work/termination')).toContain('PvcMountPathNotSet');
    const gcBroken = harness(() => ok());
    gcBroken.io.unlink = async () => {
      throw new Error('remove failed');
    };
    expect(await runAgent(request({ kind: 'gc', gcKeys: 'k', ...pvc }), gcBroken.io)).toBe(1);
    expect(wrote(gcBroken.files, '/work/termination')).toContain('GcFailed');
    expect(safeKey('')).toBe(false);
    expect(safeKey('a/b')).toBe(true);
  });
});

// A fresh Bun process transpiles src/main.ts and forks two shell stubs. That is process start-up,
// not waiting, and it slows down with the rest of the machine, so it gets more than the default.
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
}, 30_000);

describe('sweepPvc on a real tree', () => {
  test('removes only stale leftovers inside <mount>/<prefix> at stamp depth', async () => {
    const { mkdir, symlink, utimes, stat } = await import('node:fs/promises');
    const mount = await mkdtemp(join(tmpdir(), 'sweep-'));
    const old = new Date(Date.now() - 3 * 86400_000);
    const put = async (path: string, aged: boolean) => {
      const full = join(mount, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, 'x');
      if (aged) await utimes(full, old, old);
    };
    const exists = (path: string) =>
      stat(join(mount, path)).then(
        () => true,
        () => false,
      );
    const stamp = 'bk/svc/uid';
    await put(`${stamp}/old/data.dump`, true); // orphan: removed
    await put(`${stamp}/old/data.dump.partial`, true); // stale partial: removed
    await put(`${stamp}/new/data.dump.partial`, false); // fresh partial: kept
    await put(`${stamp}/done/data.dump`, true); // complete: kept
    await put(`${stamp}/done/manifest.json`, true);
    await put(`${stamp}/fresh/data.dump`, false); // young orphan: kept
    await put('bk/README', true); // wrong depth: kept
    await put('bk/svc/uid/stray.partial', true); // depth 3: kept
    await put('other/app/state/db.sqlite', true); // outside prefix: kept
    await put('other/app/state/x.partial', true); // outside prefix: kept
    await put('lost+found/a/b/c/#1234', true); // outside prefix: kept
    await put('bk/lost+found/a/b/#9', true); // lost+found under prefix: kept
    await put('elsewhere/a/b/c/data.dump', true); // reachable only through a symlink: kept
    await symlink(join(mount, 'elsewhere'), join(mount, 'bk/link'));

    const io = {
      async exec(argv: string[]) {
        const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
        return { code: await proc.exited, stdout: '', stderr: '' };
      },
    } as AgentIo;
    await sweepPvc(io, mount, ['bk']);

    expect(await exists(`${stamp}/old/data.dump`)).toBe(false);
    expect(await exists(`${stamp}/old/data.dump.partial`)).toBe(false);
    for (const kept of [
      `${stamp}/new/data.dump.partial`,
      `${stamp}/done/data.dump`,
      `${stamp}/done/manifest.json`,
      `${stamp}/fresh/data.dump`,
      'bk/README',
      'bk/svc/uid/stray.partial',
      'other/app/state/db.sqlite',
      'other/app/state/x.partial',
      'lost+found/a/b/c/#1234',
      'bk/lost+found/a/b/#9',
      'elsewhere/a/b/c/data.dump',
    ])
      expect(await exists(kept)).toBe(true);
    await rm(mount, { recursive: true, force: true });
  });

  test('refuses the claim root and symlinked prefixes', async () => {
    const { mkdir, symlink, utimes, stat } = await import('node:fs/promises');
    const mount = await mkdtemp(join(tmpdir(), 'sweep-'));
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    const old = new Date(Date.now() - 3 * 86400_000);
    const put = async (base: string, path: string) => {
      const full = join(base, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, 'x');
      await utimes(full, old, old);
    };
    await put(mount, 'a/b/c/d/data.dump'); // would match from the claim root
    await put(outside, 'a/b/c/data.dump');
    await put(outside, 'x/a/b/c/data.dump');
    await symlink(outside, join(mount, 'bk'));
    await mkdir(join(mount, 'mid'), { recursive: true });
    await symlink(outside, join(mount, 'mid/link'));
    const io = {
      async exec(argv: string[]) {
        const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
        return { code: await proc.exited, stdout: '', stderr: '' };
      },
    } as AgentIo;
    await sweepPvc(io, mount, ['/', '', 'bk/', 'mid/link', 'mid/link/x']);
    const exists = (p: string) =>
      stat(p).then(
        () => true,
        () => false,
      );
    expect(await exists(join(mount, 'a/b/c/d/data.dump'))).toBe(true);
    expect(await exists(join(outside, 'a/b/c/data.dump'))).toBe(true);
    expect(await exists(join(outside, 'x/a/b/c/data.dump'))).toBe(true);
    await rm(mount, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
});
