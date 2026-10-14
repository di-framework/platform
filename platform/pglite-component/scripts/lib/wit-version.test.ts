import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertComposedWit,
  assertProviderWit,
  databaseInterface,
  parseWitVersion,
  readWitVersion,
} from './wit-version.ts';

const pkgDir = join(import.meta.dir, '..', '..');

/** A world as `wasm-tools component wit` prints it, with the given import and export lines. */
function world(lines: string[]): string {
  return [
    'package root:component;',
    '',
    'world root {',
    '  import wasi:filesystem/preopens@0.2.6;',
    ...lines.map((line) => `  ${line}`),
    '}',
    '',
  ].join('\n');
}

describe('wit-version', () => {
  test('parses the package version', () => {
    expect(parseWitVersion('package di-framework:pglite@1.2.3;\n')).toBe('1.2.3');
    expect(() => parseWitVersion('package other:thing@1.0.0;')).toThrow('does not declare');
  });

  test('reads the version the guards use from wit/world.wit', async () => {
    const source = await Bun.file(join(pkgDir, 'wit', 'world.wit')).text();
    expect(await readWitVersion(pkgDir)).toBe(parseWitVersion(source));
  });
});

describe('build guard (assertProviderWit)', () => {
  test('accepts a provider that exports database at the WIT package version', async () => {
    const version = await readWitVersion(pkgDir);
    const wit = world([
      `export di-framework:pglite/types@${version};`,
      `export ${databaseInterface(version)};`,
    ]);
    expect(() => assertProviderWit(wit, version)).not.toThrow();
  });

  test('rejects a provider that exports an older database version than world.wit', () => {
    const wit = world(['export di-framework:pglite/database@0.1.0;']);
    expect(() => assertProviderWit(wit, '0.2.0')).toThrow(
      'component does not export di-framework:pglite/database@0.2.0',
    );
  });

  test('matches the whole version, not a prefix of it', () => {
    const wit = world(['export di-framework:pglite/database@0.2.01;']);
    expect(() => assertProviderWit(wit, '0.2.0')).toThrow('does not export');
    expect(() => assertProviderWit(wit, '0.2.01')).not.toThrow();
  });

  test('rejects a provider that does not export database at all', () => {
    expect(() => assertProviderWit(world([]), '0.2.0')).toThrow('does not export');
  });

  test('rejects socket and unplugged engine imports', () => {
    for (const leak of [
      'import wasi:sockets/tcp@0.2.6;',
      'import di-framework:pglite-engine/engine@0.1.0;',
    ]) {
      const wit = world([leak, 'export di-framework:pglite/database@0.2.0;']);
      expect(() => assertProviderWit(wit, '0.2.0'), leak).toThrow(
        'unexpected socket or unresolved engine import',
      );
    }
  });

  // `make build` output; skipped when dist/ has not been built (see package.test.ts).
  const builtWit = join(pkgDir, 'dist', 'di-framework-pglite.wit');
  const built = existsSync(builtWit) || process.env.PGLITE_REQUIRE_DIST === '1';
  test.skipIf(!built)('accepts the built provider and rejects it for another version', async () => {
    const wit = await Bun.file(builtWit).text();
    const version = await readWitVersion(pkgDir);
    expect(() => assertProviderWit(wit, version)).not.toThrow();
    expect(() => assertProviderWit(wit, '0.1.0')).toThrow('does not export');
  });
});

describe('compose guard (assertComposedWit)', () => {
  test('accepts a composed component whose database import was plugged', () => {
    const wit = world(['export wasi:cli/run@0.2.6;']);
    expect(() => assertComposedWit(wit, '0.2.0', 'out.wasm')).not.toThrow();
  });

  test('rejects a composed component that still imports database at the WIT version', () => {
    const wit = world(['import di-framework:pglite/database@0.2.0;']);
    expect(() => assertComposedWit(wit, '0.2.0', 'out.wasm')).toThrow(
      'out.wasm still imports di-framework:pglite/database@0.2.0; plug did not apply',
    );
  });
});
