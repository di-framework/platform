import { afterAll, describe, expect, it } from 'bun:test';
import {
  ADMIN_SCOPE,
  CLI_REDIRECT_URI,
  ensureTenantOAuthClients,
  HttpOAuthClientRegistry,
  identityAdminRegistry,
  OAuthAdminError,
  OAuthClientConflict,
  OAuthClientNotFound,
  type OAuthClientRegistry,
  OAuthClientRevoked,
  oauthAdminError,
  provisionerToken,
  removeTenantOAuthClients,
  storedConsoleSecret,
  TENANT_OAUTH_SCOPES,
  tenantOAuthClientIds,
  tenantOAuthClients,
  tenantOAuthOptions,
  upstreamFetch,
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
 * `IDENTITY_ADMIN_ORG` names the organization the clients belong to (default `acme`). Ids are
 * random per case and revoked afterwards, so reruns against a persistent server do not collide.
 * Example:
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

/** `registry` with every call counted by name. */
function counting(registry: OAuthClientRegistry): OAuthClientRegistry & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    create: (spec, key) => {
      calls.push('create');
      return registry.create(spec, key);
    },
    get: (id) => {
      calls.push('get');
      return registry.get(id);
    },
    rotate: (id, version, key) => {
      calls.push('rotate');
      return registry.rotate(id, version, key);
    },
    delete: (id) => {
      calls.push('delete');
      return registry.delete(id);
    },
  };
}

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

  it('registers the console callback, the loopback CLI callback and the controller audience', () => {
    const image = `ghcr.io/di-framework/tenant-auth@sha256:${'a'.repeat(64)}`;
    const auth = {
      image,
      issuer: 'http://identity.localhost:28180',
      oauthClient: { id: 'provisioner', secretName: 'tenant-auth-oauth' },
    };
    expect(tenantOAuthOptions('acme', auth)).toEqual({
      consoleRedirectUris: ['http://127.0.0.1:8787/oidc/callback'],
      cliRedirectUris: [CLI_REDIRECT_URI],
      scopes: [...TENANT_OAUTH_SCOPES],
      audiences: ['https://localhost:8788'],
    });
    const routed = {
      ...auth,
      consolePublicUrl: 'http://console.{tenant}.localhost:28180',
      controllerPublicUrl: 'https://controller.{tenant}.localhost:28180',
    };
    expect(tenantOAuthOptions('acme', routed)).toMatchObject({
      consoleRedirectUris: ['http://console.acme.localhost:28180/oidc/callback'],
      audiences: ['https://controller.acme.localhost:28180'],
    });
  });

  it('reads the stored console secret only for the current client', () => {
    const id = Buffer.from('tenant-acme-0a1b2c3d-console').toString('base64');
    expect(
      storedConsoleSecret(
        { clientId: id, clientSecret: 'c2VjcmV0' },
        'tenant-acme-0a1b2c3d-console',
      ),
    ).toBe('c2VjcmV0');
    expect(storedConsoleSecret({ clientId: id }, 'tenant-acme-0a1b2c3d-console')).toBeUndefined();
    expect(
      storedConsoleSecret({ clientSecret: 'c2VjcmV0' }, 'tenant-acme-0a1b2c3d-console'),
    ).toBeUndefined();
    expect(storedConsoleSecret(undefined, 'tenant-acme-0a1b2c3d-console')).toBeUndefined();
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
    expect(fake.clients.get('tenant-acme-0a1b2c3d-cli')).toMatchObject({
      public: true,
      browser: true,
    });
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

  it('retries a keyed create that lost the race once, instead of rotating the winner’s secret', async () => {
    // The autocommit guest: the loser's create answers 409 before the winner's idempotency record
    // is committed, then replays the winner's 201 (#529 S1).
    const inner = counting(new FakeIdentityAdmin().registry());
    const specs = tenantOAuthClients(tenant, options);
    let lost = false;
    const registry: OAuthClientRegistry = {
      ...inner,
      create: async (spec, key) => {
        if (spec.clientId === specs.console.clientId && !lost) {
          lost = true;
          await inner.create(spec, key);
          throw oauthAdminError(409, 'record not committed yet');
        }
        return inner.create(spec, key);
      },
    };
    const ensure = { ...options, consoleSecretStored: false, rotationVersion: 'r1' };
    const result = await ensureTenantOAuthClients(registry, tenant, ensure);
    const expected = await inner.create(
      specs.console,
      'platform-tenant-0a1b2c3d-4e5f-6789-abcd-ef0123456789-console-create',
    );
    expect(result.console).toEqual(expected);
    expect(inner.calls).not.toContain('rotate');
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
    const inner = counting(new FakeIdentityAdmin().registry());
    const registry: OAuthClientRegistry = {
      ...inner,
      get: async () => undefined,
      create: async () => {
        inner.calls.push('create');
        throw oauthAdminError(409, 'orphan');
      },
    };
    const ensure = { ...options, consoleSecretStored: true, rotationVersion: 'r1' };
    const failure = ensureTenantOAuthClients(registry, tenant, ensure);
    await expect(failure).rejects.toBeInstanceOf(OAuthClientConflict);
    await expect(failure).rejects.not.toBeInstanceOf(OAuthClientRevoked);
    // The CLI client is ensured first: its create is tried twice and then fails the reconcile.
    expect(inner.calls.filter((call) => call === 'create')).toHaveLength(2);
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
    expect(await removeTenantOAuthClients(registry, tenant)).toEqual([]);
    expect(await removeTenantOAuthClients(registry, tenant)).toEqual([]);
    const revoked = [...fake.clients.values()].filter((client) => client.revokedAt);
    expect(revoked.map((client) => client.organizationSlug)).toEqual(['acme', 'acme']);
    expect((await registry.get(tenantOAuthClientIds(other).console))?.revokedAt).toBeUndefined();
  });

  it('reports the clients it could not revoke and revokes the rest', async () => {
    const fake = new FakeIdentityAdmin();
    const inner = fake.registry();
    const ids = tenantOAuthClientIds(tenant);
    const ensure = { ...options, consoleSecretStored: true, rotationVersion: 'r1' };
    await ensureTenantOAuthClients(inner, tenant, ensure);
    const registry: OAuthClientRegistry = {
      ...inner,
      delete: async (id) => {
        if (id === ids.console) throw oauthAdminError(503, 'down');
        return inner.delete(id);
      },
    };
    const failed = await removeTenantOAuthClients(registry, tenant);
    expect(failed).toEqual([
      { clientId: ids.console, error: expect.objectContaining({ status: 503 }) },
    ]);
    expect(fake.clients.get(ids.cli)?.revokedAt).toBeString();
    expect(fake.clients.get(ids.console)?.revokedAt).toBeUndefined();
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
        tokenEndpointAuthMethod: 'none',
        browser: true,
      },
    ]);
    expect(fake.requests).toEqual(['POST /api/admin/oauth-clients']);
    await registry.create(tenantOAuthClients(tenant, options).console);
    expect(bodies[1]).toMatchObject({ tokenEndpointAuthMethod: 'client_secret_basic' });
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

  it('mints a new token once when the server no longer accepts the cached one', async () => {
    const fake = new FakeIdentityAdmin();
    const tokens = ['stale', fake.token, 'stale-again'];
    const registry = new HttpOAuthClientRegistry({
      baseUrl: 'http://identity.test',
      token: () => tokens[0] ?? '',
      forgetToken: () => tokens.shift(),
      fetch: (request) => fake.handle(request),
    });
    expect(await registry.get('x')).toBeUndefined();
    expect(fake.requests).toHaveLength(2);
    tokens.shift();
    // One retry only: a second 401 is reported.
    await expect(registry.get('x')).rejects.toMatchObject({ status: 401 });
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

  it('maps the token endpoint auth method and fills fields an older identity server omits', async () => {
    const answers = (body: unknown) =>
      new HttpOAuthClientRegistry({
        baseUrl: 'http://identity.test',
        token: () => 't',
        fetch: async () => Response.json(body),
      });
    expect(await answers({ client_id: 'old', organization_slug: null }).get('old')).toEqual({
      clientId: 'old',
      organizationSlug: '',
      redirectUris: [],
      scopes: [],
      audiences: [],
      public: false,
    });
    const cli = { client_id: 'cli', token_endpoint_auth_method: 'none', revoked_at: null };
    expect((await answers(cli).get('cli'))?.public).toBe(true);
  });

  it('types admin errors by status', () => {
    expect(oauthAdminError(409, 'x')).toBeInstanceOf(OAuthClientConflict);
    expect(oauthAdminError(404, 'x')).toBeInstanceOf(OAuthClientNotFound);
    expect(oauthAdminError(500, 'x')).not.toBeInstanceOf(OAuthClientNotFound);
  });
});

describe('identity admin access', () => {
  const provisioner = (fake: FakeIdentityAdmin, overrides: Record<string, unknown> = {}) => ({
    issuer: 'http://identity.test/',
    clientId: fake.provisioner.clientId,
    clientSecret: async () => fake.provisioner.clientSecret,
    fetch: (request: Request) => fake.handle(request),
    ...overrides,
  });

  it('mints a provisioner token with client credentials and caches it until shortly before expiry', async () => {
    const fake = new FakeIdentityAdmin();
    let at = 1_000_000;
    const token = provisionerToken(provisioner(fake, { now: () => at }));
    expect(await token.get()).toBe('minted-1');
    expect(await token.get()).toBe('minted-1');
    expect(fake.requests).toEqual(['POST /oauth2/token']);
    expect(fake.tokens.get('minted-1')).toEqual(ADMIN_SCOPE.split(' '));
    // 600 s lifetime: still cached 31 s before expiry, minted again 30 s before.
    at += 569_000;
    expect(await token.get()).toBe('minted-1');
    at += 1_000;
    expect(await token.get()).toBe('minted-2');
    token.forget();
    expect(await token.get()).toBe('minted-3');
  });

  it('reports a refused or malformed token response', async () => {
    const fake = new FakeIdentityAdmin();
    const wrong = provisionerToken(provisioner(fake, { clientSecret: async () => 'nope' }));
    await expect(wrong.get()).rejects.toMatchObject({ status: 401 });
    await expect(wrong.get()).rejects.toThrow('provisioner client provisioner');
    const empty = provisionerToken(
      provisioner(fake, { fetch: async () => Response.json({ token_type: 'Bearer' }) }),
    );
    await expect(empty.get()).rejects.toThrow('no access_token');
  });

  it('does not cache a token without a lifetime', async () => {
    const fake = new FakeIdentityAdmin();
    fake.provisioner.expiresIn = 0;
    const token = provisionerToken(provisioner(fake));
    expect(await token.get()).toBe('minted-1');
    expect(await token.get()).toBe('minted-2');
  });

  it('sends requests to the upstream under the issuer’s Host', async () => {
    const seen: { url: string; host: string | null; body: string }[] = [];
    const fetcher = async (request: Request) => {
      seen.push({
        url: request.url,
        host: request.headers.get('host'),
        body: await request.text(),
      });
      return new Response(null, { status: 204 });
    };
    const upstream = upstreamFetch('gateway.wasmcloud.svc:8080', fetcher);
    const issuer = 'http://identity.localhost:28180';
    await upstream(new Request(`${issuer}/oauth2/token`, { method: 'POST', body: 'a=1' }));
    await upstream(new Request(`${issuer}/api/admin/oauth-clients/x`));
    const host = 'identity.localhost:28180';
    expect(seen).toEqual([
      { url: 'http://gateway.wasmcloud.svc:8080/oauth2/token', host, body: 'a=1' },
      { url: 'http://gateway.wasmcloud.svc:8080/api/admin/oauth-clients/x', host, body: '' },
    ]);
    // Without a port the scheme's default applies; an IPv6 upstream keeps its brackets.
    await upstreamFetch('gateway', fetcher)(new Request(`${issuer}/x`));
    await upstreamFetch('[::1]:9', fetcher)(new Request(`${issuer}/y`));
    expect(seen.slice(2).map((s) => s.url)).toEqual(['http://gateway/x', 'http://[::1]:9/y']);
    expect(upstreamFetch(undefined, fetcher)).toBe(fetcher);
  });

  it('builds the admin registry over the issuer, authenticated as the provisioner client', async () => {
    const fake = new FakeIdentityAdmin();
    const server = fake.serve();
    servers.push(server);
    const registry = identityAdminRegistry({
      issuer: 'http://identity.alpha.localhost:28180',
      upstream: `127.0.0.1:${server.port}`,
      clientId: fake.provisioner.clientId,
      clientSecret: async () => fake.provisioner.clientSecret,
    });
    const ensure = { ...options, consoleSecretStored: false, rotationVersion: 'r1' };
    const created = await ensureTenantOAuthClients(registry, tenant, ensure);
    expect(created.console.clientSecret).toStartWith('fake-secret-');
    expect(fake.clients.size).toBe(2);
    expect(new Set(fake.hosts)).toEqual(new Set(['identity.alpha.localhost:28180']));
    expect(fake.requests.filter((r) => r === 'POST /oauth2/token')).toHaveLength(1);
    // The identity server restarted and forgot its tokens: minted again, once.
    fake.tokens.clear();
    expect(await removeTenantOAuthClients(registry, tenant)).toEqual([]);
    expect(fake.requests.filter((r) => r === 'POST /oauth2/token')).toHaveLength(2);
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
      post({ clientId: ' x ', organizationSlug: ' a ', audiences: [' aud ', 'aud', ''] }),
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

  it('issues provisioner tokens for client credentials only', async () => {
    const fake = new FakeIdentityAdmin();
    const basic = Buffer.from('provisioner:provisioner-secret').toString('base64');
    const send = (body: string, authorization = `Basic ${basic}`) =>
      fake.handle(
        new Request('http://identity.test/oauth2/token', {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
          body,
        }),
      );
    expect((await send('grant_type=authorization_code')).status).toBe(400);
    expect((await send('grant_type=client_credentials', 'Basic nope')).status).toBe(401);
    const minted = await send('grant_type=client_credentials&scope=admin:read');
    expect(await minted.json()).toMatchObject({ access_token: 'minted-1', expires_in: 600 });
    expect(fake.tokens.get('minted-1')).toEqual(['admin:read']);
  });
});
