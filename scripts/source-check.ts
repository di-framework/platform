#!/usr/bin/env bun
/**
 * Skip-if-published check for the GHCR publish workflows (#172).
 *
 * The source hash covers the files the workflow's own `on.push.paths` filter
 * matches (with GitHub's ordering and `!` exclusions), minus the globs listed in
 * the workflow's top-level `env.SOURCE_HASH_EXCLUDE` (one per line). Those are
 * files that only test the artifact: a change to them still starts the run, so a
 * fix to a failed gate publishes by itself, but it leaves the hash alone, so the
 * run stops at this check when the source is already published (#349). The
 * hashed files are therefore always a subset of the triggering ones. It hashes `git ls-tree -r HEAD` lines (mode, blob id and path of each
 * committed file), not the working tree, so it is deterministic for a commit. An optional
 * salt separates artifacts built from the same inputs (the tenant host variants).
 *
 * Usage:
 *   bun scripts/source-check.ts --workflow <file> --image <ghcr.io/org/name> [--salt <s>]
 *     [--force] [--stale-guard] [--no-registry] [--github-output]
 *
 * Prints `hash=`, `tag=`, `stale=`, `skip=` and `digest=` lines (and appends them to
 * `$GITHUB_OUTPUT` with `--github-output`). With `--force` (workflow_dispatch) nothing is
 * skipped. Otherwise `stale=true skip=true` when `--stale-guard` finds different inputs at the
 * tip of origin/main, and `skip=true digest=<digest>` when `<image>:src-<hash>` already exists.
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
 * The workflow's `env.SOURCE_HASH_EXCLUDE`: globs, one per line, that trigger a run but are
 * not hashed. Empty when the workflow sets none.
 */
export function hashExclusions(workflowYaml: string): string[] {
  const workflow = Bun.YAML.parse(workflowYaml) as { env?: Record<string, unknown> };
  const value = workflow.env?.SOURCE_HASH_EXCLUDE;
  if (value === undefined) return [];
  if (typeof value !== 'string') throw new Error('env.SOURCE_HASH_EXCLUDE must be a string');
  const globs = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const glob of globs) {
    if (glob.startsWith('!')) throw new Error(`SOURCE_HASH_EXCLUDE lists globs, not ${glob}`);
  }
  return globs;
}

/**
 * The filter the source hash uses: `on.push.paths`, then each `SOURCE_HASH_EXCLUDE` glob as a
 * final `!` pattern, so it can only remove files from the triggering set.
 */
export function hashPaths(workflowYaml: string): string[] {
  return [...pushPaths(workflowYaml), ...hashExclusions(workflowYaml).map((glob) => `!${glob}`)];
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
 * Staleness is about the source, not the commit (#172 review): a run is stale only when the
 * filtered inputs at the tip of main hash differently from this run's. An unrelated newer commit
 * (docs, another package) leaves the hash alone, so the run still publishes and pins; a newer
 * change to the inputs means a newer run will publish and pin that source, so this one must not
 * move tags or pins backwards. Returns a notice when stale, undefined otherwise.
 */
export function staleNotice(own: string, tip: string): string | undefined {
  if (own === tip) return undefined;
  return `the inputs on main have changed since this commit (source ${own.slice(0, 12)}, main ${tip.slice(0, 12)}); the run for the newer source publishes and pins, so this one does nothing`;
}

/** The digest in `oras manifest fetch --descriptor` output. */
export function descriptorDigest(json: string): string {
  const digest = (JSON.parse(json) as { digest?: unknown }).digest;
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`descriptor has no sha256 digest: ${json}`);
  }
  return digest;
}

/**
 * `GIT_CONFIG_*` variables that authenticate the fetch of main with a read token (passed as
 * SOURCE_CHECK_TOKEN), without putting it on the command line. Without a token the fetch is
 * anonymous, which only works while di-framework/platform is public.
 */
export function tokenConfig(token: string | undefined): Record<string, string> {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export interface Args {
  workflow: string;
  image: string;
  salt: string;
  /** workflow_dispatch: always build; neither the staleness guard nor the registry is asked. */
  force: boolean;
  /** Compare this commit's input hash with the tip of origin/main's; stale means skip. */
  staleGuard: boolean;
  /** Ask the registry for <image>:src-<hash> (default); --no-registry checks staleness only. */
  registry: boolean;
  /** Also append the outputs to $GITHUB_OUTPUT. */
  githubOutput: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    salt: '',
    force: false,
    staleGuard: false,
    registry: true,
    githubOutput: false,
  };
  const flags: Record<string, keyof Args> = {
    '--force': 'force',
    '--stale-guard': 'staleGuard',
    '--github-output': 'githubOutput',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const key = flags[flag];
    if (key) {
      (args as Record<string, unknown>)[key] = true;
      continue;
    }
    if (flag === '--no-registry') {
      args.registry = false;
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

function run(
  cmd: string[],
  env?: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: env ? { ...process.env, ...env } : undefined,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function treeHash(rev: string, filter: string[], salt: string): string {
  const tree = run(['git', '-c', 'core.quotePath=false', 'ls-tree', '-r', '--full-tree', rev]);
  if (tree.exitCode !== 0) throw new Error(`git ls-tree ${rev} failed: ${tree.stderr}`);
  return sourceHash(filterTree(tree.stdout, filter), salt);
}

interface Result {
  hash: string;
  stale: boolean;
  skip: boolean;
  digest: string;
}

/** Annotations go to stdout so the Actions runner shows them. */
export function check(args: Args, filter: string[]): Result {
  const hash = treeHash('HEAD', filter, args.salt);
  const ref = `${args.image}:src-${hash}`;
  if (args.force) {
    console.log(`::notice::workflow_dispatch: building regardless of ${ref}`);
    return { hash, stale: false, skip: false, digest: '' };
  }
  if (args.staleGuard) {
    const fetch = run(
      ['git', 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', 'refs/heads/main'],
      tokenConfig(process.env.SOURCE_CHECK_TOKEN),
    );
    if (fetch.exitCode !== 0) throw new Error(`git fetch of main failed: ${fetch.stderr}`);
    const notice = staleNotice(hash, treeHash('FETCH_HEAD', filter, args.salt));
    if (notice) {
      console.log(`::notice::${notice}`);
      return { hash, stale: true, skip: true, digest: '' };
    }
  }
  if (!args.registry) return { hash, stale: false, skip: false, digest: '' };
  const fetch = run(['oras', 'manifest', 'fetch', '--descriptor', ref]);
  const state = classifyFetch(fetch.exitCode, fetch.stderr);
  if (state === 'denied') {
    console.log(
      `::warning::${ref}: registry answered "denied"; treating it as unpublished (expected only before the package's first push)`,
    );
  }
  if (state !== 'present') {
    console.log(`${ref} absent; building`);
    return { hash, stale: false, skip: false, digest: '' };
  }
  console.log(`${ref} exists; skipping`);
  return { hash, stale: false, skip: true, digest: descriptorDigest(fetch.stdout) };
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  const filter = hashPaths(readFileSync(args.workflow, 'utf8'));
  const result = check(args, filter);
  const outputs = [
    `hash=${result.hash}`,
    `tag=src-${result.hash}`,
    `stale=${result.stale}`,
    `skip=${result.skip}`,
    `digest=${result.digest}`,
    '',
  ].join('\n');
  process.stdout.write(outputs);
  if (args.githubOutput) {
    const file = process.env.GITHUB_OUTPUT;
    if (!file) throw new Error('--github-output needs $GITHUB_OUTPUT');
    appendFileSync(file, outputs);
  }
}
