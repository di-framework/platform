import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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

  test('sqlite component pack contains the wasm provider', () => {
    const packed = packPaths(join(import.meta.dir, '../platform/sqlite-component'));
    expect(packed).toContain('dist/di-framework-sqlite.wasm');
    expect(missingPackedEntries(['dist', 'wit'], packed)).toEqual([]);
  });
});
