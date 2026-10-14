import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRootLicenses,
  LICENSE_FILES,
  missingLicenses,
  missingPackedEntries,
  PACK_MANIFEST,
  type PackedPackage,
  packPaths,
  packWorkspaces,
  parseArgs,
  parsePackedPaths,
  publishPacked,
  publishWorkspaces,
  sha256File,
  verifyPackDir,
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

/** A workspace with one public package whose build writes dist/build.txt, and one private one. */
function packFixture(): { root: string; packDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'publish-pack-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  );
  for (const license of LICENSE_FILES) writeFileSync(join(root, license), `${license}\n`);
  const pkgDir = join(root, 'packages', 'ok');
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  for (const license of LICENSE_FILES) writeFileSync(join(pkgDir, license), `${license}\n`);
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@publish-pack/ok',
      version: '1.2.3',
      files: ['dist', ...LICENSE_FILES],
      scripts: { build: 'echo rebuilt > dist/build.txt' },
    }),
  );
  writeFileSync(join(pkgDir, 'dist', 'build.txt'), 'tested\n');
  mkdirSync(join(root, 'packages', 'internal'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'internal', 'package.json'),
    JSON.stringify({ name: 'internal', version: '0.0.0', private: true }),
  );
  return { root, packDir: join(root, 'out') };
}

function packedFile(tarball: string, path: string): string {
  const result = Bun.spawnSync(['tar', '-xzOf', tarball, `package/${path}`], { stdout: 'pipe' });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

describe('release packs (#168)', () => {
  test('packs each public package once and records the tarball sha256', () => {
    const { root, packDir } = packFixture();
    const manifest = packWorkspaces(root, packDir);
    expect(manifest.map((entry) => [entry.name, entry.version, entry.directory])).toEqual([
      ['@publish-pack/ok', '1.2.3', 'packages/ok'],
    ]);
    const [entry] = manifest as [PackedPackage];
    expect(entry.filename).toBe('publish-pack-ok-1.2.3.tgz');
    expect(entry.sha256).toBe(sha256File(join(packDir, entry.filename)));
    expect(JSON.parse(readFileSync(join(packDir, PACK_MANIFEST), 'utf8'))).toEqual(manifest);
    expect(packedFile(join(packDir, entry.filename), 'dist/build.txt')).toBe('rebuilt\n');
    expect(verifyPackDir(packDir)).toEqual(manifest);
  });

  test('a --prebuilt package is packed from the bytes already on disk, not rebuilt', () => {
    const { root, packDir } = packFixture();
    const [entry] = packWorkspaces(root, packDir, new Set(['@publish-pack/ok'])) as [PackedPackage];
    expect(packedFile(join(packDir, entry.filename), 'dist/build.txt')).toBe('tested\n');
    expect(readFileSync(join(root, 'packages/ok/dist/build.txt'), 'utf8')).toBe('tested\n');
  });

  test('refuses an unknown --prebuilt name, a non-empty pack directory, and an incomplete pack', () => {
    const { root, packDir } = packFixture();
    expect(() => packWorkspaces(root, packDir, new Set(['internal']))).toThrow(
      '--prebuilt internal',
    );
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, 'stale.tgz'), 'x');
    expect(() => packWorkspaces(root, packDir)).toThrow('not empty');

    const other = packFixture();
    const manifestPath = join(other.root, 'packages/ok/package.json');
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...pkg, files: [...pkg.files, 'wit'] }));
    expect(() => packWorkspaces(other.root, other.packDir)).toThrow('missing wit');
  });

  test('verifyPackDir refuses a changed, missing, or unlisted tarball', () => {
    const { root, packDir } = packFixture();
    const [entry] = packWorkspaces(root, packDir) as [PackedPackage];
    const tarball = join(packDir, entry.filename);
    const bytes = readFileSync(tarball);

    writeFileSync(join(packDir, 'extra.tgz'), 'x');
    expect(() => verifyPackDir(packDir)).toThrow('unlisted files');
    rmSync(join(packDir, 'extra.tgz'));

    writeFileSync(tarball, Buffer.concat([bytes, Buffer.from([0])]));
    expect(() => verifyPackDir(packDir)).toThrow('differs from the packed');
    rmSync(tarball);
    expect(() => verifyPackDir(packDir)).toThrow();
  });

  test('publishPacked publishes exactly the verified tarballs and skips published versions', () => {
    const { root, packDir } = packFixture();
    const [entry] = packWorkspaces(root, packDir) as [PackedPackage];
    const sent: string[] = [];
    const publish = (tarball: string) => {
      expect(sha256File(tarball)).toBe(entry.sha256);
      sent.push(tarball);
    };
    expect(publishPacked(packDir, { isPublished: () => false, publish })).toEqual([
      '@publish-pack/ok',
    ]);
    expect(sent).toEqual([join(packDir, entry.filename)]);
    expect(publishPacked(packDir, { isPublished: () => true, publish })).toEqual([]);
    expect(sent).toHaveLength(1);

    writeFileSync(join(packDir, entry.filename), 'tampered');
    expect(() => publishPacked(packDir, { isPublished: () => false, publish })).toThrow(
      'Refusing to publish',
    );
    expect(sent).toHaveLength(1);
  });

  test('parseArgs keeps the old modes and accepts exactly one mode', () => {
    expect(parseArgs([])).toEqual({ mode: 'publish' });
    expect(parseArgs(['--dry-run'])).toEqual({ mode: 'dry-run' });
    expect(parseArgs(['--pack', 'out', '--prebuilt', 'a', '--prebuilt', 'b'])).toEqual({
      mode: 'pack',
      packDir: 'out',
      prebuilt: new Set(['a', 'b']),
    });
    expect(parseArgs(['--publish-packed', 'out'])).toEqual({
      mode: 'publish-packed',
      packDir: 'out',
    });
    expect(parseArgs(['--verify-packed', 'out'])).toEqual({
      mode: 'verify-packed',
      packDir: 'out',
    });
    expect(() => parseArgs(['--dry-run', '--verify-packed', 'out'])).toThrow('only one');
    expect(() => parseArgs(['--pack'])).toThrow('needs a value');
    expect(() => parseArgs(['--pack', 'a', '--publish-packed', 'b'])).toThrow('only one');
    expect(() => parseArgs(['--prebuilt', 'a'])).toThrow('only applies to --pack');
    expect(() => parseArgs(['--publish'])).toThrow('unknown argument');
  });
});
