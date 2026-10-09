/**
 * Component-specific patches on top of the pinned PostgreSQL engine sources.
 * Invoked by the patched upstream build recipe as
 * `bun "$DF_PGLITE_SOURCE_PATCH" "$SRC"` (see build-engine.ts).
 */
import { resolve } from 'node:path';
import { type Args, type Context, parseFlags, run, UsageError } from './lib/cli.ts';
import { isDirectory } from './lib/fs.ts';

const USAGE = 'usage: patch-engine-source.ts <engine-source-dir>';

/** Only these two engine sources may be patched. */
export const ALLOWED_RELATIVE_FILES = new Set([
  'src/backend/libpq/pqcomm.c',
  'pglite-wasm/pg_main.c',
]);

export function parseSourceArgs(argv: string[]): Args<{ source: string }> {
  const flags = parseFlags(argv, {}, USAGE, { positionals: true });
  if (flags.help) return flags;
  const [source, ...extra] = flags.positionals;
  if (!source || extra.length > 0) throw new UsageError(USAGE);
  return { help: false, source };
}

/** Resolve and validate the engine source directory. */
export async function resolveSourceDir(source: string, cwd = process.cwd()): Promise<string> {
  const resolved = resolve(cwd, source);
  if (!(await isDirectory(resolved))) throw new Error(`source dir does not exist: ${resolved}`);
  return resolved;
}

/**
 * Resolve an allowlisted relative file inside `source`, refusing anything
 * that would escape the source tree.
 */
export function checkedPath(source: string, relative: string): string {
  if (!ALLOWED_RELATIVE_FILES.has(relative)) {
    throw new Error(`refusing unexpected relative path: ${relative}`);
  }
  const resolved = resolve(source, relative);
  if (resolved === source || !resolved.startsWith(`${source}/`)) {
    throw new Error(`refusing path outside source dir: ${relative}`);
  }
  return resolved;
}

export const PQCOMM_MARKER = '/* di-framework: collect CMA replies';
export const PQCOMM_FALLBACK_START = 'static int\ninternal_putbytes(const char *s, size_t len) {';
export const PQCOMM_END = '\nstatic int\nsocket_flush';
export const PG_BACKEND_START = '     void pgl_backend()';
export const PG_BACKEND_END = '  backend_started:;';
export const PG_DEFAULTS_MARKER = '/* di-framework: application session defaults */';

/** C bytes replacing initdb's insecure `"-F", "-O", "-j"` defaults. */
export const INITDB_DEFAULTS_NEW = [
  '"-O", "-j",',
  '            "-c", "search_path=\\"$user\\", public",',
  '            "-c", "fsync=on",',
  '            "-c", "synchronous_commit=on",',
  '            "-c", "full_page_writes=on",',
].join('\n');

/** Session defaults installed after bootstrap (matches the old Python patch byte-for-byte). */
export const SESSION_DEFAULTS_BLOCK = [
  '    /* di-framework: application session defaults */',
  '    SetConfigOption("search_path", "\\"$user\\", public", PGC_USERSET, PGC_S_OVERRIDE);',
  '    SetConfigOption("exit_on_error", "off", PGC_USERSET, PGC_S_OVERRIDE);',
  '    SetConfigOption("ignore_invalid_pages", "off", PGC_POSTMASTER, PGC_S_OVERRIDE);',
  '    ResetAllOptions();',
  '',
].join('\n');

export async function patchEngineSource(source: string, pkgDir: string): Promise<void> {
  const pqcomm = checkedPath(source, 'src/backend/libpq/pqcomm.c');
  let text = await Bun.file(pqcomm).text();
  const start = text.includes(PQCOMM_MARKER)
    ? text.indexOf(PQCOMM_MARKER)
    : text.indexOf(PQCOMM_FALLBACK_START);
  if (start < 0) throw new Error(`pqcomm.c: patch anchor not found in ${pqcomm}`);
  const end = text.indexOf(PQCOMM_END, start);
  if (end < 0) throw new Error(`pqcomm.c: patch end anchor not found in ${pqcomm}`);
  const replyBuffer = await Bun.file(`${pkgDir}/engine/reply-buffer.c`).text();
  await Bun.write(pqcomm, `${text.slice(0, start)}${replyBuffer}\n${text.slice(end)}`);

  const pgMain = checkedPath(source, 'pglite-wasm/pg_main.c');
  text = await Bun.file(pgMain).text();
  const bodyStart = text.indexOf(PG_BACKEND_START);
  if (bodyStart < 0) throw new Error(`pg_main.c: pgl_backend not found in ${pgMain}`);
  const bodyEnd = text.indexOf(PG_BACKEND_END, bodyStart);
  if (bodyEnd < 0) throw new Error(`pg_main.c: backend_started not found in ${pgMain}`);
  const oldDefaults = '"-F", "-O", "-j",';
  const body = text.slice(bodyStart, bodyEnd);
  if (body.includes(oldDefaults)) {
    const occurrences = body.split(oldDefaults).length - 1;
    if (occurrences !== 2) {
      throw new Error(`pg_main.c: expected 2 initdb default blocks, found ${occurrences}`);
    }
    text =
      text.slice(0, bodyStart) +
      body.replaceAll(oldDefaults, INITDB_DEFAULTS_NEW) +
      text.slice(bodyEnd);
  }
  if (!text.includes(PG_DEFAULTS_MARKER)) {
    if (!text.includes(PG_BACKEND_END))
      throw new Error('pg_main.c: session defaults insert failed');
    text = text.replace(PG_BACKEND_END, `${PG_BACKEND_END}\n${SESSION_DEFAULTS_BLOCK}`);
  }
  await Bun.write(pgMain, text);
}

export async function patch(ctx: Context, argv: string[]): Promise<void> {
  const args = parseSourceArgs(argv);
  if (args.help) {
    console.error(USAGE);
    return;
  }
  await patchEngineSource(await resolveSourceDir(args.source), ctx.pkgDir);
}

if (import.meta.main) await run('patch-engine-source', patch);
