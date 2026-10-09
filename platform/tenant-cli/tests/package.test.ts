import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (cmd: string[], cwd: string) => {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString();
};

test('a consumer outside the workspace imports ./client from the packed tarball and calls authInfo', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tenant-client-'));
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
});
