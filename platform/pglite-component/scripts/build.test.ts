import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { engineBuildInfo, parseBuildArgs, THIRD_PARTY_NOTICE_FILES } from './build.ts';
import { postgresVersion } from './build-engine.ts';
import { loadPins } from './lib/versions.ts';

const engineDir = resolve(import.meta.dir, '..', 'engine');

describe('third-party notices', () => {
  test('ship every pgcrypto copyright line its BSD-licensed sources carry', async () => {
    expect(THIRD_PARTY_NOTICE_FILES).toContain('PGCRYPTO-NOTICES');
    const notices = await Bun.file(join(engineDir, 'PGCRYPTO-NOTICES')).text();
    // pgcrypto.h (2000), pgcrypto.c, openssl.c and px* (2001), pgp* and mbuf* (2005).
    for (const year of ['2000', '2001', '2005']) {
      expect(notices).toContain(`Copyright (c) ${year} Marko Kreen`);
    }
    expect(notices).toContain('Copyright (c) 1994 David Burren');
  });
});

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

describe('engineBuildInfo', () => {
  test('names PostgreSQL 17.11, its upstream commit, the WASI patch and the recipe', async () => {
    const pins = await loadPins(resolve(import.meta.dir, '..'));
    expect(engineBuildInfo(pins, 'abc123')).toEqual([
      'engine:          PostgreSQL 17.11, persistent WASI filesystem',
      'extensions:      plpgsql, pgcrypto (OpenSSL 3.5.9 libcrypto)',
      'engine-source:   https://github.com/postgres/postgres/tree/083ac033419f690758508e08c1736089384bbee8 (REL_17_11)',
      'engine-patch:    engine/patches/postgresql-17.11-wasi.patch (sha256 abc123)',
      `engine-recipe:   https://github.com/moznion/wasipg/tree/${pins.PGLITE_SOURCE_REF}`,
    ]);
  });

  test('reads the version from the release tag', () => {
    expect(postgresVersion('REL_17_11')).toBe('17.11');
    expect(postgresVersion('REL_18_6')).toBe('18.6');
    expect(() => postgresVersion('REL_17_STABLE')).toThrow('not a PostgreSQL release tag');
  });
});

describe('third-party notices name the engine base', () => {
  test('NOTICE names upstream 17.11 and the replayed Electric changes', async () => {
    const notice = await Bun.file(join(engineDir, 'NOTICE')).text();
    expect(notice).toContain('PostgreSQL 17.11');
    expect(notice).toContain('REL_17_5_WASM-pglite');
    expect(notice).toContain('engine/patches/postgresql-17.11-wasi.patch');
  });
});
