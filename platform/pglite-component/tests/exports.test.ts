import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = join(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  name: string;
  private?: boolean;
  type?: string;
  main?: string;
  types?: string;
  files: string[];
  exports: Record<string, string | Record<string, string>>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

// `dist/js` comes from `bun run build:adapter`; the wasm from `make build`.
// Jobs that build them set PGLITE_REQUIRE_DIST=1 so a missing output fails.
const requireDist = process.env.PGLITE_REQUIRE_DIST === '1';
const adapterBuilt = requireDist || existsSync(join(pkgDir, 'dist', 'js', 'index.js'));
const wasmBuilt = requireDist || existsSync(join(pkgDir, 'dist', 'di-framework-pglite.wasm'));

const target = (entry: string | Record<string, string>, condition = 'default'): string =>
  typeof entry === 'string' ? entry : (entry[condition] as string);

describe('pglite-component exports', () => {
  test('is a publishable ES module that peers on @di-framework/repo', () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.type).toBe('module');
    expect(pkg.peerDependencies?.['@di-framework/repo']).toMatch(/^\^6\.\d+\.\d+$/);
    expect(pkg.devDependencies?.['@di-framework/repo']).toBe(
      pkg.peerDependencies?.['@di-framework/repo'],
    );
  });

  test('every export target is packed', () => {
    const packed = (path: string) =>
      pkg.files.some((entry) => path === `./${entry}` || path.startsWith(`./${entry}/`)) ||
      path === './package.json';
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      const conditions = typeof entry === 'string' ? { default: entry } : entry;
      for (const [condition, path] of Object.entries(conditions)) {
        expect(packed(path.replace('*', 'world.wit')), `${subpath} (${condition})`).toBe(true);
      }
    }
    expect(pkg.main).toBe(target(pkg.exports['.'] as Record<string, string>, 'import'));
    expect(pkg.types).toBe(target(pkg.exports['.'] as Record<string, string>, 'types'));
  });

  test('the root export is built from js/index.ts', () => {
    const root = pkg.exports['.'] as Record<string, string>;
    expect(root.types).toBe('./dist/js/index.d.ts');
    for (const condition of ['bun', 'import', 'default']) {
      expect(root[condition]).toBe('./dist/js/index.js');
    }
    const build = JSON.parse(readFileSync(join(pkgDir, 'tsconfig.build.json'), 'utf8')) as {
      compilerOptions: { outDir: string; rootDir: string };
    };
    expect(build.compilerOptions).toMatchObject({ outDir: 'dist/js', rootDir: 'js' });
    expect(existsSync(join(pkgDir, 'js', 'index.ts'))).toBe(true);
  });

  test('the WIT subpath resolves to the source WIT', () => {
    expect(Bun.resolveSync(`${pkg.name}/wit/world.wit`, pkgDir)).toBe(
      join(pkgDir, 'wit', 'world.wit'),
    );
  });

  test.skipIf(!adapterBuilt)('the package name resolves to the built adapter', async () => {
    expect(Bun.resolveSync(pkg.name, pkgDir)).toBe(join(pkgDir, 'dist', 'js', 'index.js'));
    const built = (await import(pkg.name)) as Record<string, unknown>;
    for (const name of [
      'createWasmPgliteDatabase',
      'createSqlDatabaseFromWasmPgliteConnection',
      'toPgPlaceholders',
      'WasmPgliteError',
    ]) {
      expect(typeof built[name], name).toBe('function');
    }
    expect(built.WASM_PGLITE_MODULE_ID).toBe('di-framework:pglite/database@0.2.0');
  });

  test.skipIf(!wasmBuilt)('the wasm and built WIT subpaths resolve to dist', () => {
    expect(Bun.resolveSync(`${pkg.name}/wasm`, pkgDir)).toBe(
      join(pkgDir, 'dist', 'di-framework-pglite.wasm'),
    );
    expect(Bun.resolveSync(`${pkg.name}/wit`, pkgDir)).toBe(
      join(pkgDir, 'dist', 'di-framework-pglite.wit'),
    );
  });
});
