#!/usr/bin/env bun
/**
 * The install project the platform operator image bakes (#431):
 * platform/operator/internal/installer/project/{package.json,package-lock.json,plugins.txt}.
 *
 * package.json pins the operator's default platform version: the @di-framework/platform version
 * an instance installs without npm or the Pulumi plugin host. The operator embeds it, and the image
 * bakes the project and its Pulumi plugins from these files, so the three cannot disagree.
 *
 *   bun scripts/operator-project.ts bump <version>
 *     pins @di-framework/platform to exactly that published version. Rewrites package-lock.json
 *     (`npm install --package-lock-only`) and plugins.txt from each @pulumi provider's checksums on
 *     its GitHub release. A pin that is already current changes nothing. release.yml runs it with
 *     the release's own version once publish has put it on npm: the `bake` job, whose files the
 *     release's operator image is built with (so chart N bakes N). The `project-pr` job, which
 *     opens the PR moving main to it, commits bake's files as they are when main's project files
 *     are still the tag's, and runs this bump on main only when they are not.
 *   bun scripts/operator-project.ts bump
 *     pins npm's `latest` instead (by hand).
 *   Either form refuses a version older than the current pin (a dist-tag rollback, or a manual
 *   bump ahead of `latest`), so the baked default never moves backwards.
 *
 * Exit codes (#523): 0 pinned (or already current); 75 (EX_TEMPFAIL) npm does not serve the
 * version yet, or the registry or GitHub failed in a way a retry can fix, so release.yml's bake
 * retries; 2 refused (not an X.Y.Z release version, or older than the pin), which no retry
 * changes; 1 any other failure, also not retried.
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

/** Exit code for a failure a later attempt can fix: npm not serving the version yet (#523). */
export const EXIT_RETRY = 75;
/** Exit code for a refusal no retry changes: a non-release version or a downgrade (#523). */
export const EXIT_REFUSED = 2;

/** A failure a retry can fix: the version is not on npm yet, or the registry was unreachable. */
export class RetryableError extends Error {}
/** A refusal no retry changes. */
export class RefusedError extends Error {}

export function assertVersion(version: string | undefined): string {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new RefusedError(
      `expected a release version like 6.0.22, got ${JSON.stringify(version)}`,
    );
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
  /** Whether npm serves exactly this platform version. */
  published: (version: string) => boolean;
  lock: (dir: string) => void;
  checksums: (name: string, version: string) => Promise<string>;
};

/** npm's error output for a version it does not serve (yet): a 404 packument or no matching version. */
export const NOT_SERVED = /\bE404\b|\bETARGET\b|No matching version|No match found for version/;
/**
 * npm's error output for a registry or network failure a retry can fix: a 5xx or 429 (rate limited),
 * a dropped, refused, timed-out or unreachable connection, or a truncated registry response.
 */
export const TRANSIENT = new RegExp(
  [
    String.raw`\bE5\d\d\b`,
    String.raw`\bE429\b`,
    String.raw`\bETIMEDOUT\b`,
    String.raw`\bERR_SOCKET_TIMEOUT\b`,
    String.raw`\bECONNRESET\b`,
    String.raw`\bECONNREFUSED\b`,
    String.raw`\bECONNABORTED\b`,
    String.raw`\bEPIPE\b`,
    String.raw`\bENETUNREACH\b`,
    String.raw`\bEHOSTUNREACH\b`,
    String.raw`\bEAI_AGAIN\b`,
    String.raw`\bENOTFOUND\b`,
    String.raw`\bFETCH_ERROR\b`,
    'invalid json response body',
    'socket hang up',
  ].join('|'),
);

/** Runs a command; its stderr is echoed and returned for classifying a failure. */
const run = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.stderr) process.stderr.write(r.stderr);
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr ?? '' };
};

/** The error for a failed npm command: retryable when npm does not serve the version yet. */
export function npmFailure(what: string, status: number | null, stderr: string): Error {
  const message = `${what} exited ${status}`;
  return NOT_SERVED.test(stderr) || TRANSIENT.test(stderr)
    ? new RetryableError(message)
    : new Error(message);
}

export const npmDeps: Deps = {
  latest: () => {
    const r = run('npm', ['view', PLATFORM_PACKAGE, 'version']);
    if (r.status !== 0) throw npmFailure(`npm view ${PLATFORM_PACKAGE}`, r.status, r.stderr);
    return r.stdout;
  },
  published: (version) => {
    const r = run('npm', ['view', `${PLATFORM_PACKAGE}@${version}`, 'version']);
    if (r.status === 0) return r.stdout === version;
    if (NOT_SERVED.test(r.stderr)) return false;
    throw npmFailure(`npm view ${PLATFORM_PACKAGE}@${version}`, r.status, r.stderr);
  },
  lock: (dir) => {
    const args = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'];
    const r = run('npm', args, dir);
    if (r.status !== 0) throw npmFailure(`npm ${args.join(' ')}`, r.status, r.stderr);
  },
  checksums: async (name, version) => {
    const url = checksumsUrl(name, version);
    let res: Response;
    try {
      res = await fetch(url);
    } catch (error) {
      throw new RetryableError(`${url}: ${(error as Error).message}`);
    }
    if (res.status >= 500 || res.status === 429) {
      throw new RetryableError(`${url}: HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
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
    throw new RefusedError(`refusing to move the pin back from ${pinned} to ${version}`);
  }
  // npm can take minutes to serve a version it has just published: release.yml retries this.
  if (wanted !== undefined && !deps.published(version)) {
    throw new RetryableError(`npm does not serve ${PLATFORM_PACKAGE}@${version} yet`);
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
    if (command !== 'bump') throw new RefusedError(`unknown command ${JSON.stringify(command)}`);
    const r = await bump(root, version, deps);
    console.log(
      r.changed
        ? `Pinned the operator's baked install project to ${PLATFORM_PACKAGE}@${r.version}`
        : `The operator's baked install project is already at ${PLATFORM_PACKAGE}@${r.version}`,
    );
    return 0;
  } catch (error) {
    const message = (error as Error).message;
    if (error instanceof RetryableError) {
      // A notice, not an error: release.yml retries, and the last attempt reports the failure.
      console.error(`::notice::${message} (retryable)`);
      return EXIT_RETRY;
    }
    console.error(`::error::${message}`);
    return error instanceof RefusedError ? EXIT_REFUSED : 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
