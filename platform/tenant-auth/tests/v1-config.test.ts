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
/** When set, runs once after the next GET of this key is answered: a concurrent writer. */
let raceAfterGet: { key: string; run: () => void } | undefined;

/** Answers 409 when `expected` is set and differs from the stored version, like the API server. */
const stale = (key: string, expected: string | undefined) =>
  expected !== undefined && store.get(key)?.metadata.resourceVersion !== expected
    ? json({ message: 'the object has been modified; please apply your changes' }, 409)
    : undefined;

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
  // RBAC per token, like the platform's Roles (#112): a member's `sa-*` token may only create,
  // update and delete Secrets; the controller's own token (`admin`) may read them.
  if (
    kind === 'secrets' &&
    request.headers.get('authorization')?.startsWith('Bearer sa-') &&
    !['POST', 'PUT', 'DELETE'].includes(request.method)
  )
    return json({ message: `secrets is forbidden: cannot ${request.method}` }, 403);
  const notFound = () => json({ message: `${kind} "${name}" not found` }, 404);
  switch (request.method) {
    case 'GET': {
      if (name) {
        if (failGet) return json({ message: 'boom' }, 500);
        const found = store.get(key);
        if (raceAfterGet?.key === key) {
          const race = raceAfterGet;
          raceAfterGet = undefined;
          queueMicrotask(race.run);
        }
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
      const replacement = JSON.parse(request.body) as Stored;
      const conflict = stale(key, replacement.metadata.resourceVersion);
      if (conflict) return conflict;
      store.set(key, stamp(replacement));
      return json(store.get(key));
    }
    case 'DELETE': {
      if (!store.has(key)) return notFound();
      const options = request.body
        ? (JSON.parse(request.body) as { preconditions?: { resourceVersion?: string } })
        : {};
      const conflict = stale(key, options.preconditions?.resourceVersion);
      if (conflict) return conflict;
      store.delete(key);
      return json({});
    }
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
  raceAfterGet = undefined;
});

/** Simulates another writer bumping the stored object's resource version. */
const bump = (key: string) => () => {
  const found = store.get(key);
  if (found) store.set(key, stamp({ ...found }));
};

describe('storage names', () => {
  test('follow the README contract', () => {
    expect(varsConfigMapName('prod')).toBe('di-vars-prod');
    expect(secretObjectName('db-password', 'staging')).toBe('db-password.staging');
    expect(secretEnvName('db-password')).toBe('DB_PASSWORD');
  });
});

