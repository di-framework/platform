import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPins } from './lib/versions.ts';
import {
  checkPreviousPgVersion,
  DATABASE_MARKER,
  databaseArgs,
  PACKAGE_PROVIDER,
  previousRelease,
  readDatabaseMarker,
} from './smoke.ts';

describe('cross-version smoke step', () => {
  test('writes the data directory with the published 6.0.15 (PostgreSQL 17.5) provider', async () => {
    const release = previousRelease(await loadPins(resolve(import.meta.dir, '..')));
    expect(release).toEqual({
      version: '6.0.15',
      postgres: '17.5',
      url: 'https://registry.npmjs.org/@di-framework/pglite-component/-/pglite-component-6.0.15.tgz',
      sha256: '82b7226fb39f098cab5fb8a5740686a0cbbce48e28b6e036f21804edab200b7d',
    });
    expect(PACKAGE_PROVIDER).toBe('package/dist/di-framework-pglite.wasm');
  });

  test('refuses to run without the pins', () => {
    expect(() => previousRelease({})).toThrow('missing pin PGLITE_UPGRADE_FROM_VERSION');
  });

  test('compares the PG_VERSION major and reports it as a major', async () => {
    const release = previousRelease(await loadPins(resolve(import.meta.dir, '..')));
    expect(() => checkPreviousPgVersion('17', release)).not.toThrow();
    expect(() => checkPreviousPgVersion('16', release)).toThrow(
      'previous release wrote PG_VERSION 16, expected major version 17 ' +
        '(6.0.15 ships PostgreSQL 17.5)',
    );
  });
});

describe('database smoke checks (#212)', () => {
  test('the marker name matches the provider source', async () => {
    const engine = await Bun.file(resolve(import.meta.dir, '..', 'src', 'engine.rs')).text();
    expect(engine).toContain(`pub(crate) const DATABASE_MARKER: &str = "${DATABASE_MARKER}";`);
  });

  test('reads the marker from PGDATA under the mounted root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-pglite-marker-test.'));
    try {
      expect(await readDatabaseMarker(dir)).toBeNull();
      await mkdir(join(dir, 'pglite', 'data'), { recursive: true });
      await writeFile(join(dir, 'pglite', 'data', DATABASE_MARKER), 'postgres\n');
      expect(await readDatabaseMarker(dir)).toBe('postgres\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('passes the expectation to the consumer as environment', () => {
    expect(
      databaseArgs({
        requested: 'template1',
        expected: 'template1',
        table: 'tasks',
        present: false,
      }),
    ).toEqual([
      '--env',
      'PGLITE_SMOKE_EXPECT_DB=template1',
      '--env',
      'PGLITE_SMOKE_TABLE=tasks',
      '--env',
      'PGLITE_SMOKE_TABLE_PRESENT=0',
      '--env',
      'PGLITE_SMOKE_DATABASE=template1',
    ]);
    // No requested database: the consumer opens with `none`.
    expect(databaseArgs({ expected: 'postgres', table: 'tasks', present: true })).not.toContain(
      'PGLITE_SMOKE_DATABASE=postgres',
    );
  });
});
