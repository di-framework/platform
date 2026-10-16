/**
 * `SqlDatabase` adapter for the `di-framework:pglite/database@0.2.0` WIT
 * import: embedded PostgreSQL 17 bundled into a provider component. The guest
 * exchanges `value` variants over one exclusive connection, so every call is
 * serialized through an async mutex.
 *
 * Repositories and migrations write `?` placeholders; they are rewritten to
 * PostgreSQL's `$1`, `$2`, ... (see {@link toPgPlaceholders}). Transactions use
 * the provider's `begin`/`commit`/`rollback`, and nested `transaction()` calls
 * open savepoints. Result values match the `wasmcloud:postgres` codec in
 * `@di-framework/repo` (`pgScalar`): JSON is parsed, `timestamptz` becomes an ISO string with
 * milliseconds, and an `int8` outside the safe integer range becomes a decimal
 * string. A Postgres error keeps its SQLSTATE in `error.code`.
 *
 * Component bindings differ in how they surface `result<T, error>`: some
 * return `{ tag: 'ok' | 'err', val }` records, others throw an error object
 * carrying the variant as `payload`. Both shapes are normalized here.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  AsyncMutex,
  guardedStatements,
  isWasmResult,
  leaseGuard,
  SQL_DATABASE_BRAND,
  type SqlDatabase,
  type SqlGuard,
  type SqlLease,
  type SqlRow,
  type SqlStatementCalls,
  type WasmMaybeResult,
  type WasmResult,
  wasmBlobBytes,
} from '@di-framework/repo';

export const WASM_PGLITE_MODULE_ID = 'di-framework:pglite/database@0.2.0';

/** Database root the provider selects when `open` receives an empty path. */
export const WASM_PGLITE_DEFAULT_ROOT = '/data/pglite';

export type WasmPgValue =
  | { tag: 'null'; val?: undefined }
  | { tag: 'integer'; val: bigint | number }
  | { tag: 'real'; val: number }
  | { tag: 'text'; val: string }
  | { tag: 'blob'; val: Uint8Array | ArrayLike<number> }
  | { tag: 'boolean'; val: boolean }
  | { tag: 'json'; val: string }
  | { tag: 'timestamp'; val: string };

export type WasmPgRow = Array<[string, WasmPgValue]>;

/**
 * Guest-side view of the `connection` resource.
 *
 * TODO(#153): members use method syntax, so `tsc` compares their parameters
 * bivariantly and the drift guard does not notice a removed or narrowed `value`
 * case. Declare them as property signatures (`strictFunctionTypes`) once
 * `integer` stops allowing `number`.
 */
export interface WasmPgliteConnection {
  exec(sql: string): WasmMaybeResult<void>;
  run(sql: string, params: WasmPgValue[]): WasmMaybeResult<bigint | number>;
  query(sql: string, params: WasmPgValue[]): WasmMaybeResult<WasmPgRow[]>;
  first(sql: string, params: WasmPgValue[]): WasmMaybeResult<WasmPgRow | undefined | null>;
  begin(): WasmMaybeResult<void>;
  commit(): WasmMaybeResult<void>;
  rollback(): WasmMaybeResult<void>;
  savepoint(name: string): WasmMaybeResult<void>;
  releaseSavepoint(name: string): WasmMaybeResult<void>;
  rollbackToSavepoint(name: string): WasmMaybeResult<void>;
  close(): WasmMaybeResult<void>;
}

/** The `open-options` record. Every field is optional. */
export interface WasmPgliteOpenOptions {
  /**
   * Session database: `postgres` or `template1`. Unset selects the data
   * directory's default: `postgres` for a directory the provider initialized
   * (it writes a `di-framework-database` marker in PGDATA), `template1` for
   * one created by an earlier release. The provider rejects `template0` and
   * any other name.
   */
  database?: string;
  /** Reserved by the provider: only `0` (or unset) is accepted. */
  statementTimeoutMs?: number;
}

/** Guest-side view of the `database` interface module. */
export interface WasmPgliteModule {
  open(path: string, options?: WasmPgliteOpenOptions): WasmMaybeResult<WasmPgliteConnection>;
}

/** The `pg-error` record carried by `execution-failed`. */
export interface WasmPgliteErrorRecord {
  code?: string;
  message?: string;
}

