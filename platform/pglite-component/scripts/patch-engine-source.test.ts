import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Context } from './lib/cli.ts';
import { loadTools } from './lib/toolchain.ts';
import {
  checkedPath,
  DLERROR_NEW,
  DLFCN_DECLS,
  DLOPEN_HOOK,
  DLOPEN_HOOK_NOTE,
  DLSYM_HOOK,
  DLTAB_DECL_NEW,
  DLTAB_INSERT_NEW,
  DLTAB_LOOKUP_NEW,
  EXT_PGCRYPTO_HOOK,
  engineRoot,
  INITDB_DEFAULTS_NEW,
  INITDB_INCLUDE,
  INITDB_INCLUDE_NEW,
  insertOnce,
  LINK_PGCRYPTO,
  LINK_PLPGSQL,
  PG_BACKEND_END,
  PG_BACKEND_START,
  PGP_CFB_ENCRYPT_CALL,
  PGP_CFB_ERROR_CHECK,
  PQCOMM_END,
  PQCOMM_FALLBACK_START,
  parseSourceArgs,
  patch,
  patchDlfcn,
  patchEngineSource,
  patchFrontendGlue,
  patchFrontendStubs,
  patchInitdbInclude,
  patchPgcrypto,
  patchPgcryptoSources,
  replaceOnce,
  requirePgpCfbFix,
  resolveSourceDir,
  SESSION_DEFAULTS_BLOCK,
  STUBS_MUL_HELPERS,
  STUBS_REALLOC_ANCHOR,
} from './patch-engine-source.ts';

const pkgDir = resolve(import.meta.dir, '..');

/** The dlopen/dlsym emulation as the pinned wasipg source ships it (abridged). */
const UPSTREAM_DLFCN = [
  '// dlfcn.h',
  '',
  'volatile dict_t* dltab[];',
  'volatile int dltab_index = 0;',
  '',
  'char *',
  'dlerror(void) {',
  '    return (char *)dlerror;',
  '}',
  '',
  'extern void _PG_init(void);',
  '',
  '',
  'void *',
  'dlopen(const char *filename, int flags) {',
  '    dict_t tab = NULL;',
  '    fprintf(stderr,"void *dlopen(const char *filename = %s, int flags=%d)\\n", filename, flags);',
  '    for (int i=0; i< dltab_index; i++) {',
  '        if ( dict_find_index(dltab[i], filename) > 0 )',
  '            return (void *)i;',
  '    }',
  '    printf("dlopen: new lib \'%s\'\\n", filename );',
  '    if ( ends_with(filename,"/plpgsql.so") ){',
  '        _PG_init();',
  '    }',
  '',
  '    tab = dict_new();',
  '    dict_add(tab, filename, dltab_index++ );',
  '    dltab[dltab_index] = tab;',
  '',
  '    return (void *)dltab_index;',
  '}',
  '',
  'void *',
  'dlsym(void *__restrict handle, const char *__restrict symbol) {',
  '    void *sym = NULL;',
  '    return sym;',
  '}',
  '',
].join('\n');

/** pgcrypto's PGP CFB mode, verbatim from PostgreSQL REL_17_11 (083ac03341). */
const UPSTREAM_PGP_CFB = await Bun.file(
  join(import.meta.dir, 'testdata/pgp-cfb-REL_17_11.c'),
).text();

/** The upstream file with `from` replaced by `to`; `from` must occur exactly once. */
function editedPgpCfb(from: string, to: string): string {
  if (UPSTREAM_PGP_CFB.split(from).length !== 2) {
    throw new Error(`fixture edit anchor not found exactly once: ${JSON.stringify(from)}`);
  }
  return UPSTREAM_PGP_CFB.replace(from, () => to);
}

/** The encrypt loop before 17.11: the encrypt result is ignored. */
const UNFIXED_PGP_CFB = editedPgpCfb(
  PGP_CFB_ENCRYPT_CALL,
  '\t\tpx_cipher_encrypt(ctx->ciph, 0, ctx->fr, ctx->block_size, ctx->fre, &rlen);\n',
);

/** pglite-wasm/pgl_initdb.c around the initdb include (abridged). */
const UPSTREAM_PGL_INITDB = [
  '#define icu_validate_locale(loc_str) icu_validate_locale_idb(loc_str)',
  '',
  '',
  '#include "bin/initdb/initdb.c"',
  '',
  'void use_socketfile(void) {',
  '}',
  '',
].join('\n');

/** pglite-wasm/pgl_stubs.h around the allocator stubs (abridged). */
const UPSTREAM_PGL_STUBS = [
  'void *',
  'pg_malloc(size_t size) {',
  '\treturn malloc(size);',
  '}',
  '',
  'void *',
  'pg_realloc(void *ptr, size_t size) {',
  '    return realloc(ptr, size);',
  '}',
  '',
  'char *',
  'pg_strdup(const char *in) {',
  '}',
  '',
].join('\n');

