import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { patchEngineTree } from './check-engine-patch.ts';
import {
  INITDB_INCLUDE,
  LINK_PLPGSQL,
  PG_BACKEND_END,
  PG_BACKEND_START,
  PQCOMM_END,
  PQCOMM_FALLBACK_START,
  STUBS_REALLOC_ANCHOR,
} from './patch-engine-source.ts';

const pkgDir = resolve(import.meta.dir, '..');

/** pgcrypto's PGP CFB mode, verbatim from PostgreSQL REL_17_11. */
const UPSTREAM_PGP_CFB = await Bun.file(
  join(import.meta.dir, 'testdata/pgp-cfb-REL_17_11.c'),
).text();

/** The smallest tree that carries every anchor patch-engine-source.ts edits. */
async function engineTree(dir: string, pgpCfb: string): Promise<void> {
  const files: Record<string, string> = {
    'src/backend/libpq/pqcomm.c': `${PQCOMM_FALLBACK_START} return 0; }${PQCOMM_END}() { return 0; }`,
    'pglite-wasm/pg_main.c': `${PG_BACKEND_START} {\n${PG_BACKEND_END} rest`,
    'pglite-wasm/pgl_initdb.c': `/* glue */\n${INITDB_INCLUDE}`,
    'pglite-wasm/pgl_stubs.h': STUBS_REALLOC_ANCHOR,
    'pglite-wasm/build.sh': `             ${LINK_PLPGSQL}`,
    'wasm-build/build-ext.sh': 'if $WASI\nthen\n    SKIP_CONTRIB=true\nelse\n    SKIP=""\nfi\n',
    'wasm-build/sdk_port-wasi/sdk_port-wasi-dlfcn.c': [
      'volatile dict_t* dltab[];',
      'volatile int dltab_index = 0;',
      'char *',
      'dlerror(void) {',
      '    return (char *)dlerror;',
      '}',
      'void *',
      'dlopen(const char *filename, int flags) {',
      '    dict_t tab = NULL;',
      '    for (int i=0; i< dltab_index; i++) {',
      '        if ( dict_find_index(dltab[i], filename) > 0 )',
      '            return (void *)i;',
      '    }',
      '    tab = dict_new();',
      '    dict_add(tab, filename, dltab_index++ );',
      '    dltab[dltab_index] = tab;',
      '',
      '    return (void *)dltab_index;',
      '',
      '}',
      'void *',
      'dlsym(void *__restrict handle, const char *__restrict symbol) {',
      '    void *sym = NULL;',
      '    return sym;',
      '}',
      '',
    ].join('\n'),
    'contrib/pgcrypto/pgp-cfb.c': pgpCfb,
  };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await Bun.write(join(dir, name), text);
  }
}

describe('patchEngineTree', () => {
  test('runs every engine source edit on a tree that carries all anchors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-pglite-check-patch.'));
    try {
      await engineTree(dir, UPSTREAM_PGP_CFB);
      await patchEngineTree(dir, pkgDir);
      const read = (name: string) => Bun.file(join(dir, name)).text();
      expect(await read('pglite-wasm/pg_main.c')).toContain('application session defaults');
      expect(await read('pglite-wasm/pgl_initdb.c')).toContain('#undef SplitGUCList');
      expect(await read('pglite-wasm/pgl_stubs.h')).toContain('pg_realloc_mul(');
      expect(await read('pglite-wasm/build.sh')).toContain('libpgcrypto.a');
      expect(await read('wasm-build/sdk_port-wasi/sdk_port-wasi-dlfcn.c')).toContain(
        'DF_DLTAB_MAX',
      );
      // No copies: the quick check never needs the OpenSSL source.
      expect(await Bun.file(join(dir, 'df-extensions/openssl.tar.gz')).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fails on a base without the upstream pgcrypto fix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-pglite-check-patch.'));
    try {
      await engineTree(dir, '\tpx_cipher_encrypt(ctx->ciph, 0, ctx->fr, 8, ctx->fre, &rlen);\n');
      await expect(patchEngineTree(dir, pkgDir)).rejects.toThrow('CVE-2026-14663');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
