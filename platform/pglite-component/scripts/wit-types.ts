/**
 * Generate `js/wit.d.ts`, the TypeScript view of the `database` interface the
 * adapter imports, from `wit/world.wit`.
 *
 *   bun scripts/wit-types.ts           rewrite js/wit.d.ts
 *   bun scripts/wit-types.ts --check   fail when js/wit.d.ts is stale
 *
 * The mapping follows the component bindings the adapter targets: functions
 * and fields are camelCase, a `result<T, error>` return is `T` (the binding
 * throws the error), `option<T>` is `T | undefined` (an optional trailing
 * parameter), `s64`/`u64` are `bigint` (componentize-qjs 0.4.4-di.5 and jco
 * lift and lower them as `BigInt`), `list<u8>` is `Uint8Array`, a variant
 * is `{ tag: 'case'; val: T }`, and a resource is a class. Only the WIT subset
 * `world.wit` uses is supported; anything else throws so a WIT change cannot
 * be silently mistranslated.
 */
import { join } from 'node:path';
import { databaseInterface, parseWitVersion } from './lib/wit-version.ts';

type TypeRef =
  | { kind: 'named'; name: string }
  | { kind: 'generic'; name: string; args: Array<TypeRef | '_'> };

type TypeDef =
  | { kind: 'record'; name: string; fields: Array<[string, TypeRef]> }
  | { kind: 'variant'; name: string; cases: Array<[string, TypeRef | undefined]> }
  | { kind: 'alias'; name: string; type: TypeRef };

interface Func {
  name: string;
  params: Array<[string, TypeRef]>;
  result?: TypeRef;
}

interface Resource {
  name: string;
  methods: Func[];
}

interface Interface {
  name: string;
  uses: Array<{ from: string; names: string[] }>;
  types: TypeDef[];
  funcs: Func[];
  resources: Resource[];
}

const TOKEN = /\s*(->|@[\w.+-]+|[A-Za-z_%][\w-]*|[{}()<>,:;=./])/y;

