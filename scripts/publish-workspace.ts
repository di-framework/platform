import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packedLine = /^packed\s+\S+\s+(.+)$/;

type PackageManifest = {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  scripts?: { build?: string };
};

export function workspacePackageDirs(rootDir = process.cwd()): string[] {
  const root = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
    workspaces?: string[];
  };
  const dirs: string[] = [];
  for (const pattern of root.workspaces ?? []) {
    const directories = pattern.endsWith('/*')
      ? readdirSync(join(rootDir, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(pattern.slice(0, -2), entry.name))
      : [pattern];
    for (const directory of directories) {
      if (existsSync(join(rootDir, directory, 'package.json'))) dirs.push(directory);
    }
  }
  return dirs;
}

export function missingPackedEntries(
  filesField: string[] | undefined,
  packedPaths: string[],
): string[] {
  const missing: string[] = [];
  for (const entry of filesField ?? []) {
    const prefix = entry.replace(/\/$/, '');
    const present = packedPaths.some((path) => path === prefix || path.startsWith(`${prefix}/`));
    if (!present) missing.push(entry);
  }
  return missing;
}

export function parsePackedPaths(packOutput: string): string[] {
  return packOutput
    .split('\n')
    .map((line) => packedLine.exec(line)?.[1])
    .filter((path): path is string => path !== undefined);
}

export function packPaths(pkgDir: string): string[] {
  const result = Bun.spawnSync(['bun', 'pm', 'pack', '--dry-run', '--ignore-scripts'], {
    cwd: pkgDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `bun pm pack failed in ${pkgDir}`);
  }
  return parsePackedPaths(result.stdout.toString());
}

function readPackage(pkgDir: string): PackageManifest {
  return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as PackageManifest;
}

export const LICENSE_FILES = ['LICENSE-MIT', 'LICENSE-APACHE'] as const;

/** Throws unless every license file is committed at the repository root. */
export function assertRootLicenses(rootDir: string): void {
  for (const license of LICENSE_FILES) {
    if (!existsSync(join(rootDir, license))) {
      throw new Error(`root ${license} is missing; cannot publish without license files`);
    }
  }
}

/** License files absent from a pack. Never fails open: all are always required. */
export function missingLicenses(packedPaths: string[]): string[] {
  return LICENSE_FILES.filter((license) => !packedPaths.includes(license));
}

