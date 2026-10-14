import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPacked, run, typescriptCompilers } from '../../../tests/helpers/packed-consumer';

const scratch = mkdtempSync(join(tmpdir(), 'tenant-client-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let project: string;
let installed: string;

test('a consumer outside the workspace imports ./client and ./testing from the packed tarball', () => {
  ({ project, installed } = installPacked(join(import.meta.dir, '..'), scratch, {
    links: ['@di-framework/core', '@di-framework/http'],
  }));
  writeFileSync(
    join(project, 'main.ts'),
    `import { createClient, ControllerError, events } from '@di-framework/tenant-cli/client';
const server = Bun.serve({ port: 0, fetch: () => Response.json({ account: 'acme', issuer: 'https://id', clientId: 'cli' }) });
const info = await createClient({ baseUrl: server.url.origin }).authInfo();
server.stop(true);
console.log(JSON.stringify({ info, error: typeof ControllerError, events: typeof events }));
`,
  );

  const out = JSON.parse(run(['bun', 'main.ts'], project));
  expect(out).toEqual({
    info: { account: 'acme', issuer: 'https://id', clientId: 'cli' },
    error: 'function',
    events: 'function',
  });

  // The ./testing fixture resolves from the tarball and needs nothing beyond the package itself.
  writeFileSync(
    join(project, 'fixture.ts'),
    `import { deployBundle } from '@di-framework/tenant-cli/testing';
const a = deployBundle({ env: 'staging' });
a.secrets.push('mutated');
const b = deployBundle();
console.log(JSON.stringify({ env: a.env, host: a.workload.spec.template.spec.hostInterfaces[0].config, secrets: b.secrets }));
`,
  );
  expect(JSON.parse(run(['bun', 'fixture.ts'], project))).toEqual({
    env: 'staging',
    host: { host: 'web-staging' },
    secrets: ['api-token'],
  });

  // A strict consumer that cannot import .ts files must still compile against the packed types.
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        target: 'ESNext',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: false,
        verbatimModuleSyntax: true,
        strict: true,
        noEmit: true,
        types: [],
        lib: ['ESNext', 'DOM'],
      },
      include: ['consumer.ts'],
    }),
  );
  writeFileSync(
    join(project, 'consumer.ts'),
    `import { createClient, events, type AuthInfo } from '@di-framework/tenant-cli/client';
export const info = (baseUrl: string): Promise<AuthInfo> => createClient({ baseUrl }).authInfo();
export const framing = events;
import { deployBundle } from '@di-framework/tenant-cli/testing';
import type { DeployBundle } from '@di-framework/tenant-cli/client';
export const bundle: DeployBundle = deployBundle({ service: 'api' });
`,
  );
  run(['node', typescriptCompilers.typescript7, '-p', 'tsconfig.json'], project);
});

test('a NodeNext consumer with skipLibCheck gets real types for ./client and ./testing, not any', () => {
  writeFileSync(
    join(project, 'tsconfig.nodenext.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ESNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        lib: ['ESNext', 'DOM'],
      },
      include: ['nodenext.ts'],
    }),
  );
  // The assignment errors only while AuthInfo is a real object type; if the types collapsed to
  // any, the expected error disappears and @ts-expect-error itself fails the compile.
  writeFileSync(
    join(project, 'nodenext.ts'),
    `import type { AuthInfo } from '@di-framework/tenant-cli/client';
// @ts-expect-error a number is not an AuthInfo
export const bad: AuthInfo = 42;
import { deployBundle } from '@di-framework/tenant-cli/testing';
// @ts-expect-error deployBundle takes a Partial<DeployBundle>, so an unknown key is rejected
export const badBundle = deployBundle({ notAField: true });
export const env: string = deployBundle().env;
`,
  );
  for (const tsc of Object.values(typescriptCompilers)) {
    run(['node', tsc, '-p', 'tsconfig.nodenext.json'], project);
  }
});

/** Every concrete subpath a package `exports` map offers, wildcard targets expanded on disk. */
function exportedSubpaths(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    exports: Record<string, string | Record<string, string>>;
  };
  const specifiers: string[] = [];
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath === './package.json') continue;
    if (!subpath.includes('*')) {
      specifiers.push(`${manifest.name}/${subpath.slice(2)}`);
      continue;
    }
    const pattern = typeof target === 'string' ? target : target.default;
    if (pattern === undefined) throw new Error(`export ${subpath} has no default target`);
    const dir = pattern.slice(2, pattern.indexOf('*'));
    const files = (readdirSync(join(root, dir), { recursive: true }) as string[]).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.d.ts'),
    );
    specifiers.push(
      ...files.map((file) => `${manifest.name}/${subpath.slice(2).replace('*', file)}`),
    );
  }
  return specifiers;
}

test('every exported subpath resolves and loads from the packed tarball', () => {
  const specifiers = exportedSubpaths(installed);
  // The wildcard export must expand to real files, or an unpublished target would pass vacuously.
  expect(specifiers.filter((s) => s.includes('/src/api/')).length).toBeGreaterThan(0);

  // The shipped controller sources use legacy decorators, so a consumer enables them for Bun.
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { experimentalDecorators: true } }),
  );
  writeFileSync(
    join(project, 'exports.ts'),
    `const failures: string[] = [];
for (const specifier of ${JSON.stringify(specifiers)}) {
  try {
    await import(specifier);
  } catch (error) {
    failures.push(specifier + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}
console.log(JSON.stringify(failures));
`,
  );
  expect(JSON.parse(run(['bun', 'exports.ts'], project))).toEqual([]);

  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
  };
  expect(Object.keys(manifest.exports)).not.toContain('./tests/support/*');
});
