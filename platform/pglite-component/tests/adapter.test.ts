import { describe, expect, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { join } from 'node:path';
import {
  isMigrationDatabase,
  isSqlDatabase,
  isUniqueViolation,
  type SqlDatabase,
  type WasmMaybeResult,
} from '@di-framework/repo';
import {
  createSqlDatabaseFromWasmPgliteConnection,
  createWasmPgliteDatabase,
  fromWasmPgRow,
  fromWasmPgValue,
  normalizeWasmPgliteError,
  pgliteTimestampIso,
  toPgPlaceholders,
  toWasmPgParams,
  toWasmPgValue,
  unwrapWasmPgliteResult,
  WASM_PGLITE_DEFAULT_ROOT,
  WASM_PGLITE_MODULE_ID,
  type WasmPgliteConnection,
  WasmPgliteError,
  type WasmPgliteModule,
  type WasmPgliteOpenOptions,
  type WasmPgRow,
  type WasmPgValue,
} from '../js/index';
import { databaseInterface, readWitVersion } from '../scripts/lib/wit-version';
import { startWorker, withTimeout } from './async-context';

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('pglite value conversion', () => {
  test('binds JavaScript values as pglite value variants', () => {
    expect(toWasmPgValue(null)).toEqual({ tag: 'null' });
    expect(toWasmPgValue(undefined)).toEqual({ tag: 'null' });
    // Safe integers stay Numbers so every binding can lower them as s64.
    expect(toWasmPgValue(42)).toEqual({ tag: 'integer', val: 42 });
    expect(toWasmPgValue(Number.MAX_SAFE_INTEGER)).toEqual({
      tag: 'integer',
      val: Number.MAX_SAFE_INTEGER,
    });
    expect(toWasmPgValue(Number.MIN_SAFE_INTEGER)).toEqual({
      tag: 'integer',
      val: Number.MIN_SAFE_INTEGER,
    });
    const negativeZero = toWasmPgValue(-0);
    expect(negativeZero).toEqual({ tag: 'integer', val: 0 });
    expect(Object.is(negativeZero.val, 0)).toBe(true);
    expect(() => toWasmPgValue(2 ** 53)).toThrow(/outside the safe range/);
    expect(() => toWasmPgValue(-(2 ** 53))).toThrow(/outside the safe range/);
    expect(toWasmPgValue(1.5)).toEqual({ tag: 'real', val: 1.5 });
    expect(() => toWasmPgValue(Number.MAX_SAFE_INTEGER + 2)).toThrow(/bigint or a decimal string/);
    expect(() => toWasmPgValue(-(2 ** 60))).toThrow(TypeError);
    expect(() => toWasmPgValue(1e300)).toThrow(/outside the safe range/);
    expect(toWasmPgValue(Number.NaN)).toEqual({ tag: 'real', val: Number.NaN });
    expect(toWasmPgValue(Number.POSITIVE_INFINITY)).toEqual({
      tag: 'real',
      val: Number.POSITIVE_INFINITY,
    });
    // Band 1: a safe bigint is sent as a Number, like a safe number.
    expect(toWasmPgValue(42n)).toEqual({ tag: 'integer', val: 42 });
    expect(toWasmPgValue(0n)).toEqual({ tag: 'integer', val: 0 });
    expect(toWasmPgValue(MAX_SAFE_BIG)).toEqual({ tag: 'integer', val: Number.MAX_SAFE_INTEGER });
    expect(toWasmPgValue(-MAX_SAFE_BIG)).toEqual({ tag: 'integer', val: Number.MIN_SAFE_INTEGER });
    // Band 2: past 2^53 within int8 a BigInt payload keeps it exact
    // (componentize-qjs 0.4.4-di.5 lowers s64 from BigInt, #153).
    expect(toWasmPgValue(2n ** 53n)).toEqual({ tag: 'integer', val: 2n ** 53n });
    expect(toWasmPgValue(-(2n ** 53n))).toEqual({ tag: 'integer', val: -(2n ** 53n) });
    expect(toWasmPgValue(9007199254740993n)).toEqual({ tag: 'integer', val: 9007199254740993n });
    expect(toWasmPgValue(2n ** 63n - 1n)).toEqual({ tag: 'integer', val: 2n ** 63n - 1n });
    expect(toWasmPgValue(-(2n ** 63n))).toEqual({ tag: 'integer', val: -(2n ** 63n) });
    // Band 3: outside s64 the binding would wrap modulo 2^64, so the value goes as text for numeric.
    expect(toWasmPgValue(2n ** 63n)).toEqual({ tag: 'text', val: '9223372036854775808' });
    expect(toWasmPgValue(-(2n ** 63n) - 1n)).toEqual({ tag: 'text', val: '-9223372036854775809' });
    expect(toWasmPgValue(true)).toEqual({ tag: 'boolean', val: true });
    expect(toWasmPgValue(false)).toEqual({ tag: 'boolean', val: false });
    expect(toWasmPgValue('text')).toEqual({ tag: 'text', val: 'text' });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toWasmPgValue(bytes)).toEqual({ tag: 'blob', val: bytes });
    expect(toWasmPgValue(bytes.buffer)).toEqual({ tag: 'blob', val: bytes });
    const view = new DataView(bytes.buffer, 1, 2);
    expect(toWasmPgValue(view)).toEqual({ tag: 'blob', val: new Uint8Array([2, 3]) });
    expect(toWasmPgValue(new Date('2026-09-09T12:00:00Z'))).toEqual({
      tag: 'timestamp',
      val: '2026-09-09T12:00:00.000Z',
    });
    expect(() => toWasmPgValue(new Date('nope'))).toThrow(/invalid Date/);
    expect(toWasmPgValue({ a: [1, 'b'] })).toEqual({ tag: 'json', val: '{"a":[1,"b"]}' });
    expect(toWasmPgValue(['x', 2])).toEqual({ tag: 'json', val: '["x",2]' });
    expect(() => toWasmPgValue(Symbol('x'))).toThrow(/Cannot bind symbol/);
    expect(() => toWasmPgValue(() => 1)).toThrow(/Cannot bind function/);
    expect(toWasmPgParams([1, 'a', null])).toEqual([
      { tag: 'integer', val: 1 },
      { tag: 'text', val: 'a' },
      { tag: 'null' },
    ]);
    expect(toWasmPgParams()).toEqual([]);
  });

  test('decodes results like the wasmcloud:postgres codec', () => {
    expect(fromWasmPgValue({ tag: 'null' })).toBeNull();
    expect(fromWasmPgValue({ tag: 'integer', val: 7 })).toBe(7);
    expect(fromWasmPgValue({ tag: 'integer', val: 42n })).toBe(42);
    expect(fromWasmPgValue({ tag: 'integer', val: 2n ** 62n })).toBe('4611686018427387904');
    expect(fromWasmPgValue({ tag: 'real', val: 2.5 })).toBe(2.5);
    expect(fromWasmPgValue({ tag: 'text', val: 'hi' })).toBe('hi');
    expect(fromWasmPgValue({ tag: 'boolean', val: false })).toBe(false);
    const bytes = new Uint8Array([1, 2]);
    expect(fromWasmPgValue({ tag: 'blob', val: bytes })).toBe(bytes);
    expect(fromWasmPgValue({ tag: 'blob', val: [1, 2] })).toEqual(bytes);
    expect(fromWasmPgValue({ tag: 'json', val: '{"a": 1}' })).toEqual({ a: 1 });
    expect(fromWasmPgValue({ tag: 'json', val: 'not json' })).toBe('not json');
    expect(fromWasmPgValue({ tag: 'timestamp', val: '2024-01-15T10:30:00Z' })).toBe(
      '2024-01-15T10:30:00.000Z',
    );
    expect(() => fromWasmPgValue({ tag: 'weird' } as unknown as WasmPgValue)).toThrow(
      'PGlite value-conversion-failed: Unknown value tag weird',
    );
    expect(
      fromWasmPgRow([
        ['id', { tag: 'integer', val: 1n }],
        ['doc', { tag: 'json', val: '[1]' }],
      ]),
    ).toEqual({ id: 1, doc: [1] });
  });

  test('formats timestamps with milliseconds and keeps special values', () => {
    expect(pgliteTimestampIso('2024-01-15T10:30:00.123456Z')).toBe('2024-01-15T10:30:00.123Z');
    expect(pgliteTimestampIso('2024-01-15T10:30:00.5Z')).toBe('2024-01-15T10:30:00.500Z');
    expect(pgliteTimestampIso('2024-01-15T10:30:00.123Z')).toBe('2024-01-15T10:30:00.123Z');
    expect(pgliteTimestampIso('infinity')).toBe('infinity');
    expect(pgliteTimestampIso('-infinity')).toBe('-infinity');
    expect(pgliteTimestampIso('0044-03-15 00:00:00+00 BC')).toBe('0044-03-15 00:00:00+00 BC');
  });
});

