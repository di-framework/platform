import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

test('platform workspace publishes the cluster package and guests', () => {
  expect(existsSync('platform/platform/package.json')).toBe(true);
  expect(existsSync('platform/bindings/package.json')).toBe(true);
  expect(existsSync('platform/sqlite-component/Makefile')).toBe(true);
  expect(existsSync('adapters/cloudfoundry/package.json')).toBe(true);
});
