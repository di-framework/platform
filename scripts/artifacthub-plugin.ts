#!/usr/bin/env bun
/**
 * The Headlamp plugin's Artifact Hub entries (#435).
 *
 * The plugin's version is the platform's release version. The release PR (auto-tag.yml) runs:
 *   bun scripts/artifacthub-plugin.ts set-version <X>
 *     sets platform/operator/headlamp-plugin/package.json `version` and the plugin's `version:`
 *     line in the chart's headlamp.pluginsManager.configContent;
 *   (bun run package in the plugin directory)
 *   bun scripts/artifacthub-plugin.ts write <X> [--created-at <RFC 3339>]
 *     writes artifacthub/<X>/artifacthub-pkg.yml and README.md from the packed tarball's sha256.
 *     Rerunning with the same tarball changes nothing; a different checksum for a version that
 *     already has an entry is an error (it would rewrite a published version).
 * The plugin's CI job and the release job run:
 *   bun scripts/artifacthub-plugin.ts verify <X> [--required]
 *     checks the packed tarball against artifacthub/<X>/. Without --required a missing entry
 *     passes (an unreleased version); with it, the entry must exist.
 *
 * Only node builtins: the release job runs this without installing the root workspace.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PLUGIN_DIR = 'platform/operator/headlamp-plugin';
export const ARTIFACTHUB_DIR = `${PLUGIN_DIR}/artifacthub`;
export const CHART_VALUES = 'platform/operator/chart/values.yaml';
export const PLUGIN_NAME = 'di-framework-platform';
export const ARTIFACTHUB_REPO = 'di-framework-platform';
export const SOURCE = `https://artifacthub.io/packages/headlamp/${ARTIFACTHUB_REPO}/${PLUGIN_NAME}`;
const REPO_URL = 'https://github.com/di-framework/platform';

/** The plugin entry's `version:` line in configContent, anchored on its name and source lines. */
const CHART_VERSION_LINE = new RegExp(
  `^(\\s+- name: ${PLUGIN_NAME}\\n\\s+source: ${SOURCE.replaceAll('.', '\\.')}\\n\\s+version: )\\S+$`,
  'm',
);

export function assertVersion(version: string | undefined): string {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`expected a release version like 6.0.18, got ${JSON.stringify(version)}`);
  }
  return version;
}

export const tarballName = (version: string) => `${PLUGIN_NAME}-${version}.tar.gz`;
export const archiveUrl = (version: string) =>
  `${REPO_URL}/releases/download/v${version}/${tarballName(version)}`;
export const entryDir = (version: string) => `${ARTIFACTHUB_DIR}/${version}`;

/** Rewrites the plugin's version in the chart values text; the line must exist. */
export function setChartVersion(text: string, version: string): string {
  if (!CHART_VERSION_LINE.test(text)) {
    throw new Error(`${CHART_VALUES}: no ${PLUGIN_NAME} plugin entry with source ${SOURCE}`);
  }
  return text.replace(CHART_VERSION_LINE, `$1${version}`);
}

