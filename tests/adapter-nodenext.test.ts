import { afterAll, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc');

const run = (cmd: string[], cwd: string) => {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')}:\n${result.stdout.toString()}${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

const scratch = mkdtempSync(join(tmpdir(), 'adapter-nodenext-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Pack an adapter and install the tarball into a fresh consumer next to its core peer. */
function installPacked(adapter: string): string {
  const packageDir = join(repoRoot, 'adapters', adapter);
  run(['bun', 'run', 'build'], packageDir);
  const packs = join(scratch, `${adapter}-pack`);
  mkdirSync(packs);
  run(['bun', 'pm', 'pack', '--ignore-scripts', '--destination', packs], packageDir);
  const tarball = readdirSync(packs).find((name) => name.endsWith('.tgz'));
  expect(tarball).toBeDefined();

  const project = join(scratch, `${adapter}-consumer`);
  const scope = join(project, 'node_modules', '@di-framework');
  mkdirSync(scope, { recursive: true });
  run(['tar', '-xzf', join(packs, tarball as string)], scope);
  run(['mv', join(scope, 'package'), join(scope, adapter)], scope);
  symlinkSync(
    realpathSync(join(packageDir, 'node_modules', '@di-framework', 'core')),
    join(scope, 'core'),
  );
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'consumer', type: 'module' }),
  );
  return project;
}

/**
 * Type-check a NodeNext consumer against the packed declarations. skipLibCheck stays off so an
 * unresolvable relative import inside the shipped .d.ts (TS2835) fails the compile, and the
 * @ts-expect-error proves the imported type is real rather than a silent `any`.
 */
function checkNodeNext(project: string, source: string): void {
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ESNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        experimentalDecorators: true,
        types: [],
        lib: ['ESNext', 'DOM'],
      },
      include: ['consumer.ts'],
    }),
  );
  writeFileSync(join(project, 'consumer.ts'), source);
  run(['node', tsc, '-p', 'tsconfig.json'], project);
}

/** Node's ESM loader needs the same extensions at runtime that NodeNext needs for types. */
function importWithNode(project: string, specifier: string): string[] {
  const script = `const m = await import(${JSON.stringify(specifier)}); console.log(JSON.stringify(Object.keys(m)));`;
  return JSON.parse(run(['node', '--input-type=module', '-e', script], project)) as string[];
}

describe('adapter declarations under NodeNext', () => {
  test('@di-framework/cloudflare type-checks and loads for a NodeNext consumer', () => {
    const project = installPacked('cloudflare');
    checkNodeNext(
      project,
      `import { CloudflareEnvironment, parseWranglerBindings } from '@di-framework/cloudflare';
import type { CloudflareBindingInfo } from '@di-framework/cloudflare';
export const env: CloudflareEnvironment = new CloudflareEnvironment();
export const parse = parseWranglerBindings;
// @ts-expect-error a number is not a CloudflareBindingInfo
export const bad: CloudflareBindingInfo = 42;
`,
    );
    expect(importWithNode(project, '@di-framework/cloudflare')).toContain('CloudflareEnvironment');
  });

  test('@di-framework/cloudfoundry type-checks and loads for a NodeNext consumer', () => {
    const project = installPacked('cloudfoundry');
    checkNodeNext(
      project,
      `import { CloudFoundryEnvironment, parseVcapApplication } from '@di-framework/cloudfoundry';
import type { CloudFoundryServiceInfo } from '@di-framework/cloudfoundry';
export const env: CloudFoundryEnvironment = new CloudFoundryEnvironment();
export const parse = parseVcapApplication;
// @ts-expect-error a number is not a CloudFoundryServiceInfo
export const bad: CloudFoundryServiceInfo = 42;
`,
    );
    expect(importWithNode(project, '@di-framework/cloudfoundry')).toContain(
      'CloudFoundryEnvironment',
    );
  });
});