export interface WasmPgliteErrorPayload {
  tag: string;
  val?: string | WasmPgliteErrorRecord;
}

/**
 * A provider error. `code` is the SQLSTATE for `execution-failed` (for example
 * `23505` for a unique violation). The message then starts with
 * `PostgreSQL <code>`, the format `isUniqueViolation` from `@di-framework/repo` reads.
 */
export class WasmPgliteError extends Error {
  readonly tag: string;
  readonly detail?: string;
  readonly code?: string;

  constructor(payload: WasmPgliteErrorPayload, cause?: unknown) {
    let detail: string | undefined;
    let code: string | undefined;
    if (typeof payload.val === 'string') {
      detail = payload.val;
    } else if (typeof payload.val === 'object' && payload.val !== null) {
      detail = payload.val.message;
      code = payload.val.code || undefined;
    }
    super(wasmPgliteErrorMessage(payload.tag, code, detail), { cause });
    this.name = 'WasmPgliteError';
    this.tag = payload.tag;
    this.detail = detail;
    this.code = code;
  }
}

function wasmPgliteErrorMessage(tag: string, code?: string, detail?: string): string {
  if (code) return detail ? `PostgreSQL ${code} ${detail}` : `PostgreSQL ${code}`;
  return detail ? `PGlite ${tag}: ${detail}` : `PGlite ${tag}`;
}

function isErrorPayload(value: unknown): value is WasmPgliteErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { tag?: unknown }).tag === 'string' &&
    (value as { tag: string }).tag !== 'ok'
  );
}

/** Normalizes a thrown binding error or an `err` payload into an `Error`. */
export function normalizeWasmPgliteError(error: unknown): Error {
  if (error instanceof WasmPgliteError) return error;
  if (isErrorPayload(error)) return new WasmPgliteError(error);
  if (typeof error === 'object' && error !== null) {
    const payload = (error as { payload?: unknown }).payload;
    if (isErrorPayload(payload)) return new WasmPgliteError(payload, error);
  }
  if (typeof error === 'string') return new WasmPgliteError({ tag: 'other', val: error });
  return error instanceof Error ? error : new Error(String(error));
}

/** Unwraps `{ tag: 'ok' | 'err' }` records; passes bare values through. */
export function unwrapWasmPgliteResult<T>(value: T | WasmResult<T>): T {
  if (isWasmResult<T>(value)) {
    if (value.tag === 'err') throw normalizeWasmPgliteError(value.val);
    return value.val;
  }
  return value as T;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_INT8 = 2n ** 63n - 1n;
const MIN_INT8 = -(2n ** 63n);

/**
 * Converts a bound JavaScript parameter into a `value` variant.
 *
 * - `bigint` in the `int8` range becomes `integer` with a `bigint` payload, so
 *   values past 2^53 reach PostgreSQL exact (componentize-qjs 0.4.4-di.5 and jco
 *   lower WIT `s64` from `BigInt`). A `bigint` outside the `int8` range is sent
 *   as `text` (OID 0), so PostgreSQL parses it for a `numeric` column instead
 *   of the binding wrapping it modulo 2^64.
 * - A safe integer `number` becomes `integer` too, as a `bigint`. A `number`
 *   that is an integer outside the safe range throws a `TypeError` (pass a
 *   `bigint` or string for `int8`); other non-safe numbers, including NaN and
 *   Infinity, are `real` (`float8`).
 * - `Date` becomes `timestamp` (RFC 3339 UTC); plain objects and arrays become
 *   `json`. Arrays are not PostgreSQL arrays: pass a literal such as `'{a,b}'`.
 */
export function toWasmPgValue(value: unknown): WasmPgValue {
  if (value === null || value === undefined) return { tag: 'null' };
  switch (typeof value) {
    case 'bigint':
      // WIT s64 is lowered from BigInt (componentize-qjs 0.4.4-di.5, jco), so
      // int8 values keep every bit; only values outside s64 fall back to text.
      if (value >= MIN_INT8 && value <= MAX_INT8) {
        return { tag: 'integer', val: value };
      }
      return { tag: 'text', val: value.toString() };
    case 'number':
      if (Number.isSafeInteger(value)) {
        return { tag: 'integer', val: BigInt(value) };
      }
      if (Number.isInteger(value)) {
        // An integral double past 2^53 has already lost its low bits, and the
        // column is most likely int8; sending float8 would fail or round silently.
        throw new TypeError(
          `Cannot bind ${value} as a PostgreSQL parameter: it is an integer outside the safe range. Pass a bigint or a decimal string for int8 (or a string such as '1e300' for float8)`,
        );
      }
      // Fractions, NaN and +/-Infinity are valid float8 values in PostgreSQL.
      return { tag: 'real', val: value };
    case 'boolean':
      return { tag: 'boolean', val: value };
    case 'string':
      return { tag: 'text', val: value };
    case 'object':
      return toWasmPgObject(value as object);
  }
  throw new TypeError(
    `Cannot bind ${typeof value} as a PostgreSQL parameter; use null, number, bigint, boolean, string, Date, Uint8Array, or a JSON object`,
  );
}

function toWasmPgObject(value: object): WasmPgValue {
  const bytes = wasmBlobBytes(value);
  if (bytes) return { tag: 'blob', val: bytes };
  if (!(value instanceof Date)) return { tag: 'json', val: JSON.stringify(value) };
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('Cannot bind an invalid Date as a PostgreSQL parameter');
  }
  return { tag: 'timestamp', val: value.toISOString() };
}

