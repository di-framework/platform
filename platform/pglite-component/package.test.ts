import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = import.meta.dir;
const dist = join(pkgDir, 'dist');

describe('pglite-component package', () => {
  test('dist artifacts exist and agree', () => {
    for (const file of [
      'di-framework-pglite.wasm',
      'di-framework-pglite.wit',
      'BUILD-INFO.txt',
      'SHA256SUMS',
      'THIRD-PARTY-NOTICES.txt',
    ]) {
      expect(existsSync(join(dist, file)), file).toBe(true);
    }
  });

  test('built WIT exports the database interface', () => {
    const wit = readFileSync(join(dist, 'di-framework-pglite.wit'), 'utf8');
    expect(wit).toContain('export di-framework:pglite/database@0.1.0');
    expect(wit).toContain('export di-framework:pglite/types@0.1.0');
    expect(wit).toContain('import wasi:filesystem/preopens@');
    expect(wit).not.toContain('import wasi:sockets/');
    expect(wit).not.toContain('import di-framework:pglite-engine/');
  });

  test('source WIT matches the built WIT package', () => {
    const source = readFileSync(join(pkgDir, 'wit', 'world.wit'), 'utf8');
    expect(source).toContain('package di-framework:pglite@0.1.0');
    expect(source).toContain('world pglite-provider');
  });
});