describe('pglite errors', () => {
  test('keeps the SQLSTATE in code and the PostgreSQL message prefix', () => {
    expect(unwrapWasmPgliteResult({ tag: 'ok', val: 3 })).toBe(3);
    expect(unwrapWasmPgliteResult(5)).toBe(5);
    let caught: unknown;
    try {
      unwrapWasmPgliteResult({
        tag: 'err',
        val: {
          tag: 'execution-failed',
          val: { code: '23505', message: 'duplicate key value violates unique constraint' },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WasmPgliteError);
    const error = caught as WasmPgliteError;
    expect(error.code).toBe('23505');
    expect(error.tag).toBe('execution-failed');
    expect(error.detail).toBe('duplicate key value violates unique constraint');
    expect(error.message).toBe('PostgreSQL 23505 duplicate key value violates unique constraint');
    expect(isUniqueViolation(error)).toBe(true);

    expect(new WasmPgliteError({ tag: 'execution-failed', val: { code: '22012' } }).message).toBe(
      'PostgreSQL 22012',
    );
    const noCode = new WasmPgliteError({
      tag: 'execution-failed',
      val: { code: '', message: 'x' },
    });
    expect(noCode.code).toBeUndefined();
    expect(noCode.message).toBe('PGlite execution-failed: x');
    expect(new WasmPgliteError({ tag: 'closed' }).message).toBe('PGlite closed');
    expect(new WasmPgliteError({ tag: 'invalid-sql', val: 'syntax' }).message).toBe(
      'PGlite invalid-sql: syntax',
    );
  });

  test('normalizes every binding error shape', () => {
    const existing = new WasmPgliteError({ tag: 'closed' });
    expect(normalizeWasmPgliteError(existing)).toBe(existing);
    expect(normalizeWasmPgliteError({ tag: 'closed' }).message).toBe('PGlite closed');
    const thrown = Object.assign(new Error('ComponentError'), {
      payload: { tag: 'execution-failed', val: { code: '23505', message: 'dup' } },
    });
    const normalized = normalizeWasmPgliteError(thrown) as WasmPgliteError;
    expect(normalized.code).toBe('23505');
    expect(normalized.cause).toBe(thrown);
    expect(normalizeWasmPgliteError('boom').message).toBe('PGlite other: boom');
    const plain = new Error('plain');
    expect(normalizeWasmPgliteError(plain)).toBe(plain);
    expect(normalizeWasmPgliteError({ payload: 1 }).message).toBe('[object Object]');
    expect(normalizeWasmPgliteError(7).message).toBe('7');
    expect(normalizeWasmPgliteError({ tag: 'ok' }).message).toBe('[object Object]');
  });
});

describe('toPgPlaceholders', () => {
  test('numbers placeholders in order', () => {
    expect(toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b IN (?, ?)')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)',
    );
    expect(toPgPlaceholders('SELECT 1')).toBe('SELECT 1');
  });

  const skipped: Array<[sql: string, expected: string]> = [
    ["SELECT '?', 'it''s ?', ? FROM t", "SELECT '?', 'it''s ?', $1 FROM t"],
    ["SELECT E'\\'?', e'\\\\', ?", "SELECT E'\\'?', e'\\\\', $1"],
    ["SELECT ae'\\', ?", "SELECT ae'\\', $1"],
    ['SELECT "a?", "b""?", ? FROM t', 'SELECT "a?", "b""?", $1 FROM t'],
    ['SELECT ? -- what?\n, ?', 'SELECT $1 -- what?\n, $2'],
    ['SELECT ? -- trailing?', 'SELECT $1 -- trailing?'],
    ['SELECT /* a /* ? */ ? */ ?', 'SELECT /* a /* ? */ ? */ $1'],
    ['SELECT ? /* open ?', 'SELECT $1 /* open ?'],
    ['SELECT $$?$$, $fn$ ? $fn$, ?', 'SELECT $$?$$, $fn$ ? $fn$, $1'],
    ['SELECT ?, $q$ open ?', 'SELECT $1, $q$ open ?'],
    ["SELECT ?, 'open ?", "SELECT $1, 'open ?"],
    ['SELECT doc ?| ?, doc ?& ? FROM t', 'SELECT doc ?| $1, doc ?& $2 FROM t'],
    ['SELECT a$1, $x, ?', 'SELECT a$1, $x, $1'],
    ['SELECT 5 / 2, - 1, ?', 'SELECT 5 / 2, - 1, $1'],
    // Shapes taken from identity-server's repositories.
    ['SELECT * FROM users WHERE id = ?::uuid', 'SELECT * FROM users WHERE id = $1::uuid'],
    [
      'UPDATE t SET doc = ?::text::jsonb WHERE id = ?',
      'UPDATE t SET doc = $1::text::jsonb WHERE id = $2',
    ],
    [
      'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    ],
    [
      `SELECT id FROM t WHERE position('"invalidated":true' IN data) = 0 AND c = ?`,
      `SELECT id FROM t WHERE position('"invalidated":true' IN data) = 0 AND c = $1`,
    ],
    ["SELECT 'is this ?' AS q, ? AS a", "SELECT 'is this ?' AS q, $1 AS a"],
    ["SELECT ? || 'x' FROM t WHERE c = ?", "SELECT $1 || 'x' FROM t WHERE c = $2"],
  ];
  for (const [sql, expected] of skipped) {
    test(`skips quoted text, comments, and jsonb operators: ${sql}`, () => {
      expect(toPgPlaceholders(sql)).toBe(expected);
    });
  }

  test('leaves $n statements alone and rejects mixed styles', () => {
    expect(toPgPlaceholders('SELECT $1, $2')).toBe('SELECT $1, $2');
    expect(() => toPgPlaceholders('SELECT $1, ?')).toThrow(/Cannot mix/);
  });
});

interface FakeOptions {
  resultRecords?: boolean;
  fail?: (op: string, sql?: string) => unknown;
  rows?: WasmPgRow[];
  changes?: bigint | number | undefined;
}

/**
 * Scripted `connection` resource. Records every call; `fail` returns an error
 * payload for a call that should fail. `resultRecords` switches between hosts
 * that return `{ tag: 'ok' | 'err' }` records and hosts that throw `payload`s.
 */
function fakeConnection(options: FakeOptions = {}) {
  const log: string[] = [];
  const params: WasmPgValue[][] = [];
  const respond = <T>(op: string, value: T, sql?: string): WasmMaybeResult<T> => {
    log.push(sql === undefined ? op : `${op} ${sql}`);
    const failure = options.fail?.(op, sql);
    if (failure !== undefined) {
      if (options.resultRecords) return { tag: 'err', val: failure };
      throw Object.assign(new Error('ComponentError'), { payload: failure });
    }
    return options.resultRecords ? { tag: 'ok', val: value } : value;
  };
  const rows = options.rows ?? [[['n', { tag: 'integer', val: 1n }]]];
  const changes = ('changes' in options ? options.changes : 1n) as bigint | number;
  const connection: WasmPgliteConnection = {
    exec: (sql) => respond('exec', undefined, sql),
    run: (sql, values) => {
      params.push(values);
      return respond('run', changes, sql);
    },
    query: (sql, values) => {
      params.push(values);
      return respond('query', rows, sql);
    },
    first: (sql, values) => {
      params.push(values);
      return respond('first', rows[0], sql);
    },
    begin: () => respond('BEGIN', undefined),
    commit: () => respond('COMMIT', undefined),
    rollback: () => respond('ROLLBACK', undefined),
    savepoint: (name) => respond('SAVEPOINT', undefined, name),
    releaseSavepoint: (name) => respond('RELEASE', undefined, name),
    rollbackToSavepoint: (name) => respond('ROLLBACK TO', undefined, name),
    close: () => respond('close', undefined),
  };
  return { connection, log, params };
}

describe('pglite SqlDatabase adapter', () => {
  for (const resultRecords of [true, false]) {
    test(`runs statements through the connection (${resultRecords ? 'result records' : 'thrown payloads'})`, async () => {
      const { connection, log, params } = fakeConnection({
        resultRecords,
        fail: (op, sql) =>
          op === 'run' && sql?.includes('dup')
            ? { tag: 'execution-failed', val: { code: '23505', message: 'duplicate key' } }
            : undefined,
      });
      const db = createSqlDatabaseFromWasmPgliteConnection(connection);
      expect(isSqlDatabase(db)).toBe(true);
      expect(isMigrationDatabase(db)).toBe(true);

      expect(await db.run('INSERT INTO t VALUES (?, ?)', [1, { a: 1 }])).toEqual({ changes: 1 });
      expect(await db.query('SELECT n FROM t WHERE id = ?', [new Date(0)])).toEqual([{ n: 1 }]);
      expect(await db.first<{ n: number }>('SELECT n FROM t WHERE ok = ?', [true])).toEqual({
        n: 1,
      });
      expect(await db.query("SELECT '{}'::jsonb ? 'a'")).toEqual([{ n: 1 }]);
      await db.exec('CREATE TABLE t (id int)');
      expect(log).toEqual([
        'run INSERT INTO t VALUES ($1, $2)',
        'query SELECT n FROM t WHERE id = $1',
        'first SELECT n FROM t WHERE ok = $1',
        "query SELECT '{}'::jsonb ? 'a'",
        'exec CREATE TABLE t (id int)',
      ]);
      expect(params).toEqual([
        [
          { tag: 'integer', val: 1 },
          { tag: 'json', val: '{"a":1}' },
        ],
        [{ tag: 'timestamp', val: '1970-01-01T00:00:00.000Z' }],
        [{ tag: 'boolean', val: true }],
        [],
      ]);

      const failure = await db.run('INSERT dup', [1]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WasmPgliteError);
      expect((failure as WasmPgliteError).code).toBe('23505');

      await db.close?.();
      expect(log.at(-1)).toBe('close');
    });
  }

  test('surfaces an undefined-table execution-failed as code 42P01', async () => {
    const { connection } = fakeConnection({
      fail: (op) =>
        op === 'query'
          ? {
              tag: 'execution-failed',
              val: { code: '42P01', message: 'relation "t" does not exist' },
            }
          : undefined,
    });
    const db = createSqlDatabaseFromWasmPgliteConnection(connection);
    const failure = await db.query('SELECT * FROM t').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WasmPgliteError);
    expect((failure as WasmPgliteError).code).toBe('42P01');
    expect((failure as WasmPgliteError).message.startsWith('PostgreSQL 42P01')).toBe(true);
  });

  test('defaults parameters, missing rows, and missing change counts', async () => {
    const { connection } = fakeConnection({ rows: [], changes: undefined });
    const db = createSqlDatabaseFromWasmPgliteConnection(connection);
    expect(await db.run('DELETE FROM t')).toEqual({ changes: 0 });
    expect(await db.query('SELECT 1')).toEqual([]);
    expect(await db.first<{ n: number }>('SELECT 1')).toBeNull();
    const asyncDb = createSqlDatabaseFromWasmPgliteConnection({
      ...connection,
      run: async () => 3,
      first: async () => null,
    });
    expect(await asyncDb.run('x')).toEqual({ changes: 3 });
    expect(await asyncDb.first('x')).toBeNull();
  });

  test('commits transactions and rolls back when the callback throws', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(connection);
    expect(
      await db.transaction(async (tx) => {
        await tx.run('INSERT ?', [1]);
        await tx.exec('SELECT 1');
        expect(await tx.first<{ n: number }>('SELECT ?', [1])).toEqual({ n: 1 });
        expect(await tx.query('SELECT ?', [1])).toEqual([{ n: 1 }]);
        // Statements on the outer handle from inside the callback join it.
        await db.run('UPDATE ?', [2]);
        return 'done';
      }),
    ).toBe('done');
    await expect(
      db.transaction(async (tx) => {
        await tx.run('INSERT ?', [3]);
        throw new Error('rollback please');
      }),
    ).rejects.toThrow('rollback please');
    expect(log).toEqual([
      'BEGIN',
      'run INSERT $1',
      'exec SELECT 1',
      'first SELECT $1',
      'query SELECT $1',
      'run UPDATE $1',
      'COMMIT',
      'BEGIN',
      'run INSERT $1',
      'ROLLBACK',
    ]);
  });

  test('a failed commit rolls back and a failed rollback keeps the original error', async () => {
    const commitFails = fakeConnection({
      fail: (op) =>
        op === 'COMMIT'
          ? { tag: 'execution-failed', val: { code: '23505', message: 'deferred' } }
          : undefined,
    });
    const db = createSqlDatabaseFromWasmPgliteConnection(commitFails.connection);
    await expect(db.transaction(async () => 1)).rejects.toThrow('PostgreSQL 23505 deferred');
    expect(commitFails.log).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);

    const rollbackFails = fakeConnection({
      resultRecords: true,
      fail: (op) =>
        op === 'ROLLBACK' || op === 'ROLLBACK TO'
          ? { tag: 'invalid-transaction-state', val: 'none' }
          : undefined,
    });
    const other = createSqlDatabaseFromWasmPgliteConnection(rollbackFails.connection);
    await expect(
      other.transaction(async (tx) => {
        await expect(
          tx.transaction(async () => {
            throw new Error('inner');
          }),
        ).rejects.toThrow('inner');
        throw new Error('outer');
      }),
    ).rejects.toThrow('outer');
    expect(rollbackFails.log).toEqual([
      'BEGIN',
      'SAVEPOINT di_sp_1',
      'ROLLBACK TO di_sp_1',
      'ROLLBACK',
    ]);

    const beginFails = fakeConnection({
      fail: (op) => (op === 'BEGIN' ? { tag: 'connection-lost', val: 'trap' } : undefined),
    });
    const lost = createSqlDatabaseFromWasmPgliteConnection(beginFails.connection);
    let ran = false;
    await expect(
      lost.transaction(async () => {
        ran = true;
      }),
    ).rejects.toThrow('PGlite connection-lost: trap');
    expect(ran).toBe(false);
    expect(beginFails.log).toEqual(['BEGIN']);
  });

  test('nested transactions use savepoints that roll back on their own', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(connection);
    await db.transaction(async (tx) => {
      await tx.transaction(async (nested) => {
        await nested.run('INSERT ?', ['a']);
        await nested.transaction(async (deeper) => {
          await deeper.run('INSERT ?', ['b']);
        });
      });
      await expect(
        db.transaction(async (nested) => {
          await nested.run('INSERT ?', ['c']);
          throw new Error('drop c');
        }),
      ).rejects.toThrow('drop c');
      await tx.run('INSERT ?', ['d']);
    });
    expect(log).toEqual([
      'BEGIN',
      'SAVEPOINT di_sp_1',
      'run INSERT $1',
      'SAVEPOINT di_sp_2',
      'run INSERT $1',
      'RELEASE di_sp_2',
      'RELEASE di_sp_1',
      'SAVEPOINT di_sp_3',
      'run INSERT $1',
      'ROLLBACK TO di_sp_3',
      'run INSERT $1',
      'COMMIT',
    ]);
  });

  test('a parent view opened from inside a savepoint nests under the savepoint', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(connection);
    await db.transaction(async (tx) => {
      await tx.transaction(async () => {
        // `tx` is the outer view, but this call runs inside di_sp_1.
        await tx.transaction(async (inner) => {
          await inner.run('INSERT ?', [1]);
        });
      });
    });
    expect(log).toEqual([
      'BEGIN',
      'SAVEPOINT di_sp_1',
      'SAVEPOINT di_sp_2',
      'run INSERT $1',
      'RELEASE di_sp_2',
      'RELEASE di_sp_1',
      'COMMIT',
    ]);
  });

  test('sibling savepoints and concurrent transactions run one at a time', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(connection);
    await db.transaction(async (tx) => {
      await Promise.all([
        tx.transaction(async (a) => {
          await tick(5);
          await a.run('A ?', [1]);
        }),
        tx.transaction(async (b) => {
          await b.run('B ?', [1]);
        }),
      ]);
    });
    expect(log).toEqual([
      'BEGIN',
      'SAVEPOINT di_sp_1',
      'run A $1',
      'RELEASE di_sp_1',
      'SAVEPOINT di_sp_2',
      'run B $1',
      'RELEASE di_sp_2',
      'COMMIT',
    ]);

    log.length = 0;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = db.transaction(async (tx) => {
      await tx.run('INSIDE ?', [1]);
      await hold;
      throw new Error('drop');
    });
    await tick(5);
    const outside = db.run('OUTSIDE ?', [1]);
    const second = db.transaction(async (tx) => tx.run('SECOND ?', [1]));
    await tick(5);
    expect(log).toEqual(['BEGIN', 'run INSIDE $1']);
    release();
    await expect(first).rejects.toThrow('drop');
    await outside;
    await second;
    expect(log).toEqual([
      'BEGIN',
      'run INSIDE $1',
      'ROLLBACK',
      'run OUTSIDE $1',
      'BEGIN',
      'run SECOND $1',
      'COMMIT',
    ]);
  });

  test('a statement scheduled inside a transaction waits once that transaction has ended', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(connection);
    let leaked!: Promise<unknown>;
    await db.transaction(async (tx) => {
      await tx.run('FIRST ?', [1]);
      leaked = tick(5).then(() => db.run('LEAKED ?', [1]));
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const second = db.transaction(async (tx) => {
      await tx.run('SECOND ?', [1]);
      await hold;
      throw new Error('drop second');
    });
    await tick(15);
    // The leaked statement must not run inside the second transaction.
    expect(log).toEqual(['BEGIN', 'run FIRST $1', 'COMMIT', 'BEGIN', 'run SECOND $1']);
    release();
    await expect(second).rejects.toThrow('drop second');
    await leaked;
    expect(log.slice(5)).toEqual(['ROLLBACK', 'run LEAKED $1']);
  });

  test('a callback view kept past its transaction queues and opens new transactions', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(connection);
    let kept!: SqlDatabase;
    await db.transaction(async (tx) => {
      kept = tx;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const other = db.transaction(async (tx) => {
      await tx.run('OTHER ?', [1]);
      await hold;
      throw new Error('drop other');
    });
    await tick(5);
    const stale = kept.run('STALE ?', [1]);
    const staleTx = kept.transaction(async (tx) => tx.query('STALE TX ?', [1]));
    await tick(5);
    expect(log).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'run OTHER $1']);
    release();
    await expect(other).rejects.toThrow('drop other');
    await stale;
    expect(await staleTx).toEqual([{ n: 1 }]);
    expect(log.slice(4)).toEqual([
      'ROLLBACK',
      'run STALE $1',
      'BEGIN',
      'query STALE TX $1',
      'COMMIT',
    ]);
  });

  test('the callback view joins its open transaction from another async context', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(connection);
    // Created before the transaction, so it does not carry the transaction's context.
    const resource = new AsyncResource('outside');
    const worker = startWorker();
    const result = await withTimeout(
      db.transaction(async (tx) => {
        await resource.runInAsyncScope(() => tx.run('FROM RESOURCE ?', [1]));
        await worker.run(() => tx.query('FROM WORKER ?', [1]));
        await tx.transaction(async (sp) => {
          await worker.run(async () => {
            await sp.exec('SP FROM WORKER');
            await sp.transaction(async (deeper) => deeper.first('DEEPER ?', [1]));
          });
        });
        return 'ok';
      }),
    );
    await worker.stop();
    expect(result).toBe('ok');
    expect(log).toEqual([
      'BEGIN',
      'run FROM RESOURCE $1',
      'query FROM WORKER $1',
      'SAVEPOINT di_sp_1',
      'exec SP FROM WORKER',
      'SAVEPOINT di_sp_2',
      'first DEEPER $1',
      'RELEASE di_sp_2',
      'RELEASE di_sp_1',
      'COMMIT',
    ]);
    // The handle is still usable afterwards.
    await db.run('AFTER ?', [1]);
    expect(log.at(-1)).toBe('run AFTER $1');
  });

  test('a continuation that outlives its savepoint joins the still-open transaction', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(connection);
    await db.transaction(async (tx) => {
      let later!: Promise<unknown>;
      await tx.transaction(async (savepoint) => {
        await savepoint.run('IN SP ?', [1]);
        later = tick(5).then(async () => {
          await db.run('AFTER SP ?', [1]);
          await db.transaction(async (inner) => inner.run('NEW SP ?', [1]));
        });
      });
      await later;
    });
    expect(log).toEqual([
      'BEGIN',
      'SAVEPOINT di_sp_1',
      'run IN SP $1',
      'RELEASE di_sp_1',
      'run AFTER SP $1',
      'SAVEPOINT di_sp_2',
      'run NEW SP $1',
      'RELEASE di_sp_2',
      'COMMIT',
    ]);
  });

  /** `connection` with `op` (a promise-returning binding) that takes `ms` before it runs. */
  const slowing = <K extends 'commit' | 'rollback' | 'releaseSavepoint'>(
    connection: WasmPgliteConnection,
    op: K,
    ms = 15,
  ): WasmPgliteConnection => ({
    ...connection,
    [op]: ((...args: unknown[]) =>
      (async () => {
        await tick(ms);
        return (connection[op] as (...a: unknown[]) => unknown)(...args);
      })()) as WasmPgliteConnection[K],
  });
  /** Resolves with a promise that `fn` settles later; lets a test await work `fn` starts. */
  const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  test('a view statement issued while COMMIT is in flight runs after the transaction, in lock order', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(slowing(connection, 'commit'));
    const started = deferred<Promise<unknown>>();
    const done = db.transaction(async (tx) => {
      // Unawaited: fires while COMMIT is on the wire.
      started.resolve(tick(5).then(() => tx.run('LATE ?', [1])));
    });
    // Queued on the mutex before LATE is issued, so it must run first.
    const outer = db.run('OUTER ?', [1]);
    const late = await started.promise;
    await Promise.all([done, late, outer]);
    expect(log).toEqual(['BEGIN', 'COMMIT', 'run OUTER $1', 'run LATE $1']);
  });

  test('an outer-handle statement from the transaction context during COMMIT runs after it, in lock order', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(slowing(connection, 'commit'));
    const started = deferred<Promise<unknown>>();
    const done = db.transaction(async () => {
      // The timer continuation inherits the transaction's async context.
      started.resolve(tick(5).then(() => db.run('LATE OUTER ?', [1])));
    });
    const waiting = db.run('WAITING ?', [1]);
    const late = await started.promise;
    await Promise.all([done, late, waiting]);
    expect(log).toEqual(['BEGIN', 'COMMIT', 'run WAITING $1', 'run LATE OUTER $1']);
  });

  test('a statement issued while ROLLBACK is in flight runs after it, in lock order', async () => {
    for (const via of ['view', 'outer'] as const) {
      const { connection, log } = fakeConnection();
      const db = createSqlDatabaseFromWasmPgliteConnection(slowing(connection, 'rollback'));
      const started = deferred<Promise<unknown>>();
      const done = db.transaction(async (tx) => {
        started.resolve(tick(5).then(() => (via === 'view' ? tx : db).run('LATE ?', [1])));
        throw new Error('fail');
      });
      const waiting = db.run('WAITING ?', [1]);
      const late = await started.promise;
      await expect(done).rejects.toThrow('fail');
      await Promise.all([late, waiting]);
      expect(log).toEqual(['BEGIN', 'ROLLBACK', 'run WAITING $1', 'run LATE $1']);
    }
  });

  test('a savepoint view retained by an earlier worker, used while RELEASE is in flight, joins the open parent', async () => {
    const { connection, log } = fakeConnection();
    // Promise-returning bindings, as componentized hosts provide.
    const asyncConnection = slowing(
      {
        ...connection,
        run: ((...args: Parameters<WasmPgliteConnection['run']>) =>
          Promise.resolve(connection.run(...args))) as WasmPgliteConnection['run'],
      },
      'releaseSavepoint',
    );
    const db = createSqlDatabaseFromWasmPgliteConnection(asyncConnection);
    const worker = startWorker();
    const result = await withTimeout(
      db.transaction(async (tx) => {
        let late!: Promise<void>;
        await tx.transaction(async (savepoint) => {
          // Runs in the worker's context, after the savepoint callback returned.
          late = worker.run(async () => {
            await tick(5);
            await savepoint.run('LATE ?', [1]);
          });
        });
        // The root callback waits on the worker; the mutex is held until it returns.
        await late;
        return 'ok';
      }),
    );
    await worker.stop();
    expect(result).toBe('ok');
    expect(log).toEqual(['BEGIN', 'SAVEPOINT di_sp_1', 'RELEASE di_sp_1', 'run LATE $1', 'COMMIT']);
  });

  test('a transaction opened on a closed savepoint view, awaited by the root callback, nests on the parent', async () => {
    const { connection, log } = fakeConnection();
    const db = createSqlDatabaseFromWasmPgliteConnection(slowing(connection, 'releaseSavepoint'));
    const worker = startWorker();
    const result = await withTimeout(
      db.transaction(async (tx) => {
        let late!: Promise<void>;
        await tx.transaction(async (savepoint) => {
          late = worker.run(async () => {
            await tick(5);
            await savepoint.transaction(async (inner) => {
              await inner.run('LATE ?', [1]);
            });
          });
        });
        await late;
        return 'ok';
      }),
    );
    await worker.stop();
    expect(result).toBe('ok');
    expect(log).toEqual([
      'BEGIN',
      'SAVEPOINT di_sp_1',
      'RELEASE di_sp_1',
      'SAVEPOINT di_sp_2',
      'run LATE $1',
      'RELEASE di_sp_2',
      'COMMIT',
    ]);
  });

  test('a transaction requested from the context of BEGIN waits for the open transaction', async () => {
    const { connection, log } = fakeConnection();
    const reentrant = deferred<Promise<unknown>>();
    let db!: SqlDatabase;
    const withBegin: WasmPgliteConnection = {
      ...connection,
      begin: () => {
        // Runs in the root transaction's async context, before its callback.
        if (log.length === 0) {
          reentrant.resolve(db.transaction(async (inner) => inner.run('REENTRANT ?', [1])));
        }
        return connection.begin();
      },
    };
    db = createSqlDatabaseFromWasmPgliteConnection(withBegin);
    await withTimeout(
      db.transaction(async (tx) => {
        await tx.run('OUTER ?', [1]);
        await tick(5);
        await tx.run('OUTER 2 ?', [1]);
      }),
    );
    await withTimeout(reentrant.promise);
    expect(log).toEqual([
      'BEGIN',
      'run OUTER $1',
      'run OUTER 2 $1',
      'COMMIT',
      'BEGIN',
      'run REENTRANT $1',
      'COMMIT',
    ]);
  });

  test('statements issued together inside a transaction reach an async binding one at a time', async () => {
    const { connection, log } = fakeConnection();
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = <A extends unknown[], R>(fn: (...args: A) => R) =>
      (async (...args: A) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick(1);
        try {
          return await fn(...args);
        } finally {
          inFlight--;
        }
      }) as unknown as (...args: A) => R;
    const asyncConnection: WasmPgliteConnection = {
      ...connection,
      run: slow(connection.run),
      query: slow(connection.query),
      exec: slow(connection.exec),
    };
    const db = createSqlDatabaseFromWasmPgliteConnection(asyncConnection);
    await db.transaction(async (tx) => {
      await Promise.all([tx.run('A ?', [1]), tx.query('B ?', [2]), tx.exec('C')]);
    });
    expect(maxInFlight).toBe(1);
    expect(log).toEqual(['BEGIN', 'run A $1', 'query B $1', 'exec C', 'COMMIT']);
  });
});