/** Sets the plugin's package.json version and the chart's plugin version. */
export function setVersion(root: string, version: string): void {
  const pkgPath = join(root, PLUGIN_DIR, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  const valuesPath = join(root, CHART_VALUES);
  writeFileSync(valuesPath, setChartVersion(readFileSync(valuesPath, 'utf8'), version));
}

/** sha256 of the packed tarball in dist-package/. */
export function tarballSha256(root: string, version: string): string {
  const path = join(root, PLUGIN_DIR, 'dist-package', tarballName(version));
  if (!existsSync(path)) throw new Error(`${path} is missing: run \`bun run package\` first`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function pkgYaml(version: string, sha256: string, createdAt: string): string {
  return `version: ${version}
name: ${PLUGIN_NAME}
displayName: di-framework Platform Instances
createdAt: "${createdAt}"
description: Manage di-framework PlatformInstances from Headlamp.
homeURL: ${REPO_URL}/blob/v${version}/${PLUGIN_DIR}/README.md
license: MIT OR Apache-2.0
keywords:
  - headlamp
  - kubernetes
  - di-framework
links:
  - name: source
    url: ${REPO_URL}/tree/v${version}/${PLUGIN_DIR}
annotations:
  headlamp/plugin/archive-url: ${archiveUrl(version)}
  headlamp/plugin/archive-checksum: sha256:${sha256}
  headlamp/plugin/version-compat: ">=0.46.0"
  headlamp/plugin/distro-compat: in-cluster,web,app
`;
}

export function readme(version: string): string {
  return `# di-framework Platform Instances ${version}

A [Headlamp](https://headlamp.dev) plugin for di-framework PlatformInstances
(\`platform.di-framework.dev/v1alpha1\`), released with di-framework platform v${version}.

The platform operator's Helm chart installs it through Headlamp's plugin manager. See the
[plugin README](${REPO_URL}/blob/v${version}/${PLUGIN_DIR}/README.md).
`;
}

/** The archive checksum recorded in an artifacthub-pkg.yml, or undefined. */
export function recordedSha256(yaml: string): string | undefined {
  return /^\s*headlamp\/plugin\/archive-checksum: sha256:([0-9a-f]{64})\s*$/m.exec(yaml)?.[1];
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** UTC, whole seconds. */
export const rfc3339 = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;

/** Writes artifacthub/<version>/; returns false when an identical entry already exists. */
export function writeEntry(root: string, version: string, createdAt: string): boolean {
  if (!RFC3339.test(createdAt)) throw new Error(`createdAt must be RFC 3339 UTC: ${createdAt}`);
  const sha256 = tarballSha256(root, version);
  const dir = join(root, entryDir(version));
  const pkgPath = join(dir, 'artifacthub-pkg.yml');
  if (existsSync(pkgPath)) {
    const recorded = recordedSha256(readFileSync(pkgPath, 'utf8'));
    if (recorded !== sha256) {
      throw new Error(
        `${entryDir(version)} already records sha256:${recorded}, the tarball is sha256:${sha256}; a published version is not rewritten`,
      );
    }
    return false;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(pkgPath, pkgYaml(version, sha256, createdAt));
  writeFileSync(join(dir, 'README.md'), readme(version));
  return true;
}

/** Checks the packed tarball against artifacthub/<version>/; returns a message on success. */
export function verifyEntry(root: string, version: string, required: boolean): string {
  const pkgPath = join(root, entryDir(version), 'artifacthub-pkg.yml');
  if (!existsSync(pkgPath)) {
    if (required) throw new Error(`${entryDir(version)}/artifacthub-pkg.yml is missing`);
    return `no Artifact Hub entry for ${version} (unreleased); nothing to verify`;
  }
  const recorded = recordedSha256(readFileSync(pkgPath, 'utf8'));
  const sha256 = tarballSha256(root, version);
  if (recorded !== sha256) {
    throw new Error(
      `${tarballName(version)} is sha256:${sha256}, ${entryDir(version)} records sha256:${recorded}`,
    );
  }
  return `${tarballName(version)} matches ${entryDir(version)} (sha256:${sha256})`;
}

/** CLI entry point; returns the exit code. */
export function main(argv: string[], root = process.cwd(), now = () => new Date()): number {
  const [command, rawVersion, ...rest] = argv;
  try {
    const version = assertVersion(rawVersion);
    if (command === 'set-version') {
      setVersion(root, version);
      console.log(`Set the Headlamp plugin version to ${version}`);
    } else if (command === 'write') {
      const at = rest.indexOf('--created-at');
      const createdAt = at === -1 ? rfc3339(now()) : (rest[at + 1] ?? '');
      const wrote = writeEntry(root, version, createdAt);
      console.log(
        wrote ? `Wrote ${entryDir(version)}` : `${entryDir(version)} is already up to date`,
      );
    } else if (command === 'verify') {
      console.log(verifyEntry(root, version, rest.includes('--required')));
    } else {
      throw new Error(`unknown command ${JSON.stringify(command)}`);
    }
    return 0;
  } catch (error) {
    console.error(`::error::${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
