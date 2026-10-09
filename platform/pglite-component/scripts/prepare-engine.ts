/** Fetch pinned inputs and wrap PGlite's core module with a private WIT ABI. */
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { $ } from 'bun';
import { buildEngineSource } from './build-engine.ts';
import { type Context, logger, run } from './lib/cli.ts';
import { fetchVerified } from './lib/fetch.ts';
import { fileExists } from './lib/fs.ts';
import { requiredPin } from './lib/versions.ts';

const log = logger('prepare-engine');

export const ARCHIVE_PREFIX = 'tmp/pglite/';
export const BOOTSTRAP_FILES = ['initdb.boot.txt', 'initdb.single.txt'];
/** Directory of the bootstrap paths baked into the engine WAT: a text pattern to rewrite, not a directory this script touches. */
export const ENGINE_BOOTSTRAP_DIR = posix.join(posix.sep, 'tmp');

export const PG_STRONG_RANDOM_REPLACEMENT = [
  '  (func $pg_strong_random (param i32 i32) (result i32)',
  '    local.get 0',
  '    local.get 1',
  '    call $__imported_wasi_snapshot_preview1_random_get',
  '    i32.eqz',
  '  )',
].join('\n');

/** Rewrite the extracted engine WAT: WASI entropy, relocatable bootstrap paths. */
export function patchEngineWat(wat: string, bridgeWat: string): string {
  let patched = wat;
  const randomMatches = patched.match(/ {2}\(func \$pg_strong_random .*?\n {2}\)/s);
  if (randomMatches?.length !== 1 || !randomMatches[0]) {
    throw new Error('engine pg_strong_random ABI changed');
  }
  patched = patched.replace(
    / {2}\(func \$pg_strong_random .*?\n {2}\)/s,
    PG_STRONG_RANDOM_REPLACEMENT,
  );

  for (const name of BOOTSTRAP_FILES) {
    const needle = posix.join(ENGINE_BOOTSTRAP_DIR, name);
    const occurrences = patched.split(needle).length - 1;
    if (occurrences !== 1) throw new Error(`engine bootstrap path changed: ${needle}`);
    patched = patched.replaceAll(needle, `./../${name}`);
  }

  const exportMatches = patched.match(/ {2}\(export "_start" \(func \$_start\)\)\n/);
  if (!exportMatches) throw new Error('engine _start export ABI changed');
  patched = patched.replace(/ {2}\(export "_start" \(func \$_start\)\)\n/, '');
  return `${patched.trimEnd().slice(0, -1)}${bridgeWat}\n)\n`;
}

export interface ArchiveEntry {
  /** Forward-slash path as stored in the archive. */
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  isHardlink: boolean;
  isFile: boolean;
  /** Raw link target for symlinks/hardlinks. */
  linkTarget?: string;
}

/**
 * Validate extracted archive entries (mirrors the old Python tar filter):
 * everything must live under `tmp/pglite/` with no `..` or absolute escapes,
 * and links may only point inside the same prefix. Returns the stripped names.
 */
export function validateArchiveMembers(members: ArchiveEntry[]): string[] {
  const safe: string[] = [];
  for (const member of members) {
    if (member.isDirectory) continue;
    if (member.isSymlink || member.isHardlink) {
      // Mirror posixpath.join: an absolute link target discards the dirname.
      const target = member.linkTarget ?? '';
      const linked = member.isSymlink
        ? target.startsWith('/')
          ? posix.normalize(target)
          : posix.normalize(posix.join(posix.dirname(member.name), target))
        : posix.normalize(target);
      if (!linked.startsWith(ARCHIVE_PREFIX))
        throw new Error(`unsafe archive link: ${member.name}`);
    } else if (!member.isFile) {
      throw new Error(`unexpected archive member: ${member.name}`);
    }
    if (!member.name.startsWith(ARCHIVE_PREFIX))
      throw new Error(`unsafe archive member: ${member.name}`);
    const stripped = member.name.slice(ARCHIVE_PREFIX.length);
    if (!stripped || stripped.includes('..') || stripped.startsWith('/')) {
      throw new Error(`unsafe archive member: ${member.name}`);
    }
    safe.push(stripped);
  }
  return safe;
}

interface WalkedEntry extends ArchiveEntry {
  /** Absolute path on disk. */
  absPath: string;
}

