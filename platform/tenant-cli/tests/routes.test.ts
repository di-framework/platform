import { expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { OPERATIONS, TenantControllerHandlers } from '../src/api/handlers.ts';
import { dispatch, MAX_BODY_BYTES, match, ROUTES } from '../src/api/routes.ts';

test('every contract operation has exactly one route', () => {
  expect(ROUTES.map((route) => route.operation).sort()).toEqual([...OPERATIONS].sort());
  expect(match('GET', '/v1/deployments/stats')?.operation).toBe('deploymentStats');
  expect(match('GET', '/v1/services/web/logs')?.operation).toBe('logs');
  expect(match('GET', '/v1/services/web/logs/extra')).toBeUndefined();
  expect(match('POST', '/v1/deployments')).toBeUndefined();
});

test('requests that name no operation are left to the caller', async () => {
  expect(await dispatch(new Request('http://controller.test/v1/unknown'))).toBeUndefined();
});

test('dispatch reaches the handler registered in the container', async () => {
  const response = await dispatch(new Request('http://controller.test/v1/deployments?env=prod'));
  expect(response?.status).toBe(501);
});

test('a handler result that breaks the response contract is a 500, not a 400', async () => {
  const handlers = useContainer().resolve(TenantControllerHandlers);
  const original = handlers.vars;
  handlers.vars = (async () => ({ env: 'prod' })) as never;
  try {
    const response = await dispatch(new Request('http://controller.test/v1/vars?env=prod'));
    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
    });
  } finally {
    handlers.vars = original;
  }
});

test('a bodiless POST with an Empty input reaches its handler', async () => {
  const handlers = useContainer().resolve(TenantControllerHandlers);
  const original = handlers.logout;
  let received: unknown;
  handlers.logout = (async (command: unknown) => {
    received = command;
    return new Response(null, { status: 204 });
  }) as never;
  try {
    const response = await dispatch(
      new Request('http://controller.test/v1/auth/logout', { method: 'POST' }),
    );
    expect(response?.status).toBe(204);
    expect(received).toEqual({});
  } finally {
    handlers.logout = original;
  }
});

test('a bodiless POST to an operation that needs a body is a 400, not a 415', async () => {
  const response = await dispatch(
    new Request('http://controller.test/v1/deploy', { method: 'POST' }),
  );
  expect(response?.status).toBe(400);
});

test('a body that is not JSON is still a 415', async () => {
  const response = await dispatch(
    new Request('http://controller.test/v1/secrets/db?env=prod', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'v',
    }),
  );
  expect(response?.status).toBe(415);
});

test('a body above the size cap is a 413', async () => {
  const big = JSON.stringify({ value: 'x'.repeat(MAX_BODY_BYTES) });
  const declared = await dispatch(
    new Request('http://controller.test/v1/secrets/db?env=prod', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
      body: big,
    }),
  );
  expect(declared?.status).toBe(413);
  const streamed = await dispatch(
    new Request('http://controller.test/v1/secrets/db?env=prod', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: new Blob([big]).stream(),
    }),
  );
  expect(streamed?.status).toBe(413);
});

test('a chunked body over the cap gets its 413 while the client is still streaming', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => (await dispatch(request)) ?? new Response(null, { status: 404 }),
  });
  try {
    // Never closes: the 413 must not wait for the client to finish sending.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new Uint8Array(65536).fill(32));
        await Bun.sleep(5);
      },
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/secrets/db?env=prod`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(413);
  } finally {
    server.stop(true);
  }
});

test('a streamed body under the cap with multi-byte characters is read whole', async () => {
  const value = 'é'.repeat(1000);
  const response = await dispatch(
    new Request('http://controller.test/v1/secrets/db?env=prod', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: new Blob([JSON.stringify({ value })]).stream(),
    }),
  );
  expect(response?.status).not.toBe(400);
  expect(response?.status).not.toBe(413);
});

test('errors other than validation failures propagate to the caller', async () => {
  const handlers = useContainer().resolve(TenantControllerHandlers);
  const original = handlers.vars;
  handlers.vars = async () => {
    throw new Error('cluster down');
  };
  try {
    await expect(dispatch(new Request('http://controller.test/v1/vars?env=prod'))).rejects.toThrow(
      'cluster down',
    );
  } finally {
    handlers.vars = original;
  }
});
