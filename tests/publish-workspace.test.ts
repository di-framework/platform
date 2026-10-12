import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRootLicenses,
  LICENSE_FILES,
  missingLicenses,
  missingPackedEntries,
  packPaths,
  parsePackedPaths,
  publishWorkspaces,
  workspacePackageDirs,
} from '../scripts/publish-workspace.ts';

describe('publish workspace packs', () => {
  test('rejects a files entry that the pack omitted', () => {
    expect(missingPackedEntries(['dist', 'wit'], ['package.json', 'wit/world.wit'])).toEqual([
      'dist',
    ]);
    expect(missingPackedEntries(['dist'], ['dist/index.js'])).toEqual([]);
    expect(
      parsePackedPaths('packed 1.00KB dist/di-framework-sqlite.wasm\nTotal files: 1\n'),
    ).toEqual(['dist/di-framework-sqlite.wasm']);
  });

  test('lists workspace packages and packs a directory that has its files', () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-workspace-'));
    mkdirSync(join(root, 'packages', 'ok', 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    );
    writeFileSync(
      join(root, 'packages', 'ok', 'package.json'),
      JSON.stringify({
        name: 'publish-workspace-ok',
        version: '0.0.0',
        files: ['dist'],
      }),
    );
    writeFileSync(join(root, 'packages', 'ok', 'dist', 'index.js'), 'export {}\n');

    expect(workspacePackageDirs(root)).toEqual(['packages/ok']);
    expect(missingPackedEntries(['dist'], packPaths(join(root, 'packages', 'ok')))).toEqual([]);
  });

  test('publishes the cloudflare adapter with the other public packages', () => {
    const rootDir = join(import.meta.dir, '..');
    const root = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
      version: string;
    };
    const published = workspacePackageDirs(rootDir).flatMap((directory) => {
      const pkg = JSON.parse(readFileSync(join(rootDir, directory, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        private?: boolean;
      };
      return pkg.private === true ? [] : [`${pkg.name}@${pkg.version}`];
    });

    expect(published).toContain(`@di-framework/cloudflare@${root.version}`);
    expect(published.sort()).toEqual([
      `@di-framework/bindings@${root.version}`,
      `@di-framework/cloudflare@${root.version}`,
      `@di-framework/cloudfoundry@${root.version}`,
      `@di-framework/pglite-component@${root.version}`,
      `@di-framework/platform@${root.version}`,
      `@di-framework/sqlite-component@${root.version}`,
      `@di-framework/tenant-cli@${root.version}`,
    ]);
  });

  test('sqlite component pack contains the wasm provider', () => {
    const packed = packPaths(join(import.meta.dir, '../platform/sqlite-component'));
    expect(packed).toContain('dist/di-framework-sqlite.wasm');
    expect(missingPackedEntries(['dist', 'wit'], packed)).toEqual([]);
  });

  // The pglite wasm needs the engine build (Docker); jobs that run it set
  // PGLITE_REQUIRE_DIST=1, everyone else skips unless dist/ is on disk.
  const pgliteDir = join(import.meta.dir, '../platform/pglite-component');
  const pgliteBuilt =
    process.env.PGLITE_REQUIRE_DIST === '1' ||
    existsSync(join(pgliteDir, 'dist/di-framework-pglite.wasm'));

  test.skipIf(!pgliteBuilt)('pglite component pack contains the adapter and the wasm', () => {
    const pkg = JSON.parse(readFileSync(join(pgliteDir, 'package.json'), 'utf8')) as {
      files: string[];
    };
    const packed = packPaths(pgliteDir);
    for (const file of [
      'dist/di-framework-pglite.wasm',
      'dist/di-framework-pglite.wit',
      'dist/SHA256SUMS',
      'dist/js/index.js',
      'dist/js/index.d.ts',
      'wit/world.wit',
    ]) {
      expect(packed).toContain(file);
    }
    expect(missingPackedEntries(pkg.files, packed)).toEqual([]);
  });

  test('pglite component refuses a pack without its wasm or adapter', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, '../platform/pglite-component/package.json'), 'utf8'),
    ) as { files: string[] };
    expect(missingPackedEntries(pkg.files, ['package.json', 'wit/world.wit'])).toEqual(
      expect.arrayContaining(['dist/js', 'dist/di-framework-pglite.wasm']),
    );
  });

  test('missingLicenses requires both license files with no fail-open', () => {
    expect(missingLicenses(['package.json'])).toEqual(['LICENSE-MIT', 'LICENSE-APACHE']);
    expect(missingLicenses(['LICENSE-MIT'])).toEqual(['LICENSE-APACHE']);
    expect(missingLicenses(['LICENSE-MIT', 'LICENSE-APACHE'])).toEqual([]);
  });

  test('a missing root license throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-license-'));
    expect(() => assertRootLicenses(root)).toThrow('LICENSE-MIT');
    writeFileSync(join(root, 'LICENSE-MIT'), 'mit\n');
    expect(() => assertRootLicenses(root)).toThrow('LICENSE-APACHE');
    writeFileSync(join(root, 'LICENSE-APACHE'), 'apache\n');
    expect(() => assertRootLicenses(root)).not.toThrow();
  });

  test('publishWorkspaces refuses to run without root licenses', () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-license-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
    expect(() => publishWorkspaces(root, true)).toThrow('LICENSE-MIT');
  });

  // pglite-component is private until #145 publishes it; it must already carry licenses.
  const rootDir = join(import.meta.dir, '..');
  const licensedDirs = [
    ...new Set([
      ...workspacePackageDirs(rootDir).filter(
        (directory) =>
          (
            JSON.parse(readFileSync(join(rootDir, directory, 'package.json'), 'utf8')) as {
              private?: boolean;
            }
          ).private !== true,
      ),
      'platform/pglite-component',
    ]),
  ];

  test('there are public packages to check', () => {
    expect(licensedDirs.length).toBeGreaterThan(1);
  });

  for (const directory of licensedDirs) {
    test(`${directory} commits byte-identical license files listed in files`, () => {
      const manifest = JSON.parse(
        readFileSync(join(rootDir, directory, 'package.json'), 'utf8'),
      ) as { files?: string[] };
      for (const license of LICENSE_FILES) {
        expect(manifest.files ?? [], `${directory} files`).toContain(license);
        const copy = readFileSync(join(rootDir, directory, license));
        expect(copy.equals(readFileSync(join(rootDir, license))), `${directory}/${license}`).toBe(
          true,
        );
      }
    });

    test(`${directory} pack includes both license files`, () => {
      expect(missingLicenses(packPaths(join(rootDir, directory)))).toEqual([]);
    });
  }

  test.skipIf(!pgliteBuilt)('pglite-component pack includes THIRD-PARTY-NOTICES.txt', () => {
    const packed = packPaths(join(rootDir, 'platform/pglite-component'));
    expect(packed).toContain('dist/THIRD-PARTY-NOTICES.txt');
  });
});
