import { describe, expect, test } from 'bun:test';
import { detectPlatform, parseInstallArgs } from './install-tools.ts';

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

  test('rejects platforms without pinned binaries', () => {
    expect(() => detectPlatform('win32', 'x64')).toThrow('unsupported OS: win32');
    expect(() => detectPlatform('linux', 'riscv64')).toThrow('unsupported architecture: riscv64');
  });
});

describe('parseInstallArgs', () => {
  test('install-tools flags', () => {
    expect(parseInstallArgs([])).toEqual({ help: false, withRust: false, wacOnly: false });
    expect(parseInstallArgs(['--rust'])).toEqual({ help: false, withRust: true, wacOnly: false });
    expect(parseInstallArgs(['--wac-only'])).toEqual({
      help: false,
      withRust: false,
      wacOnly: true,
    });
  });
});
