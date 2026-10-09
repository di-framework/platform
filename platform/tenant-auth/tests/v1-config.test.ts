import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Controller, configFromEnv } from '../src/controller.ts';
import { AuthError, type Principal } from '../src/identity.ts';
import { KubeClient } from '../src/kube.ts';
import { secretEnvName, secretObjectName, varsConfigMapName } from '../src/v1/config.ts';
import { json, serve } from './support/servers.ts';

/**
 * `/v1/secrets` and `/v1/vars` served by the controller over real HTTP, in front of a fake API
 * server that keeps Secrets and ConfigMaps in memory and records every request.
 */
type Stored = {
  metadata: {
    name: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
};

const NS = '/api/v1/namespaces/di-tenant-acme';
const store = new Map<string, Stored>();
let version = 0;
/** When set, the next PUT answers this status instead of writing. */
let failPut: number | undefined;
/** When set, every GET of a named object answers 500. */
let failGet = false;
let corruptAnnotation = false;

const api = serve((request) => {
  if (request.pathname.endsWith('/token')) {
    const user = /di-user-([^/]+)\/token$/.exec(request.pathname)?.[1];
    return json({
      status: {
        token: `sa-${user}`,
        expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
  }
  const match = /^\/api\/v1\/namespaces\/di-tenant-acme\/(secrets|configmaps)(?:\/([^/]+))?$/.exec(
    request.pathname,
  );
  if (!match) return json({ message: 'unexpected' }, 500);
  const [, kind, name] = match;
  const key = `${kind}/${name}`;
  const notFound = () => json({ message: `${kind} "${name}" not found` }, 404);
  switch (request.method) {
    case 'GET': {
      if (name) {
        if (failGet) return json({ message: 'boom' }, 500);
        const found = store.get(key);
        if (!found) return notFound();
        if (corruptAnnotation && found.metadata.annotations)
          return json({
            ...found,
            metadata: {
              ...found.metadata,
              annotations: { 'platform.di-framework.dev/updated-at': '{' },
            },
          });
        return json(found);
      }
      const selector = new URL(`http://x${request.path}`).searchParams.get('labelSelector') ?? '';
      const wanted = selector.split(',').map((pair) => pair.split('='));
      const items = [...store.entries()]
        .filter(([k]) => k.startsWith(`${kind}/`))
        .map(([, v]) => v)
        .filter((v) => wanted.every(([l, value]) => v.metadata.labels?.[l as string] === value));
      return json({ items });
    }
    case 'POST': {
      const body = JSON.parse(request.body) as Stored;
      const created = `${kind}/${body.metadata.name}`;
      if (store.has(created)) return json({ message: 'already exists' }, 409);
      store.set(created, stamp(body));
      return json(store.get(created), 201);
    }
    case 'PUT': {
      if (failPut) {
        const status = failPut;
        failPut = undefined;
        return json({ message: 'the object has been modified' }, status);
      }
      if (!store.has(key)) return notFound();
      store.set(key, stamp(JSON.parse(request.body) as Stored));
      return json(store.get(key));
    }
    case 'DELETE':
      if (!store.delete(key)) return notFound();
      return json({});
  }
  return json({}, 405);
});

/** Applies `stringData` like the API server does, and bumps the resource version. */
function stamp(object: Stored): Stored {
  const data = { ...object.data };
  for (const [k, v] of Object.entries(object.stringData ?? {})) data[k] = btoa(v);
  const { stringData: _, ...rest } = object;
  return {
    ...rest,
    metadata: { ...object.metadata, resourceVersion: String(++version) },
    ...(object.stringData || object.data ? { data } : {}),
  };
}

const principal = (user: string, role: 'developer' | 'viewer'): Principal => ({
  user,
  account: 'acme',
  role,
  via: 'identity',
  credentialId: 's',
});
const kube = new KubeClient({ server: api.url, token: 'admin' }, 'wasmcloud');
const controller = new Controller(
  configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
  kube,
  { issuer: 'https://issuer.test' } as never,
  {
    resolve: async (authorization: string | null) => {
      if (authorization === 'Bearer alice') return principal('alice', 'developer');
      if (authorization === 'Bearer bob') return principal('bob', 'viewer');
      throw new AuthError(401, 'a bearer token is required');
    },
    forget: () => {},
  } as never,
  { kube, namespace: 'di-runtime-acme', tenant: 'acme' },
);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => controller.handle(r) });
const base = `http://127.0.0.1:${server.port}`;

const call = (method: string, path: string, value?: string, bearer = 'alice') =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(value !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: value === undefined ? undefined : JSON.stringify({ value }),
  });
const body = async (response: Response) => (await response.json()) as Record<string, unknown>;
const kubeCalls = () => api.requests.filter((r) => !r.pathname.endsWith('/token'));

let log: ReturnType<typeof spyOn>;
beforeAll(() => {
  log = spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  log.mockRestore();
  server.stop(true);
  api.stop();
});
beforeEach(() => {
  store.clear();
  api.requests.length = 0;
  failPut = undefined;
  failGet = false;
  corruptAnnotation = false;
});

describe('storage names', () => {
  test('follow the README contract', () => {
    expect(varsConfigMapName('prod')).toBe('di-vars-prod');
    expect(secretObjectName('db-password', 'staging')).toBe('db-password.staging');
    expect(secretEnvName('db-password')).toBe('DB_PASSWORD');
  });
});

describe('secrets', () => {
  test('set, list, update and unset as the calling user, never returning values', async () => {
    expect((await call('PUT', '/v1/secrets/db-password?env=prod', 's3cret')).status).toBe(204);
    const stored = store.get('secrets/db-password.prod');
    expect(stored?.metadata.labels).toEqual({
      'platform.di-framework.dev/config': 'secret',
      'platform.di-framework.dev/env': 'prod',
      'platform.di-framework.dev/secret': 'db-password',
    });
    expect(stored?.data).toEqual({ DB_PASSWORD: btoa('s3cret') });
    // Another environment is a separate Secret.
    expect((await call('PUT', '/v1/secrets/api-key?env=staging', 'k')).status).toBe(204);

    const list = await call('GET', '/v1/secrets?env=prod');
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain(btoa('s3cret'));
    const parsed = JSON.parse(text) as { env: string; items: Record<string, unknown>[] };
    expect(parsed.env).toBe('prod');
    expect(parsed.items).toHaveLength(1);
    expect(Object.keys(parsed.items[0] as object).sort()).toEqual(['name', 'updatedAt']);
    expect(parsed.items[0]?.name).toBe('db-password');

    // Setting again replaces it.
    expect((await call('PUT', '/v1/secrets/db-password?env=prod', 'again')).status).toBe(204);
    expect(store.get('secrets/db-password.prod')?.data).toEqual({ DB_PASSWORD: btoa('again') });
    expect((await call('PATCH', '/v1/secrets/db-password?env=prod', 'newer')).status).toBe(204);
    expect(store.get('secrets/db-password.prod')?.data).toEqual({ DB_PASSWORD: btoa('newer') });
    expect((await call('DELETE', '/v1/secrets/db-password?env=prod')).status).toBe(204);
    expect(store.has('secrets/db-password.prod')).toBe(false);

    const calls = kubeCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const request of calls) {
      expect(request.headers.get('authorization')).toBe('Bearer sa-alice');
      expect(request.pathname.startsWith(`${NS}/secrets`)).toBe(true);
    }
    expect(calls.map((r) => r.method)).toContain('POST');
    expect(calls.map((r) => r.method)).toContain('DELETE');
  });

  test('lists sorted, falling back to the object name and creation time', async () => {
    store.set('secrets/b.prod', {
      metadata: {
        name: 'b.prod',
        labels: {
          'platform.di-framework.dev/config': 'secret',
          'platform.di-framework.dev/env': 'prod',
        },
        creationTimestamp: '2026-01-01T00:00:00Z',
      } as never,
      data: { B: 'eA==' },
    });
    store.set('secrets/a.prod', {
      metadata: {
        name: 'a.prod',
        labels: {
          'platform.di-framework.dev/config': 'secret',
          'platform.di-framework.dev/env': 'prod',
          'platform.di-framework.dev/secret': 'a',
        },
      },
    });
    expect(await body(await call('GET', '/v1/secrets?env=prod'))).toEqual({
      env: 'prod',
      items: [
        { name: 'a', updatedAt: '' },
        { name: 'b.prod', updatedAt: '2026-01-01T00:00:00Z' },
      ],
    });
  });

  test.each([
    ['PUT', 'di-binding-kv-creds', 'v'],
    ['PATCH', 'di-bs-postgres', 'v'],
    ['DELETE', 'di-binding-x', undefined],
  ])('refuses the managed name in %s %s', async (method, name, value) => {
    const response = await call(method, `/v1/secrets/${name}?env=prod`, value);
    expect(response.status).toBe(403);
    expect((await body(response)).detail).toBe(`${name} is a platform-managed secret name`);
    expect(kubeCalls()).toHaveLength(0);
  });

  test('refuses a name that is not a DNS label', async () => {
    const response = await call('PUT', '/v1/secrets/DB_PASSWORD?env=prod', 'v');
    expect(response.status).toBe(400);
    expect(kubeCalls()).toHaveLength(0);
  });

  test('update and unset of a missing secret are 404', async () => {
    for (const [method, value] of [
      ['PATCH', 'v'],
      ['DELETE', undefined],
    ] as const) {
      const response = await call(method, '/v1/secrets/nope?env=prod', value);
      expect(response.status).toBe(404);
      expect((await body(response)).detail).toBe('secret nope does not exist in prod');
    }
  });

  test('a Secret without the tenant label is not touched', async () => {
    store.set('secrets/foreign.prod', { metadata: { name: 'foreign.prod' } });
    for (const [method, value] of [
      ['PUT', 'v'],
      ['PATCH', 'v'],
      ['DELETE', undefined],
    ] as const) {
      const response = await call(method, '/v1/secrets/foreign?env=prod', value);
      expect(response.status).toBe(409);
    }
    expect(store.get('secrets/foreign.prod')).toEqual({ metadata: { name: 'foreign.prod' } });
  });

  test('a concurrent change is a 409 the caller can retry', async () => {
    await call('PUT', '/v1/secrets/db?env=prod', 'one');
    failPut = 409;
    const response = await call('PUT', '/v1/secrets/db?env=prod', 'two');
    expect(response.status).toBe(409);
    expect((await body(response)).detail).toBe('secret db changed concurrently; retry');
  });

  test('a server failure on write is a generic 502', async () => {
    await call('PUT', '/v1/secrets/db?env=prod', 'one');
    failPut = 500;
    const response = await call('PATCH', '/v1/secrets/db?env=prod', 'two');
    expect(response.status).toBe(502);
  });

  test('a server failure on read is a generic 502', async () => {
    failGet = true;
    expect((await call('PATCH', '/v1/secrets/x?env=prod', 'v')).status).toBe(502);
  });

  test.each([
    ['GET', '/v1/secrets?env=prod', undefined, 'secrets'],
    ['PUT', '/v1/secrets/db?env=prod', 'v', 'setSecret'],
    ['PATCH', '/v1/secrets/db?env=prod', 'v', 'updateSecret'],
    ['DELETE', '/v1/secrets/db?env=prod', undefined, 'unsetSecret'],
  ])('a viewer is refused %s %s', async (method, path, value, operation) => {
    const response = await call(method, path, value, 'bob');
    expect(response.status).toBe(403);
    expect((await body(response)).detail).toBe(`a viewer may not call ${operation}`);
    expect(kubeCalls()).toHaveLength(0);
  });
});

