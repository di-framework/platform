import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { MAX_BODY_BYTES } from '@di-framework/tenant-cli/src/api/routes.ts';
import { Controller, configFromEnv } from '../src/controller.ts';
import { AuthError, type Principal } from '../src/identity.ts';
import { KubeClient } from '../src/kube.ts';
import {
  PASSTHROUGH,
  ProxySessions,
  proxySessions,
  servePassthrough,
  tenantUpstream,
} from '../src/v1/proxy.ts';
import { json, serve } from './support/servers.ts';

/** The controller over real HTTP, in front of a fake API server and a fake tenant upstream. */
describe('services create and the service proxy', () => {
  const api = serve((request) => {
    if (request.pathname.match(/\/serviceaccounts\/di-user-[a-z]+\/token$/))
      return json({
        status: {
          token: `sa-${request.pathname.split('/').at(-2)?.slice(8)}`,
          expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    const body = JSON.parse(request.body || '{}') as { metadata?: { name?: string } };
    if (body.metadata?.name === 'taken')
      return json({ kind: 'Status', message: 'backingservices "taken" already exists' }, 409);
    if (body.metadata?.name === 'denied')
      return json(
        {
          kind: 'Status',
          message: 'BackingService className must be an approved platform default',
        },
        422,
      );
    if (body.metadata?.name === 'broken')
      return json({ kind: 'Status', message: 'etcd down' }, 500);
    return json(
      {
        ...body,
        metadata: {
          ...body.metadata,
          ...(body.metadata?.name === 'bare' ? {} : { creationTimestamp: '2026-10-09T00:00:00Z' }),
        },
      },
      201,
    );
  });
  const upstream = serve((request) => {
    if (request.pathname === '/slow') return new Promise(() => {});
    return new Response(`echo ${request.method} ${request.path} ${request.body}`, {
      status: request.pathname === '/missing' ? 404 : 200,
      headers: { 'x-service': 'yes', 'set-cookie': 'sid=1' },
    });
  });
  const alice: Principal = {
    user: 'alice',
    account: 'acme',
    role: 'developer',
    via: 'identity',
    credentialId: 's',
  };
  const carol: Principal = { ...alice, user: 'carol' };
  const bob: Principal = { ...alice, user: 'bob', role: 'viewer' };
  const kube = new KubeClient({ server: api.url, token: 'admin' }, 'wasmcloud');
  const controller = new Controller(
    configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
    kube,
    { issuer: 'https://issuer.test' } as never,
    {
      resolve: async (authorization: string | null) => {
        if (authorization === 'Bearer ok') return alice;
        if (authorization === 'Bearer carol') return carol;
        if (authorization === 'Bearer viewer') return bob;
        throw new AuthError(401, 'a bearer token is required');
      },
      forget: () => {},
    } as never,
    { kube, namespace: 'di-runtime-acme', tenant: 'acme' },
  );
  let upstreamUrl = upstream.url;
  controller.proxyUpstream = () => upstreamUrl;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => controller.handle(r) });
  const base = `http://127.0.0.1:${server.port}`;
  let log: ReturnType<typeof spyOn>;
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => {
    log.mockRestore();
    server.stop(true);
    api.stop();
    upstream.stop();
  });

  const call = (method: string, path: string, body?: unknown, bearer = 'ok') =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const created = () => api.requests.filter((r) => r.pathname.endsWith('/backingservices'));
  const openSession = async (service = 'web', bearer = 'ok') => {
    const response = await call('POST', `/v1/services/${service}/proxy`, { env: 'prod' }, bearer);
    expect(response.status).toBe(201);
    return (await response.json()) as { url: string; port: number; expiresAt: string };
  };

  test.each([
    [{ type: 'keyvalue', name: 'cache' }, { type: 'keyvalue' }, 'keyvalue-redis'],
    [
      { type: 'messaging', name: 'events', className: 'messaging-nats' },
      { type: 'messaging', className: 'messaging-nats' },
      'messaging-nats',
    ],
    [
      { type: 'blobstore', name: 'files', deletionPolicy: 'Delete' },
      { type: 'blobstore', deletionPolicy: 'Delete' },
      'blobstore-nats',
    ],
    [
      { type: 'postgres', name: 'db', parameters: { storage: '1Gi', cpu: '500m' } },
      { type: 'postgres', parameters: { storage: '1Gi', cpu: '500m' } },
      'postgres-dedicated',
    ],
    [
      { type: 'egress', name: 'out', destinations: ['api.example.com:443', '*.example.org'] },
      { type: 'egress', destinations: ['api.example.com:443', '*.example.org'] },
      'egress-public',
    ],
  ])('createService writes a %o BackingService as the caller', async (fields, spec, className) => {
    const before = created().length;
    const response = await call('POST', '/v1/services', { env: 'prod', ...fields });
    expect(response.status).toBe(201);
    const sent = created().at(before);
    expect(created().length).toBe(before + 1);
    expect(sent?.method).toBe('POST');
    expect(sent?.pathname).toBe(
      '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-acme/backingservices',
    );
    expect(sent?.headers.get('authorization')).toBe('Bearer sa-alice');
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      apiVersion: 'platform.di-framework.dev/v1alpha1',
      kind: 'BackingService',
      metadata: { name: fields.name, annotations: { 'platform.di-framework.dev/env': 'prod' } },
      spec,
    });
    const { name: _name, type: _type, ...rest } = fields;
    expect(await response.json()).toEqual({
      ...rest,
      name: fields.name,
      env: 'prod',
      type: fields.type,
      className,
      createdAt: '2026-10-09T00:00:00Z',
    });
  });

  test('createService fills createdAt when the API server omits it', async () => {
    const response = await call('POST', '/v1/services', {
      env: 'staging',
      type: 'keyvalue',
      name: 'bare',
      parameters: {},
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { createdAt: string; parameters?: unknown };
    expect(Date.parse(body.createdAt)).not.toBeNaN();
    expect(body.parameters).toBeUndefined();
  });

  test.each([
    [{ type: 'keyvalue', name: 'Bad_Name' }, 'name must be a DNS label of at most 40 characters'],
    [
      { type: 'keyvalue', name: 'a'.repeat(41) },
      'name must be a DNS label of at most 40 characters',
    ],
    [
      { type: 'keyvalue', name: 'cache', className: 'messaging-nats' },
      'className for keyvalue must be the platform default keyvalue-redis',
    ],
    [
      { type: 'postgres', name: 'db', parameters: { storage: 'lots' } },
      'parameters.storage must be a quantity such as 1Gi',
    ],
    [{ type: 'egress', name: 'out' }, 'an egress service needs at least one destination'],
    [
      { type: 'egress', name: 'out', destinations: [] },
      'an egress service needs at least one destination',
    ],
    [
      { type: 'egress', name: 'out', destinations: ['http://x'] },
      'destination http://x must be host, *.suffix, or either with :port',
    ],
    [
      { type: 'egress', name: 'out', destinations: ['x.example.com:70000'] },
      'destination x.example.com:70000 must be host, *.suffix, or either with :port',
    ],
    [
      { type: 'egress', name: 'out', destinations: [`${'a.'.repeat(130)}com`] },
      `destination ${'a.'.repeat(130)}com must be host, *.suffix, or either with :port`,
    ],
    [
      { type: 'keyvalue', name: 'cache', destinations: ['x.example.com'] },
      'destinations are only allowed on an egress service',
    ],
  ])('createService refuses %o with 422 before the API server', async (fields, detail) => {
    const before = created().length;
    const response = await call('POST', '/v1/services', { env: 'prod', ...fields });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { detail: string }).detail).toBe(detail);
    expect(created().length).toBe(before);
  });

  test('createService refuses http, cron and worker: they come from the deploy bundle', async () => {
    const response = await call('POST', '/v1/services', { env: 'prod', type: 'http', name: 'web' });
    expect(response.status).toBe(400);
  });

  test.each([
    ['taken', 409, 'backingservices "taken" already exists'],
    ['denied', 422, 'BackingService className must be an approved platform default'],
    ['broken', 502, 'the cluster request failed'],
  ])('an API server answer for %s maps to %i', async (name, status, detail) => {
    const response = await call('POST', '/v1/services', { env: 'prod', type: 'keyvalue', name });
    expect(response.status).toBe(status);
    expect(((await response.json()) as { detail: string }).detail).toBe(detail);
  });

  test('a viewer may not create a service or open a proxy session', async () => {
    const before = created().length;
    const create = await call(
      'POST',
      '/v1/services',
      { env: 'prod', type: 'keyvalue', name: 'cache' },
      'viewer',
    );
    expect(create.status).toBe(403);
    expect(created().length).toBe(before);
    const proxy = await call('POST', '/v1/services/web/proxy', { env: 'prod' }, 'viewer');
    expect(proxy.status).toBe(403);
  });

  test('proxy issues a short-lived session URL for one service', async () => {
    const session = await openSession();
    expect(session.port).toBe(80);
    expect(session.url).toMatch(
      new RegExp(`^${base}/v1/services/web/proxy/[A-Za-z0-9_-]{43}$`.replaceAll('.', '\\.')),
    );
    const ttl = Date.parse(session.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect((await openSession()).url).not.toBe(session.url);
  });

  test.each([
    [
      '/v1/services/web/proxy',
      { env: 'prod', port: 8080 },
      'only port 80, the tenant HTTP upstream, can be proxied',
    ],
    ['/v1/services/Web/proxy', { env: 'prod' }, 'service must be a DNS label'],
  ])('proxy refuses %s %o with 422', async (path, body, detail) => {
    const response = await call('POST', path, body);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { detail: string }).detail).toBe(detail);
  });

  test('the session forwards method, path, query and body with Host set, without credentials', async () => {
    const { url } = await openSession();
    const response = await fetch(`${url}/api/items?x=1&y=two`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer ok',
        cookie: 'session=secret',
        'proxy-authorization': 'Basic x',
        'x-forwarded-for': '10.0.0.1',
        'content-type': 'text/plain',
        'x-trace': 't1',
      },
      body: 'payload',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('echo PUT /api/items?x=1&y=two payload');
    expect(response.headers.get('x-service')).toBe('yes');
    expect(response.headers.get('set-cookie')).toBeNull();
    const seen = upstream.requests.at(-1);
    expect(seen?.headers.get('host')).toBe('web');
    expect(seen?.headers.get('x-trace')).toBe('t1');
    expect(seen?.headers.get('content-type')).toBe('text/plain');
    for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-forwarded-for'])
      expect(seen?.headers.get(name)).toBeNull();
  });

  test('the session root and service status codes pass through', async () => {
    const { url } = await openSession();
    const root = await fetch(url, { headers: { authorization: 'Bearer ok' } });
    expect(await root.text()).toBe('echo GET / ');
    const missing = await fetch(`${url}/missing`, { headers: { authorization: 'Bearer ok' } });
    expect(missing.status).toBe(404);
    const empty = await fetch(`${url}/e`, {
      method: 'POST',
      headers: { authorization: 'Bearer ok' },
    });
    expect(await empty.text()).toBe('echo POST /e ');
  });

  test('sessions are refused to other users, viewers, strangers, and after expiry', async () => {
    const { url } = await openSession();
    const path = new URL(url).pathname;
    const as = (bearer: string, target = path) =>
      fetch(`${base}${target}/x`, { headers: { authorization: `Bearer ${bearer}` } });
    expect((await as('carol')).status).toBe(403);
    expect((await as('viewer')).status).toBe(403);
    expect((await as('nobody')).status).toBe(401);
    expect((await as('ok', path.replace('/web/', '/api/'))).status).toBe(404);
    expect((await as('ok', `/v1/services/web/proxy/${'A'.repeat(43)}`)).status).toBe(404);
    const expired = proxySessions.issue(
      { tenant: 'acme', user: 'alice', service: 'web', env: 'prod' },
      -1,
    );
    const gone = await as('ok', `/v1/services/web/proxy/${expired.id}`);
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { detail: string }).detail).toBe(
      'no such proxy session, or it expired',
    );
  });

  test('issuing a session drops expired ones', () => {
    const sessions = new ProxySessions();
    const old = sessions.issue({ tenant: 'acme', user: 'alice', service: 'web', env: 'prod' }, -1);
    sessions.issue({ tenant: 'acme', user: 'alice', service: 'web', env: 'prod' });
    expect((sessions as unknown as { sessions: Map<string, unknown> }).sessions.has(old.id)).toBe(
      false,
    );
  });

  test('an unreachable service maps to 502 without internal detail', async () => {
    const { url } = await openSession();
    upstreamUrl = 'http://127.0.0.1:1';
    try {
      const response = await fetch(`${url}/x`, { headers: { authorization: 'Bearer ok' } });
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain('the service could not be reached');
      expect(text).not.toContain('127.0.0.1');
    } finally {
      upstreamUrl = upstream.url;
    }
  });

  test('a body over the dispatch limit is refused with 413', async () => {
    const { url } = await openSession();
    const response = await fetch(`${url}/big`, {
      method: 'POST',
      headers: { authorization: 'Bearer ok' },
      body: new Uint8Array(MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
  });

  describe('servePassthrough directly', () => {
    const sessions = new ProxySessions();
    const session = sessions.issue({ tenant: 'acme', user: 'alice', service: 'web', env: 'prod' });
    const run = (request: Request, timeoutMs?: number) => {
      const url = new URL(request.url);
      return servePassthrough(request, url, PASSTHROUGH.exec(url.pathname) as RegExpExecArray, {
        tenant: 'acme',
        principal: alice,
        upstream: upstream.url,
        audit: () => {},
        sessions,
        timeoutMs,
      });
    };
    const at = (path: string) => `http://controller/v1/services/web/proxy/${session.id}${path}`;

    test('a streamed body over the limit without content-length is refused with 413', async () => {
      const chunk = new Uint8Array(512 * 1024);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ < 3) controller.enqueue(chunk);
          else controller.close();
        },
      });
      const response = await run(new Request(at('/big'), { method: 'POST', body }));
      expect(response.status).toBe(413);
    });

    test('a slow service maps to 504', async () => {
      const response = await run(new Request(at('/slow')), 50);
      expect(response.status).toBe(504);
      expect(((await response.json()) as { detail: string }).detail).toBe(
        'the service did not answer in time',
      );
    });
  });

  test('the default upstream is the tenant HTTP service', () => {
    expect(tenantUpstream('acme')).toBe('http://di-http.di-runtime-acme.svc.cluster.local:80');
  });
});
