import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { spawnEnv } from '../../../tests/helpers/spawn-env';
import {
  ADMIN_SCOPE,
  adminFetch,
  CLI_REDIRECT_URI,
  ensureTenantOAuthClients,
  HttpOAuthClientRegistry,
  identityAdminRegistry,
  identityAdminUpstream,
  OAuthAdminError,
  OAuthClientConflict,
  OAuthClientNotFound,
  type OAuthClientRegistry,
  OAuthClientRevoked,
  oauthAdminError,
  provisionerToken,
  REQUEST_TIMEOUT_MS,
  removeTenantOAuthClients,
  storedConsoleSecret,
  TENANT_OAUTH_SCOPES,
  tenantOAuthClientIds,
  tenantOAuthClients,
  tenantOAuthOptions,
} from '../src/tenancy/oauth-clients';
import { FakeIdentityAdmin } from './support/fake-identity-admin';
import { describeOAuthClientRegistryContract } from './support/oauth-client-registry-contract';

const servers: ReturnType<typeof Bun.serve>[] = [];
const httpServers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
  for (const server of httpServers) {
    server.closeAllConnections();
    server.close();
  }
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
/**
 * The contract through {@link identityAdminRegistry}, i.e. with the provisioner token minted by
 * `client_credentials` as the controller does, against the same real server: set
 * `IDENTITY_PROVISIONER_CLIENT_ID` and `IDENTITY_PROVISIONER_CLIENT_SECRET` as well.
 */
