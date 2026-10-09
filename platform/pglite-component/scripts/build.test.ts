import { describe, expect, test } from 'bun:test';
import { parseBuildArgs } from './build.ts';

describe('parseBuildArgs', () => {
  test('selects the cargo profile', () => {
    expect(parseBuildArgs([])).toEqual({ help: false, profile: 'release', profileDir: 'release' });
    expect(parseBuildArgs(['--debug'])).toEqual({
      help: false,
      profile: 'dev',
      profileDir: 'debug',
    });
    expect(parseBuildArgs(['--help'])).toEqual({ help: true });
  });
});