async function walkExtracted(dir: string, base: string, out: WalkedEntry[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absPath = join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkExtracted(absPath, rel, out);
    } else if (entry.isSymbolicLink()) {
      out.push({
        name: rel,
        isDirectory: false,
        isSymlink: true,
        isHardlink: false,
        isFile: false,
        linkTarget: await readlink(absPath),
        absPath,
      });
    } else if (entry.isFile()) {
      out.push({
        name: rel,
        isDirectory: false,
        isSymlink: false,
        isHardlink: false,
        isFile: true,
        absPath,
      });
    } else {
      const st = await lstat(absPath);
      out.push({
        name: rel,
        isDirectory: false,
        isSymlink: false,
        isHardlink: false,
        isFile: st.isFile(),
        absPath,
      });
    }
  }
}

/**
 * Extract `archive` (xz-compressed tar) into `runtimeDir`, keeping only
 * validated `tmp/pglite/` members. Uses the host `tar` for decompression and
 * enforces containment in TypeScript before any file is installed.
 */
export async function extractRuntime(archive: string, runtimeDir: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'df-pglite-engine.'));
  try {
    await $`tar -xJf ${archive} -C ${scratch}`;
    const walked: WalkedEntry[] = [];
    await walkExtracted(scratch, '', walked);
    const safe = new Set(validateArchiveMembers(walked));
    await mkdir(runtimeDir, { recursive: true });
    for (const entry of walked) {
      if (!safe.has(entry.name.slice(ARCHIVE_PREFIX.length))) continue;
      const stripped = entry.name.slice(ARCHIVE_PREFIX.length);
      const target = join(runtimeDir, stripped);
      await mkdir(join(target, '..'), { recursive: true });
      if (entry.isSymlink) {
        await rm(target, { force: true });
        await symlink(entry.linkTarget ?? '', target);
      } else {
        const st = await lstat(entry.absPath);
        if (!st.isFile()) throw new Error(`unexpected archive member: ${entry.name}`);
        await Bun.write(target, Bun.file(entry.absPath));
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function prepareEngine(ctx: Context): Promise<void> {
  const { pkgDir } = ctx;
  const { pins } = ctx.tools;
  const out = join(pkgDir, 'target', 'engine');
  await mkdir(out, { recursive: true });

  await buildEngineSource(ctx);

  const archive = join(out, 'pglite-source.tar.xz');
  const adapter = join(out, 'adapter.wasm');
  await fetchVerified(
    requiredPin(pins, 'PGLITE_ADAPTER_URL'),
    adapter,
    requiredPin(pins, 'PGLITE_ADAPTER_SHA256'),
    { log },
  );

  const bridgeWatSource = join(pkgDir, 'engine', 'bridge.wat');
  const engineWit = join(pkgDir, 'wit', 'deps', 'pglite-engine');
  const wasmToolsVersion = (await $`wasm-tools --version`.text()).trim();
  const hasher = new Bun.CryptoHasher('sha256');
  for (const file of [
    archive,
    adapter,
    import.meta.path,
    bridgeWatSource,
    join(engineWit, 'engine.wit'),
  ]) {
    hasher.update(await Bun.file(file).bytes());
  }
  hasher.update(wasmToolsVersion);
  const stamp = hasher.digest('hex');
  const stampFile = join(out, 'stamp');
  if ((await fileExists(stampFile)) && (await Bun.file(stampFile).text()) === stamp) return;

  const runtime = join(out, 'runtime');
  await mkdir(runtime, { recursive: true });
  await extractRuntime(archive, runtime);

  const engineWat = join(out, 'engine.wat');
  const bridgeWat = join(out, 'bridge.wat');
  const coreWasm = join(out, 'engine.core.wasm');
  const engineWasm = join(out, 'engine.wasm');
  await $`wasm-tools print ${join(runtime, 'bin', 'pglite.wasi')} -o ${engineWat}`;
  await Bun.write(
    bridgeWat,
    patchEngineWat(await Bun.file(engineWat).text(), await Bun.file(bridgeWatSource).text()),
  );
  await $`wasm-tools component embed ${engineWit} --world embedded-engine ${bridgeWat} -o ${coreWasm}`;
  await $`wasm-tools component new ${coreWasm} --adapt wasi_snapshot_preview1=${adapter} -o ${engineWasm}`;
  await $`wasm-tools validate ${engineWasm}`;
  await Bun.write(stampFile, stamp);
  log('engine ready');
}

if (import.meta.main) await run('prepare-engine', prepareEngine);
