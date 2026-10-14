import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPacked, run, typescriptCompilers } from '../../../tests/helpers/packed-consumer';

const scratch = mkdtempSync(join(tmpdir(), 'tenant-client-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let project: string;

test('a consumer outside the workspace imports ./client and ./testing from the packed tarball', () => {
  ({ project } = installPacked(join(import.meta.dir, '..'), scratch));
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