const RFC3339_UTC = /^(\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

/**
 * Formats a `timestamp` variant the way the `wasmcloud:postgres` codec does:
 * `YYYY-MM-DDTHH:MM:SS.mmmZ`. Microseconds are truncated to milliseconds.
 * `infinity` and `-infinity` are returned unchanged. (The provider returns BC dates and other
 * values it cannot express in RFC 3339 as `text`, so they never reach this function.)
 */
export function pgliteTimestampIso(value: string): string {
  const match = RFC3339_UTC.exec(value);
  if (!match) return value;
  const millis = (match[2] ?? '').padEnd(3, '0').slice(0, 3);
  return `${match[1]}.${millis}Z`;
}

/** Converts a `value` variant into what the `wasmcloud:postgres` codec in `@di-framework/repo` returns. */
export function fromWasmPgValue(value: WasmPgValue): unknown {
  switch (value.tag) {
    case 'null':
      return null;
    case 'integer': {
      if (typeof value.val === 'number') return value.val;
      return value.val >= MIN_SAFE && value.val <= MAX_SAFE
        ? Number(value.val)
        : value.val.toString();
    }
    case 'real':
    case 'text':
    case 'boolean':
      return value.val;
    case 'blob':
      return value.val instanceof Uint8Array ? value.val : Uint8Array.from(value.val);
    case 'json':
      try {
        return JSON.parse(value.val) as unknown;
      } catch {
        return value.val;
      }
    case 'timestamp':
      return pgliteTimestampIso(value.val);
    default:
      throw new WasmPgliteError({
        tag: 'value-conversion-failed',
        val: `Unknown value tag ${String((value as { tag?: unknown }).tag)}`,
      });
  }
}

export function toWasmPgParams(params: readonly unknown[] = []): WasmPgValue[] {
  return params.map((param) => toWasmPgValue(param));
}

export function fromWasmPgRow(row: WasmPgRow): SqlRow {
  const result: SqlRow = {};
  for (const [column, value] of row) {
    result[column] = fromWasmPgValue(value);
  }
  return result;
}

const IDENTIFIER_CHAR = /[\w$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_]\w*)?\$/;
const POSITIONAL = /^\$\d+/;

function skipQuoted(sql: string, start: number, quote: string, backslashes: boolean): number {
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (backslashes && char === '\\') {
      index += 2;
    } else if (char === quote) {
      if (sql[index + 1] !== quote) return index + 1;
      index += 2;
    } else {
      index++;
    }
  }
  return sql.length;
}

function skipBlockComment(sql: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < sql.length) {
    if (sql.startsWith('/*', index)) {
      depth++;
      index += 2;
    } else if (sql.startsWith('*/', index)) {
      depth--;
      index += 2;
      if (depth === 0) return index;
    } else {
      index++;
    }
  }
  return sql.length;
}

