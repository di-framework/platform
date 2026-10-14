#!/usr/bin/env bun
/**
 * Keeps the workspace entries in bun.lock at the name and version of each
 * workspace package.json (#260).
 *
 * `bun install --frozen-lockfile` can pass with old workspace versions in
 * bun.lock, and the next plain `bun install` then rewrites the lockfile. The
 * Test workflow (ci.yml) runs this check on every PR. Auto Tag runs `--write`
 * after the release version bump, then the check, and commits bun.lock.
 *
 * Usage (from the repository root):
 *   bun scripts/check-lockfile-versions.ts           exit 1 and list every mismatch
 *   bun scripts/check-lockfile-versions.ts --write   set the workspace "version" lines in
 *                                                    bun.lock, leaving every other byte as is
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Manifest {
  name?: string;
  version?: string;
  workspaces?: unknown;
}

interface Lockfile {
  workspaces?: Record<string, { name?: string; version?: string }>;
}

/** The directories one root `workspaces` pattern names (`dir/*` or a plain path). */
function expandPattern(dir: string, pattern: string): string[] {
  if (!pattern.endsWith('/*')) return [pattern];
  const parent = pattern.slice(0, -2);
  if (!existsSync(join(dir, parent))) return [];
  return readdirSync(join(dir, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

/** Workspace directories (relative, `/`-separated) matched by the root `workspaces` patterns. */
export function workspaceDirectories(dir: string, patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return [];
  return patterns
    .filter((pattern): pattern is string => typeof pattern === 'string')
    .flatMap((pattern) => expandPattern(dir, pattern))
    .filter((d) => existsSync(join(dir, d, 'package.json')))
    .sort((a, b) => a.localeCompare(b));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Each workspace directory with its package.json. */
function workspaces(dir: string): [string, Manifest][] {
  const root = readJson<Manifest>(join(dir, 'package.json'));
  return workspaceDirectories(dir, root.workspaces).map((d) => [
    d,
    readJson<Manifest>(join(dir, d, 'package.json')),
  ]);
}

/** Every disagreement between the workspace manifests and bun.lock in `dir`. */
export function lockfileVersionMismatches(dir: string): string[] {
  const lock = Bun.JSONC.parse(readFileSync(join(dir, 'bun.lock'), 'utf8')) as Lockfile;
  const locked = lock.workspaces ?? {};
  const problems: string[] = [];

  for (const [directory, pkg] of workspaces(dir)) {
    const entry = locked[directory];
    if (!entry) {
      problems.push(`${directory}: missing from bun.lock workspaces`);
      continue;
    }
    if (entry.name !== pkg.name) {
      problems.push(`${directory}: bun.lock name ${entry.name} != package.json name ${pkg.name}`);
    }
    if (entry.version !== pkg.version) {
      problems.push(
        `${directory}: bun.lock version ${entry.version} != package.json version ${pkg.version}`,
      );
    }
  }
  return problems;
}

/** The leading spaces and tabs of a line. */
function indentOf(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/**
 * Sets the `version` line of one workspace entry in bun.lock text. The entry is the
 * `"<directory>": {` object under `"workspaces"`; only its own `"version"` line is
 * replaced (or added after `"name"`, or removed when the package has no version).
 * Every other line is kept byte for byte. Returns the text unchanged when the entry
 * is missing.
 */
export function setWorkspaceVersion(
  lockText: string,
  directory: string,
  version: string | undefined,
): string {
  const lines = lockText.split('\n');
  const section = lines.findIndex((l) => l.trim() === '"workspaces": {');
  const key = `${JSON.stringify(directory)}: {`;
  const open = lines.findIndex((l, i) => i > section && l.trim() === key);
  if (section === -1 || open === -1) return lockText;

  const indent = indentOf(lines[open] ?? '');
  const close = lines.findIndex((l, i) => i > open && (l === `${indent}},` || l === `${indent}}`));
  if (close === -1) return lockText;

  const body = setVersionLine(lines.slice(open + 1, close), `${indent}  `, version);
  return [...lines.slice(0, open + 1), ...body, ...lines.slice(close)].join('\n');
}

/** The entry's lines with its direct `"version"` child set to `version` (removed if undefined). */
function setVersionLine(lines: string[], child: string, version: string | undefined): string[] {
  const line = `${child}"version": ${JSON.stringify(version)},`;
  const existing = lines.findIndex((l) => l.startsWith(`${child}"version": `));
  if (existing !== -1) {
    return version === undefined ? lines.toSpliced(existing, 1) : lines.with(existing, line);
  }
  const name = lines.findIndex((l) => l.startsWith(`${child}"name": `));
  if (version === undefined || name === -1) return lines;
  return lines.toSpliced(name + 1, 0, line);
}

/**
 * Rewrites bun.lock in `dir` so every workspace entry has its package.json version.
 * Returns the workspace directories whose entry changed.
 */
export function writeLockfileVersions(dir: string): string[] {
  const path = join(dir, 'bun.lock');
  let text = readFileSync(path, 'utf8');
  const changed: string[] = [];
  for (const [directory, pkg] of workspaces(dir)) {
    const next = setWorkspaceVersion(text, directory, pkg.version);
    if (next !== text) changed.push(directory);
    text = next;
  }
  if (changed.length > 0) writeFileSync(path, text);
  return changed;
}

if (import.meta.main) {
  const dir = process.cwd();
  if (process.argv.includes('--write')) {
    const changed = writeLockfileVersions(dir);
    console.log(`Set the bun.lock version of ${changed.length} workspace(s)`);
  }
  const problems = lockfileVersionMismatches(dir);
  if (problems.length > 0) {
    console.error('bun.lock disagrees with the workspace package.json files:');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('Run `bun scripts/check-lockfile-versions.ts --write` and commit bun.lock.');
    process.exit(1);
  }
  console.log('bun.lock matches every workspace package name and version');
}