/** Write the upstream files patchPgcrypto edits into `source`. */
async function writePgcryptoInputs(source: string): Promise<void> {
  await mkdir(join(source, 'wasm-build/sdk_port-wasi'), { recursive: true });
  await mkdir(join(source, 'pglite-wasm'), { recursive: true });
  await mkdir(join(source, 'contrib/pgcrypto'), { recursive: true });
  await Bun.write(
    join(source, 'wasm-build/build-ext.sh'),
    'if $WASI\nthen\n    SKIP="pgcrypto"\n    SKIP_CONTRIB=true\nelse\n    SKIP=""\nfi\n',
  );
  await Bun.write(join(source, 'pglite-wasm/build.sh'), `             ${LINK_PLPGSQL}`);
  await Bun.write(join(source, 'wasm-build/sdk_port-wasi/sdk_port-wasi-dlfcn.c'), UPSTREAM_DLFCN);
  await Bun.write(join(source, 'contrib/pgcrypto/pgp-cfb.c'), UPSTREAM_PGP_CFB);
  await Bun.write(join(source, 'pglite-wasm/pgl_initdb.c'), UPSTREAM_PGL_INITDB);
  await Bun.write(join(source, 'pglite-wasm/pgl_stubs.h'), UPSTREAM_PGL_STUBS);
}

describe('checkedPath', () => {
  test('allows only the patchable files inside the source tree', () => {
    expect(checkedPath('/src', 'src/backend/libpq/pqcomm.c')).toBe(
      '/src/src/backend/libpq/pqcomm.c',
    );
    expect(checkedPath('/src', 'pglite-wasm/pg_main.c')).toBe('/src/pglite-wasm/pg_main.c');
    expect(() => checkedPath('/src', 'src/backend/other.c')).toThrow('unexpected relative path');
    expect(() => checkedPath('/src', '/etc/passwd')).toThrow('unexpected relative path');
  });
});

describe('source argument', () => {
  test('requires exactly one source directory', async () => {
    expect(() => parseSourceArgs([])).toThrow('usage');
    expect(() => parseSourceArgs(['a', 'b'])).toThrow('usage');
    expect(parseSourceArgs(['-h'])).toEqual({ help: true });
    expect(parseSourceArgs(['src'])).toEqual({ help: false, source: 'src' });
    await expect(resolveSourceDir('/does/not/exist', '/does')).rejects.toThrow('does not exist');
    await expect(resolveSourceDir('../../etc', '/does/not', '/does/not/exist')).rejects.toThrow(
      'outside',
    );
    expect(engineRoot('/pkg')).toBe('/pkg/target/engine');
  });
});

