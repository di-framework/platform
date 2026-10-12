/**
 * Shared plumbing for `bun scripts/<name>.ts`: package paths, the pinned
 * toolchain environment, and error-to-exit-code mapping.
 *
 * wasm-tools and wac are the pinned binaries that `../pglite-component`
 * installs (`make tools`), so both components build with identical tools.
 * Rust is the channel in rust-toolchain.toml, selected through rustup.
 */
import { dirname, join, resolve } from 'node:path';
import { $ } from 'bun';

export type Env = Record<string, string | undefined>;

export const PKG_DIR = resolve(import.meta.dir, '..', '..');
export const PGLITE_DIR = resolve(PKG_DIR, '..', 'pglite-component');
/** The core module target: std adds no WASI imports of its own. */
export const RUST_TARGET = 'wasm32-unknown-unknown';
export const CORE_WASM = 'pglite_encfs.wasm';
export const WASM_FILE = 'pglite-encfs.wasm';
export const WIT_FILE = 'pglite-encfs.wit';

export interface Context {
  pkgDir: string;
  pgliteDir: string;
  toolchain: string;
  env: Env;
}

/** The `channel` pinned in rust-toolchain.toml. */
export function toolchainChannel(toml: string): string {
  const channel = toml.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  if (!channel) throw new Error('rust-toolchain.toml has no channel');
  return channel;
}

/** The WIT package version, which is also the published version tag. */
export function witPackageVersion(wit: string): string {
  const version = wit.match(/^package di-framework:pglite-encfs@([^;\s]+);/m)?.[1];
  if (!version)
    throw new Error('wit/world.wit must start with package di-framework:pglite-encfs@<version>;');
  return version;
}

function prependPath(path: string, dir: string): string {
  return path.split(':').includes(dir) ? path : `${dir}:${path}`;
}

export async function createContext(base: Env = process.env): Promise<Context> {
  const toolchain = toolchainChannel(await Bun.file(join(PKG_DIR, 'rust-toolchain.toml')).text());
  const env: Env = { ...base };
  let path = base.PATH ?? '';
  path = prependPath(path, join(PGLITE_DIR, '.tools', 'bin'));
  // pglite-component's hermetic rustup (`make tools-rust` without a system rustup).
  const hermetic = join(PGLITE_DIR, '.tools', 'cargo', 'bin');
  if (!Bun.which('rustup', { PATH: path }) && Bun.which('rustup', { PATH: hermetic })) {
    env.RUSTUP_HOME = join(PGLITE_DIR, '.tools', 'rustup');
    env.CARGO_HOME = join(PGLITE_DIR, '.tools', 'cargo');
    path = prependPath(path, hermetic);
  }
  path = prependPath(path, join(base.CARGO_HOME ?? join(base.HOME ?? '', '.cargo'), 'bin'));
  const rustup = Bun.which('rustup', { PATH: path });
  if (rustup) {
    const cargo = await $`${rustup} which --toolchain ${toolchain} cargo`
      .env({ ...env, PATH: path })
      .nothrow()
      .quiet()
      .text();
    if (cargo.trim()) path = prependPath(path, dirname(cargo.trim()));
  }
  env.PATH = path;
  return { pkgDir: PKG_DIR, pgliteDir: PGLITE_DIR, toolchain, env };
}

/** Fail early with the command that installs a missing tool. */
export function requireTools(ctx: Context, tools: string[]): void {
  for (const tool of tools) {
    if (!Bun.which(tool, { PATH: ctx.env.PATH })) {
      const hint =
        tool === 'wasmtime'
          ? 'install wasmtime 48 (https://wasmtime.dev)'
          : tool === 'cargo' || tool === 'rustup'
            ? 'install rustup, or run make -C ../pglite-component tools-rust'
            : 'run make tools';
      throw new Error(`${tool} not found on PATH; ${hint}`);
    }
  }
}

export function logger(tag: string): (message: string) => void {
  return (message) => console.error(`[${tag}] ${message}`);
}

/** Run a command with the package as cwd and the toolchain environment. */
export async function run(tag: string, command: (ctx: Context) => Promise<void>): Promise<void> {
  try {
    const ctx = await createContext();
    $.cwd(ctx.pkgDir);
    $.env(ctx.env);
    await command(ctx);
  } catch (error) {
    console.error(`[${tag}] error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
