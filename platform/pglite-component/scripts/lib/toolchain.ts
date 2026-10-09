/**
 * Pinned toolchain layout and the shell environment it needs. Nothing here
 * mutates `process.env`: callers apply the returned environment to the
 * commands they spawn (see `cli.ts`) or print it for `eval` (see `env.ts`).
 */
import { dirname, join } from 'node:path';
import { $ } from 'bun';
import { isDirectory, isExecutable } from './fs.ts';
import { loadPins, type Pins, requiredPin } from './versions.ts';

export type Env = Record<string, string | undefined>;

/** Pinned versions plus the hermetic `.tools/` directory layout. */
export interface Tools {
  pkgDir: string;
  toolsDir: string;
  binDir: string;
  cacheDir: string;
  pins: Pins;
  rustToolchain: string;
  rustTarget: string;
}

export async function loadTools(pkgDir: string, base: Env = process.env): Promise<Tools> {
  const pins = await loadPins(pkgDir);
  const toolsDir = base.DF_PGLITE_TOOLS_DIR ?? join(pkgDir, '.tools');
  return {
    pkgDir,
    toolsDir,
    binDir: join(toolsDir, 'bin'),
    cacheDir: join(toolsDir, 'cache'),
    pins,
    rustToolchain: requiredPin(pins, 'RUST_TOOLCHAIN'),
    rustTarget: requiredPin(pins, 'RUST_TARGET'),
  };
}

/** Variables the pinned toolchain adds on top of the caller's environment. */
export interface ToolsEnv {
  PATH: string;
  RUSTFLAGS: string;
  DF_PGLITE_TOOLS_DIR: string;
  DF_PGLITE_ENV_LOADED: string;
  RUSTUP_HOME?: string;
  CARGO_HOME?: string;
}

/**
 * Put the hermetic tools on PATH, select the pinned rustup toolchain, and add
 * the RUSTFLAGS that keep the artifact reproducible. Idempotent per package:
 * a `base` that already carries `DF_PGLITE_ENV_LOADED` keeps its RUSTFLAGS.
 */
export async function resolveToolsEnv(tools: Tools, base: Env = process.env): Promise<ToolsEnv> {
  let path = base.PATH ?? '';
  const prepend = (dir: string): void => {
    if (!path.split(':').includes(dir)) path = path ? `${dir}:${path}` : dir;
  };
  const env: ToolsEnv = {
    PATH: path,
    RUSTFLAGS: base.RUSTFLAGS ?? '',
    DF_PGLITE_TOOLS_DIR: tools.toolsDir,
    DF_PGLITE_ENV_LOADED: base.DF_PGLITE_ENV_LOADED ?? '',
  };

  if (await isDirectory(tools.binDir)) prepend(tools.binDir);

  const hermeticCargoBin = join(tools.toolsDir, 'cargo', 'bin');
  if ((await isExecutable(join(hermeticCargoBin, 'cargo'))) && !base.RUSTUP_HOME) {
    env.RUSTUP_HOME = join(tools.toolsDir, 'rustup');
    env.CARGO_HOME = join(tools.toolsDir, 'cargo');
    prepend(hermeticCargoBin);
  }

  const rustup = Bun.which('rustup', { PATH: path });
  if (rustup) {
    const cargo = await $`${rustup} which --toolchain ${tools.rustToolchain} cargo`
      .env({ ...base, ...env, PATH: path })
      .nothrow()
      .text();
    if (cargo.trim()) prepend(dirname(cargo.trim()));
  }

  if (base.DF_PGLITE_ENV_LOADED !== tools.pkgDir) {
    const cargoHome = env.CARGO_HOME ?? base.CARGO_HOME ?? `${base.HOME ?? ''}/.cargo`;
    env.RUSTFLAGS =
      `${env.RUSTFLAGS} --remap-path-prefix=${tools.pkgDir}=/di-framework-pglite-component --remap-path-prefix=${cargoHome}=/cargo`.trim();
    env.DF_PGLITE_ENV_LOADED = tools.pkgDir;
  }
  env.PATH = path;
  return env;
}

/** Lines a POSIX shell can `eval` to reproduce {@link resolveToolsEnv}. */
export function exportEnvLines(env: ToolsEnv): string[] {
  const lines = [
    `export DF_PGLITE_TOOLS_DIR=${shellQuote(env.DF_PGLITE_TOOLS_DIR)}`,
    `export PATH=${shellQuote(env.PATH)}`,
  ];
  if (env.RUSTUP_HOME) lines.push(`export RUSTUP_HOME=${shellQuote(env.RUSTUP_HOME)}`);
  if (env.CARGO_HOME) lines.push(`export CARGO_HOME=${shellQuote(env.CARGO_HOME)}`);
  if (env.RUSTFLAGS) lines.push(`export RUSTFLAGS=${shellQuote(env.RUSTFLAGS)}`);
  lines.push(`export DF_PGLITE_ENV_LOADED=${shellQuote(env.DF_PGLITE_ENV_LOADED)}`);
  return lines;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
