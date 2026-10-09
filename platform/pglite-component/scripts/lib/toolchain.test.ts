import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportEnvLines, resolveToolsEnv, type Tools } from './toolchain.ts';

async function withToolsDir(fn: (tools: Tools) => Promise<void>): Promise<void> {
  const toolsDir = await mkdtemp(join(tmpdir(), 'df-pglite-tools.'));
  try {
    await fn({
      pkgDir: '/pkg',
      toolsDir,
      binDir: join(toolsDir, 'bin'),
      cacheDir: join(toolsDir, 'cache'),
      pins: {},
      rustToolchain: '1.97.1',
      rustTarget: 'wasm32-wasip2',
    });
  } finally {
    await rm(toolsDir, { recursive: true, force: true });
  }
}

// An empty-ish PATH keeps a developer's real rustup out of these tests.
const base = { PATH: '/nonexistent', HOME: '/home/dev' };

describe('resolveToolsEnv', () => {
  test('adds reproducibility RUSTFLAGS without hermetic tools', async () => {
    await withToolsDir(async (tools) => {
      const env = await resolveToolsEnv(tools, base);
      expect(env.PATH).toBe('/nonexistent');
      expect(env.RUSTUP_HOME).toBeUndefined();
      expect(env.RUSTFLAGS).toBe(
        '--remap-path-prefix=/pkg=/di-framework-pglite-component --remap-path-prefix=/home/dev/.cargo=/cargo',
      );
      expect(env.DF_PGLITE_ENV_LOADED).toBe('/pkg');
      expect(env.DF_PGLITE_TOOLS_DIR).toBe(tools.toolsDir);
    });
  });

  test('prefers hermetic bin/ and cargo/ when installed', async () => {
    await withToolsDir(async (tools) => {
      const cargoBin = join(tools.toolsDir, 'cargo', 'bin');
      await mkdir(tools.binDir, { recursive: true });
      await mkdir(cargoBin, { recursive: true });
      await Bun.write(join(cargoBin, 'cargo'), '#!/bin/sh\n');
      await chmod(join(cargoBin, 'cargo'), 0o755);

      const env = await resolveToolsEnv(tools, base);
      expect(env.PATH).toBe(`${cargoBin}:${tools.binDir}:/nonexistent`);
      expect(env.RUSTUP_HOME).toBe(join(tools.toolsDir, 'rustup'));
      expect(env.CARGO_HOME).toBe(join(tools.toolsDir, 'cargo'));
      expect(env.RUSTFLAGS).toContain(
        `--remap-path-prefix=${join(tools.toolsDir, 'cargo')}=/cargo`,
      );
    });
  });

  test('is idempotent once the environment is loaded', async () => {
    await withToolsDir(async (tools) => {
      const first = await resolveToolsEnv(tools, base);
      const second = await resolveToolsEnv(tools, { ...base, ...first });
      expect(second).toEqual(first);
    });
  });
});

describe('exportEnvLines', () => {
  test('quotes values for POSIX eval', () => {
    const lines = exportEnvLines({
      PATH: "/it's/bin:/usr/bin",
      RUSTFLAGS: '',
      DF_PGLITE_TOOLS_DIR: '/pkg/.tools',
      DF_PGLITE_ENV_LOADED: '/pkg',
    });
    expect(lines).toEqual([
      "export DF_PGLITE_TOOLS_DIR='/pkg/.tools'",
      "export PATH='/it'\\''s/bin:/usr/bin'",
      "export DF_PGLITE_ENV_LOADED='/pkg'",
    ]);
  });
});