describe('vars', () => {
  test('set, list, update and unset as the calling user', async () => {
    expect((await call('PUT', '/v1/vars/LEVEL?env=prod', 'debug')).status).toBe(204);
    const map = store.get(`configmaps/${varsConfigMapName('prod')}`);
    expect(map?.metadata.labels).toEqual({
      'platform.di-framework.dev/config': 'vars',
      'platform.di-framework.dev/env': 'prod',
    });
    expect(map?.data).toEqual({ LEVEL: 'debug' });
    expect((await call('PUT', '/v1/vars/A_FIRST?env=prod', 'x')).status).toBe(204);
    expect((await call('PATCH', '/v1/vars/LEVEL?env=prod', 'info')).status).toBe(204);

    const list = await body(await call('GET', '/v1/vars?env=prod'));
    expect(list.env).toBe('prod');
    const items = list.items as { name: string; value: string; updatedAt: string }[];
    expect(items.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'A_FIRST', value: 'x' },
      { name: 'LEVEL', value: 'info' },
    ]);
    for (const item of items) expect(Number.isNaN(Date.parse(item.updatedAt))).toBe(false);

    expect((await call('DELETE', '/v1/vars/LEVEL?env=prod')).status).toBe(204);
    expect(store.get('configmaps/di-vars-prod')?.data).toEqual({ A_FIRST: 'x' });
    expect(
      Object.keys(
        JSON.parse(
          store.get('configmaps/di-vars-prod')?.metadata.annotations?.[
            'platform.di-framework.dev/updated-at'
          ] ?? '',
        ),
      ),
    ).toEqual(['A_FIRST']);

    // The staging environment is empty and separate.
    expect(await body(await call('GET', '/v1/vars?env=staging'))).toEqual({
      env: 'staging',
      items: [],
    });

    for (const request of kubeCalls()) {
      expect(request.headers.get('authorization')).toBe('Bearer sa-alice');
      expect(request.pathname.startsWith(`${NS}/configmaps`)).toBe(true);
    }
  });

  test('a viewer can list vars but not write them', async () => {
    await call('PUT', '/v1/vars/LEVEL?env=prod', 'debug');
    api.requests.length = 0;
    const list = await call('GET', '/v1/vars?env=prod', undefined, 'bob');
    expect(list.status).toBe(200);
    expect(((await body(list)).items as unknown[]).length).toBe(1);
    expect(kubeCalls().map((r) => r.headers.get('authorization'))).toEqual(['Bearer sa-bob']);
    for (const [method, value, operation] of [
      ['PUT', 'v', 'setVar'],
      ['PATCH', 'v', 'updateVar'],
      ['DELETE', undefined, 'unsetVar'],
    ] as const) {
      const response = await call(method, '/v1/vars/LEVEL?env=prod', value, 'bob');
      expect(response.status).toBe(403);
      expect((await body(response)).detail).toBe(`a viewer may not call ${operation}`);
    }
    expect(store.get('configmaps/di-vars-prod')?.data).toEqual({ LEVEL: 'debug' });
  });

  test('update and unset of a missing var are 404, with or without the ConfigMap', async () => {
    for (const [method, value] of [
      ['PATCH', 'v'],
      ['DELETE', undefined],
    ] as const) {
      const response = await call(method, '/v1/vars/NOPE?env=prod', value);
      expect(response.status).toBe(404);
      expect((await body(response)).detail).toBe('var NOPE does not exist in prod');
    }
    await call('PUT', '/v1/vars/OTHER?env=prod', 'v');
    for (const [method, value] of [
      ['PATCH', 'v'],
      ['DELETE', undefined],
    ] as const)
      expect((await call(method, '/v1/vars/NOPE?env=prod', value)).status).toBe(404);
  });

  test('refuses a name that is not an environment variable name', async () => {
    const response = await call('PUT', '/v1/vars/not-a-var?env=prod', 'v');
    expect(response.status).toBe(400);
    expect(kubeCalls()).toHaveLength(0);
  });

  test('an unreadable timestamp annotation falls back to the creation time', async () => {
    store.set('configmaps/di-vars-prod', {
      metadata: {
        name: 'di-vars-prod',
        creationTimestamp: '2026-02-02T00:00:00Z',
        annotations: {},
      } as never,
      data: { A: '1' },
    });
    corruptAnnotation = true;
    expect(await body(await call('GET', '/v1/vars?env=prod'))).toEqual({
      env: 'prod',
      items: [{ name: 'A', value: '1', updatedAt: '2026-02-02T00:00:00Z' }],
    });
  });

  test('a concurrent change is a 409 the caller can retry', async () => {
    await call('PUT', '/v1/vars/A?env=prod', '1');
    failPut = 409;
    const response = await call('PUT', '/v1/vars/A?env=prod', '2');
    expect(response.status).toBe(409);
    expect((await body(response)).detail).toBe('the prod vars changed concurrently; retry');
  });
});
