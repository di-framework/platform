import { describe, expect, test } from 'bun:test';
import { allowed, tenantNamespaces } from '../src/controller.ts';

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
