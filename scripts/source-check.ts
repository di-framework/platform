#!/usr/bin/env bun
/**
 * Skip-if-published check for the GHCR publish workflows (#172).
 *
 * The source hash covers exactly the files the workflow's own `on.push.paths`
 * filter matches (with GitHub's ordering and `!` exclusions), so the files that
 * trigger a publish and the files that decide whether one is needed are the same
 * set. It hashes `git ls-tree -r HEAD` lines (mode, blob id and path of each
 * committed file), not the working tree, so it is deterministic for a commit. An optional salt separates artifacts built from the same inputs
 * (the tenant host variants).
 *
 * Usage:
 *   bun scripts/source-check.ts --workflow <file> --image <ghcr.io/org/name> [--salt <s>] [--force]
 *
 * Prints `hash=`, `tag=` and `skip=` lines for `$GITHUB_OUTPUT`. `skip=true` only when
 * `<image>:src-<hash>` already exists and `--force` (workflow_dispatch) is not set.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The `on.push.paths` filter of a workflow. */
export function pushPaths(workflowYaml: string): string[] {
  const workflow = Bun.YAML.parse(workflowYaml) as { on?: { push?: { paths?: unknown } } };
  const paths = workflow.on?.push?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string')) {
    throw new Error('workflow has no on.push.paths list');
  }
  return paths as string[];
}

/**
 * GitHub's `paths` semantics: patterns apply in order and the last one that matches a file
 * decides; a `!` pattern excludes. A file no pattern matches is not an input.
 */
export function matchesPathFilter(filter: string[], file: string): boolean {
  let matched = false;
  for (const pattern of filter) {
    const negated = pattern.startsWith('!');
    if (new Bun.Glob(negated ? pattern.slice(1) : pattern).match(file)) matched = !negated;
  }
  return matched;
}

/** Keep the `git ls-tree -r` lines (`<mode> <type> <blob>\t<path>`) whose path the filter matches. */
export function filterTree(lsTree: string, filter: string[]): string {
  return lsTree
    .split('\n')
    .filter((line) => {
      const tab = line.indexOf('\t');
      return tab !== -1 && matchesPathFilter(filter, line.slice(tab + 1));
    })
    .map((line) => `${line}\n`)
    .join('');
}

/** sha256 over the salt and the `git ls-tree -r` listing. */
export function sourceHash(lsTree: string, salt = ''): string {
  if (lsTree.trim().length === 0) throw new Error('no committed files match the path filter');
  return createHash('sha256').update(`salt=${salt}\n`).update(lsTree).digest('hex');
}

/**
 * Read `oras manifest fetch --descriptor` results. A missing tag is "not found"; a GHCR
 * package that has never been pushed answers "denied" (#137: pglite has no package yet).
 * Any other failure (network, 5xx, bad credentials on an existing package) is an error, so
 * an outage fails the run instead of silently republishing.
 */
export function classifyFetch(exitCode: number, stderr: string): 'present' | 'absent' {
  if (exitCode === 0) return 'present';
  if (/: not found\b|\bmanifest unknown\b|\bname unknown\b|\bdenied\b/i.test(stderr)) {
    return 'absent';
  }
  throw new Error(`registry lookup failed (exit ${exitCode}): ${stderr.trim()}`);
}

interface Args {
  workflow: string;
  image: string;
  salt: string;
  force: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { salt: '', force: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--force') {
      args.force = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    if (flag === '--workflow') args.workflow = value;
    else if (flag === '--image') args.image = value;
    else if (flag === '--salt') args.salt = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.workflow || !args.image) throw new Error('--workflow and --image are required');
  return args as Args;
}

function run(cmd: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  const filter = pushPaths(readFileSync(args.workflow, 'utf8'));
  const tree = run(['git', '-c', 'core.quotePath=false', 'ls-tree', '-r', '--full-tree', 'HEAD']);
  if (tree.exitCode !== 0) throw new Error(`git ls-tree failed: ${tree.stderr}`);
  const hash = sourceHash(filterTree(tree.stdout, filter), args.salt);
  const tag = `src-${hash}`;
  let skip = false;
  if (args.force) {
    console.error(`workflow_dispatch: building regardless of ${args.image}:${tag}`);
  } else {
    const fetch = run(['oras', 'manifest', 'fetch', '--descriptor', `${args.image}:${tag}`]);
    skip = classifyFetch(fetch.exitCode, fetch.stderr) === 'present';
    console.error(skip ? `${args.image}:${tag} exists; skipping` : `${args.image}:${tag} absent`);
  }
  console.log(`hash=${hash}`);
  console.log(`tag=${tag}`);
  console.log(`skip=${skip}`);
}