describe('createWasmPgliteDatabase', () => {
  function fakeModule(fail = false) {
    const opened: Array<{ path: string; options: WasmPgliteOpenOptions | undefined }> = [];
    const { connection, log } = fakeConnection();
    const module: WasmPgliteModule = {
      open(path, options) {
        opened.push({ path, options });
        if (fail) throw { tag: 'open-failed', val: 'read-only storage' };
        return { tag: 'ok', val: connection };
      },
    };
    return { module, opened, log };
  }

  test('opens the provider default root unless the caller names one', async () => {
    expect(WASM_PGLITE_DEFAULT_ROOT).toBe('/data/pglite');
    expect(WASM_PGLITE_MODULE_ID).toBe('di-framework:pglite/database@0.2.0');
    const { module, opened, log } = fakeModule();
    const db = await createWasmPgliteDatabase(undefined, { module });
    expect(await db.first<{ n: number }>('SELECT ?', [1])).toEqual({ n: 1 });
    await createWasmPgliteDatabase('/data/identity', {
      loadModule: async () => module,
      database: 'template1',
      statementTimeoutMs: 0,
    });
    expect(opened).toEqual([
      { path: '', options: undefined },
      { path: '/data/identity', options: { database: 'template1', statementTimeoutMs: 0 } },
    ]);
    expect(log).toEqual(['first SELECT $1']);
    // The adapter imports the interface this package's WIT declares.
    expect(WASM_PGLITE_MODULE_ID).toBe(
      databaseInterface(await readWitVersion(join(import.meta.dir, '..'))),
    );
  });

  test('reports open failures and a missing provider import', async () => {
    const { module } = fakeModule(true);
    await expect(createWasmPgliteDatabase('/data/x', { module })).rejects.toThrow(
      'PGlite open-failed: read-only storage',
    );
    await expect(createWasmPgliteDatabase('/data/x')).rejects.toThrow(
      /di-framework:pglite\/database@0\.2\.0 import is unavailable/,
    );
    // The failed import is not cached.
    await expect(createWasmPgliteDatabase('/data/x')).rejects.toThrow(/import is unavailable/);
  });
});
