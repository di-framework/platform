import { describe, expect, test } from 'bun:test';
import { alice, bob, servedController } from './support/controller.ts';
import { json } from './support/servers.ts';

/**
 * The controller served over real HTTP, in front of a fake API server that mints tokens and
 * echoes everything else, so a request that leaks to the Kubernetes proxy is visible.
 */
describe('/v1 dispatch', () => {
  const served = servedController({
    api: (request) => {
      if (/\/serviceaccounts\/di-user-(alice|bob)\/token$/.test(request.pathname))
        return json({
          status: {
            token: 'sa',
            expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
          },
        });
      return json({ echo: request.path });
    },
    principals: {
      ok: alice,
      viewer: bob,
      stranger: { ...alice, role: 'owner' } as never,
      roleless: { ...alice, role: undefined } as never,
    },
  });
  const { api, base } = served;

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

  test('GET /v1/deploy/registry answers 503 problem+json while no registry is configured', async () => {
    const response = await call('GET', '/v1/deploy/registry');
    expect(response.status).toBe(503);
    expect(await problem(response)).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'no registry is configured for this tenant',
    } as never);
    expect(reachedCluster('/v1')).toBe(false);
  });

  test('a deploy bundle that matches the contract reaches its handler', async () => {
    const bundle = {
      env: 'prod',
      service: 'web',
      component: { reference: 'registry/acme/web:1', digest: 'sha256:abc' },
      workload: { replicas: 1 },
      bindings: [{ name: 'kv', capability: 'wasi:keyvalue', config: { bucket: 'b' } }],
      secrets: ['db'],
    };
    // The handler's own bundle validation answers, so the contract let it through.
    for (const path of ['/v1/deploy', '/v1/deploy/preview'])
      expect((await call('POST', path, { body: JSON.stringify(bundle) })).status).toBe(422);
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

  test.each(['/v1/x/../deploy/registry', '/v1/x/%2e%2e/deploy/registry'])(
    '%s is normalised to the operation it names',
    async (path) => {
      const response = await call('GET', path);
      expect(response.status).toBe(503);
      expect((await problem(response)).detail).toBe('no registry is configured for this tenant');
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

  test('the registry operation requires a credential', async () => {
    expect((await fetch(`${base}/v1/deploy/registry`)).status).toBe(401);
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
      ['GET', '/v1/deployments?env=prod', 200, { items: [] }],
      [
        'GET',
        '/v1/deployments/stats?env=prod',
        200,
        { env: 'prod', services: 0, deployments: 0, ready: 0, failed: 0 },
      ],
      [
        'GET',
        '/v1/deploy/registry',
        503,
        {
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          detail: 'no registry is configured for this tenant',
        },
      ],
    ] as [string, string, number, unknown][])(
      'a viewer may call %s %s',
      async (method, path, status, body) => {
        const response = await call(method, path, { bearer: 'viewer' });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body as never);
      },
    );

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
      [
        'POST',
        '/v1/deploy/preview',
        '{"env":"prod","service":"web","component":{"reference":"r","digest":"d"},"workload":{},"bindings":[],"secrets":[]}',
        'previewDeploy',
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
      expect(served.log).toHaveBeenCalledWith(expect.stringContaining('"request.denied"'));
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
      const response = await call('POST', '/v1/deployments/rollback', {
        body: '{"env":"prod","service":"web"}',
      });
      expect(response.status).toBe(404);
      expect(await problem(response)).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'web has no earlier deployment in prod',
      } as never);
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
