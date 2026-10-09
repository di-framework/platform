import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (cmd: string[], cwd: string) => {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString();
};

const scratch = mkdtempSync(join(tmpdir(), 'tenant-client-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('a consumer outside the workspace imports ./client from the packed tarball and calls authInfo', () => {
  run(['bun', 'run', 'build'], join(import.meta.dir, '..'));
  run(
    ['bun', 'pm', 'pack', '--ignore-scripts', '--destination', scratch],
    join(import.meta.dir, '..'),
  );
  const tarball = readdirSync(scratch).find((name) => name.endsWith('.tgz'));
  expect(tarball).toBeDefined();

  const project = join(scratch, 'consumer');
  const installed = join(project, 'node_modules', '@di-framework');
  mkdirSync(installed, { recursive: true });
  run(['tar', '-xzf', join(scratch, tarball as string)], installed);
  run(['mv', join(installed, 'package'), join(installed, 'tenant-cli')], installed);

  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'consumer', type: 'module' }),
  );
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
`,
  );
  const tsc = join(import.meta.dir, '../../../node_modules/typescript/bin/tsc');
  run(['node', tsc, '-p', 'tsconfig.json'], project);
});
