import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { databaseInterface, parseWitVersion, readWitVersion } from './wit-version.ts';

describe('wit-version', () => {
  test('parses the package version', () => {
    expect(parseWitVersion('package di-framework:pglite@1.2.3;\n')).toBe('1.2.3');
    expect(() => parseWitVersion('package other:thing@1.0.0;')).toThrow('does not declare');
  });

  test('the build and compose guards follow the WIT package version', async () => {
    const version = await readWitVersion(join(import.meta.dir, '..', '..'));
    expect(databaseInterface(version)).toBe(`di-framework:pglite/database@${version}`);
    for (const script of ['build.ts', 'compose.ts']) {
      const src = await Bun.file(join(import.meta.dir, '..', script)).text();
      expect(src, script).not.toMatch(/pglite(\/database)?@\d/);
      expect(src, script).toContain('wit-version');
    }
  });
});
