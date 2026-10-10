import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Controller, configFromEnv } from '../src/controller.ts';
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
      new Request('https://registry.acme.localhost/v2/'),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Basic realm="di-framework-tenant-registry"',
    );
    expect(hosts.requests.at(-1)!.headers.get('authorization')).toBeNull();
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
    const response = await down.handleRegistry(new Request('https://registry.acme.localhost/v2/'));
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
  });
});
