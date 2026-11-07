/**
 * Logical export/import migration from a PostgreSQL 17 data directory to a fresh
 * PostgreSQL 18 data directory (#401, D03 Option (b)).
 *
 * Exports extensions, public tables, constraints, rows, and user-defined functions
 * from the PG 17 mount directory using the pinned 17.x provider component, then
 * initializes a new PG 18 cluster in the target mount directory and imports the SQL
 * dump inside a single transaction using the 18.x provider component.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import { composeConsumer } from './compose.ts';
import { type Args, type Command, type Context, logger, run, UsageError } from './lib/cli.ts';
import { fetchVerified } from './lib/fetch.ts';
import { type Pins, requiredPin } from './lib/versions.ts';

const log = logger('migrate-17-to-18');

export const USAGE =
  'usage: bun scripts/migrate-17-to-18.ts --from <pg17-mount-dir> --to <pg18-mount-dir> [--database <postgres|template1>] [--dump <sql-file>]';

export type ApplicationDatabase = 'postgres' | 'template1';

export interface MigrateOptions {
  fromDir: string;
  toDir: string;
  database?: ApplicationDatabase;
  dumpPath?: string;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new UsageError(`option ${flag} requires an argument\n\n${USAGE}`);
  }
  return next;
}

export function parseMigrateArgs(argv: string[]): Args<MigrateOptions> {
  let fromRaw: string | undefined;
  let toRaw: string | undefined;
  let dumpRaw: string | undefined;
  let databaseRaw: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg === '--from') {
      fromRaw = readFlagValue(argv, i, '--from').trim();
      i++;
    } else if (arg === '--to') {
      toRaw = readFlagValue(argv, i, '--to').trim();
      i++;
    } else if (arg === '--dump') {
      dumpRaw = readFlagValue(argv, i, '--dump').trim();
      i++;
    } else if (arg === '--database') {
      databaseRaw = readFlagValue(argv, i, '--database').trim();
      i++;
    } else {
      throw new UsageError(`unknown or unexpected argument: ${arg}\n\n${USAGE}`);
    }
  }

  if (!fromRaw || !toRaw) {
    throw new UsageError(`--from and --to are required\n\n${USAGE}`);
  }
  let database: ApplicationDatabase | undefined;
  if (databaseRaw !== undefined && databaseRaw !== '') {
    if (databaseRaw !== 'postgres' && databaseRaw !== 'template1') {
      throw new UsageError(
        `--database must be "postgres" or "template1" (got ${JSON.stringify(databaseRaw)})\n\n${USAGE}`,
      );
    }
    database = databaseRaw;
  }
  const fromDir = resolve(fromRaw);
  const toDir = resolve(toRaw);
  if (fromDir === toDir) {
    throw new UsageError(`--from and --to must be distinct directories (${fromDir})\n\n${USAGE}`);
  }
  const dumpPath = dumpRaw ? resolve(dumpRaw) : undefined;
  return { help: false, fromDir, toDir, database, dumpPath };
}

/** Validate that `fromDir` contains a PostgreSQL 17 cluster and `toDir` does not already hold a cluster. */
export async function validateMigrationDirs(fromDir: string, toDir: string): Promise<void> {
  const sourceVersionFile = Bun.file(join(fromDir, 'pglite', 'data', 'PG_VERSION'));
  if (!(await sourceVersionFile.exists())) {
    throw new Error(
      `source directory ${fromDir} has no pglite/data/PG_VERSION (expected a PostgreSQL 17 mount root)`,
    );
  }
  const sourceVersion = (await sourceVersionFile.text()).trim();
  if (sourceVersion !== '17') {
    throw new Error(
      `source directory ${fromDir} has PG_VERSION ${JSON.stringify(sourceVersion)}; expected "17"`,
    );
  }
  const targetVersionFile = Bun.file(join(toDir, 'pglite', 'data', 'PG_VERSION'));
  if (await targetVersionFile.exists()) {
    throw new Error(
      `target directory ${toDir} already contains an initialized cluster (pglite/data/PG_VERSION exists); refuse to overwrite`,
    );
  }
}

