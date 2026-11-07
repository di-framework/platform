import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createContext, UsageError } from './lib/cli.ts';
import {
  migrateCluster17To18,
  parseMigrateArgs,
  USAGE,
  validateMigrationDirs,
} from './migrate-17-to-18.ts';

describe('parseMigrateArgs', () => {
  test('parses --from, --to, optional --database, and optional --dump', () => {
    expect(parseMigrateArgs(['--from', '/tmp/pg17', '--to', '/tmp/pg18'])).toEqual({
      help: false,
      fromDir: resolve('/tmp/pg17'),
      toDir: resolve('/tmp/pg18'),
      database: undefined,
      dumpPath: undefined,
    });
    expect(
      parseMigrateArgs([
        '--from',
        '/tmp/pg17',
        '--to',
        '/tmp/pg18',
        '--database',
        'template1',
        '--dump',
        '/tmp/dump.sql',
      ]),
    ).toEqual({
      help: false,
      fromDir: resolve('/tmp/pg17'),
      toDir: resolve('/tmp/pg18'),
      database: 'template1',
      dumpPath: resolve('/tmp/dump.sql'),
    });
    expect(
      parseMigrateArgs(['--from', '/tmp/pg17', '--to', '/tmp/pg18', '--database', 'postgres']),
    ).toEqual({
      help: false,
      fromDir: resolve('/tmp/pg17'),
      toDir: resolve('/tmp/pg18'),
      database: 'postgres',
      dumpPath: undefined,
    });
  });

  test('reports --help without throwing', () => {
    expect(parseMigrateArgs(['--help'])).toEqual({ help: true });
    expect(parseMigrateArgs(['-h'])).toEqual({ help: true });
  });

  test('rejects missing, invalid, or identical arguments', () => {
    expect(() => parseMigrateArgs([])).toThrow(UsageError);
    expect(() => parseMigrateArgs(['--from', '/tmp/pg17'])).toThrow(USAGE);
    expect(() => parseMigrateArgs(['--from'])).toThrow('requires an argument');
    expect(() => parseMigrateArgs(['--from', '--to', '/tmp/pg18'])).toThrow('requires an argument');
    expect(() => parseMigrateArgs(['--unknown', 'x'])).toThrow('unknown or unexpected argument');
    expect(() =>
      parseMigrateArgs(['--from', '/tmp/pg17', '--to', '/tmp/pg18', '--database', 'other']),
    ).toThrow('must be "postgres" or "template1"');
    expect(() => parseMigrateArgs(['--from', '/tmp/same', '--to', '/tmp/same'])).toThrow(
      'must be distinct directories',
    );
  });
});

describe('validateMigrationDirs', () => {
  test('accepts a PostgreSQL 17 source root and an uninitialized target root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'df-pglite-mig-test.'));
    try {
      const fromDir = join(base, 'from17');
      const toDir = join(base, 'to18');
      await mkdir(join(fromDir, 'pglite', 'data'), { recursive: true });
      await writeFile(join(fromDir, 'pglite', 'data', 'PG_VERSION'), '17\n');
      await expect(validateMigrationDirs(fromDir, toDir)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('rejects missing source PG_VERSION, wrong source major version, or existing target cluster', async () => {
    const base = await mkdtemp(join(tmpdir(), 'df-pglite-mig-bad.'));
    try {
      const emptyFrom = join(base, 'empty');
      const toDir = join(base, 'to18');
      await expect(validateMigrationDirs(emptyFrom, toDir)).rejects.toThrow(
        'has no pglite/data/PG_VERSION',
      );

      const from16 = join(base, 'from16');
      await mkdir(join(from16, 'pglite', 'data'), { recursive: true });
      await writeFile(join(from16, 'pglite', 'data', 'PG_VERSION'), '16\n');
      await expect(validateMigrationDirs(from16, toDir)).rejects.toThrow('expected "17"');

      const from17 = join(base, 'from17');
      await mkdir(join(from17, 'pglite', 'data'), { recursive: true });
      await writeFile(join(from17, 'pglite', 'data', 'PG_VERSION'), '17\n');
      await mkdir(join(toDir, 'pglite', 'data'), { recursive: true });
      await writeFile(join(toDir, 'pglite', 'data', 'PG_VERSION'), '18\n');
      await expect(validateMigrationDirs(from17, toDir)).rejects.toThrow('refuse to overwrite');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('cleans up partial target directory if migration fails mid-flight', async () => {
    const base = await mkdtemp(join(tmpdir(), 'df-pglite-mig-fail.'));
    try {
      const fromDir = join(base, 'from17');
      const toDir = join(base, 'to18');
      const workDir = join(base, 'work');
      await mkdir(join(fromDir, 'pglite', 'data'), { recursive: true });
      await writeFile(join(fromDir, 'pglite', 'data', 'PG_VERSION'), '17\n');
      await mkdir(workDir, { recursive: true });

      const ctx = await createContext();
      await expect(
        migrateCluster17To18(ctx, {
          fromDir,
          toDir,
          previousComposed: join(base, 'missing-prev.wasm'),
          currentComposed: join(base, 'missing-curr.wasm'),
          workDir,
        }),
      ).rejects.toThrow('wasmtime export-sql failed');

      expect(existsSync(toDir)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
