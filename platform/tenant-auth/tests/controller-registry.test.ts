import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Controller, configFromEnv, REGISTRY_IDLE_TIMEOUT_SECONDS } from '../src/controller.ts';
import { AuthError, type Principal } from '../src/identity.ts';
import { serve } from './support/servers.ts';

/** The whoami-only listener and the registry front (platform#83). */
describe('registry listeners', () => {
  const alice: Principal = {
    user: 'alice',
    account: 'acme',
    role: 'viewer',
    via: 'api-key',
    credentialId: 'k',
  };
  const config = configFromEnv({
    TENANT_CONTROLLER_TENANT: 'acme',
    TENANT_CONTROLLER_WHOAMI_PORT: '8789',
    TENANT_CONTROLLER_REGISTRY_FRONT_PORT: '8790',
    TENANT_CONTROLLER_REGISTRY_HOST: 'registry',
  });
  const controller = new Controller(
    config,
    {} as never,
    { issuer: 'https://issuer.test' } as never,
    {
      resolve: async (authorization: string | null) => {
        if (authorization === 'Bearer ok') return alice;
        if (authorization === 'Bearer suspended') throw new AuthError(403, 'user is suspended');
        if (authorization === 'Bearer boom') throw new Error('userinfo returned 500');
        throw new AuthError(401, 'a bearer token is required');
      },
      forget: () => {},
    } as never,
    {} as never,
  );
  const hosts = serve((request) => {
    if (request.pathname === '/v2/')
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="di-framework-tenant-registry"' },
      });
    return new Response(`echo ${request.method} ${request.path} ${request.body}`, {
      status: 202,
      headers: { location: '/v2/app/blobs/uploads/1', 'docker-upload-uuid': '1' },
    });
  });
  controller.proxyUpstream = () => hosts.url;
  let log: ReturnType<typeof spyOn>;
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => {
    log.mockRestore();
    hosts.stop();
  });
  const whoami = (method: string, path: string, authorization?: string) =>
    controller.handleWhoami(
      new Request(`http://tenant-controller.di-runtime-acme.svc:8789${path}`, {
        method,
        headers: authorization ? { authorization } : {},
      }),
    );

  test('reads the listener ports and the registry host from the environment', () => {
    expect(config).toMatchObject({
      whoamiPort: 8789,
      registryFrontPort: 8790,
      registryHost: 'registry',
    });
    const defaults = configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' });
    expect(defaults.whoamiPort).toBeUndefined();
    expect(defaults.registryFrontPort).toBeUndefined();
    expect(defaults.registryHost).toBe('registry');
    for (const bad of ['0', '65536', 'x', '1.5'])
      expect(() =>
        configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme', TENANT_CONTROLLER_WHOAMI_PORT: bad }),
      ).toThrow('TENANT_CONTROLLER_WHOAMI_PORT must be a TCP port');
  });

  test('whoami answers the principal, as on the main listener', async () => {
    const response = await whoami('GET', '/v1/auth/whoami', 'Bearer ok');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(alice);
  });

  test('whoami errors are problem+json', async () => {
    for (const [authorization, status, title] of [
      [undefined, 401, 'Unauthorized'],
      ['Bearer suspended', 403, 'Forbidden'],
      ['Bearer boom', 502, 'Bad Gateway'],
    ] as const) {
      const response = await whoami('GET', '/v1/auth/whoami', authorization);
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(await response.json()).toMatchObject({ status, title });
    }
  });

  test('the whoami listener serves nothing else', async () => {
    for (const path of [
      '/-/whoami',
      '/v1/auth/info',
      '/api/v1/namespaces',
      '/v1/deploy/registry',
    ]) {
      const response = await whoami('GET', path, 'Bearer ok');
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
    }
    const post = await whoami('POST', '/v1/auth/whoami', 'Bearer ok');
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });

  test('the registry front forwards to the tenant hosts with the registry Host and credentials', async () => {
    const response = await controller.handleRegistry(
      new Request('https://registry.acme.localhost:28180/v2/app/blobs/uploads/?mount=x', {
        method: 'POST',
        headers: {
          authorization: 'Basic eDpvaw==',
          'x-forwarded-for': 'spoofed',
          connection: 'keep-alive',
          'content-type': 'application/octet-stream',
        },
        body: 'layer-bytes',
      }),
      { requestIP: () => ({ address: '10.0.0.9' }) },
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('location')).toBe('/v2/app/blobs/uploads/1');
    expect(response.headers.get('docker-upload-uuid')).toBe('1');
    expect(await response.text()).toBe('echo POST /v2/app/blobs/uploads/?mount=x layer-bytes');
    const seen = hosts.requests.at(-1)!;
    expect(seen.headers.get('host')).toBe('registry');
    expect(seen.headers.get('authorization')).toBe('Basic eDpvaw==');
    expect(seen.headers.get('x-forwarded-for')).toBe('10.0.0.9');
    expect(seen.headers.get('x-forwarded-host')).toBe('registry.acme.localhost:28180');
    expect(seen.headers.get('x-forwarded-proto')).toBe('https');
  });

  test('the registry front relays the registry challenge unchanged', async () => {
    const response = await controller.handleRegistry(
      new Request('https://registry.acme.localhost/v2/', {
        headers: { authorization: 'Basic eDpiYWQ=' },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Basic realm="di-framework-tenant-registry"',
    );
  });

  test('the registry front answers requests without Basic credentials with the registry challenge (S5)', async () => {
    const before = hosts.requests.length;
    for (const init of [
      {},
      { headers: { authorization: 'Bearer token' } },
      { method: 'PUT', body: 'layer-bytes' },
    ] as RequestInit[]) {
      const response = await controller.handleRegistry(
        new Request('https://registry.acme.localhost/v2/app/blobs/uploads/1', init),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        'Basic realm="di-framework-tenant-registry"',
      );
      expect(response.headers.get('docker-distribution-api-version')).toBe('registry/2.0');
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({
        errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }],
      });
    }
    expect(hosts.requests.length).toBe(before);
  });

  test('an unreachable registry is a 502 problem', async () => {
    const down = new Controller(
      config,
      {} as never,
      { issuer: 'https://issuer.test' } as never,
      {} as never,
      {} as never,
    );
    down.proxyUpstream = () => 'http://127.0.0.1:1';
    const response = await down.handleRegistry(
      new Request('https://registry.acme.localhost/v2/', {
        headers: { authorization: 'Basic eDpvaw==' },
      }),
    );
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
  });
});

