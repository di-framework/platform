import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  classifyFetch,
  filterTree,
  matchesPathFilter,
  parseArgs,
  pushPaths,
  sourceHash,
  staleNotice,
} from '../scripts/source-check';

const repo = resolve(import.meta.dir, '..');
// Git hooks (pre-push runs this suite) export GIT_DIR and friends; they would point every git
// command these tests spawn at the hook's repository instead of the one in `cwd`.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

const TREE = [
  '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tplatform/tenant-host/Dockerfile',
  '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tplatform/tenant-host/README.md',
  '100644 blob cccccccccccccccccccccccccccccccccccccccc\tplatform/tenant-hostile/x',
  '100644 blob dddddddddddddddddddddddddddddddddddddddd\tCargo.toml',
  '',
].join('\n');

describe('pushPaths', () => {
  test('reads on.push.paths', () => {
    const yaml =
      "on:\n  push:\n    branches: [main]\n    paths:\n      - 'a/**'\n      - '!**/*.md'\n";
    expect(pushPaths(yaml)).toEqual(['a/**', '!**/*.md']);
  });

  test('rejects a workflow without a paths filter', () => {
    expect(() => pushPaths('on:\n  workflow_dispatch:\n')).toThrow('no on.push.paths');
    expect(() => pushPaths('on:\n  push:\n    paths: []\n')).toThrow('no on.push.paths');
  });
});

describe('matchesPathFilter', () => {
  test('follows GitHub ordering: the last matching pattern decides', () => {
    const filter = ['platform/tenant-host/**', '!**/*.md'];
    expect(matchesPathFilter(filter, 'platform/tenant-host/Dockerfile')).toBe(true);
    expect(matchesPathFilter(filter, 'platform/tenant-host/README.md')).toBe(false);
    expect(matchesPathFilter(filter, 'platform/tenant-hostile/x')).toBe(false);
    expect(matchesPathFilter(['!**/*.md', '**'], 'README.md')).toBe(true);
  });

  test('a root file pattern does not match nested files', () => {
    expect(matchesPathFilter(['Cargo.toml'], 'Cargo.toml')).toBe(true);
    expect(matchesPathFilter(['Cargo.toml'], 'platform/x/Cargo.toml')).toBe(false);
  });
});

describe('filterTree and sourceHash', () => {
  const filter = ['platform/tenant-host/**', '!**/*.md'];

  test('keeps only the filtered ls-tree lines', () => {
    expect(filterTree(TREE, filter)).toBe(
      '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tplatform/tenant-host/Dockerfile\n',
    );
  });

  test('is deterministic, ignores files outside the filter, and is salted', () => {
    const a = sourceHash(filterTree(TREE, filter));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceHash(filterTree(TREE, filter))).toBe(a);
    const docsOnly = TREE.replace('bbbbbbbb', '99999999');
    expect(sourceHash(filterTree(docsOnly, filter))).toBe(a);
    const changed = TREE.replace('aaaaaaaa', '99999999');
    expect(sourceHash(filterTree(changed, filter))).not.toBe(a);
    expect(sourceHash(filterTree(TREE, filter), 'wasi-tls')).not.toBe(
      sourceHash(filterTree(TREE, filter), 'wasi-tls-exclusive'),
    );
  });

  test('refuses an empty input set', () => {
    expect(() => sourceHash('')).toThrow('no committed files');
  });
});

describe('classifyFetch', () => {
  test('a fetched descriptor is present', () => {
    expect(classifyFetch(0, '')).toBe('present');
  });

  test('a missing tag or a package that was never pushed is absent', () => {
    expect(classifyFetch(1, 'Error: ghcr.io/di-framework/wash:src-x: not found')).toBe('absent');
    expect(
      classifyFetch(1, 'Error response from registry: MANIFEST_UNKNOWN: manifest unknown'),
    ).toBe('absent');
    // Reported separately so the CLI can warn (S3).
    expect(classifyFetch(1, 'Error response from registry: denied: requested access')).toBe(
      'denied',
    );
  });

  test('any other registry failure is an error, not a silent republish', () => {
    expect(() => classifyFetch(1, 'dial tcp: i/o timeout')).toThrow('registry lookup failed');
    expect(() => classifyFetch(127, 'oras: command not found')).toThrow('registry lookup failed');
  });
});

describe('staleNotice', () => {
  const tip = 'a'.repeat(40);
  test('the tip of main is current', () => {
    expect(staleNotice(tip, `${tip}\trefs/heads/main\n`)).toBeUndefined();
  });

  test('an older commit is stale', () => {
    expect(staleNotice('b'.repeat(40), `${tip}\trefs/heads/main\n`)).toContain(
      'no longer the tip of main',
    );
  });

  test('an unreadable remote is an error', () => {
    expect(() => staleNotice(tip, '')).toThrow('cannot read the tip of main');
  });
});

