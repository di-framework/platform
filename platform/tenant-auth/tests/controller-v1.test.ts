import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Controller, configFromEnv } from '../src/controller.ts';
import { AuthError, type Principal } from '../src/identity.ts';
import { KubeClient } from '../src/kube.ts';
import { json, serve } from './support/servers.ts';

/**
 * The controller served over real HTTP, in front of a fake API server that mints tokens and
 * echoes everything else, so a request that leaks to the Kubernetes proxy is visible.
 */
describe('/v1 dispatch', () => {
  const api = serve((request) => {
    if (request.pathname.endsWith('/serviceaccounts/di-user-alice/token'))
      return json({
        status: {
          token: 'sa',
          expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    return json({ echo: request.path });
  });
  const alice: Principal = {
    user: 'alice',
    account: 'acme',
    role: 'developer',
    via: 'identity',
    credentialId: 's',
  };
  const bob: Principal = { ...alice, user: 'bob', role: 'viewer' };
  const kube = new KubeClient({ server: api.url, token: 'admin' }, 'wasmcloud');
  const controller = new Controller(
    configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
    kube,
    { issuer: 'https://issuer.test' } as never,
    {
      resolve: async (authorization: string | null) => {
        if (authorization === 'Bearer ok') return alice;
        if (authorization === 'Bearer viewer') return bob;
        if (authorization === 'Bearer stranger') return { ...alice, role: 'owner' } as never;
        if (authorization === 'Bearer roleless') return { ...alice, role: undefined } as never;
        throw new AuthError(401, 'a bearer token is required');
      },
      forget: () => {},
    } as never,
    { kube, namespace: 'di-runtime-acme', tenant: 'acme' },
  );
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
  });

  const call = (
    method: string,
    path: string,
    init: { body?: string; type?: string; bearer?: string } = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${init.bearer ?? 'ok'}`,
        ...(init.body !== undefined ? { 'content-type': init.type ?? 'application/json' } : {}),
      },
      body: init.body,
    });
  const problem = async (response: Response) => {
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    return (await response.json()) as { status: number; title: string; detail?: string };
  };
  const reachedCluster = (path: string) => api.requests.some((r) => r.pathname.startsWith(path));

  test.each([
    ['GET', '/v1/deployments?env=prod', undefined, 'deployments'],
    ['GET', '/v1/deployments?env=staging&service=web', undefined, 'deployments'],
    ['GET', '/v1/deployments/stats?env=prod', undefined, 'deploymentStats'],
    ['POST', '/v1/deployments/rollback', '{"env":"prod","service":"web"}', 'rollback'],
    ['GET', '/v1/secrets?env=prod', undefined, 'secrets'],
    ['PUT', '/v1/secrets/db?env=prod', '{"value":"s3cret"}', 'setSecret'],
    ['PATCH', '/v1/vars/LEVEL?env=prod', '{"value":"debug"}', 'updateVar'],
    ['DELETE', '/v1/vars/LEVEL?env=prod', undefined, 'unsetVar'],
    [
      'GET',
      '/v1/services/web/logs?env=prod&follow=true&tail=10&since=2026-10-09T00:00:00Z',
      undefined,
      'logs',
    ],
  ])('%s %s answers 501 problem+json', async (method, path, body, operation) => {
    const response = await call(method, path, { body });
    expect(response.status).toBe(501);
    expect(await problem(response)).toEqual({
      type: 'about:blank',
      title: 'Not Implemented',
      status: 501,
      detail: `${operation} is not implemented in the pilot yet`,
    } as never);
    expect(reachedCluster('/v1')).toBe(false);
  });

  test('a deploy bundle that matches the contract reaches its 501 handler', async () => {
    const bundle = {
      env: 'prod',
      service: 'web',
      component: { reference: 'registry/acme/web:1', digest: 'sha256:abc' },
      workload: { replicas: 1 },
      bindings: [{ name: 'kv', capability: 'wasi:keyvalue', config: { bucket: 'b' } }],
      secrets: ['db'],
    };
    for (const path of ['/v1/deploy', '/v1/deploy/preview'])
      expect((await call('POST', path, { body: JSON.stringify(bundle) })).status).toBe(501);
  });

  test.each([
    ['GET', '/v1/deployments', undefined, 'query.env is required'],
    ['GET', '/v1/deployments?env=dev', undefined, 'query.env must be one of prod, staging'],
    ['GET', '/v1/secrets?env=prod&env=staging', undefined, 'query.env must be given once'],
    [
      'GET',
      '/v1/services/web/logs?env=prod&follow=yes',
      undefined,
      'query.follow must be true or false',
    ],
    ['GET', '/v1/services/web/logs?env=prod&tail=ten', undefined, 'query.tail must be an integer'],
    ['PUT', '/v1/secrets/db?env=prod', '{}', 'body.value is required'],
    ['PUT', '/v1/secrets/db?env=prod', '{"value":7}', 'body.value must be a string'],
    ['PUT', '/v1/secrets/db?env=prod', 'not json', 'the request body is not valid JSON'],
    [
      'POST',
      '/v1/services',
      '{"env":"prod","type":"ftp","name":"x"}',
      'body.type must be one of keyvalue, messaging, blobstore, postgres, egress',
    ],
    ['POST', '/v1/deploy', '{"env":"prod"}', 'body.service is required'],
  ])('%s %s is refused with 400 before a handler', async (method, path, body, detail) => {
    const response = await call(method, path, { body });
    expect(response.status).toBe(400);
    expect(await problem(response)).toMatchObject({ status: 400, title: 'Bad Request', detail });
  });

  test('a body that is not JSON gets 415 problem+json', async () => {
    const response = await call('PUT', '/v1/secrets/db?env=prod', {
      body: 'v',
      type: 'text/plain',
    });
    expect(response.status).toBe(415);
    expect((await problem(response)).title).toBe('Unsupported Media Type');
  });

  test('a /v1 path that names no operation is a 404 problem, not a proxied request', async () => {
    const response = await call('GET', '/v1/nothing');
    expect(response.status).toBe(404);
    expect((await problem(response)).detail).toBe('GET /v1/nothing is not a /v1 operation');
    expect(reachedCluster('/v1')).toBe(false);
  });

  test.each([
    ['/v1/deployments/?env=prod', 'GET /v1/deployments/ is not a /v1 operation'],
    ['/v1/auth/info/', 'GET /v1/auth/info/ is not a /v1 operation'],
    ['/v1/unknown/path', 'GET /v1/unknown/path is not a /v1 operation'],
  ])('%s is a 404 problem and is not proxied', async (path, detail) => {
    const response = await call('GET', path);
    expect(response.status).toBe(404);
    expect((await problem(response)).detail).toBe(detail);
    expect(reachedCluster('/v1')).toBe(false);
  });

  test.each(['/v1/x/../deployments?env=prod', '/v1/x/%2e%2e/deployments?env=prod'])(
    '%s is normalised to the operation it names',
    async (path) => {
      const response = await call('GET', path);
      expect(response.status).toBe(501);
      expect((await problem(response)).detail).toBe(
        'deployments is not implemented in the pilot yet',
      );
    },
  );

  test('only GET /v1/auth/info is public', async () => {
    expect((await fetch(`${base}/v1/auth/info`)).status).toBe(200);
    expect((await fetch(`${base}/v1/auth/info`, { method: 'HEAD' })).status).toBe(401);
    expect((await fetch(`${base}/v1/auth/info/`)).status).toBe(401);
    expect((await fetch(`${base}/v1/auth/whoami`)).status).toBe(401);
  });

  test('a /V1 path goes to the proxy and is denied with 403', async () => {
    const response = await call('GET', '/V1/deployments?env=prod');
    expect(response.status).toBe(403);
    expect(reachedCluster('/V1')).toBe(false);
  });

  test('/v1 operations still require a credential', async () => {
    const response = await fetch(`${base}/v1/deployments?env=prod`);
    expect(response.status).toBe(401);
  });

  test('the auth routes keep their behaviour', async () => {
    const info = await fetch(`${base}/v1/auth/info`);
    expect(await info.json()).toEqual({
      account: 'acme',
      issuer: 'https://issuer.test',
      clientId: 'tenant-cli',
    });
    expect(await (await call('GET', '/v1/auth/whoami')).json()).toEqual(alice as never);
    expect((await call('POST', '/v1/auth/logout')).status).toBe(204);
  });

  test('paths outside /v1 still go to the Kubernetes proxy', async () => {
    const response = await call('GET', '/api/v1/namespaces/di-tenant-acme/pods?limit=1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      echo: '/api/v1/namespaces/di-tenant-acme/pods?limit=1',
    });
  });

  describe('role policy', () => {
    test.each([
      ['GET', '/v1/deployments?env=prod', undefined],
      ['GET', '/v1/deployments/stats?env=prod', undefined],
      ['GET', '/v1/vars?env=prod', undefined],
      ['GET', '/v1/services/web/logs?env=prod', undefined],
      [
        'POST',
        '/v1/deploy/preview',
        '{"env":"prod","service":"web","component":{"reference":"r","digest":"d"},"workload":{},"bindings":[],"secrets":[]}',
      ],
    ])('a viewer may call %s %s', async (method, path, body) => {
      const response = await call(method, path, { body, bearer: 'viewer' });
      expect(response.status).toBe(501);
    });

    test.each([
      ['GET', '/v1/secrets?env=prod', undefined, 'secrets'],
      ['PUT', '/v1/secrets/db?env=prod', '{"value":"s3cret"}', 'setSecret'],
      ['PATCH', '/v1/secrets/db?env=prod', '{"value":"s3cret"}', 'updateSecret'],
      ['DELETE', '/v1/secrets/db?env=prod', undefined, 'unsetSecret'],
      ['PUT', '/v1/vars/LEVEL?env=prod', '{"value":"debug"}', 'setVar'],
      ['DELETE', '/v1/vars/LEVEL?env=prod', undefined, 'unsetVar'],
      ['POST', '/v1/deployments/rollback', '{"env":"prod","service":"web"}', 'rollback'],
      ['POST', '/v1/services', '{"env":"prod","type":"keyvalue","name":"web"}', 'createService'],
      ['POST', '/v1/services/web/proxy', '{"env":"prod"}', 'proxy'],
      [
        'POST',
        '/v1/deploy',
        '{"env":"prod","service":"web","component":{"reference":"r","digest":"d"},"workload":{},"bindings":[],"secrets":[]}',
        'deploy',
      ],
    ])('a viewer is refused %s %s with 403 problem+json', async (method, path, body, operation) => {
      const response = await call(method, path, { body, bearer: 'viewer' });
      expect(response.status).toBe(403);
      expect(await problem(response)).toEqual({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: `a viewer may not call ${operation}`,
      } as never);
      expect(reachedCluster('/v1')).toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"request.denied"'));
    });

    test.each([
      ['stranger', 'an owner may not call vars'],
      ['roleless', 'a caller without a tenant role may not call vars'],
    ])('a %s principal is refused with 403', async (bearer, detail) => {
      const response = await call('GET', '/v1/vars?env=prod', { bearer });
      expect(response.status).toBe(403);
      expect(await problem(response)).toMatchObject({ status: 403, detail } as never);
    });

    test('a developer may call the operations a viewer may not', async () => {
      const response = await call('PUT', '/v1/secrets/db?env=prod', { body: '{"value":"v"}' });
      expect(response.status).toBe(501);
    });

    test('a viewer keeps whoami and logout', async () => {
      expect(await (await call('GET', '/v1/auth/whoami', { bearer: 'viewer' })).json()).toEqual(
        bob as never,
      );
      expect((await call('POST', '/v1/auth/logout', { bearer: 'viewer' })).status).toBe(204);
    });

    test('validation still answers before the policy, and no credential is still 401', async () => {
      expect(
        (await call('PUT', '/v1/secrets/db?env=prod', { body: '{}', bearer: 'viewer' })).status,
      ).toBe(400);
      const anonymous = await fetch(`${base}/v1/secrets/db?env=prod`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{"value":"v"}',
      });
      expect(anonymous.status).toBe(401);
    });
  });
});
