import { type PgParameter, pgValue } from '@di-framework/repo/postgres';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rewrites `@di-framework/repo` `?` placeholders for the wasmCloud Postgres binding.
 *
 * The host binds every parameter in binary as the type Postgres infers for its slot, and the
 * guest never sees that type. A UUID string may fill a `uuid` column or a `varchar` one (the
 * Spring Authorization Server tables), and its 16 binary bytes are invalid UTF-8 in a
 * `varchar`. An integer may fill an `int4` slot or an `int8` one (`LIMIT`), and the widths
 * differ. So UUID strings go inline as untyped literals and safe integers as numeric
 * constants, which Postgres resolves from context. Neither can carry SQL: the UUID pattern
 * admits only hex digits and dashes, and a negative integer is parenthesized so it cannot
 * form a `--` comment.
 */
export function bindParams(
  sql: string,
  params: readonly unknown[] = [],
): { text: string; params: PgParameter[] } {
  if (params.length === 0) return { text: sql, params: [] };
  const bound: PgParameter[] = [];
  let index = 0;
  const text = sql.replaceAll('?', () => {
    const value = params[index++];
    const literal = inlineLiteral(value);
    if (literal !== undefined) return literal;
    bound.push(pgValue(value));
    return `$${bound.length}`;
  });
  if (index !== params.length) {
    throw new Error(`SQL placeholder count ${index} does not match ${params.length} parameters`);
  }
  return { text, params: bound };
}

function inlineLiteral(value: unknown): string | undefined {
  if (typeof value === 'string') return UUID.test(value) ? `'${value}'` : undefined;
  const integer =
    typeof value === 'bigint'
      ? value
      : Number.isSafeInteger(value)
        ? BigInt(value as number)
        : undefined;
  if (integer === undefined) return undefined;
  return integer < 0n ? `(${integer})` : `${integer}`;
}