const realProvisioner = {
  clientId: process.env.IDENTITY_PROVISIONER_CLIENT_ID,
  clientSecret: process.env.IDENTITY_PROVISIONER_CLIENT_SECRET,
};
describeOAuthClientRegistryContract(
  'identityAdminRegistry against a real identity server, as the provisioner client',
  () => ({
    registry: identityAdminRegistry({
      issuer: realServer.url ?? '',
      clientId: realProvisioner.clientId ?? '',
      clientSecret: async () => realProvisioner.clientSecret ?? '',
    }),
    organizationSlug: process.env.IDENTITY_ADMIN_ORG,
  }),
  { skip: !realServer.url || !realProvisioner.clientId || !realProvisioner.clientSecret },
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

  it('derives the upstream from issuerUpstream, else issuerIp with the issuer port', () => {
    const base = {
      image: `ghcr.io/di-framework/tenant-auth@sha256:${'a'.repeat(64)}`,
      oauthClient: { id: 'provisioner', secretName: 'tenant-auth-oauth' },
    };
    const issuer = 'http://identity.localhost:28180';
    expect(identityAdminUpstream({ ...base, issuer })).toBeUndefined();
    expect(identityAdminUpstream({ ...base, issuer, issuerUpstream: 'gw.wasmcloud.svc:80' })).toBe(
      'gw.wasmcloud.svc:80',
    );
    const ip = '192.0.2.7';
    expect(identityAdminUpstream({ ...base, issuer, issuerUpstream: 'gw:80', issuerIp: ip })).toBe(
      'gw:80',
    );
    expect(identityAdminUpstream({ ...base, issuer, issuerIp: ip })).toBe('192.0.2.7:28180');
    expect(identityAdminUpstream({ ...base, issuer: 'https://id.example', issuerIp: ip })).toBe(
      '192.0.2.7:443',
    );
    expect(identityAdminUpstream({ ...base, issuer: 'http://id.example', issuerIp: ip })).toBe(
      '192.0.2.7:80',
    );
  });

  /** A `node:http` server that records the `Host` of every request and answers `status`. */
  async function hostLogger(status = 204, address = '127.0.0.1') {
    const seen: { method: string; path: string; host: string | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        seen.push({ method: req.method ?? '', path: req.url ?? '', host: req.headers.host, body });
        res.writeHead(status, {
          'content-type': 'application/json',
          'x-seen': String(seen.length),
        });
        res.end(status === 204 ? undefined : '{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, address, resolve));
    httpServers.push(server);
    return { seen, port: (server.address() as { port: number }).port };
  }

  it('sends requests to the upstream over node:http under the issuer’s Host', async () => {
    const { seen, port } = await hostLogger();
    const send = adminFetch({ upstream: `127.0.0.1:${port}` });
    const issuer = 'http://identity.localhost:28180';
    const token = await send(
      new Request(`${issuer}/oauth2/token?x=1`, {
        method: 'POST',
        headers: { authorization: 'Basic abc' },
        body: 'a=1',
      }),
    );
    expect(token.status).toBe(204);
    expect(token.headers.get('x-seen')).toBe('1');
    const read = await send(new Request(`${issuer}/api/admin/oauth-clients/x`));
    expect(read.status).toBe(204);
    expect(seen).toEqual([
      { method: 'POST', path: '/oauth2/token?x=1', host: 'identity.localhost:28180', body: 'a=1' },
      {
        method: 'GET',
        path: '/api/admin/oauth-clients/x',
        host: 'identity.localhost:28180',
        body: '',
      },
    ]);
    // A body comes back as a Response body; an IPv6 upstream keeps its address.
    const { seen: more, port: other } = await hostLogger(200, '::1');
    const answered = await adminFetch({ upstream: `[::1]:${other}` })(new Request(`${issuer}/y`));
    expect(await answered.json()).toEqual({ ok: true });
    expect(more.map((s) => s.host)).toEqual(['identity.localhost:28180']);
  });

  it('runs under node: the Host reaches the upstream from the built module', () => {
    // The platform controller runs on Node, whose fetch replaces an explicit Host with the
    // connected host; the built module is exercised there, against a server that logs the Host.
    const built = join(import.meta.dir, '../dist/tenancy/oauth-clients.js');
    const script = `
      const { createServer } = require('node:http');
      const { identityAdminRegistry } = require(${JSON.stringify(built)});
      const hosts = [];
      const server = createServer((req, res) => {
        hosts.push(req.method + ' ' + req.url + ' host=' + req.headers.host);
        if (req.url === '/oauth2/token') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 't', expires_in: 600 }));
        } else res.writeHead(404).end();
      });
      server.listen(0, '127.0.0.1', async () => {
        const registry = identityAdminRegistry({
          issuer: 'http://identity.acme.localhost:28180',
          upstream: '127.0.0.1:' + server.address().port,
          clientId: 'provisioner',
          clientSecret: async () => 'secret',
        });
        const client = await registry.get('tenant-x-console');
        console.log(JSON.stringify({ node: process.version, client, hosts }));
        // Node keeps the client connection alive; exit instead of waiting for it to close.
        process.exit(0);
      });
    `;
    const result = spawnSync('node', ['-e', script], { env: spawnEnv, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as {
      node: string;
      client: unknown;
      hosts: string[];
    };
    expect(output.node).toStartWith('v');
    expect(output.client).toBeUndefined();
    expect(output.hosts).toEqual([
      'POST /oauth2/token host=identity.acme.localhost:28180',
      'GET /api/admin/oauth-clients/tenant-x-console host=identity.acme.localhost:28180',
    ]);
  });

  it('limits every request and reports no answer as an admin error with status 0', async () => {
    const hanging = adminFetch({ fetch: () => new Promise<Response>(() => {}), timeoutMs: 20 });
    const slow = hanging(new Request('http://identity.test/api/admin/oauth-clients/x'));
    await expect(slow).rejects.toBeInstanceOf(OAuthAdminError);
    await expect(slow).rejects.toMatchObject({ status: 0 });
    const hangingUpstream = createServer(() => {});
    await new Promise<void>((resolve) => hangingUpstream.listen(0, '127.0.0.1', resolve));
    httpServers.push(hangingUpstream);
    const port = (hangingUpstream.address() as { port: number }).port;
    const stuck = adminFetch({ upstream: `127.0.0.1:${port}`, timeoutMs: 20 });
    await expect(stuck(new Request('http://identity.test/oauth2/token'))).rejects.toThrow(
      'POST http://identity.test/oauth2/token: timed out after 20 ms'.replace('POST', 'GET'),
    );
    const refused = adminFetch({ upstream: '127.0.0.1:1' });
    await expect(refused(new Request('http://identity.test/x'))).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('GET http://identity.test/x: '),
    });
    const failing = adminFetch({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(failing(new Request('http://identity.test/x'))).rejects.toThrow(
      'GET http://identity.test/x: fetch failed',
    );
    // The default limit applies to the plain fetch path: the request carries a timeout signal.
    let signal: AbortSignal | null = null;
    const plain = adminFetch({
      fetch: async (request) => {
        signal = request.signal;
        return new Response(null, { status: 204 });
      },
    });
    await plain(new Request('http://identity.test/x'));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it('reports a registry call or token mint that gets no answer as an admin error', async () => {
    const registry = new HttpOAuthClientRegistry({
      baseUrl: 'http://identity.test',
      token: () => 't',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const failure = registry.get('x');
    await expect(failure).rejects.toBeInstanceOf(OAuthAdminError);
    await expect(failure).rejects.toMatchObject({
      status: 0,
      message: 'GET http://identity.test/api/admin/oauth-clients/x: fetch failed',
    });
    const token = provisionerToken({
      issuer: 'http://identity.test',
      clientId: 'p',
      clientSecret: async () => 's',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(token.get()).rejects.toMatchObject({
      status: 0,
      message: 'POST http://identity.test/oauth2/token: fetch failed',
    });
    // An error the transport already typed passes as it is.
    const typed = provisionerToken({
      issuer: 'http://identity.test',
      clientId: 'p',
      clientSecret: async () => 's',
      fetch: async () => {
        throw new OAuthAdminError(0, 'already typed');
      },
    });
    await expect(typed.get()).rejects.toThrow('already typed');
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
