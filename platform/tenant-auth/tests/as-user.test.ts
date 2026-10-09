import { afterAll, describe, expect, spyOn, test } from 'bun:test';
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

test('strips cookies, proxy credentials and impersonation headers', async () => {
  await asUser(kube, tokens('sa-alice'), { user: 'alice' }).fetch('GET', '/version', {
    headers: {
      cookie: 'tenant_console_session=secret',
      'proxy-authorization': 'Basic x',
      'impersonate-user': 'admin',
      'Impersonate-Group': 'system:masters',
      'impersonate-extra-scopes': 'all',
      accept: 'application/json',
    },
  });
  const sent = api.requests.at(-1)?.headers;
  for (const name of [
    'cookie',
    'proxy-authorization',
    'impersonate-user',
    'impersonate-group',
    'impersonate-extra-scopes',
  ])
    expect(sent?.get(name)).toBeNull();
  expect(sent?.get('accept')).toBe('application/json');
});

test('retries exactly once when both tokens are rejected', async () => {
  const source = tokens('stale', 'stale');
  const before = api.requests.length;
  const response = await asUser(kube, source, { user: 'carol' }).fetch('GET', '/version');
  expect(response.status).toBe(401);
  expect(api.requests.length - before).toBe(2);
  expect(source.forgotten).toEqual(['carol']);
  expect(source.asked).toEqual(['carol', 'carol']);
});

describe('call', () => {
  const typed = serve((request) => {
    if (request.pathname === '/missing') return json({ message: 'secrets "x" not found' }, 404);
    if (request.pathname === '/bare') return new Response('nope', { status: 403 });
    if (request.pathname === '/empty') return new Response(null, { status: 200 });
    if (request.headers.get('authorization') === 'Bearer stale')
      return json({ message: 'Unauthorized' }, 401);
    return json({
      method: request.method,
      body: request.body,
      accept: request.headers.get('accept'),
      type: request.headers.get('content-type'),
      auth: request.headers.get('authorization'),
    });
  });
  afterAll(() => typed.stop());
  const client = new KubeClient({ server: typed.url, token: 'admin' }, 'wasmcloud');

  test('sends JSON with the user token and parses the reply, retrying a stale token', async () => {
    const result = await asUser(client, tokens('stale', 'fresh'), { user: 'dan' }).call(
      'POST',
      '/things',
      { a: 1 },
    );
    expect(result).toEqual({
      method: 'POST',
      body: '{"a":1}',
      accept: 'application/json',
      type: 'application/json',
      auth: 'Bearer fresh',
    });
  });

  test('omits the content type without a body and returns undefined for an empty reply', async () => {
    const user = asUser(client, tokens('a', 'b'), { user: 'dan' });
    const result = await user.call<{ type: string | null }>('GET', '/things');
    expect(result.type).toBeNull();
    expect(await user.call('GET', '/empty')).toBeUndefined();
  });

  test('maps API server errors to KubeError with the server message', async () => {
    const user = asUser(client, tokens('a', 'b'), { user: 'dan' });
    const missing = (await user
      .call('GET', '/missing')
      .catch((error: KubeError) => error)) as KubeError;
    expect(missing).toBeInstanceOf(KubeError);
    expect(missing.status).toBe(404);
    expect(missing.message).toBe('secrets "x" not found');
    const bare = (await user
      .call('GET', '/bare?x=1')
      .catch((error: KubeError) => error)) as KubeError;
    expect(bare.status).toBe(403);
    expect(bare.message).toBe('GET /bare returned 403');
  });

  test('maps network failures to KubeError(502)', async () => {
    const down = new KubeClient({ server: 'http://127.0.0.1:1', token: 'admin' }, 'wasmcloud');
    const error = (await asUser(down, tokens('a'), { user: 'dan' })
      .call('GET', '/version')
      .catch((e: KubeError) => e)) as KubeError;
    expect(error).toBeInstanceOf(KubeError);
    expect(error.status).toBe(502);
    expect(error.message).toContain('GET /version failed');
  });

  test('maps a failure to mint the user token to KubeError(502), not the mint 404', async () => {
    const source: UserTokens = {
      token: async () => {
        throw new KubeError(404, 'serviceaccounts "di-user-dan" not found');
      },
      forget: () => {},
    };
    const user = asUser(client, source, { user: 'dan' });
    const error = (await user.call('GET', '/things').catch((e: KubeError) => e)) as KubeError;
    expect(error).toBeInstanceOf(KubeError);
    expect(error.status).toBe(502);
    expect(error.message).toContain('could not mint a token for dan');
    expect(error.message).toContain('di-user-dan');
    const raw = (await user.fetch('GET', '/things').catch((e: KubeError) => e)) as KubeError;
    expect(raw.status).toBe(502);
  });

  test('maps a 401 that persists after the retry to KubeError(502)', async () => {
    const source = tokens('stale', 'stale');
    const error = (await asUser(client, source, { user: 'dan' })
      .call('GET', '/things')
      .catch((e: KubeError) => e)) as KubeError;
    expect(error).toBeInstanceOf(KubeError);
    expect(error.status).toBe(502);
    expect(error.message).toBe("GET /things rejected the user's token");
    expect(source.asked).toEqual(['dan', 'dan']);
  });
});

test('maps a timeout while reading the body to KubeError(502)', async () => {
  const slow = serve(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            // Never closes: the body read only ends when the signal aborts it.
            controller.enqueue(new TextEncoder().encode('{"partial":'));
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), 100);
    return controller.signal;
  });
  try {
    const client = new KubeClient({ server: slow.url, token: 'admin' }, 'wasmcloud');
    const error = (await asUser(client, tokens('a'), { user: 'dan' })
      .call('GET', '/slow')
      .catch((e: unknown) => e)) as KubeError;
    expect(error).toBeInstanceOf(KubeError);
    expect(error.status).toBe(502);
    expect(error.message).toContain('GET /slow failed');
  } finally {
    timeout.mockRestore();
    slow.stop();
  }
});
