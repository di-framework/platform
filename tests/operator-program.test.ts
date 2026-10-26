/**
 * The platform operator's embedded Pulumi program (`program` in platform/operator/internal/installer/pulumi.go)
 * type-checks against the built platform package, with the tsconfig the operator writes. Pulumi type-checks
 * `index.ts` at run time, so a type error here would fail every install (#460 review S1).
 *
 * The project is laid out the way npm installs the operator's package.json: `@di-framework/platform` with
 * `@pulumi/pulumi` and `@pulumi/kubernetes` hoisted next to it, and `@types/node`.
 */
import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const installer = join(root, 'platform', 'operator', 'internal', 'installer');
const platformPkg = join(root, 'platform', 'platform');
const pulumiGo = readFileSync(join(installer, 'pulumi.go'), 'utf8');
const installerGo = readFileSync(join(installer, 'installer.go'), 'utf8');

/** The Go constant `name`'s string value: its raw-string pieces, with `" + Ident + "` joins resolved. */
function goString(source: string, name: string, idents: Record<string, string>): string {
  const match = source.match(new RegExp(`${name} = ((?:\`[^\`]*\`(?: \\+ \\w+ \\+ )?)+)`));
  if (!match?.[1]) throw new Error(`no ${name} in source`);
  return match[1]
    .replace(/` \+ (\w+) \+ `/g, (_, ident: string) => {
      const value = idents[ident];
      if (value === undefined) throw new Error(`unknown identifier ${ident}`);
      return value;
    })
    .slice(1, -1);
}

const secretKey = installerGo.match(/TenantAuthClientSecretKey = "([^"]+)"/)?.[1] ?? '';
const program = goString(pulumiGo, 'const program', { TenantAuthClientSecretKey: secretKey });
const tsconfig = JSON.parse(pulumiGo.match(/tsconfig := `([^`]+)`/)?.[1] ?? '');

function link(target: string, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'dir');
}

describe('the operator Pulumi program', () => {
  test('is extracted whole from pulumi.go', () => {
    expect(secretKey).toBe('tenantAuthClientSecret');
    expect(program).toContain("config.getSecret('tenantAuthClientSecret')");
    expect(program).toContain("from '@di-framework/platform/existing'");
    expect(program.trimEnd().endsWith('}')).toBe(true);
    expect(tsconfig.include).toEqual(['index.ts']);
  });

  test('type-checks against the built platform package', () => {
    expect(existsSync(join(platformPkg, 'dist', 'existing.d.ts'))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'operator-program-'));
    try {
      const modules = join(dir, 'node_modules');
      link(platformPkg, join(modules, '@di-framework', 'platform'));
      for (const name of ['pulumi', 'kubernetes']) {
        link(join(platformPkg, 'node_modules', '@pulumi', name), join(modules, '@pulumi', name));
      }
      link(join(platformPkg, 'node_modules', '@types', 'node'), join(modules, '@types', 'node'));
      writeFileSync(join(dir, 'index.ts'), program);
      // TypeScript 6 deprecates the `node` (node10) resolution the operator's TypeScript 5.9 uses.
      const config = {
        ...tsconfig,
        compilerOptions: { ...tsconfig.compilerOptions, ignoreDeprecations: '6.0' },
      };
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
      const result = Bun.spawnSync(
        [join(root, 'node_modules', '.bin', 'tsc6'), '--noEmit', '-p', dir],
        {
          cwd: dir,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      expect(`${result.stdout}${result.stderr}`).toBe('');
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
