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
  insertOnce,
  LINK_PGCRYPTO,
  LINK_PLPGSQL,
  PG_BACKEND_END,
  PG_BACKEND_START,
  PGP_CFB_BLOCK_NEW,
  PGP_CFB_BLOCK_OLD,
  PGP_CFB_INIT_ANCHOR,
  PGP_CFB_PROBE,
  PQCOMM_END,
  PQCOMM_FALLBACK_START,
  parseSourceArgs,
  patch,
  patchDlfcn,
  patchEngineSource,
  patchPgcrypto,
  patchPgpCfb,
  replaceOnce,
  resolveSourceDir,
  SESSION_DEFAULTS_BLOCK,
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

/** pgcrypto's PGP CFB mode as PostgreSQL 17.5 ships it (abridged). */
const UPSTREAM_PGP_CFB = [
  'int',
  'pgp_cfb_create(PGP_CFB **ctx_p, int algo, const uint8 *key, int key_len,',
  '\t\t\t   int resync, uint8 *iv)',
  '{',
  '\tres = pgp_load_cipher(algo, &ciph);',
  '\tif (res < 0)',
  '\t\treturn res;',
  '',
  '\tres = px_cipher_init(ciph, key, key_len, NULL);',
  '\tif (res < 0)',
  '\t{',
  '\t\tpx_cipher_free(ciph);',
  '\t\treturn res;',
  '\t}',
  '',
  '\tctx = palloc0(sizeof(*ctx));',
  '\treturn 0;',
  '}',
  '',
  'static int',
  'cfb_process(PGP_CFB *ctx, const uint8 *data, int len, uint8 *dst,',
  '\t\t\tmix_data_t mix_data)',
  '{',
  '\twhile (len > 0)',
  '\t{',
  '\t\tunsigned\trlen;',
  '',
  '\t\tpx_cipher_encrypt(ctx->ciph, 0, ctx->fr, ctx->block_size, ctx->fre, &rlen);',
  '\t\tif (ctx->block_no < 5)',
  '\t\t\tctx->block_no++;',
  '\t}',
  '\treturn 0;',
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
      expect(cfb).toBe(patchPgpCfb(UPSTREAM_PGP_CFB));
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

describe('patchPgpCfb', () => {
  test('probes the cipher at create time and propagates block failures', () => {
    const out = patchPgpCfb(UPSTREAM_PGP_CFB);
    // The probe runs right after px_cipher_init and before the context exists.
    expect(out).toContain(`${PGP_CFB_INIT_ANCHOR}${PGP_CFB_PROBE}\n\tctx = palloc0`);
    expect(out).toContain(PGP_CFB_BLOCK_NEW);
    expect(out).not.toContain(PGP_CFB_BLOCK_OLD);
    expect(patchPgpCfb(out)).toBe(out);
  });

  test('refuses sources whose anchors moved', () => {
    expect(() => patchPgpCfb(UPSTREAM_PGP_CFB.replace(PGP_CFB_BLOCK_OLD, ''))).toThrow(
      'pgp-cfb.c: expected 1 patch anchor, found 0',
    );
    expect(() => patchPgpCfb(UPSTREAM_PGP_CFB.replace(PGP_CFB_INIT_ANCHOR, ''))).toThrow(
      'pgp-cfb.c: expected 1 patch anchor, found 0',
    );
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
