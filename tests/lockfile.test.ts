/**
 * bun.lock must record every workspace package at its package.json version (#260),
 * and Auto Tag's release PR must update it after the version bump.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  lockfileVersionMismatches,
  setWorkspaceVersion,
  workspaceDirectories,
} from '../scripts/check-lockfile-versions';
import { spawnEnv } from './helpers/spawn-env';

const repo = resolve(import.meta.dir, '..');
const script = join(repo, 'scripts/check-lockfile-versions.ts');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-'));
  temps.push(dir);
  return dir;
}

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

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The release PR's bump: `npm version` on the root, then the real sync script. */
function bump(dir: string, version: string) {
  writeJson(join(dir, 'package.json'), { ...readJson(join(dir, 'package.json')), version });
  const sync = run(dir, ['node', join(repo, 'scripts/sync-workspace-versions.mjs')], {
    NEXT: version,
  });
  expect(sync.exitCode).toBe(0);
}

/** Lines that differ between two texts with the same line count. */
function changedLines(before: string, after: string): [string, string][] {
  const a = before.split('\n');
  const b = after.split('\n');
  expect(b).toHaveLength(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i] ?? '']]));
}

/** A two-package workspace with no external dependencies, locked at 1.0.0 by Bun. */
function fixture(): string {
  const dir = tempDir();
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
  expect(run(dir, ['bun', 'install', '--lockfile-only', '--ignore-scripts']).exitCode).toBe(0);
  return dir;
}

/** A copy of this repository's root manifest, bun.lock and workspace manifests. */
function repoCopy(): string {
  const dir = tempDir();
  for (const file of ['package.json', 'bun.lock']) cpSync(join(repo, file), join(dir, file));
  const patterns = readJson(join(repo, 'package.json')).workspaces;
  for (const d of workspaceDirectories(repo, patterns)) {
    mkdirSync(join(dir, d), { recursive: true });
    cpSync(join(repo, d, 'package.json'), join(dir, d, 'package.json'));
  }
  return dir;
}

test("the repository's bun.lock matches every workspace package.json", () => {
  expect(lockfileVersionMismatches(repo)).toEqual([]);
});

describe('scripts/check-lockfile-versions.ts', () => {
  test('finds the workspaces the root patterns match, skipping dirs without a manifest', () => {
    const dir = fixture();
    expect(workspaceDirectories(dir, ['tools/cli', 'packages/*', 'missing/*', 3])).toEqual([
      'packages/a',
      'packages/b',
      'tools/cli',
    ]);
    expect(workspaceDirectories(dir, undefined)).toEqual([]);
  });

  test('reports version, name and missing-entry drift, and exits 1', () => {
    const dir = fixture();
    expect(lockfileVersionMismatches(dir)).toEqual([]);
    expect(run(dir, ['bun', script]).exitCode).toBe(0);

    writeJson(join(dir, 'packages/a/package.json'), { name: '@fixture/a', version: '1.0.1' });
    writeJson(join(dir, 'packages/b/package.json'), { name: '@fixture/renamed', version: '1.0.0' });
    mkdirSync(join(dir, 'packages/c'));
    writeJson(join(dir, 'packages/c/package.json'), { name: '@fixture/c', version: '1.0.0' });

    expect(lockfileVersionMismatches(dir)).toEqual([
      'packages/a: bun.lock version 1.0.0 != package.json version 1.0.1',
      'packages/b: bun.lock name @fixture/b != package.json name @fixture/renamed',
      'packages/c: missing from bun.lock workspaces',
    ]);

    const cli = run(dir, ['bun', script]);
    expect(cli.exitCode).toBe(1);
    expect(cli.out).toContain('packages/a: bun.lock version 1.0.0 != package.json version 1.0.1');
  });

  test('--write does not fix names or missing entries, so the check still fails', () => {
    const dir = fixture();
    writeJson(join(dir, 'packages/b/package.json'), { name: '@fixture/renamed', version: '1.0.0' });
    const cli = run(dir, ['bun', script, '--write']);
    expect(cli.exitCode).toBe(1);
    expect(cli.out).toContain('bun.lock name @fixture/b != package.json name @fixture/renamed');
  });
});

