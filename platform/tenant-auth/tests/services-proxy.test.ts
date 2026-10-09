import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { MAX_BODY_BYTES, ROUTES } from '@di-framework/tenant-cli/src/api/routes.ts';
import { tenantUpstream as gatewayUpstream } from '../../platform/src/gateway/gateway.ts';
import {
  backingServiceCrds,
  DEFAULT_CLASS_NAMES,
} from '../../platform/src/tenancy/backing-services.ts';
import { Controller, configFromEnv } from '../src/controller.ts';
import { AuthError, type Principal } from '../src/identity.ts';
import { KubeClient } from '../src/kube.ts';
import {
  PASSTHROUGH,
  type ProxySession,
  ProxySessions,
  proxySessions,
  SERVICE_NAME,
  servePassthrough,
  tenantUpstream,
  upstreamRequestHeaders,
} from '../src/v1/proxy.ts';
import { DEFAULT_CLASSES } from '../src/v1/services.ts';
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
    if (request.pathname === '/gzip')
      return new Response(Bun.gzipSync('compressed hello'), {
        headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain' },
      });
    if (request.pathname === '/redirect')
      return new Response(null, { status: 302, headers: { location: '/login?next=1' } });
    if (request.pathname === '/away')
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/x' } });
    if (request.pathname === '/empty') return new Response(null, { status: 204 });
    if (request.pathname === '/drip')
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (const part of ['a', 'b', 'c', 'd']) {
              await Bun.sleep(30);
              controller.enqueue(new TextEncoder().encode(part));
            }
            controller.close();
          },
        }),
      );
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
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (r, s) => controller.handle(r, s),
  });
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
    for (const name of ['authorization', 'cookie', 'proxy-authorization'])
      expect(seen?.headers.get(name)).toBeNull();
    expect(seen?.headers.get('x-forwarded-for')).toBe('127.0.0.1');
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
    ) as ProxySession;
    const gone = await as('ok', `/v1/services/web/proxy/${expired.id}`);
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { detail: string }).detail).toBe(
      'no such proxy session, or it expired',
    );
  });

  test('issuing a session drops expired ones', () => {
    const sessions = new ProxySessions(16, 1);
    const old = sessions.issue(
      { tenant: 'acme', user: 'alice', service: 'web', env: 'prod' },
      -1,
    ) as ProxySession;
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
    const session = sessions.issue({
      tenant: 'acme',
      user: 'alice',
      service: 'web',
      env: 'prod',
    }) as ProxySession;
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

  /** `isForwardedRequest` in cli-plugin-platform `src/control/network.ts`. */
  const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-by'];
  const readsAsExternal = (headers: Headers) =>
    FORWARDED.some((name) => (headers.get(name) ?? '').trim() !== '');

  test.each(['/_di/state', '/_actors/counter/1'])(
    'a proxied request to %s arrives marked as external, without a control token',
    async (target) => {
      const { url } = await openSession();
      const response = await fetch(`${url}${target}`, {
        headers: {
          authorization: 'Bearer ok',
          'x-forwarded-for': '',
          'x-forwarded-host': 'web',
          'x-forwarded-proto': '',
          'x-forwarded-by': 'spoofed',
          'x-di-control-token': 'stolen',
        },
      });
      expect(response.status).toBe(200);
      const seen = upstream.requests.at(-1);
      expect(seen?.path).toBe(target);
      expect(seen?.headers.get('host')).toBe('web');
      expect(seen?.headers.get('x-forwarded-for')).toBe('127.0.0.1');
      expect(seen?.headers.get('x-forwarded-host')).toBe(new URL(base).host);
      expect(seen?.headers.get('x-forwarded-proto')).toBe('http');
      expect(seen?.headers.get('x-forwarded-by')).toBeNull();
      expect(seen?.headers.get('x-di-control-token')).toBeNull();
      expect(readsAsExternal(seen?.headers as Headers)).toBe(true);
    },
  );

  test('without a known client address the request still reads as external', () => {
    const request = new Request('http://controller.test/x', { headers: { host: 'c.test' } });
    const headers = upstreamRequestHeaders(request, new URL(request.url), 'web');
    expect(headers.get('x-forwarded-for')).toBe('unknown');
    expect(headers.get('x-forwarded-host')).toBe('c.test');
    expect(
      upstreamRequestHeaders(
        new Request('https://c2.test/x'),
        new URL('https://c2.test/x'),
        'web',
      ).get('x-forwarded-host'),
    ).toBe('c2.test');
  });

  test.each([
    ['impersonate-user', 'admin'],
    ['impersonate-group', 'system:masters'],
    ['impersonate-uid', '1'],
    ['impersonate-extra-scopes', 'all'],
    ['x-real-ip', '10.0.0.1'],
    ['via', '1.1 evil'],
    ['x-forwarded-port', '443'],
    ['x-forwarded-prefix', '/admin'],
    ['x-forwarded-server', 'evil'],
    ['proxy-connection', 'keep-alive'],
    ['x-hop', 'named by Connection'],
  ])('the passthrough strips %s', (name, value) => {
    const request = new Request('http://controller.test/x', {
      headers: { [name]: value, connection: 'x-hop', 'x-kept': 'yes' },
    });
    const headers = upstreamRequestHeaders(request, new URL(request.url), 'web', '10.1.1.1');
    expect(headers.get(name)).toBeNull();
    expect(headers.get('x-kept')).toBe('yes');
  });

  test('a gzip-encoded answer passes through intact', async () => {
    const { url } = await openSession();
    const response = await fetch(`${url}/gzip`, {
      headers: { authorization: 'Bearer ok', 'accept-encoding': 'gzip' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(await response.text()).toBe('compressed hello');
  });

  test('redirects pass through unfollowed; relative ones stay under the session URL', async () => {
    const { url } = await openSession();
    const prefix = new URL(url).pathname;
    const relative = await fetch(`${url}/redirect`, {
      headers: { authorization: 'Bearer ok' },
      redirect: 'manual',
    });
    expect(relative.status).toBe(302);
    expect(relative.headers.get('location')).toBe(`${prefix}/login?next=1`);
    expect(upstream.requests.at(-1)?.pathname).toBe('/redirect');
    const away = await fetch(`${url}/away`, {
      headers: { authorization: 'Bearer ok' },
      redirect: 'manual',
    });
    expect(away.headers.get('location')).toBe('https://elsewhere.test/x');
  });

  test('proxied responses are sniff-proof and sandboxed', async () => {
    const { url } = await openSession();
    const response = await fetch(`${url}/page`, { headers: { authorization: 'Bearer ok' } });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    const empty = await fetch(`${url}/empty`, { headers: { authorization: 'Bearer ok' } });
    expect(empty.status).toBe(204);
  });

  test.each(['/a/../../../x', '/%2e%2e/%2e%2e/x', '//evil.test/x', '/@evil.test/x'])(
    'the path %s cannot leave the upstream',
    async (target) => {
      const { url } = await openSession();
      const before = upstream.requests.length;
      const response = await fetch(`${url}${target}`, { headers: { authorization: 'Bearer ok' } });
      // Either normalisation took the path out of the session URL, or it reached our upstream.
      if (response.status === 200) {
        expect(upstream.requests.length).toBe(before + 1);
        expect(upstream.requests.at(-1)?.path.startsWith('/')).toBe(true);
      } else {
        expect(upstream.requests.length).toBe(before);
      }
    },
  );

  test('a client abort mid-body is audited and answers a generic 502', async () => {
    const { url } = await openSession();
    const events: Record<string, unknown>[] = [];
    log.mockImplementation((line: string) => {
      events.push(JSON.parse(line));
    });
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(8));
        } else controller.error(new Error('client went away'));
      },
    });
    try {
      const response = await controller.handle(
        new Request(`${url}/upload`, {
          method: 'POST',
          headers: { authorization: 'Bearer ok' },
          body,
        }),
      );
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain('the service could not be reached');
      expect(text).not.toContain('client went away');
      expect(
        events.some((e) => e.event === 'request.failed' && String(e.reason).includes('went away')),
      ).toBe(true);
    } finally {
      log.mockImplementation(() => {});
    }
  });

  test('proxy answers 429 when the session store is full', async () => {
    const full = spyOn(proxySessions, 'issue').mockReturnValueOnce(undefined);
    try {
      const response = await call('POST', '/v1/services/web/proxy', { env: 'prod' });
      expect(response.status).toBe(429);
    } finally {
      full.mockRestore();
    }
  });

  test.each([
    [{ destinations: ['a.example.com'], parameters: { cpu: '1' } }, 'takes no sizing parameters'],
    [{ destinations: Array.from({ length: 33 }, (_, i) => `h${i}.example.com`) }, 'at most 32'],
    [{ destinations: ['a.example.com', 'a.example.com'] }, 'must not repeat'],
    [{ destinations: ['a.example.com:080'] }, 'host, *.suffix'],
    [
      {
        destinations: [
          `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}:12345`,
        ],
      },
      'host, *.suffix',
    ],
  ])('createService refuses egress %o with 422 before the API server', async (fields, detail) => {
    const before = created().length;
    const response = await call('POST', '/v1/services', {
      env: 'prod',
      type: 'egress',
      name: 'out',
      ...fields,
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { detail: string }).detail).toContain(detail);
    expect(created().length).toBe(before);
  });

  describe('session caps', () => {
    const bind = (user: string) => ({ tenant: 'acme', user, service: 'web', env: 'prod' });

    test("a user's oldest session is evicted past the per-user cap", () => {
      const sessions = new ProxySessions(2, 10);
      const first = sessions.issue(bind('alice')) as { id: string };
      const second = sessions.issue(bind('alice')) as { id: string };
      const third = sessions.issue(bind('alice')) as { id: string };
      expect(sessions.get(first.id)).toBeUndefined();
      expect(sessions.get(second.id)).toBeDefined();
      expect(sessions.get(third.id)).toBeDefined();
      expect(sessions.issue(bind('carol'))).toBeDefined();
      expect(sessions.size).toBe(3);
    });

    test('issuing is refused at the total cap, and expired sessions free room', () => {
      const sessions = new ProxySessions(5, 2);
      sessions.issue(bind('a'), -1);
      sessions.issue(bind('b'));
      // The store is full, so the expired session is swept to make room.
      expect(sessions.issue(bind('c'))).toBeDefined();
      expect(sessions.issue(bind('d'))).toBeUndefined();
      expect(sessions.size).toBe(2);
    });
  });

  test('a streamed answer survives past the idle timeout while it keeps sending', async () => {
    const sessions = new ProxySessions();
    const session = sessions.issue({
      tenant: 'acme',
      user: 'alice',
      service: 'web',
      env: 'prod',
    }) as { id: string };
    const request = new Request(`http://controller/v1/services/web/proxy/${session.id}/drip`);
    const url = new URL(request.url);
    const response = await servePassthrough(
      request,
      url,
      PASSTHROUGH.exec(url.pathname) as RegExpExecArray,
      {
        tenant: 'acme',
        principal: alice,
        upstream: upstream.url,
        audit: () => {},
        sessions,
        timeoutMs: 80,
      },
    );
    expect(await response.text()).toBe('abcd');
  });

  describe('pinned to the platform sources', () => {
    test('tenantUpstream matches the tenant gateway', () => {
      const ours = new URL(tenantUpstream('acme'));
      const gateway = gatewayUpstream('acme');
      expect(ours.hostname).toBe(gateway.hostname);
      expect(Number(ours.port || 80)).toBe(gateway.port);
    });

    test('DEFAULT_CLASSES matches the platform default class names', () => {
      expect(DEFAULT_CLASSES).toEqual(DEFAULT_CLASS_NAMES);
    });

    test('SERVICE_NAME is the CRD name pattern', () => {
      expect(JSON.stringify(backingServiceCrds)).toContain(
        JSON.stringify(`^${SERVICE_NAME.source.slice(1, -1)}$`),
      );
    });
  });

  test('no contract route matches the passthrough pattern', () => {
    const sample = `/v1/services/web/proxy/${'A'.repeat(43)}`;
    for (const path of [sample, `${sample}/`, `${sample}/x/y`])
      for (const route of ROUTES) expect(route.pattern.test(path)).toBe(false);
  });
});
