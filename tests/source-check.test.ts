import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  classifyFetch,
  descriptorDigest,
  filterTree,
  matchesPathFilter,
  parseArgs,
  pushPaths,
  sourceHash,
  staleNotice,
  tokenConfig,
} from '../scripts/source-check';
import { git, sandboxClone, spawnEnv } from './helpers/spawn-env';

const repo = resolve(import.meta.dir, '..');
const env = spawnEnv;

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
  const own = 'a'.repeat(64);
  test('the same inputs on main are current, whatever the commit', () => {
    expect(staleNotice(own, own)).toBeUndefined();
  });

  test('different inputs on main are stale', () => {
    expect(staleNotice(own, 'b'.repeat(64))).toContain('the inputs on main have changed');
  });
});

test('descriptorDigest reads the digest of an oras descriptor', () => {
  const digest = `sha256:${'c'.repeat(64)}`;
  expect(descriptorDigest(JSON.stringify({ mediaType: 'x', digest, size: 1 }))).toBe(digest);
  expect(() => descriptorDigest('{}')).toThrow('no sha256 digest');
});

test('tokenConfig authenticates the fetch through GIT_CONFIG_* only when a token is given', () => {
  expect(tokenConfig(undefined)).toEqual({});
  expect(tokenConfig('')).toEqual({});
  const config = tokenConfig('t0k');
  expect(config.GIT_CONFIG_COUNT).toBe('1');
  expect(config.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
  expect(config.GIT_CONFIG_VALUE_0).toBe(
    `AUTHORIZATION: basic ${Buffer.from('x-access-token:t0k').toString('base64')}`,
  );
});

describe('parseArgs', () => {
  test('reads the flags', () => {
    expect(parseArgs(['--workflow', 'w.yml', '--image', 'ghcr.io/x/y'])).toEqual({
      workflow: 'w.yml',
      image: 'ghcr.io/x/y',
      salt: '',
      force: false,
      staleGuard: false,
      registry: true,
      githubOutput: false,
    });
    expect(
      parseArgs([
        '--force',
        '--workflow',
        'w.yml',
        '--image',
        'i',
        '--salt',
        'wasi-tls',
        '--stale-guard',
        '--no-registry',
        '--github-output',
      ]),
    ).toEqual({
      workflow: 'w.yml',
      image: 'i',
      salt: 'wasi-tls',
      force: true,
      staleGuard: true,
      registry: false,
      githubOutput: true,
    });
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

/**
 * A sandbox whose origin's main is `checkout` plus one newer commit. The clone stays at the
 * first commit, as a queued or re-run job for an older push would. `newer` names the file the
 * newer commit changes: inside the filter (`src/`) or outside it.
 */
function behindMain(newer: 'src/a' | 'docs/b') {
  const { base, origin, work } = sandboxClone('source-check-');
  writeFileSync(join(work, 'w.yml'), "on:\n  push:\n    paths:\n      - 'src/**'\n");
  mkdirSync(join(work, 'src'));
  mkdirSync(join(work, 'docs'));
  writeFileSync(join(work, 'src/a'), 'one\n');
  writeFileSync(join(work, 'docs/b'), 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'one');
  const old = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, newer), 'two\n');
  git(work, 'commit', '-q', '-am', 'two');
  git(work, 'push', '-q', origin, 'HEAD:main');
  git(work, 'checkout', '-q', '--detach', old);
  return { base, work };
}

/** A PATH with bun and a stub `oras` whose answer is fixed by `script`. */
function stubOras(base: string, script: string): string {
  const bin = join(base, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'oras'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, 'oras'), 0o755);
  return `${bin}:${process.env.PATH}`;
}

function cli(cwd: string, path: string, ...extra: string[]) {
  return Bun.spawnSync(
    [
      process.execPath,
      join(repo, 'scripts/source-check.ts'),
      '--workflow',
      'w.yml',
      '--image',
      'r/i',
      ...extra,
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...env, PATH: path } },
  );
}

const ABSENT = 'echo "Error: r/i:src-x: not found" >&2; exit 1';
const FAIL = 'echo "registry must not be asked" >&2; exit 99';

describe('--stale-guard compares inputs, not commits (#173 C1)', () => {
  test('an unrelated newer commit on main is not stale: the run still publishes', () => {
    const { base, work } = behindMain('docs/b');
    const result = cli(work, stubOras(base, ABSENT), '--stale-guard');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain('stale=false');
    expect(out).toContain('skip=false');
  });

  test('a newer commit that changes the inputs makes the run stale, without asking the registry', () => {
    const { base, work } = behindMain('src/a');
    const result = cli(work, stubOras(base, FAIL), '--stale-guard');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain('::notice::the inputs on main have changed');
    expect(out).toContain('stale=true');
    expect(out).toContain('skip=true');
  });

  test('--no-registry checks staleness only', () => {
    const fresh = behindMain('docs/b');
    const out = cli(fresh.work, stubOras(fresh.base, FAIL), '--stale-guard', '--no-registry');
    expect(out.exitCode, out.stderr.toString()).toBe(0);
    expect(out.stdout.toString()).toContain('stale=false');
    expect(out.stdout.toString()).toContain('skip=false');
  });

  test('--force (workflow_dispatch) neither checks staleness nor asks the registry', () => {
    const { base, work } = behindMain('src/a');
    const result = cli(work, stubOras(base, FAIL), '--stale-guard', '--force');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain('stale=false');
    expect(result.stdout.toString()).toContain('skip=false');
  });
});

describe('registry lookup', () => {
  test('a published source is skipped and reports its digest', () => {
    const { base, work } = behindMain('docs/b');
    const digest = `sha256:${'d'.repeat(64)}`;
    const result = cli(work, stubOras(base, `echo '{"digest":"${digest}"}'`));
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain('skip=true');
    expect(result.stdout.toString()).toContain(`digest=${digest}`);
  });

  test('"denied" is treated as unpublished, with a warning (S3)', () => {
    const { base, work } = behindMain('docs/b');
    const result = cli(work, stubOras(base, 'echo "denied: requested access" >&2; exit 1'));
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain('::warning::');
    expect(result.stdout.toString()).toContain('skip=false');
  });

  test('an unknown registry failure fails the run', () => {
    const { base, work } = behindMain('docs/b');
    expect(cli(work, stubOras(base, FAIL)).exitCode).not.toBe(0);
  });
});

test('--github-output appends the outputs to $GITHUB_OUTPUT', () => {
  const { base, work } = behindMain('docs/b');
  const file = join(base, 'out');
  writeFileSync(file, '');
  const result = Bun.spawnSync(
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
    { cwd: work, stdout: 'pipe', stderr: 'pipe', env: { ...env, GITHUB_OUTPUT: file } },
  );
  expect(result.exitCode).toBe(0);
  expect(readFileSync(file, 'utf8')).toMatch(
    /^hash=[0-9a-f]{64}\ntag=src-[0-9a-f]{64}\nstale=false\nskip=false\ndigest=\n$/,
  );
});
