import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { parseBuildArgs, THIRD_PARTY_NOTICE_FILES } from './build.ts';

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
