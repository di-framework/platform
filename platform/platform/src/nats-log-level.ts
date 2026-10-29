import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dump, loadAll } from 'js-yaml';

/**
 * nats-server flags that turn on debug or protocol trace logging, matched on the name before any
 * `=value`. The runtime-operator chart starts its scheduler NATS with `-DV` and has no value to
 * change it (#550).
 */
const NATS_DEBUG_ARGS = new Set([
  '-D',
  '-V',
  '-DV',
  '-VD',
  '-VV',
  '-DVV',
  '-VVD',
  '--debug',
  '--trace',
]);

const isDebugArg = (arg: unknown) => NATS_DEBUG_ARGS.has(String(arg).split('=')[0] as string);

interface Container {
  name?: unknown;
  args?: unknown;
}

interface Manifest {
  kind?: unknown;
  spec?: { template?: { spec?: { containers?: Container[] } } };
}

/** One rendered document: rewritten only when it is a Deployment whose `nats` container loses args. */
function stripDocument(chunk: string): string {
  const docs = loadAll(chunk);
  if (docs.length !== 1) return chunk;
  const manifest = docs[0] as Manifest | null;
  if (manifest?.kind !== 'Deployment') return chunk;
  let changed = false;
  for (const container of manifest.spec?.template?.spec?.containers ?? []) {
    if (container.name !== 'nats' || !Array.isArray(container.args)) continue;
    const args = container.args.filter((arg) => !isDebugArg(arg));
    changed ||= args.length !== container.args.length;
    container.args = args;
  }
  if (!changed) return chunk;
  // Keep the separator and the `# Source:` comment Helm puts before each document.
  const header = /^(?:---[ \t]*\n)?(?:#[^\n]*\n)*/.exec(chunk)?.[0];
  return `${header}${dump(manifest, { lineWidth: -1 })}`;
}

/**
 * Drop debug/trace flags from the `nats` container args of the Deployments in a Helm render. Every
 * other document passes through byte for byte.
 */
export function stripNatsDebugArgs(manifests: string): string {
  return manifests
    .split(/^(?=---[ \t]*$)/m)
    .map(stripDocument)
    .join('');
}

/** Helm post-renderer entry: rendered manifests on stdin, the patched manifests on stdout. */
export function runNatsPostrender(
  read: () => string = () => readFileSync(0, 'utf8'),
  write: (text: string) => void = (text) => process.stdout.write(text),
): void {
  write(stripNatsDebugArgs(read()));
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The post-renderer script: `/bin/sh` running this module's entry with `runtime`. */
export function natsPostrenderScript(module: string, runtime: string): string {
  const code = `require(${JSON.stringify(module)}).runNatsPostrender()`;
  return `#!/bin/sh\nexec ${shellQuote(runtime)} -e ${shellQuote(code)}\n`;
}

/** The per-user directory the post-renderer is written to: `$XDG_CACHE_HOME` or `~/.cache`. */
export function defaultPostrenderDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'di-framework-platform');
}

/** Create `dir` private to the current user; refuse a symlink, another owner or group/other write. */
function privateDir(dir: string, uid: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory())
    throw new Error(`${dir} is not a directory (symlink?); refusing to use it`);
  if (stat.uid !== uid) throw new Error(`${dir} is owned by uid ${stat.uid}; refusing to use it`);
  if ((stat.mode & 0o022) !== 0)
    throw new Error(`${dir} is writable by group or others; refusing to use it`);
}

export interface PostrendererOptions {
  /** Directory for the script; default {@link defaultPostrenderDir}. */
  dir?: string;
  /** Module whose `runNatsPostrender` the script runs; default this module. */
  module?: string;
  /** Node binary; default the current one. */
  runtime?: string;
  /** Expected owner of `dir`; default the current user. */
  uid?: number;
}

/**
 * Write the executable Helm runs as the runtime-operator release's post-renderer and return its
 * path. The name carries a hash of the script, so it stays the same across runs of one install
 * (no Release diff) and differs between installs. It is written to a unique temp file and renamed
 * into place, so a concurrent reader never sees a partial file.
 */
export function natsPostrenderer({
  dir = defaultPostrenderDir(),
  module = __filename,
  runtime = process.execPath,
  uid = process.getuid?.() ?? 0,
}: PostrendererOptions = {}): string {
  privateDir(dir, uid);
  const script = natsPostrenderScript(module, runtime);
  const hash = createHash('sha256').update(script).digest('hex').slice(0, 16);
  const path = join(dir, `nats-postrender-${hash}`);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, script, { mode: 0o700 });
  chmodSync(temp, 0o700);
  renameSync(temp, path);
  return path;
}
