import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = import.meta.dir;
const dist = join(pkgDir, 'dist');

// `dist/` is gitignored and only produced by `make build` (Docker/Podman +
// GBs for the PostgreSQL WASI engine). Skip artifact checks when it is absent
// so contributors who did not touch this package still get green `bun test`.
// Strict in CI: `CI` forces the checks to run (and fail if `dist/` is missing).
const built = existsSync(join(dist, 'di-framework-pglite.wasm')) || !!process.env.CI;

describe('pglite-component package', () => {
  test.skipIf(!built)('dist artifacts exist and agree', () => {
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

  test.skipIf(!built)('built WIT exports the database interface', () => {
    const wit = readFileSync(join(dist, 'di-framework-pglite.wit'), 'utf8');
    expect(wit).toContain('export di-framework:pglite/database@0.1.0');
    expect(wit).toContain('export di-framework:pglite/types@0.1.0');
    expect(wit).toContain('import wasi:filesystem/preopens@');
    expect(wit).not.toContain('import wasi:sockets/');
    expect(wit).not.toContain('import di-framework:pglite-engine/');
  });

  // Source-only: mirrors `sqlite-component` and always runs, even without a build.
  test('source WIT declares the database package', () => {
    const source = readFileSync(join(pkgDir, 'wit', 'world.wit'), 'utf8');
    expect(source).toContain('package di-framework:pglite@0.1.0');
    expect(source).toContain('world pglite-provider');
  });

  test('component sources exist', () => {
    for (const file of ['Makefile', 'Cargo.toml', 'wit/world.wit']) {
      expect(existsSync(join(pkgDir, file)), file).toBe(true);
    }
  });
});
