import { describe, expect, test } from 'bun:test';
import { parseFlags, UsageError } from './cli.ts';

describe('parseFlags', () => {
  const options = { debug: { type: 'boolean' }, out: { type: 'string' } } as const;

  test('parses typed flags and positionals', () => {
    const flags = parseFlags(['--debug', '--out', 'x.wasm', 'app'], options, 'usage', {
      positionals: true,
    });
    expect(flags).toEqual({
      help: false,
      values: { debug: true, out: 'x.wasm' },
      positionals: ['app'],
    });
  });

  test('reports --help instead of exiting', () => {
    expect(parseFlags(['-h'], options, 'usage')).toEqual({ help: true });
  });

  test('turns unknown flags and stray positionals into UsageError with usage text', () => {
    expect(() => parseFlags(['--nope'], options, 'USAGE TEXT')).toThrow(UsageError);
    expect(() => parseFlags(['--nope'], options, 'USAGE TEXT')).toThrow('USAGE TEXT');
    expect(() => parseFlags(['stray'], options, 'usage')).toThrow(UsageError);
  });
});