describe('setWorkspaceVersion', () => {
  const lock = [
    '{',
    '  "lockfileVersion": 1,',
    '  "workspaces": {',
    '    "": {',
    '      "name": "root",',
    '    },',
    '    "packages/a": {',
    '      "name": "@x/a",',
    '      "version": "1.0.0",',
    '      "dependencies": {',
    '        "version": "1.0.0",',
    '      },',
    '    },',
    '    "packages/ab": {',
    '      "name": "@x/ab",',
    '      "version": "1.0.0",',
    '    },',
    '    "packages/c": {',
    '      "name": "@x/c",',
    '    },',
    '  },',
    '  "packages": {',
    '    "packages/a": ["@x/a@workspace:packages/a"],',
    '  }',
    '}',
    '',
  ].join('\n');

  test('replaces only the entry’s own version line', () => {
    const next = setWorkspaceVersion(lock, 'packages/a', '2.0.0');
    expect(changedLines(lock, next)).toEqual([
      ['      "version": "1.0.0",', '      "version": "2.0.0",'],
    ]);
    expect(next.indexOf('"version": "2.0.0"')).toBe(lock.indexOf('"version": "1.0.0"'));
    expect(setWorkspaceVersion(lock, 'packages/ab', '1.0.0')).toBe(lock);
  });

  test('adds a version after the name, or removes it, keeping the format', () => {
    const added = setWorkspaceVersion(lock, 'packages/c', '1.2.3');
    expect(added).toContain(
      '    "packages/c": {\n      "name": "@x/c",\n      "version": "1.2.3",\n    },',
    );
    expect(Bun.JSONC.parse(added)).toMatchObject({
      workspaces: { 'packages/c': { name: '@x/c', version: '1.2.3' } },
    });
    const removed = setWorkspaceVersion(lock, 'packages/ab', undefined);
    expect(removed).toContain('    "packages/ab": {\n      "name": "@x/ab",\n    },');
    expect(setWorkspaceVersion(lock, 'packages/c', undefined)).toBe(lock);
  });

  test('leaves the text alone when the entry or the workspaces section is missing', () => {
    expect(setWorkspaceVersion(lock, 'packages/missing', '9.9.9')).toBe(lock);
    expect(setWorkspaceVersion('{\n  "packages": {},\n}\n', 'packages/a', '9.9.9')).toBe(
      '{\n  "packages": {},\n}\n',
    );
  });
});

describe('--write after the release bump', () => {
  test("on this repository's bun.lock it changes only the workspace version lines", () => {
    const dir = repoCopy();
    const before = readFileSync(join(dir, 'bun.lock'), 'utf8');
    const workspaces = workspaceDirectories(dir, readJson(join(dir, 'package.json')).workspaces);
    const current = readJson(join(dir, 'package.json')).version;
    bump(dir, '999.0.0');
    expect(lockfileVersionMismatches(dir)).toHaveLength(workspaces.length);

    const cli = run(dir, ['bun', script, '--write']);
    expect(cli.exitCode).toBe(0);
    expect(cli.out).toContain(`Set the bun.lock version of ${workspaces.length} workspace(s)`);

    const after = readFileSync(join(dir, 'bun.lock'), 'utf8');
    const changed = changedLines(before, after);
    expect(changed).toHaveLength(workspaces.length);
    for (const [old, line] of changed) {
      expect(old).toBe(`      "version": "${current}",`);
      expect(line).toBe('      "version": "999.0.0",');
    }
    expect(lockfileVersionMismatches(dir)).toEqual([]);
    // A second run is a no-op.
    expect(run(dir, ['bun', script, '--write']).out).toContain('version of 0 workspace(s)');
    expect(readFileSync(join(dir, 'bun.lock'), 'utf8')).toBe(after);
  });

  test('Bun accepts the result: frozen install passes and a plain install keeps it', () => {
    const dir = fixture();
    const before = readFileSync(join(dir, 'bun.lock'), 'utf8');
    bump(dir, '1.0.1');
    expect(lockfileVersionMismatches(dir)).toHaveLength(3);

    expect(run(dir, ['bun', script, '--write']).exitCode).toBe(0);
    const written = readFileSync(join(dir, 'bun.lock'), 'utf8');
    expect(changedLines(before, written)).toHaveLength(3);

    expect(run(dir, ['bun', 'install', '--frozen-lockfile', '--ignore-scripts']).exitCode).toBe(0);
    expect(run(dir, ['bun', 'install', '--ignore-scripts']).exitCode).toBe(0);
    expect(readFileSync(join(dir, 'bun.lock'), 'utf8')).toBe(written);
    expect(run(dir, ['bun', script]).exitCode).toBe(0);
  });
});

