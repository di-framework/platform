import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..', 'prototype');

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
});
