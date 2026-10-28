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
  'pglite-wasm/pgl_initdb.c',
  'pglite-wasm/pgl_stubs.h',
  'contrib/pgcrypto/pgp-cfb.c',
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

/**
 * Replace the single occurrence of `anchor` with `replacement`.
 * Idempotent: text that already contains `replacement` is returned unchanged.
 */
export function replaceOnce(
  text: string,
  anchor: string,
  replacement: string,
  file: string,
): string {
  if (text.includes(replacement)) return text;
  const count = text.split(anchor).length - 1;
  if (count !== 1) throw new Error(`${file}: expected 1 patch anchor, found ${count}`);
  return text.replace(anchor, () => replacement);
}

export const DLOPEN_DEFINITION = 'void *\ndlopen(';

/**
 * The static-extension dlopen hook must run before the emulated dlopen table
 * code below it, so statically linked extensions never take a table slot.
 */
export const DLOPEN_HOOK_NOTE = [
  '    /* di-framework: keep this hook ahead of the dltab code below; static',
  '     * extensions such as pgcrypto must never take a dltab slot. */',
  '',
].join('\n');

/**
 * wasipg's dlopen emulation declares `volatile dict_t* dltab[];`, which C
 * completes to a one-element array, then stores each new table at
 * `dltab[++dltab_index]` with no bound. The first dlopen already writes past
 * the array, and loading plpgsql (or LOAD of any existing file) reaches it.
 * Its lookup never matched either (`> 0` on entry 0). Replace the table with
 * a bounded one and fail dlopen cleanly once it is full.
 */
export const DLTAB_DECL_OLD = 'volatile dict_t* dltab[];\nvolatile int dltab_index = 0;\n';
export const DLTAB_DECL_NEW = [
  '/* di-framework: bounded dlopen table (upstream overflowed dltab[]). */',
  '#define DF_DLTAB_MAX 64',
  'static dict_t dltab[DF_DLTAB_MAX];',
  'static int dltab_index = 0;',
  '',
].join('\n');
export const DLTAB_LOOKUP_OLD = [
  '    for (int i=0; i< dltab_index; i++) {',
  '        if ( dict_find_index(dltab[i], filename) > 0 )',
  '            return (void *)i;',
  '    }',
  '',
].join('\n');
export const DLTAB_LOOKUP_NEW = [
  '    for (int i = 0; i < dltab_index; i++) {',
  '        if (dict_find_index(dltab[i], filename) >= 0)',
  '            return (void *)(intptr_t)(i + 1);',
  '    }',
  '    if (dltab_index >= DF_DLTAB_MAX)',
  '        return NULL;',
  '',
].join('\n');
export const DLTAB_INSERT_OLD = [
  '    tab = dict_new();',
  '    dict_add(tab, filename, dltab_index++ );',
  '    dltab[dltab_index] = tab;',
  '',
  '    return (void *)dltab_index;',
  '',
].join('\n');
export const DLTAB_INSERT_NEW = [
  '    tab = dict_new();',
  '    dict_add(tab, filename, dltab_index);',
  '    dltab[dltab_index++] = tab;',
  '',
  '    return (void *)(intptr_t)dltab_index;',
  '',
].join('\n');
/** Upstream dlerror returned its own address as the message string. */
export const DLERROR_OLD = '    return (char *)dlerror;\n';
export const DLERROR_NEW = '    return (char *)"di-framework: dlopen table is full";\n';

/**
 * Patch the emulated dlopen/dlsym: the static-extension hooks first, then the
 * bounded dltab. The dlopen hook is anchored to the function's first
 * statement, so it always runs before the table lookup; if upstream moves the
 * lookup above that statement the anchor no longer matches and patching fails.
 */
export function patchDlfcn(text: string): string {
  const name = 'sdk_port-wasi-dlfcn.c';
  let out = insertOnce(text, DLOPEN_DEFINITION, DLFCN_DECLS, 'before', name);
  out = insertOnce(out, DLOPEN_ANCHOR, DLOPEN_HOOK, 'after', name);
  out = insertOnce(out, DLOPEN_HOOK, DLOPEN_HOOK_NOTE, 'before', name);
  out = insertOnce(out, DLSYM_ANCHOR, DLSYM_HOOK, 'after', name);
  out = replaceOnce(out, DLTAB_DECL_OLD, DLTAB_DECL_NEW, name);
  out = replaceOnce(out, DLTAB_LOOKUP_OLD, DLTAB_LOOKUP_NEW, name);
  out = replaceOnce(out, DLTAB_INSERT_OLD, DLTAB_INSERT_NEW, name);
  return replaceOnce(out, DLERROR_OLD, DLERROR_NEW, name);
}

