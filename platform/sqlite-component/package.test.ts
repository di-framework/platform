import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dir;

test('sqlite-component is a make-based rust crate', () => {
  expect(existsSync(join(root, 'Makefile'))).toBe(true);
  expect(existsSync(join(root, 'Cargo.toml'))).toBe(true);
  expect(existsSync(join(root, 'wit/world.wit'))).toBe(true);
});