export function tokenize(source: string): string[] {
  const text = source
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*package\s+[^;]+;/m, '');
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match?.[1])
      throw new Error(`unsupported WIT syntax near: ${text.slice(start, start + 40)}`);
    tokens.push(match[1]);
  }
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: string[]) {}

  private peek(): string | undefined {
    return this.tokens[this.index];
  }

  private next(): string {
    const token = this.tokens[this.index++];
    if (token === undefined) throw new Error('unexpected end of WIT');
    return token;
  }

  private expect(token: string): void {
    const actual = this.next();
    if (actual !== token) throw new Error(`expected '${token}' in WIT, found '${actual}'`);
  }

  /** Skips a `{ ... }` block (worlds) without interpreting it. */
  private skipBlock(): void {
    this.expect('{');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '{') depth++;
      if (token === '}') depth--;
    }
  }

  interfaces(): Interface[] {
    const result: Interface[] = [];
    while (this.peek() !== undefined) {
      const token = this.next();
      if (token === 'interface') {
        result.push(this.interface(this.next()));
      } else if (token === 'world') {
        this.next();
        this.skipBlock();
      } else {
        throw new Error(`unsupported top-level WIT item '${token}'`);
      }
    }
    return result;
  }

  private interface(name: string): Interface {
    const iface: Interface = { name, uses: [], types: [], funcs: [], resources: [] };
    this.expect('{');
    while (this.peek() !== '}') {
      const token = this.next();
      if (token === 'use') {
        const from = this.next();
        this.expect('.');
        this.expect('{');
        const names: string[] = [];
        while (this.peek() !== '}') {
          names.push(this.next());
          if (this.peek() === ',') this.next();
        }
        this.expect('}');
        this.expect(';');
        iface.uses.push({ from, names });
      } else if (token === 'record') {
        const recordName = this.next();
        iface.types.push({ kind: 'record', name: recordName, fields: this.fields() });
      } else if (token === 'variant') {
        iface.types.push({ kind: 'variant', name: this.next(), cases: this.cases() });
      } else if (token === 'type') {
        const aliasName = this.next();
        this.expect('=');
        const type = this.type();
        this.expect(';');
        iface.types.push({ kind: 'alias', name: aliasName, type });
      } else if (token === 'resource') {
        iface.resources.push(this.resource(this.next()));
      } else {
        iface.funcs.push(this.func(token));
      }
    }
    this.expect('}');
    return iface;
  }

  private fields(): Array<[string, TypeRef]> {
    const fields: Array<[string, TypeRef]> = [];
    this.expect('{');
    while (this.peek() !== '}') {
      const name = this.next();
      this.expect(':');
      fields.push([name, this.type()]);
      if (this.peek() === ',') this.next();
    }
    this.expect('}');
    return fields;
  }

  private cases(): Array<[string, TypeRef | undefined]> {
    const cases: Array<[string, TypeRef | undefined]> = [];
    this.expect('{');
    while (this.peek() !== '}') {
      const name = this.next();
      let payload: TypeRef | undefined;
      if (this.peek() === '(') {
        this.next();
        payload = this.type();
        this.expect(')');
      }
      cases.push([name, payload]);
      if (this.peek() === ',') this.next();
    }
    this.expect('}');
    return cases;
  }

  private resource(name: string): Resource {
    const methods: Func[] = [];
    this.expect('{');
    while (this.peek() !== '}') methods.push(this.func(this.next()));
    this.expect('}');
    return { name, methods };
  }

  private func(name: string): Func {
    this.expect(':');
    this.expect('func');
    this.expect('(');
    const params: Array<[string, TypeRef]> = [];
    while (this.peek() !== ')') {
      const param = this.next();
      this.expect(':');
      params.push([param, this.type()]);
      if (this.peek() === ',') this.next();
    }
    this.expect(')');
    let result: TypeRef | undefined;
    if (this.peek() === '->') {
      this.next();
      result = this.type();
    }
    this.expect(';');
    return { name, params, result };
  }

  private type(): TypeRef {
    const name = this.next();
    if (this.peek() !== '<') return { kind: 'named', name };
    this.next();
    const args: Array<TypeRef | '_'> = [];
    while (this.peek() !== '>') {
      if (this.peek() === '_') {
        this.next();
        args.push('_');
      } else {
        args.push(this.type());
      }
      if (this.peek() === ',') this.next();
    }
    this.expect('>');
    return { kind: 'generic', name, args };
  }
}

export function parseWit(source: string): Interface[] {
  return new Parser(tokenize(source)).interfaces();
}

