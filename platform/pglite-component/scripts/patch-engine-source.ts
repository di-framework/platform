/**
 * Component-specific patches on top of the pinned PostgreSQL engine sources.
 * Invoked by the patched upstream build recipe as
 * `bun "$DF_PGLITE_SOURCE_PATCH" "$SRC"` (see build-engine.ts).
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Args, type Context, parseFlags, run, UsageError } from './lib/cli.ts';
import { isDirectory } from './lib/fs.ts';

const USAGE = 'usage: patch-engine-source.ts <engine-source-dir>';

/** Only these engine sources may be patched or written. */
export const ALLOWED_RELATIVE_FILES = new Set([
  'src/backend/libpq/pqcomm.c',
  'pglite-wasm/pg_main.c',
  'pglite-wasm/build.sh',
  'wasm-build/build-ext.sh',
  'wasm-build/sdk_port-wasi/sdk_port-wasi-dlfcn.c',
  'df-extensions/build-pgcrypto.sh',
  'df-extensions/openssl.tar.gz',
]);

export function parseSourceArgs(argv: string[]): Args<{ source: string }> {
  const flags = parseFlags(argv, {}, USAGE, { positionals: true });
  if (flags.help) return flags;
  const [source, ...extra] = flags.positionals;
  if (!source || extra.length > 0) throw new UsageError(USAGE);
  return { help: false, source };
}

/** Engine checkouts live under `target/engine` (see build-engine.ts). */
export function engineRoot(pkgDir: string): string {
  return join(pkgDir, 'target', 'engine');
}

/** Resolve the engine source directory, refusing anything outside `root`. */
export async function resolveSourceDir(
  source: string,
  root: string,
  cwd = process.cwd(),
): Promise<string> {
  const resolved = resolve(cwd, source);
  const base = resolve(root);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    throw new Error(`refusing source dir outside ${base}: ${resolved}`);
  }
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

/** WASI link line anchor: pgcrypto and libcrypto are linked right after plpgsql. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text for the upstream build recipe, not a TS template.
export const LINK_PLPGSQL = '${PG_BUILD}/${BUILD}/src/pl/plpgsql/src/libplpgsql.a \\\n';
export const LINK_PGCRYPTO =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text for the upstream build recipe, not a TS template.
  '             ${PG_BUILD}/${BUILD}/contrib/pgcrypto/libpgcrypto.a ${PG_BUILD}/df-openssl/lib/libcrypto.a \\\n';

/** build-ext.sh skips all contrib on WASI; build pgcrypto there instead. */
export const EXT_SKIP_ANCHOR = '    SKIP_CONTRIB=true\nelse\n';
export const EXT_PGCRYPTO_HOOK =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text for the upstream build recipe, not a TS template.
  '    bash "${WORKSPACE}/df-extensions/build-pgcrypto.sh" || exit 70 # di-framework: pgcrypto\n';

export const DLFCN_DECLS_MARKER = '/* di-framework: static extensions */';
export const DLFCN_DECLS = [
  DLFCN_DECLS_MARKER,
  'extern void *df_ext_dlopen(const char *filename);',
  'extern void *df_ext_dlsym(const char *symbol);',
  '',
  '',
].join('\n');
export const DLOPEN_ANCHOR = 'dlopen(const char *filename, int flags) {\n    dict_t tab = NULL;\n';
export const DLOPEN_HOOK = [
  '    void *df_handle = df_ext_dlopen(filename);',
  '    if (df_handle)',
  '        return df_handle;',
  '',
].join('\n');
export const DLSYM_ANCHOR =
  'dlsym(void *__restrict handle, const char *__restrict symbol) {\n    void *sym = NULL;\n';
export const DLSYM_HOOK = [
  '    void *df_sym = df_ext_dlsym(symbol);',
  '    if (df_sym)',
  '        return df_sym;',
  '',
].join('\n');

/**
 * Insert `addition` before or after the single occurrence of `anchor`.
 * Idempotent: text that already contains `addition` is returned unchanged.
 */
export function insertOnce(
  text: string,
  anchor: string,
  addition: string,
  where: 'before' | 'after',
  file: string,
): string {
  if (text.includes(addition)) return text;
  const count = text.split(anchor).length - 1;
  if (count !== 1) throw new Error(`${file}: expected 1 patch anchor, found ${count}`);
  return text.replace(anchor, where === 'before' ? `${addition}${anchor}` : `${anchor}${addition}`);
}

export const DLOPEN_DEFINITION = 'void *\ndlopen(';

/**
 * Wire pgcrypto into the WASI build: build it after the core (build-ext.sh),
 * link it statically (pglite-wasm/build.sh) and resolve its symbols through
 * the emulated dlopen/dlsym (sdk_port-wasi-dlfcn.c). The build script and the
 * checksum-verified OpenSSL source are copied into df-extensions/.
 */
export async function patchPgcrypto(
  source: string,
  pkgDir: string,
  opensslTarball: string,
): Promise<void> {
  const ext = checkedPath(source, 'wasm-build/build-ext.sh');
  await Bun.write(
    ext,
    insertOnce(
      await Bun.file(ext).text(),
      EXT_SKIP_ANCHOR,
      EXT_PGCRYPTO_HOOK,
      'before',
      'build-ext.sh',
    ),
  );

  const link = checkedPath(source, 'pglite-wasm/build.sh');
  await Bun.write(
    link,
    insertOnce(await Bun.file(link).text(), LINK_PLPGSQL, LINK_PGCRYPTO, 'after', 'build.sh'),
  );

  const dlfcn = checkedPath(source, 'wasm-build/sdk_port-wasi/sdk_port-wasi-dlfcn.c');
  const name = 'sdk_port-wasi-dlfcn.c';
  let text = await Bun.file(dlfcn).text();
  text = insertOnce(text, DLOPEN_DEFINITION, DLFCN_DECLS, 'before', name);
  text = insertOnce(text, DLOPEN_ANCHOR, DLOPEN_HOOK, 'after', name);
  text = insertOnce(text, DLSYM_ANCHOR, DLSYM_HOOK, 'after', name);
  await Bun.write(dlfcn, text);

  await mkdir(join(source, 'df-extensions'), { recursive: true });
  await Bun.write(
    checkedPath(source, 'df-extensions/build-pgcrypto.sh'),
    Bun.file(join(pkgDir, 'engine', 'build-pgcrypto.sh')),
  );
  await Bun.write(checkedPath(source, 'df-extensions/openssl.tar.gz'), Bun.file(opensslTarball));
}

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
  const root = engineRoot(ctx.pkgDir);
  const source = await resolveSourceDir(args.source, root);
  await patchEngineSource(source, ctx.pkgDir);
  // build-engine.ts downloads and verifies the pinned OpenSSL source first.
  const openssl = ctx.env.DF_PGLITE_OPENSSL_TARBALL;
  if (!openssl) throw new Error('DF_PGLITE_OPENSSL_TARBALL is not set (run via build-engine.ts)');
  const tarball = resolve(openssl);
  if (!tarball.startsWith(`${resolve(root)}/`)) {
    throw new Error(`refusing OpenSSL source outside ${root}: ${tarball}`);
  }
  await patchPgcrypto(source, ctx.pkgDir, tarball);
}

if (import.meta.main) await run('patch-engine-source', patch);
