import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  combineDigests,
  type Digests,
  differingEntries,
  digestTree,
  parseReproArgs,
} from './check-reproducible.ts';
import { UsageError } from './lib/cli.ts';

describe('parseReproArgs', () => {
  test('defaults', () => {
    expect(parseReproArgs([])).toEqual({
      help: false,
      workDir: undefined,
      sdkCache: undefined,
      keep: false,
    });
  });

  test('flags', () => {
    expect(parseReproArgs(['--work-dir', 'w', '--sdk-cache', 'c', '--keep'])).toEqual({
      help: false,
      workDir: 'w',
      sdkCache: 'c',
      keep: true,
    });
    expect(parseReproArgs(['-h'])).toEqual({ help: true });
  });

  test('rejects unknown flags', () => {
    expect(() => parseReproArgs(['--nope'])).toThrow(UsageError);
  });
});

describe('digests', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'df-pglite-repro-test.'));
    await mkdir(join(root, 'share', 'postgresql'), { recursive: true });
    await Bun.write(join(root, 'share', 'postgresql', 'postgres.bki'), 'bki');
    await Bun.write(join(root, 'COPYRIGHT'), 'copyright');
    await symlink('COPYRIGHT', join(root, 'LICENSE'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('digestTree hashes files and records symlink targets', async () => {
    const digests = await digestTree(root);
    expect([...digests.keys()]).toEqual(['COPYRIGHT', 'LICENSE', 'share/postgresql/postgres.bki']);
    expect(digests.get('LICENSE')).toBe('-> COPYRIGHT');
    expect(digests.get('COPYRIGHT')).toBe(
      new Bun.CryptoHasher('sha256').update('copyright').digest('hex'),
    );
  });

  test('combineDigests ignores insertion order', () => {
    const a: Digests = new Map([
      ['x', '1'],
      ['y', '2'],
    ]);
    const b: Digests = new Map([
      ['y', '2'],
      ['x', '1'],
    ]);
    expect(combineDigests(a)).toBe(combineDigests(b));
    expect(combineDigests(a)).not.toBe(combineDigests(new Map([['x', '1']])));
  });

  test('differingEntries reports changed and one-sided names', () => {
    const a: Digests = new Map([
      ['same', '1'],
      ['changed', '2'],
      ['only-a', '3'],
    ]);
    const b: Digests = new Map([
      ['same', '1'],
      ['changed', '4'],
      ['only-b', '5'],
    ]);
    expect(differingEntries(a, b)).toEqual(['changed', 'only-a', 'only-b']);
    expect(differingEntries(a, a)).toEqual([]);
  });
});
