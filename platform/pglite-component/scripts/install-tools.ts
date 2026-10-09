/** Install the pinned, checksum-verified toolchain into `.tools/` (or `DF_PGLITE_TOOLS_DIR`). */
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { type Args, type Context, logger, parseFlags, run } from './lib/cli.ts';
import { fetchVerified } from './lib/fetch.ts';
import { fileExists, isExecutable } from './lib/fs.ts';
import { requiredPin } from './lib/versions.ts';

const log = logger('install-tools');

const USAGE = [
  'install the pinned toolchain into .tools/',
  '',
  '  install-tools.ts [--rust] [--wac-only]',
].join('\n');

const FLAGS = { rust: { type: 'boolean' }, 'wac-only': { type: 'boolean' } } as const;

export type Os = 'macos' | 'linux';
export type Arch = 'aarch64' | 'x86_64';

export interface Platform {
  os: Os;
  arch: Arch;
  rustTriple: string;
  wacTriple: string;
}

export function detectPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): Platform {
  const os: Os | undefined =
    platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : undefined;
  if (!os) throw new Error(`unsupported OS: ${platform}`);
  const resolvedArch: Arch | undefined =
    arch === 'arm64' || arch === 'aarch64'
      ? 'aarch64'
      : arch === 'x64' || arch === 'x86_64' || arch === 'amd64'
        ? 'x86_64'
        : undefined;
  if (!resolvedArch) throw new Error(`unsupported architecture: ${arch}`);
  return {
    os,
    arch: resolvedArch,
    rustTriple: `${resolvedArch}-${os === 'macos' ? 'apple-darwin' : 'unknown-linux-gnu'}`,
    wacTriple: `${resolvedArch}-${os === 'macos' ? 'apple-darwin' : 'unknown-linux-musl'}`,
  };
}

export interface InstallOptions {
  withRust: boolean;
  wacOnly: boolean;
}

export function parseInstallArgs(argv: string[]): Args<InstallOptions> {
  const flags = parseFlags(argv, FLAGS, USAGE);
  if (flags.help) return flags;
  return {
    help: false,
    withRust: flags.values.rust === true,
    wacOnly: flags.values['wac-only'] === true,
  };
}

/** True when `bin` exists, is executable, and reports `versionNeedle`. */
async function hasVersion(ctx: Context, bin: string, versionNeedle: string): Promise<boolean> {
  if (!(await isExecutable(bin))) return false;
  const out = await $`${bin} --version`.env(ctx.env).nothrow().text();
  return out.includes(versionNeedle);
}

async function installBinary(source: Blob, dest: string): Promise<void> {
  await Bun.write(dest, source);
  await chmod(dest, 0o755);
}

async function installWasmTools(ctx: Context, { arch, os }: Platform): Promise<void> {
  const { pins, binDir, cacheDir } = ctx.tools;
  const version = requiredPin(pins, 'WASM_TOOLS_VERSION');
  const dest = join(binDir, 'wasm-tools');
  if (await hasVersion(ctx, dest, `wasm-tools ${version}`)) {
    log(`ok      wasm-tools ${version}`);
    return;
  }
  const name = `wasm-tools-${version}-${arch}-${os}`;
  const tgz = join(cacheDir, `${name}.tar.gz`);
  await fetchVerified(
    `https://github.com/bytecodealliance/wasm-tools/releases/download/v${version}/${name}.tar.gz`,
    tgz,
    requiredPin(pins, `WASM_TOOLS_SHA256_${arch}_${os}`),
    { log },
  );
  const member = `${name}/wasm-tools`;
  const archive = new Bun.Archive(await Bun.file(tgz).bytes());
  const binary = (await archive.files(member)).get(member);
  if (!binary) throw new Error(`${member} missing from ${tgz}`);
  await installBinary(binary, dest);
  log(`installed wasm-tools -> ${dest}`);
}

async function installWac(ctx: Context, { wacTriple }: Platform): Promise<void> {
  const { pins, binDir, cacheDir } = ctx.tools;
  const version = requiredPin(pins, 'WAC_VERSION');
  const dest = join(binDir, 'wac');
  if (await hasVersion(ctx, dest, `wac-cli ${version}`)) {
    log(`ok      wac ${version}`);
    return;
  }
  const name = `wac-cli-${wacTriple}`;
  const bin = join(cacheDir, `${name}-${version}`);
  await fetchVerified(
    `https://github.com/bytecodealliance/wac/releases/download/v${version}/${name}`,
    bin,
    requiredPin(pins, `WAC_SHA256_${wacTriple.replace(/-/g, '_')}`),
    { log },
  );
  await installBinary(Bun.file(bin), dest);
  log(`installed wac -> ${dest}`);
}

async function installRust(ctx: Context, { rustTriple }: Platform): Promise<void> {
  const { pins, toolsDir, cacheDir, rustToolchain, rustTarget } = ctx.tools;
  const env = {
    ...ctx.env,
    RUSTUP_HOME: join(toolsDir, 'rustup'),
    CARGO_HOME: join(toolsDir, 'cargo'),
  };
  const rustupBin = join(toolsDir, 'cargo', 'bin', 'rustup');
  if (!(await fileExists(rustupBin))) {
    const version = requiredPin(pins, 'RUSTUP_VERSION');
    const init = join(cacheDir, `rustup-init-${version}-${rustTriple}`);
    await fetchVerified(
      `https://static.rust-lang.org/rustup/archive/${version}/${rustTriple}/rustup-init`,
      init,
      requiredPin(pins, `RUSTUP_INIT_SHA256_${rustTriple.replace(/-/g, '_')}`),
      { log },
    );
    await chmod(init, 0o755);
    log(`installing rustup ${version} into ${toolsDir} (no PATH changes)`);
    await $`${init} -y --quiet --no-modify-path --profile minimal --default-toolchain none`.env({
      ...env,
      RUSTUP_INIT_SKIP_PATH_CHECK: 'yes',
    });
  }
  await $`${rustupBin} toolchain install ${rustToolchain} --profile minimal --target ${rustTarget} --no-self-update`.env(
    env,
  );
  log(`ok      rust ${rustToolchain} + ${rustTarget} (RUSTUP_HOME=${env.RUSTUP_HOME})`);
}

export async function installTools(ctx: Context, options: InstallOptions): Promise<void> {
  const { toolsDir, binDir, cacheDir } = ctx.tools;
  const platform = detectPlatform();
  await mkdir(binDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  if (options.wacOnly) {
    await installWac(ctx, platform);
    return;
  }
  await installWasmTools(ctx, platform);
  await installWac(ctx, platform);
  if (options.withRust) await installRust(ctx, platform);

  console.error(`\n[install-tools] done. Tools directory: ${toolsDir}`);
  console.error(`  export PATH="${binDir}:$PATH"`);
  if (options.withRust) {
    console.error(`  export RUSTUP_HOME="${toolsDir}/rustup" CARGO_HOME="${toolsDir}/cargo"`);
    console.error(`  export PATH="${toolsDir}/cargo/bin:$PATH"`);
  }
}

export async function install(ctx: Context, argv: string[]): Promise<void> {
  const args = parseInstallArgs(argv);
  if (args.help) {
    console.error(USAGE);
    return;
  }
  await installTools(ctx, args);
}

if (import.meta.main) await run('install-tools', install);
