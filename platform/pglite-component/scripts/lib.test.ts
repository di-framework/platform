import { describe, expect, test } from 'bun:test';
import { parseBuildArgs } from './build.ts';
import { parseComposeArgs } from './compose.ts';
import { detectPlatform, parseInstallArgs } from './install-tools.ts';
import { parseVersions, requiredPin } from './lib.ts';

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

describe('detectPlatform', () => {
  test('maps node platform/arch names to triples', () => {
    expect(detectPlatform('darwin', 'arm64')).toMatchObject({
      os: 'macos',
      arch: 'aarch64',
      rustTriple: 'aarch64-apple-darwin',
      wacTriple: 'aarch64-apple-darwin',
    });
    expect(detectPlatform('linux', 'x64')).toMatchObject({
      os: 'linux',
      arch: 'x86_64',
      rustTriple: 'x86_64-unknown-linux-gnu',
      wacTriple: 'x86_64-unknown-linux-musl',
    });
  });
});

describe('CLI arg parsing', () => {
  test('install-tools flags', () => {
    expect(parseInstallArgs([])).toEqual({ withRust: false, wacOnly: false });
    expect(parseInstallArgs(['--rust'])).toEqual({ withRust: true, wacOnly: false });
    expect(parseInstallArgs(['--wac-only'])).toEqual({ withRust: false, wacOnly: true });
  });

  test('build profiles', () => {
    expect(parseBuildArgs([])).toEqual({ profile: 'release', profileDir: 'release' });
    expect(parseBuildArgs(['--debug'])).toEqual({ profile: 'dev', profileDir: 'debug' });
  });

  test('compose defaults the provider into dist/', () => {
    const args = parseComposeArgs(['app.wasm', 'out.wasm'], '/pkg');
    expect(args).toEqual({
      app: 'app.wasm',
      out: 'out.wasm',
      provider: '/pkg/dist/di-framework-pglite.wasm',
    });
  });
});