export interface MigrateClusterParams {
  fromDir: string;
  toDir: string;
  previousComposed: string;
  currentComposed: string;
  workDir: string;
  database?: ApplicationDatabase;
  dumpPath?: string;
  fromServerVersion?: string;
}

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

async function runWasmtimeStep(
  ctx: Context,
  composed: string,
  mode: 'export-sql' | 'import-sql',
  marker: string,
  extraArgs: string[],
  logFile: string,
): Promise<void> {
  const proc = Bun.spawn(
    ['wasmtime', 'run', ...extraArgs, '--env', `PGLITE_SMOKE_MODE=${mode}`, composed],
    {
      cwd: ctx.pkgDir,
      env: ctx.env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: RUN_TIMEOUT_MS,
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ]);
  const output = `${stdout}${stderr}`;
  await Bun.write(logFile, output);
  if (code !== 0) {
    console.error(output.split('\n').slice(-80).join('\n'));
    const why = proc.signalCode ? `signal ${proc.signalCode}` : `exit ${code}`;
    throw new Error(`wasmtime ${mode} failed with ${why}`);
  }
  if (!output.split('\n').includes(marker)) {
    throw new Error(`wasmtime ${mode}: marker ${marker} not found`);
  }
}

/**
 * Export a PostgreSQL 17 cluster at `fromDir` with `previousComposed` and import
 * the logical SQL dump into a fresh PostgreSQL 18 cluster at `toDir` with `currentComposed`.
 */
export async function migrateCluster17To18(
  ctx: Context,
  params: MigrateClusterParams,
): Promise<string> {
  const {
    fromDir,
    toDir,
    previousComposed,
    currentComposed,
    workDir,
    database,
    dumpPath,
    fromServerVersion = '17.5',
  } = params;
  await validateMigrationDirs(fromDir, toDir);

  const toExisted = (await $`test -d ${toDir}`.nothrow()).exitCode === 0;
  const dumpDir = await mkdtemp(join(tmpdir(), 'df-pglite-mig-dump.'));
  const dbEnv = database ? ['--env', `PGLITE_MIGRATE_DATABASE=${database}`] : [];

  try {
    if (!database) {
      const hasMarker = await Bun.file(
        join(fromDir, 'pglite', 'data', 'di-framework-database'),
      ).exists();
      const siblingDb: ApplicationDatabase = hasMarker ? 'template1' : 'postgres';
      const siblingOid = siblingDb === 'postgres' ? '5' : '1';
      if (
        await Bun.file(join(fromDir, 'pglite', 'data', 'base', siblingOid, 'PG_VERSION')).exists()
      ) {
        await runWasmtimeStep(
          ctx,
          previousComposed,
          'export-sql',
          'sibling database public schema is empty',
          [
            '--dir',
            `${fromDir}::/data`,
            '--dir',
            `${dumpDir}::/dump`,
            '--env',
            `PGLITE_SMOKE_SERVER_VERSION=${fromServerVersion}`,
            '--env',
            `PGLITE_MIGRATE_DATABASE=${siblingDb}`,
            '--env',
            'PGLITE_MIGRATE_ASSERT_EMPTY_PUBLIC=1',
          ],
          join(workDir, 'migrate-check-sibling.log'),
        );
      }
    }

    const sqlFile = join(dumpDir, 'migration.sql');
    await runWasmtimeStep(
      ctx,
      previousComposed,
      'export-sql',
      'export sql ok',
      [
        '--dir',
        `${fromDir}::/data`,
        '--dir',
        `${dumpDir}::/dump`,
        '--env',
        `PGLITE_SMOKE_SERVER_VERSION=${fromServerVersion}`,
        ...dbEnv,
      ],
      join(workDir, 'migrate-export.log'),
    );
    log('export sql ok');

    const sql = await Bun.file(sqlFile).text();
    if (!sql.startsWith('-- di-framework:pglite logical export')) {
      throw new Error('exported SQL dump is missing header');
    }
    if (dumpPath) {
      await Bun.write(dumpPath, sql);
    }

    await $`mkdir -p ${toDir}`;
    await runWasmtimeStep(
      ctx,
      currentComposed,
      'import-sql',
      'import sql ok',
      ['--dir', `${toDir}::/data`, '--dir', `${dumpDir}::/dump`, ...dbEnv],
      join(workDir, 'migrate-import.log'),
    );
    log('import sql ok');

    const targetPgVersion = (
      await Bun.file(join(toDir, 'pglite', 'data', 'PG_VERSION')).text()
    ).trim();
    if (targetPgVersion !== '18') {
      throw new Error(
        `migrated target cluster wrote PG_VERSION ${JSON.stringify(targetPgVersion)}, expected "18"`,
      );
    }
    return sql;
  } catch (error) {
    await $`rm -rf ${join(toDir, 'pglite')}`.nothrow();
    if (!toExisted) {
      await $`rm -rf ${toDir}`.nothrow();
    }
    throw error;
  } finally {
    await rm(dumpDir, { recursive: true, force: true });
  }
}

