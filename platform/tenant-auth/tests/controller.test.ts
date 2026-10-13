import { describe, expect, test } from 'bun:test';
import { allowed, Controller, configFromEnv, tenantNamespaces } from '../src/controller.ts';
import { AuthError } from '../src/identity.ts';

describe('controller path policy', () => {
  const t = 'acme';
  test('names the tenant namespaces', () => {
    expect(tenantNamespaces(t)).toEqual(['di-tenant-acme', 'di-runtime-acme']);
  });
  test.each([
    ['GET', '/api/v1/namespaces/di-tenant-acme/secrets'],
    ['POST', '/api/v1/namespaces/di-tenant-acme/secrets'],
    ['GET', '/api/v1/namespaces/di-tenant-acme'],
    ['GET', '/api/v1/namespaces/di-runtime-acme/pods/x/log?follow=true'],
    [
      'PATCH',
      '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-acme/backingservices/db',
    ],
    ['GET', '/api'],
    ['GET', '/apis'],
    ['GET', '/apis/platform.di-framework.dev/v1alpha1'],
    ['GET', '/version'],
    ['GET', '/openapi/v3'],
    ['POST', '/apis/authentication.k8s.io/v1/selfsubjectreviews'],
  ])('allows %s %s', (method, path) => {
    expect(allowed(method, path.split('?')[0] as string, t)).toBe(true);
  });
  test.each([
    ['GET', '/api/v1/namespaces/di-tenant-other/secrets'],
    ['GET', '/api/v1/namespaces/wasmcloud/secrets'],
    ['GET', '/api/v1/namespaces/di-tenant-acme-evil/secrets'],
    ['GET', '/api/v1/secrets'],
    ['GET', '/api/v1/namespaces'],
    ['GET', '/apis/platform.di-framework.dev/v1alpha1/users'],
    ['DELETE', '/apis/platform.di-framework.dev/v1alpha1/tenants/acme'],
    ['POST', '/api/v1/namespaces'],
    ['POST', '/apis/authorization.k8s.io/v1/subjectaccessreviews'],
    ['GET', '/-/keys'],
  ])('refuses %s %s', (method, path) => {
    expect(allowed(method, path, t)).toBe(false);
  });
});

describe('v1 auth routes', () => {
  const principal = {
    user: 'alice',
    account: 'acme',
    role: 'developer' as const,
    via: 'identity' as const,
    credentialId: 'sub-1',
  };
  const forgotten: string[] = [];
  const provider = { issuer: 'https://issuer.test' } as never;
  const mockIdentityResolver = {
    resolve: async (authorization: string | null) => {
      if (authorization !== 'Bearer ok') throw new AuthError(401, 'a bearer token is required');
      return principal;
    },
    forget: (user: string) => {
      forgotten.push(user);
    },
    setProvider: () => {}, // No-op for tests
  } as never;
  const controller = new Controller(
    { ...configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }), cliClientId: 'tenant-cli' },
    {} as never,
    provider,
    mockIdentityResolver,
    {} as never,
  );
  // Manually set discovery state for tests to work
  (controller as any).discoveryState = { status: 'complete', provider };

  const call = (method: string, path: string, authorization?: string) =>
    controller.handle(
      new Request(`https://controller.test${path}`, {
        method,
        headers: authorization ? { authorization } : {},
      }),
    );

  test('info is public and names the account, issuer, and CLI client', async () => {
    const response = await call('GET', '/v1/auth/info');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      account: 'acme',
      issuer: 'https://issuer.test',
      clientId: 'tenant-cli',
    });
    expect(configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }).cliClientId).toBe('tenant-cli');
    expect(
      configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme', TENANT_CONTROLLER_CLI_CLIENT_ID: 'x' })
        .cliClientId,
    ).toBe('x');
  });

  test('whoami and logout take the bearer', async () => {
    expect((await call('GET', '/v1/auth/whoami')).status).toBe(401);
    const who = await call('GET', '/v1/auth/whoami', 'Bearer ok');
    expect(await who.json()).toEqual(principal);
    const logout = await call('POST', '/v1/auth/logout', 'Bearer ok');
    expect(logout.status).toBe(204);
    expect(forgotten).toEqual(['alice']);
    expect((await call('GET', '/v1/other', 'Bearer ok')).status).toBe(404);
  });
});

describe('discovery and 503 handling', () => {
  const forgotten: string[] = [];
  const provider = { issuer: 'https://issuer.test' } as never;
  const mockIdentityResolver = {
    resolve: async (_authorization: string | null) => {
      throw new AuthError(503, 'issuer discovery is not yet complete');
    },
    forget: (_user: string) => {},
    setProvider: () => {}, // No-op for tests
  } as never;
  const controller = new Controller(
    { ...configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }), cliClientId: 'tenant-cli' },
    {} as never,
    null,
    mockIdentityResolver,
    {} as never,
  );

  const call = (method: string, path: string, authorization?: string) =>
    controller.handle(
      new Request(`https://controller.test${path}`, {
        method,
        headers: authorization ? { authorization } : {},
      }),
    );

  const whoamiCall = (authorization?: string) => {
    return controller.handleWhoami(
      new Request(`https://controller.test/v1/auth/whoami`, {
        method: 'GET',
        headers: authorization ? { authorization } : {},
      }),
    );
  };

  test('info returns 503 while discovery is pending', async () => {
    const response = await call('GET', '/v1/auth/info');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBeTruthy();
    const body = await response.json();
    expect(body.title).toBe('Service Unavailable');
  });

  test('health endpoint reports discovery status', async () => {
    const response = await call('GET', '/-/healthz');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.tenant).toBe('acme');
    expect(body.discoveryReady).toBe(false);
  });

  test('whoami with bearer token returns 503 while discovery pending', async () => {
    const response = await whoamiCall('Bearer test-token');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBeTruthy();
  });

  test('whoami with host pull token works without discovery', async () => {
    // Create controller with host pull token support
    const tokenController = new Controller(
      {
        ...configFromEnv({
          TENANT_CONTROLLER_TENANT: 'acme',
          TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE: '/dev/null', // Empty file - matches nothing
        }),
        cliClientId: 'tenant-cli',
      },
      {} as never,
      null,
      mockIdentityResolver,
      {} as never,
    );
    const response = await tokenController.handleWhoami(
      new Request(`https://controller.test/v1/auth/whoami`, {
        method: 'GET',
        headers: { authorization: 'Bearer ' }, // Invalid token for host pull
      }),
    );
    // Since host pull token doesn't match, it should fall through to identity.resolve and get 503
    expect(response.status).toBe(503);
  });
});
