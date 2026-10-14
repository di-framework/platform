/**
 * Prove the engine build is byte-reproducible (#267): build the engine twice
 * from clean copies of this package at different paths and require identical
 * SHA-256 digests for every engine artifact the component embeds.
 */
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { $ } from 'bun';
import { type Args, type Context, logger, parseFlags, run } from './lib/cli.ts';
import { sha256File } from './lib/fetch.ts';
import { fileExists, isDirectory } from './lib/fs.ts';

const log = logger('check-reproducible');

const USAGE = [
  'build the PostgreSQL engine twice from clean copies and compare digests',
  '',
  '  check-reproducible.ts [--work-dir DIR] [--sdk-cache DIR] [--keep]',
  '',
  '  --work-dir DIR   where the two package copies are built (default: a new directory',
  '                   under the system temp dir; keep it outside the repository, or',
  '                   `bun test` picks up the copied test files)',
  '  --sdk-cache DIR  seed each copy with these SDK tarballs instead of downloading them',
  '                   (default: target/engine/source/build/cache when it exists; the',
  '                   recipe still verifies every tarball against its pinned sha256)',
  '  --keep           keep both copies after a successful comparison',
].join('\n');

const FLAGS = {
  'work-dir': { type: 'string' },
  'sdk-cache': { type: 'string' },
  keep: { type: 'boolean' },
} as const;

export interface ReproOptions {
  workDir?: string;
  sdkCache?: string;
  keep: boolean;
}

export function parseReproArgs(argv: string[]): Args<ReproOptions> {
  const flags = parseFlags(argv, FLAGS, USAGE);
  if (flags.help) return flags;
  return {
    help: false,
    workDir: flags.values['work-dir'],
    sdkCache: flags.values['sdk-cache'],
    keep: flags.values.keep === true,
  };
}

/** Engine artifacts compared between the two builds, relative to the package. */
export const ENGINE_ARTIFACTS = [
  'target/engine/source/build/out/pglite.wasi',
  'target/engine/engine.core.wasm',
  'target/engine/engine.wasm',
] as const;

/** Support filesystem build.rs embeds next to the engine; compared file by file. */
export const RUNTIME_TREE = 'target/engine/runtime';

/** SDK tarball cache of the upstream recipe inside an engine checkout. */
export const SDK_CACHE = 'target/engine/source/build/cache';

/** Path -> digest for every regular file (sha256) and symlink (its target). */
export type Digests = Map<string, string>;

export async function digestTree(root: string): Promise<Digests> {
  const out: Digests = new Map();
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(abs, name);
      else if (entry.isSymbolicLink()) out.set(name, `-> ${await readlink(abs)}`);
      else out.set(name, await sha256File(abs));
    }
  };
  await walk(root, '');
  return out;
}

/** One digest for a whole tree, stable across hosts: sorted `path\0digest\n` lines. */
export function combineDigests(digests: Digests): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const name of [...digests.keys()].sort()) hasher.update(`${name}\0${digests.get(name)}\n`);
  return hasher.digest('hex');
}

/** Names whose digests differ, or that exist in only one build. */
export function differingEntries(a: Digests, b: Digests): string[] {
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].filter((name) => a.get(name) !== b.get(name)).sort();
}

/** Copy the package's git-tracked files (working-tree contents) into `dest`. */
async function copyPackage(pkgDir: string, dest: string): Promise<void> {
  const listed = await $`git -C ${pkgDir} ls-files -z --cached --others --exclude-standard`.text();
  const files = listed.split('\0').filter(Boolean);
  if (files.length === 0) throw new Error(`no files to copy from ${pkgDir}`);
  for (const file of files) {
    const from = join(pkgDir, file);
    const st = await lstat(from).catch(() => undefined);
    if (!st?.isFile()) continue; // deleted in the working tree, or not a regular file
    const to = join(dest, file);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

/** Seed `dest` with the regular files in `from` (copy-on-write clones where supported). */
async function seedFiles(from: string, dest: string): Promise<number> {
  if (!(await isDirectory(from))) return 0;
  await mkdir(dest, { recursive: true });
  let seeded = 0;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith('.part')) continue;
    await copyFile(join(from, entry.name), join(dest, entry.name), constants.COPYFILE_FICLONE);
    seeded++;
  }
  return seeded;
}

interface BuildResult {
  artifacts: Map<string, string>;
  runtime: Digests;
}

async function cleanBuild(ctx: Context, copy: string, sdkCache: string): Promise<BuildResult> {
  await rm(copy, { recursive: true, force: true });
  await copyPackage(ctx.pkgDir, copy);
  const seeded = await seedFiles(sdkCache, join(copy, SDK_CACHE));
  log(`clean engine build in ${copy}${seeded ? ` (${seeded} SDK tarballs seeded)` : ''}`);

  const proc = Bun.spawn([process.execPath, join('scripts', 'prepare-engine.ts')], {
    cwd: copy,
    env: ctx.env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`engine build in ${copy} failed with exit ${code}`);

  const artifacts = new Map<string, string>();
  for (const artifact of ENGINE_ARTIFACTS) {
    const path = join(copy, artifact);
    if (!(await fileExists(path))) throw new Error(`expected output missing: ${path}`);
    artifacts.set(artifact, await sha256File(path));
  }
  const runtime = await digestTree(join(copy, RUNTIME_TREE));
  if (runtime.size === 0) throw new Error(`empty engine runtime in ${copy}`);
  artifacts.set(`${RUNTIME_TREE}/`, combineDigests(runtime));
  return { artifacts, runtime };
}

export async function checkReproducible(ctx: Context, options: ReproOptions): Promise<void> {
  const workDir = options.workDir
    ? resolve(ctx.pkgDir, options.workDir)
    : await mkdtemp(join(tmpdir(), 'df-pglite-repro.'));
  const sdkCache = resolve(ctx.pkgDir, options.sdkCache ?? SDK_CACHE);
  const firstDir = join(workDir, 'a');
  const first = await cleanBuild(ctx, firstDir, sdkCache);
  // Without a seed cache, hand the first build's verified SDK tarballs (over
  // 1 GB) to the second instead of downloading them again.
  const secondSeed = (await isDirectory(sdkCache)) ? sdkCache : join(firstDir, SDK_CACHE);
  const second = await cleanBuild(ctx, join(workDir, 'b'), secondSeed);

  let identical = true;
  for (const [name, a] of first.artifacts) {
    const b = second.artifacts.get(name) ?? '(missing)';
    const same = a === b;
    identical &&= same;
    console.log(`${same ? 'same' : 'DIFF'}  ${a}  ${b}  ${name}`);
  }
  if (!identical) {
    for (const name of differingEntries(first.runtime, second.runtime)) {
      console.log(`DIFF  ${RUNTIME_TREE}/${name}`);
    }
    throw new Error(`engine build is not reproducible; both builds kept under ${workDir}`);
  }
  log(`ok: ${first.artifacts.size} engine artifacts identical across two clean builds`);
  if (!options.keep) await rm(workDir, { recursive: true, force: true });
}

export async function reproducible(ctx: Context, argv: string[]): Promise<void> {
  const args = parseReproArgs(argv);
  if (args.help) {
    console.error(USAGE);
    return;
  }
  await checkReproducible(ctx, args);
}

if (import.meta.main) await run('check-reproducible', reproducible);