const PACKAGE_PROVIDER = 'package/dist/di-framework-pglite.wasm';

async function preparePreviousProvider(
  pins: Pins,
  dir: string,
): Promise<{ provider: string; postgres: string }> {
  const version = requiredPin(pins, 'PGLITE_UPGRADE_FROM_VERSION');
  const postgres = requiredPin(pins, 'PGLITE_UPGRADE_FROM_POSTGRES');
  const url = requiredPin(pins, 'PGLITE_UPGRADE_FROM_URL');
  const sha256 = requiredPin(pins, 'PGLITE_UPGRADE_FROM_SHA256');
  const tarball = join(dir, `pglite-component-${version}.tgz`);
  await fetchVerified(url, tarball, sha256, { log });
  const out = join(dir, `pglite-component-${version}`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await $`tar -xzf ${tarball} -C ${out} ${PACKAGE_PROVIDER}`;
  return { provider: join(out, PACKAGE_PROVIDER), postgres };
}

export const migrate17To18: Command = async (ctx, argv) => {
  const args = parseMigrateArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  await validateMigrationDirs(args.fromDir, args.toDir);

  const { pkgDir } = ctx;
  const { rustTarget } = ctx.tools;
  await $`cargo build --locked --release --target ${rustTarget} -p pglite-smoke-consumer`;
  const consumer = join(pkgDir, 'target', rustTarget, 'release', 'pglite-smoke-consumer.wasm');
  const workDir = join(pkgDir, 'target', 'migrate-17-to-18');
  await mkdir(workDir, { recursive: true });

  const { provider: prevProvider, postgres: fromServerVersion } = await preparePreviousProvider(
    ctx.tools.pins,
    workDir,
  );
  const previousComposed = join(workDir, 'previous.wasm');
  const currentComposed = join(workDir, 'current.wasm');
  await composeConsumer(ctx, { app: consumer, out: previousComposed, provider: prevProvider });
  await composeConsumer(ctx, {
    app: consumer,
    out: currentComposed,
    provider: join(pkgDir, 'dist', 'di-framework-pglite.wasm'),
  });

  await migrateCluster17To18(ctx, {
    fromDir: args.fromDir,
    toDir: args.toDir,
    previousComposed,
    currentComposed,
    workDir,
    database: args.database,
    dumpPath: args.dumpPath,
    fromServerVersion,
  });
  log(`migrated ${args.fromDir} (PostgreSQL 17) -> ${args.toDir} (PostgreSQL 18)`);
};

if (import.meta.main) await run('migrate-17-to-18', migrate17To18);
