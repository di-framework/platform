import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { loadPins } from './lib/versions.ts';
import { PACKAGE_PROVIDER, previousRelease } from './smoke.ts';

describe('cross-version smoke step', () => {
  test('writes the data directory with the published 6.0.15 (PostgreSQL 17.5) provider', async () => {
    const release = previousRelease(await loadPins(resolve(import.meta.dir, '..')));
    expect(release).toEqual({
      version: '6.0.15',
      postgres: '17.5',
      url: 'https://registry.npmjs.org/@di-framework/pglite-component/-/pglite-component-6.0.15.tgz',
      sha256: '82b7226fb39f098cab5fb8a5740686a0cbbce48e28b6e036f21804edab200b7d',
    });
    expect(PACKAGE_PROVIDER).toBe('package/dist/di-framework-pglite.wasm');
  });

  test('refuses to run without the pins', () => {
    expect(() => previousRelease({})).toThrow('missing pin PGLITE_UPGRADE_FROM_VERSION');
  });
});
