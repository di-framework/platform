import { describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copyLicenseFiles,
  missingPackedEntries,
  packPaths,
  parsePackedPaths,
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

  test('public packages include LICENSE files in their packs after copying', () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-license-'));
    mkdirSync(join(root, 'packages', 'test', 'dist'), { recursive: true });
    // Create root license files
    writeFileSync(join(root, 'LICENSE-MIT'), 'MIT License content\n');
    writeFileSync(join(root, 'LICENSE-APACHE'), 'Apache 2.0 License content\n');
    // Create a test package with license files in the files array (as they should be declared)
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    );
    writeFileSync(
      join(root, 'packages', 'test', 'package.json'),
      JSON.stringify({
        name: 'test-package',
        version: '0.0.0',
        files: ['dist', 'LICENSE-MIT', 'LICENSE-APACHE'],
      }),
    );
    writeFileSync(join(root, 'packages', 'test', 'dist', 'index.js'), 'export {}\n');

    // Copy license files as the publish script does
    const pkgDir = join(root, 'packages', 'test');
    copyLicenseFiles(pkgDir, root);

    // Verify files were copied
    expect(existsSync(join(pkgDir, 'LICENSE-MIT'))).toBe(true);
    expect(existsSync(join(pkgDir, 'LICENSE-APACHE'))).toBe(true);

    // Verify they are in the pack
    const packed = packPaths(pkgDir);
    expect(packed).toContain('LICENSE-MIT');
    expect(packed).toContain('LICENSE-APACHE');
  });

  test('all public packages in the real workspace include LICENSE files', () => {
    const rootDir = join(import.meta.dir, '..');
    const publicPackages = workspacePackageDirs(rootDir).filter((directory) => {
      const pkg = JSON.parse(
        readFileSync(join(rootDir, directory, 'package.json'), 'utf8'),
      ) as { private?: boolean };
      return pkg.private !== true;
    });

    expect(publicPackages.length).toBeGreaterThan(0);

    for (const directory of publicPackages) {
      const pkgDir = join(rootDir, directory);
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
        name: string;
      };

      // Copy license files as the publish script does
      copyLicenseFiles(pkgDir, rootDir);

      // Verify files were copied
      expect(existsSync(join(pkgDir, 'LICENSE-MIT'))).toBe(true);
      expect(existsSync(join(pkgDir, 'LICENSE-APACHE'))).toBe(true);

      // Verify they are in the pack
      const packed = packPaths(pkgDir);
      expect(packed).toContain('LICENSE-MIT');
      expect(packed).toContain('LICENSE-APACHE');
    }
  });

  test('pglite-component preserves THIRD-PARTY-NOTICES.txt', () => {
    const pglitePath = join(import.meta.dir, '../platform/pglite-component');
    const packed = packPaths(pglitePath);
    if (existsSync(join(pglitePath, 'dist/THIRD-PARTY-NOTICES.txt'))) {
      expect(packed).toContain('dist/THIRD-PARTY-NOTICES.txt');
    }
  });
});
