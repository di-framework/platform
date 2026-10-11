import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  classifyFetch,
  filterTree,
  matchesPathFilter,
  parseArgs,
  pushPaths,
  sourceHash,
} from '../scripts/source-check';

const repo = resolve(import.meta.dir, '..');

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
    expect(classifyFetch(1, 'Error response from registry: denied: requested access')).toBe(
      'absent',
    );
  });

  test('any other registry failure is an error, not a silent republish', () => {
    expect(() => classifyFetch(1, 'dial tcp: i/o timeout')).toThrow('registry lookup failed');
    expect(() => classifyFetch(127, 'oras: command not found')).toThrow('registry lookup failed');
  });
});

describe('parseArgs', () => {
  test('reads the flags', () => {
    expect(parseArgs(['--workflow', 'w.yml', '--image', 'ghcr.io/x/y'])).toEqual({
      workflow: 'w.yml',
      image: 'ghcr.io/x/y',
      salt: '',
      force: false,
    });
    expect(
      parseArgs(['--force', '--workflow', 'w.yml', '--image', 'i', '--salt', 'wasi-tls']),
    ).toEqual({ workflow: 'w.yml', image: 'i', salt: 'wasi-tls', force: true });
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
      { cwd: repo, stdout: 'pipe', stderr: 'pipe' },
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
