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
  // The setup commit runs the hook too.
  const first = commit(work, 'setup');
  if (first.code !== 0) throw new Error(`fixture setup commit failed:\n${first.output}`);
  return work;
}

function commit(work: string, message: string): { code: number; output: string } {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message],
    { cwd: work, env: { ...spawnEnv, TMPDIR: tmp }, stdout: 'pipe', stderr: 'pipe' },
  );
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

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'pre-commit-test-'));
  tmp = join(base, 'tmp');
  mkdirSync(tmp);
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
      expect(commit(work, 'ok').code).toBe(0);

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
      const work = fixture();
      writeFileSync(join(work, 'src/long.ts'), longModule(GOOD, 'export const z = 0;\n'));
      git(work, 'add', 'src/long.ts');
      expect(commit(work, 'long').code).toBe(0);

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
    },
    TIMEOUT,
  );

  test(
    'git add -p of a separate hunk commits even though the other hunk is broken',
    () => {
      const work = fixture();
      writeFileSync(join(work, 'src/long.ts'), longModule(GOOD, 'export const z = 0;\n'));
      git(work, 'add', 'src/long.ts');
      expect(commit(work, 'long').code).toBe(0);

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
