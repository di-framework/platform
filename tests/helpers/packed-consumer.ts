/**
 * Pack a workspace package and install the tarball into a throwaway consumer project, the way a
 * registry install would lay it out, so tests see exactly the files that get published.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');

/** Run a command in `cwd`; throws with its output on a non-zero exit. */
export function run(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')}:\n${result.stdout.toString()}${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

/**
 * The directory of package `name` as resolved from `from`, whatever linker laid it out (hoisted
 * or isolated). Packages whose `exports` hide `./package.json` are found from their entry point.
 */
export function packageRoot(name: string, from: string): string {
  try {
    return realpathSync(dirname(Bun.resolveSync(`${name}/package.json`, from)));
  } catch {
    let dir = dirname(Bun.resolveSync(name, from));
    while (dir !== dirname(dir)) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) {
        return realpathSync(dir);
      }
      dir = dirname(dir);
    }
    throw new Error(`cannot find the package root of ${name} from ${from}`);
  }
}

/** The TypeScript compilers a published declaration must satisfy, by major version. */
export const typescriptCompilers = {
  typescript7: join(packageRoot('typescript', repoRoot), 'bin', 'tsc'),
  typescript6: join(packageRoot('@typescript/typescript6', repoRoot), 'bin', 'tsc6'),
} as const;

export interface PackedConsumer {
  /** The consumer project root (has a `package.json` and `node_modules`). */
  project: string;
  /** Where the tarball was extracted, i.e. `node_modules/<name>`. */
  installed: string;
}

/**
 * Build and pack the workspace package in `packageDir`, then extract it into a fresh ESM consumer
 * under `scratch`. Each of `links` is resolved from `packageDir` and symlinked into the consumer's
 * `node_modules`, standing in for an install of the package's dependencies.
 */
export function installPacked(
  packageDir: string,
  scratch: string,
  options: { links?: readonly string[] } = {},
): PackedConsumer {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    name: string;
  };
  const slug = manifest.name.replace(/^@/, '').replace('/', '-');
  run(['bun', 'run', 'build'], packageDir);
  const packs = join(scratch, `${slug}-pack`);
  mkdirSync(packs, { recursive: true });
  run(['bun', 'pm', 'pack', '--ignore-scripts', '--destination', packs], packageDir);
  const tarball = readdirSync(packs).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error(`bun pm pack produced no tarball for ${manifest.name}`);

  const project = join(scratch, `${slug}-consumer`);
  const installed = join(project, 'node_modules', manifest.name);
  mkdirSync(dirname(installed), { recursive: true });
  run(['tar', '-xzf', join(packs, tarball)], dirname(installed));
  run(['mv', join(dirname(installed), 'package'), installed], project);
  for (const link of options.links ?? []) {
    const target = join(project, 'node_modules', link);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(packageRoot(link, packageDir), target);
  }
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'consumer', type: 'module' }),
  );
  return { project, installed };
}
