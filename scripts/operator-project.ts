#!/usr/bin/env bun
/**
 * The install project the platform operator image bakes (#431):
 * platform/operator/internal/installer/project/{package.json,package-lock.json,plugins.txt}.
 *
 * package.json pins the operator's default platform version: the @di-framework/platform version
 * an instance installs without npm or the Pulumi plugin host. The operator embeds it, and the image
 * bakes the project and its Pulumi plugins from these files, so the three cannot disagree.
 *
 * The release PR (auto-tag.yml) runs:
 *   bun scripts/operator-project.ts bump
 *     pins @di-framework/platform to the newest published release (npm's `latest`), which is never
 *     the release the PR is about to publish: that one is not on npm until its tag is released.
 *     Rewrites package-lock.json (`npm install --package-lock-only`) and plugins.txt from each
 *     @pulumi provider's checksums on its GitHub release. A pin that is already current changes
 *     nothing.
 *   bun scripts/operator-project.ts bump <version>
 *     pins an exact published version instead.
 *   Either form refuses a version older than the current pin (a dist-tag rollback, or a manual
 *   bump ahead of `latest`), so the baked default never moves backwards.
 *
 * Only node builtins and the npm CLI.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_DIR = 'platform/operator/internal/installer/project';
export const PLATFORM_PACKAGE = '@di-framework/platform';
export const ARCHES = ['amd64', 'arm64'] as const;

export const PLUGINS_HEADER = `# The Pulumi resource plugins the operator image bakes for this project (#431): one line per plugin
# and architecture, \`<name> <version> <arch> <sha256 of pulumi-resource-<name>-v<version>-linux-<arch>.tar.gz>\`.
# The versions are the @pulumi/<name> versions in package-lock.json; the digests are from each
# provider's GitHub release (pulumi-<name>_<version>_checksums.txt). Written by
# \`bun scripts/operator-project.ts bump\`; installer tests and the image build check them.
`;

export function assertVersion(version: string | undefined): string {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`expected a release version like 6.0.22, got ${JSON.stringify(version)}`);
  }
  return version;
}

/** Compares two release versions (major.minor.patch): negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

type Manifest = { dependencies: Record<string, string> } & Record<string, unknown>;

/** package.json with the platform pinned to version. */
export function setPlatformVersion(text: string, version: string): string {
  const pkg = JSON.parse(text) as Manifest;
  if (!pkg.dependencies?.[PLATFORM_PACKAGE]) {
    throw new Error(`${PROJECT_DIR}/package.json has no ${PLATFORM_PACKAGE} dependency`);
  }
  pkg.dependencies[PLATFORM_PACKAGE] = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** The Pulumi provider packages a lockfile installs: name (without @pulumi/) to version. */
export function providers(lockText: string): Map<string, string> {
  const lock = JSON.parse(lockText) as { packages: Record<string, { version: string }> };
  const found = new Map<string, string>();
  for (const [path, pkg] of Object.entries(lock.packages)) {
    const name = /^node_modules\/@pulumi\/([^/]+)$/.exec(path)?.[1];
    if (name && name !== 'pulumi') found.set(name, pkg.version);
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}

export const checksumsUrl = (name: string, version: string) =>
  `https://github.com/pulumi/pulumi-${name}/releases/download/v${version}/pulumi-${name}_${version}_checksums.txt`;

export const pluginArchive = (name: string, version: string, arch: string) =>
  `pulumi-resource-${name}-v${version}-linux-${arch}.tar.gz`;

/** The linux archives' digests in a provider's checksums.txt, by arch. */
export function parseChecksums(
  text: string,
  name: string,
  version: string,
): Record<(typeof ARCHES)[number], string> {
  const sums: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [sum, file] = line.trim().split(/\s+/);
    for (const arch of ARCHES) {
      if (file === pluginArchive(name, version, arch) && /^[0-9a-f]{64}$/.test(sum ?? '')) {
        sums[arch] = sum as string;
      }
    }
  }
  for (const arch of ARCHES) {
    if (!sums[arch]) throw new Error(`no sha256 for ${pluginArchive(name, version, arch)}`);
  }
  return sums as Record<(typeof ARCHES)[number], string>;
}

export function renderPlugins(
  plugins: Map<string, string>,
  sums: Map<string, Record<(typeof ARCHES)[number], string>>,
): string {
  const lines = [...plugins].flatMap(([name, version]) =>
    ARCHES.map((arch) => `${name} ${version} ${arch} ${sums.get(name)?.[arch]}`),
  );
  return `${PLUGINS_HEADER}${lines.join('\n')}\n`;
}

/** The versions plugins.txt bakes, by provider name. */
export function bakedPlugins(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [name, version] = line.split(' ');
    if (name && version) found.set(name, version);
  }
  return found;
}

type Deps = {
  latest: () => string;
  lock: (dir: string) => void;
  checksums: (name: string, version: string) => Promise<string>;
};

const run = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
  return r.stdout.trim();
};

export const npmDeps: Deps = {
  latest: () => run('npm', ['view', PLATFORM_PACKAGE, 'version']),
  lock: (dir) =>
    void run(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      dir,
    ),
  checksums: async (name, version) => {
    const res = await fetch(checksumsUrl(name, version));
    if (!res.ok) throw new Error(`${checksumsUrl(name, version)}: HTTP ${res.status}`);
    return res.text();
  },
};

/** Pins the project to version (default npm's latest); returns what it did. */
export async function bump(root: string, wanted: string | undefined, deps = npmDeps) {
  const version = assertVersion(wanted ?? deps.latest());
  const dir = join(root, PROJECT_DIR);
  const pkgPath = join(dir, 'package.json');
  const before = readFileSync(pkgPath, 'utf8');
  const pinned = (JSON.parse(before) as Manifest).dependencies?.[PLATFORM_PACKAGE];
  if (pinned && /^\d+\.\d+\.\d+$/.test(pinned) && compareVersions(version, pinned) < 0) {
    throw new Error(`refusing to move the pin back from ${pinned} to ${version}`);
  }
  const after = setPlatformVersion(before, version);
  if (after !== before) writeFileSync(pkgPath, after);
  deps.lock(dir);
  const plugins = providers(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const pluginsPath = join(dir, 'plugins.txt');
  const current = readFileSync(pluginsPath, 'utf8');
  const baked = bakedPlugins(current);
  const same =
    baked.size === plugins.size && [...plugins].every(([name, v]) => baked.get(name) === v);
  if (!same) {
    const sums = new Map<string, Record<(typeof ARCHES)[number], string>>();
    for (const [name, v] of plugins) {
      sums.set(name, parseChecksums(await deps.checksums(name, v), name, v));
    }
    writeFileSync(pluginsPath, renderPlugins(plugins, sums));
  }
  return { version, changed: after !== before || !same };
}

/** CLI entry point; returns the exit code. */
export async function main(argv: string[], root = process.cwd(), deps = npmDeps): Promise<number> {
  const [command, version] = argv;
  try {
    if (command !== 'bump') throw new Error(`unknown command ${JSON.stringify(command)}`);
    const r = await bump(root, version, deps);
    console.log(
      r.changed
        ? `Pinned the operator's baked install project to ${PLATFORM_PACKAGE}@${r.version}`
        : `The operator's baked install project is already at ${PLATFORM_PACKAGE}@${r.version}`,
    );
    return 0;
  } catch (error) {
    console.error(`::error::${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
