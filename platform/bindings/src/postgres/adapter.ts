import type { SqlDatabase } from '@di-framework/repo';
import { assertBatch, postgresError, readRows } from '@di-framework/repo/postgres';
import type { PostgresGuest } from '../bindings/postgres';
import { type AtomicStatement, renderAtomicBatch } from './atomic-batch';
import { bindParams } from './bind-params';

type SqlStateError = Error & { code?: string };

/**
 * `SqlDatabase` over `wasmcloud:postgres@0.2.0` where every statement is its own transaction.
 *
 * The binding has no connection or transaction handle, and a named import has no connection
 * affinity: each `query` and `queryBatch` may run on any pooled connection. A `BEGIN` sent on
 * one call does not cover the next. This handle never sends `BEGIN`, `COMMIT`, or `ROLLBACK`.
 * `transaction(fn)` runs `fn` on this same handle. `FOR UPDATE` and advisory locks last only
 * for their statement.
 *
 * Keep an invariant in one statement:
 *
 * - conditional `UPDATE … RETURNING`
 * - a data-modifying CTE
 * - `INSERT … SELECT … WHERE NOT EXISTS`
 *
 * `run` reports `changes` as the number of rows returned. The provider does not report a
 * command tag, so a count comes from `RETURNING`.
 *
 * A multi-statement `exec` script is still one `queryBatch`. The host runs that string with
 * `batch_execute` on a single pooled client, so Postgres treats it as one implicit transaction.
 */
export interface AutocommitDatabase extends SqlDatabase {
  /**
   * Writes `statements` as one transaction and returns no rows.
   *
   * Parameters are rendered as SQL literals and the text is submitted as a single
   * `queryBatch` string. The string has no `BEGIN`, `COMMIT`, or `ROLLBACK`.
   * Postgres treats that multi-statement simple query as one implicit transaction
   * and rolls it back on error, so the pooled client returns idle. A quote is
   * doubled. A negative number is parenthesized so it cannot form a `--` comment.
   * Do not use this when a later statement must read an earlier one.
   *
   * The whole string runs on one pooled client. wasmCloud v2.8.0 (commit
   * `5c4ec4a3d008b3f401d9e763515f434deebc9936`, the wash revision this platform
   * pins) implements `query_batch` in
   * `crates/wash-runtime/src/plugin/wasmcloud_postgres/async_p3.rs`. The default
   * import checks out one client (`query_batch`, line 331) and `batch_with_client`
   * (line 190) calls `client.batch_execute` with that string (line 191). The named
   * import does the same (`query_batch`, line 407; `id.client()`, line 412;
   * `batch_with_client`, line 416). `crates/provider-sqldb-postgres` is not in that
   * tag. The invocation-lease patch does not split this string, so it still
   * reaches one `batch_execute`.
   */
  atomicBatch(statements: readonly AtomicStatement[]): Promise<void>;
}

/**
 * Opens `binding` as an {@link AutocommitDatabase}.
 *
 * `wasmcloud:postgres@0.2.0` has no connection or transaction handle: each `query` and
 * `query-batch` call may run on any pooled connection of the host, so a `BEGIN` sent in one call
 * does not cover the next. The guest therefore never opens a transaction. Every statement
 * commits on its own, `transaction(fn)` runs `fn` on this same handle, and `FOR UPDATE` and
 * advisory locks last only for their statement. Keep invariants in one statement (conditional
 * `UPDATE … RETURNING`, data-modifying CTEs, `INSERT … SELECT … WHERE NOT EXISTS`). A
 * multi-statement `exec` script still runs as one `query-batch`, which Postgres executes as one
 * implicit transaction on one connection.
 *
 * `run`, `query`, and `first` call `query`. `exec` calls `queryBatch`. Failures keep a
 * five-digit SQLSTATE on `error.code`.
 */
export function openPostgresDatabase(binding: PostgresGuest): AutocommitDatabase {
  const handle: AutocommitDatabase = {
    async run(sql, params = []) {
      const rows = await statements(binding, sql, params);
      return { changes: rows.length };
    },
    async query<T>(sql: string, params: unknown[] = []) {
      return (await statements(binding, sql, params)) as T[];
    },
    async first<T>(sql: string, params: unknown[] = []) {
      const rows = await statements(binding, sql, params);
      return (rows[0] ?? null) as T | null;
    },
    async exec(sql) {
      await submitBatch(binding, sql);
    },
    transaction(fn) {
      return fn(handle);
    },
    atomicBatch(statements) {
      return submitAtomicBatch(binding, statements);
    },
  };
  return handle;
}

/**
 * {@link AutocommitDatabase.atomicBatch} for a `PostgresGuest` that is not wrapped
 * as a `SqlDatabase`.
 */
export async function atomicBatch(
  binding: PostgresGuest,
  statements: readonly AtomicStatement[],
): Promise<void> {
  await submitAtomicBatch(binding, statements);
}

async function submitAtomicBatch(
  binding: PostgresGuest,
  statements: readonly AtomicStatement[],
): Promise<void> {
  await submitBatch(binding, renderAtomicBatch(statements));
}

async function statements(
  binding: PostgresGuest,
  sql: string,
  params: readonly unknown[],
): Promise<Record<string, unknown>[]> {
  const bound = bindParams(sql, params);
  try {
    return await readRows(await binding.query(bound.text, bound.params));
  } catch (error) {
    throw coded(error);
  }
}

async function submitBatch(binding: PostgresGuest, sql: string): Promise<void> {
  try {
    assertBatch(await binding.queryBatch(sql));
  } catch (error) {
    throw coded(error);
  }
}

function coded(error: unknown): SqlStateError {
  const wrapped = (
    error instanceof Error && error.message.startsWith('PostgreSQL') ? error : postgresError(error)
  ) as SqlStateError;
  const code = /PostgreSQL (\d{5})/.exec(wrapped.message)?.[1];
  if (code !== undefined) wrapped.code = code;
  return wrapped;
}
