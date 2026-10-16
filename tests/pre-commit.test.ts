import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { batches, biomeArg, ignoredEntries, splitNul } from '../scripts/pre-commit';
import { git, spawnEnv } from './helpers/spawn-env';

const repo = resolve(import.meta.dir, '..');
// Each commit runs the hook (tsc and biome), so allow for slow machines.
const TIMEOUT = 60_000;

describe('pre-commit helpers', () => {
  test('splitNul keeps spaces, newlines and non-ASCII characters', () => {
    expect(splitNul('a b.ts\0naïve ü.ts\0line\nbreak.ts\0')).toEqual([
      'a b.ts',
      'naïve ü.ts',
      'line\nbreak.ts',
    ]);
    expect(splitNul('')).toEqual([]);
  });

  test('batches splits into consecutive groups', () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 2)).toEqual([]);
  });

  test('ignoredEntries drops the trailing slash of directories', () => {
    expect(ignoredEntries('node_modules/\0a/dist/\0tsconfig.tsbuildinfo\0')).toEqual([
      'node_modules',
      'a/dist',
      'tsconfig.tsbuildinfo',
    ]);
  });

  test('biomeArg cannot be read as an option', () => {
    expect(biomeArg('--write.ts')).toBe('./--write.ts');
  });
});

const GOOD = 'export const a: number = 1;\n';
const TYPE_ERROR = "export const a: number = 'not a number';\n";
const FORMAT_ERROR = 'export const   a: number = 1\n';

/** A module whose first and last lines are far enough apart to be separate `git add -p` hunks. */
function longModule(first: string, last: string): string {
  const middle = Array.from({ length: 12 }, (_, i) => `export const m${i}: number = ${i};\n`);
  return [first, ...middle, last].join('');
}

let base: string;
let tmp: string;
let noHooks: string;

