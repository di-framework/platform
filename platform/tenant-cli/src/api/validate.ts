import { schemas } from './schemas.ts';

/** A request that does not match the contract; the controller answers it with a 400 problem. */
export class ValidationError extends Error {
  override readonly name = 'ValidationError';
}

type Schema = {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: readonly unknown[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
};

const INT32 = 2 ** 31;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

function resolve(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace('#/components/schemas/', '');
  const target = (schemas as Record<string, Schema>)[name];
  if (!target) throw new Error(`unknown schema reference ${schema.$ref}`);
  return target;
}

function checkFormat(format: string | undefined, value: string, at: string): void {
  if (format === 'date-time' && !(DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))))
    throw new ValidationError(`${at} must be an RFC 3339 date-time`);
  if (format === 'uri' && !URL.canParse(value)) throw new ValidationError(`${at} must be a URI`);
}

/**
 * Checks a value against the subset of JSON Schema the `/v1` component schemas use: `$ref`,
 * `type` (object, array, string, integer, boolean), `enum`, `required`, `properties`,
 * `additionalProperties`, `items`, and the `date-time`, `uri` and `int32` formats.
 * Throws {@link ValidationError} naming the first offending location.
 */
export function validate(input: Schema, value: unknown, at = 'body'): void {
  const schema = resolve(input);
  if (schema.enum && !schema.enum.includes(value))
    throw new ValidationError(`${at} must be one of ${schema.enum.join(', ')}`);
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ValidationError(`${at} must be an object`);
      const record = value as Record<string, unknown>;
      for (const name of schema.required ?? [])
        if (record[name] === undefined) throw new ValidationError(`${at}.${name} is required`);
      for (const [name, item] of Object.entries(record)) {
        const property = schema.properties?.[name];
        if (property) validate(property, item, `${at}.${name}`);
        else if (typeof schema.additionalProperties === 'object')
          validate(schema.additionalProperties, item, `${at}.${name}`);
      }
      return;
    }
    case 'array':
      if (!Array.isArray(value)) throw new ValidationError(`${at} must be an array`);
      value.forEach((item, index) => {
        validate(schema.items ?? {}, item, `${at}[${index}]`);
      });
      return;
    case 'string':
      if (typeof value !== 'string') throw new ValidationError(`${at} must be a string`);
      checkFormat(schema.format, value, at);
      return;
    case 'integer':
      if (!Number.isInteger(value)) throw new ValidationError(`${at} must be an integer`);
      if (schema.format === 'int32' && ((value as number) < -INT32 || (value as number) >= INT32))
        throw new ValidationError(`${at} must be a 32-bit integer`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw new ValidationError(`${at} must be a boolean`);
      return;
  }
}

/**
 * Reads one query parameter as its declared scalar type: `true`/`false` for booleans, a decimal
 * for integers, the raw string otherwise. A repeated parameter is refused.
 */
export function coerceQuery(schema: Schema, raw: string | string[], at: string): unknown {
  if (Array.isArray(raw)) throw new ValidationError(`${at} must be given once`);
  if (schema.type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new ValidationError(`${at} must be true or false`);
  }
  if (schema.type === 'integer') {
    if (!/^-?\d+$/.test(raw)) throw new ValidationError(`${at} must be an integer`);
    return Number(raw);
  }
  return raw;
}
