import { describe, expect, test } from 'bun:test';
import { schemas } from '@di-framework/tenant-cli/src/api/schemas.ts';
import { validate } from '@di-framework/tenant-cli/src/api/validate.ts';
import { configFromEnv, registryOrigin } from '../src/controller.ts';
import { alice, bob, servedController } from './support/controller.ts';

describe('registryOrigin', () => {
  test('is undefined when no registry is configured', () => {
    expect(registryOrigin(undefined, 'acme')).toBeUndefined();
    expect(registryOrigin('', 'acme')).toBeUndefined();
    expect(configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }).registryUrl).toBeUndefined();
  });

  test.each([
    ['https://registry-{tenant}.example.test', 'https://registry-acme.example.test'],
    ['http://registry.{tenant}.svc:5000/', 'http://registry.acme.svc:5000'],
    ['http://registry.{tenant}.svc.cluster.local', 'http://registry.acme.svc.cluster.local'],
    ['http://127.0.0.1:5000', 'http://127.0.0.1:5000'],
    ['http://localhost:5000', 'http://localhost:5000'],
    ['http://[::1]:5000', 'http://[::1]:5000'],
    ['https://registry.example.test', 'https://registry.example.test'],
  ])('resolves %s to the origin %s', (pattern, origin) => {
    expect(registryOrigin(pattern, 'acme')).toBe(origin);
    expect(
      configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme', TENANT_CONTROLLER_REGISTRY_URL: pattern })
        .registryUrl,
    ).toBe(origin);
  });

  test('refuses a value that is not a URL without echoing it', () => {
    expect(() => registryOrigin('registry.example.test/secret', 'acme')).toThrow(
      'TENANT_CONTROLLER_REGISTRY_URL is not a URL',
    );
    expect(() => registryOrigin('registry.example.test/secret', 'acme')).not.toThrow('secret');
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

  test('refuses userinfo without echoing the password', () => {
    expect(() => registryOrigin('https://user:pass@registry.example.test', 'acme')).toThrow(
      'userinfo is not allowed',
    );
    expect(() => registryOrigin('https://user:pass@registry.example.test', 'acme')).not.toThrow(
      'pass@',
    );
  });

  test.each([
    'http://registry-{tenant}.example.com',
    'http://{tenant}.registry.local:5000/',
    'http://evil.svc.example.com',
    'http://.svc',
    'http://10.0.0.1:5000',
  ])('refuses plain http to %s, which may leave the cluster', (pattern) => {
    expect(() => registryOrigin(pattern, 'acme')).toThrow('must use https://');
  });
});

/** The registry operation over real HTTP against a controller with a configured registry. */
describe('GET /v1/deploy/registry', () => {
  const served = servedController({
    env: { TENANT_CONTROLLER_REGISTRY_URL: 'https://registry-{tenant}.example.test' },
    principals: {
      'tok-dev-7f3a': alice,
      'tok-viewer-9c1e': bob,
      roleless: { ...alice, role: undefined } as never,
    },
  });
  const get = (bearer?: string) =>
    fetch(`${served.base}/v1/deploy/registry`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });

  test.each([
    ['developer', 'tok-dev-7f3a'],
    ['viewer', 'tok-viewer-9c1e'],
  ])('a %s gets the tenant registry and how to log in to it', async (_role, bearer) => {
    served.log.mockClear();
    const response = await get(bearer);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      url: 'https://registry-acme.example.test',
      auth: 'basic-identity',
      username: 'token',
    });
    expect(() => validate(schemas.RegistryInfo, body)).not.toThrow();
    // The credential is the caller's own: no token or Secret value comes back or is logged, and
    // the operation never touches the cluster.
    expect(JSON.stringify(body)).not.toContain(bearer);
    for (const call of served.log.mock.calls) expect(call.join(' ')).not.toContain(bearer);
    expect(served.api.requests).toHaveLength(0);
  });

  test('a caller without a tenant role is refused', async () => {
    const response = await get('roleless');
    expect(response.status).toBe(403);
    expect(((await response.json()) as { detail?: string }).detail).toBe(
      'a caller without a tenant role may not call registry',
    );
  });

  test('a caller without a credential is refused', async () => {
    expect((await get()).status).toBe(401);
  });
});
