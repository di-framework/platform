/** Persistent-storage smoke test: compose a consumer and run it under wasmtime. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { composeConsumer } from './compose.ts';
import { type Context, logger, run } from './lib/cli.ts';
import { fetchVerified } from './lib/fetch.ts';
import { fileExists } from './lib/fs.ts';
import { type Pins, requiredPin } from './lib/versions.ts';

const log = logger('smoke');

const MARKERS = {
  'no-mount': 'no mount ok',
  write: 'smoke ok',
  read: 'restart ok',
  abrupt: 'abrupt ok',
  'upgrade-write': 'upgrade write ok',
  'upgrade-read': 'upgrade read ok',
  database: 'database ok',
} as const;

type SmokeMode = keyof typeof MARKERS;

/** Upper bound for one wasmtime run; a wedged guest fails the build instead of hanging CI. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

async function runMode(
  ctx: Context,
  composed: string,
  smokeDir: string,
  mode: SmokeMode,
  extraArgs: string[],
  logName: string = mode,
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
  await Bun.write(join(smokeDir, `${logName}.log`), output);
  if (code !== 0) {
    console.error(output.split('\n').slice(-80).join('\n'));
    const why = proc.signalCode ? `signal ${proc.signalCode}` : `exit ${code}`;
    throw new Error(`wasmtime ${mode} failed with ${why}`);
  }
  const marker = MARKERS[mode];
  if (!output.split('\n').some((line) => line === marker)) {
    throw new Error(`wasmtime ${mode}: marker ${marker} not found`);
  }
  log(marker);
}

/** Marker inside PGDATA that `src/engine.rs` (`DATABASE_MARKER`) writes on a new data directory (#212). */
export const DATABASE_MARKER = 'di-framework-database';

/** The marker's content, or null when the data directory has none. */
export async function readDatabaseMarker(dataDir: string): Promise<string | null> {
  const file = Bun.file(join(dataDir, 'pglite', 'data', DATABASE_MARKER));
  return (await file.exists()) ? await file.text() : null;
}

/** Arguments for the consumer's `database` mode: open `requested`, expect `expected` and `table`. */
export function databaseArgs(check: {
  requested?: 'postgres' | 'template1';
  expected: 'postgres' | 'template1';
  table: string;
  present: boolean;
}): string[] {
  const env = [
    `PGLITE_SMOKE_EXPECT_DB=${check.expected}`,
    `PGLITE_SMOKE_TABLE=${check.table}`,
    `PGLITE_SMOKE_TABLE_PRESENT=${check.present ? '1' : '0'}`,
  ];
  if (check.requested) env.push(`PGLITE_SMOKE_DATABASE=${check.requested}`);
  return env.flatMap((pair) => ['--env', pair]);
}

/** Run the consumer's `database` mode on `mount` with one expectation. */
async function databaseCheck(
  ctx: Context,
  composed: string,
  smokeDir: string,
  mount: string[],
  logName: string,
  check: Parameters<typeof databaseArgs>[0],
): Promise<void> {
  await runMode(ctx, composed, smokeDir, 'database', [...mount, ...databaseArgs(check)], logName);
  const what = check.requested ? `explicit ${check.requested}` : 'default';
  log(
    `${logName}: ${what} -> ${check.expected}, ${check.table} ${check.present ? 'present' : 'absent'}`,
  );
}

