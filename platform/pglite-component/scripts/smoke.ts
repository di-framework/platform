/** Persistent-storage smoke test: compose a consumer and run it under wasmtime. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeConsumer } from './compose.ts';
import { die, fileExists, loadToolEnv, mkdir, packageDir, rm, setupEnv } from './lib.ts';

const MARKERS = {
  'no-mount': 'no mount ok',
  write: 'smoke ok',
  read: 'restart ok',
  abrupt: 'abrupt ok',
} as const;

type SmokeMode = keyof typeof MARKERS;

async function runMode(
  composed: string,
  smokeDir: string,
  mode: SmokeMode,
  extraDirs: string[],
): Promise<void> {
  const logFile = join(smokeDir, `${mode}.log`);
  const proc = Bun.spawn(
    ['wasmtime', 'run', ...extraDirs, '--env', `PGLITE_SMOKE_MODE=${mode}`, composed],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = `${stdout}${stderr}`;
  await Bun.write(logFile, output);
  if (code !== 0) {
    console.error(output.split('\n').slice(-80).join('\n'));
    throw new Error(`wasmtime ${mode} failed with exit ${code}`);
  }
  const marker = MARKERS[mode];
  if (!marker || !output.split('\n').some((line) => line === marker)) {
    throw new Error(`wasmtime ${mode}: marker ${marker ?? mode} not found`);
  }
  console.error(`[smoke] ${MARKERS[mode]}`);
}

export async function smoke(pkgDir?: string): Promise<void> {
  const dir = pkgDir ?? packageDir(import.meta.url);
  const env = await loadToolEnv(dir);
  await setupEnv(env);
  process.chdir(dir);

  if (!Bun.which('wasmtime')) die('smoke', 'wasmtime not found on PATH');
  await Bun.$`cargo build --locked --release --target ${env.rustTarget} -p pglite-smoke-consumer`;
  await mkdir(join('target', 'smoke'), { recursive: true });
  await composeConsumer(
    join('target', env.rustTarget, 'release', 'pglite-smoke-consumer.wasm'),
    join('target', 'smoke', 'composed.wasm'),
    join('dist', 'di-framework-pglite.wasm'),
  );
  const composed = join('target', 'smoke', 'composed.wasm');
  const composedWit = await Bun.$`wasm-tools component wit ${composed}`.text();
  await Bun.write(join('target', 'smoke', 'composed.wit'), composedWit);
  if (/(^|\s)import (wasi:sockets|di-framework:pglite)/m.test(composedWit)) {
    die('smoke', 'unexpected socket or unresolved database/engine import');
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'df-pglite-smoke.'));
  const smokeDir = join('target', 'smoke');
  try {
    await runMode(composed, smokeDir, 'no-mount', []);
    await runMode(composed, smokeDir, 'write', ['--dir', `${dataDir}::/data`]);
    if (!(await fileExists(join(dataDir, 'pglite', 'data', 'PG_VERSION')))) {
      die('smoke', 'PG_VERSION missing after write');
    }
    if (!(await fileExists(join(dataDir, 'pglite', 'data', 'global', 'pg_control')))) {
      die('smoke', 'pg_control missing after write');
    }
    await runMode(composed, smokeDir, 'read', ['--dir', `${dataDir}::/data`]);
    await runMode(composed, smokeDir, 'abrupt', ['--dir', `${dataDir}::/data`]);
    await runMode(composed, smokeDir, 'read', ['--dir', `${dataDir}::/data`]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  console.error('[smoke] persistent embedded PGlite passed without networking');
}

if (import.meta.main) {
  try {
    await smoke();
  } catch (error) {
    die('smoke', error instanceof Error ? error.message : String(error));
  }
}
