import { afterAll, beforeAll, describe, expect, type Mock, spyOn, test } from 'bun:test';
import { Controller, configFromEnv } from '../src/controller.ts';
import { AuthError } from '../src/identity.ts';

/**
 * Authentication refusals raised before `/v1` dispatch are problem+json (platform#97), while the
 * Kubernetes proxy keeps its Status shape. The resolver below raises each refusal the real
 * `IdentityResolver` can, keyed by the bearer.
 */
const SECRET = 'eyJhbGciOi.secret-token-body.sig';
const refusals: Record<string, Error> = {
  [`Bearer ${SECRET}`]: new AuthError(401, 'the access token is invalid or has expired'),
  'Bearer dik_expired': new AuthError(401, 'API key has expired'),
  'Bearer dik_malformed': new AuthError(401, 'API key is malformed'),
  'Bearer suspended': new AuthError(403, 'account acme is suspended'),
  'Bearer stranger': new AuthError(403, 'carol is not a member of organization acme'),
  'Bearer gone': new AuthError(404, 'account acme does not exist'),
  'Bearer broken': new Error(`upstream said no to ${SECRET} at https://kube.internal:6443`),
};

const controller = new Controller(
  configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
  {} as never,
  { issuer: 'https://issuer.test' } as never,
  {
    resolve: async (authorization: string | null) => {
      if (!authorization) throw new AuthError(401, 'a bearer token is required');
      throw refusals[authorization] ?? new AuthError(401, 'a bearer token is required');
    },
    forget: () => {},
  } as never,
  {} as never,
);

const call = (path: string, authorization?: string) =>
  controller.handle(
    new Request(`https://controller.test${path}`, {
      headers: authorization ? { authorization } : {},
    }),
  );

let log: Mock<typeof console.log>;
beforeAll(() => {
  log = spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => log.mockRestore());

const audited = () => log.mock.calls.map(([line]) => JSON.parse(String(line)));

describe('/v1 authentication refusals', () => {
  const PATH = '/v1/vars?env=staging';

  test('no credential is a 401 problem with a bare bearer challenge', async () => {
    const response = await call(PATH);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="di-framework-tenant"');
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'a bearer token is required',
    });
  });

  test.each([
    [`Bearer ${SECRET}`, 'the access token is invalid or has expired'],
    ['Bearer dik_expired', 'API key has expired'],
    ['Bearer dik_malformed', 'API key is malformed'],
    ['Basic dXNlcjpwYXNz', 'a bearer token is required'],
  ])('a rejected credential (%s) is a 401 invalid_token problem', async (authorization, detail) => {
    const response = await call(PATH, authorization);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer realm="di-framework-tenant", error="invalid_token"',
    );
    const body = await response.text();
    expect(body).not.toContain(authorization.slice(7));
    expect(JSON.parse(body)).toEqual({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail,
    });
  });

  test.each([
    ['Bearer suspended', 403, 'Forbidden', 'account acme is suspended'],
    ['Bearer stranger', 403, 'Forbidden', 'carol is not a member of organization acme'],
    ['Bearer gone', 404, 'Not Found', 'account acme does not exist'],
  ])(
    'an authorization refusal (%s) is a %i problem without a challenge',
    async (authorization, code, title, detail) => {
      const response = await call(PATH, authorization);
      expect(response.status).toBe(code);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(response.headers.get('www-authenticate')).toBeNull();
      expect(await response.json()).toEqual({ type: 'about:blank', title, status: code, detail });
    },
  );

  test('an identity outage is a 502 problem that echoes nothing upstream', async () => {
    const response = await call(PATH, 'Bearer broken');
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const body = await response.text();
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('kube.internal');
    expect(JSON.parse(body)).toEqual({
      type: 'about:blank',
      title: 'Bad Gateway',
      status: 502,
      detail: 'the identity provider or cluster is unavailable',
    });
  });

  test('refusals are still audited as request.denied', async () => {
    log.mockClear();
    await call(PATH, 'Bearer suspended');
    expect(audited()).toContainEqual(
      expect.objectContaining({
        event: 'request.denied',
        path: '/v1/vars',
        status: 403,
        reason: 'account acme is suspended',
      }),
    );
  });
});

describe('Kubernetes proxy refusals keep the Status shape', () => {
  const PATH = '/api/v1/namespaces/di-tenant-acme/pods';

  test.each([
    [undefined, 401, 'Unauthorized', 'a bearer token is required'],
    [`Bearer ${SECRET}`, 401, 'Unauthorized', 'the access token is invalid or has expired'],
    ['Bearer suspended', 403, 'Forbidden', 'account acme is suspended'],
    ['Bearer gone', 404, 'Forbidden', 'account acme does not exist'],
  ])('%s gets a %i Status', async (authorization, code, reason, message) => {
    const response = await call(PATH, authorization);
    expect(response.status).toBe(code);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(await response.json()).toEqual({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Failure',
      message,
      reason,
      code,
    });
  });

  test('an identity outage is a 502 Status', async () => {
    const response = await call(PATH, 'Bearer broken');
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toMatchObject({
      kind: 'Status',
      reason: 'ServiceUnavailable',
      message: 'the identity provider or cluster is unavailable',
    });
  });

  test('the controller endpoints under /-/ keep the Status shape', async () => {
    const response = await call('/-/whoami');
    expect(response.status).toBe(401);
    expect((await response.json()).kind).toBe('Status');
  });
});

describe('the whoami listener', () => {
  const whoami = (authorization?: string) =>
    controller.handleWhoami(
      new Request('http://controller.test/v1/auth/whoami', {
        headers: authorization ? { authorization } : {},
      }),
    );

  test('challenges a missing credential and flags a rejected one', async () => {
    const missing = await whoami();
    expect(missing.status).toBe(401);
    expect(missing.headers.get('content-type')).toBe('application/problem+json');
    expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="di-framework-tenant"');
    const rejected = await whoami('Bearer dik_expired');
    expect(rejected.headers.get('www-authenticate')).toBe(
      'Bearer realm="di-framework-tenant", error="invalid_token"',
    );
    expect(await rejected.json()).toMatchObject({ status: 401, detail: 'API key has expired' });
  });

  test('a 404 refusal gets its own title', async () => {
    const response = await whoami('Bearer gone');
    expect(await response.json()).toMatchObject({ status: 404, title: 'Not Found' });
  });
});