function alreadyPublished(name: string, version: string): boolean {
  const result = Bun.spawnSync(['bun', 'pm', 'view', `${name}@${version}`, 'version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0;
}

function buildPackage(pkgDir: string, pkg: PackageManifest, prebuilt: ReadonlySet<string>): void {
  if (!pkg.scripts?.build) return;
  if (prebuilt.has(pkg.name)) {
    console.log(`Using the existing build of ${pkg.name} (--prebuilt)`);
    return;
  }
  console.log(`Building ${pkg.name} from ${pkgDir}`);
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: pkgDir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (build.exitCode !== 0) throw new Error(`build failed for ${pkg.name}`);
}

/** Throws unless the pack carries both licenses and every `files` entry. */
function assertCompletePack(pkg: PackageManifest, packed: string[]): void {
  const missingLicense = missingLicenses(packed);
  if (missingLicense.length > 0) {
    throw new Error(
      `${pkg.name}@${pkg.version} pack is missing ${missingLicense.join(', ')}. Refusing to publish.`,
    );
  }
  const missing = missingPackedEntries(pkg.files, packed);
  if (missing.length > 0) {
    throw new Error(
      `${pkg.name}@${pkg.version} pack is missing ${missing.join(', ')}. Refusing to publish.`,
    );
  }
}

function publicPackages(
  rootDir: string,
): { directory: string; pkgDir: string; pkg: PackageManifest }[] {
  const result: { directory: string; pkgDir: string; pkg: PackageManifest }[] = [];
  for (const directory of workspacePackageDirs(rootDir)) {
    const pkgDir = join(rootDir, directory);
    const pkg = readPackage(pkgDir);
    if (pkg.private === true) {
      console.log(`Skipping ${pkg.name} (private)`);
      continue;
    }
    result.push({ directory, pkgDir, pkg });
  }
  return result;
}

export function publishWorkspaces(rootDir = process.cwd(), dryRun = false): string[] {
  assertRootLicenses(rootDir);
  const published: string[] = [];
  for (const { directory, pkgDir, pkg } of publicPackages(rootDir)) {
    buildPackage(pkgDir, pkg, new Set());
    const packed = packPaths(pkgDir);
    assertCompletePack(pkg, packed);
    if (dryRun) {
      console.log(`Dry run ${pkg.name}@${pkg.version} (${packed.length} files)`);
      published.push(pkg.name);
      continue;
    }
    if (alreadyPublished(pkg.name, pkg.version)) {
      console.log(`Skipping ${pkg.name}@${pkg.version} (already published)`);
      continue;
    }
    console.log(`Publishing ${pkg.name}@${pkg.version} from ${directory}`);
    npmPublish(pkgDir, pkgDir);
    published.push(pkg.name);
  }
  return published;
}

function npmPublish(target: string, cwd: string): void {
  const publish = Bun.spawnSync(
    ['npm', 'publish', target, '--access', 'public', '--provenance', '--ignore-scripts'],
    { cwd, stdout: 'inherit', stderr: 'inherit' },
  );
  if (publish.exitCode !== 0) throw new Error(`npm publish failed for ${target}`);
}

/** One tarball in a pack directory, as recorded in its manifest. */
export type PackedPackage = {
  name: string;
  version: string;
  directory: string;
  filename: string;
  sha256: string;
};

export const PACK_MANIFEST = 'packages.json';

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

type NpmPackResult = { name: string; version: string; filename: string; files: { path: string }[] };

/** Runs `npm pack` (the packer `npm publish` uses) into `packDir` without lifecycle scripts. */
export function npmPack(pkgDir: string, packDir: string): NpmPackResult {
  const result = Bun.spawnSync(
    ['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
    { cwd: pkgDir, stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `npm pack failed in ${pkgDir}`);
  }
  const [packed] = JSON.parse(result.stdout.toString()) as NpmPackResult[];
  if (!packed) throw new Error(`npm pack printed no result in ${pkgDir}`);
  return packed;
}

/**
 * Builds every public package (except `prebuilt` ones, whose build already ran), packs each into
 * `packDir`, refuses an incomplete pack, and records every tarball's sha256 in `packages.json`.
 * The tarballs are exactly what `publishPacked` later hands to npm.
 */
export function packWorkspaces(
  rootDir: string,
  packDir: string,
  prebuilt: ReadonlySet<string> = new Set(),
): PackedPackage[] {
  assertRootLicenses(rootDir);
  mkdirSync(packDir, { recursive: true });
  if (readdirSync(packDir).length > 0) throw new Error(`pack directory ${packDir} is not empty`);
  const packages = publicPackages(rootDir);
  const names = new Set(packages.map(({ pkg }) => pkg.name));
  for (const name of prebuilt) {
    if (!names.has(name)) throw new Error(`--prebuilt ${name} is not a public workspace package`);
  }
  const manifest: PackedPackage[] = [];
  for (const { directory, pkgDir, pkg } of packages) {
    buildPackage(pkgDir, pkg, prebuilt);
    const packed = npmPack(pkgDir, packDir);
    if (packed.name !== pkg.name || packed.version !== pkg.version) {
      throw new Error(`npm pack in ${directory} produced ${packed.name}@${packed.version}`);
    }
    assertCompletePack(
      pkg,
      packed.files.map((file) => file.path),
    );
    const sha256 = sha256File(join(packDir, packed.filename));
    console.log(`Packed ${pkg.name}@${pkg.version} -> ${packed.filename} sha256:${sha256}`);
    manifest.push({
      name: pkg.name,
      version: pkg.version,
      directory,
      filename: packed.filename,
      sha256,
    });
  }
  writeFileSync(join(packDir, PACK_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Reads `packages.json` and throws unless the directory holds exactly the tarballs it lists, each
 * with its recorded sha256.
 */
export function verifyPackDir(packDir: string): PackedPackage[] {
  const manifest = JSON.parse(
    readFileSync(join(packDir, PACK_MANIFEST), 'utf8'),
  ) as PackedPackage[];
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error(`${PACK_MANIFEST} lists no packages`);
  }
  const listed = new Set<string>();
  for (const entry of manifest) {
    if (!/^[^/\\]+\.tgz$/.test(entry.filename) || listed.has(entry.filename)) {
      throw new Error(`${PACK_MANIFEST} has an invalid or repeated tarball ${entry.filename}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`${PACK_MANIFEST} has no sha256 for ${entry.filename}`);
    }
    listed.add(entry.filename);
    const actual = sha256File(join(packDir, entry.filename));
    if (actual !== entry.sha256) {
      throw new Error(
        `${entry.filename} sha256 ${actual} differs from the packed ${entry.sha256}. Refusing to publish.`,
      );
    }
  }
  const unlisted = readdirSync(packDir).filter(
    (file) => file !== PACK_MANIFEST && !listed.has(file),
  );
  if (unlisted.length > 0) throw new Error(`unlisted files in ${packDir}: ${unlisted.join(', ')}`);
  return manifest;
}

export type PublishPackedDeps = {
  isPublished?: (name: string, version: string) => boolean;
  publish?: (tarball: string) => void;
};

/** Publishes the verified tarballs in `packDir` as they are. Nothing is built or repacked. */
export function publishPacked(packDir: string, deps: PublishPackedDeps = {}): string[] {
  const isPublished = deps.isPublished ?? alreadyPublished;
  const publish = deps.publish ?? ((tarball: string) => npmPublish(tarball, packDir));
  const manifest = verifyPackDir(packDir);
  const published: string[] = [];
  for (const entry of manifest) {
    if (isPublished(entry.name, entry.version)) {
      console.log(`Skipping ${entry.name}@${entry.version} (already published)`);
      continue;
    }
    console.log(
      `Publishing ${entry.name}@${entry.version} from ${entry.filename} sha256:${entry.sha256}`,
    );
    publish(resolve(packDir, entry.filename));
    published.push(entry.name);
  }
  return published;
}

export type PublishArgs =
  | { mode: 'publish' | 'dry-run' }
  | { mode: 'pack'; packDir: string; prebuilt: Set<string> }
  | { mode: 'publish-packed' | 'verify-packed'; packDir: string };

export function parseArgs(argv: string[]): PublishArgs {
  let pack: string | undefined;
  let publishPackedDir: string | undefined;
  let verifyPackedDir: string | undefined;
  let dryRun = false;
  const prebuilt = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--pack') pack = value();
    else if (arg === '--prebuilt') prebuilt.add(value());
    else if (arg === '--publish-packed') publishPackedDir = value();
    else if (arg === '--verify-packed') verifyPackedDir = value();
    else throw new Error(`unknown argument ${arg}`);
  }
  const modes = [dryRun, pack, publishPackedDir, verifyPackedDir].filter(
    (mode) => mode !== false && mode !== undefined,
  );
  if (modes.length > 1) {
    throw new Error('use only one of --dry-run, --pack, --publish-packed, --verify-packed');
  }
  if (prebuilt.size > 0 && pack === undefined) throw new Error('--prebuilt only applies to --pack');
  if (pack !== undefined) return { mode: 'pack', packDir: pack, prebuilt };
  if (publishPackedDir !== undefined) return { mode: 'publish-packed', packDir: publishPackedDir };
  if (verifyPackedDir !== undefined) return { mode: 'verify-packed', packDir: verifyPackedDir };
  return { mode: dryRun ? 'dry-run' : 'publish' };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.mode === 'pack') packWorkspaces(process.cwd(), resolve(args.packDir), args.prebuilt);
    else if (args.mode === 'publish-packed') publishPacked(resolve(args.packDir));
    else if (args.mode === 'verify-packed') {
      for (const entry of verifyPackDir(resolve(args.packDir))) {
        console.log(`${entry.sha256}  ${entry.filename}  ${entry.name}@${entry.version}`);
      }
    } else publishWorkspaces(process.cwd(), args.mode === 'dry-run');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
