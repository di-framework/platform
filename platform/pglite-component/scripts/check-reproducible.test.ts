import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  byCodeUnit,
  combineDigests,
  createWorkDir,
  type Digests,
  differingEntries,
  digestTree,
  isInside,
  parseReproArgs,
  WORK_DIR_PREFIX,
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

describe('byCodeUnit', () => {
  test('orders by UTF-16 code unit, not locale', () => {
    expect(['b', 'B', 'a', 'A', '_', 'é'].sort(byCodeUnit)).toEqual(['A', 'B', '_', 'a', 'b', 'é']);
    expect(byCodeUnit('x', 'x')).toBe(0);
  });
});

describe('isInside', () => {
  test('matches the root and paths below it only', () => {
    expect(isInside('/repo', '/repo')).toBe(true);
    expect(isInside('/repo/a/b', '/repo')).toBe(true);
    expect(isInside('/repo-other', '/repo')).toBe(false);
    expect(isInside('/', '/repo')).toBe(false);
    expect(isInside('/tmp/x', '/repo')).toBe(false);
  });
});

describe('createWorkDir', () => {
  let parent: string;
  let repo: string;

  beforeAll(async () => {
    parent = await realpath(await mkdtemp(join(tmpdir(), 'df-pglite-repro-parent.')));
    repo = await realpath(await mkdtemp(join(tmpdir(), 'df-pglite-repro-repo.')));
    await Bun.write(join(parent, 'keep.txt'), 'user data');
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  test('creates a new empty directory under the given parent', async () => {
    const dir = await createWorkDir(parent, repo);
    expect(dirname(dir)).toBe(parent);
    expect(basename(dir).startsWith(WORK_DIR_PREFIX)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
    expect(await Bun.file(join(parent, 'keep.txt')).text()).toBe('user data');
    expect(await createWorkDir(parent, repo)).not.toBe(dir);
  });

  test('defaults to the system temp dir', async () => {
    const dir = await createWorkDir(undefined, repo);
    try {
      expect(dirname(dir)).toBe(await realpath(tmpdir()));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses the repository checkout and anything inside it', async () => {
    await expect(createWorkDir(repo, repo)).rejects.toThrow('inside the repository checkout');
    await mkdir(join(repo, 'platform', 'x'), { recursive: true });
    await expect(createWorkDir(join(repo, 'platform', 'x'), repo)).rejects.toThrow(
      'inside the repository checkout',
    );
  });

  test('refuses a parent that does not exist instead of creating it', async () => {
    const missing = join(parent, 'missing');
    await expect(createWorkDir(missing, repo)).rejects.toThrow('must be an existing directory');
    expect(await readdir(parent)).not.toContain('missing');
  });
});
