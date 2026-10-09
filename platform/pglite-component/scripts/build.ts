/** Build the di-framework:pglite component and stage release artifacts in dist/. */
import { join } from 'node:path';
import {
  die,
  dieUsage,
  fileExists,
  isDirectory,
  loadToolEnv,
  log,
  mkdir,
  packageDir,
  requiredPin,
  setupEnv,
} from './lib.ts';
import { prepareEngine } from './prepare-engine.ts';

export interface BuildOptions {
  profile: 'release' | 'dev';
  profileDir: 'release' | 'debug';
}

export function parseBuildArgs(argv: string[]): BuildOptions {
  let debug = false;
  for (const arg of argv) {
    if (arg === '--debug') debug = true;
    else if (arg === '-h' || arg === '--help') {
      console.error(
        [
          'build the di-framework:pglite component into dist/',
          '',
          '  build.ts [--debug]',
          '',
          'Produces dist/di-framework-pglite.wasm, .wit, BUILD-INFO.txt, SHA256SUMS.',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else dieUsage('build', `unknown argument: ${arg}`);
  }
  return debug
    ? { profile: 'dev', profileDir: 'debug' }
    : { profile: 'release', profileDir: 'release' };
}

async function need(tag: string, cmd: string, hint: string): Promise<void> {
  if (!Bun.which(cmd)) die(tag, `${cmd} ${hint}`);
}

export async function buildComponent(argv: string[], pkgDir?: string): Promise<string> {
  const dir = pkgDir ?? packageDir(import.meta.url);
  const { profile, profileDir } = parseBuildArgs(argv);
  const env = await loadToolEnv(dir);
  await setupEnv(env);
  process.chdir(dir);

  await need(
    'build',
    'cargo',
    'not found. Install rustup (https://rustup.rs) or run: bun scripts/install-tools.ts --rust',
  );
  await need('build', 'wac', 'is required; run bun scripts/install-tools.ts');
  await need('build', 'wasm-tools', 'not found. Run bun scripts/install-tools.ts');

  if (Bun.which('rustup')) {
    const installed = await Bun.$`rustup target list --installed --toolchain ${env.rustToolchain}`
      .nothrow()
      .quiet()
      .text();
    if (!installed.split('\n').some((line) => line.trim() === env.rustTarget)) {
      log('build', `installing ${env.rustTarget} for ${env.rustToolchain} via rustup`);
      await Bun.$`rustup target add ${env.rustTarget} --toolchain ${env.rustToolchain}`;
    }
  } else {
    const rustcVersion = await Bun.$`rustc --version`.nothrow().quiet().text();
    if (!rustcVersion.includes(`rustc ${env.rustToolchain}`)) {
      log(
        'build',
        `warning: rustc is not ${env.rustToolchain} (${rustcVersion.trim()}); artifact will differ from the pinned build`,
      );
    }
    const libdir = await Bun.$`rustc --print target-libdir --target ${env.rustTarget}`
      .nothrow()
      .quiet()
      .text();
    if (!libdir.trim() || !(await isDirectory(libdir.trim()))) {
      die(
        'build',
        `rust-std for ${env.rustTarget} is not installed and rustup is unavailable; run bun scripts/install-tools.ts --rust`,
      );
    }
  }

  log('build', `rustc:      ${(await Bun.$`rustc --version`.text()).trim()}`);
  log('build', `wasm-tools: ${(await Bun.$`wasm-tools --version`.text()).trim()}`);
  log('build', `profile:    ${profile}`);

  await prepareEngine(dir);
  await Bun.$`cargo build --locked --profile ${profile} --target ${env.rustTarget} -p di-framework-pglite-component`;

  const wasmIn = join('target', env.rustTarget, profileDir, 'pglite_provider.wasm');
  if (!(await fileExists(wasmIn))) die('build', `expected output missing: ${wasmIn}`);

  await mkdir('dist', { recursive: true });
  const wasmOut = 'dist/di-framework-pglite.wasm';
  await Bun.$`wac plug --plug target/engine/engine.wasm ${wasmIn} -o ${wasmOut}`;
  await Bun.$`wasm-tools validate --features all ${wasmOut}`;
  await Bun.$`wasm-tools component wit ${wasmOut} > dist/di-framework-pglite.wit`;

  const wit = await Bun.file('dist/di-framework-pglite.wit').text();
  if (!wit.includes('export di-framework:pglite/database@0.1.0')) {
    die(
      'build',
      'component does not export di-framework:pglite/database@0.1.0 (see dist/di-framework-pglite.wit)',
    );
  }
  if (/(^|\s)import (wasi:sockets|di-framework:pglite-engine)/m.test(wit)) {
    die('build', 'unexpected socket or unresolved engine import in bundled provider');
  }

  const notices = await Promise.all(
    ['NOTICE', 'POSTGRESQL-COPYRIGHT', 'PGLITE-BINDINGS-LICENSE', 'WASMTIME-LICENSE'].map((f) =>
      Bun.file(join('engine', f)).text(),
    ),
  );
  await Bun.write('dist/THIRD-PARTY-NOTICES.txt', notices.join(''));

  const built = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const engineSha = (await Bun.$`shasum -a 256 target/engine/engine.core.wasm`.text()).split(
    ' ',
  )[0];
  const size = Bun.file(wasmOut).size;
  await Bun.write(
    'dist/BUILD-INFO.txt',
    [
      'component:       di-framework:pglite@0.1.0',
      `profile:         ${profile}`,
      `built:           ${built}`,
      `rustc:           ${(await Bun.$`rustc --version`.text()).trim()}`,
      `target:          ${env.rustTarget}`,
      `wasm-tools:      ${(await Bun.$`wasm-tools --version`.text()).trim()}`,
      `wit-bindgen:     ${requiredPin(env.pins, 'WIT_BINDGEN_VERSION')}`,
      `md5:             ${requiredPin(env.pins, 'MD5_VERSION')}`,
      'engine:          PostgreSQL 17.5, persistent WASI filesystem',
      `engine-source:   https://github.com/moznion/wasipg/tree/${requiredPin(env.pins, 'PGLITE_SOURCE_REF')}`,
      `adapter-sha256:  ${requiredPin(env.pins, 'PGLITE_ADAPTER_SHA256')}`,
      `engine-sha256:   ${engineSha}`,
      `size:            ${size} bytes`,
      '',
    ].join('\n'),
  );
  await Bun.$`shasum -a 256 di-framework-pglite.wasm di-framework-pglite.wit THIRD-PARTY-NOTICES.txt > SHA256SUMS`.cwd(
    'dist',
  );

  log('build', `ok: ${wasmOut} (${size} bytes)`);
  log('build', 'imports/exports:');
  const world = await Bun.$`wasm-tools component wit ${wasmOut}`.text();
  const worldBlock = world.match(/^world root[\s\S]*?^}/m);
  console.error(worldBlock?.[0] ?? world);
  return wasmOut;
}

if (import.meta.main) {
  try {
    await buildComponent(process.argv.slice(2));
  } catch (error) {
    die('build', error instanceof Error ? error.message : String(error));
  }
}
