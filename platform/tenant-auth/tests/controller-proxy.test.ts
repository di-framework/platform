import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  zstdCompressSync,
} from 'node:zlib';
import { dump } from 'js-yaml';
import { Controller, configFromEnv } from '../src/controller.ts';
import { AuthError, type Principal } from '../src/identity.ts';
import { KubeClient, type SecretResource } from '../src/kube.ts';
import { type FakeServer, json, serve } from './support/servers.ts';

/** An API object large enough that its encoded and plain sizes differ. */
const PLAIN = JSON.stringify({ kind: 'ConfigMap', data: { text: 'compressible '.repeat(200) } });
const ENCODE: Record<string, (body: string) => Uint8Array<ArrayBuffer>> = {
  gzip: (body) => new Uint8Array(gzipSync(body)),
  'x-gzip': (body) => new Uint8Array(gzipSync(body)),
  br: (body) => new Uint8Array(brotliCompressSync(body)),
  deflate: (body) => new Uint8Array(deflateSync(body)),
  zstd: (body) => new Uint8Array(zstdCompressSync(body)),
  'gzip, identity': (body) => new Uint8Array(gzipSync(body)),
  'identity, gzip': (body) => new Uint8Array(gzipSync(body)),
  'gzip, ': (body) => new Uint8Array(gzipSync(body)),
  // A coding list `fetch` does not decode: the bytes and the header must both pass untouched.
  'gzip, br': (body) => new Uint8Array(brotliCompressSync(gzipSync(body))),
};
/** Resolved by the watch test once it has read the first chunk, releasing the second. */
const watchGate: { release: () => void; opened: Promise<void> } = {
  release: () => {},
  opened: Promise.resolve(),
};
const WATCH = ['{"type":"ADDED","object":{"n":1}}\n', '{"type":"MODIFIED","object":{"n":2}}\n'];

/** A slice of the Kubernetes API: TokenRequest, a namespaced resource, users, and Secrets. */
function fakeApiServer() {
  const validTokens = new Set<string>();
  const secrets = new Map<string, SecretResource>();
  const state = {
    minted: 0,
    mintFails: false,
    users: [] as { metadata: { name: string }; spec?: unknown }[],
    /**
     * The published member list (#321): `members` (active names) and `entries` (every
     * membership). With neither, the ConfigMap answers 403, as an older platform does.
     */
    members: undefined as string | undefined,
    entries: undefined as string | undefined,
    /** Users the controller may read by name; the rest answer 403. */
    readable: [] as string[],
    /** User reads (by name or listed) the controller made. */
    userReads: 0,
  };
  const server = serve((request) => {
    if (
      request.pathname === '/api/v1/namespaces/di-runtime-acme/configmaps/tenant-controller-members'
    )
      return state.members === undefined && state.entries === undefined
        ? json({ message: 'forbidden' }, 403)
        : json({
            metadata: { name: 'tenant-controller-members' },
            data: {
              ...(state.members === undefined ? {} : { members: state.members }),
              ...(state.entries === undefined ? {} : { entries: state.entries }),
            },
          });
    if (request.pathname.startsWith('/apis/platform.di-framework.dev/v1alpha1/users'))
      state.userReads++;
    const byName = /^\/apis\/platform\.di-framework\.dev\/v1alpha1\/users\/([^/]+)$/.exec(
      request.pathname,
    );
    if (byName?.[1]) {
      if (!state.readable.includes(byName[1])) return json({ message: 'forbidden' }, 403);
      const found = state.users.find((u) => u.metadata.name === byName[1]);
      return found ? json(found) : json({ message: 'not found' }, 404);
    }
    if (request.pathname === '/api/v1/namespaces/wasmcloud/serviceaccounts/di-user-alice/token') {
      if (state.mintFails)
        return json({ message: 'serviceaccounts "di-user-alice" not found' }, 404);
      const token = `sa-${++state.minted}`;
      validTokens.add(token);
      return json({
        status: { token, expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString() },
      });
    }
    if (request.pathname === '/apis/platform.di-framework.dev/v1alpha1/users')
      return json({ items: state.users });
    if (request.pathname.startsWith('/api/v1/namespaces/di-runtime-acme/secrets')) {
      const name = request.pathname.split('/')[6];
      if (request.method === 'POST') {
        const secret = JSON.parse(request.body) as SecretResource;
        const data = Object.fromEntries(
          Object.entries(secret.stringData ?? {}).map(([k, v]) => [
            k,
            Buffer.from(v).toString('base64'),
          ]),
        );
        const stored = {
          ...secret,
          data,
          metadata: { ...secret.metadata, creationTimestamp: new Date().toISOString() },
        };
        secrets.set(secret.metadata.name, stored);
        return json(stored, 201);
      }
      if (request.method === 'DELETE') {
        secrets.delete(name ?? '');
        return json({});
      }
      if (name)
        return secrets.has(name) ? json(secrets.get(name)) : json({ message: 'not found' }, 404);
      return json({ items: [...secrets.values()] });
    }
    const token = request.headers.get('authorization')?.slice(7) ?? '';
    if (!validTokens.has(token)) return json({ message: 'Unauthorized' }, 401);
    if (request.pathname === '/api/v1/namespaces/di-tenant-acme/configmaps/encoded') {
      const coding = new URLSearchParams(request.path.split('?')[1]).get('coding') ?? '';
      return new Response(ENCODE[coding.toLowerCase()]?.(PLAIN) ?? PLAIN, {
        headers: {
          'content-type': 'application/json',
          ...(coding ? { 'content-encoding': coding } : {}),
        },
      });
    }
    if (
      request.pathname === '/api/v1/namespaces/di-tenant-acme/pods' &&
      request.path.includes('watch')
    )
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(WATCH[0] as string));
            await watchGate.opened;
            controller.enqueue(new TextEncoder().encode(WATCH[1] as string));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    return json({
      echo: { method: request.method, path: request.path, body: request.body, token },
    });
  });
  return { server, validTokens, state };
}