describe('write-only Secrets for developers (#112)', () => {
  const direct = (method: string, path: string, token: string, body?: string) =>
    fetch(`${api.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });

  test('a developer token cannot get, list, watch or patch Secrets; the controller can read', async () => {
    store.set('secrets/db.prod', stamp({ metadata: { name: 'db.prod' }, data: { DB: 'eA==' } }));
    for (const [method, path] of [
      ['GET', `${NS}/secrets/db.prod`],
      ['GET', `${NS}/secrets`],
      ['GET', `${NS}/secrets?watch=true`],
      ['PATCH', `${NS}/secrets/db.prod`],
    ] as const)
      expect(
        (await direct(method, path, 'sa-alice', method === 'PATCH' ? '{}' : undefined)).status,
      ).toBe(403);
    expect((await direct('GET', `${NS}/secrets/db.prod`, 'admin')).status).toBe(200);
    expect((await direct('GET', `${NS}/secrets`, 'admin')).status).toBe(200);
  });

  test('no /v1 response carries a Secret value', async () => {
    const responses = [
      await call('PUT', '/v1/secrets/db-password?env=prod', 'hidden-value'),
      await call('PATCH', '/v1/secrets/db-password?env=prod', 'hidden-value'),
      await call('GET', '/v1/secrets?env=prod'),
      await call('PUT', '/v1/vars/DB_PASSWORD?env=prod', 'v'),
      await call('PUT', '/v1/secrets/db-password?env=prod', 'hidden-value'),
      await call('DELETE', '/v1/secrets/db-password?env=prod'),
    ];
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain('hidden-value');
      expect(text).not.toContain(btoa('hidden-value'));
    }
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
      expect(request.pathname.startsWith(NS)).toBe(true);
      // Secret reads run as the controller; every write runs as the caller, never as a PATCH.
      const secret = request.pathname.startsWith(`${NS}/secrets`);
      expect(request.headers.get('authorization')).toBe(
        secret && request.method === 'GET' ? 'Bearer admin' : 'Bearer sa-alice',
      );
      expect(request.method).not.toBe('PATCH');
      if (request.method !== 'GET') expect(secret).toBe(true);
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
        { name: 'b', updatedAt: '2026-01-01T00:00:00Z' },
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

  test('refuses a name starting with a digit, whose env var would be invalid', async () => {
    const response = await call('PUT', '/v1/secrets/1password?env=prod', 'v');
    expect(response.status).toBe(400);
    expect((await body(response)).detail).toBe(
      'secret name "1password" must be a DNS label starting with a letter',
    );
    expect(kubeCalls()).toHaveLength(0);
  });

  test('a write between read and replace is a 409 the caller can retry', async () => {
    await call('PUT', '/v1/secrets/db?env=prod', 'one');
    raceAfterGet = { key: 'secrets/db.prod', run: bump('secrets/db.prod') };
    const response = await call('PUT', '/v1/secrets/db?env=prod', 'two');
    expect(response.status).toBe(409);
    expect((await body(response)).detail).toBe('secret db changed concurrently; retry');
    expect(store.get('secrets/db.prod')?.data).toEqual({ DB: btoa('one') });
  });

  test('a create that races another create is the same retry problem', async () => {
    raceAfterGet = {
      key: 'secrets/db.prod',
      run: () => store.set('secrets/db.prod', stamp({ metadata: { name: 'db.prod' } })),
    };
    const response = await call('PUT', '/v1/secrets/db?env=prod', 'v');
    expect(response.status).toBe(409);
    expect((await body(response)).detail).toBe('secret db changed concurrently; retry');
  });

  test('unset deletes only the version it read', async () => {
    await call('PUT', '/v1/secrets/db?env=prod', 'one');
    raceAfterGet = { key: 'secrets/db.prod', run: bump('secrets/db.prod') };
    const response = await call('DELETE', '/v1/secrets/db?env=prod');
    expect(response.status).toBe(409);
    expect(store.has('secrets/db.prod')).toBe(true);
  });

  test('refuses a secret whose env var name is already a var in that env', async () => {
    await call('PUT', '/v1/vars/DB_PASSWORD?env=prod', 'plain');
    const response = await call('PUT', '/v1/secrets/db-password?env=prod', 's');
    expect(response.status).toBe(409);
    expect((await body(response)).detail).toBe(
      'var DB_PASSWORD already exists in prod; a secret and a var cannot share it',
    );
    expect(store.has('secrets/db-password.prod')).toBe(false);
    // Another environment is unaffected.
    expect((await call('PUT', '/v1/secrets/db-password?env=staging', 's')).status).toBe(204);
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
      // The var/secret clash check reads the Secret as the controller (#112).
      expect(request.headers.get('authorization')).toBe(
        request.pathname.startsWith(`${NS}/secrets`) ? 'Bearer admin' : 'Bearer sa-alice',
      );
      expect(request.pathname.startsWith(NS)).toBe(true);
      if (request.method !== 'GET')
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

  test('refuses __proto__ before any cluster call', async () => {
    const response = await call('PUT', '/v1/vars/__proto__?env=prod', 'x');
    expect(response.status).toBe(400);
    expect((await body(response)).detail).toBe('var name "__proto__" is reserved');
    expect(kubeCalls()).toHaveLength(0);
  });

  test('Object.prototype names are ordinary vars, never inherited', async () => {
    await call('PUT', '/v1/vars/A?env=prod', '1');
    expect((await call('PATCH', '/v1/vars/toString?env=prod', 'x')).status).toBe(404);
    expect((await call('DELETE', '/v1/vars/constructor?env=prod')).status).toBe(404);
    expect(store.get(`configmaps/${varsConfigMapName('prod')}`)?.data).toEqual({ A: '1' });
    expect((await call('PUT', '/v1/vars/constructor?env=prod', 'c')).status).toBe(204);
    expect(store.get(`configmaps/${varsConfigMapName('prod')}`)?.data).toEqual({
      A: '1',
      constructor: 'c',
    });
    expect((await call('DELETE', '/v1/vars/constructor?env=prod')).status).toBe(204);
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

  test('a write between read and replace is a 409 the caller can retry', async () => {
    await call('PUT', '/v1/vars/A?env=prod', '1');
    raceAfterGet = { key: 'configmaps/di-vars-prod', run: bump('configmaps/di-vars-prod') };
    const response = await call('PUT', '/v1/vars/A?env=prod', '2');
    expect(response.status).toBe(409);
    expect((await body(response)).detail).toBe('the prod vars changed concurrently; retry');
    expect(store.get('configmaps/di-vars-prod')?.data).toEqual({ A: '1' });
  });

  test('a create that races another create is the same retry problem', async () => {
    raceAfterGet = {
      key: 'configmaps/di-vars-prod',
      run: () =>
        store.set('configmaps/di-vars-prod', stamp({ metadata: { name: 'di-vars-prod' } })),
    };
    const response = await call('PUT', '/v1/vars/A?env=prod', '1');
    expect(response.status).toBe(409);
    expect((await body(response)).detail).toBe('the prod vars changed concurrently; retry');
  });

  test('refuses a var whose name a secret in that env is injected as', async () => {
    await call('PUT', '/v1/secrets/db-password?env=prod', 's');
    const response = await call('PUT', '/v1/vars/DB_PASSWORD?env=prod', 'plain');
    expect(response.status).toBe(409);
    expect((await body(response)).detail).toBe(
      'secret db-password is injected as DB_PASSWORD in prod; a secret and a var cannot share it',
    );
    // Names a secret cannot produce, and other environments, are unaffected.
    expect((await call('PUT', '/v1/vars/db_password?env=prod', 'x')).status).toBe(204);
    expect((await call('PUT', '/v1/vars/DB_PASSWORD?env=staging', 'x')).status).toBe(204);
  });

  test('an unlabelled di-vars ConfigMap is refused, never adopted', async () => {
    store.set('configmaps/di-vars-prod', { metadata: { name: 'di-vars-prod' }, data: { X: '1' } });
    for (const [method, value] of [
      ['PUT', 'v'],
      ['PATCH', 'v'],
      ['DELETE', undefined],
    ] as const) {
      const response = await call(method, '/v1/vars/X?env=prod', value);
      expect(response.status).toBe(409);
      expect((await body(response)).detail).toBe('di-vars-prod is not a tenant vars ConfigMap');
    }
    expect(store.get('configmaps/di-vars-prod')?.metadata.labels).toBeUndefined();
  });
});
