import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Controller, configFromEnv, registryNotServing } from '../src/controller.ts';

/**
 * Host pulls while the registry workload is starting (#197): after a host (re)start its workloads
 * pull before `di-tenant-registry` on the same host serves, so the pull listener waits for it.
 */
describe('host pulls wait for the registry', () => {
  const make = (env: Record<string, string> = {}) =>
    new Controller(
      configFromEnv({
        TENANT_CONTROLLER_TENANT: 'acme',
        TENANT_CONTROLLER_REGISTRY_HOST: 'registry',
        ...env,
      }),
      {} as never,
      { issuer: 'https://issuer.test' } as never,
      {} as never,
      {} as never,
    );
  /** Requests per path, and how many more times each path answers "no workload for this Host". */
  const hits = new Map<string, number>();
  const notYet = new Map<string, number>();
  let hold = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
      if (pathname.endsWith('/hold')) {
        await hold.promise;
        return new Response('held', { headers: { 'content-type': 'text/plain' } });
      }
      const left = notYet.get(pathname) ?? 0;
      // wash's answer for a `Host` no workload serves yet: an empty 404, no content-type.
      if (pathname.endsWith('/never') || left > 0) {
        notYet.set(pathname, left - 1);
        return new Response(null, { status: 404 });
      }
      if (pathname.includes('sha256:missing'))
        return Response.json(
          { errors: [{ code: 'BLOB_UNKNOWN', message: 'blob unknown' }] },
          { status: 404 },
        );
      return new Response('blob', {
        headers: { 'content-type': 'application/octet-stream', 'docker-content-digest': 'x' },
      });
    },
  });
  const origin = `http://127.0.0.1:${upstream.port}`;
  const pullRequest = (path: string, init: RequestInit = {}) =>
    new Request(`https://tenant-registry.di-runtime-acme.svc${path}`, {
      ...init,
      headers: { authorization: 'Basic eDpvaw==' },
    });
  const events: Record<string, unknown>[] = [];
  let log: ReturnType<typeof spyOn>;
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation((line: unknown) => {
      if (typeof line === 'string' && line.startsWith('{')) events.push(JSON.parse(line));
    });
  });
  afterAll(() => {
    hold.resolve();
    log.mockRestore();
    upstream.stop(true);
  });

  test('reads the wait from the environment, default 30 s', () => {
    expect(make().config.registryPullWaitMs).toBe(30_000);
    expect(make({ TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS: '500' }).config.registryPullWaitMs).toBe(
      500,
    );
    for (const bad of ['0', '-1', 'x'])
      expect(() => make({ TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS: bad })).toThrow(
        'TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS must be a positive integer',
      );
  });

  test('tells a host answer from a registry answer', () => {
    expect(registryNotServing(new Response(null, { status: 404 }))).toBe(true);
    expect(registryNotServing(new Response(null, { status: 503 }))).toBe(true);
    expect(registryNotServing(Response.json({ errors: [] }, { status: 404 }))).toBe(false);
    expect(registryNotServing(new Response(null, { status: 401 }))).toBe(false);
    expect(registryNotServing(new Response(null, { status: 200 }))).toBe(false);
  });

  test('a pull made before the registry serves is retried until it answers', async () => {
    const controller = make();
    controller.proxyUpstream = () => origin;
    const path = '/v2/acme/app/blobs/sha256:starting';
    notYet.set(path, 3);
    events.length = 0;
    const response = await controller.handleRegistryPull(pullRequest(path));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('blob');
    expect(hits.get(path)).toBe(4);
    expect(events.filter((e) => e.event === 'registry.waiting')).toHaveLength(1);
  });

  test('the registry’s own 404 is final', async () => {
    const controller = make();
    controller.proxyUpstream = () => origin;
    const path = '/v2/acme/app/blobs/sha256:missing';
    const response = await controller.handleRegistryPull(pullRequest(path));
    expect(response.status).toBe(404);
    expect((await response.json()).errors[0].code).toBe('BLOB_UNKNOWN');
    expect(hits.get(path)).toBe(1);
  });

  test('the public registry front does not wait', async () => {
    const controller = make();
    controller.proxyUpstream = () => origin;
    const path = '/v2/acme/front/never';
    const response = await controller.handleRegistry(pullRequest(path));
    expect(response.status).toBe(404);
    expect(hits.get(path)).toBe(1);
  });

  test('the wait is bounded: the host answer is returned once it is over', async () => {
    const controller = make({ TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS: '600' });
    controller.proxyUpstream = () => origin;
    const path = '/v2/acme/app/never';
    const started = Date.now();
    const response = await controller.handleRegistryPull(pullRequest(path));
    expect(response.status).toBe(404);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hits.get(path)).toBeGreaterThan(1);
    // The slot is free again afterwards.
    const next = await controller.handleRegistryPull(pullRequest('/v2/acme/app/blobs/sha256:ok'));
    expect(next.status).toBe(200);
  });

  test('a waiting pull gives its slot back, so other pulls are not turned away (S1)', async () => {
    const controller = make({ TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT: '1' });
    controller.proxyUpstream = () => origin;
    const path = '/v2/acme/slot/blobs/sha256:starting';
    notYet.set(path, 2);
    const waiting = controller.handleRegistryPull(pullRequest(path));
    await Bun.sleep(100);
    // The only slot is not held while the first pull waits.
    const other = await controller.handleRegistryPull(pullRequest('/v2/acme/app/blobs/sha256:ok'));
    expect(other.status).toBe(200);
    await other.text();
    const response = await waiting;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('blob');
  });

  test('a waiting pull that finds no free slot before its wait is over is answered busy', async () => {
    const controller = make({
      TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT: '1',
      TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS: '600',
    });
    controller.proxyUpstream = () => origin;
    hold = Promise.withResolvers<void>();
    const waiting = controller.handleRegistryPull(pullRequest('/v2/acme/busy/never'));
    await Bun.sleep(100);
    const holder = controller.handleRegistryPull(pullRequest('/v2/acme/app/hold'));
    const response = await waiting;
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    hold.resolve();
    expect(await (await holder).text()).toBe('held');
  });

  test('each attempt gets the full header timeout, so a long wait does not end in 504 (S2)', async () => {
    const controller = make({
      TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS: '300',
      TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS: '900',
    });
    controller.proxyUpstream = () => origin;
    const started = Date.now();
    const response = await controller.handleRegistryPull(pullRequest('/v2/acme/long/never'));
    expect(response.status).toBe(404);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  test('a registry that hangs past the header timeout still answers 504', async () => {
    const controller = make({ TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS: '150' });
    controller.proxyUpstream = () => origin;
    hold = Promise.withResolvers<void>();
    const response = await controller.handleRegistryPull(pullRequest('/v2/acme/slow/hold'));
    expect(response.status).toBe(504);
    hold.resolve();
  });

  test('a refused connection is retried until the host listens', async () => {
    const controller = make();
    const late = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') });
    const port = late.port;
    late.stop(true);
    controller.proxyUpstream = () => `http://127.0.0.1:${port}`;
    const pending = controller.handleRegistryPull(pullRequest('/v2/acme/app/blobs/sha256:late'));
    await Bun.sleep(400);
    const back = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: () => new Response('up', { headers: { 'content-type': 'text/plain' } }),
    });
    try {
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('up');
    } finally {
      back.stop(true);
    }
  });

  test('a refused connection past the wait answers 502', async () => {
    const controller = make({ TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS: '300' });
    const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') });
    const port = gone.port;
    gone.stop(true);
    controller.proxyUpstream = () => `http://127.0.0.1:${port}`;
    const response = await controller.handleRegistryPull(pullRequest('/v2/acme/app/x'));
    expect(response.status).toBe(502);
  });

  test('a pull whose client goes away stops waiting', async () => {
    const controller = make();
    controller.proxyUpstream = () => origin;
    const path = '/v2/acme/gone/never';
    const client = new AbortController();
    const pending = controller.handleRegistryPull(pullRequest(path, { signal: client.signal }));
    await Bun.sleep(100);
    client.abort();
    const started = Date.now();
    expect((await pending).status).toBe(502);
    expect(Date.now() - started).toBeLessThan(500);
    const count = hits.get(path) ?? 0;
    await Bun.sleep(600);
    expect(hits.get(path)).toBe(count);
  });
});
