/**
 * `make bench`: the section 11 benchmark of docs/design-200-two-slot-aead.md
 * (#200). Plaintext, XTS and codec 4 run the same workloads on the same
 * host, one wasmtime process per phase, through tests/bench:
 *
 *   init   cold start + initdb (wall clock), then the on-disk size
 *   oltp   3000 inserts (10 per commit), 3000 point selects, 200 commits of
 *          one 24 KiB row each (multi-page WAL flushes)
 *   bulk   200k rows of about 240 bytes, then CHECKPOINT
 *   scan   a fresh engine opening the directory and scanning the bulk table
 *   stat   cold and warm `stat-at` on every relation file
 *
 * For the encrypted variants encfs is plugged into pglite and into the bench
 * component's own filesystem imports, so `stat` measures encfs's `stat-at`;
 * for plaintext it measures the host. The results go to
 * target/bench/run/results.{json,md}; the markdown is what the design note
 * records. Counts are fixed, the data is seeded, and the key is generated
 * per run and passed by inherited environment, never printed.
 *
 * pglite: $PGLITE_ENCFS_PGLITE_WASM, else ../pglite-component/dist (make build there).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { build, ensureToolchain } from './build.ts';
import { type Context, logger, requireTools, run, WASM_FILE } from './lib/env.ts';

const log = logger('bench');
const MARKER_FILE = '.di-encfs';
/** The integrity reservation the platform writes into an empty directory (scripts/smoke.ts). */
const RESERVATION = Buffer.concat([Buffer.from('DIPGKEY2'), Buffer.alloc(16), Buffer.from([0b11])]);
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const PHASES = ['init', 'oltp', 'bulk', 'scan', 'stat'] as const;
type Phase = (typeof PHASES)[number];

interface Variant {
  name: 'plaintext' | 'xts' | 'codec4';
  composed: string;
  key?: string;
  reservation: boolean;
}

type Numbers = Record<string, number>;

/** Build tests/bench and plug pglite (plaintext) or pglite + encfs into it. */
async function compose(ctx: Context, outDir: string, pglite: string, encfs: string) {
  const target = join(ctx.pkgDir, 'target', 'bench');
  await $`cargo build --locked --release --target wasm32-wasip2`
    .cwd(join(ctx.pkgDir, 'tests', 'bench'))
    .env({ ...ctx.env, CARGO_TARGET_DIR: target });
  const consumer = join(target, 'wasm32-wasip2', 'release', 'pglite-encfs-bench.wasm');
  const pgliteEnc = join(outDir, 'pglite-enc.wasm');
  const plain = join(outDir, 'bench-plain.wasm');
  const encrypted = join(outDir, 'bench-enc.wasm');
  await $`wac plug --plug ${encfs} ${pglite} -o ${pgliteEnc}`;
  await $`wac plug --plug ${pglite} ${consumer} -o ${plain}`;
  // encfs twice: inside pglite, and on the consumer's own filesystem imports
  // so the stat phase reaches encfs's `stat-at`.
  await $`wac plug --plug ${pgliteEnc} --plug ${encfs} ${consumer} -o ${encrypted}`;
  for (const out of [plain, encrypted]) await $`wasm-tools validate --features all ${out}`;
  return { plain, encrypted };
}

/** Run one phase; returns its wall clock and the numbers on its result line. */
async function runPhase(
  ctx: Context,
  logDir: string,
  variant: Variant,
  dataDir: string,
  phase: Phase,
): Promise<{ wallMs: number; values: Numbers }> {
  const args = [
    'wasmtime',
    'run',
    '--dir',
    `${dataDir}::/data`,
    '--env',
    `PGLITE_BENCH_PHASE=${phase}`,
  ];
  const env = { ...ctx.env };
  delete env.DI_PGLITE_KEY;
  delete env.DI_PGLITE_KEY_PREVIOUS;
  if (variant.key !== undefined) {
    env.DI_PGLITE_KEY = variant.key;
    args.push('--env', 'DI_PGLITE_KEY');
  }
  args.push(variant.composed);
  const started = performance.now();
  const proc = Bun.spawn(args, { env, stdout: 'pipe', stderr: 'pipe', timeout: RUN_TIMEOUT_MS });
  const [stdout, stderr, code] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ]);
  const wallMs = performance.now() - started;
  const output = `${stdout}${stderr}`;
  const name = `${variant.name}-${phase}`;
  await Bun.write(join(logDir, `${name}.log`), output);
  if (variant.key !== undefined && output.includes(variant.key))
    throw new Error(`${name}: key material in the output`);
  const prefix = `bench ${phase} `;
  const line = output.split('\n').find((l) => l.startsWith(prefix));
  if (code !== 0 || !line) {
    console.error(output.split('\n').slice(-40).join('\n'));
    throw new Error(`${name}: exit ${code}${line ? '' : ', no result line'}`);
  }
  const values: Numbers = {};
  for (const pair of line.slice(prefix.length).trim().split(' ')) {
    const [key = '', value = ''] = pair.split('=');
    values[key] = Number(value);
  }
  log(`${name}: ${Math.round(wallMs)} ms wall; ${line.slice(prefix.length)}`);
  return { wallMs, values };
}

/** Regular files under `root`: count, `st_size` and allocated bytes. */
async function diskUsage(root: string): Promise<Numbers> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const usage = { files: 0, size: 0, allocated: 0 };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const s = await stat(join(entry.parentPath, entry.name));
    usage.files += 1;
    usage.size += s.size;
    usage.allocated += s.blocks * 512;
  }
  return usage;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const millis = (ms: number) => `${Math.round(ms)} ms`;
