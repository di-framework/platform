/** Build the di-framework:pglite component and stage release artifacts in dist/. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { type Args, type Context, logger, parseFlags, run } from './lib/cli.ts';
import { sha256File } from './lib/fetch.ts';
import { fileExists, isDirectory } from './lib/fs.ts';
import { requiredPin } from './lib/versions.ts';
import { prepareEngine } from './prepare-engine.ts';

const log = logger('build');

const USAGE = [
  'build the di-framework:pglite component into dist/',
  '',
  '  build.ts [--debug]',
  '',
  'Produces dist/di-framework-pglite.wasm, .wit, BUILD-INFO.txt, SHA256SUMS.',
].join('\n');

const FLAGS = { debug: { type: 'boolean' } } as const;

export interface BuildOptions {
  profile: 'release' | 'dev';
  profileDir: 'release' | 'debug';
}

export function parseBuildArgs(argv: string[]): Args<BuildOptions> {
  const flags = parseFlags(argv, FLAGS, USAGE);
  if (flags.help) return flags;
  return flags.values.debug
    ? { help: false, profile: 'dev', profileDir: 'debug' }
    : { help: false, profile: 'release', profileDir: 'release' };
}

function need(ctx: Context, cmd: string, hint: string): void {
  if (!Bun.which(cmd, { PATH: ctx.env.PATH })) throw new Error(`${cmd} ${hint}`);
}

async function ensureRustTarget(ctx: Context): Promise<void> {
  const { rustToolchain, rustTarget } = ctx.tools;
  if (Bun.which('rustup', { PATH: ctx.env.PATH })) {
    const installed = await $`rustup target list --installed --toolchain ${rustToolchain}`
      .nothrow()
      .text();
    if (!installed.split('\n').some((line) => line.trim() === rustTarget)) {
      log(`installing ${rustTarget} for ${rustToolchain} via rustup`);
      await $`rustup target add ${rustTarget} --toolchain ${rustToolchain}`;
    }
    return;
  }
  const rustcVersion = await $`rustc --version`.nothrow().text();
  if (!rustcVersion.includes(`rustc ${rustToolchain}`)) {
    log(
      `warning: rustc is not ${rustToolchain} (${rustcVersion.trim()}); artifact will differ from the pinned build`,
    );
  }
  const libdir = (
    await $`rustc --print target-libdir --target ${rustTarget}`.nothrow().text()
  ).trim();
  if (!libdir || !(await isDirectory(libdir))) {
    throw new Error(
      `rust-std for ${rustTarget} is not installed and rustup is unavailable; run bun scripts/install-tools.ts --rust`,
    );
  }
}

export async function buildComponent(ctx: Context, options: BuildOptions): Promise<string> {
  const { profile, profileDir } = options;
  const { pkgDir } = ctx;
  const { rustTarget, pins } = ctx.tools;

  need(
    ctx,
    'cargo',
    'not found. Install rustup (https://rustup.rs) or run: bun scripts/install-tools.ts --rust',
  );
  need(ctx, 'wac', 'is required; run bun scripts/install-tools.ts');
  need(ctx, 'wasm-tools', 'not found. Run bun scripts/install-tools.ts');
  await ensureRustTarget(ctx);

  const rustcVersion = (await $`rustc --version`.text()).trim();
  const wasmToolsVersion = (await $`wasm-tools --version`.text()).trim();
  log(`rustc:      ${rustcVersion}`);
  log(`wasm-tools: ${wasmToolsVersion}`);
  log(`profile:    ${profile}`);

  await prepareEngine(ctx);
  await $`cargo build --locked --profile ${profile} --target ${rustTarget} -p di-framework-pglite-component`;

  const wasmIn = join(pkgDir, 'target', rustTarget, profileDir, 'pglite_provider.wasm');
  if (!(await fileExists(wasmIn))) throw new Error(`expected output missing: ${wasmIn}`);

  const dist = join(pkgDir, 'dist');
  await mkdir(dist, { recursive: true });
  const wasmOut = join(dist, 'di-framework-pglite.wasm');
  const engineDir = join(pkgDir, 'target', 'engine');
  await $`wac plug --plug ${join(engineDir, 'engine.wasm')} ${wasmIn} -o ${wasmOut}`;
  await $`wasm-tools validate --features all ${wasmOut}`;
  const wit = await $`wasm-tools component wit ${wasmOut}`.text();
  await Bun.write(join(dist, 'di-framework-pglite.wit'), wit);

  if (!wit.includes('export di-framework:pglite/database@0.1.0')) {
    throw new Error(
      'component does not export di-framework:pglite/database@0.1.0 (see dist/di-framework-pglite.wit)',
    );
  }
  if (/(^|\s)import (wasi:sockets|di-framework:pglite-engine)/m.test(wit)) {
    throw new Error('unexpected socket or unresolved engine import in bundled provider');
  }

  const notices = await Promise.all(
    ['NOTICE', 'POSTGRESQL-COPYRIGHT', 'PGLITE-BINDINGS-LICENSE', 'WASMTIME-LICENSE'].map((f) =>
      Bun.file(join(pkgDir, 'engine', f)).text(),
    ),
  );
  await Bun.write(join(dist, 'THIRD-PARTY-NOTICES.txt'), notices.join(''));

  const built = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const size = Bun.file(wasmOut).size;
  await Bun.write(
    join(dist, 'BUILD-INFO.txt'),
    [
      'component:       di-framework:pglite@0.1.0',
      `profile:         ${profile}`,
      `built:           ${built}`,
      `rustc:           ${rustcVersion}`,
      `target:          ${rustTarget}`,
      `wasm-tools:      ${wasmToolsVersion}`,
      `wit-bindgen:     ${requiredPin(pins, 'WIT_BINDGEN_VERSION')}`,
      `md5:             ${requiredPin(pins, 'MD5_VERSION')}`,
      'engine:          PostgreSQL 17.5, persistent WASI filesystem',
      `engine-source:   https://github.com/moznion/wasipg/tree/${requiredPin(pins, 'PGLITE_SOURCE_REF')}`,
      `adapter-sha256:  ${requiredPin(pins, 'PGLITE_ADAPTER_SHA256')}`,
      `engine-sha256:   ${await sha256File(join(engineDir, 'engine.core.wasm'))}`,
      `size:            ${size} bytes`,
      '',
    ].join('\n'),
  );
  const sums = await Promise.all(
    ['di-framework-pglite.wasm', 'di-framework-pglite.wit', 'THIRD-PARTY-NOTICES.txt'].map(
      async (name) => `${await sha256File(join(dist, name))}  ${name}`,
    ),
  );
  await Bun.write(join(dist, 'SHA256SUMS'), `${sums.join('\n')}\n`);

  log(`ok: ${wasmOut} (${size} bytes)`);
  log('imports/exports:');
  console.error(wit.match(/^world root[\s\S]*?^}/m)?.[0] ?? wit);
  return wasmOut;
}

export async function build(ctx: Context, argv: string[]): Promise<void> {
  const args = parseBuildArgs(argv);
  if (args.help) {
    console.error(USAGE);
    return;
  }
  await buildComponent(ctx, args);
}

if (import.meta.main) await run('build', build);