describe('patchEngineSource', () => {
  test('applies all three patches with exact C bytes and is stable on re-run', async () => {
    // The generated C must keep the backslash-escaped `$user` search_path.
    expect(INITDB_DEFAULTS_NEW).toContain('search_path=\\"$user\\"');
    expect(SESSION_DEFAULTS_BLOCK).toContain('SetConfigOption("search_path", "\\"$user\\"');

    const source = await mkdtemp(join(tmpdir(), 'df-pglite-patch-test.'));
    try {
      await mkdir(join(source, 'src/backend/libpq'), { recursive: true });
      await mkdir(join(source, 'pglite-wasm'), { recursive: true });
      await Bun.write(
        join(source, 'src/backend/libpq/pqcomm.c'),
        'static int\ninternal_putbytes(const char *s, size_t len) { return 0; }\nstatic int\nsocket_flush() { return 0; }',
      );
      const backend = [
        '     void pgl_backend() {',
        '  "-F", "-O", "-j",',
        '  x();',
        '  "-F", "-O", "-j",',
        '  backend_started:; rest',
      ].join('\n');
      await Bun.write(join(source, 'pglite-wasm/pg_main.c'), backend);

      await patchEngineSource(source, pkgDir);
      const replyBuffer = await Bun.file(join(pkgDir, 'engine', 'reply-buffer.c')).text();
      const patchedPqcomm = await Bun.file(join(source, 'src/backend/libpq/pqcomm.c')).text();
      expect(patchedPqcomm).toContain(replyBuffer.trim().slice(0, 64));

      const patchedMain = await Bun.file(join(source, 'pglite-wasm/pg_main.c')).text();
      expect(patchedMain).not.toContain('"-F", "-O", "-j",');
      expect(patchedMain).toContain('"-c", "fsync=on",');
      expect(patchedMain).toContain('/* di-framework: application session defaults */');

      const once = `${patchedPqcomm}\n${patchedMain}`;
      await patchEngineSource(source, pkgDir);
      const twicePqcomm = await Bun.file(join(source, 'src/backend/libpq/pqcomm.c')).text();
      const twiceMain = await Bun.file(join(source, 'pglite-wasm/pg_main.c')).text();
      expect(`${twicePqcomm}\n${twiceMain}`).toBe(once);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});

describe('insertOnce', () => {
  test('inserts around a unique anchor once and refuses ambiguous anchors', () => {
    expect(insertOnce('a X b', 'X', '+', 'after', 'f')).toBe('a X+ b');
    expect(insertOnce('a X b', 'X', '+', 'before', 'f')).toBe('a +X b');
    expect(insertOnce('a X+ b', 'X', '+', 'after', 'f')).toBe('a X+ b');
    expect(() => insertOnce('a b', 'X', '+', 'after', 'f')).toThrow('expected 1 patch anchor');
    expect(() => insertOnce('X X', 'X', '+', 'after', 'f')).toThrow('found 2');
  });
});

describe('patchPgcrypto', () => {
  test('wires the pgcrypto build, link and dlsym hooks idempotently', async () => {
    const source = await mkdtemp(join(tmpdir(), 'df-pglite-pgcrypto-test.'));
    try {
      await mkdir(join(source, 'wasm-build/sdk_port-wasi'), { recursive: true });
      await mkdir(join(source, 'pglite-wasm'), { recursive: true });
      await Bun.write(
        join(source, 'wasm-build/build-ext.sh'),
        'if $WASI\nthen\n    SKIP="pgcrypto"\n    SKIP_CONTRIB=true\nelse\n    SKIP=""\nfi\n',
      );
      await Bun.write(
        join(source, 'pglite-wasm/build.sh'),
        [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text for the upstream build recipe, not a TS template.
          '             ${PG_BUILD}/${BUILD}/src/pl/plpgsql/src/libplpgsql.a \\',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text for the upstream build recipe, not a TS template.
          '             -lxml2 -lz ${LINK_SETJMP:-}',
          '',
        ].join('\n'),
      );
      await Bun.write(
        join(source, 'wasm-build/sdk_port-wasi/sdk_port-wasi-dlfcn.c'),
        UPSTREAM_DLFCN,
      );
      await mkdir(join(source, 'contrib/pgcrypto'), { recursive: true });
      await Bun.write(join(source, 'contrib/pgcrypto/pgp-cfb.c'), UPSTREAM_PGP_CFB);
      const openssl = join(source, 'openssl-test.tar.gz');
      await Bun.write(openssl, 'tarball bytes');

      await patchPgcrypto(source, pkgDir, openssl);
      const read = async () =>
        Promise.all(
          [
            'wasm-build/build-ext.sh',
            'pglite-wasm/build.sh',
            'wasm-build/sdk_port-wasi/sdk_port-wasi-dlfcn.c',
            'contrib/pgcrypto/pgp-cfb.c',
          ].map((f) => Bun.file(join(source, f)).text()),
        );
      const once = await read();
      const [ext = '', link = '', dlfcn = '', cfb = ''] = once;
      // pgcrypto's PGP CFB mode is left exactly as upstream ships it.
      expect(cfb).toBe(UPSTREAM_PGP_CFB);
      expect(ext).toContain(`${EXT_PGCRYPTO_HOOK}    SKIP_CONTRIB=true\nelse\n`);
      expect(link).toContain(`libplpgsql.a \\\n${LINK_PGCRYPTO}`);
      expect(dlfcn).toContain('extern void *df_ext_dlsym(const char *symbol);');
      expect(dlfcn).toContain(`    dict_t tab = NULL;\n${DLOPEN_HOOK_NOTE}${DLOPEN_HOOK}`);
      expect(dlfcn).toContain(`    void *sym = NULL;\n${DLSYM_HOOK}`);
      expect(dlfcn.indexOf('df_ext_dlopen(const char')).toBeLessThan(
        dlfcn.indexOf('dlopen(const char *filename, int'),
      );
      expect(dlfcn).toContain(DLTAB_DECL_NEW);
      expect(dlfcn).not.toContain('dltab[];');
      expect(await Bun.file(join(source, 'df-extensions/openssl.tar.gz')).text()).toBe(
        'tarball bytes',
      );
      expect(await Bun.file(join(source, 'df-extensions/build-pgcrypto.sh')).text()).toBe(
        await Bun.file(join(pkgDir, 'engine/build-pgcrypto.sh')).text(),
      );

      await patchPgcrypto(source, pkgDir, openssl);
      expect(await read()).toEqual(once);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});

describe('requirePgpCfbFix', () => {
  test('accepts PostgreSQL 17.11 pgp-cfb.c as upstream ships it', () => {
    expect(UPSTREAM_PGP_CFB).toContain(PGP_CFB_ENCRYPT_CALL);
    expect(UPSTREAM_PGP_CFB).toContain(PGP_CFB_ERROR_CHECK);
    expect(() => requirePgpCfbFix(UPSTREAM_PGP_CFB)).not.toThrow();
  });

  test('accepts the error check without the comment above it', () => {
    const bare = UPSTREAM_PGP_CFB.replace(/\n\t\t\/\*\n\t\t \* XXX Ignoring[\s\S]*?\*\/\n/, '');
    expect(bare).not.toContain('XXX Ignoring');
    expect(() => requirePgpCfbFix(bare)).not.toThrow();
  });

  const missing =
    'pgp-cfb.c: the PGP CFB cipher error check (PostgreSQL 17.11, CVE-2026-14663) is missing';

  test('refuses a base whose PGP CFB mode ignores cipher failures', () => {
    expect(() => requirePgpCfbFix(UNFIXED_PGP_CFB)).toThrow(missing);
  });

  test('refuses a base that keeps the encrypt result but never checks it', () => {
    const unchecked = editedPgpCfb(PGP_CFB_ERROR_CHECK, '\t\tif (0)\n\t\t\tereport(ERROR,\n');
    expect(unchecked).toContain(PGP_CFB_ENCRYPT_CALL);
    expect(() => requirePgpCfbFix(unchecked)).toThrow(missing);
  });

  test('refuses a base whose error check does not directly follow the encrypt call', () => {
    const late = editedPgpCfb(PGP_CFB_ERROR_CHECK, `\t\terr = 0;\n${PGP_CFB_ERROR_CHECK}`);
    expect(() => requirePgpCfbFix(late)).toThrow(missing);
  });

  test('refuses a base with a second, unchecked encrypt call', () => {
    const loop = '\twhile (len > 0 && ctx->pos > 0)\n';
    const twice = editedPgpCfb(
      loop,
      `\tpx_cipher_encrypt(ctx->ciph, 0, ctx->fr, ctx->block_size, ctx->fre, NULL);\n\n${loop}`,
    );
    expect(() => requirePgpCfbFix(twice)).toThrow(missing);
  });

  test('refuses a second, unchecked encrypt call written with a space before its parenthesis', () => {
    const loop = '\twhile (len > 0 && ctx->pos > 0)\n';
    const spaced = editedPgpCfb(
      loop,
      `\tpx_cipher_encrypt (ctx->ciph, 0, ctx->fr, ctx->block_size, ctx->fre, NULL);\n\n${loop}`,
    );
    expect(() => requirePgpCfbFix(spaced)).toThrow('1 of 2 px_cipher_encrypt calls recognised');
  });

  test('refuses a pgp_cfb_encrypt with an earlier cfb_process call that ignores failures', () => {
    const mix = '\tmix_data_t\tmix = ctx->resync ? mix_encrypt_resync : mix_encrypt_normal;\n';
    const early = editedPgpCfb(
      mix,
      `${mix}\n\tif (ctx->resync)\n\t\treturn cfb_process(ctx, data, len, dst, mix, 1);\n`,
    );
    expect(() => requirePgpCfbFix(early)).toThrow(
      'pgp_cfb_encrypt may ignore cipher failures (PostgreSQL 17.11, CVE-2026-14663)',
    );
  });

  test('accepts the fix with CRLF line endings', () => {
    expect(() => requirePgpCfbFix(UPSTREAM_PGP_CFB.replace(/\n/g, '\r\n'))).not.toThrow();
  });

  test('accepts the fix re-indented with spaces', () => {
    expect(() => requirePgpCfbFix(UPSTREAM_PGP_CFB.replace(/\t/g, '    '))).not.toThrow();
  });

  test('accepts // and /* */ comments between the encrypt call and its error check', () => {
    const commented = editedPgpCfb(
      PGP_CFB_ERROR_CHECK,
      `\t\t// keep the result\n\t\t/* and check it */\n${PGP_CFB_ERROR_CHECK}`,
    );
    expect(() => requirePgpCfbFix(commented)).not.toThrow();
  });

  test('does not count an encrypt call that only appears in a comment', () => {
    const noted = editedPgpCfb(
      PGP_CFB_ERROR_CHECK,
      `\t\t// px_cipher_encrypt(ctx->ciph, ...) result is checked below\n${PGP_CFB_ERROR_CHECK}`,
    );
    expect(() => requirePgpCfbFix(noted)).not.toThrow();
  });

  // #513: the C a compiler would see, not the text, decides. Each case below
  // was accepted by the #504 checker although the compiled code lacks the fix.
  const loop = '\twhile (len > 0 && ctx->pos > 0)\n';
  const mix = '\tmix_data_t\tmix = ctx->resync ? mix_encrypt_resync : mix_encrypt_normal;\n';
  const encryptReturn =
    '\treturn cfb_process(ctx, data, len, dst, mix,\n\t\t\t\t\t   0 /* never ignore cipher failures for encrypt */ );\n}';
  const ignoring = 'pgp_cfb_encrypt may ignore cipher failures (PostgreSQL 17.11, CVE-2026-14663)';

  test('S1: refuses an error check commented out by // comments continued with a backslash', () => {
    const fullCheck =
      '\t\tif (err && !ignore_cipher_failure)\n\t\t\tereport(ERROR,\n\t\t\t\t\t(errcode(ERRCODE_EXTERNAL_ROUTINE_INVOCATION_EXCEPTION),\n\t\t\t\t\t errmsg("encrypt error: %s", px_strerror(err))));\n';
    const spliced = editedPgpCfb(
      fullCheck,
      '\t\t// spliced \\\n\t\tif (err && !ignore_cipher_failure) // \\\n\t\t\tereport(ERROR, // \\\n\t\t\t\t\t(errcode(ERRCODE_EXTERNAL_ROUTINE_INVOCATION_EXCEPTION), // \\\n\t\t\t\t\t errmsg("encrypt error: %s", px_strerror(err))));\n',
    );
    expect(() => requirePgpCfbFix(spliced)).toThrow(missing);
    // Without the comments, a continuation is only layout.
    const continued = editedPgpCfb(
      PGP_CFB_ERROR_CHECK,
      '\t\tif (err && \\\n!ignore_cipher_failure)\n\t\t\tereport(ERROR,\n',
    );
    expect(() => requirePgpCfbFix(continued)).not.toThrow();
  });

  test('S2: refuses an unchecked encrypt call between comment markers inside string literals', () => {
    const hidden = editedPgpCfb(
      loop,
      `\telog(DEBUG1, "/*");\n\tpx_cipher_encrypt(ctx->ciph, 0, ctx->fr, ctx->block_size, ctx->fre, NULL);\n\telog(DEBUG1, "*/");\n${loop}`,
    );
    expect(() => requirePgpCfbFix(hidden)).toThrow('1 of 2 px_cipher_encrypt calls recognised');
    // Comment markers in literals are text, so they cut nothing either.
    const literals = editedPgpCfb(loop, `\telog(DEBUG1, "http://x /*", '"', '\\'');\n${loop}`);
    expect(() => requirePgpCfbFix(literals)).not.toThrow();
  });

  test('S3: refuses an encrypt call assigned to another variable whose name ends in err', () => {
    const myerr = editedPgpCfb(
      PGP_CFB_ENCRYPT_CALL,
      PGP_CFB_ENCRYPT_CALL.replace('err =', 'myerr ='),
    );
    expect(() => requirePgpCfbFix(myerr)).toThrow('0 of 1 px_cipher_encrypt calls recognised');
    const member = editedPgpCfb(
      PGP_CFB_ENCRYPT_CALL,
      PGP_CFB_ENCRYPT_CALL.replace('err =', 'ctx->err ='),
    );
    expect(() => requirePgpCfbFix(member)).toThrow('0 of 1 px_cipher_encrypt calls recognised');
  });

  test('S3: inspects pgp_cfb_encrypt, not an earlier function whose name ends in pgp_cfb_encrypt', () => {
    const decoy = editedPgpCfb(
      'int\npgp_cfb_encrypt(',
      'static int\nold_pgp_cfb_encrypt(PGP_CFB *ctx)\n{\n\treturn cfb_process(ctx, NULL, 0, NULL, NULL, 0);\n}\n\nint\npgp_cfb_encrypt(',
    );
    expect(() => requirePgpCfbFix(decoy)).not.toThrow();
    const ignored = decoy.replace(
      encryptReturn,
      '\treturn cfb_process(ctx, data, len, dst, mix, 1);\n}',
    );
    expect(ignored).not.toBe(decoy);
    expect(() => requirePgpCfbFix(ignored)).toThrow(ignoring);
  });

  test('S4: checks the last argument of each cfb_process call, not of the expression around it', () => {
    const comma = editedPgpCfb(
      encryptReturn,
      '\treturn (cfb_process(ctx, data, len, dst, mix, 1), 0);\n}',
    );
    expect(() => requirePgpCfbFix(comma)).toThrow(ignoring);
    const sum = editedPgpCfb(
      encryptReturn,
      '\treturn cfb_process(ctx, data, len, dst, mix, 1) + cfb_process(ctx, data, 0, dst, mix, 0);\n}',
    );
    expect(() => requirePgpCfbFix(sum)).toThrow(ignoring);
    // Nested calls and commas inside an argument are part of that argument.
    const nested = editedPgpCfb(
      encryptReturn,
      '\treturn cfb_process(ctx, f(data, 1), len, dst, mix, 0);\n}',
    );
    expect(() => requirePgpCfbFix(nested)).not.toThrow();
  });

  test('S5: inspects all of pgp_cfb_encrypt, past its first nested block', () => {
    const later = editedPgpCfb(
      mix,
      `${mix}\tif (ctx->resync)\n\t{\n\t\treturn cfb_process(ctx, data, len, dst, mix, 0);\n\t}\n\tif (len)\n\t\treturn cfb_process(ctx, data, len, dst, mix, 1);\n`,
    );
    expect(() => requirePgpCfbFix(later)).toThrow(ignoring);
    const guarded = editedPgpCfb(mix, `${mix}\tif (len == 0)\n\t{\n\t\treturn 0;\n\t}\n`);
    expect(() => requirePgpCfbFix(guarded)).not.toThrow();
  });

  test('W1: splices a backslash followed by spaces or tabs before the newline', () => {
    const fullCheck =
      '\t\tif (err && !ignore_cipher_failure)\n\t\t\tereport(ERROR,\n\t\t\t\t\t(errcode(ERRCODE_EXTERNAL_ROUTINE_INVOCATION_EXCEPTION),\n\t\t\t\t\t errmsg("encrypt error: %s", px_strerror(err))));\n';
    const spliced = editedPgpCfb(
      fullCheck,
      '\t\t// see below \\ \n\t\tif (err && !ignore_cipher_failure) // \\ \n\t\t\tereport(ERROR, // \\\t\n\t\t\t\t\t(errcode(ERRCODE_EXTERNAL_ROUTINE_INVOCATION_EXCEPTION), // \\ \r\n\t\t\t\t\t errmsg("encrypt error: %s", px_strerror(err))));\n',
    );
    expect(() => requirePgpCfbFix(spliced)).toThrow(missing);
  });

  test('W2: refuses a $ decoy name and a parenthesised pgp_cfb_encrypt definition', () => {
    const header = 'int\npgp_cfb_encrypt(';
    const decoy = editedPgpCfb(
      header,
      'static int\nold$pgp_cfb_encrypt(PGP_CFB *ctx)\n{\n\treturn cfb_process(ctx, NULL, 0, NULL, NULL, 0);\n}\n\nint\n(pgp_cfb_encrypt)(',
    ).replace(encryptReturn, '\treturn cfb_process(ctx, data, len, dst, mix, 1);\n}');
    expect(() => requirePgpCfbFix(decoy)).toThrow(ignoring);
    // `old$pgp_cfb_encrypt` is one identifier, not a definition of pgp_cfb_encrypt.
    const dollar = editedPgpCfb(
      header,
      'static int\nold$pgp_cfb_encrypt(PGP_CFB *ctx)\n{\n\treturn cfb_process(ctx, NULL, 0, NULL, NULL, 1);\n}\n\nint\npgp_cfb_encrypt(',
    );
    expect(() => requirePgpCfbFix(dollar)).not.toThrow();
  });

  test('W3: reads digraphs as the brackets they spell', () => {
    const digraph = editedPgpCfb(
      mix,
      `${mix}\n\tif (len == 0) <% return cfb_process(ctx, data, len, dst, mix, 0); }\n\treturn cfb_process(ctx, data, len, dst, mix, 1);\n}\nstatic int\nunused(void)\n{\n`,
    );
    expect(() => requirePgpCfbFix(digraph)).toThrow(ignoring);
    const balanced = editedPgpCfb(mix, `${mix}\tif (len == 0) <% return 0; %>\n`);
    expect(() => requirePgpCfbFix(balanced)).not.toThrow();
  });

  test('refuses preprocessor conditionals inside pgp_cfb_encrypt', () => {
    for (const directive of ['#if 0', '#ifdef X', '#ifndef X', '%:if 0']) {
      const conditional = editedPgpCfb(mix, `${mix}${directive}\n\t}\n#endif\n`);
      expect(() => requirePgpCfbFix(conditional)).toThrow(ignoring);
    }
  });

  test('refuses truncated input with an unclosed bracket', () => {
    const call = 'return cfb_process(ctx, data, len, dst, mix,';
    const cut = UPSTREAM_PGP_CFB.indexOf(call);
    expect(cut).toBeGreaterThan(0);
    const truncated = UPSTREAM_PGP_CFB.slice(0, cut + 'return cfb_process(ctx, data'.length);
    expect(() => requirePgpCfbFix(truncated)).toThrow(ignoring);
  });

  test('names what to inspect when the expected pattern is not recognised', () => {
    expect(() => requirePgpCfbFix(UNFIXED_PGP_CFB)).toThrow(
      'not in the expected pattern (0 of 1 px_cipher_encrypt calls recognised as checked)',
    );
    expect(() => requirePgpCfbFix(UNFIXED_PGP_CFB)).toThrow(
      'inspect cfb_process and pgp_cfb_encrypt in contrib/pgcrypto/pgp-cfb.c',
    );
  });

  test('refuses a base whose encrypt path may ignore cipher failures', () => {
    const ignoring = editedPgpCfb(
      '0 /* never ignore cipher failures for encrypt */ );',
      'ctx->ignore_decrypt_cipher_failure);',
    );
    expect(() => requirePgpCfbFix(ignoring)).toThrow(
      'pgp-cfb.c: pgp_cfb_encrypt may ignore cipher failures (PostgreSQL 17.11, CVE-2026-14663)',
    );
  });

  test('patchPgcryptoSources stops on an unfixed pgcrypto', async () => {
    const source = await mkdtemp(join(tmpdir(), 'df-pglite-cfb-test.'));
    try {
      await writePgcryptoInputs(source);
      await Bun.write(join(source, 'contrib/pgcrypto/pgp-cfb.c'), UNFIXED_PGP_CFB);
      await expect(patchPgcryptoSources(source)).rejects.toThrow('CVE-2026-14663');
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});

describe('frontend glue', () => {
  test('renames the frontend SplitGUCList only around the initdb include', () => {
    const out = patchInitdbInclude(UPSTREAM_PGL_INITDB);
    expect(out).toContain(INITDB_INCLUDE_NEW);
    expect(out.indexOf('#define SplitGUCList')).toBeLessThan(out.indexOf(INITDB_INCLUDE));
    expect(out.indexOf('#undef SplitGUCList')).toBeGreaterThan(out.indexOf(INITDB_INCLUDE));
    expect(out.split(INITDB_INCLUDE)).toHaveLength(2);
    expect(patchInitdbInclude(out)).toBe(out);
    expect(() => patchInitdbInclude('#include "initdb.c"\n')).toThrow(
      'pgl_initdb.c: expected 1 patch anchor, found 0',
    );
  });

  test('adds overflow-checked pg_malloc_mul and pg_realloc_mul after pg_realloc', () => {
    const out = patchFrontendStubs(UPSTREAM_PGL_STUBS);
    expect(out).toContain(`${STUBS_REALLOC_ANCHOR}${STUBS_MUL_HELPERS}`);
    expect(STUBS_MUL_HELPERS).toContain('pg_malloc_mul(size_t s1, size_t s2) {');
    expect(STUBS_MUL_HELPERS).toContain('pg_realloc_mul(void *ptr, size_t s1, size_t s2) {');
    // fe_memutils.c's limits: no wrap-around and nothing above SIZE_MAX / 2.
    expect(STUBS_MUL_HELPERS).toContain(
      '__builtin_mul_overflow(s1, s2, &req) || req > (SIZE_MAX / 2)',
    );
    expect(patchFrontendStubs(out)).toBe(out);
    expect(() => patchFrontendStubs(UPSTREAM_PGL_STUBS.replace(STUBS_REALLOC_ANCHOR, ''))).toThrow(
      'pgl_stubs.h: expected 1 patch anchor, found 0',
    );
  });

  test('patchFrontendGlue edits both files in place, idempotently', async () => {
    const source = await mkdtemp(join(tmpdir(), 'df-pglite-glue-test.'));
    try {
      await writePgcryptoInputs(source);
      await patchFrontendGlue(source);
      const read = () =>
        Promise.all(
          ['pglite-wasm/pgl_initdb.c', 'pglite-wasm/pgl_stubs.h'].map((f) =>
            Bun.file(join(source, f)).text(),
          ),
        );
      const once = await read();
      expect(once).toEqual([
        patchInitdbInclude(UPSTREAM_PGL_INITDB),
        patchFrontendStubs(UPSTREAM_PGL_STUBS),
      ]);
      await patchFrontendGlue(source);
      expect(await read()).toEqual(once);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});

describe('replaceOnce', () => {
  test('replaces a unique anchor once and refuses missing or ambiguous anchors', () => {
    expect(replaceOnce('a X b', 'X', 'Y', 'f')).toBe('a Y b');
    expect(replaceOnce('a Y b', 'X', 'Y', 'f')).toBe('a Y b');
    // `$&` in a replacement is literal text, not a back-reference.
    expect(replaceOnce('a X b', 'X', '$&$&', 'f')).toBe('a $&$& b');
    expect(() => replaceOnce('a b', 'X', 'Y', 'f')).toThrow('expected 1 patch anchor, found 0');
    expect(() => replaceOnce('X X', 'X', 'Y', 'f')).toThrow('found 2');
  });
});

describe('patchDlfcn', () => {
  const dlopenBody = (text: string): string => {
    const start = text.indexOf('dlopen(const char *filename, int flags) {');
    return text.slice(start, text.indexOf('\n}\n', start) + 1);
  };

  test('bounds the dlopen table and keeps the static-extension hook ahead of it', () => {
    const out = patchDlfcn(UPSTREAM_DLFCN);
    expect(out).toContain(DLTAB_DECL_NEW);
    expect(out).toContain(DLTAB_LOOKUP_NEW);
    expect(out).toContain(DLTAB_INSERT_NEW);
    expect(out).toContain(DLERROR_NEW);
    // No one-element table and no store past the last entry.
    expect(out).not.toContain('dltab[];');
    expect(out).not.toContain('dltab[dltab_index] = tab;');
    expect(out).toContain('dltab[dltab_index++] = tab;');
    expect(out).toContain('if (dltab_index >= DF_DLTAB_MAX)\n        return NULL;');

    const body = dlopenBody(out);
    const note = body.indexOf(DLOPEN_HOOK_NOTE);
    const hook = body.indexOf(DLOPEN_HOOK);
    const lookup = body.indexOf(DLTAB_LOOKUP_NEW);
    const insert = body.indexOf(DLTAB_INSERT_NEW);
    expect(note).toBeGreaterThan(0);
    expect(hook).toBe(note + DLOPEN_HOOK_NOTE.length);
    expect(lookup).toBeGreaterThan(hook);
    expect(insert).toBeGreaterThan(lookup);
  });

  test('is idempotent and upgrades a tree patched without the table fix', () => {
    const once = patchDlfcn(UPSTREAM_DLFCN);
    expect(patchDlfcn(once)).toBe(once);

    // A checkout patched before the table fix carries the hooks but no note.
    let older = insertOnce(UPSTREAM_DLFCN, 'void *\ndlopen(', DLFCN_DECLS, 'before', 'f');
    older = insertOnce(older, '    dict_t tab = NULL;\n', DLOPEN_HOOK, 'after', 'f');
    older = insertOnce(older, '    void *sym = NULL;\n', DLSYM_HOOK, 'after', 'f');
    const upgraded = patchDlfcn(older);
    expect(upgraded).toBe(once);
    expect(upgraded.split(DLOPEN_HOOK).length - 1).toBe(1);
  });

  test('refuses sources whose anchors moved', () => {
    expect(() => patchDlfcn(UPSTREAM_DLFCN.replace('volatile dict_t* dltab[];', 'x'))).toThrow(
      'expected 1 patch anchor, found 0',
    );
    expect(() =>
      patchDlfcn(UPSTREAM_DLFCN.replace('    return (char *)dlerror;\n', '    return 0;\n')),
    ).toThrow('expected 1 patch anchor, found 0');
  });

  test('refuses a layout where the dltab lookup would run before the hook', () => {
    // The hook goes right after dlopen's first statement; if upstream moves
    // its table lookup ahead of that statement, the hook anchor is gone.
    const lookup = [
      '    for (int i=0; i< dltab_index; i++) {',
      '        if ( dict_find_index(dltab[i], filename) > 0 )',
      '            return (void *)i;',
      '    }',
      '',
    ].join('\n');
    const moved = UPSTREAM_DLFCN.replace(lookup, '').replace(
      'dlopen(const char *filename, int flags) {\n',
      `dlopen(const char *filename, int flags) {\n${lookup}`,
    );
    expect(() => patchDlfcn(moved)).toThrow('expected 1 patch anchor, found 0');
  });
});

describe('patch', () => {
  /** A package dir whose engine root holds a minimal patchable source tree. */
  async function fixture(): Promise<{ pkg: string; source: string; files: string[] }> {
    const pkg = await mkdtemp(join(tmpdir(), 'df-pglite-patch-cmd.'));
    const source = join(engineRoot(pkg), 'src');
    await mkdir(join(pkg, 'engine'), { recursive: true });
    for (const file of ['reply-buffer.c', 'build-pgcrypto.sh']) {
      await Bun.write(join(pkg, 'engine', file), Bun.file(join(pkgDir, 'engine', file)));
    }
    await mkdir(join(source, 'src/backend/libpq'), { recursive: true });
    await mkdir(join(source, 'pglite-wasm'), { recursive: true });
    await Bun.write(
      join(source, 'src/backend/libpq/pqcomm.c'),
      `${PQCOMM_FALLBACK_START} return 0; }${PQCOMM_END}() { return 0; }`,
    );
    await Bun.write(
      join(source, 'pglite-wasm/pg_main.c'),
      `${PG_BACKEND_START} {\n${PG_BACKEND_END} rest`,
    );
    return { pkg, source, files: ['src/backend/libpq/pqcomm.c', 'pglite-wasm/pg_main.c'] };
  }

  async function context(pkg: string, env: Record<string, string>): Promise<Context> {
    return {
      pkgDir: pkg,
      tools: await loadTools(pkgDir, {}),
      toolsEnv: { PATH: '', RUSTFLAGS: '', DF_PGLITE_TOOLS_DIR: '', DF_PGLITE_ENV_LOADED: '' },
      env,
    };
  }

  const snapshot = (source: string, files: string[]): Promise<string[]> =>
    Promise.all(files.map((f) => Bun.file(join(source, f)).text()));

  test('refuses to run without the OpenSSL tarball and leaves the source alone', async () => {
    const { pkg, source, files } = await fixture();
    try {
      const before = await snapshot(source, files);
      await expect(patch(await context(pkg, {}), [source])).rejects.toThrow(
        'DF_PGLITE_OPENSSL_TARBALL is not set',
      );
      expect(await snapshot(source, files)).toEqual(before);
    } finally {
      await rm(pkg, { recursive: true, force: true });
    }
  });

  test('refuses an OpenSSL tarball outside the engine root and leaves the source alone', async () => {
    const { pkg, source, files } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'df-pglite-openssl.'));
    try {
      const tarball = join(outside, 'openssl.tar.gz');
      await Bun.write(tarball, 'tarball bytes');
      const before = await snapshot(source, files);
      // Elsewhere, a sibling of the engine root reached through `..`, and the root itself.
      for (const path of [
        tarball,
        join(engineRoot(pkg), '..', 'openssl.tar.gz'),
        engineRoot(pkg),
      ]) {
        const ctx = await context(pkg, { DF_PGLITE_OPENSSL_TARBALL: path });
        await expect(patch(ctx, [source])).rejects.toThrow('refusing OpenSSL source outside');
      }
      expect(await snapshot(source, files)).toEqual(before);
    } finally {
      await rm(pkg, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('patches the source once the tarball is inside the engine root', async () => {
    const { pkg, source, files } = await fixture();
    try {
      await writePgcryptoInputs(source);
      const tarball = join(engineRoot(pkg), 'openssl-test.tar.gz');
      await Bun.write(tarball, 'tarball bytes');
      await patch(await context(pkg, { DF_PGLITE_OPENSSL_TARBALL: tarball }), [source]);
      const [pqcomm = '', main = ''] = await snapshot(source, files);
      expect(pqcomm).toContain('di-framework');
      expect(main).toContain('/* di-framework: application session defaults */');
      expect(await Bun.file(join(source, 'pglite-wasm/pgl_initdb.c')).text()).toContain(
        '#define SplitGUCList df_frontend_SplitGUCList',
      );
      expect(await Bun.file(join(source, 'pglite-wasm/pgl_stubs.h')).text()).toContain(
        'pg_malloc_mul(size_t s1, size_t s2) {',
      );
      expect(await Bun.file(join(source, 'df-extensions/openssl.tar.gz')).text()).toBe(
        'tarball bytes',
      );
    } finally {
      await rm(pkg, { recursive: true, force: true });
    }
  });

  test('rejects bad arguments and prints usage for --help', async () => {
    const { pkg, source } = await fixture();
    try {
      const ctx = await context(pkg, {});
      await expect(patch(ctx, [])).rejects.toThrow('usage');
      await expect(patch(ctx, ['/elsewhere'])).rejects.toThrow('outside');
      const printed: unknown[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        printed.push(...args);
      };
      try {
        await patch(ctx, ['--help']);
      } finally {
        console.error = original;
      }
      expect(String(printed[0])).toContain('usage: patch-engine-source.ts');
      expect(await Bun.file(join(source, 'pglite-wasm/pg_main.c')).text()).not.toContain(
        'di-framework',
      );
    } finally {
      await rm(pkg, { recursive: true, force: true });
    }
  });
});