/**
 * Blowfish and CAST5 are unavailable in this build (they need the OpenSSL
 * legacy provider, which is not built). Upstream PostgreSQL 17.11 makes
 * pgcrypto's PGP CFB mode raise an ERROR when a cipher cannot encrypt
 * (b05cfc6937, CVE-2026-14663) and adds a decrypt-only `ignore-cipher-failure`
 * recovery option (7eed42a). di-framework carried its own fix for this until
 * #383; now the engine relies on upstream's, and refuses a base without it.
 *
 * The fix has three parts, and a base must carry all of them:
 * - cfb_process keeps px_cipher_encrypt's result (PGP_CFB_ENCRYPT_CALL),
 * - then raises an ERROR on it unless failures are ignored (PGP_CFB_ERROR_CHECK),
 *   with nothing but comments in between,
 * - and pgp_cfb_encrypt never ignores them (passes 0 as ignore_cipher_failure).
 */
export const PGP_CFB_ENCRYPT_CALL =
  '\t\terr = px_cipher_encrypt(ctx->ciph, 0, ctx->fr, ctx->block_size, ctx->fre, &rlen);\n';
export const PGP_CFB_ERROR_CHECK = '\t\tif (err && !ignore_cipher_failure)\n\t\t\tereport(ERROR,\n';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The encrypt call followed by its error check; only whitespace and comments may sit between. */
const PGP_CFB_CHECKED_CALL = new RegExp(
  `${escapeRegExp(PGP_CFB_ENCRYPT_CALL)}(?:\\s|/\\*[\\s\\S]*?\\*/)*${escapeRegExp(PGP_CFB_ERROR_CHECK)}`,
  'g',
);

/** pgp_cfb_encrypt hands cfb_process 0 as its last (ignore_cipher_failure) argument. */
const PGP_CFB_ENCRYPT_NEVER_IGNORES =
  /\npgp_cfb_encrypt\([^)]*\)\s*\{[^}]*\breturn cfb_process\([^;]*,\s*0\s*(?:\/\*[^*]*\*\/\s*)?\)\s*;/;

/** Fail unless pgcrypto's PGP CFB mode raises an ERROR when encryption fails (see above). */
export function requirePgpCfbFix(text: string): void {
  const calls = text.split('px_cipher_encrypt(').length - 1;
  const checked = text.match(PGP_CFB_CHECKED_CALL)?.length ?? 0;
  if (calls === 0 || checked !== calls) {
    throw new Error(
      'pgp-cfb.c: the PGP CFB cipher error check (PostgreSQL 17.11, CVE-2026-14663) is missing; ' +
        'Blowfish and CAST5 would encrypt to plaintext',
    );
  }
  if (!PGP_CFB_ENCRYPT_NEVER_IGNORES.test(text)) {
    throw new Error(
      'pgp-cfb.c: pgp_cfb_encrypt may ignore cipher failures (PostgreSQL 17.11, CVE-2026-14663); ' +
        'Blowfish and CAST5 would encrypt to plaintext',
    );
  }
}

/**
 * Frontend glue the PostgreSQL security fixes since 17.5 need. pgl_initdb.c
 * compiles initdb.c into the backend translation unit, and pgl_stubs.h stands
 * in for src/common/fe_memutils.c there.
 *
 * - 4fcccea (17.11, CVE-2026-6471) declares a frontend
 *   `SplitGUCList(char *, char, char ***)` in fe_utils/string_utils.h, which
 *   clashes with the backend's `List **` one in utils/varlena.h. initdb never
 *   calls it, so the frontend declaration is renamed for that include only.
 * - fe2720c (17.10, CVE-2026-6473) routes pg_malloc_array() and
 *   pg_realloc_array() through new overflow-checked pg_malloc_mul() and
 *   pg_realloc_mul(); the stubs gain both, with upstream's limits.
 */
