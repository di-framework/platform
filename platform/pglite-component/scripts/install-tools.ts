/** Install the pinned, checksum-verified toolchain into `.tools/` (or `DF_PGLITE_TOOLS_DIR`). */
import { join } from 'node:path';
import {
  chmod,
  die,
  dieUsage,
  fetchVerified,
  fileExists,
  loadToolEnv,
  log,
  mkdir,
  packageDir,
  requiredPin,
  rm,
  setupEnv,
} from './lib.ts';

export type Os = 'macos' | 'linux';
export type Arch = 'aarch64' | 'x86_64';

export function detectPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): {
  os: Os;
  arch: Arch;
  rustTriple: string;
  wacTriple: string;
} {
  const os: Os =
    platform === 'darwin'
      ? 'macos'
      : platform === 'linux'
        ? 'linux'
        : die('install-tools', `unsupported OS: ${platform}`);
  const resolvedArch: Arch =
    arch === 'arm64' || arch === 'aarch64'
      ? 'aarch64'
      : arch === 'x64' || arch === 'x86_64' || arch === 'amd64'
        ? 'x86_64'
        : die('install-tools', `unsupported architecture: ${arch}`);
  return {
    os,
    arch: resolvedArch,
    rustTriple: `${resolvedArch}-${os === 'macos' ? 'apple-darwin' : 'unknown-linux-gnu'}`,
    wacTriple: `${resolvedArch}-${os === 'macos' ? 'apple-darwin' : 'unknown-linux-musl'}`,
  };
}

async function executableOnPath(name: string, versionNeedle: string): Promise<boolean> {
  const found = Bun.which(name);
  if (!found) return false;
  const out = await Bun.$`${found} --version`.nothrow().quiet().text();
  return out.includes(versionNeedle);
}

export interface InstallOptions {
  withRust: boolean;
  wacOnly: boolean;
}

