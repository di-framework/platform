/**
 * The pre-commit check (`.githooks/pre-commit` runs it from the repository root).
 *
 * It checks what the commit records, which is the index, not the working tree:
 *
 * - When the working tree matches the index (no unstaged changes and no untracked, non-ignored
 *   files), it runs `bun typecheck` and `biome check` on the staged files in the repository itself.
 * - Otherwise (`git add -p`, `git commit <path>`, edits left unstaged, untracked scratch files), it
 *   writes the index to a temporary directory with `git checkout-index` and runs the same checks
 *   there. Ignored directories (node_modules, dist) are symlinked into that copy so modules still
 *   resolve, and `*.tsbuildinfo` is copied so the typecheck stays incremental. The repository's
 *   working tree and index are never modified.
 *
 * File lists come from `git ... -z`, so paths with spaces, newlines, or non-ASCII characters are
 * passed to biome unchanged whatever `core.quotePath` is set to.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Biome receives the staged files in batches of this size, to stay under the argument limit. */
export const BIOME_BATCH = 200;

/** Split NUL-terminated `git -z` output into paths. */
export function splitNul(output: string): string[] {
  return output.split('\0').filter((path) => path !== '');
}

/** Split `items` into consecutive batches of at most `size` items. */
export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Ignored entries from `git ls-files --others --ignored --exclude-standard --directory -z`,
 * without the trailing `/` git adds to directories.
 */
export function ignoredEntries(output: string): string[] {
  return splitNul(output).map((path) => (path.endsWith('/') ? path.slice(0, -1) : path));
}

/** Whether `path` is a directory or a symlink to one. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A path argument biome cannot mistake for an option. Every path git prints is relative to the
 * repository root, so `./` keeps it the same file.
 */
export function biomeArg(path: string): string {
  return `./${path}`;
}

type Run = (cmd: string[], cwd: string) => { code: number; stdout: string };

const run: Run = (cmd, cwd) => {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'inherit', stdin: 'ignore' });
  return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
};

/** Run a command with inherited output and return its exit status. */
function check(cmd: string[], cwd: string): number {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' });
  return result.exitCode ?? 1;
}

function git(root: string, ...args: string[]): string {
  const result = run(['git', ...args], root);
  if (result.code !== 0) throw new Error(`[pre-commit] git ${args.join(' ')} failed`);
  return result.stdout;
}

/** Write the index into `dir` and link the repository's ignored directories into it. */
export function snapshotIndex(root: string, dir: string): void {
  git(root, 'checkout-index', '--all', '--force', `--prefix=${dir}/`);
  const ignored = ignoredEntries(
    git(root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'),
  );
  for (const path of ignored) {
    const target = join(dir, path);
    const source = join(root, path);
    if (existsSync(target)) continue;
    if (isDirectory(source)) {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target);
    } else if (path.endsWith('.tsbuildinfo')) {
      // Copied, not linked, so the snapshot's typecheck never writes the repository's build info.
      // tsc compares file hashes, so a stale copy only costs time, never a wrong result.
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
}

/** Run the checks in `cwd` on `files` (paths relative to `cwd`); returns the exit status. */
export function runChecks(cwd: string, files: string[]): number {
  if (check(['bun', 'run', 'typecheck'], cwd) !== 0) {
    console.error('\n[pre-commit] FAILED: typecheck found errors in the staged content.');
    console.error(
      "[pre-commit] Fix them, stage the fix ('git add'), and commit again. Unstaged changes are not checked.",
    );
    return 1;
  }

  // Only regular files: a staged symlink or submodule is not something biome formats.
  const regular = files.filter((path) => {
    try {
      return lstatSync(join(cwd, path)).isFile();
    } catch {
      return false;
    }
  });
  // No --write: writing here would change the working tree but not the index, so the commit
  // would record the unformatted content.
  for (const batch of batches(regular, BIOME_BATCH)) {
    const cmd = [
      'bun',
      'x',
      'biome',
      'check',
      '--files-ignore-unknown=true',
      '--no-errors-on-unmatched',
      ...batch.map(biomeArg),
    ];
    if (check(cmd, cwd) !== 0) {
      console.error('\n[pre-commit] FAILED: biome found lint or format errors in staged files.');
      console.error(
        "[pre-commit] Run 'bun run lint:fix', review the changes, stage them, and commit again.",
      );
      return 1;
    }
  }
  return 0;
}

/**
 * Whether the working tree holds anything the index (the commit) does not: an unstaged change to
 * a tracked file, or an untracked, non-ignored file that the in-repo typecheck would pick up.
 *
 * Git exports GIT_INDEX_FILE to the hook, and every git command here inherits it. For
 * `git commit <path>` (and `-a`) that is the temporary index the commit records, so files staged
 * in the real index but not part of this commit count as untracked here.
 */
export function workingTreeDiffers(root: string): boolean {
  if (run(['git', 'diff', '--quiet', '--no-ext-diff'], root).code !== 0) return true;
  const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '--directory', '-z');
  return untracked !== '';
}

export function main(): number {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  // T: a path that changed type (symlink -> file) is a file to check; runChecks skips
  // non-regular files. D is left out: a deleted file has nothing to check.
  const staged = splitNul(
    git(root, 'diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--diff-filter=ACMRT'),
  );
  if (!workingTreeDiffers(root)) return runChecks(root, staged);

  console.error(
    '[pre-commit] The working tree has unstaged changes or untracked files; checking the staged content.',
  );
  const dir = mkdtempSync(join(tmpdir(), 'di-framework-pre-commit-'));
  try {
    snapshotIndex(root, dir);
    return runChecks(dir, staged);
  } finally {
    // rmSync removes the symlinks themselves; it does not follow them into the repository.
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main());
