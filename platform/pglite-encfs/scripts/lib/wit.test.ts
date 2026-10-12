import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { witPackageVersion } from './env.ts';
import { compositionProblems, ENCFS_EXPORTS, worldItems } from './wit.ts';

const PKG_DIR = join(import.meta.dir, '..', '..');

const PGLITE_IMPORTS = [
  'wasi:io/poll@0.2.9',
  'wasi:clocks/monotonic-clock@0.2.9',
  'wasi:clocks/wall-clock@0.2.9',
  'wasi:io/error@0.2.9',
  'wasi:io/streams@0.2.9',
  'wasi:cli/stdout@0.2.9',
  'wasi:cli/stderr@0.2.9',
  'wasi:cli/stdin@0.2.9',
  'wasi:cli/environment@0.2.9',
  'wasi:cli/exit@0.2.9',
  'wasi:cli/terminal-input@0.2.9',
  'wasi:filesystem/types@0.2.9',
  'wasi:filesystem/preopens@0.2.9',
  'wasi:random/random@0.2.3',
];
const pglite = {
  imports: PGLITE_IMPORTS,
  exports: ['di-framework:pglite/types@0.2.0', 'di-framework:pglite/database@0.2.0'],
};
const encfs = {
  imports: [...ENCFS_EXPORTS, 'wasi:clocks/wall-clock@0.2.9', 'wasi:random/random@0.2.3'],
  exports: [...ENCFS_EXPORTS],
};

describe('worldItems', () => {
  test('reads the first world and ignores dependency packages', () => {
    const wit = [
      'package root:component;',
      '',
      'world root {',
      '  import wasi:io/poll@0.2.9;',
      '  export di-framework:pglite/database@0.2.0;',
      '}',
      'package wasi:io@0.2.9 {',
      '  world other {',
      '    import wasi:io/error@0.2.9;',
      '  }',
      '}',
    ].join('\n');
    expect(worldItems(wit)).toEqual({
      imports: ['wasi:io/poll@0.2.9'],
      exports: ['di-framework:pglite/database@0.2.0'],
    });
  });

  test('rejects inline interfaces and incomplete worlds', () => {
    expect(() => worldItems('world root {\n  import x: interface {\n  }\n}')).toThrow(
      'named interface',
    );
    expect(() => worldItems('world root {\n  import wasi:io/poll@0.2.9;\n')).toThrow(
      'no complete world',
    );
  });
});

describe('compositionProblems', () => {
  test('accepts the layer that exactly fits pglite', () => {
    expect(compositionProblems(pglite, encfs, pglite)).toEqual([]);
  });

  test('a WASI version drift in pglite is caught before composing', () => {
    const drifted = {
      ...pglite,
      imports: PGLITE_IMPORTS.map((i) =>
        i.replace('filesystem/types@0.2.9', 'filesystem/types@0.2.10'),
      ),
    };
    expect(compositionProblems(drifted, encfs)).toContain(
      'pglite does not import wasi:filesystem/types@0.2.9; rebuild encfs from its WIT',
    );
  });

  test('a missing export or a new host import is a problem', () => {
    const partial = { ...encfs, exports: encfs.exports.filter((e) => !e.includes('environment')) };
    expect(compositionProblems(pglite, partial)[0]).toStartWith('encfs exports');
    const extra = { ...encfs, imports: [...encfs.imports, 'wasi:sockets/tcp@0.2.9'] };
    expect(compositionProblems(pglite, extra)).toEqual([
      'encfs imports wasi:sockets/tcp@0.2.9, which pglite does not',
    ]);
  });

  test('the composed provider must keep pglite’s imports and exports', () => {
    const composed = { imports: [...PGLITE_IMPORTS, 'wasi:sockets/tcp@0.2.9'], exports: [] };
    expect(compositionProblems(pglite, encfs, composed)).toHaveLength(2);
  });
});

describe('the committed WIT', () => {
  const wit = readFileSync(join(PKG_DIR, 'wit', 'world.wit'), 'utf8');

  test('declares the published version', () => {
    expect(witPackageVersion(wit)).toBe('0.1.0');
  });

  test('re-exports every interface it imports except wall-clock and random', () => {
    const items = worldItems(wit.replace(/^package [^;]+;/m, ''));
    expect([...items.exports].sort()).toEqual([...ENCFS_EXPORTS].sort());
    expect(items.imports.filter((i) => !items.exports.includes(i))).toEqual([
      'wasi:random/random@0.2.3',
    ]);
  });
});