export function parseInstallArgs(argv: string[]): InstallOptions {
  let withRust = false;
  let wacOnly = false;
  for (const arg of argv) {
    if (arg === '--rust') withRust = true;
    else if (arg === '--wac-only') wacOnly = true;
    else if (arg === '-h' || arg === '--help') {
      console.error(
        [
          'install the pinned toolchain into .tools/',
          '',
          '  install-tools.ts [--rust] [--wac-only]',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else dieUsage('install-tools', `unknown argument: ${arg}`);
  }
  return { withRust, wacOnly };
}

async function installWasmTools(
  tag: string,
  pins: Record<string, string>,
  binDir: string,
  cacheDir: string,
  arch: Arch,
  os: Os,
): Promise<void> {
  const version = requiredPin(pins, 'WASM_TOOLS_VERSION');
  if (await executableOnPath(join(binDir, 'wasm-tools'), `wasm-tools ${version}`)) {
    log(tag, `ok      wasm-tools ${version}`);
    return;
  }
  const name = `wasm-tools-${version}-${arch}-${os}`;
  const tgz = join(cacheDir, `${name}.tar.gz`);
  await fetchVerified(
    tag,
    `https://github.com/bytecodealliance/wasm-tools/releases/download/v${version}/${name}.tar.gz`,
    tgz,
    requiredPin(pins, `WASM_TOOLS_SHA256_${arch}_${os}`),
  );
  await Bun.$`tar -xzf ${tgz} -C ${cacheDir} ${name}/wasm-tools`;
  await Bun.$`install -m 0755 ${join(cacheDir, name, 'wasm-tools')} ${join(binDir, 'wasm-tools')}`;
  await rm(join(cacheDir, name), { recursive: true, force: true });
  log(tag, `installed wasm-tools -> ${join(binDir, 'wasm-tools')}`);
}

async function installWac(
  tag: string,
  pins: Record<string, string>,
  binDir: string,
  cacheDir: string,
  wacTriple: string,
): Promise<void> {
  const version = requiredPin(pins, 'WAC_VERSION');
  if (await executableOnPath(join(binDir, 'wac'), `wac-cli ${version}`)) {
    log(tag, `ok      wac ${version}`);
    return;
  }
  const name = `wac-cli-${wacTriple}`;
  const bin = join(cacheDir, `${name}-${version}`);
  await fetchVerified(
    tag,
    `https://github.com/bytecodealliance/wac/releases/download/v${version}/${name}`,
    bin,
    requiredPin(pins, `WAC_SHA256_${wacTriple.replace(/-/g, '_')}`),
  );
  await Bun.$`install -m 0755 ${bin} ${join(binDir, 'wac')}`;
  log(tag, `installed wac -> ${join(binDir, 'wac')}`);
}

async function installRust(
  tag: string,
  pins: Record<string, string>,
  toolsDir: string,
  cacheDir: string,
  rustTriple: string,
  rustToolchain: string,
  rustTarget: string,
): Promise<void> {
  process.env.RUSTUP_HOME = join(toolsDir, 'rustup');
  process.env.CARGO_HOME = join(toolsDir, 'cargo');
  const rustupBin = join(toolsDir, 'cargo', 'bin', 'rustup');
  if (!(await fileExists(rustupBin))) {
    const version = requiredPin(pins, 'RUSTUP_VERSION');
    const init = join(cacheDir, `rustup-init-${version}-${rustTriple}`);
    await fetchVerified(
      tag,
      `https://static.rust-lang.org/rustup/archive/${version}/${rustTriple}/rustup-init`,
      init,
      requiredPin(pins, `RUSTUP_INIT_SHA256_${rustTriple.replace(/-/g, '_')}`),
    );
    await chmod(init, 0o755);
    log(tag, `installing rustup ${version} into ${toolsDir} (no PATH changes)`);
    await Bun.$`${init} -y --quiet --no-modify-path --profile minimal --default-toolchain none`.env(
      {
        ...process.env,
        RUSTUP_INIT_SKIP_PATH_CHECK: 'yes',
      },
    );
  }
  await Bun.$`${rustupBin} toolchain install ${rustToolchain} --profile minimal --target ${rustTarget} --no-self-update`;
  log(
    tag,
    `ok      rust ${rustToolchain} + ${rustTarget} (RUSTUP_HOME=${process.env.RUSTUP_HOME})`,
  );
}

export async function installTools(argv: string[], pkgDir?: string): Promise<void> {
  const dir = pkgDir ?? packageDir(import.meta.url);
  const { withRust, wacOnly } = parseInstallArgs(argv);
  const env = await loadToolEnv(dir);
  await setupEnv(env);
  const { os, arch, rustTriple, wacTriple } = detectPlatform();
  await mkdir(env.binDir, { recursive: true });
  await mkdir(env.cacheDir, { recursive: true });

  if (wacOnly) {
    await installWac('install-tools', env.pins, env.binDir, env.cacheDir, wacTriple);
    return;
  }
  await installWasmTools('install-tools', env.pins, env.binDir, env.cacheDir, arch, os);
  await installWac('install-tools', env.pins, env.binDir, env.cacheDir, wacTriple);
  if (withRust) {
    await installRust(
      'install-tools',
      env.pins,
      env.toolsDir,
      env.cacheDir,
      rustTriple,
      env.rustToolchain,
      env.rustTarget,
    );
  }

  console.error(`\n[install-tools] done. Tools directory: ${env.toolsDir}`);
  console.error(`  export PATH="${env.binDir}:$PATH"`);
  if (withRust) {
    console.error(
      `  export RUSTUP_HOME="${env.toolsDir}/rustup" CARGO_HOME="${env.toolsDir}/cargo"`,
    );
    console.error(`  export PATH="${env.toolsDir}/cargo/bin:$PATH"`);
  }
}

if (import.meta.main) {
  try {
    await installTools(process.argv.slice(2));
  } catch (error) {
    die('install-tools', error instanceof Error ? error.message : String(error));
  }
}