function camel(name: string): string {
  return name.replace(/^%/, '').replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function pascal(name: string): string {
  const value = camel(name);
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const PRIMITIVES: Record<string, string> = {
  bool: 'boolean',
  string: 'string',
  char: 'string',
  s8: 'number',
  s16: 'number',
  s32: 'number',
  u8: 'number',
  u16: 'number',
  u32: 'number',
  f32: 'number',
  f64: 'number',
  s64: 'bigint',
  u64: 'bigint',
};

function arg(type: TypeRef, index: number): TypeRef {
  if (type.kind !== 'generic') throw new Error(`expected a generic WIT type, got ${type.name}`);
  const value = type.args[index];
  if (value === undefined || value === '_')
    throw new Error(`missing argument ${index} of ${type.name}`);
  return value;
}

function ts(type: TypeRef): string {
  if (type.kind === 'named') {
    const primitive = PRIMITIVES[type.name];
    return primitive ?? pascal(type.name);
  }
  switch (type.name) {
    case 'list': {
      const item = arg(type, 0);
      if (item.kind === 'named' && item.name === 'u8') return 'Uint8Array';
      return `Array<${ts(item)}>`;
    }
    case 'option':
      return `${ts(arg(type, 0))} | undefined`;
    case 'tuple':
      return `[${type.args.map((_, index) => ts(arg(type, index))).join(', ')}]`;
    default:
      throw new Error(`unsupported WIT type ${type.name}<...> outside a function result`);
  }
}

/** A function result: `result<T, E>` lowers to `T` (errors throw), `result<_, E>` to `void`. */
function tsResult(type: TypeRef | undefined): string {
  if (type === undefined) return 'void';
  if (type.kind === 'generic' && type.name === 'result') {
    const ok = type.args[0];
    return ok === undefined || ok === '_' ? 'void' : ts(ok);
  }
  return ts(type);
}

function tsParams(params: Array<[string, TypeRef]>): string {
  let optionalTail = true;
  const rendered: string[] = [];
  for (let index = params.length - 1; index >= 0; index--) {
    const [name, type] = params[index] as [string, TypeRef];
    const optional: boolean = optionalTail && type.kind === 'generic' && type.name === 'option';
    optionalTail = optional;
    rendered.unshift(
      optional ? `${camel(name)}?: ${ts(arg(type, 0))}` : `${camel(name)}: ${ts(type)}`,
    );
  }
  return rendered.join(', ');
}

function typeDef(def: TypeDef, indent: string): string[] {
  const name = pascal(def.name);
  if (def.kind === 'alias') return [`${indent}export type ${name} = ${ts(def.type)};`];
  if (def.kind === 'record') {
    return [
      `${indent}export interface ${name} {`,
      ...def.fields.map(([field, type]) =>
        type.kind === 'generic' && type.name === 'option'
          ? `${indent}  ${camel(field)}?: ${ts(arg(type, 0))};`
          : `${indent}  ${camel(field)}: ${ts(type)};`,
      ),
      `${indent}}`,
    ];
  }
  return [
    `${indent}export type ${name} =`,
    ...def.cases.map(([tag, payload], index) => {
      const end = index === def.cases.length - 1 ? ';' : '';
      return payload
        ? `${indent}  | { tag: '${tag}'; val: ${ts(payload)} }${end}`
        : `${indent}  | { tag: '${tag}'; val?: undefined }${end}`;
    }),
  ];
}

/** Renders the ambient module declaration for the versioned `database` interface. */
export function generateWitTypes(source: string): string {
  const version = parseWitVersion(source);
  const interfaces = parseWit(source);
  const database = interfaces.find((iface) => iface.name === 'database');
  if (!database) throw new Error('wit/world.wit has no `database` interface');
  // Every type of a used interface is emitted, so types the used ones refer to
  // (for example `pg-error` inside `error`) resolve inside the module.
  const shared: TypeDef[] = [];
  for (const use of database.uses) {
    const from = interfaces.find((iface) => iface.name === use.from);
    if (!from) throw new Error(`database uses unknown interface ${use.from}`);
    for (const name of use.names) {
      if (!from.types.some((type) => type.name === name)) {
        throw new Error(`interface ${use.from} has no type ${name}`);
      }
    }
    for (const def of from.types) if (!shared.includes(def)) shared.push(def);
  }
  const indent = '  ';
  const lines = [
    '// Generated by scripts/wit-types.ts from wit/world.wit. Do not edit:',
    '// run `bun scripts/wit-types.ts` after changing the WIT.',
    `declare module '${databaseInterface(version)}' {`,
  ];
  for (const def of [...shared, ...database.types]) {
    lines.push(...typeDef(def, indent), '');
  }
  for (const resource of database.resources) {
    lines.push(`${indent}export class ${pascal(resource.name)} {`);
    lines.push(`${indent}  private constructor();`);
    for (const method of resource.methods) {
      lines.push(
        `${indent}  ${camel(method.name)}(${tsParams(method.params)}): ${tsResult(method.result)};`,
      );
    }
    lines.push(`${indent}}`, '');
  }
  for (const func of database.funcs) {
    lines.push(
      `${indent}export function ${camel(func.name)}(${tsParams(func.params)}): ${tsResult(func.result)};`,
    );
  }
  lines.push('}', '');
  return lines.join('\n');
}

export const WIT_TYPES_PATH = join('js', 'wit.d.ts');

if (import.meta.main) {
  const pkgDir = join(import.meta.dir, '..');
  const source = await Bun.file(join(pkgDir, 'wit', 'world.wit')).text();
  const generated = generateWitTypes(source);
  const target = join(pkgDir, WIT_TYPES_PATH);
  if (Bun.argv.includes('--check')) {
    const current = await Bun.file(target)
      .text()
      .catch(() => '');
    if (current !== generated) {
      console.error(`${WIT_TYPES_PATH} is stale; run bun scripts/wit-types.ts`);
      process.exit(1);
    }
  } else {
    await Bun.write(target, generated);
    console.log(`wrote ${WIT_TYPES_PATH}`);
  }
}
