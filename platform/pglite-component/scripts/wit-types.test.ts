import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { generateWitTypes, parseWit, tokenize, WIT_TYPES_PATH } from './wit-types.ts';

const pkgDir = join(import.meta.dir, '..');
const readWit = () => Bun.file(join(pkgDir, 'wit', 'world.wit')).text();

describe('wit-types', () => {
  test('js/wit.d.ts is generated from the current wit/world.wit', async () => {
    const committed = await Bun.file(join(pkgDir, WIT_TYPES_PATH)).text();
    expect(committed).toBe(generateWitTypes(await readWit()));
  });

  test('declares the versioned database interface the adapter imports', async () => {
    const generated = generateWitTypes(await readWit());
    expect(generated).toContain("declare module 'di-framework:pglite/database@0.2.0' {");
    expect(generated).toContain("| { tag: 'execution-failed'; val: PgError }");
    expect(generated).toContain('    run(sql: string, params: Array<Value>): bigint;');
    expect(generated).toContain('    first(sql: string, params: Array<Value>): Row | undefined;');
    expect(generated).toContain('    rollbackToSavepoint(name: string): void;');
    expect(generated).toContain(
      '  export function open(path: string, options?: OpenOptions): Connection;',
    );
    expect(generated).toContain('    statementTimeoutMs?: number;');
  });

  test('follows a WIT change instead of keeping stale types', async () => {
    const wit = (await readWit())
      .replace('package di-framework:pglite@0.2.0;', 'package di-framework:pglite@0.3.0;')
      .replace('rows-affected: func() -> u64;', 'rows-affected: func() -> u32;');
    const generated = generateWitTypes(wit);
    expect(generated).toContain("declare module 'di-framework:pglite/database@0.3.0' {");
    expect(generated).toContain('    rowsAffected(): number;');
  });

  test('maps tuples, non-byte lists, required options and bare results', () => {
    const generated = generateWitTypes(
      [
        'package di-framework:pglite@1.0.0;',
        'interface types { record r { a: option<s32> } }',
        'interface database {',
        '  use types.{r};',
        '  type pair = tuple<string, list<r>>;',
        '  f: func(a: option<u8>, b: string) -> pair;',
        '  g: func();',
        '  h: func() -> result<_, string>;',
        '}',
        'world w { export database; }',
      ].join('\n'),
    );
    expect(generated).toContain('    a?: number;');
    expect(generated).toContain('  export type Pair = [string, Array<R>];');
    expect(generated).toContain('  export function f(a: number | undefined, b: string): Pair;');
    expect(generated).toContain('  export function g(): void;');
    expect(generated).toContain('  export function h(): void;');
  });

  test('rejects WIT it cannot translate', () => {
    const wrap = (body: string) => `package di-framework:pglite@1.0.0;\n${body}`;
    expect(() => tokenize('interface x { a: func() -> # }')).toThrow('unsupported WIT syntax');
    expect(() => generateWitTypes(wrap('interface types {}'))).toThrow('no `database` interface');
    expect(() => generateWitTypes(wrap('interface database { use other.{x}; }'))).toThrow(
      'unknown interface other',
    );
    expect(() =>
      generateWitTypes(wrap('interface types {} interface database { use types.{x}; }')),
    ).toThrow('has no type x');
    expect(() => generateWitTypes(wrap('interface database { f: func(a: borrow<x>); }'))).toThrow(
      'unsupported WIT type borrow',
    );
    expect(() => generateWitTypes(wrap('interface database { f: func(a: list<_>); }'))).toThrow(
      'missing argument 0 of list',
    );
    expect(() => parseWit('enum e { a }')).toThrow("unsupported top-level WIT item 'enum'");
    expect(() => parseWit('interface database { f: func(')).toThrow('unexpected end of WIT');
    expect(() => parseWit('interface database { f func(); }')).toThrow("expected ':'");
  });
});
