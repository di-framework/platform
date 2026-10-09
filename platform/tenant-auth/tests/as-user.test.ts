import { afterAll, expect, test } from 'bun:test';
import { asUser, KubeClient, KubeError, type UserTokens } from '../src/kube.ts';
import { json, serve } from './support/servers.ts';

const api = serve((request) =>
  request.headers.get('authorization') === 'Bearer stale'
    ? json({ message: 'Unauthorized' }, 401)
    : json({ ok: true }),
);
afterAll(() => api.stop());
const kube = new KubeClient({ server: api.url, token: 'admin' }, 'wasmcloud');

function tokens(...issued: string[]): UserTokens & { asked: string[]; forgotten: string[] } {
  const asked: string[] = [];
  const forgotten: string[] = [];
  return {
    asked,
    forgotten,
    token: async (user) => {
      asked.push(user);
      return issued.shift() as string;
    },
    forget: (user) => {
      forgotten.push(user);
    },
  };
}

test('sends the request with the user ServiceAccount token, not the caller credentials', async () => {
  const source = tokens('sa-alice');
  const user = asUser(kube, source, { user: 'alice' });
  expect(user.user).toBe('alice');
  const response = await user.fetch('POST', '/api/v1/namespaces/di-tenant-acme/pods?dryRun=All', {
    headers: { authorization: 'Bearer caller', host: 'evil', 'content-type': 'application/json' },
    body: '{"kind":"Pod"}',
  });
  expect(response.status).toBe(200);
  const sent = api.requests.at(-1);
  expect(sent?.method).toBe('POST');
  expect(sent?.path).toBe('/api/v1/namespaces/di-tenant-acme/pods?dryRun=All');
  expect(sent?.headers.get('authorization')).toBe('Bearer sa-alice');
  expect(sent?.headers.get('host')).not.toBe('evil');
  expect(sent?.headers.get('content-type')).toBe('application/json');
  expect(sent?.body).toBe('{"kind":"Pod"}');
  expect(source.asked).toEqual(['alice']);
  expect(source.forgotten).toEqual([]);
});

test('re-mints once when the cached token is rejected', async () => {
  const source = tokens('stale', 'fresh');
  const response = await asUser(kube, source, { user: 'bob' }).fetch('GET', '/version');
  expect(response.status).toBe(200);
  expect(api.requests.at(-1)?.headers.get('authorization')).toBe('Bearer fresh');
  expect(source.forgotten).toEqual(['bob']);
});

test('refuses when there is no user', () => {
  const source = tokens();
  expect(() => asUser(kube, source, undefined)).toThrow(KubeError);
  expect(() => asUser(kube, source, { user: '' })).toThrow('no user to act as');
  expect(source.asked).toEqual([]);
});