/** A fresh repository using this repository's hook, scripts, biome config and node_modules. */
function fixture(): string {
  const work = mkdtempSync(join(base, 'repo-'));
  git(work, 'init', '-q', '-b', 'main');
  mkdirSync(join(work, '.githooks'));
  mkdirSync(join(work, 'scripts'));
  copyFileSync(join(repo, '.githooks/pre-commit'), join(work, '.githooks/pre-commit'));
  copyFileSync(join(repo, 'scripts/pre-commit.ts'), join(work, 'scripts/pre-commit.ts'));
  copyFileSync(join(repo, 'biome.json'), join(work, 'biome.json'));
  writeFileSync(
    join(work, 'package.json'),
    [
      '{',
      '  "name": "fixture",',
      '  "private": true,',
      '  "scripts": {',
      '    "typecheck": "bun x tsc --noEmit"',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  // scripts/ is excluded: the copied hook script needs Bun's types, which the fixture skips.
  writeFileSync(
    join(work, 'tsconfig.json'),
    [
      '{',
      '  "compilerOptions": {',
      '    "strict": true,',
      '    "noEmit": true,',
      '    "target": "ESNext",',
      '    "module": "ESNext",',
      '    "moduleResolution": "bundler",',
      '    "types": []',
      '  },',
      '  "include": ["**/*.ts"],',
      '  "exclude": ["node_modules", "scripts"]',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(work, '.gitignore'), 'node_modules\n');
  symlinkSync(join(repo, 'node_modules'), join(work, 'node_modules'));
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'src/base.ts'), GOOD);
  git(work, 'config', 'core.hooksPath', '.githooks');
  git(work, 'add', '-A');
  baseline(work, 'setup');
  return work;
}

/**
 * Commit without running the hook, for setup and baseline commits. The hook is skipped by
 * pointing core.hooksPath at an empty directory for this one command.
 */
function baseline(work: string, message: string): void {
  const result = commit(work, message, { hooks: noHooks });
  if (result.code !== 0) throw new Error(`baseline commit failed:\n${result.output}`);
}

function commit(
  work: string,
  message: string,
  options: { hooks?: string; paths?: string[] } = {},
): { code: number; output: string } {
  const hooks = options.hooks ? ['-c', `core.hooksPath=${options.hooks}`] : [];
  const cmd = ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...hooks, 'commit', '-q'];
  cmd.push('-m', message, ...(options.paths ? ['--', ...options.paths] : []));
  const result = Bun.spawnSync(cmd, {
    cwd: work,
    env: { ...spawnEnv, TMPDIR: tmp },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode ?? 1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

/** Stage `content` for `path` without touching the working tree (what `git add -p` produces). */
function stageContent(work: string, path: string, content: string): void {
  const blob = Bun.spawnSync(['git', 'hash-object', '-w', '--stdin', '--path', path], {
    cwd: work,
    env: spawnEnv,
    stdin: new TextEncoder().encode(content),
    stdout: 'pipe',
  });
  const sha = blob.stdout.toString().trim();
  git(work, 'update-index', '--add', '--cacheinfo', `100644,${sha},${path}`);
}

function committed(work: string, path: string): string {
  return git(work, 'show', `HEAD:${path}`);
}

/** Stage a good hunk, leave a broken one unstaged, and expect the commit to pass. */
function expectPartialStagingPasses(work: string): void {
  writeFileSync(join(work, 'src/long.ts'), longModule(GOOD, 'export const z = 0;\n'));
  git(work, 'add', 'src/long.ts');
  baseline(work, 'long');

  // Staged: a good change to the first line. Unstaged: a type and format error at the end.
  const staged = longModule('export const a: number = 2;\n', 'export const z = 0;\n');
  const working = longModule(
    'export const a: number = 2;\n',
    "export const   z: number = 'broken'\n",
  );
  writeFileSync(join(work, 'src/long.ts'), working);
  stageContent(work, 'src/long.ts', staged);
  expect(git(work, 'diff', '--name-only')).toBe('src/long.ts');

  const result = commit(work, 'partial');
  expect(result.output).toContain('checking the staged content');
  expect(result.code).toBe(0);
  expect(`${committed(work, 'src/long.ts')}\n`).toBe(staged);
  // The hook leaves the working tree, the linked node_modules and the temp dir alone.
  expect(readFileSync(join(work, 'src/long.ts'), 'utf8')).toBe(working);
  expect(existsSync(join(repo, 'node_modules/.bin/biome'))).toBe(true);
  expect(readdirSync(tmp)).toEqual([]);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'pre-commit-test-'));
  tmp = join(base, 'tmp');
  mkdirSync(tmp);
  noHooks = join(base, 'no-hooks');
  mkdirSync(noHooks);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('pre-commit hook', () => {
  test(
    'a normal commit passes when the staged files are clean and fails when they are not',
    () => {
      const work = fixture();
      writeFileSync(join(work, 'src/ok.ts'), GOOD);
      git(work, 'add', 'src/ok.ts');
      const ok = commit(work, 'ok');
      expect(ok.code).toBe(0);
      // Nothing unstaged or untracked: the checks run in the repository itself.
      expect(ok.output).not.toContain('checking the staged content');

      writeFileSync(join(work, 'src/fmt.ts'), FORMAT_ERROR);
      git(work, 'add', 'src/fmt.ts');
      const fmt = commit(work, 'fmt');
      expect(fmt.code).not.toBe(0);
      expect(fmt.output).toContain('biome found lint or format errors');

      git(work, 'rm', '-q', '--cached', 'src/fmt.ts');
      rmSync(join(work, 'src/fmt.ts'));
      writeFileSync(join(work, 'src/types.ts'), TYPE_ERROR);
      git(work, 'add', 'src/types.ts');
      const types = commit(work, 'types');
      expect(types.code).not.toBe(0);
      expect(types.output).toContain('typecheck found errors');
    },
    TIMEOUT,
  );

  test(
    'a partially staged file passes when only the unstaged part is broken',
    () => {
      expectPartialStagingPasses(fixture());
    },
    TIMEOUT,
  );

  test(
    'an untracked file the commit depends on fails the commit',
    () => {
      const work = fixture();
      writeFileSync(join(work, 'src/helper.ts'), 'export const h = 1;\n');
      writeFileSync(
        join(work, 'src/uses-helper.ts'),
        "import { h } from './helper';\n\nexport const v: number = h;\n",
      );
      git(work, 'add', 'src/uses-helper.ts');
      const result = commit(work, 'imports an untracked file');
      expect(result.output).toContain('checking the staged content');
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('typecheck found errors');
    },
    TIMEOUT,
  );

  test(
    'an untracked broken file does not fail a clean commit',
    () => {
      const work = fixture();
      writeFileSync(join(work, 'src/wip.ts'), TYPE_ERROR);
      writeFileSync(join(work, 'src/ok.ts'), GOOD);
      git(work, 'add', 'src/ok.ts');
      const result = commit(work, 'clean');
      expect(result.output).toContain('checking the staged content');
      expect(result.code).toBe(0);
      expect(git(work, 'status', '--porcelain', '--untracked-files=all')).toBe('?? src/wip.ts');
    },
    TIMEOUT,
  );

  test(
    'git commit <path> checks only what that commit records',
    () => {
      const work = fixture();
      // Another file is staged and broken, but it is not part of `git commit src/base.ts`.
      writeFileSync(join(work, 'src/other.ts'), TYPE_ERROR);
      git(work, 'add', 'src/other.ts');
      writeFileSync(join(work, 'src/base.ts'), 'export const a: number = 2;\n');

      const result = commit(work, 'only base', { paths: ['src/base.ts'] });
      expect(result.code).toBe(0);
      expect(committed(work, 'src/base.ts')).toBe('export const a: number = 2;');
      expect(git(work, 'diff', '--cached', '--name-only')).toBe('src/other.ts');

      // Committing the broken file by path still fails.
      const broken = commit(work, 'only other', { paths: ['src/other.ts'] });
      expect(broken.code).not.toBe(0);
      expect(broken.output).toContain('typecheck found errors');
    },
    TIMEOUT,
  );

  test(
    'works in a linked worktree',
    () => {
      const work = fixture();
      const tree = join(base, 'linked-worktree');
      git(work, 'worktree', 'add', '-q', '-b', 'side', tree);
      symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'));
      expectPartialStagingPasses(tree);

      writeFileSync(join(tree, 'src/fixed.ts'), GOOD);
      stageContent(tree, 'src/fixed.ts', TYPE_ERROR);
      const broken = commit(tree, 'staged type error');
      expect(broken.code).not.toBe(0);
      expect(broken.output).toContain('typecheck found errors');
      expect(readdirSync(tmp)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    'git add -p of a separate hunk commits even though the other hunk is broken',
    () => {
      const work = fixture();
      writeFileSync(join(work, 'src/long.ts'), longModule(GOOD, 'export const z = 0;\n'));
      git(work, 'add', 'src/long.ts');
      baseline(work, 'long');

      writeFileSync(
        join(work, 'src/long.ts'),
        longModule('export const a: number = 2;\n', "export const   z: number = 'broken'\n"),
      );
      // Stage the first hunk only: "y" for the first, "n" for the second.
      const add = Bun.spawnSync(['git', 'add', '-p', 'src/long.ts'], {
        cwd: work,
        env: spawnEnv,
        stdin: new TextEncoder().encode('y\nn\n'),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(add.exitCode).toBe(0);
      expect(git(work, 'diff', '--name-only')).toBe('src/long.ts');

      const result = commit(work, 'add -p');
      expect(result.code).toBe(0);
      expect(committed(work, 'src/long.ts')).toContain('export const a: number = 2;');
      expect(committed(work, 'src/long.ts')).not.toContain('broken');
    },
    TIMEOUT,
  );

  test(
    'fails when the staged content is broken even though the working tree is fixed',
    () => {
      const work = fixture();
      writeFileSync(join(work, 'src/fixed.ts'), GOOD);
      stageContent(work, 'src/fixed.ts', TYPE_ERROR);
      const types = commit(work, 'staged type error');
      expect(types.code).not.toBe(0);
      expect(types.output).toContain('typecheck found errors');

      stageContent(work, 'src/fixed.ts', FORMAT_ERROR);
      const fmt = commit(work, 'staged format error');
      expect(fmt.code).not.toBe(0);
      expect(fmt.output).toContain('biome found lint or format errors');
      expect(git(work, 'log', '--format=%s')).toBe('setup');
    },
    TIMEOUT,
  );

  for (const quotePath of ['true', 'false']) {
    test(
      `checks non-ASCII and spaced file names (core.quotePath=${quotePath})`,
      () => {
        const work = fixture();
        git(work, 'config', 'core.quotePath', quotePath);
        const name = 'src/naïve file ü.ts';

        writeFileSync(join(work, name), FORMAT_ERROR);
        git(work, 'add', name);
        const bad = commit(work, 'bad name');
        expect(bad.code).not.toBe(0);
        expect(bad.output).toContain('naïve file ü.ts');

        writeFileSync(join(work, name), GOOD);
        git(work, 'add', name);
        expect(commit(work, 'good name').code).toBe(0);

        // Partially staged: broken staged content, fixed working tree.
        writeFileSync(join(work, name), 'export const a: number = 3;\n');
        stageContent(work, name, FORMAT_ERROR);
        const partial = commit(work, 'partial name');
        expect(partial.code).not.toBe(0);
        expect(partial.output).toContain('naïve file ü.ts');
      },
      TIMEOUT,
    );
  }
});
