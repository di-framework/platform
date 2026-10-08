import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bearer,
  CliError,
  type Credential,
  home,
  load,
  readStore,
  resolveAccount,
  writeStore,
} from '../src/credentials.ts';

let env: NodeJS.ProcessEnv;
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tenant-cli-'));
  env = { DI_FRAMEWORK_HOME: join(scratch, 'home') };
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const credential: Credential = {
  account: 'acme',
  user: 'alice',
  role: 'developer',
  via: 'api-key',
  apiKey: 'dik_x',
  controller: { url: 'https://127.0.0.1:8788' },
};

test('the store lives under DI_FRAMEWORK_HOME, is created on write, and is private', () => {
  expect(home({})).toBe(join(homedir(), '.di-framework'));
  expect(readStore(env)).toEqual({});
  writeStore({ acme: credential }, env);
  writeStore({ acme: credential }, env);
  expect(readStore(env)).toEqual({ acme: credential });
  expect(statSync(join(env.DI_FRAMEWORK_HOME as string, 'credentials.json')).mode & 0o777).toBe(
    0o600,
  );
  expect(load('acme', env)).toEqual(credential);
  expect(() => load('beta', env)).toThrow(CliError);
});

test('bearer prefers the API key and refuses a missing or expired token', () => {
  expect(bearer(credential)).toBe('dik_x');
  const token = { ...credential, apiKey: undefined, via: 'identity' as const, accessToken: 'at' };
  expect(bearer(token)).toBe('at');
  expect(bearer({ ...token, expiresAt: '2999-01-01T00:00:00Z' })).toBe('at');
  expect(() => bearer({ ...token, expiresAt: '2000-01-01T00:00:00Z' })).toThrow('expired');
  expect(() => bearer({ ...token, accessToken: undefined })).toThrow('no token');
});

test('the account comes from the flag, the environment, or the only login', () => {
  expect(resolveAccount('beta', {}, {})).toBe('beta');
  expect(resolveAccount(undefined, { DI_TENANT_ACCOUNT: 'gamma' }, {})).toBe('gamma');
  expect(resolveAccount(undefined, {}, { acme: credential })).toBe('acme');
  expect(() => resolveAccount(undefined, {}, {})).toThrow('not logged in');
  expect(() => resolveAccount(undefined, {}, { acme: credential, beta: credential })).toThrow(
    'logged in to acme, beta',
  );
});