describe('parseArgs', () => {
  test('reads the flags', () => {
    expect(parseArgs(['--workflow', 'w.yml', '--image', 'ghcr.io/x/y'])).toEqual({
      workflow: 'w.yml',
      image: 'ghcr.io/x/y',
      salt: '',
      force: false,
      githubOutput: false,
    });
    expect(
      parseArgs(['--force', '--workflow', 'w.yml', '--image', 'i', '--salt', 'wasi-tls']),
    ).toEqual({
      workflow: 'w.yml',
      image: 'i',
      salt: 'wasi-tls',
      force: true,
      githubOutput: false,
    });
    expect(
      parseArgs([
        '--workflow',
        'w',
        '--image',
        'i',
        '--require-main-tip',
        'abc',
        '--github-output',
      ]),
    ).toMatchObject({ sha: 'abc', githubOutput: true });
  });

  test('rejects missing and unknown arguments', () => {
    expect(() => parseArgs(['--workflow', 'w.yml'])).toThrow('required');
    expect(() => parseArgs(['--workflow'])).toThrow('needs a value');
    expect(() => parseArgs(['--nope', 'x'])).toThrow('unknown argument');
  });
});

test('the CLI hashes the committed inputs of a real workflow; --force never asks the registry', () => {
  const run = (salt: string) =>
    Bun.spawnSync(
      [
        'bun',
        'scripts/source-check.ts',
        '--workflow',
        '.github/workflows/tenant-host-image.yml',
        '--image',
        'ghcr.io/di-framework/wash',
        '--salt',
        salt,
        '--force',
      ],
      { env, cwd: repo, stdout: 'pipe', stderr: 'pipe' },
    );
  const first = run('wasi-tls');
  expect(first.exitCode).toBe(0);
  const out = first.stdout.toString();
  const hash = out.match(/^hash=([0-9a-f]{64})$/m)?.[1];
  expect(hash).toBeDefined();
  expect(out).toContain(`tag=src-${hash}`);
  expect(out).toContain('skip=false');
  expect(run('wasi-tls').stdout.toString()).toBe(out);
  expect(run('wasi-tls-exclusive').stdout.toString()).not.toBe(out);
});

/** A clone whose origin is a local bare repository; main has two commits. */
function cloneWithHistory(): { clone: string; old: string; tip: string } {
  const base = mkdtempSync(join(tmpdir(), 'source-check-'));
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      env,
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const origin = join(base, 'origin.git');
  const work = join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, work);
  writeFileSync(join(work, 'w.yml'), "on:\n  push:\n    paths:\n      - '**'\n");
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'one');
  const old = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'x'), 'x\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'two');
  git(work, 'push', '-q', origin, 'HEAD:main');
  return { clone: work, old, tip: git(work, 'rev-parse', 'HEAD') };
}

test('a re-run of an older push skips without asking the registry; --force still builds (W2)', () => {
  const { clone, old } = cloneWithHistory();
  const cli = (...extra: string[]) =>
    Bun.spawnSync(
      [
        process.execPath,
        join(repo, 'scripts/source-check.ts'),
        '--workflow',
        'w.yml',
        '--image',
        'r/i',
        ...extra,
      ],
      // No oras on PATH: reaching the registry would fail the run.
      {
        cwd: clone,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      },
    );
  const stale = cli('--require-main-tip', old);
  expect(stale.exitCode).toBe(0);
  const out = stale.stdout.toString();
  expect(out).toContain('::notice::');
  expect(out).toContain('no longer the tip of main');
  expect(out).toContain('skip=true');
  const forced = cli('--require-main-tip', old, '--force');
  expect(forced.exitCode).toBe(0);
  expect(forced.stdout.toString()).toContain('skip=false');
});

test('--github-output appends the outputs to $GITHUB_OUTPUT', () => {
  const { clone } = cloneWithHistory();
  const file = join(clone, '..', 'out');
  writeFileSync(file, '');
  const r = Bun.spawnSync(
    [
      process.execPath,
      join(repo, 'scripts/source-check.ts'),
      '--workflow',
      'w.yml',
      '--image',
      'r/i',
      '--force',
      '--github-output',
    ],
    { cwd: clone, stdout: 'pipe', stderr: 'pipe', env: { ...env, GITHUB_OUTPUT: file } },
  );
  expect(r.exitCode).toBe(0);
  expect(readFileSync(file, 'utf8')).toMatch(
    /^hash=[0-9a-f]{64}\ntag=src-[0-9a-f]{64}\nskip=false\n$/,
  );
});
