/**
 * One write statement inside {@link renderAtomicBatch}.
 * `?` is a value placeholder. `queryBatch` takes no parameters, so each placeholder
 * is rendered as a SQL literal before the batch is submitted.
 */
export type AtomicStatement = {
  sql: string;
  params?: readonly unknown[];
};

/**
 * Renders `statements` as one `BEGIN; …; COMMIT` script.
 *
 * Literals use standard SQL quotes (`standard_conforming_strings`): a quote is
 * doubled, and a backslash is not an escape. A negative number is parenthesized
 * so `x-?` with `-1` becomes `x-(-1)` and cannot form a `--` comment. Strings
 * that match a UUID are quoted too; the hex pattern cannot close the quote.
 */
export function renderAtomicBatch(statements: readonly AtomicStatement[]): string {
  if (statements.length === 0) throw new Error('atomicBatch requires at least one statement');
  const rendered = statements.map((statement) =>
    renderStatement(statement.sql, statement.params ?? []),
  );
  return `BEGIN;\n${rendered.join(';\n')};\nCOMMIT`;
}

function renderStatement(sql: string, params: readonly unknown[]): string {
  const body = sql
    .trim()
    .replace(/;+\s*$/u, '')
    .trim();
  if (body.length === 0) throw new Error('atomicBatch statement is empty');
  let index = 0;
  const rendered = body.replaceAll('?', () => {
    const value = params[index++];
    return sqlLiteral(value);
  });
  if (index !== params.length) {
    throw new Error(`SQL placeholder count ${index} does not match ${params.length} parameters`);
  }
  return rendered;
}

function sqlLiteral(value: unknown): string {
  if (value == null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'bigint') return integerLiteral(value);
  if (typeof value === 'number') return numberLiteral(value);
  if (value instanceof Date) return timestampLiteral(value);
  if (value instanceof Uint8Array) return byteaLiteral(value);
  if (typeof value === 'object') return jsonLiteral(value);
  return unrenderable();
}

function quote(value: string): string {
  if (value.includes('\0')) throw new Error('PostgreSQL text parameter contains a null byte');
  return `'${value.replaceAll("'", "''")}'`;
}

function integerLiteral(value: bigint): string {
  return value < 0n ? `(${value})` : `${value}`;
}

function numberLiteral(value: number): string {
  if (!Number.isFinite(value)) throw new Error('PostgreSQL parameter is not a finite number');
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error('PostgreSQL int8 parameter is not an exact integer');
    }
    return integerLiteral(BigInt(value));
  }
  const text = String(value);
  if (text.startsWith('-')) return `(${text})`;
  return text;
}

function timestampLiteral(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error('PostgreSQL timestamp-tz parameter has the wrong type');
  }
  return quote(value.toISOString());
}

function byteaLiteral(value: Uint8Array): string {
  const hex = [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `decode('${hex}', 'hex')`;
}

function jsonLiteral(value: object): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return unrenderable();
  }
  if (json === undefined) return unrenderable();
  return quote(json);
}

function unrenderable(): string {
  throw new Error('PostgreSQL parameter cannot be rendered as a literal');
}
