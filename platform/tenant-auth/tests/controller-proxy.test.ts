import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { Controller, configFromEnv } from '../src/controller.ts';
import { AuthError, type Principal } from '../src/identity.ts';
import { KubeClient, type SecretResource } from '../src/kube.ts';
import { type FakeServer, json, serve } from './support/servers.ts';

/** A slice of the Kubernetes API: TokenRequest, a namespaced resource, users, and Secrets. */
function fakeApiServer() {
  const validTokens = new Set<string>();
  const secrets = new Map<string, SecretResource>();
  const state = { minted: 0, mintFails: false, users: [] as unknown[] };
  const server = serve((request) => {
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
    expect(((await unmintable.json()) as { message: string }).message).toContain('not found');
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
    expect(controller.kube.server).toBe('https://k8s.test');
    expect(controller.provider.issuer).toBe(issuer.url);
    expect(controller.keys).toMatchObject({ namespace: 'di-runtime-acme', tenant: 'acme' });
    expect(controller.identity.tenant).toBe('acme');
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