/** The registry front's limits (W2 of the platform#83 review). */
describe('registry front limits', () => {
  const limited = configFromEnv({
    TENANT_CONTROLLER_TENANT: 'acme',
    TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES: '8',
    TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS: '150',
    TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT: '1',
    TENANT_CONTROLLER_REGISTRY_UPLOAD_IDLE_TIMEOUT_MS: '100',
  });
  const controller = new Controller(
    limited,
    {} as never,
    { issuer: 'https://issuer.test' } as never,
    {} as never,
    {} as never,
  );
  /** Upstream request signals by path, to see whether the front aborted them. */
  const signals = new Map<string, AbortSignal>();
  let hold = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      signals.set(pathname, request.signal);
      if (pathname === '/hang-after-body') {
        await request.text();
        await hold.promise;
        return new Response('late');
      }
      if (pathname === '/hang') {
        await hold.promise;
        return new Response('late');
      }
      if (pathname === '/stream')
        return new Response(
          new ReadableStream({
            async pull(c) {
              c.enqueue(new TextEncoder().encode('chunk'));
              await hold.promise;
            },
          }),
        );
      if (pathname === '/broken')
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('partial'));
              setTimeout(() => c.error(new Error('upstream secret detail')), 20);
            },
          }),
        );
      if (request.method === 'HEAD') return new Response(null, { status: 200 });
      return new Response(`ok ${await request.text()}`);
    },
  });
  controller.proxyUpstream = () => `http://127.0.0.1:${upstream.port}`;
  let log: ReturnType<typeof spyOn>;
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => {
    log.mockRestore();
    hold.resolve();
    upstream.stop(true);
  });
  const call = (path: string, init: RequestInit = {}) =>
    controller.handleRegistry(
      new Request(`https://registry.acme.localhost${path}`, {
        ...init,
        headers: { authorization: 'Basic eDpvaw==', ...(init.headers as Record<string, string>) },
      }),
    );
  /** A body that sends `chunks` pieces `everyMs` apart, then ends (or stalls when `stall`). */
  const trickle = (chunks: number, everyMs: number, stall = false) =>
    new ReadableStream<Uint8Array>({
      async pull(c) {
        if (chunks-- <= 0) {
          if (stall) return new Promise<void>(() => {});
          return c.close();
        }
        await Bun.sleep(everyMs);
        c.enqueue(new TextEncoder().encode('x'));
      },
    });
  /** The single slot is free again: a plain request goes through. */
  const free = async () => {
    const response = await call('/v2/');
    expect(response.status).toBe(200);
    await response.text();
  };

  test('reads the limits from the environment, with defaults', () => {
    const defaults = configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' });
    expect(defaults.registryMaxBodyBytes).toBe(512 * 1024 * 1024);
    expect(defaults.registryUpstreamTimeoutMs).toBe(60_000);
    expect(defaults.registryUploadIdleTimeoutMs).toBe(60_000);
    expect(defaults.registryMaxConcurrent).toBe(16);
    expect(REGISTRY_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(REGISTRY_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
    for (const bad of ['0', '-1', 'x', '1.5'])
      expect(() =>
        configFromEnv({
          TENANT_CONTROLLER_TENANT: 'acme',
          TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT: bad,
        }),
      ).toThrow('TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT must be a positive integer');
  });

  test('refuses a declared body over the cap with 413 before contacting the registry', async () => {
    signals.clear();
    for (const length of ['9', 'nonsense']) {
      const response = await call('/v2/app/blobs/uploads/1', {
        method: 'PUT',
        headers: { 'content-length': length },
        body: 'x'.repeat(9),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
    }
    expect(signals.size).toBe(0);
    const ok = await call('/v2/app/blobs/uploads/1', { method: 'PUT', body: '12345678' });
    expect(await ok.text()).toBe('ok 12345678');
  });

  test('answers 504 without upstream details when the registry does not answer in time', async () => {
    hold = Promise.withResolvers<void>();
    const response = await call('/hang');
    expect(response.status).toBe(504);
    const body = await response.text();
    expect(body).toContain('did not answer in time');
    expect(body).not.toContain('127.0.0.1');
    await Bun.sleep(20);
    expect(signals.get('/hang')?.aborted).toBe(true);
    hold.resolve();
    await free();
  });

  test('answers 503 beyond the concurrency limit and frees the slot when the client goes away', async () => {
    hold = Promise.withResolvers<void>();
    const client = new AbortController();
    const pending = call('/hang', { signal: client.signal });
    await Bun.sleep(20);
    const busy = await call('/v2/');
    expect(busy.status).toBe(503);
    expect(busy.headers.get('content-type')).toBe('application/problem+json');
    // Unauthenticated requests are challenged without a slot, even while none is free (S5).
    const anonymous = await controller.handleRegistry(
      new Request('https://registry.acme.localhost/v2/'),
    );
    expect(anonymous.status).toBe(401);
    client.abort();
    expect((await pending).status).toBe(502);
    await Bun.sleep(20);
    expect(signals.get('/hang')?.aborted).toBe(true);
    hold.resolve();
    await free();
  });

  test('a client that stops reading cancels the upstream body and frees the slot', async () => {
    hold = Promise.withResolvers<void>();
    const response = await call('/stream');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('chunk');
    await reader.cancel();
    await Bun.sleep(20);
    expect(signals.get('/stream')?.aborted).toBe(true);
    hold.resolve();
    await free();
  });

  test('a failed upstream body ends the client response and frees the slot', async () => {
    const response = await call('/broken');
    await expect(response.text()).rejects.toBeDefined();
    await Bun.sleep(50);
    await free();
  });

  test('a response without a body frees the slot at once', async () => {
    const response = await call('/v2/', { method: 'HEAD' });
    expect(response.status).toBe(200);
    await free();
  });

  test('a steady upload longer than the header timeout succeeds (W5)', async () => {
    // 8 bytes, 50 ms apart: 400 ms in all, well past the 150 ms header timeout.
    const response = await call('/v2/app/blobs/uploads/1', {
      method: 'PUT',
      body: trickle(8, 50),
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok xxxxxxxx');
    await free();
  });

  test('a stalled upload is cut off with 408 and frees the slot (W5)', async () => {
    const response = await call('/v2/app/blobs/uploads/1', {
      method: 'PUT',
      body: trickle(1, 10, true),
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(408);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.text()).not.toContain('127.0.0.1');
    await free();
  });

  test('the header timeout starts once the body is sent, then answers 504 (W5)', async () => {
    hold = Promise.withResolvers<void>();
    const response = await call('/hang-after-body', {
      method: 'PUT',
      body: trickle(4, 50),
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(504);
    hold.resolve();
    await free();
  });
});
