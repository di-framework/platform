import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPacked, run, typescriptCompilers } from './helpers/packed-consumer';

const repoRoot = join(import.meta.dir, '..');

const scratch = mkdtempSync(join(tmpdir(), 'nodenext-consumer-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Pack an adapter and install the tarball into a fresh consumer next to its core peer. */
const installAdapter = (adapter: string): string =>
  installPacked(join(repoRoot, 'adapters', adapter), scratch, { links: ['@di-framework/core'] })
    .project;

/**
 * Type-check a NodeNext consumer against the packed declarations with every supported TypeScript
 * major. skipLibCheck stays off so an unresolvable relative import inside the shipped .d.ts
 * (TS2835) fails the compile, and the @ts-expect-error proves the imported type is real rather
 * than a silent `any`.
 */
function checkNodeNext(project: string, source: string, types: string[] = []): void {
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
        types,
        lib: ['ESNext', 'DOM'],
      },
      include: ['consumer.ts'],
    }),
  );
  writeFileSync(join(project, 'consumer.ts'), source);
  for (const tsc of Object.values(typescriptCompilers)) {
    run(['node', tsc, '-p', 'tsconfig.json'], project);
  }
}

/** Node's ESM loader needs the same extensions at runtime that NodeNext needs for types. */
function importWithNode(project: string, specifier: string): string[] {
  const script = `const m = await import(${JSON.stringify(specifier)}); console.log(JSON.stringify(Object.keys(m)));`;
  return JSON.parse(run(['node', '--input-type=module', '-e', script], project)) as string[];
}

describe('adapter declarations under NodeNext', () => {
  test('@di-framework/cloudflare type-checks and loads for a NodeNext consumer', () => {
    const project = installAdapter('cloudflare');
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
    const project = installAdapter('cloudfoundry');
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

describe('@di-framework/platform under NodeNext', () => {
  const packageDir = join(repoRoot, 'platform', 'platform');
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };

  test('the packed package type-checks and loads for a NodeNext consumer', () => {
    // The Pulumi and Kubernetes dependencies are linked from the workspace instead of installed.
    const { project, installed } = installPacked(packageDir, scratch, {
      links: [...Object.keys(manifest.dependencies), '@types/node'],
    });
    // The package is CommonJS today, where Node and TypeScript tolerate extensionless relative
    // specifiers; the shipped files still spell them out so they stay valid as ESM.
    const extensionless = [...new Bun.Glob('dist/**/*.{js,d.ts}').scanSync(installed)].flatMap(
      (file) =>
        [
          ...readFileSync(join(installed, file), 'utf8').matchAll(
            /(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g,
          ),
        ]
          .map((match) => match[1] as string)
          .filter((specifier) => !specifier.endsWith('.js'))
          .map((specifier) => `${file}: ${specifier}`),
    );
    expect(extensionless).toEqual([]);
    checkNodeNext(
      project,
      `import { createPlatform, kubeconfigServer, type PlatformArgs } from '@di-framework/platform';
import type { kubeconfig as localKubeconfig } from '@di-framework/platform/local';
import type { kubeconfig as existingKubeconfig } from '@di-framework/platform/existing';
export const create = createPlatform;
export const server = kubeconfigServer;
export type Local = typeof localKubeconfig;
export type Existing = typeof existingKubeconfig;
// @ts-expect-error a number is not PlatformArgs
export const bad: PlatformArgs = 42;
`,
      ['node'],
    );
    // ./local and ./existing are Pulumi programs that need a running engine, so only the root
    // entry is loaded; it pulls in every module the programs share.
    const keys = importWithNode(project, '@di-framework/platform');
    expect(keys).toContain('createPlatform');
    expect(keys).toContain('kubeconfigServer');
  });
});
