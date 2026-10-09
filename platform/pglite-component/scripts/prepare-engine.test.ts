import { describe, expect, test } from 'bun:test';
import {
  PG_STRONG_RANDOM_REPLACEMENT,
  patchEngineWat,
  validateArchiveMembers,
} from './prepare-engine.ts';

describe('validateArchiveMembers', () => {
  const file = (name: string) => ({
    name,
    isDirectory: false,
    isSymlink: false,
    isHardlink: false,
    isFile: true,
  });

  test('accepts tmp/pglite members and strips the prefix', () => {
    expect(validateArchiveMembers([file('tmp/pglite/bin/pglite.wasi')])).toEqual([
      'bin/pglite.wasi',
    ]);
  });

  test('rejects escapes, absolute paths, and bad links', () => {
    expect(() => validateArchiveMembers([file('etc/passwd')])).toThrow('unsafe archive member');
    expect(() => validateArchiveMembers([file('tmp/pglite/../../evil')])).toThrow(
      'unsafe archive member',
    );
    expect(() =>
      validateArchiveMembers([
        {
          name: 'tmp/pglite/link',
          isDirectory: false,
          isSymlink: true,
          isHardlink: false,
          isFile: false,
          linkTarget: '/etc/passwd',
        },
      ]),
    ).toThrow('unsafe archive link');
    expect(() =>
      validateArchiveMembers([
        {
          name: 'tmp/pglite/link',
          isDirectory: false,
          isSymlink: true,
          isHardlink: false,
          isFile: false,
          linkTarget: '../evil',
        },
      ]),
    ).toThrow('unsafe archive link');
    expect(() =>
      validateArchiveMembers([
        {
          name: 'tmp/pglite/fifo',
          isDirectory: false,
          isSymlink: false,
          isHardlink: false,
          isFile: false,
        },
      ]),
    ).toThrow('unexpected archive member');
  });

  test('accepts links that stay inside the prefix', () => {
    const members = validateArchiveMembers([
      {
        name: 'tmp/pglite/bin/tool',
        isDirectory: false,
        isSymlink: true,
        isHardlink: false,
        isFile: false,
        linkTarget: 'tool.real',
      },
    ]);
    expect(members).toEqual(['bin/tool']);
  });
});

describe('patchEngineWat', () => {
  const wat = [
    '(module',
    '  (func $pg_strong_random (param i32 i32) (result i32)',
    '    unreachable',
    '  )',
    '  (data "/tmp/initdb.boot.txt")',
    '  (data "/tmp/initdb.single.txt")',
    '  (export "_start" (func $_start))',
    ')',
    '',
  ].join('\n');

  test('rewrites entropy, bootstrap paths, and drops _start', () => {
    const bridge = '(elem test)';
    const patched = patchEngineWat(wat, bridge);
    expect(patched).toContain(PG_STRONG_RANDOM_REPLACEMENT);
    expect(patched).not.toContain('/tmp/initdb.boot.txt');
    expect(patched).toContain('./../initdb.boot.txt');
    expect(patched).toContain('./../initdb.single.txt');
    expect(patched).not.toContain('(export "_start"');
    expect(patched.endsWith(`${bridge}\n)\n`)).toBe(true);
  });

  test('fails closed when the engine ABI changes', () => {
    expect(() => patchEngineWat('(module)', '(elem)')).toThrow('pg_strong_random');
  });
});
