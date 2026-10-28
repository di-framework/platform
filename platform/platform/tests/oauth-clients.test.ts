import { afterAll, describe, expect, it } from 'bun:test';
import {
  ensureTenantOAuthClients,
  HttpOAuthClientRegistry,
  OAuthAdminError,
  OAuthClientConflict,
  OAuthClientNotFound,
  type OAuthClientRegistry,
  OAuthClientRevoked,
  oauthAdminError,
  PROVISIONAL_48,
  removeTenantOAuthClients,
  tenantOAuthClientIds,
  tenantOAuthClients,
} from '../src/tenancy/oauth-clients';
import { FakeIdentityAdmin } from './support/fake-identity-admin';
import { describeOAuthClientRegistryContract } from './support/oauth-client-registry-contract';

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

/** Admin requests against `fake` through the HTTP handler, for the contract's raw cases. */
function rawRequests(
  baseUrl: string,
  token: string,
  fetcher: (request: Request) => Promise<Response>,
) {
  return (path: string, init: RequestInit) =>
    fetcher(
      new Request(`${baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      }),
    );
}

describeOAuthClientRegistryContract('in-memory fake', () => ({
  registry: new FakeIdentityAdmin().registry(),
}));
describeOAuthClientRegistryContract('HTTP client against the fake handler', () => {
  const fake = new FakeIdentityAdmin();
  const handle = (request: Request) => fake.handle(request);
  return {
    registry: new HttpOAuthClientRegistry({
      baseUrl: 'http://identity.test/',
      token: () => fake.token,
      fetch: handle,
    }),
    request: rawRequests('http://identity.test', fake.token, handle),
  };
});
describeOAuthClientRegistryContract('HTTP client against the fake server', () => {
  const fake = new FakeIdentityAdmin();
  const server = fake.serve();
  servers.push(server);
  return {
    registry: new HttpOAuthClientRegistry({
      baseUrl: server.url.origin,
      token: async () => fake.token,
    }),
    request: rawRequests(server.url.origin, fake.token, (request) => fetch(request)),
  };
});
/**
 * The same contract against a real identity server, skipped unless `IDENTITY_ADMIN_URL` (origin)
 * and `IDENTITY_ADMIN_TOKEN` (a bearer token with `admin:read admin:write`) are set;
 * `IDENTITY_ADMIN_ORG` names an existing organization (default `acme`). Ids are random per case,
 * so reruns against a persistent server do not collide. The `#48 provisional` cases fail against
 * a server without #48. Example:
 * `IDENTITY_ADMIN_URL=https://identity.example.com IDENTITY_ADMIN_TOKEN=… bun test oauth-clients`
 */
const realServer = { url: process.env.IDENTITY_ADMIN_URL, token: process.env.IDENTITY_ADMIN_TOKEN };
describeOAuthClientRegistryContract(
  'HTTP client against a real identity server',
  () => {
    const baseUrl = realServer.url ?? '';
    const token = realServer.token ?? '';
    return {
      registry: new HttpOAuthClientRegistry({ baseUrl, token: () => token }),
      organizationSlug: process.env.IDENTITY_ADMIN_ORG,
      request: rawRequests(baseUrl, token, (request) => fetch(request)),
    };
  },
  { skip: !realServer.url || !realServer.token },
);

const tenant = { name: 'acme', uid: '0a1b2c3d-4e5f-6789-abcd-ef0123456789' };
const options = {
  consoleRedirectUris: ['https://acme.example.com/auth/callback'],
  cliRedirectUris: ['http://127.0.0.1/callback'],
  scopes: ['openid', 'profile'],
  audiences: ['https://acme.example.com'],
};

describe('tenant OAuth clients', () => {
  it('derives per-tenant ids from the name and uid', () => {
    expect(tenantOAuthClientIds(tenant)).toEqual({
      console: 'tenant-acme-0a1b2c3d-console',
      cli: 'tenant-acme-0a1b2c3d-cli',
    });
    const long = tenantOAuthClientIds({ name: 'a'.repeat(63), uid: tenant.uid });
    expect(long.console.length).toBeLessThanOrEqual(100);
  });

  it('describes a confidential console client and a public CLI client', () => {
    const specs = tenantOAuthClients(tenant, options);
    expect(specs.console).toEqual({
      clientId: 'tenant-acme-0a1b2c3d-console',
      organizationSlug: 'acme',
      redirectUris: options.consoleRedirectUris,
      scopes: options.scopes,
      audiences: options.audiences,
      public: false,
    });
    expect(specs.cli).toMatchObject({ public: true, redirectUris: options.cliRedirectUris });
  });

  it('registers both clients once and returns the console secret only when new', async () => {
    const fake = new FakeIdentityAdmin();
    const registry = fake.registry();
    const ensure = { ...options, consoleSecretStored: false, rotationVersion: 'r1' };
    const first = await ensureTenantOAuthClients(registry, tenant, ensure);
    expect(first.console.clientSecret).toStartWith('fake-secret-');
    expect(first.cli).toEqual({ clientId: 'tenant-acme-0a1b2c3d-cli' });
    const again = await ensureTenantOAuthClients(registry, tenant, {
      ...ensure,
      consoleSecretStored: true,
    });
    expect(again.console).toEqual({ clientId: 'tenant-acme-0a1b2c3d-console' });
    expect(fake.clients.size).toBe(2);
  });

  it('rotates the console secret when it was never stored', async () => {
    const registry = new FakeIdentityAdmin().registry();
    const ensure = { ...options, consoleSecretStored: false, rotationVersion: 'r1' };
    const first = await ensureTenantOAuthClients(registry, tenant, ensure);
    const recovered = await ensureTenantOAuthClients(registry, tenant, ensure);
    expect(recovered.console.clientSecret).toStartWith('fake-secret-');
    expect(recovered.console.clientSecret).not.toBe(first.console.clientSecret);
    expect(await ensureTenantOAuthClients(registry, tenant, ensure)).toEqual(recovered);
  });

  it('gives two concurrent reconciles the same console secret', async () => {
    const fake = new FakeIdentityAdmin();
    const registry = fake.registry();
    const ensure = { ...options, consoleSecretStored: false, rotationVersion: 'r1' };
    const [a, b] = await Promise.all([
      ensureTenantOAuthClients(registry, tenant, ensure),
      ensureTenantOAuthClients(registry, tenant, ensure),
    ]);
    expect(a.console.clientSecret).toBeString();
    expect(b).toEqual(a);
    expect(fake.clients.size).toBe(2);
  });

  it('re-reads a client another reconcile created between get and create', async () => {
    const fake = new FakeIdentityAdmin();
    const inner = fake.registry();
    const specs = tenantOAuthClients(tenant, options);
    let raced = false;
    const registry: OAuthClientRegistry = {
      ...inner,
      get: async (clientId) => {
        if (raced || clientId !== specs.console.clientId) return inner.get(clientId);
        raced = true;
        await inner.create(specs.console, 'someone-else');
        return undefined;
      },
    };
    const ensure = { ...options, consoleSecretStored: true, rotationVersion: 'r1' };
    const result = await ensureTenantOAuthClients(registry, tenant, ensure);
    expect(result.console).toEqual({ clientId: specs.console.clientId });
  });

  it('rethrows a create conflict when the client still cannot be read', async () => {
    const inner = new FakeIdentityAdmin().registry();
    const registry: OAuthClientRegistry = {
      ...inner,
      get: async () => undefined,
      create: async () => {
        throw oauthAdminError(409, 'orphan');
      },
    };
    const ensure = { ...options, consoleSecretStored: true, rotationVersion: 'r1' };
    const failure = ensureTenantOAuthClients(registry, tenant, ensure);
    await expect(failure).rejects.toBeInstanceOf(OAuthClientConflict);
    await expect(failure).rejects.not.toBeInstanceOf(OAuthClientRevoked);
  });

  it('passes other create failures through', async () => {
    const registry: OAuthClientRegistry = {
      ...new FakeIdentityAdmin().registry(),
      create: async () => {
        throw oauthAdminError(500, 'down');
      },
    };
    const ensure = { ...options, consoleSecretStored: true, rotationVersion: 'r1' };
    await expect(ensureTenantOAuthClients(registry, tenant, ensure)).rejects.toMatchObject({
      status: 500,
    });
  });

  it('keeps two tenants apart and removes only the deleted one', async () => {
    const fake = new FakeIdentityAdmin();
    const registry = fake.registry();
    const other = { name: 'globex', uid: 'ffffffff-0000-0000-0000-000000000000' };
    const ensure = { ...options, consoleSecretStored: true, rotationVersion: 'r1' };
    await ensureTenantOAuthClients(registry, tenant, ensure);
    await ensureTenantOAuthClients(registry, other, ensure);
    await removeTenantOAuthClients(registry, tenant);
    await removeTenantOAuthClients(registry, tenant);
    const revoked = [...fake.clients.values()].filter((client) => client.revokedAt);
    expect(revoked.map((client) => client.organizationSlug)).toEqual(['acme', 'acme']);
    expect((await registry.get(tenantOAuthClientIds(other).console))?.revokedAt).toBeUndefined();
  });

  it('refuses to reuse a revoked client id', async () => {
    const registry = new FakeIdentityAdmin().registry();
    const ensure = { ...options, consoleSecretStored: true, rotationVersion: 'r1' };
    await ensureTenantOAuthClients(registry, tenant, ensure);
    await removeTenantOAuthClients(registry, tenant);
    await expect(ensureTenantOAuthClients(registry, tenant, ensure)).rejects.toBeInstanceOf(
      OAuthClientRevoked,
    );
  });

  it('lists the #48 guesses in one place', () => {
    expect(PROVISIONAL_48.length).toBe(4);
  });
});

describe('HttpOAuthClientRegistry', () => {
  it('sends the provisioner token, the idempotency key and the #48 fields', async () => {
    const fake = new FakeIdentityAdmin();
    const bodies: unknown[] = [];
    const keys: (string | null)[] = [];
    const registry = new HttpOAuthClientRegistry({
      baseUrl: 'http://identity.test',
      token: () => fake.token,
      fetch: async (request) => {
        if (request.method === 'POST') bodies.push(await request.clone().json());
        keys.push(request.headers.get('idempotency-key'));
        return fake.handle(request);
      },
    });
    await registry.create(tenantOAuthClients(tenant, options).cli, 'k1');
    expect(keys).toEqual(['k1']);
    expect(bodies).toEqual([
      {
        clientId: 'tenant-acme-0a1b2c3d-cli',
        organizationSlug: 'acme',
        redirectUris: options.cliRedirectUris,
        scopes: options.scopes,
        audiences: options.audiences,
        public: true,
        browser: true,
      },
    ]);
    expect(fake.requests).toEqual(['POST /api/admin/oauth-clients']);
  });

  it('maps other failures to OAuthAdminError', async () => {
    const registry = new HttpOAuthClientRegistry({
      baseUrl: 'http://identity.test',
      token: () => 'wrong',
      fetch: (request) => new FakeIdentityAdmin().handle(request),
    });
    const failure = registry.get('x');
    await expect(failure).rejects.toBeInstanceOf(OAuthAdminError);
    await expect(failure).rejects.toMatchObject({ status: 401, name: 'OAuthAdminError' });
  });

  const answering = (body: unknown) =>
    new HttpOAuthClientRegistry({
      baseUrl: 'http://identity.test',
      token: () => 't',
      fetch: async () => Response.json(body, { status: 201 }),
    });

  it('fails when a public create comes back with a secret', async () => {
    const registry = answering({ client_id: 'cli', client_secret: 's' });
    const spec = tenantOAuthClients(tenant, options).cli;
    await expect(registry.create(spec)).rejects.toThrow('server did not honour public');
  });

  it('fails when a confidential create or rotate comes back without a secret', async () => {
    const registry = answering({ client_id: 'console' });
    const spec = tenantOAuthClients(tenant, options).console;
    await expect(registry.create(spec)).rejects.toThrow('no client_secret');
    await expect(registry.rotate('console', 'v1')).rejects.toBeInstanceOf(OAuthAdminError);
  });

  it('fills fields an older identity server omits', async () => {
    const registry = new HttpOAuthClientRegistry({
      baseUrl: 'http://identity.test',
      token: () => 't',
      fetch: async () => Response.json({ client_id: 'old', organization_slug: null }),
    });
    expect(await registry.get('old')).toEqual({
      clientId: 'old',
      organizationSlug: '',
      redirectUris: [],
      scopes: [],
      audiences: [],
      public: false,
    });
  });

  it('types admin errors by status', () => {
    expect(oauthAdminError(409, 'x')).toBeInstanceOf(OAuthClientConflict);
    expect(oauthAdminError(404, 'x')).toBeInstanceOf(OAuthClientNotFound);
    expect(oauthAdminError(500, 'x')).not.toBeInstanceOf(OAuthClientNotFound);
  });
});

describe('FakeIdentityAdmin HTTP surface', () => {
  const call = (path: string, init: RequestInit = {}) =>
    new FakeIdentityAdmin().handle(
      new Request(`http://identity.test${path}`, {
        ...init,
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      }),
    );

  it('rejects malformed requests like the identity server', async () => {
    expect((await call('/api/other')).status).toBe(404);
    expect((await call('/api/admin/oauth-clients', { method: 'PATCH' })).status).toBe(405);
    const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
    expect((await call('/api/admin/oauth-clients', post({ clientId: 'x' }))).status).toBe(400);
    const trimmed = await call(
      '/api/admin/oauth-clients',
      post({ clientId: ' x ', organizationSlug: ' a ' }),
    );
    expect(await trimmed.json()).toMatchObject({ client_id: 'x' });
    const noVersion = { method: 'POST', body: '{}' };
    expect((await call('/api/admin/oauth-clients/x/rotate-secret', noVersion)).status).toBe(400);
    expect((await call('/api/admin/oauth-clients/x', { method: 'DELETE' })).status).toBe(404);
  });

  it('authenticates like the bearer guard: 401 with a challenge, 403 without the scope', async () => {
    const fake = new FakeIdentityAdmin();
    fake.tokens.set('reader', ['admin:read']);
    const send = (authorization: string, method = 'GET') =>
      fake.handle(
        new Request('http://identity.test/api/admin/oauth-clients/x', {
          method,
          headers: { authorization },
        }),
      );
    const missing = await send('');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect((await send('bearer admin-token')).status).toBe(404);
    expect((await send('Bearer reader')).status).toBe(404);
    const denied = await send('Bearer reader', 'DELETE');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('www-authenticate')).toContain('scope="admin:write"');
  });
});
