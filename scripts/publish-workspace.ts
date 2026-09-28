import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

function alreadyPublished(name: string, version: string): boolean {
  const result = Bun.spawnSync(['bun', 'pm', 'view', `${name}@${version}`, 'version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0;
}

export function publishWorkspaces(rootDir = process.cwd(), dryRun = false): string[] {
  const published: string[] = [];
  for (const directory of workspacePackageDirs(rootDir)) {
    const pkgDir = join(rootDir, directory);
    const pkg = readPackage(pkgDir);
    if (pkg.private === true) {
      console.log(`Skipping ${pkg.name} (private)`);
      continue;
    }
    if (pkg.scripts?.build) {
      console.log(`Building ${pkg.name} from ${directory}`);
      const build = Bun.spawnSync(['bun', 'run', 'build'], {
        cwd: pkgDir,
        stdout: 'inherit',
        stderr: 'inherit',
      });
      if (build.exitCode !== 0) throw new Error(`build failed for ${pkg.name}`);
    }
    const packed = packPaths(pkgDir);
    const missing = missingPackedEntries(pkg.files, packed);
    if (missing.length > 0) {
      throw new Error(
        `${pkg.name}@${pkg.version} pack is missing ${missing.join(', ')}. Refusing to publish.`,
      );
    }
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
    const publish = Bun.spawnSync(
      ['npm', 'publish', '--access', 'public', '--provenance', '--ignore-scripts'],
      { cwd: pkgDir, stdout: 'inherit', stderr: 'inherit' },
    );
    if (publish.exitCode !== 0) throw new Error(`npm publish failed for ${pkg.name}`);
    published.push(pkg.name);
  }
  return published;
}

if (import.meta.main) {
  try {
    publishWorkspaces(process.cwd(), Bun.argv.includes('--dry-run'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