function isEscapeString(sql: string, quote: number): boolean {
  const prefix = sql[quote - 1];
  return (prefix === 'E' || prefix === 'e') && !IDENTIFIER_CHAR.test(sql[quote - 2] ?? '');
}

/**
 * Rewrites `?` placeholders to `$1`, `$2`, ... in order.
 *
 * Skipped: `'...'` and `E'...'` strings, `"..."` identifiers, `$tag$...$tag$`
 * dollar quotes, `--` and nested `/* *\/` comments, and the `?|` / `?&` jsonb
 * operators. The bare jsonb `?` (key exists) operator cannot be told apart
 * from a placeholder: write `jsonb_exists(col, ?)` instead. The adapter does
 * not rewrite statements bound without parameters, so a literal `?` operator
 * still works there. Mixing `?` with explicit `$n` placeholders throws.
 */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let count = 0;
  let positional = false;
  while (index < sql.length) {
    let end = skippedTokenEnd(sql, index);
    if (end === undefined && sql[index] === '$') {
      const dollar = dollarTokenEnd(sql, index);
      end = dollar.end;
      positional ||= dollar.positional;
    }
    if (end === undefined && sql[index] === '?') {
      out += `$${++count}`;
      index++;
      continue;
    }
    end ??= index + 1;
    out += sql.slice(index, end);
    index = end;
  }
  if (count > 0 && positional) {
    throw new TypeError('Cannot mix ? placeholders with $n placeholders in one statement');
  }
  return out;
}

/** End of the string, identifier, comment, or `?|`/`?&` operator at `index`. */
function skippedTokenEnd(sql: string, index: number): number | undefined {
  const char = sql[index];
  const next = sql[index + 1];
  if (char === "'") return skipQuoted(sql, index, "'", isEscapeString(sql, index));
  if (char === '"') return skipQuoted(sql, index, '"', false);
  if (char === '-' && next === '-') {
    const newline = sql.indexOf('\n', index);
    return newline < 0 ? sql.length : newline;
  }
  if (char === '/' && next === '*') return skipBlockComment(sql, index);
  if (char === '?' && (next === '|' || next === '&')) return index + 2;
  return undefined;
}

/** End of the `$tag$...$tag$` body or `$n` placeholder that starts at `index`. */
function dollarTokenEnd(sql: string, index: number): { end: number; positional: boolean } {
  if (IDENTIFIER_CHAR.test(sql[index - 1] ?? '')) return { end: index + 1, positional: false };
  const rest = sql.slice(index);
  const tag = DOLLAR_TAG.exec(rest)?.[0];
  if (tag) {
    const close = sql.indexOf(tag, index + tag.length);
    return { end: close < 0 ? sql.length : close + tag.length, positional: false };
  }
  const number = POSITIONAL.exec(rest)?.[0];
  if (number) return { end: index + number.length, positional: true };
  return { end: index + 1, positional: false };
}

async function call<T>(fn: () => WasmMaybeResult<T>): Promise<T> {
  try {
    return unwrapWasmPgliteResult(await fn());
  } catch (error) {
    throw normalizeWasmPgliteError(error);
  }
}

/** A transaction or savepoint level; siblings opened from it run one at a time. */
interface TransactionScope {
  readonly view: SqlDatabase;
  readonly parent?: TransactionScope;
  readonly children: AsyncMutex;
  readonly lease: SqlLease;
  /** Runs directly while the lease is active, else defers to the parent scope's guard. */
  readonly guard: SqlGuard;
}

