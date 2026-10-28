import { afterAll, describe, expect, it } from 'bun:test';
import {
  ensureTenantOAuthClients,
  HttpOAuthClientRegistry,
  OAuthAdminError,
  OAuthClientConflict,
  OAuthClientNotFound,
  oauthAdminError,
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

describeOAuthClientRegistryContract('in-memory fake', () => new FakeIdentityAdmin().registry());
describeOAuthClientRegistryContract('HTTP client against the fake handler', () => {
  const fake = new FakeIdentityAdmin();
  return new HttpOAuthClientRegistry({
    baseUrl: 'http://identity.test/',
    token: () => fake.token,
    fetch: (request) => fake.handle(request),
  });
});
describeOAuthClientRegistryContract('HTTP client against the fake server', () => {
  const fake = new FakeIdentityAdmin();
  const server = fake.serve();
  servers.push(server);
  return new HttpOAuthClientRegistry({
    baseUrl: server.url.origin,
    token: async () => fake.token,
  });
});

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
    expect(first.console.clientSecret).toBe('fake-secret-1');
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
    await ensureTenantOAuthClients(registry, tenant, ensure);
    const recovered = await ensureTenantOAuthClients(registry, tenant, ensure);
    expect(recovered.console.clientSecret).toBe('fake-secret-2');
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
      OAuthClientConflict,
    );
  });
});

describe('HttpOAuthClientRegistry', () => {
  it('sends the provisioner token and the #48 fields', async () => {
    const fake = new FakeIdentityAdmin();
    const bodies: unknown[] = [];
    const registry = new HttpOAuthClientRegistry({
      baseUrl: 'http://identity.test',
      token: () => fake.token,
      fetch: async (request) => {
        if (request.method === 'POST') bodies.push(await request.clone().json());
        return fake.handle(request);
      },
    });
    await registry.create(tenantOAuthClients(tenant, options).cli);
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
    const noSlug = { method: 'POST', body: JSON.stringify({ clientId: 'x' }) };
    expect((await call('/api/admin/oauth-clients', noSlug)).status).toBe(400);
    const noVersion = { method: 'POST', body: '{}' };
    expect((await call('/api/admin/oauth-clients/x/rotate-secret', noVersion)).status).toBe(400);
    expect((await call('/api/admin/oauth-clients/x', { method: 'DELETE' })).status).toBe(404);
  });
});
