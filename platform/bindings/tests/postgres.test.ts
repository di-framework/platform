import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { text } from '@di-framework/repo/postgres';
import { Postgres, type PostgresGuest } from '../src/bindings/postgres.ts';
import { BINDING_CATALOG } from '../src/catalog.ts';
import {
  type AutocommitDatabase,
  atomicBatch,
  bindParams,
  openPostgresDatabase,
} from '../src/postgres/index.ts';

const cell = (val: string) => ({ tag: 'text' as const, val });

function table(columns: readonly string[], rows: readonly unknown[][]): unknown {
  return [columns, rows, null];
}

type RecordedCall = {
  connection: number;
  method: 'query' | 'queryBatch';
  sql: string;
  params?: readonly unknown[];
};

function rotatingGuest(
  options: {
    query?: (sql: string, params: readonly unknown[]) => Promise<unknown>;
    queryBatch?: (sql: string) => Promise<unknown>;
  } = {},
): { guest: PostgresGuest; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let next = 0;
  const guest: PostgresGuest = {
    async query(sql, params) {
      const connection = next % 2;
      next += 1;
      calls.push({ connection, method: 'query', sql, params });
      if (options.query) return options.query(sql, params);
      return table(['one'], [[cell('1')]]);
    },
    async queryBatch(sql) {
      const connection = next % 2;
      next += 1;
      calls.push({ connection, method: 'queryBatch', sql });
      if (options.queryBatch) return options.queryBatch(sql);
      return undefined;
    },
  };
  return { guest, calls };
}

const TRANSACTION_BOUNDARY = /^(BEGIN|COMMIT|ROLLBACK)\b/i;

/**
 * One pooled client on the simple-query protocol.
 *
 * `BEGIN` inside the batch string opens a transaction block. A later error skips
 * the rest of the string, including `COMMIT`, and the client returns to the pool
 * aborted. A multi-statement string with no transaction-control command is one
 * implicit transaction: Postgres rolls it back on error and returns the client idle.
 */
function simpleQueryPool(): {
  guest: PostgresGuest;
  session: () => 'idle' | 'aborted';
  batches: string[];
} {
  const state: { session: 'idle' | 'aborted' } = { session: 'idle' };
  const batches: string[] = [];
  const fail = (code: string, message: string): never => {
    throw new Error(`PostgreSQL ${code} ${message}`);
  };
  const guest: PostgresGuest = {
    async query() {
      if (state.session === 'aborted') fail('25P02', 'current transaction is aborted');
      return table(['one'], [[cell('1')]]);
    },
    async queryBatch(sql) {
      batches.push(sql);
      if (state.session === 'aborted') fail('25P02', 'current transaction is aborted');
      const statements = sql
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      let explicit = false;
      try {
        for (const statement of statements) {
          if (/^BEGIN\b/i.test(statement)) {
            explicit = true;
            continue;
          }
          if (/^(COMMIT|ROLLBACK)\b/i.test(statement)) {
            explicit = false;
            state.session = 'idle';
            continue;
          }
          if (statement.includes("'dup'")) fail('23505', 'duplicate key value');
        }
        state.session = 'idle';
      } catch (error) {
        state.session = explicit ? 'aborted' : 'idle';
        throw error;
      }
      return undefined;
    },
  };
  return { guest, session: () => state.session, batches };
}

describe('bindParams', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('inlines uuid strings and safe integers and binds the rest', () => {
    expect(bindParams('SELECT 1')).toEqual({ text: 'SELECT 1', params: [] });
    expect(bindParams('SELECT ?', [])).toEqual({ text: 'SELECT ?', params: [] });
    expect(bindParams('INSERT INTO t VALUES (?, ?, ?, ?)', ['acme', id, true, 1.5])).toEqual({
      text: `INSERT INTO t VALUES ($1, '${id}', $2, $3)`,
      params: [text('acme'), { tag: 'bool', val: true }, { tag: 'numeric', val: '1.5' }],
    });
    expect(bindParams('SELECT ?', [id.toUpperCase()])).toEqual({
      text: `SELECT '${id.toUpperCase()}'`,
      params: [],
    });
    expect(bindParams('SELECT x - ? LIMIT ? OFFSET ?', [-5, 25, 7n])).toEqual({
      text: 'SELECT x - (-5) LIMIT 25 OFFSET 7',
      params: [],
    });
    expect(bindParams('SELECT ?', [-7n])).toEqual({ text: 'SELECT (-7)', params: [] });
    expect(() => bindParams('SELECT ?', [2 ** 53])).toThrow('not an exact integer');
    expect(() => bindParams('SELECT ?', ['a', 'b'])).toThrow(
      'placeholder count 1 does not match 2',
    );
  });
});