function descendsFrom(scope: TransactionScope, ancestor: TransactionScope): boolean {
  for (let current = scope.parent; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Wraps an open WIT `connection` resource as a `SqlDatabase`.
 *
 * Every statement holds one mutex. `transaction(fn)` runs `begin` … `commit`
 * and calls `rollback` when `fn` throws. Statements issued from inside `fn`,
 * through the callback view or the outer handle, join the transaction; other
 * tasks wait. A nested `transaction()` opens a savepoint: its failure rolls
 * back to the savepoint, and its work commits only with the outer transaction.
 * Sibling savepoints started concurrently run one at a time; a plain statement
 * issued while a sibling savepoint is open joins that savepoint.
 *
 * Inside `fn`, prefer the callback view: while its transaction or savepoint is
 * open it joins from any async context. The outer handle joins only from
 * `fn`'s own async context (tracked with AsyncLocalStorage); from anywhere else
 * it waits for the mutex, which deadlocks if `fn` awaits it.
 *
 * Sibling savepoints are queued on their parent. `transaction()` on a view,
 * called from an async context outside an open sibling savepoint, waits for
 * that sibling to finish; if the sibling awaits that call, it waits forever.
 *
 * Joining lasts only while a transaction is open. A savepoint view kept after
 * its savepoint ends joins the nearest open ancestor, so its work commits or
 * rolls back with that ancestor. Once the root transaction has ended, a
 * retained view, like a timer scheduled inside `fn`, takes the mutex like any
 * other caller.
 */
export function createSqlDatabaseFromWasmPgliteConnection(
  connection: WasmPgliteConnection,
): SqlDatabase {
  const mutex = new AsyncMutex();
  // The outer handle joins a running root transaction from its own async
  // context for as long as that transaction's lease is active. The lease ends
  // before COMMIT/ROLLBACK is issued (see `enter`), unlike `contextLock`, which
  // would keep it until the holder returns.
  const held = new AsyncLocalStorage<SqlLease>();
  const locked: SqlGuard = (fn) => (held.getStore()?.active ? fn() : mutex.run(fn));
  // Statements a transaction's callers issue concurrently reach the connection
  // one at a time, even when the binding returns promises (see `leaseGuard`).
  const wire = new AsyncMutex();
  const invoke = <T>(fn: () => WasmMaybeResult<T>): Promise<T> => wire.run(() => call(fn));
  const activeScope = new AsyncLocalStorage<TransactionScope>();
  let savepoints = 0;

  const bind = (sql: string, params: unknown[]) => {
    const values = toWasmPgParams(params);
    return { sql: values.length > 0 ? toPgPlaceholders(sql) : sql, values };
  };
  const calls: SqlStatementCalls = {
    run: async (sql, params) => {
      const bound = bind(sql, params);
      const changes = await invoke(() => connection.run(bound.sql, bound.values));
      return { changes: Number(changes ?? 0) };
    },
    query: async (sql, params) => {
      const bound = bind(sql, params);
      const rows = await invoke(() => connection.query(bound.sql, bound.values));
      return rows.map((row) => fromWasmPgRow(row));
    },
    first: async (sql, params) => {
      const bound = bind(sql, params);
      const row = await invoke(() => connection.first(bound.sql, bound.values));
      return row ? fromWasmPgRow(row) : null;
    },
    exec: async (sql) => {
      await invoke(() => connection.exec(sql));
    },
  };
  const statementsVia = (guard: SqlGuard) => ({
    [SQL_DATABASE_BRAND]: true,
    ...guardedStatements(guard, calls),
  });

  /** The innermost transaction or savepoint of this context that is still open. */
  const liveScope = (): TransactionScope | undefined => {
    let scope = activeScope.getStore();
    while (scope && !scope.lease.active) scope = scope.parent;
    return scope;
  };

  const enter = async <T>(
    scope: TransactionScope,
    fn: (db: SqlDatabase) => Promise<T>,
    open: () => WasmMaybeResult<void>,
    close: () => WasmMaybeResult<void>,
    undo: () => WasmMaybeResult<void>,
  ): Promise<T> => {
    try {
      await invoke(open);
      try {
        const result = await activeScope.run(scope, () => fn(scope.view));
        // End the lease before COMMIT / RELEASE is issued: a statement that
        // arrives late waits for the mutex and runs after the transaction,
        // instead of reaching the wire between the close and the end of the lease.
        scope.lease.active = false;
        await invoke(close);
        return result;
      } catch (error) {
        scope.lease.active = false;
        try {
          await invoke(undo);
        } catch {}
        throw error;
      }
    } finally {
      scope.lease.active = false;
    }
  };

  const nest = <T>(parent: TransactionScope, fn: (db: SqlDatabase) => Promise<T>): Promise<T> => {
    const current = liveScope();
    if (current && descendsFrom(current, parent)) return nest(current, fn);
    return parent.children.run(() => {
      const name = `di_sp_${++savepoints}`;
      return enter(
        createScope(parent),
        fn,
        () => connection.savepoint(name),
        () => connection.releaseSavepoint(name),
        () => connection.rollbackToSavepoint(name),
      );
    });
  };

  // A view runs directly while its scope is open, from any async context: the
  // scope's lease is cleared before the mutex is released. Once a savepoint has
  // ended, its view falls back to the parent scope, which is still open and
  // may be awaiting the caller; taking the root mutex there would deadlock. A
  // root view, whose transaction holds that mutex, takes it like the outer handle.
  const createScope = (
    parent?: TransactionScope,
    lease: SqlLease = { active: true },
  ): TransactionScope => {
    const guard = leaseGuard(lease, parent ? parent.guard : locked);
    const scope: TransactionScope = {
      parent,
      children: new AsyncMutex(),
      lease,
      guard,
      view: {
        ...statementsVia(guard),
        // A view kept past its scope opens its transaction on the parent scope
        // (or, for a root view, a fresh transaction).
        transaction: (fn) =>
          lease.active
            ? nest(scope, fn)
            : parent
              ? parent.view.transaction(fn)
              : database.transaction(fn),
      } as SqlDatabase,
    };
    return scope;
  };

  const database: SqlDatabase = {
    ...statementsVia(locked),
    transaction: async <T>(fn: (db: SqlDatabase) => Promise<T>): Promise<T> => {
      const current = liveScope();
      if (current) return nest(current, fn);
      return mutex.run(() => {
        // The root scope's lease doubles as the outer handle's join lease.
        const lease: SqlLease = { active: true };
        return held.run(lease, () =>
          enter(
            createScope(undefined, lease),
            fn,
            () => connection.begin(),
            () => connection.commit(),
            () => connection.rollback(),
          ),
        );
      });
    },
    close: () => locked(() => invoke(() => connection.close())),
  } as SqlDatabase;

  return database;
}

export interface WasmPgliteDatabaseOptions extends WasmPgliteOpenOptions {
  /** Pre-loaded module; skips the dynamic import of the WIT interface. */
  module?: WasmPgliteModule;
  /** Custom loader for the WIT interface module (primarily for tests). */
  loadModule?: () => Promise<WasmPgliteModule>;
}

let cachedModule: Promise<WasmPgliteModule> | undefined;

/**
 * Imports `di-framework:pglite/database@0.2.0`, provided by the composed provider component.
 *
 * The module's types come from `wit.d.ts`, generated from `wit/world.wit`. The
 * conversion below has no cast, so a WIT change that breaks the adapter's view
 * of the interface fails the typecheck. The check covers method names, arity
 * and result types, not the parameter variants (see the TODO on
 * `WasmPgliteConnection`).
 */
export function loadWasmPgliteModule(): Promise<WasmPgliteModule> {
  cachedModule ??= import('di-framework:pglite/database@0.2.0')
    .then((module): WasmPgliteModule => module)
    .catch((error) => {
      cachedModule = undefined;
      throw new Error(
        `The ${WASM_PGLITE_MODULE_ID} import is unavailable in this runtime; compose the component with the di-framework PGlite provider`,
        { cause: error },
      );
    });
  return cachedModule;
}

/**
 * Opens a persistent PGlite database root through the provider component and
 * adapts it to `SqlDatabase`. `path` is the root directory inside a writable
 * WASI preopen (for example `/data/identity`); an empty path selects
 * {@link WASM_PGLITE_DEFAULT_ROOT}. The provider allows one open connection per
 * component instance, so keep one handle and share it.
 */
export async function createWasmPgliteDatabase(
  path = '',
  options: WasmPgliteDatabaseOptions = {},
): Promise<SqlDatabase> {
  const { module: providedModule, loadModule, ...openOptions } = options;
  const module = providedModule ?? (await (loadModule ?? loadWasmPgliteModule)());
  const resolvedOpenOptions: WasmPgliteOpenOptions = {
    ...(openOptions.database !== undefined ? { database: openOptions.database } : {}),
    ...(openOptions.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: openOptions.statementTimeoutMs }
      : {}),
  };
  const hasOptions = Object.keys(resolvedOpenOptions).length > 0;
  const connection = await call(() =>
    module.open(path, hasOptions ? resolvedOpenOptions : undefined),
  );
  return createSqlDatabaseFromWasmPgliteConnection(connection);
}
