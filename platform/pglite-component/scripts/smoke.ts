/** Persistent-storage smoke test: compose a consumer and run it under wasmtime. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { composeConsumer } from './compose.ts';
import { type Context, logger, run } from './lib/cli.ts';
import { fileExists } from './lib/fs.ts';

const log = logger('smoke');

const MARKERS = {
  'no-mount': 'no mount ok',
  write: 'smoke ok',
  read: 'restart ok',
  abrupt: 'abrupt ok',
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
  await Bun.write(join(smokeDir, `${mode}.log`), output);
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

export async function smoke(ctx: Context): Promise<void> {
  const { pkgDir } = ctx;
  const { rustTarget } = ctx.tools;
  if (!Bun.which('wasmtime', { PATH: ctx.env.PATH })) throw new Error('wasmtime not found on PATH');

  await $`cargo build --locked --release --target ${rustTarget} -p pglite-smoke-consumer`;
  const smokeDir = join(pkgDir, 'target', 'smoke');
  await mkdir(smokeDir, { recursive: true });
  const composed = join(smokeDir, 'composed.wasm');
  await composeConsumer(ctx, {
    app: join(pkgDir, 'target', rustTarget, 'release', 'pglite-smoke-consumer.wasm'),
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
    await runMode(ctx, composed, smokeDir, 'read', mount);
    await runMode(ctx, composed, smokeDir, 'abrupt', mount);
    await runMode(ctx, composed, smokeDir, 'read', mount);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  log('persistent embedded PGlite passed without networking');
}

if (import.meta.main) await run('smoke', smoke);
