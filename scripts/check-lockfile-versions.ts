#!/usr/bin/env bun
/**
 * Checks that bun.lock records every workspace package at the name and version
 * in its package.json (#260).
 *
 * `bun install --frozen-lockfile` does not catch this: after a version bump it
 * still passes with the old workspace versions in bun.lock, and the next plain
 * `bun install` rewrites the lockfile. Auto Tag runs this after it regenerates
 * bun.lock for a release PR, and tests/lockfile.test.ts runs it on every PR.
 *
 * Usage: bun scripts/check-lockfile-versions.ts [dir]   (default: current directory)
 * Exits 1 and lists each mismatch when bun.lock is stale.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Manifest {
  name?: string;
  version?: string;
  workspaces?: unknown;
}

interface Lockfile {
  workspaces?: Record<string, { name?: string; version?: string }>;
}

/** Workspace directories (relative, `/`-separated) matched by the root `workspaces` patterns. */
export function workspaceDirectories(dir: string, patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return [];
  const directories: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2);
      if (!existsSync(join(dir, parent))) continue;
      for (const entry of readdirSync(join(dir, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(`${parent}/${entry.name}`);
      }
    } else {
      directories.push(pattern);
    }
  }
  return directories.filter((d) => existsSync(join(dir, d, 'package.json'))).sort();
}

/** Every disagreement between the workspace manifests and bun.lock in `dir`. */
export function lockfileVersionMismatches(dir: string): string[] {
  const root = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  const lock = Bun.JSONC.parse(readFileSync(join(dir, 'bun.lock'), 'utf8')) as Lockfile;
  const locked = lock.workspaces ?? {};
  const problems: string[] = [];

  for (const directory of workspaceDirectories(dir, root.workspaces)) {
    const pkg = JSON.parse(readFileSync(join(dir, directory, 'package.json'), 'utf8')) as Manifest;
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

if (import.meta.main) {
  const problems = lockfileVersionMismatches(process.argv[2] ?? process.cwd());
  if (problems.length > 0) {
    console.error('bun.lock disagrees with the workspace package.json files:');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('Run `bun install --lockfile-only` and commit bun.lock.');
    process.exit(1);
  }
  console.log('bun.lock matches every workspace package name and version');
}
