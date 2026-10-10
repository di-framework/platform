import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Controller, configFromEnv, registryOrigin } from '../src/controller.ts';
import { AuthError, type Principal } from '../src/identity.ts';
import { KubeClient } from '../src/kube.ts';
import { json, serve } from './support/servers.ts';

describe('registryOrigin', () => {
  test('is undefined when no registry is configured', () => {
    expect(registryOrigin(undefined, 'acme')).toBeUndefined();
    expect(registryOrigin('', 'acme')).toBeUndefined();
    expect(configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }).registryUrl).toBeUndefined();
  });

  test.each([
    ['https://registry-{tenant}.example.test', 'https://registry-acme.example.test'],
    ['http://{tenant}.registry.local:5000/', 'http://acme.registry.local:5000'],
    ['https://registry.example.test', 'https://registry.example.test'],
  ])('resolves %s to the origin %s', (pattern, origin) => {
    expect(registryOrigin(pattern, 'acme')).toBe(origin);
    expect(
      configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme', TENANT_CONTROLLER_REGISTRY_URL: pattern })
        .registryUrl,
    ).toBe(origin);
  });

  test('refuses a value that is not a URL', () => {
    expect(() => registryOrigin('registry.example.test', 'acme')).toThrow(
      'TENANT_CONTROLLER_REGISTRY_URL is not a URL: registry.example.test',
    );
  });

  test.each([
    'ftp://registry.example.test',
    'https://registry.example.test/acme',
    'https://user:pass@registry.example.test',
    'https://registry.example.test?x=1',
    'https://registry.example.test#x',
  ])('refuses %s, which is not a bare http(s) origin', (pattern) => {
    expect(() => registryOrigin(pattern, 'acme')).toThrow('must be an http(s) origin');
  });
});

/** The registry operation over real HTTP against a controller with a configured registry. */
describe('GET /v1/deploy/registry', () => {
  const api = serve(() => json({}));
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
    configFromEnv({
      TENANT_CONTROLLER_TENANT: 'acme',
      TENANT_CONTROLLER_REGISTRY_URL: 'https://registry-{tenant}.example.test',
    }),
    kube,
    { issuer: 'https://issuer.test' } as never,
    {
      resolve: async (authorization: string | null) => {
        if (authorization === 'Bearer dev') return alice;
        if (authorization === 'Bearer viewer') return bob;
        if (authorization === 'Bearer stranger') return { ...alice, role: 'owner' } as never;
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
  const get = (bearer?: string) =>
    fetch(`${base}/v1/deploy/registry`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });

  test.each([
    ['developer', 'dev'],
    ['viewer', 'viewer'],
  ])('a %s gets the tenant registry and how to log in to it', async (_role, bearer) => {
    const response = await get(bearer);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      url: 'https://registry-acme.example.test',
      auth: 'basic-identity',
      username: 'token',
    });
    // The credential is the caller's own: no token or Secret value comes back, and the
    // operation never touches the cluster.
    expect(JSON.stringify(body)).not.toContain(bearer);
    expect(api.requests).toHaveLength(0);
  });

  test('a caller without a tenant role is refused', async () => {
    expect((await get('stranger')).status).toBe(403);
  });

  test('a caller without a credential is refused', async () => {
    expect((await get()).status).toBe(401);
  });
});
