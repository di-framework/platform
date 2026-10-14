/**
 * bun.lock must record every workspace package at its package.json version (#260),
 * and Auto Tag's release PR must regenerate it after the version bump.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  lockfileVersionMismatches,
  workspaceDirectories,
} from '../scripts/check-lockfile-versions';
import { spawnEnv } from './helpers/spawn-env';

const repo = resolve(import.meta.dir, '..');

function run(cwd: string, cmd: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: { ...spawnEnv, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    out: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A two-package workspace with no external dependencies, locked at 1.0.0. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-'));
  writeJson(join(dir, 'package.json'), {
    name: 'fixture-root',
    version: '1.0.0',
    private: true,
    workspaces: ['packages/*', 'tools/cli'],
  });
  for (const [path, name] of [
    ['packages/a', '@fixture/a'],
    ['packages/b', '@fixture/b'],
    ['tools/cli', '@fixture/cli'],
  ] as const) {
    mkdirSync(join(dir, path), { recursive: true });
    writeJson(join(dir, path, 'package.json'), { name, version: '1.0.0' });
  }
  // A directory without a manifest is not a workspace.
  mkdirSync(join(dir, 'packages/empty'));
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(repo, 'scripts/sync-workspace-versions.mjs'), join(dir, 'scripts/sync.mjs'));
  const install = run(dir, ['bun', 'install', '--lockfile-only', '--ignore-scripts']);
  expect(install.exitCode).toBe(0);
  return dir;
}

test("the repository's bun.lock matches every workspace package.json", () => {
  expect(lockfileVersionMismatches(repo)).toEqual([]);
});

describe('scripts/check-lockfile-versions.ts', () => {
  test('finds the workspaces the root patterns match, skipping dirs without a manifest', () => {
    const dir = fixture();
    expect(workspaceDirectories(dir, ['packages/*', 'tools/cli', 'missing/*', 3])).toEqual([
      'packages/a',
      'packages/b',
      'tools/cli',
    ]);
    expect(workspaceDirectories(dir, undefined)).toEqual([]);
  });

  test('reports version, name and missing-entry drift', () => {
    const dir = fixture();
    expect(lockfileVersionMismatches(dir)).toEqual([]);

    writeJson(join(dir, 'packages/a/package.json'), { name: '@fixture/a', version: '1.0.1' });
    writeJson(join(dir, 'packages/b/package.json'), { name: '@fixture/renamed', version: '1.0.0' });
    mkdirSync(join(dir, 'packages/c'));
    writeJson(join(dir, 'packages/c/package.json'), { name: '@fixture/c', version: '1.0.0' });

    expect(lockfileVersionMismatches(dir)).toEqual([
      'packages/a: bun.lock version 1.0.0 != package.json version 1.0.1',
      'packages/b: bun.lock name @fixture/b != package.json name @fixture/renamed',
      'packages/c: missing from bun.lock workspaces',
    ]);

    const cli = run(dir, ['bun', join(repo, 'scripts/check-lockfile-versions.ts'), dir]);
    expect(cli.exitCode).toBe(1);
    expect(cli.out).toContain('packages/a: bun.lock version 1.0.0 != package.json version 1.0.1');
  });

  test("Auto Tag's bump leaves bun.lock stale, frozen install misses it, --lockfile-only fixes it", () => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'bun.lock'), 'utf8');

    // The release PR's bump: `npm version` on the root, then the sync script.
    const root = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    writeJson(join(dir, 'package.json'), { ...root, version: '1.0.1' });
    expect(run(dir, ['node', 'scripts/sync.mjs'], { NEXT: '1.0.1' }).exitCode).toBe(0);

    expect(lockfileVersionMismatches(dir)).toHaveLength(3);
    // This is why CI's `bun install --frozen-lockfile` never caught it.
    expect(run(dir, ['bun', 'install', '--frozen-lockfile', '--ignore-scripts']).exitCode).toBe(0);
    expect(readFileSync(join(dir, 'bun.lock'), 'utf8')).toBe(before);

    // What Auto Tag now runs before committing.
    expect(run(dir, ['bun', 'install', '--lockfile-only', '--ignore-scripts']).exitCode).toBe(0);
    expect(lockfileVersionMismatches(dir)).toEqual([]);
    const cli = run(dir, ['bun', join(repo, 'scripts/check-lockfile-versions.ts'), dir]);
    expect(cli.exitCode).toBe(0);
    expect(run(dir, ['bun', 'install', '--frozen-lockfile', '--ignore-scripts']).exitCode).toBe(0);
  });
});

describe('Auto Tag regenerates bun.lock in the release PR', () => {
  type Step = { uses?: string; with?: Record<string, string>; run?: string };
  type Workflow = { jobs: Record<string, { steps: Step[] }> };
  const parse = (file: string) =>
    Bun.YAML.parse(readFileSync(join(repo, '.github/workflows', file), 'utf8')) as Workflow;
  const steps = parse('auto-tag.yml').jobs.tag?.steps ?? [];
  const ciSteps = Object.values(parse('ci.yml').jobs).flatMap((job) => job.steps);

  test('sets up the same Bun as the Test workflow', () => {
    const setup = (list: typeof steps) =>
      list.find((s) => s.uses?.startsWith('oven-sh/setup-bun@'));
    expect(setup(steps)?.uses).toBe(setup(ciSteps)?.uses);
    expect(setup(steps)?.with?.['bun-version']).toBe(setup(ciSteps)?.with?.['bun-version']);
    const setupIndex = steps.findIndex((s) => s.uses?.startsWith('oven-sh/setup-bun@'));
    const prIndex = steps.findIndex((s) => (s.run ?? '').includes('git commit'));
    expect(setupIndex).toBeGreaterThan(-1);
    expect(prIndex).toBeGreaterThan(setupIndex);
  });

  test('regenerates and checks bun.lock after the bump, and commits it', () => {
    const script = steps.map((s) => s.run ?? '').find((r) => r.includes('git commit')) ?? '';
    const sync = script.indexOf('node scripts/sync-workspace-versions.mjs');
    const lock = script.indexOf('bun install --lockfile-only');
    const check = script.indexOf('bun scripts/check-lockfile-versions.ts');
    const add = script.indexOf('git add package.json bun.lock');
    const commit = script.indexOf('git commit');
    expect(sync).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(sync);
    expect(check).toBeGreaterThan(lock);
    expect(add).toBeGreaterThan(check);
    expect(commit).toBeGreaterThan(add);
  });

  test('the Test workflow checks bun.lock on every PR, release/v* included', () => {
    const runs = ciSteps.map((s) => s.run ?? '');
    const install = runs.indexOf('bun install --frozen-lockfile');
    const check = runs.indexOf('bun scripts/check-lockfile-versions.ts');
    expect(install).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(install);
  });
});
