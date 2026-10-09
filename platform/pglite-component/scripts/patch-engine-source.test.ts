import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkedPath,
  engineRoot,
  INITDB_DEFAULTS_NEW,
  parseSourceArgs,
  patchEngineSource,
  resolveSourceDir,
  SESSION_DEFAULTS_BLOCK,
} from './patch-engine-source.ts';

const pkgDir = resolve(import.meta.dir, '..');

describe('checkedPath', () => {
  test('allows only the two patchable files inside the source tree', () => {
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
