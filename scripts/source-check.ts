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
 *   bun scripts/source-check.ts --workflow <file> --image <ghcr.io/org/name> [--salt <s>]
 *     [--force] [--require-main-tip <sha>] [--github-output]
 *
 * Prints `hash=`, `tag=` and `skip=` lines (and appends them to `$GITHUB_OUTPUT` with
 * `--github-output`). Without `--force` (workflow_dispatch), `skip=true` when
 * `<image>:src-<hash>` already exists, or when `--require-main-tip` names a commit that is no
 * longer the tip of origin/main (a re-run of an older push).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

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
 * Read `oras manifest fetch --descriptor` results. A missing tag is "not found". A GHCR
 * package that has never been pushed answers "denied" (#137: pglite has no package yet); the
 * caller treats that as absent but warns, since broken access to an existing package reads the
 * same. Any other failure (network, 5xx) is an error, so an outage fails the run instead of
 * silently republishing.
 */
export function classifyFetch(exitCode: number, stderr: string): 'present' | 'absent' | 'denied' {
  if (exitCode === 0) return 'present';
  if (/: not found\b|\bmanifest unknown\b|\bname unknown\b/i.test(stderr)) return 'absent';
  if (/\bdenied\b/i.test(stderr)) return 'denied';
  throw new Error(`registry lookup failed (exit ${exitCode}): ${stderr.trim()}`);
}

/**
 * A re-run of an older push must not republish (moving the mutable tags backwards) or pin an
 * older digest. `lsRemote` is `git ls-remote origin refs/heads/main`; returns a notice when
 * `sha` is no longer the tip of main, undefined when it is.
 */
export function staleNotice(sha: string, lsRemote: string): string | undefined {
  const tip = lsRemote.split(/\s/)[0] ?? '';
  if (!/^[0-9a-f]{40}$/.test(tip)) throw new Error(`cannot read the tip of main: ${lsRemote}`);
  if (tip === sha) return undefined;
  return `${sha} is no longer the tip of main (${tip}); a re-run of an older push publishes nothing`;
}

interface Args {
  workflow: string;
  image: string;
  salt: string;
  force: boolean;
  /** Skip unless this commit is still the tip of origin/main (ignored with --force). */
  sha?: string;
  /** Also append the outputs to $GITHUB_OUTPUT. */
  githubOutput: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { salt: '', force: false, githubOutput: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--force') {
      args.force = true;
      continue;
    }
    if (flag === '--github-output') {
      args.githubOutput = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    if (flag === '--workflow') args.workflow = value;
    else if (flag === '--image') args.image = value;
    else if (flag === '--salt') args.salt = value;
    else if (flag === '--require-main-tip') args.sha = value;
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

/** Decide whether to skip; annotations go to stdout so the Actions runner shows them. */
function decide(args: Args, tag: string): boolean {
  const ref = `${args.image}:${tag}`;
  if (args.force) {
    console.log(`::notice::workflow_dispatch: building regardless of ${ref}`);
    return false;
  }
  if (args.sha) {
    const remote = run(['git', 'ls-remote', 'origin', 'refs/heads/main']);
    if (remote.exitCode !== 0) throw new Error(`git ls-remote failed: ${remote.stderr}`);
    const notice = staleNotice(args.sha, remote.stdout);
    if (notice) {
      console.log(`::notice::${notice}`);
      return true;
    }
  }
  const fetch = run(['oras', 'manifest', 'fetch', '--descriptor', ref]);
  const state = classifyFetch(fetch.exitCode, fetch.stderr);
  if (state === 'denied') {
    console.log(
      `::warning::${ref}: registry answered "denied"; treating it as unpublished (expected only before the package's first push)`,
    );
  }
  console.log(state === 'present' ? `${ref} exists; skipping` : `${ref} absent; building`);
  return state === 'present';
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  const filter = pushPaths(readFileSync(args.workflow, 'utf8'));
  const tree = run(['git', '-c', 'core.quotePath=false', 'ls-tree', '-r', '--full-tree', 'HEAD']);
  if (tree.exitCode !== 0) throw new Error(`git ls-tree failed: ${tree.stderr}`);
  const hash = sourceHash(filterTree(tree.stdout, filter), args.salt);
  const tag = `src-${hash}`;
  const skip = decide(args, tag);
  const outputs = `hash=${hash}\ntag=${tag}\nskip=${skip}\n`;
  process.stdout.write(outputs);
  const file = process.env.GITHUB_OUTPUT;
  if (args.githubOutput) {
    if (!file) throw new Error('--github-output needs $GITHUB_OUTPUT');
    appendFileSync(file, outputs);
  }
}
