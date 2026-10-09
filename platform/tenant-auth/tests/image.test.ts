import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = join(import.meta.dir, '..');
const repo = join(pkg, '..', '..');
const dockerfile = readFileSync(join(pkg, 'Dockerfile'), 'utf8');
const workflow = readFileSync(join(repo, '.github/workflows/tenant-auth-image.yml'), 'utf8');

test('the Dockerfile bundles entry points that exist', () => {
  for (const entry of dockerfile.match(/platform\/tenant-auth\/src\/\w+\.ts/g) ?? []) {
    expect(existsSync(join(repo, entry))).toBe(true);
  }
  expect(dockerfile).toContain('platform/tenant-auth/src/controller.ts');
  expect(dockerfile).toContain('platform/tenant-auth/src/console.ts');
});

test('both stages use a base image pinned by digest, and the image does not run as root', () => {
  const froms = dockerfile.match(/^FROM .*$/gm) ?? [];
  expect(froms).toHaveLength(2);
  for (const from of froms) expect(from).toMatch(/@sha256:[0-9a-f]{64}/);
  expect(dockerfile).toContain('USER 1000:1000');
});

test('the entry points bundle for Bun', async () => {
  const result = await Bun.build({
    entrypoints: [join(pkg, 'src/controller.ts'), join(pkg, 'src/console.ts')],
    target: 'bun',
  });
  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(2);
});

test('the publish workflow is dispatch-only and builds the Dockerfile from the repo root', () => {
  expect(workflow).toMatch(/on:\s+workflow_dispatch:\s+permissions:/);
  expect(workflow).toContain('file: platform/tenant-auth/Dockerfile');
  expect(workflow).toContain('context: .');
  expect(workflow).toContain('ghcr.io/di-framework/tenant-auth');
  expect(existsSync(join(pkg, 'Dockerfile.dockerignore'))).toBe(true);
});