export const INITDB_INCLUDE = '#include "bin/initdb/initdb.c"\n';
export const INITDB_INCLUDE_NEW = [
  '/* di-framework: initdb never calls the frontend SplitGUCList (17.11), whose',
  ' * declaration clashes with the backend one already in scope here. */',
  '#define SplitGUCList df_frontend_SplitGUCList',
  '#include "bin/initdb/initdb.c"',
  '#undef SplitGUCList',
  '',
].join('\n');
export const STUBS_REALLOC_ANCHOR = [
  'void *',
  'pg_realloc(void *ptr, size_t size) {',
  '    return realloc(ptr, size);',
  '}',
  '',
].join('\n');
export const STUBS_MUL_HELPERS = [
  '',
  '/* di-framework: overflow-checked helpers behind pg_malloc_array() and',
  " * pg_realloc_array() (17.10), with fe_memutils.c's limits. */",
  'static size_t',
  'df_mul_size(size_t s1, size_t s2) {',
  '    size_t req;',
  '    if (__builtin_mul_overflow(s1, s2, &req) || req > (SIZE_MAX / 2)) {',
  '        fprintf(stderr, "invalid memory allocation request size %zu * %zu\\n", s1, s2);',
  '        abort();',
  '    }',
  '    return req;',
  '}',
  '',
  'void *',
  'pg_malloc_mul(size_t s1, size_t s2) {',
  '    return pg_malloc(df_mul_size(s1, s2));',
  '}',
  '',
  'void *',
  'pg_realloc_mul(void *ptr, size_t s1, size_t s2) {',
  '    return pg_realloc(ptr, df_mul_size(s1, s2));',
  '}',
  '',
].join('\n');

export function patchInitdbInclude(text: string): string {
  return replaceOnce(text, INITDB_INCLUDE, INITDB_INCLUDE_NEW, 'pgl_initdb.c');
}

export function patchFrontendStubs(text: string): string {
  return insertOnce(text, STUBS_REALLOC_ANCHOR, STUBS_MUL_HELPERS, 'after', 'pgl_stubs.h');
}

/** Apply the frontend glue fixes (see INITDB_INCLUDE_NEW and STUBS_MUL_HELPERS). */
export async function patchFrontendGlue(source: string): Promise<void> {
  const initdb = checkedPath(source, 'pglite-wasm/pgl_initdb.c');
  await Bun.write(initdb, patchInitdbInclude(await Bun.file(initdb).text()));
  const stubs = checkedPath(source, 'pglite-wasm/pgl_stubs.h');
  await Bun.write(stubs, patchFrontendStubs(await Bun.file(stubs).text()));
}

/**
 * Wire pgcrypto into the WASI build: build it after the core (build-ext.sh),
 * link it statically (pglite-wasm/build.sh) and resolve its symbols through
 * the emulated dlopen/dlsym (sdk_port-wasi-dlfcn.c), and check that its PGP CFB
 * mode reports cipher failures (contrib/pgcrypto/pgp-cfb.c). patchPgcrypto then
 * copies the build script and the checksum-verified OpenSSL source into
 * df-extensions/.
 */
export async function patchPgcryptoSources(source: string): Promise<void> {
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
  await Bun.write(dlfcn, patchDlfcn(await Bun.file(dlfcn).text()));

  requirePgpCfbFix(await Bun.file(checkedPath(source, 'contrib/pgcrypto/pgp-cfb.c')).text());
}

export async function patchPgcrypto(
  source: string,
  pkgDir: string,
  opensslTarball: string,
): Promise<void> {
  await patchPgcryptoSources(source);
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
  // build-engine.ts downloads and verifies the pinned OpenSSL source first.
  // Check it before writing anything so a refusal leaves the source untouched.
  const openssl = ctx.env.DF_PGLITE_OPENSSL_TARBALL;
  if (!openssl) throw new Error('DF_PGLITE_OPENSSL_TARBALL is not set (run via build-engine.ts)');
  const tarball = resolve(openssl);
  if (!tarball.startsWith(`${resolve(root)}/`)) {
    throw new Error(`refusing OpenSSL source outside ${root}: ${tarball}`);
  }
  await patchEngineSource(source, ctx.pkgDir);
  await patchFrontendGlue(source);
  await patchPgcrypto(source, ctx.pkgDir, tarball);
}

if (import.meta.main) await run('patch-engine-source', patch);
