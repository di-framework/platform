import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkedPath,
  DLOPEN_HOOK,
  DLSYM_HOOK,
  EXT_PGCRYPTO_HOOK,
  engineRoot,
  INITDB_DEFAULTS_NEW,
  insertOnce,
  LINK_PGCRYPTO,
  parseSourceArgs,
  patchEngineSource,
  patchPgcrypto,
  resolveSourceDir,
  SESSION_DEFAULTS_BLOCK,
} from './patch-engine-source.ts';

const pkgDir = resolve(import.meta.dir, '..');

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
        [
          'extern void _PG_init(void);',
          '',
          'void *',
          'dlopen(const char *filename, int flags) {',
          '    dict_t tab = NULL;',
          '    return NULL;',
          '}',
          '',
          'void *',
          'dlsym(void *__restrict handle, const char *__restrict symbol) {',
          '    void *sym = NULL;',
          '    return sym;',
          '}',
          '',
        ].join('\n'),
      );
      const openssl = join(source, 'openssl-test.tar.gz');
      await Bun.write(openssl, 'tarball bytes');

      await patchPgcrypto(source, pkgDir, openssl);
      const read = async () =>
        Promise.all(
          [
            'wasm-build/build-ext.sh',
            'pglite-wasm/build.sh',
            'wasm-build/sdk_port-wasi/sdk_port-wasi-dlfcn.c',
          ].map((f) => Bun.file(join(source, f)).text()),
        );
      const once = await read();
      const [ext = '', link = '', dlfcn = ''] = once;
      expect(ext).toContain(`${EXT_PGCRYPTO_HOOK}    SKIP_CONTRIB=true\nelse\n`);
      expect(link).toContain(`libplpgsql.a \\\n${LINK_PGCRYPTO}`);
      expect(dlfcn).toContain('extern void *df_ext_dlsym(const char *symbol);');
      expect(dlfcn).toContain(`    dict_t tab = NULL;\n${DLOPEN_HOOK}`);
      expect(dlfcn).toContain(`    void *sym = NULL;\n${DLSYM_HOOK}`);
      expect(dlfcn.indexOf('df_ext_dlopen(const char')).toBeLessThan(
        dlfcn.indexOf('dlopen(const char *filename, int'),
      );
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
