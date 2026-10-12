/**
 * `make build`: release build -> dist/pglite-encfs.wasm (+ .wit, BUILD-INFO.txt, SHA256SUMS).
 *
 * The crate builds for wasm32-unknown-unknown and `wasm-tools component new`
 * turns it into a component, so its only imports are the WASI 0.2.9 names in
 * wit/world.wit (std on wasip2 would add its own).
 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import {
  CORE_WASM,
  type Context,
  logger,
  RUST_TARGET,
  requireTools,
  run,
  WASM_FILE,
  WIT_FILE,
  witPackageVersion,
} from './lib/env.ts';
import { ENCFS_EXPORTS, worldItems } from './lib/wit.ts';

const log = logger('build');

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest('hex');
}

/**
 * Make sure the pinned toolchain has the Wasm targets (this crate's, and
 * wasm32-wasip2 for the pglite smoke consumer) and the lint components.
 */
export async function ensureToolchain(ctx: Context): Promise<void> {
  requireTools(ctx, ['cargo']);
  if (Bun.which('rustup', { PATH: ctx.env.PATH })) {
    await $`rustup target add --toolchain ${ctx.toolchain} ${RUST_TARGET} wasm32-wasip2`.quiet();
    await $`rustup component add --toolchain ${ctx.toolchain} clippy rustfmt`.quiet();
  }
}

export async function build(ctx: Context): Promise<string> {
  requireTools(ctx, ['wasm-tools']);
  await ensureToolchain(ctx);
  const { pkgDir } = ctx;
  const cargoHome = ctx.env.CARGO_HOME ?? `${ctx.env.HOME ?? ''}/.cargo`;
  // Reproducible paths in the artifact, as in ../pglite-component.
  const rustflags =
    `${ctx.env.RUSTFLAGS ?? ''} --remap-path-prefix=${pkgDir}=/di-framework-pglite-encfs --remap-path-prefix=${cargoHome}=/cargo`.trim();
  await $`cargo build --locked --release --target ${RUST_TARGET}`.env({
    ...ctx.env,
    RUSTFLAGS: rustflags,
  });

  const targetDir = ctx.env.CARGO_TARGET_DIR ?? join(pkgDir, 'target');
  const core = join(targetDir, RUST_TARGET, 'release', CORE_WASM);
  const dist = join(pkgDir, 'dist');
  await mkdir(dist, { recursive: true });
  const wasm = join(dist, WASM_FILE);
  await $`wasm-tools component new ${core} -o ${wasm}`;
  await $`wasm-tools validate --features all ${wasm}`;
  const wit = await $`wasm-tools component wit ${wasm}`.text();
  await Bun.write(join(dist, WIT_FILE), wit);

  // The export set is fixed; that every import and export matches pglite is checked in smoke.
  const { imports, exports } = worldItems(wit);
  if (JSON.stringify([...exports].sort()) !== JSON.stringify([...ENCFS_EXPORTS].sort())) {
    throw new Error(`exports ${exports.join(', ')}; expected ${ENCFS_EXPORTS.join(', ')}`);
  }
  const stray = imports.filter((name) => !name.startsWith('wasi:'));
  if (stray.length > 0) throw new Error(`unexpected non-WASI imports: ${stray.join(', ')}`);

  const version = witPackageVersion(await Bun.file(join(pkgDir, 'wit', 'world.wit')).text());
  const rustc = (await $`rustc --version`.text()).trim();
  const wasmTools = (await $`wasm-tools --version`.text()).trim();
  const size = Bun.file(wasm).size;
  await Bun.write(
    join(dist, 'BUILD-INFO.txt'),
    [
      `component:       di-framework:pglite-encfs@${version}`,
      'format:          header v1, codec AES-256-XTS (4 KiB units)',
      'profile:         release',
      `built:           ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`,
      `rustc:           ${rustc}`,
      `target:          ${RUST_TARGET} + wasm-tools component new`,
      `wasm-tools:      ${wasmTools}`,
      `size:            ${size} bytes`,
      '',
    ].join('\n'),
  );
  const sums = await Promise.all(
    [WASM_FILE, WIT_FILE, 'BUILD-INFO.txt'].map(
      async (name) => `${await sha256File(join(dist, name))}  ${name}`,
    ),
  );
  await Bun.write(join(dist, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  log(`ok: ${wasm} (${size} bytes)`);
  return wasm;
}

if (import.meta.main) await run('build', async (ctx) => void (await build(ctx)));
