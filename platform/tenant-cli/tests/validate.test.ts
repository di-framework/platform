import { expect, test } from 'bun:test';
import auth from '../src/api/contracts/auth-v1.codegen.ts';
import { secrets, vars } from '../src/api/contracts/config-v1.codegen.ts';
import deploy from '../src/api/contracts/deploy-v1.codegen.ts';
import deployments from '../src/api/contracts/deployments-v1.codegen.ts';
import services from '../src/api/contracts/services-v1.codegen.ts';
import { schemas } from '../src/api/schemas.ts';
import { coerceQuery, SUPPORTED_KEYWORDS, ValidationError, validate } from '../src/api/validate.ts';

test('additionalProperties false refuses undeclared fields, including inherited names', () => {
  const closed = {
    type: 'object',
    properties: { a: { type: 'string' } },
    additionalProperties: false,
  };
  fails(closed, { b: 1 }, 'body.b is not allowed');
  fails(closed, { constructor: 1 }, 'body.constructor is not allowed');
  fails(closed, JSON.parse('{"__proto__":1}'), 'body.__proto__ is not allowed');
  fails({ type: 'object', required: ['toString'] }, {}, 'body.toString is required');
  expect(() => validate(closed, { a: 'x' })).not.toThrow();
});

test('an unsupported type fails closed', () => {
  expect(() => validate({ type: 'number' }, 1)).toThrow('unsupported schema type "number"');
  expect(() => validate({ type: ['string', 'null'] } as never, 'x')).toThrow('unsupported');
});

test('every contract schema and parameter uses only keywords the validator supports', () => {
  const unsupported: string[] = [];
  const walk = (schema: unknown, at: string): void => {
    if (typeof schema !== 'object' || schema === null) return;
    for (const [key, value] of Object.entries(schema)) {
      if (!SUPPORTED_KEYWORDS.has(key)) unsupported.push(`${at}.${key}`);
      if (key === 'properties')
        for (const [name, child] of Object.entries(value as object)) walk(child, `${at}.${name}`);
      else if (key === 'items' || (key === 'additionalProperties' && typeof value === 'object'))
        walk(value, `${at}.${key}`);
    }
  };
  for (const [name, schema] of Object.entries(schemas)) walk(schema, name);
  for (const manifest of [auth, deploy, deployments, secrets, vars, services])
    for (const [operation, { http }] of Object.entries(manifest.operations))
      for (const parameter of (http?.parameters ?? []) as { name: string; schema: unknown }[])
        walk(parameter.schema, `${operation}.${parameter.name}`);
  expect(unsupported).toEqual([]);
  walk({ minLength: 1 }, 'probe');
  expect(unsupported).toEqual(['probe.minLength']);
});

const fails = (schema: object, value: unknown, message: string) => {
  expect(() => validate(schema, value)).toThrow(new ValidationError(message));
};

test('objects check their type, required fields, properties and additional properties', () => {
  fails({ type: 'object' }, null, 'body must be an object');
  fails({ type: 'object' }, [], 'body must be an object');
  fails({ type: 'object', required: ['a'] }, {}, 'body.a is required');
  const map = { type: 'object', additionalProperties: { type: 'string' } };
  fails(map, { a: 1 }, 'body.a must be a string');
  expect(() => validate(map, { a: 'x' })).not.toThrow();
  expect(() => validate({ type: 'object', additionalProperties: true }, { a: 1 })).not.toThrow();
  expect(() => validate({ type: 'object' }, { anything: 1 })).not.toThrow();
});

test('arrays check every item', () => {
  fails({ type: 'array', items: { type: 'string' } }, 'x', 'body must be an array');
  fails({ type: 'array', items: { type: 'string' } }, ['a', 2], 'body[1] must be a string');
  expect(() => validate({ type: 'array' }, [1, 'a'])).not.toThrow();
});

test('scalars check their type, enum and format', () => {
  fails({ type: 'string', enum: ['a'] }, 'b', 'body must be one of a');
  fails({ type: 'boolean' }, 'true', 'body must be a boolean');
  fails({ type: 'integer' }, 1.5, 'body must be an integer');
  fails({ type: 'integer', format: 'int32' }, 2 ** 31, 'body must be a 32-bit integer');
  expect(() => validate({ type: 'integer', format: 'int32' }, -(2 ** 31))).not.toThrow();
  fails({ type: 'string', format: 'uri' }, 'not a uri', 'body must be a URI');
  fails(
    { type: 'string', format: 'date-time' },
    '2026-10-09',
    'body must be an RFC 3339 date-time',
  );
  fails(
    { type: 'string', format: 'date-time' },
    '2026-13-45T99:00:00Z',
    'body must be an RFC 3339 date-time',
  );
  expect(() =>
    validate({ type: 'string', format: 'date-time' }, '2026-10-09T01:02:03.5+02:00'),
  ).not.toThrow();
  expect(() => validate({ type: 'string', format: 'uri' }, 'https://x.test')).not.toThrow();
});

test('references resolve to the component schemas', () => {
  fails({ $ref: '#/components/schemas/ComponentReference' }, {}, 'body.reference is required');
  expect(() => validate({ $ref: '#/components/schemas/Missing' }, {})).toThrow(
    'unknown schema reference #/components/schemas/Missing',
  );
});

test('query parameters are coerced to their declared type', () => {
  expect(coerceQuery({ type: 'boolean' }, 'true', 'q')).toBe(true);
  expect(coerceQuery({ type: 'boolean' }, 'false', 'q')).toBe(false);
  expect(coerceQuery({ type: 'integer' }, '-4', 'q')).toBe(-4);
  expect(coerceQuery({ type: 'string' }, 'x', 'q')).toBe('x');
  expect(() => coerceQuery({ type: 'string' }, ['a', 'b'], 'q')).toThrow('q must be given once');
});