const micros = (us: number) => `${us.toFixed(1)} µs`;

/** The README-style table, with each encrypted column's ratio to plaintext. */
function renderTable(results: Record<Variant['name'], Numbers>): string {
  const rows: [string, string, (v: number) => string][] = [
    ['cold start + initdb (wall clock)', 'init_wall_ms', seconds],
    ['3000 inserts, 10 per transaction', 'oltp_inserts_ms', seconds],
    ['3000 point selects (cached)', 'oltp_selects_ms', millis],
    ['200 commits of one 24 KiB row (multi-page WAL flush)', 'oltp_wide_ms', seconds],
    ['bulk load 200k rows', 'bulk_load_ms', seconds],
    ['CHECKPOINT after the bulk load', 'bulk_checkpoint_ms', seconds],
    ['restart (open after the bulk load)', 'scan_open_ms', seconds],
    ['scan of the bulk table, fresh engine', 'scan_scan_ms', millis],
    ['stat-at, cold (per file)', 'stat_cold_us', micros],
    ['stat-at, warm (per file)', 'stat_warm_us', micros],
    ['disk after initdb, st_size', 'init_size', mb],
    ['disk after initdb, allocated', 'init_allocated', mb],
    ['disk after the run, st_size', 'final_size', mb],
    ['disk after the run, allocated', 'final_allocated', mb],
  ];
  const at = (n: Numbers, key: string) => n[key] ?? Number.NaN;
  const cell = (n: Numbers, key: string, fmt: (v: number) => string) => {
    const value = at(n, key);
    const base = at(results.plaintext, key);
    const ratio = n === results.plaintext || base === 0 ? '' : ` (${(value / base).toFixed(2)}×)`;
    return `${fmt(value)}${ratio}`;
  };
  const lines = [
    '| measurement | plaintext | pglite-encfs (XTS) | pglite-encfs (codec 4) |',
    '|---|---|---|---|',
  ];
  for (const [label, key, fmt] of rows) {
    lines.push(
      `| ${label} | ${cell(results.plaintext, key, fmt)} | ${cell(results.xts, key, fmt)} | ${cell(results.codec4, key, fmt)} |`,
    );
  }
  lines.push(
    '',
    `Files: ${results.plaintext.init_files} after initdb, ${results.plaintext.final_files} after the run (plaintext); ` +
      `stat-at over ${results.plaintext.stat_files} relation files; bulk table ${mb(at(results.plaintext, 'bulk_bytes'))}.`,
  );
  return `${lines.join('\n')}\n`;
}

export async function bench(ctx: Context): Promise<void> {
  requireTools(ctx, ['wasmtime', 'wac', 'wasm-tools', 'cargo']);
  await ensureToolchain(ctx);
  const pglite =
    ctx.env.PGLITE_ENCFS_PGLITE_WASM ?? join(ctx.pgliteDir, 'dist', 'di-framework-pglite.wasm');
  if (!(await Bun.file(pglite).exists())) {
    throw new Error(
      `pglite component not found: ${pglite} (run make -C ../pglite-component build)`,
    );
  }
  const encfs = join(ctx.pkgDir, 'dist', WASM_FILE);
  if (!(await Bun.file(encfs).exists())) await build(ctx);

  const outDir = join(ctx.pkgDir, 'target', 'bench', 'run');
  await rm(outDir, { recursive: true, force: true });
  const logDir = join(outDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const { plain, encrypted } = await compose(ctx, outDir, pglite, encfs);

  const key = randomBytes(32).toString('base64');
  const variants: Variant[] = [
    { name: 'plaintext', composed: plain, reservation: false },
    { name: 'xts', composed: encrypted, key, reservation: false },
    { name: 'codec4', composed: encrypted, key, reservation: true },
  ];
  const results = {} as Record<Variant['name'], Numbers>;
  const work = await mkdtemp(join(tmpdir(), 'df-pglite-encfs-bench.'));
  try {
    for (const variant of variants) {
      const data = join(work, variant.name);
      await mkdir(data);
      if (variant.reservation) await writeFile(join(data, MARKER_FILE), RESERVATION);
      const numbers: Numbers = {};
      for (const phase of PHASES) {
        const { wallMs, values } = await runPhase(ctx, logDir, variant, data, phase);
        numbers[`${phase}_wall_ms`] = wallMs;
        for (const [name, value] of Object.entries(values)) numbers[`${phase}_${name}`] = value;
        if (phase === 'init') {
          for (const [name, value] of Object.entries(await diskUsage(data)))
            numbers[`init_${name}`] = value;
        }
      }
      for (const [name, value] of Object.entries(await diskUsage(data)))
        numbers[`final_${name}`] = value;
      results[variant.name] = numbers;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const wasmtime = (await $`wasmtime --version`.text()).trim();
  const host = `${cpus()[0]?.model ?? 'unknown cpu'}, ${cpus().length} cores, ${platform()} ${release()} ${arch()}`;
  const date = new Date().toISOString().slice(0, 10);
  const table = renderTable(results);
  const markdown = `Measured ${date} on ${host}, ${wasmtime}, with \`make bench\`.\n\n${table}`;
  await Bun.write(
    join(outDir, 'results.json'),
    JSON.stringify({ date, host, wasmtime, results }, null, 2),
  );
  await Bun.write(join(outDir, 'results.md'), markdown);
  console.log(`\n${markdown}`);
  log(`results in ${outDir}`);
}

if (import.meta.main) await run('bench', bench);
