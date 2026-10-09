import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { OPERATIONS } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { Controller, configFromEnv } from '../src/controller.ts';
import type { Principal } from '../src/identity.ts';
import { KubeClient } from '../src/kube.ts';
import { auth } from '../src/v1/auth.ts';
import { MODULES, type V1Context, type V1Handler } from '../src/v1/index.ts';
import { json, serve } from './support/servers.ts';

test('every contract operation belongs to exactly one resource module', () => {
  const owned = Object.values(MODULES).flatMap((module) => Object.keys(module));
  expect(owned.sort()).toEqual([...OPERATIONS].sort());
  expect(Object.keys(MODULES).sort()).toEqual(['auth', 'config', 'deploy', 'logs', 'services']);
});

test('the auth stubs answer 501 when reached', async () => {
  for (const [name, handler] of Object.entries(auth)) {
    const response = await (handler as V1Handler)(
      {},
      { transport: 'http', request: {} },
      {} as V1Context,
    );
    expect(response.status).toBe(501);
    expect(((await response.json()) as { detail: string }).detail).toContain(name);
  }
});

describe('resource modules over real HTTP', () => {
  const api = serve((request) => {
    if (request.pathname.endsWith('/serviceaccounts/di-user-alice/token'))
      return json({
        status: {
          token: 'sa-alice',
          expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    return json({ seen: request.headers.get('authorization') });
  });
  const alice: Principal = {
    user: 'alice',
    account: 'acme',
    role: 'developer',
    via: 'identity',
    credentialId: 's',
  };
  const kube = new KubeClient({ server: api.url, token: 'admin' }, 'wasmcloud');
  const controller = new Controller(
    configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
    kube,
    { issuer: 'https://issuer.test' } as never,
    { resolve: async () => alice, forget: () => {} } as never,
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

  test.each([
    ['config', 'secrets', 'GET', '/v1/secrets?env=prod'],
    ['logs', 'logs', 'GET', '/v1/services/web/logs?env=prod'],
    ['deploy', 'deployments', 'GET', '/v1/deployments?env=prod'],
    ['services', 'proxy', 'POST', '/v1/services/web/proxy'],
  ] as const)(
    'the %s module serves %s, with the caller as context',
    async (group, operation, method, path) => {
      const module = MODULES[group] as Record<string, V1Handler>;
      const stub = module[operation] as V1Handler;
      const before = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? '{"env":"prod"}' : undefined,
      });
      expect(before.status).toBe(501);

      module[operation] = async (_command, _call, context) => {
        const upstream = await context
          .asUser()
          .fetch('GET', '/api/v1/namespaces/di-tenant-acme/pods');
        return Response.json({
          tenant: context.tenant,
          user: context.principal.user,
          upstream: await upstream.json(),
        });
      };
      try {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'POST' ? '{"env":"prod"}' : undefined,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          tenant: 'acme',
          user: 'alice',
          upstream: { seen: 'Bearer sa-alice' },
        });
      } finally {
        module[operation] = stub;
      }
    },
  );
});
