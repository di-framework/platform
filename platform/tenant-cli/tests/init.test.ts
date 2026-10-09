import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../src/init.ts';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tenant-init-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

test('seeds a package, the component config, and one handler, and refuses to overwrite', () => {
  const seeded = init({ name: 'orders', cwd: scratch });
  expect(seeded).toEqual({
    directory: join(scratch, 'orders'),
    files: ['package.json', 'di-framework.config.json', 'src/app.ts'],
  });
  const config = JSON.parse(
    readFileSync(join(seeded.directory, 'di-framework.config.json'), 'utf8'),
  );
  expect(config).toEqual({ name: 'orders', entry: 'src/app.ts', output: 'dist/orders.wasm' });
  expect(readFileSync(join(seeded.directory, 'src/app.ts'), 'utf8')).toContain('"orders"');
  expect(() => init({ name: 'orders', cwd: scratch })).toThrow('already exist');
  expect(init({ name: 'orders', cwd: scratch, force: true }).files).toHaveLength(3);
});

test('dir and name flags are independent, and the name must be a DNS label', () => {
  const seeded = init({ dir: 'svc', projectName: 'billing', cwd: scratch });
  expect(seeded.directory).toBe(join(scratch, 'svc'));
  const pkg = JSON.parse(readFileSync(join(seeded.directory, 'package.json'), 'utf8'));
  expect(pkg.name).toBe('billing');
  expect(() => init({ dir: 'Bad Name', cwd: scratch })).toThrow('DNS label');
});
