import { describe, expect, test } from 'bun:test';
import {
  allowed,
  Controller,
  canonicalPath,
  configFromEnv,
  tenantNamespaces,
} from '../src/controller.ts';
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

  describe('decides on the canonical path (#116)', () => {
    test.each([
      ['/api/v1/namespaces/di-tenant-acme/secrets', '/api/v1/namespaces/di-tenant-acme/secrets'],
      ['/api/v1/namespaces/di-tenant-acme/%73ecrets', '/api/v1/namespaces/di-tenant-acme/secrets'],
      [
        '/api/v1/namespaces/di-tenant-acme/%73%45crets',
        '/api/v1/namespaces/di-tenant-acme/sEcrets',
      ],
      ['/api/v1/namespaces/%64i-tenant-acme/pods', '/api/v1/namespaces/di-tenant-acme/pods'],
      [
        '/api/v1/namespaces/di-tenant-acme/pods/web%2D1',
        '/api/v1/namespaces/di-tenant-acme/pods/web-1',
      ],
      ['/api/v1/namespaces/x/pods/web:8080/proxy', '/api/v1/namespaces/x/pods/web:8080/proxy'],
      ['/api/v1/namespaces/x/pods/web%3A8080/proxy', '/api/v1/namespaces/x/pods/web:8080/proxy'],
      ['/api/v1/namespaces/x/configmaps/a%20b', '/api/v1/namespaces/x/configmaps/a%20b'],
      ['/apis/', '/apis/'],
      ['/', '/'],
    ])('canonicalises %s', (raw, canonical) => {
      expect(canonicalPath(raw)).toBe(canonical);
      // Idempotent: the forwarded path canonicalises to itself.
      expect(canonicalPath(canonical)).toBe(canonical);
    });
    test.each([
      'api/v1/namespaces/di-tenant-acme/pods',
      '//api/v1/namespaces/di-tenant-acme/pods',
      '/api/v1/namespaces/di-tenant-acme//secrets',
      '/api/v1/namespaces/di-tenant-acme/secrets%2Fname',
      '/api/v1/namespaces/di-tenant-acme/secrets%2fname',
      '/api/v1/namespaces/di-tenant-acme%2F..%2Fwasmcloud/secrets',
      '/api/v1/namespaces/di-tenant-acme/%2e%2e/%2E%2e/wasmcloud/secrets',
      '/api/v1/namespaces/di-tenant-acme/../wasmcloud/secrets',
      '/api/v1/namespaces/di-tenant-acme/./secrets',
      '/api/v1/namespaces/di-tenant-acme/%2e/secrets',
      '/api/v1/namespaces/di-tenant-acme/%2573ecrets',
      '/api/v1/namespaces/di-tenant-acme/secrets%252Fname',
      '/api/v1/namespaces/di-tenant-acme/secrets%5Cname',
      '/api/v1/namespaces/di-tenant-acme/secrets%00',
      '/api/v1/namespaces/di-tenant-acme/%zz',
      '/api/v1/namespaces/di-tenant-acme/%',
      '/api/v1/namespaces/di-tenant-acme/%C3',
    ])('refuses the ambiguous path %s', (raw) => {
      expect(canonicalPath(raw)).toBeUndefined();
      expect(allowed('GET', raw, t)).toBe(false);
    });
    test.each([
      ['GET', '/api/v1/namespaces/di-tenant-acme/%73ecrets'],
      ['GET', '/api/v1/namespaces/%64i-tenant-acme/%73ecrets/db'],
      ['GET', '/%61pi/v1/namespaces/di-runtime-acme/pods'],
      ['GET', '/%61pis'],
      ['POST', '/apis/authentication.k8s.io/v1/%73elfsubjectreviews'],
    ])('allows the encoded spelling %s %s', (method, path) => {
      expect(allowed(method, path, t)).toBe(true);
    });
    test.each([
      ['GET', '/api/v1/namespaces/%77asmcloud/secrets'],
      ['GET', '/api/v1/namespaces/di-tenant-acme%2Dother/secrets'],
      ['GET', '/api/v1/%73ecrets'],
      ['GET', '/api/v1/namespaces/di-tenant-%41CME/secrets'],
      ['POST', '/apis/authorization.k8s.io/v1/%73ubjectaccessreviews'],
    ])('refuses the encoded spelling %s %s', (method, path) => {
      expect(allowed(method, path, t)).toBe(false);
    });
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
  const controller = new Controller(
    { ...configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }), cliClientId: 'tenant-cli' },
    {} as never,
    { issuer: 'https://issuer.test' } as never,
    {
      resolve: async (authorization: string | null) => {
        if (authorization !== 'Bearer ok') throw new AuthError(401, 'a bearer token is required');
        return principal;
      },
      forget: (user: string) => {
        forgotten.push(user);
      },
    } as never,
    {} as never,
  );
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