async function expectMarker(dataDir: string, expected: string | null, when: string): Promise<void> {
  const marker = await readDatabaseMarker(dataDir);
  if (marker !== expected) {
    throw new Error(
      `${when}: ${DATABASE_MARKER} is ${JSON.stringify(marker)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

/** The previous release the cross-version step writes a data directory with. */
export interface PreviousRelease {
  version: string;
  postgres: string;
  url: string;
  sha256: string;
}

export function previousRelease(pins: Pins): PreviousRelease {
  return {
    version: requiredPin(pins, 'PGLITE_UPGRADE_FROM_VERSION'),
    postgres: requiredPin(pins, 'PGLITE_UPGRADE_FROM_POSTGRES'),
    url: requiredPin(pins, 'PGLITE_UPGRADE_FROM_URL'),
    sha256: requiredPin(pins, 'PGLITE_UPGRADE_FROM_SHA256'),
  };
}

/** Path of the provider component inside the published npm tarball. */
export const PACKAGE_PROVIDER = 'package/dist/di-framework-pglite.wasm';

/** Fetch the previous release's npm tarball (checksum-verified) and extract its provider. */
async function previousProvider(release: PreviousRelease, dir: string): Promise<string> {
  const tarball = join(dir, `pglite-component-${release.version}.tgz`);
  await fetchVerified(release.url, tarball, release.sha256, { log });
  const out = join(dir, `pglite-component-${release.version}`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await $`tar -xzf ${tarball} -C ${out} ${PACKAGE_PROVIDER}`;
  return join(out, PACKAGE_PROVIDER);
}

/**
 * Cross-version step (#383): the previous release (PostgreSQL 17.5) writes a
 * data directory with a table, pgcrypto and PGP ciphertext; this build must
 * open it, read the data, and run pgcrypto on old and new values.
 */
async function upgradeSmoke(ctx: Context, consumer: string, composed: string, smokeDir: string) {
  const release = previousRelease(ctx.tools.pins);
  const upgradeDir = join(smokeDir, 'upgrade');
  await mkdir(upgradeDir, { recursive: true });
  const previous = join(upgradeDir, 'previous.wasm');
  await composeConsumer(ctx, {
    app: consumer,
    out: previous,
    provider: await previousProvider(release, upgradeDir),
  });

  const dataDir = await mkdtemp(join(tmpdir(), 'df-pglite-upgrade.'));
  const mount = ['--dir', `${dataDir}::/data`];
  try {
    await runMode(
      ctx,
      previous,
      smokeDir,
      'upgrade-write',
      [...mount, '--env', `PGLITE_SMOKE_SERVER_VERSION=${release.postgres}`],
      `upgrade-write-${release.version}`,
    );
    const pgVersion = (await Bun.file(join(dataDir, 'pglite', 'data', 'PG_VERSION')).text()).trim();
    if (pgVersion !== release.postgres.split('.')[0]) {
      throw new Error(`previous release wrote PG_VERSION ${pgVersion}, not ${release.postgres}`);
    }
    await expectMarker(dataDir, null, `after ${release.version}`);
    // upgrade-read asserts that `none` still selects template1 here (#212).
    await runMode(ctx, composed, smokeDir, 'upgrade-read', mount);
    await expectMarker(dataDir, null, 'legacy directory after upgrade-read');
    const table = 'upgrade_check';
    await databaseCheck(ctx, composed, smokeDir, mount, 'legacy-explicit-postgres', {
      requested: 'postgres',
      expected: 'postgres',
      table,
      present: false,
    });
    await databaseCheck(ctx, composed, smokeDir, mount, 'legacy-explicit-template1', {
      requested: 'template1',
      expected: 'template1',
      table,
      present: true,
    });
    await databaseCheck(ctx, composed, smokeDir, mount, 'legacy-default', {
      expected: 'template1',
      table,
      present: true,
    });
    await expectMarker(dataDir, null, 'legacy directory after explicit opens');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  log(
    `data directory from ${release.version} (PostgreSQL ${release.postgres}) opens under this build`,
  );
}

/**
 * A directory without the marker uses template1, even one this build
 * initialized: the state a crash between initdb and the marker leaves.
 */
async function markerLossSmoke(ctx: Context, composed: string, smokeDir: string): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'df-pglite-marker.'));
  const mount = ['--dir', `${dataDir}::/data`];
  try {
    await runMode(ctx, composed, smokeDir, 'write', mount, 'marker-loss-write');
    await expectMarker(dataDir, 'postgres\n', 'marker-loss directory after write');
    await rm(join(dataDir, 'pglite', 'data', DATABASE_MARKER));
    await databaseCheck(ctx, composed, smokeDir, mount, 'marker-loss-default', {
      expected: 'template1',
      table: 'tasks',
      present: false,
    });
    await expectMarker(dataDir, null, 'marker-loss directory after reopen');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function smoke(ctx: Context): Promise<void> {
  const { pkgDir } = ctx;
  const { rustTarget } = ctx.tools;
  if (!Bun.which('wasmtime', { PATH: ctx.env.PATH })) throw new Error('wasmtime not found on PATH');

  await $`cargo build --locked --release --target ${rustTarget} -p pglite-smoke-consumer`;
  const smokeDir = join(pkgDir, 'target', 'smoke');
  await mkdir(smokeDir, { recursive: true });
  const composed = join(smokeDir, 'composed.wasm');
  const consumer = join(pkgDir, 'target', rustTarget, 'release', 'pglite-smoke-consumer.wasm');
  await composeConsumer(ctx, {
    app: consumer,
    out: composed,
    provider: join(pkgDir, 'dist', 'di-framework-pglite.wasm'),
  });
  const composedWit = await $`wasm-tools component wit ${composed}`.text();
  await Bun.write(join(smokeDir, 'composed.wit'), composedWit);
  if (/(^|\s)import (wasi:sockets|di-framework:pglite)/m.test(composedWit)) {
    throw new Error('unexpected socket or unresolved database/engine import');
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'df-pglite-smoke.'));
  const mount = ['--dir', `${dataDir}::/data`];
  try {
    await runMode(ctx, composed, smokeDir, 'no-mount', []);
    await runMode(ctx, composed, smokeDir, 'write', mount);
    for (const file of ['PG_VERSION', join('global', 'pg_control')]) {
      if (!(await fileExists(join(dataDir, 'pglite', 'data', file)))) {
        throw new Error(`${file} missing after write`);
      }
    }
    // write asserted that the first session of the new directory is in postgres.
    await expectMarker(dataDir, 'postgres\n', 'new directory after write');
    // read asserts that a restart stays in postgres.
    await runMode(ctx, composed, smokeDir, 'read', mount);
    await databaseCheck(ctx, composed, smokeDir, mount, 'new-explicit-template1', {
      requested: 'template1',
      expected: 'template1',
      table: 'tasks',
      present: false,
    });
    await databaseCheck(ctx, composed, smokeDir, mount, 'new-explicit-postgres', {
      requested: 'postgres',
      expected: 'postgres',
      table: 'tasks',
      present: true,
    });
    await runMode(ctx, composed, smokeDir, 'abrupt', mount);
    await runMode(ctx, composed, smokeDir, 'read', mount);
    await expectMarker(dataDir, 'postgres\n', 'new directory after restarts');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  await markerLossSmoke(ctx, composed, smokeDir);
  await upgradeSmoke(ctx, consumer, composed, smokeDir);
  log('persistent embedded PGlite passed without networking');
}

if (import.meta.main) await run('smoke', smoke);
