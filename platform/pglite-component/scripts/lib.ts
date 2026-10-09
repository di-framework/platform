/** Shared helpers for the di-framework:pglite Bun/TypeScript build scripts. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Directory of the pglite-component package derived from a script's import.meta.url. */
export function packageDir(scriptUrl: string): string {
  return resolve(dirname(new URL(scriptUrl).pathname), '..');
}

/** Parse `scripts/tool-versions.env` (`KEY=VALUE`, `#` comments, blank lines skipped). */
export function parseVersions(text: string): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) pins[key] = value;
  }
  return pins;
}

export async function readFileText(path: string): Promise<string> {
  return Bun.file(path).text();
}

/** Pinned versions + directory layout. Call {@link setupEnv} before spawning tools. */
export interface ToolEnv {
  pkgDir: string;
  toolsDir: string;
  binDir: string;
  cacheDir: string;
  pins: Record<string, string>;
  rustToolchain: string;
  rustTarget: string;
}

export async function loadToolEnv(pkgDir: string): Promise<ToolEnv> {
  const pins = parseVersions(await readFileText(join(pkgDir, 'scripts', 'tool-versions.env')));
  const toolsDir = process.env.DF_PGLITE_TOOLS_DIR ?? join(pkgDir, '.tools');
  const rustToolchain = requiredPin(pins, 'RUST_TOOLCHAIN');
  const rustTarget = requiredPin(pins, 'RUST_TARGET');
  return {
    pkgDir,
    toolsDir,
    binDir: join(toolsDir, 'bin'),
    cacheDir: join(toolsDir, 'cache'),
    pins,
    rustToolchain,
    rustTarget,
  };
}

export function requiredPin(pins: Record<string, string>, name: string): string {
  const value = pins[name];
  if (!value) throw new Error(`missing pin ${name} in scripts/tool-versions.env`);
  return value;
}

function prependPath(dir: string): void {
  const current = process.env.PATH ?? '';
  if (!current.split(':').includes(dir)) process.env.PATH = `${dir}:${current}`;
}

async function executable(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Mirror of the old `scripts/env.sh`: put the pinned hermetic tools on PATH
 * and export the RUSTFLAGS the Rust build needs. Idempotent per package dir.
 */
export async function setupEnv(env: ToolEnv): Promise<void> {
  const { pkgDir, toolsDir } = env;
  if (await isDirectory(join(toolsDir, 'bin'))) prependPath(join(toolsDir, 'bin'));

  if ((await executable(join(toolsDir, 'cargo', 'bin', 'cargo'))) && !process.env.RUSTUP_HOME) {
    process.env.RUSTUP_HOME = join(toolsDir, 'rustup');
    process.env.CARGO_HOME = join(toolsDir, 'cargo');
    prependPath(join(toolsDir, 'cargo', 'bin'));
  }

  if (Bun.which('rustup')) {
    const found = await Bun.$`rustup which --toolchain ${env.rustToolchain} cargo`
      .nothrow()
      .quiet()
      .text();
    const cargo = found.trim();
    if (cargo) prependPath(dirname(cargo));
  }

  if (process.env.DF_PGLITE_ENV_LOADED !== pkgDir) {
    const cargoHome = process.env.CARGO_HOME ?? `${process.env.HOME ?? ''}/.cargo`;
    const flags = `${process.env.RUSTFLAGS ?? ''} --remap-path-prefix=${pkgDir}=/di-framework-pglite-component --remap-path-prefix=${cargoHome}=/cargo`;
    process.env.RUSTFLAGS = flags.trim();
    process.env.DF_PGLITE_ENV_LOADED = pkgDir;
  }
}

/** Lines a POSIX shell can `eval` to reproduce {@link setupEnv} (for Makefile use). */
export async function exportEnvLines(env: ToolEnv): Promise<string[]> {
  await setupEnv(env);
  const lines = [
    `export DF_PGLITE_TOOLS_DIR=${shellQuote(env.toolsDir)}`,
    `export PATH=${shellQuote(process.env.PATH ?? '')}`,
  ];
  if (process.env.RUSTUP_HOME)
    lines.push(`export RUSTUP_HOME=${shellQuote(process.env.RUSTUP_HOME)}`);
  if (process.env.CARGO_HOME) lines.push(`export CARGO_HOME=${shellQuote(process.env.CARGO_HOME)}`);
  if (process.env.RUSTFLAGS) lines.push(`export RUSTFLAGS=${shellQuote(process.env.RUSTFLAGS)}`);
  lines.push(`export DF_PGLITE_ENV_LOADED=${shellQuote(process.env.DF_PGLITE_ENV_LOADED ?? '')}`);
  return lines;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export function log(tag: string, message: string): void {
  console.error(`[${tag}] ${message}`);
}

/** Print an error and exit (mirrors the `die()` helpers in the old shell scripts). */
export function die(tag: string, message: string, code = 1): never {
  console.error(`[${tag}] error: ${message}`);
  process.exit(code);
}

/** Exit 2 with usage text for unknown CLI arguments. */
export function dieUsage(tag: string, message: string): never {
  console.error(message);
  die(tag, 'see --help', 2);
}

/** SHA-256 hex digest of a file (streamed, safe for large engine archives). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveDigest(hash.digest('hex')));
  });
}

/**
 * Download `url` to `dest` (via `dest.part`) and verify its SHA-256.
 * Skips the download when a valid cached copy already exists.
 */
export async function fetchVerified(
  tag: string,
  url: string,
  dest: string,
  expectedSha: string,
  attempts = 3,
): Promise<void> {
  if (!expectedSha)
    die(tag, `no pinned checksum for ${dest} on this platform; see scripts/tool-versions.env`);
  await mkdir(dirname(dest), { recursive: true });
  if (await fileExists(dest)) {
    const actual = await sha256File(dest);
    if (actual === expectedSha) {
      log(tag, `cached  ${dirname(dest) === '.' ? dest : dest.split('/').pop()}`);
      return;
    }
    log(tag, `cached copy has wrong checksum; re-downloading`);
    await rm(dest, { force: true });
  }
  log(tag, `fetch   ${url}`);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const data = new Uint8Array(await response.arrayBuffer());
      await Bun.write(`${dest}.part`, data);
      const actual = await sha256File(`${dest}.part`);
      if (actual !== expectedSha) {
        await rm(`${dest}.part`, { force: true });
        throw new Error(`checksum mismatch: expected ${expectedSha}, got ${actual}`);
      }
      await rename(`${dest}.part`, dest);
      log(tag, `verified sha256=${expectedSha}`);
      return;
    } catch (error) {
      lastError = error;
      await rm(`${dest}.part`, { force: true });
      if (attempt < attempts) log(tag, `attempt ${attempt} failed, retrying`);
    }
  }
  die(tag, `download failed for ${url}: ${String(lastError)}`);
}

export { chmod, mkdir, readdir, rm, stat };
