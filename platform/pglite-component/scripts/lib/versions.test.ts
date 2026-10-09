import { describe, expect, test } from 'bun:test';
import { parseVersions, requiredPin } from './versions.ts';

describe('parseVersions', () => {
  test('parses KEY=VALUE, skips comments and blanks', () => {
    const pins = parseVersions('# comment\n\nRUST_TOOLCHAIN=1.97.1\nEMPTY_OK=\nNOEQUALS\nA=B=C\n');
    expect(pins.RUST_TOOLCHAIN).toBe('1.97.1');
    expect(pins.EMPTY_OK).toBe('');
    expect(pins.A).toBe('B=C');
    expect('NOEQUALS' in pins).toBe(false);
  });

  test('requiredPin throws on missing keys', () => {
    expect(() => requiredPin({}, 'MISSING')).toThrow('missing pin MISSING');
  });
});