describe('Controller', () => {
  const api = fakeApiServer();
  const alice: Principal = {
    user: 'alice',
    account: 'acme',
    role: 'developer',
    via: 'identity',
    credentialId: 's',
  };
  const viaKey: Principal = { ...alice, via: 'api-key', credentialId: 'k' };
  const forgotten: string[] = [];
  const kube = new KubeClient({ server: api.server.url, token: 'admin' }, 'wasmcloud');
  const keys = { kube, namespace: 'di-runtime-acme', tenant: 'acme' };
  const controller = new Controller(
    configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
    kube,
    { issuer: 'https://issuer.test' } as never,
    {
      resolve: async (authorization: string | null) => {
        if (authorization === 'Bearer ok') return alice;
        if (authorization === 'Bearer key') return viaKey;
        if (authorization === 'Bearer boom') throw new Error('userinfo returned 500');
        throw new AuthError(401, 'a bearer token is required');
      },
      forget: (user: string) => {
        forgotten.push(user);
      },
    } as never,
    keys,
  );
  const logged: string[] = [];
  let log: ReturnType<typeof spyOn>;
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(JSON.parse(line).event);
    });
  });
  afterAll(() => {
    log.mockRestore();
    api.server.stop();
  });
  afterEach(() => {
    logged.length = 0;
  });
  const call = (method: string, path: string, authorization = 'Bearer ok', body?: string) =>
    controller.handle(
      new Request(`https://controller.test${path}`, {
        method,
        headers: {
          authorization,
          'x-extra': 'kept',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body,
      }),
    );

  test('reads config from the environment', () => {
    expect(() => configFromEnv({})).toThrow('TENANT_CONTROLLER_TENANT is required');
    expect(
      configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme', TENANT_CONTROLLER_PORT: '1' }),
    ).toMatchObject({
      tenant: 'acme',
      port: 1,
      platformNamespace: 'wasmcloud',
      issuer: 'http://localhost:4180',
      tokenTtlSeconds: 3600,
    });
  });

  test('proxies inside the tenant with a minted ServiceAccount token', async () => {
    const response = await call('GET', '/api/v1/namespaces/di-tenant-acme/pods?limit=1');
    expect(response.status).toBe(200);
    const { echo } = (await response.json()) as { echo: Record<string, string> };
    expect(echo).toMatchObject({
      method: 'GET',
      path: '/api/v1/namespaces/di-tenant-acme/pods?limit=1',
      token: 'sa-1',
    });
    expect(api.server.requests.at(-1)?.headers.get('x-extra')).toBe('kept');
    expect(api.server.requests.at(-1)?.headers.get('host')).not.toBe('controller.test');
    const posted = await call(
      'POST',
      '/api/v1/namespaces/di-runtime-acme/configmaps',
      'Bearer ok',
      '{"a":1}',
    );
    expect(((await posted.json()) as { echo: Record<string, string> }).echo).toMatchObject({
      body: '{"a":1}',
      token: 'sa-1',
    });
    expect(api.state.minted).toBe(1);
    expect(logged).toEqual(['token.minted', 'request.proxied', 'request.proxied']);
  });

  describe('relays response codings a client can read (#71)', () => {
    // The controller behind a real listener, read by a real client: what a kubectl would see.
    const front = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => controller.handle(request),
    });
    afterAll(() => front.stop(true));
    const get = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${front.port}${path}`, {
        ...init,
        headers: { authorization: 'Bearer ok', ...(init.headers as Record<string, string>) },
      } as RequestInit);
    const encoded = (coding: string) =>
      `/api/v1/namespaces/di-tenant-acme/configmaps/encoded?coding=${encodeURIComponent(coding)}`;

    test.each([
      'gzip',
      'x-gzip',
      'br',
      'deflate',
      'zstd',
      'GZIP',
      'identity',
      '',
      'gzip, identity',
      'identity, gzip',
      'gzip, ',
    ])('drops the already-decoded %p coding and its stale length', async (coding) => {
      // Undecoded bytes: the body on the wire is exactly the plain object, with no coding to undo.
      const raw = await get(encoded(coding), {
        headers: { 'accept-encoding': 'gzip, br' },
        decompress: false,
      } as RequestInit);
      expect(raw.status).toBe(200);
      expect(raw.headers.get('content-encoding')).toBeNull();
      expect(Buffer.from(await raw.arrayBuffer()).toString()).toBe(PLAIN);
      const length = raw.headers.get('content-length');
      if (length !== null) expect(Number(length)).toBe(Buffer.byteLength(PLAIN));
      // The caller's Accept-Encoding is not what reached the API server.
      expect(api.server.requests.at(-1)?.headers.get('accept-encoding') ?? '').not.toBe('gzip, br');
      // An ordinary client (decoding on) reads the object.
      const read = await get(encoded(coding));
      expect(await read.json()).toEqual(JSON.parse(PLAIN));
    });

    test('relays a coding fetch left encoded, bytes and header untouched', async () => {
      const raw = await get(encoded('gzip, br'), { decompress: false } as RequestInit);
      expect(raw.headers.get('content-encoding')).toBe('gzip, br');
      const bytes = new Uint8Array(await raw.arrayBuffer());
      expect(bytes).toEqual(new Uint8Array(brotliCompressSync(gzipSync(PLAIN))));
      expect(gunzipSync(brotliDecompressSync(bytes)).toString()).toBe(PLAIN);
    });

    test('streams an uncoded watch chunk by chunk', async () => {
      watchGate.opened = new Promise<void>((resolve) => {
        watchGate.release = resolve;
      });
      const response = await get('/api/v1/namespaces/di-tenant-acme/pods?watch=1');
      expect(response.headers.get('content-encoding')).toBeNull();
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      // The upstream holds the second line back until the first has crossed both hops, so a
      // relay that buffered the whole body would hang here instead of passing by luck of timing.
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(WATCH[0] as string);
      watchGate.release();
      let rest = '';
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        rest += new TextDecoder().decode(chunk.value);
      expect(rest).toBe(WATCH[1] as string);
    });
  });

  test('never returns the object a Secret DELETE answers with (#112)', async () => {
    for (const path of [
      '/api/v1/namespaces/di-tenant-acme/secrets/db.prod',
      '/api/v1/namespaces/di-tenant-acme/secrets?labelSelector=a%3Db',
    ]) {
      const response = await call('DELETE', path);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('echo');
      expect(JSON.parse(text)).toMatchObject({ kind: 'Status', status: 'Success', code: 200 });
    }
    // Other deletes, and failed Secret deletes, pass through unchanged.
    const other = await call('DELETE', '/api/v1/namespaces/di-tenant-acme/configmaps/x');
    expect(((await other.json()) as { echo: Record<string, string> }).echo.method).toBe('DELETE');
  });

  test('redacts a Secret DELETE however its path is spelled (#116)', async () => {
    for (const [raw, forwarded] of [
      [
        '/api/v1/namespaces/di-tenant-acme/%73ecrets/db',
        '/api/v1/namespaces/di-tenant-acme/secrets/db',
      ],
      [
        '/api/v1/namespaces/di-tenant-acme/%73%65%63%72%65%74%73/db',
        '/api/v1/namespaces/di-tenant-acme/secrets/db',
      ],
      [
        '/api/v1/namespaces/%64i-tenant-acme/secrets/d%62',
        '/api/v1/namespaces/di-tenant-acme/secrets/db',
      ],
      [
        '/api/v1/namespaces/di-tenant-acme/secrets/db%2Eprod',
        '/api/v1/namespaces/di-tenant-acme/secrets/db.prod',
      ],
    ] as const) {
      const response = await call('DELETE', raw);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('echo');
      expect(JSON.parse(text)).toMatchObject({ kind: 'Status', status: 'Success', code: 200 });
      // The API server is sent the path the policy and the redaction checked.
      expect(api.server.requests.at(-1)?.pathname).toBe(forwarded);
    }
  });

  test('refuses ambiguous encodings before the API server sees them (#116)', async () => {
    const before = api.server.requests.length;
    for (const path of [
      '/api/v1/namespaces/di-tenant-acme/secrets%2Fdb',
      '/api/v1/namespaces/di-tenant-acme/secrets%2fdb',
      '/api/v1/namespaces/di-tenant-acme//secrets/db',
      '/api/v1/namespaces/di-tenant-acme%2F..%2Fwasmcloud/secrets',
      '/api/v1/namespaces/di-tenant-acme/%2573ecrets/db',
      '/api/v1/namespaces/di-tenant-acme/%zz',
    ]) {
      const response = await call('DELETE', path);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { kind: string }).kind).toBe('Status');
    }
    // Dot segments, encoded or not, are resolved by the URL parser and then checked as usual.
    expect(
      (await call('GET', '/api/v1/namespaces/di-tenant-acme/%2e%2E/%2E%2e/wasmcloud/secrets'))
        .status,
    ).toBe(403);
    expect(api.server.requests.length).toBe(before);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.every((event) => event === 'request.denied')).toBe(true);
  });

  test('forwards a legitimately encoded name in its canonical spelling (#116)', async () => {
    const response = await call(
      'GET',
      '/api/v1/namespaces/di-tenant-acme/pods/web%2D1%3A8080/proxy?x=%2F',
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { echo: Record<string, string> }).echo.path).toBe(
      '/api/v1/namespaces/di-tenant-acme/pods/web-1:8080/proxy?x=%2F',
    );
  });

  test('re-mints once when the cached token is rejected', async () => {
    api.validTokens.clear();
    const response = await call('GET', '/api/v1/namespaces/di-tenant-acme/pods', 'Bearer key');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { echo: Record<string, string> }).echo.token).toBe('sa-2');
    expect(forgotten).toContain('alice');
    expect(logged).toEqual(['token.minted', 'request.proxied']);
  });

  test('refuses paths outside the tenant and reports auth or cluster failures', async () => {
    expect((await call('GET', '/api/v1/namespaces/wasmcloud/secrets')).status).toBe(403);
    expect(logged).toEqual(['request.denied']);
    expect(
      (await call('GET', '/api/v1/namespaces/di-tenant-acme/pods', 'Bearer nope')).status,
    ).toBe(401);
    const failed = await call('GET', '/api/v1/namespaces/di-tenant-acme/pods', 'Bearer boom');
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { message: string }).message).toContain('unavailable');
    api.state.mintFails = true;
    controller.identity.forget('alice');
    await call('POST', '/v1/auth/logout');
    const unmintable = await call('GET', '/api/v1/namespaces/di-tenant-acme/pods');
    api.state.mintFails = false;
    expect(unmintable.status).toBe(502);
    // The mint failure names the ServiceAccount and platform namespace: it stays in the audit.
    const body = await unmintable.text();
    expect(JSON.parse(body)).toMatchObject({
      reason: 'ServiceUnavailable',
      message: 'the cluster request failed',
    });
    expect(body).not.toContain('di-user-alice');
    expect(body).not.toContain('not found');
    const audit = (log.mock.calls as unknown[][])
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .findLast((entry) => entry.event === 'request.failed');
    expect(audit).toMatchObject({ user: 'alice', path: '/api/v1/namespaces/di-tenant-acme/pods' });
    expect(String(audit?.reason)).toContain('di-user-alice');
  });

  test('manages API keys and lists members', async () => {
    expect(
      (await call('POST', '/-/keys', 'Bearer key', '{"name":"ci","ttlSeconds":3600}')).status,
    ).toBe(403);
    expect(
      (await call('POST', '/-/keys', 'Bearer ok', '{"name":"","ttlSeconds":3600}')).status,
    ).toBe(400);
    const created = await call('POST', '/-/keys', 'Bearer ok', '{"name":"ci","ttlSeconds":3600}');
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const listed = (await (await call('GET', '/-/keys')).json()) as { keys: { id: string }[] };
    expect(listed.keys.map((k) => k.id)).toEqual([id]);
    expect((await call('DELETE', `/-/keys/${id}`)).status).toBe(204);
    expect((await call('DELETE', `/-/keys/${id}`)).status).toBe(404);
    api.state.users = [
      {
        metadata: { name: 'bob' },
        spec: { suspended: true, memberships: [{ tenant: 'acme', role: 'viewer' }] },
      },
      {
        metadata: { name: 'alice' },
        spec: {
          memberships: [
            { tenant: 'acme', role: 'developer' },
            { tenant: 'other', role: 'viewer' },
          ],
        },
      },
    ];
    expect(await (await call('GET', '/-/members')).json()).toEqual({
      members: [
        { user: 'alice', role: 'developer', suspended: false },
        { user: 'bob', role: 'viewer', suspended: true },
      ],
    });
    expect((await call('GET', '/-/healthz', 'Bearer nope')).status).toBe(200);
  });

  test('reads the published members by name instead of listing every User (#321)', async () => {
    api.state.users = [
      {
        metadata: { name: 'alice' },
        spec: { memberships: [{ tenant: 'acme', role: 'developer' }] },
      },
      { metadata: { name: 'bob' }, spec: { memberships: [{ tenant: 'acme', role: 'viewer' }] } },
      // Not a member: listing every User would reach it, reading by name does not.
      { metadata: { name: 'eve' }, spec: { memberships: [{ tenant: 'acme', role: 'viewer' }] } },
    ];
    // carol was removed (404), dave's grant was already dropped (403): both are skipped.
    api.state.members = JSON.stringify(['alice', 'bob', 'carol', 'dave']);
    api.state.readable = ['alice', 'bob', 'carol'];
    try {
      expect(await (await call('GET', '/-/members')).json()).toEqual({
        members: [
          { user: 'alice', role: 'developer', suspended: false },
          { user: 'bob', role: 'viewer', suspended: false },
        ],
      });
      api.state.members = JSON.stringify([]);
      expect(await (await call('GET', '/-/members')).json()).toEqual({ members: [] });
      api.state.members = JSON.stringify({ alice: true });
      expect((await call('GET', '/-/members')).status).toBeGreaterThanOrEqual(500);
    } finally {
      api.state.members = undefined;
      api.state.readable = [];
    }
  });

  test('lists published entries, suspended members included, without reading Users (#321)', async () => {
    // Users the controller could list or read: none of them may be consulted.
    api.state.users = [
      { metadata: { name: 'eve' }, spec: { memberships: [{ tenant: 'acme', role: 'viewer' }] } },
    ];
    api.state.readable = ['eve'];
    api.state.members = JSON.stringify(['alice']);
    api.state.entries = JSON.stringify([
      { name: 'carol', role: 'viewer', suspended: true },
      { name: 'alice', role: 'viewer', suspended: false },
      { name: 'alice', role: 'developer', suspended: false },
    ]);
    const reads = api.state.userReads;
    try {
      expect(await (await call('GET', '/-/members')).json()).toEqual({
        members: [
          { user: 'alice', role: 'developer', suspended: false },
          { user: 'alice', role: 'viewer', suspended: false },
          { user: 'carol', role: 'viewer', suspended: true },
        ],
      });
      expect(api.state.userReads).toBe(reads);
      // Fails closed on an entry without a suspended flag, or with an unknown role.
      for (const bad of [
        [{ name: 'alice', role: 'developer' }],
        [{ name: 'alice', role: 'admin', suspended: false }],
        [{ role: 'developer', suspended: false }],
        ['alice'],
        { alice: true },
      ]) {
        api.state.entries = JSON.stringify(bad);
        expect((await call('GET', '/-/members')).status).toBeGreaterThanOrEqual(500);
      }
      expect(api.state.userReads).toBe(reads);
    } finally {
      api.state.members = undefined;
      api.state.entries = undefined;
      api.state.readable = [];
    }
  });
});

describe('Controller.start', () => {
  let issuer: FakeServer;
  let dir: string;
  beforeAll(() => {
    issuer = serve((request) =>
      request.pathname === '/.well-known/openid-configuration'
        ? json({
            issuer: issuer.url,
            authorization_endpoint: `${issuer.url}/a`,
            token_endpoint: `${issuer.url}/t`,
            jwks_uri: `${issuer.url}/j`,
          })
        : json({}, 404),
    );
    dir = mkdtempSync(join(tmpdir(), 'controller-'));
    writeFileSync(
      join(dir, 'kubeconfig'),
      dump({
        'current-context': 'x',
        contexts: [{ name: 'x', context: { cluster: 'c', user: 'u' } }],
        clusters: [{ name: 'c', cluster: { server: 'https://k8s.test' } }],
        users: [{ name: 'u', user: { token: 't' } }],
      }),
    );
  });
  afterAll(() => {
    issuer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('wires the kubeconfig, discovery, and key store', async () => {
    const controller = await Controller.start(
      configFromEnv({
        TENANT_CONTROLLER_TENANT: 'acme',
        TENANT_CONTROLLER_KUBECONFIG: join(dir, 'kubeconfig'),
        TENANT_CONTROLLER_ISSUER: issuer.url,
      }),
    );
    await controller.discovered;
    expect(controller.kube.server).toBe('https://k8s.test');
    expect(controller.provider?.issuer).toBe(issuer.url);
    expect(controller.keys).toMatchObject({ namespace: 'di-runtime-acme', tenant: 'acme' });
    expect(controller.identity.tenant).toBe('acme');
    controller.stop();
  });
  test('falls back to in-cluster credentials', async () => {
    const saved = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
    try {
      await expect(
        Controller.start(
          configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme', TENANT_CONTROLLER_ISSUER: issuer.url }),
        ),
      ).rejects.toThrow('not running inside a cluster');
    } finally {
      if (saved !== undefined) process.env.KUBERNETES_SERVICE_HOST = saved;
    }
  });
});

describe('Controller upstream failures (#84)', () => {
  const alice: Principal = {
    user: 'alice',
    account: 'acme',
    role: 'developer',
    via: 'identity',
    credentialId: 's',
  };
  // Nothing listens here: every API server call is a network error.
  const unreachable = serve(() => json({}));
  const server = unreachable.url;
  unreachable.stop();
  const kube = new KubeClient({ server, token: 'admin' }, 'wasmcloud');
  const controller = new Controller(
    configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
    kube,
    { issuer: 'https://issuer.test' } as never,
    { resolve: async () => alice, forget: () => {} } as never,
    { kube, namespace: 'di-runtime-acme', tenant: 'acme' },
  );
  let log: ReturnType<typeof spyOn<typeof console, 'log'>>;
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => log.mockRestore());

  test('a network error answers a generic 502 and logs the detail', async () => {
    const response = await controller.handle(
      new Request('https://controller.test/api/v1/namespaces/di-tenant-acme/pods', {
        headers: { authorization: 'Bearer ok' },
      }),
    );
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Failure',
      reason: 'ServiceUnavailable',
      message: 'the cluster request failed',
      code: 502,
    });
    // Neither the API server address, the ServiceAccount, nor the raw error reaches the caller.
    expect(body).not.toContain(new URL(server).host);
    expect(body).not.toContain('di-user-alice');
    expect(body).not.toContain('Error');
    const audit = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((entry) => entry.event === 'request.failed');
    expect(audit).toMatchObject({ user: 'alice', path: '/api/v1/namespaces/di-tenant-acme/pods' });
    expect(String(audit?.reason)).toContain('could not mint a token for alice');
  });
});
