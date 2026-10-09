import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { OPERATIONS } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { dispatch } from '@di-framework/tenant-cli/src/api/routes.ts';
import { Controller, configFromEnv } from '../src/controller.ts';
import type { Principal } from '../src/identity.ts';
import { AuthError } from '../src/identity.ts';
import { KubeClient, KubeError } from '../src/kube.ts';
import { auth } from '../src/v1/auth.ts';
import { MODULES, type V1Context, type V1Handler } from '../src/v1/index.ts';
import { POLICY, permits } from '../src/v1/policy.ts';
import { json, serve } from './support/servers.ts';

test('every contract operation belongs to exactly one resource module', () => {
  const owned = Object.values(MODULES).flatMap((module) => Object.keys(module));
  expect(owned.sort()).toEqual([...OPERATIONS].sort());
  expect(Object.keys(MODULES).sort()).toEqual(['auth', 'config', 'deploy', 'logs', 'services']);
});

test('every contract operation declares a role policy, and a viewer is read-only', () => {
  expect(Object.keys(POLICY).sort()).toEqual([...OPERATIONS].sort());
  for (const name of OPERATIONS) {
    expect(POLICY[name].length).toBeGreaterThan(0);
    expect(permits(name, 'developer')).toBe(true);
  }
  const viewer: string[] = OPERATIONS.filter((name) => permits(name, 'viewer')).sort();
  expect(viewer).toEqual(
    [
      'authInfo',
      'whoami',
      'logout',
      'previewDeploy',
      'registry',
      'logs',
      'deployments',
      'deploymentStats',
      'vars',
    ].sort(),
  );
});

test('an operation without a policy is denied to every role', () => {
  expect(permits('undeclared' as never, 'developer')).toBe(false);
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

test('outside serveV1 the original contract handler answers', async () => {
  const module = MODULES.deploy as Record<string, V1Handler>;
  const stub = module.deployments as V1Handler;
  let called = false;
  module.deployments = async () => {
    called = true;
    return Response.json({});
  };
  try {
    const response = await dispatch(new Request('http://controller/v1/deployments?env=prod'));
    expect(response?.status).toBe(501);
    expect(called).toBe(false);
  } finally {
    module.deployments = stub;
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
    ['an RBAC refusal', new KubeError(403, 'secrets is forbidden'), 403, 'Forbidden'],
    ['a missing object', new KubeError(404, 'secrets "x" not found'), 404, 'Not Found'],
    ['a conflict', new KubeError(409, 'already exists'), 409, 'Conflict'],
    ['the no-user refusal', new KubeError(401, 'no user to act as'), 401, 'Unauthorized'],
    ['an unusual 4xx', new KubeError(418, 'teapot'), 418, 'Client Error'],
    ['an upstream failure', new KubeError(503, 'etcd is down'), 502, 'Bad Gateway'],
    ['an identity error', new AuthError(403, 'not a member'), 403, 'Forbidden'],
  ] as const)(
    'maps %s raised in a handler to problem+json',
    async (_name, error, status, title) => {
      const module = MODULES.deploy as Record<string, V1Handler>;
      const stub = module.deployments as V1Handler;
      module.deployments = async () => {
        throw error;
      };
      try {
        const response = await fetch(`${base}/v1/deployments?env=prod`);
        expect(response.status).toBe(status);
        expect(response.headers.get('content-type')).toBe('application/problem+json');
        expect(await response.json()).toEqual({
          type: 'about:blank',
          title,
          status,
          detail: error.message,
        });
      } finally {
        module.deployments = stub;
      }
    },
  );

  test('leaves other handler errors to the controller', async () => {
    const module = MODULES.deploy as Record<string, V1Handler>;
    const stub = module.deployments as V1Handler;
    module.deployments = async () => {
      throw new Error('boom');
    };
    try {
      const response = await fetch(`${base}/v1/deployments?env=prod`);
      expect(response.status).toBe(502);
    } finally {
      module.deployments = stub;
    }
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
