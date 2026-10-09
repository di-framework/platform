import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = import.meta.dir;
const dist = join(pkgDir, 'dist');

// `dist/` is gitignored and only produced by `make build` (Docker/Podman +
// GBs for the PostgreSQL WASI engine). Skip artifact checks when it is absent
// so contributors who did not touch this package still get green `bun test`.
// Jobs that build this component set PGLITE_REQUIRE_DIST=1 to require artifacts.
const built =
  existsSync(join(dist, 'di-framework-pglite.wasm')) || process.env.PGLITE_REQUIRE_DIST === '1';

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

  // Build scripts are Bun TypeScript (testable, auto-escaped shell). Guard the
  // migration: every build script must exist as .ts and no .sh/.py may remain.
  test('build scripts are TypeScript', () => {
    const scripts = join(pkgDir, 'scripts');
    const names = readdirSync(scripts);
    for (const file of [
      'lib.ts',
      'env.ts',
      'install-tools.ts',
      'build.ts',
      'build-engine.ts',
      'patch-engine-source.ts',
      'prepare-engine.ts',
      'compose.ts',
      'smoke.ts',
      'check.ts',
      'wit.ts',
    ]) {
      expect(existsSync(join(scripts, file)), file).toBe(true);
    }
    for (const name of names) {
      expect(name.endsWith('.sh'), name).toBe(false);
      expect(name.endsWith('.py'), name).toBe(false);
    }
  });
});
