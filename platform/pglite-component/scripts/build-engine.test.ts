import { describe, expect, test } from 'bun:test';
import { patchUpstreamBuild } from './build-engine.ts';

const upstreamVersions = [
  'SDK_SHA256_X86_64=__FILLED_BY_FIRST_BUILD__',
  'WASI_SDK_OVERLAY_SHA256_X86_64=__FILLED_BY_FIRST_BUILD__',
  '',
].join('\n');

const upstreamBuild = [
  '#!/usr/bin/env bash',
  'docker build -t "$IMG" .',
  'IMG=wasipg-builder:latest',
  'docker run --rm \\',
  '  -v "$(pwd)/$SRC:/workspace:rw" \\',
  '  "$IMG" bash -c \'./wasm-build.sh; /pack.sh\'',
  '',
  '(cd .. && go run ./cmd/mkdata -bundle build/out/pglite-wasi.tar.xz)',
  'cp ../NOTICE out/NOTICE',
  '',
].join('\n');

describe('patchUpstreamBuild', () => {
  const patched = patchUpstreamBuild(
    upstreamVersions,
    upstreamBuild,
    'sdk-sha',
    'wasi-sdk-sha',
    '/pkg/scripts/patch-engine-source.ts',
  );

  test('fills the x86_64 SDK pins', () => {
    expect(patched.versionsEnv).toContain('SDK_SHA256_X86_64=sdk-sha');
    expect(patched.versionsEnv).toContain('WASI_SDK_OVERLAY_SHA256_X86_64=wasi-sdk-sha');
    expect(patched.versionsEnv).not.toContain('__FILLED_BY_FIRST_BUILD__');
  });

  test('replaces the docker run tail with the container block', () => {
    expect(patched.buildSh).toContain('docker build --load -t');
    expect(patched.buildSh).toContain(
      'bun "/pkg/scripts/patch-engine-source.ts" "$SRC"\n\nIMG=wasipg-builder:',
    );
    expect(patched.buildSh).toContain('docker create --name "$CONTAINER"');
    expect(patched.buildSh).toContain('docker cp "$SRC/." "$CONTAINER:/workspace"');
    expect(patched.buildSh).not.toContain('docker run --rm');
    expect(patched.buildSh).not.toContain('go run ./cmd/mkdata');
    expect(patched.buildSh).not.toContain('-v "$(pwd)/$SRC:/workspace:rw"');
    expect(patched.buildSh.endsWith('cp ../NOTICE out/NOTICE\n')).toBe(true);
    expect(patched.buildSh.split('cp ../NOTICE out/NOTICE')).toHaveLength(2);
  });

  test('fails loudly when the upstream anchor moves', () => {
    expect(() =>
      patchUpstreamBuild(upstreamVersions, 'IMG=wasipg-builder:x\n', 'a', 'b', '/p.ts'),
    ).toThrow('anchor not found');
  });
});
