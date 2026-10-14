import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..', 'prototype');
const platformDir = join(import.meta.dir, '..', '..', 'platform');
const PULUMI_PACKAGES = ['@pulumi/pulumi', '@pulumi/kubernetes'] as const;

describe('backup prototype Pulumi program', () => {
  // Pulumi's nodejs runtime loads ts-node, which needs the TypeScript compiler API.
  // TypeScript 7 ships no such API, so the prototype must pin its own TypeScript < 7
  // instead of resolving the repo root's.
  test('pins a TypeScript release that has the compiler API', async () => {
    const pkg = await Bun.file(join(dir, 'package.json')).json();
    const range: string = pkg.devDependencies?.typescript;
    expect(range).toBeDefined();
    expect(Bun.semver.satisfies('5.9.3', range)).toBe(true);
    expect(Bun.semver.satisfies('7.0.2', range)).toBe(false);
  });

  test('lockfile resolves the pinned TypeScript', async () => {
    const lock = await Bun.file(join(dir, 'bun.lock')).text();
    expect(lock).toMatch(/"typescript@5\.\d+\.\d+"/);
    expect(lock).not.toMatch(/"typescript@[67]\./);
  });

  // index.ts passes its own pulumi.Config and k8s.Provider to createPlatform from
  // @di-framework/platform's dist, whose types come from that package's @pulumi/* (#251).
  test('pins the same @pulumi/* versions as @di-framework/platform', async () => {
    const prototype = await Bun.file(join(dir, 'package.json')).json();
    const platform = await Bun.file(join(platformDir, 'package.json')).json();
    for (const name of PULUMI_PACKAGES) {
      expect(platform.dependencies?.[name]).toBeDefined();
      expect({ name, version: prototype.dependencies?.[name] }).toEqual({
        name,
        version: platform.dependencies[name],
      });
    }
  });

  test('lockfile resolves those @pulumi/* versions', async () => {
    const lock = await Bun.file(join(dir, 'bun.lock')).text();
    const platform = await Bun.file(join(platformDir, 'package.json')).json();
    for (const name of PULUMI_PACKAGES) {
      expect(lock).toContain(`"${name}": ["${name}@${platform.dependencies[name]}"`);
    }
  });

  // The prototype installs its own @pulumi/* (they must resolve TypeScript < 7), so the
  // platform's dist .d.ts would otherwise see a second physical copy and Config/Provider
  // would not be assignable. paths makes the type checker use one copy; the pins above
  // keep that copy the same version the platform was built against.
  test('type-checks @pulumi/* against one copy', async () => {
    const tsconfig = await Bun.file(join(dir, 'tsconfig.json')).json();
    const paths: Record<string, string[]> = tsconfig.compilerOptions?.paths ?? {};
    for (const name of PULUMI_PACKAGES) {
      expect(paths[name]).toEqual([`./node_modules/${name}`]);
      expect(paths[`${name}/*`]).toEqual([`./node_modules/${name}/*`]);
    }
  });
});