describe('the workflows keep bun.lock in step with the release bump', () => {
  type Step = { uses?: string; with?: Record<string, string>; run?: string };
  type Workflow = { jobs: Record<string, { steps: Step[] }> };
  const parse = (file: string) =>
    Bun.YAML.parse(readFileSync(join(repo, '.github/workflows', file), 'utf8')) as Workflow;
  const steps = parse('auto-tag.yml').jobs['release-pr']?.steps ?? [];
  const ciSteps = Object.values(parse('ci.yml').jobs).flatMap((job) => job.steps);
  const isSetupBun = (s: Step) => s.uses?.startsWith('oven-sh/setup-bun@') ?? false;

  test('Auto Tag sets up the same Bun as the Test workflow', () => {
    const setup = steps.find(isSetupBun);
    expect(setup?.uses).toBe(ciSteps.find(isSetupBun)?.uses);
    expect(setup?.with?.['bun-version']).toBe(ciSteps.find(isSetupBun)?.with?.['bun-version']);
    const setupIndex = steps.findIndex(isSetupBun);
    const prIndex = steps.findIndex((s) => (s.run ?? '').includes('git commit'));
    expect(setupIndex).toBeGreaterThan(-1);
    expect(prIndex).toBeGreaterThan(setupIndex);
  });

  test('Auto Tag writes and checks bun.lock after the bump, commits it, and installs nothing', () => {
    const pr = steps.map((s) => s.run ?? '').find((r) => r.includes('git commit')) ?? '';
    const sync = pr.indexOf('node scripts/sync-workspace-versions.mjs');
    const write = pr.indexOf('bun scripts/check-lockfile-versions.ts --write\n');
    const check = pr.indexOf('bun scripts/check-lockfile-versions.ts\n');
    const add = pr.indexOf('git add package.json bun.lock');
    const commit = pr.indexOf('git commit');
    expect(sync).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(sync);
    expect(check).toBeGreaterThan(write);
    expect(add).toBeGreaterThan(check);
    expect(commit).toBeGreaterThan(add);
    // The root workspace is never installed. The only install is the Headlamp plugin's own frozen
    // lockfile, which the release PR packs for its Artifact Hub entry (#435).
    const plugin =
      'bun install --cwd platform/operator/headlamp-plugin --frozen-lockfile --ignore-scripts\n';
    expect(pr).toContain(plugin);
    expect(
      steps
        .map((s) => s.run ?? '')
        .join('\n')
        .replace(plugin, ''),
    ).not.toMatch(/^\s*bun (install|i|add)\b/m);
  });

  test('Auto Tag moves the Headlamp plugin to the release version and writes its Artifact Hub entry (#435)', () => {
    const pr = steps.map((s) => s.run ?? '').find((r) => r.includes('git commit')) ?? '';
    const order = [
      'bun scripts/check-lockfile-versions.ts\n',
      'bun scripts/artifacthub-plugin.ts set-version "$NEXT"',
      'bun install --cwd platform/operator/headlamp-plugin --frozen-lockfile --ignore-scripts',
      'bun run --cwd platform/operator/headlamp-plugin package',
      'bun scripts/artifacthub-plugin.ts write "$NEXT"',
      'git add platform/operator/chart/values.yaml platform/operator/headlamp-plugin/artifacthub',
      'git commit',
    ].map((s) => pr.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The plugin is built and packed without the token; only the push/PR step holds it.
    const bumpStep = steps.find((s) => (s.run ?? '').includes('git commit')) as Step & {
      env?: Record<string, string>;
    };
    const prStep = steps.find((s) => (s.run ?? '').includes('gh pr create')) as Step & {
      env?: Record<string, string>;
    };
    expect(bumpStep).not.toBe(prStep);
    expect(Object.keys(bumpStep.env ?? {})).not.toContain('GH_TOKEN');
    expect(JSON.stringify(bumpStep)).not.toContain('github.token');
    expect(prStep.env?.GH_TOKEN).toContain('github.token');
    expect(prStep.run).toContain('git push');
    expect(prStep.run).not.toContain('bun ');
    // The plugin's package.json is added by the `*package.json` loop.
    expect(pr).toContain("git ls-files -m -- '*package.json'");
    // Packs with the same pinned Node as the plugin's CI job.
    const node = (s: Step) => s.uses?.startsWith('actions/setup-node@') ?? false;
    const ciNode = parse('ci.yml').jobs['headlamp-plugin']?.steps.find(node);
    expect(steps.find(node)?.uses).toBe(ciNode?.uses);
    expect(steps.find(node)?.with?.['node-version']).toBe(ciNode?.with?.['node-version']);
  });

  test('the Test workflow checks bun.lock on every PR, release/v* included', () => {
    const runs = ciSteps.map((s) => s.run ?? '');
    const install = runs.indexOf('bun install --frozen-lockfile');
    const check = runs.indexOf('bun scripts/check-lockfile-versions.ts');
    expect(install).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(install);
  });
});
