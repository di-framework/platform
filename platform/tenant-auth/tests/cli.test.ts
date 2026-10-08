import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  bearer,
  type Credential,
  parseArgs,
  readStore,
  renderKubeconfig,
  writeStore,
} from '../src/cli.ts';

const credential: Credential = {
  console: 'http://127.0.0.1:8787',
  account: 'acme',
  user: 'alice',
  role: 'developer',
  via: 'identity',
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: '2030-01-01T00:00:00Z',
  controller: { url: 'https://127.0.0.1:8788', certificateAuthorityData: 'Q0E=' },
};

describe('parseArgs', () => {
  test('splits command, flags, and positionals', () => {
    expect(parseArgs(['keys', 'revoke', 'abc', '--account', 'acme', '--no-browser'])).toEqual({
      command: 'keys',
      flags: { account: 'acme', 'no-browser': 'true' },
      rest: ['revoke', 'abc'],
    });
  });
  test('stops flag parsing at --', () => {
    expect(parseArgs(['exec', '--account', 'acme', '--', 'kubectl', '--namespace', 'x'])).toEqual({
      command: 'exec',
      flags: { account: 'acme' },
      rest: ['kubectl', '--namespace', 'x'],
    });
  });
});

describe('credential store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tenant-auth-'));
    process.env.DI_FRAMEWORK_HOME = dir;
  });
  afterEach(() => {
    delete process.env.DI_FRAMEWORK_HOME;
    rmSync(dir, { recursive: true, force: true });
  });
  test('writes a private file and reads it back', () => {
    expect(readStore()).toEqual({});
    writeStore({ acme: credential });
    expect(readStore().acme?.user).toBe('alice');
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600);
  });
});

describe('kubeconfig', () => {
  type Doc = {
    users: { user: { token: string } }[];
    contexts: { context: { namespace: string } }[];
    clusters: { cluster: Record<string, string> }[];
  };
  test('points kubectl at the controller with the identity token', () => {
    const doc = load(renderKubeconfig(credential)) as Doc;
    expect(doc.clusters[0]?.cluster.server).toBe('https://127.0.0.1:8788');
    expect(doc.clusters[0]?.cluster['certificate-authority-data']).toBe('Q0E=');
    expect(doc.users[0]?.user.token).toBe('access');
    expect(doc.contexts[0]?.context.namespace).toBe('di-tenant-acme');
    expect(renderKubeconfig(credential)).not.toContain('refresh');
  });
  test('uses the API key as the bearer for key logins', () => {
    const withKey: Credential = {
      ...credential,
      via: 'api-key',
      accessToken: undefined,
      refreshToken: undefined,
      apiKey: 'dik_x',
    };
    expect(bearer(withKey)).toBe('dik_x');
    expect((load(renderKubeconfig(withKey)) as Doc).users[0]?.user.token).toBe('dik_x');
  });
});