describe('autocommit adapter', () => {
  function database(): { sql: AutocommitDatabase; calls: RecordedCall[] } {
    const { guest, calls } = rotatingGuest({
      query: async (sql) => {
        if (sql.includes('ALREADY')) throw new Error('PostgreSQL already failed');
        if (sql.includes('ERRVAR')) {
          return { tag: 'err', val: { code: '23505', message: 'duplicate key value' } };
        }
        if (sql.includes('DUPLICATE')) throw { code: '23505', message: 'duplicate key value' };
        if (sql.includes('EMPTY')) return table(['one'], []);
        if (sql.includes('AS tx')) return table(['tx'], [[cell('9')]]);
        if (sql.includes('RETURNING')) return table(['one'], [[cell('1')]]);
        return table(['one'], [[cell('1')]]);
      },
      queryBatch: async (sql) => {
        if (sql.includes('BAD BATCH')) {
          return { tag: 'err', val: { code: '42601', message: 'syntax' } };
        }
        if (sql.includes('DOWN')) throw { message: 'down' };
        return undefined;
      },
    });
    return { sql: openPostgresDatabase(guest), calls };
  }

  it('binds parameters and never opens a transaction', async () => {
    const { sql, calls } = database();
    expect(await sql.query<{ tx: string }>('SELECT ? AS tx', ['acme'])).toEqual([{ tx: '9' }]);
    expect(await sql.first<{ tx: string }>('SELECT ? AS tx', ['acme'])).toEqual({ tx: '9' });
    expect(await sql.first('SELECT EMPTY')).toBeNull();
    expect((await sql.run('DELETE FROM t WHERE id = ? RETURNING 1', ['a'])).changes).toBe(1);
    expect((await sql.run('SELECT 1')).changes).toBe(1);
    await expect(sql.run('INSERT DUPLICATE INTO t VALUES (?)', ['a'])).rejects.toMatchObject({
      code: '23505',
    });
    await expect(sql.query('SELECT ALREADY')).rejects.toThrow('PostgreSQL already failed');
    await expect(sql.query('SELECT ERRVAR')).rejects.toMatchObject({ code: '23505' });
    await sql.exec('CREATE TABLE t (id text)');
    await expect(sql.exec('BAD BATCH')).rejects.toMatchObject({ code: '42601' });
    await expect(sql.exec('DOWN')).rejects.toThrow('PostgreSQL down');
    expect(
      await sql.transaction(async (tx) => {
        expect(tx).toBe(sql);
        return tx.transaction(async (inner) =>
          inner.first<{ tx: string }>('SELECT ? AS tx', ['x']),
        );
      }),
    ).toEqual({ tx: '9' });
    await expect(
      sql.transaction(async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    expect(calls.filter((call) => TRANSACTION_BOUNDARY.test(call.sql.trim()))).toEqual([]);
    expect(new Set(calls.map((call) => call.connection))).toEqual(new Set([0, 1]));
    expect(calls.filter((call) => call.method === 'queryBatch').map((call) => call.sql)).toEqual([
      'CREATE TABLE t (id text)',
      'BAD BATCH',
      'DOWN',
    ]);
    const bound = calls.find((call) => call.sql === 'SELECT $1 AS tx');
    expect(bound?.params).toEqual([text('acme')]);
    expect(calls.some((call) => call.method === 'query' && call.sql.includes('BEGIN'))).toBe(false);
  });

  it('accepts a Postgres binding instance', async () => {
    const { guest, calls } = rotatingGuest();
    const sql = openPostgresDatabase(new Postgres(guest));
    expect(await sql.query('SELECT 1')).toEqual([{ one: '1' }]);
    expect(calls.map((call) => call.method)).toEqual(['query']);
  });
});

describe('atomicBatch', () => {
  it('returns the pooled connection idle when a statement fails', async () => {
    const pool = simpleQueryPool();
    const sql = openPostgresDatabase(pool.guest);
    await expect(
      sql.atomicBatch([
        { sql: 'INSERT INTO t (id) VALUES (?)', params: ['a'] },
        { sql: 'INSERT INTO t (id) VALUES (?)', params: ['dup'] },
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    expect(pool.session()).toBe('idle');
    await expect(sql.query('SELECT 1')).resolves.toEqual([{ one: '1' }]);
    expect(pool.batches).toEqual([
      ["INSERT INTO t (id) VALUES ('a')", "INSERT INTO t (id) VALUES ('dup')"].join(';\n') + ';',
    ]);
  });

  it('escapes quotes and parenthesizes a negative integer', async () => {
    const { guest, calls } = rotatingGuest();
    const sql = openPostgresDatabase(guest);
    await sql.atomicBatch([
      { sql: 'INSERT INTO note (body, n) VALUES (?, ?);', params: ["o'brien", -5] },
      { sql: 'SELECT x-?', params: [-1] },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('queryBatch');
    expect(calls[0]?.sql).toBe(
      ["INSERT INTO note (body, n) VALUES ('o''brien', (-5))", 'SELECT x-(-1)'].join(';\n') + ';',
    );
    expect(calls[0]?.sql.includes('--')).toBe(false);
  });

  it('renders the other literal kinds on one batch call', async () => {
    const { guest, calls } = rotatingGuest();
    const id = '11111111-1111-4111-8111-111111111111';
    await atomicBatch(guest, [
      {
        sql: 'INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [null, true, false, 'plain', id, 7n, -8n, 25, 1.5, -2.5],
      },
      {
        sql: 'INSERT INTO b VALUES (?, ?, ?, ?)',
        params: [
          new Date('2020-01-02T03:04:05.006Z'),
          new Uint8Array([0, 255]),
          { name: "a'b" },
          'a\\b',
        ],
      },
      { sql: 'SELECT 1' },
    ]);
    expect(calls).toHaveLength(1);
    const batch = calls[0]?.sql ?? '';
    expect(batch.split('\n').some((line) => TRANSACTION_BOUNDARY.test(line))).toBe(false);
    expect(batch.endsWith(';')).toBe(true);
    expect(batch).toContain('NULL');
    expect(batch).toContain('true');
    expect(batch).toContain('false');
    expect(batch).toContain("'plain'");
    expect(batch).toContain(`'${id}'`);
    expect(batch).toContain('7');
    expect(batch).toContain('(-8)');
    expect(batch).toContain('25');
    expect(batch).toContain('1.5');
    expect(batch).toContain('(-2.5)');
    expect(batch).toContain("'2020-01-02T03:04:05.006Z'");
    expect(batch).toContain("decode('00ff', 'hex')");
    expect(batch).toContain(`'{"name":"a''b"}'`);
    expect(batch).toContain("'a\\b'");
    expect(batch).toContain('SELECT 1');
    expect(batch.includes('--')).toBe(false);
  });

  it('keeps a sqlstate when the batch fails', async () => {
    const { guest } = rotatingGuest({
      queryBatch: async () => ({
        tag: 'err',
        val: { code: '23505', message: 'duplicate key value' },
      }),
    });
    await expect(atomicBatch(guest, [{ sql: 'INSERT INTO t VALUES (1)' }])).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('rejects a batch that cannot be rendered', async () => {
    const { guest, calls } = rotatingGuest({
      queryBatch: async () => {
        throw new Error('batch should not run');
      },
    });
    const box: { self?: unknown } = {};
    box.self = box;
    await expect(atomicBatch(guest, [])).rejects.toThrow('at least one statement');
    await expect(atomicBatch(guest, [{ sql: '   ;  ' }])).rejects.toThrow('statement is empty');
    await expect(atomicBatch(guest, [{ sql: 'SELECT ?', params: ['a', 'b'] }])).rejects.toThrow(
      'placeholder count 1 does not match 2',
    );
    await expect(atomicBatch(guest, [{ sql: 'SELECT ?', params: [2 ** 53] }])).rejects.toThrow(
      'not an exact integer',
    );
    await expect(atomicBatch(guest, [{ sql: 'SELECT ?', params: [Number.NaN] }])).rejects.toThrow(
      'not a finite number',
    );
    await expect(
      atomicBatch(guest, [{ sql: 'SELECT ?', params: [new Date('nope')] }]),
    ).rejects.toThrow('wrong type');
    await expect(atomicBatch(guest, [{ sql: 'SELECT ?', params: ['a\0b'] }])).rejects.toThrow(
      'null byte',
    );
    await expect(atomicBatch(guest, [{ sql: 'SELECT ?', params: [box] }])).rejects.toThrow(
      'cannot be rendered',
    );
    await expect(
      atomicBatch(guest, [{ sql: 'SELECT ?', params: [{ toJSON: () => undefined }] }]),
    ).rejects.toThrow('cannot be rendered');
    await expect(atomicBatch(guest, [{ sql: 'SELECT ?', params: [Symbol('x')] }])).rejects.toThrow(
      'cannot be rendered',
    );
    expect(calls).toEqual([]);
  });
});

describe('postgres subpath packaging', () => {
  it('keeps repo off the main entry and describes the subpath', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, Record<string, string>>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
      devDependencies: Record<string, string>;
    };
    expect(packageJson.exports['./postgres']).toEqual({
      types: './dist/postgres/index.d.ts',
      bun: './dist/postgres/index.js',
      import: './dist/postgres/index.js',
      default: './dist/postgres/index.js',
    });
    expect(packageJson.peerDependencies['@di-framework/repo']).toBe('^6.0.4');
    expect(packageJson.peerDependenciesMeta['@di-framework/repo']?.optional).toBe(true);
    expect(packageJson.devDependencies['@di-framework/repo']).toBe('^6.0.4');

    const root = new URL('../src/', import.meta.url);
    const offenders = sourceFiles(root).filter((file) =>
      readFileSync(file, 'utf8').includes('@di-framework/repo'),
    );
    expect(offenders).toEqual([]);
    expect(BINDING_CATALOG.Postgres.interfaces).toEqual(['query', 'prepared', 'types']);
    expect(BINDING_CATALOG.Postgres.package).toBe('wasmcloud:postgres');
  });
});

function sourceFiles(directory: URL): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'postgres') continue;
    const path = join(directory.pathname, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(new URL(`${entry.name}/`, directory)));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}
