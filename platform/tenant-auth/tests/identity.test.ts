import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AuthError, IdentityResolver } from '../src/identity.ts';
import { createApiKey, type KeyStore } from '../src/keys.ts';
import type { KubeClient, SecretResource, TenantResource, UserResource } from '../src/kube.ts';
import { ORGANIZATION_ROLES_CLAIM, type ProviderMetadata } from '../src/oidc.ts';
import { type FakeServer, json, serve } from './support/servers.ts';

/** Tenancy CRs plus the Secrets the key store writes, all in memory. */
function fakeKube(state: {
  tenants: Record<string, TenantResource>;
  users: Record<string, UserResource>;
}) {
  const secrets = new Map<string, SecretResource>();
  const encode = (value: string) => Buffer.from(value).toString('base64');
  const calls = { getTenant: 0, getUser: 0 };
  const kube = {
    platformNamespace: 'wasmcloud',
    async getTenant(name: string) {
      calls.getTenant++;
      return state.tenants[name];
    },
    async getUser(name: string) {
      calls.getUser++;
      return state.users[name];
    },
    async createSecret(namespace: string, secret: SecretResource) {
      const data = Object.fromEntries(
        Object.entries(secret.stringData ?? {}).map(([k, v]) => [k, encode(v)]),
      );
      const stored = {
        ...secret,
        data,
        metadata: { ...secret.metadata, creationTimestamp: new Date().toISOString() },
      };
      secrets.set(`${namespace}/${secret.metadata.name}`, stored);
      return stored;
    },
    async getSecret(namespace: string, name: string) {
      return secrets.get(`${namespace}/${name}`);
    },
  } as unknown as KubeClient;
  return { kube, calls };
}

describe('IdentityResolver', () => {
  let issuer: FakeServer;
  let metadata: ProviderMetadata;
  const tokens: Record<string, Record<string, unknown> | number> = {};
  beforeAll(() => {
    issuer = serve((request) => {
      if (request.path !== '/userinfo') return json({}, 404);
      const token = request.headers.get('authorization')?.slice(7) ?? '';
      const answer = tokens[token];
      if (answer === undefined) return json({ error: 'invalid_token' }, 401);
      if (typeof answer === 'number') return new Response('x', { status: answer });
      return json(answer);
    });
    metadata = {
      issuer: issuer.url,
      authorization_endpoint: `${issuer.url}/oauth2/authorize`,
      token_endpoint: `${issuer.url}/oauth2/token`,
      jwks_uri: `${issuer.url}/oauth2/jwks`,
    };
  });
  afterAll(() => issuer.stop());

  const state = () => ({
    tenants: { acme: { metadata: { name: 'acme' }, spec: {} } } as Record<string, TenantResource>,
    users: {
      alice: {
        metadata: { name: 'alice' },
        spec: { memberships: [{ tenant: 'acme', role: 'developer' as const }] },
      },
      bob: {
        metadata: { name: 'bob' },
        spec: { memberships: [{ tenant: 'other', role: 'viewer' as const }] },
      },
      carol: { metadata: { name: 'carol' }, spec: { suspended: true, memberships: [] } },
    } as Record<string, UserResource>,
  });
  const resolverFor = (s = state()) => {
    const { kube, calls } = fakeKube(s);
    const keys: KeyStore = { kube, namespace: 'di-runtime-acme', tenant: 'acme' };
    return { resolver: new IdentityResolver(kube, metadata, 'acme', keys), keys, calls, state: s };
  };
  const member = (user: string, slug = 'acme') => ({
    sub: `sub-${user}`,
    preferred_username: user,
    [ORGANIZATION_ROLES_CLAIM]: [{ slug, role: 'MEMBER' }],
  });
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  };

  test('requires a bearer token', async () => {
    const { resolver } = resolverFor();
    expect((await failure(resolver.resolve(null))).status).toBe(401);
    expect((await failure(resolver.resolve('Basic abc'))).status).toBe(401);
    expect((await failure(resolver.resolve('Bearer '))).status).toBe(401);
  });

  test('resolves an identity token through userinfo and caches the claims', async () => {
    const { resolver, calls } = resolverFor();
    tokens.alice = member('alice');
    const principal = await resolver.resolve('Bearer alice');
    expect(principal).toEqual({
      user: 'alice',
      account: 'acme',
      role: 'developer',
      via: 'identity',
      credentialId: 'sub-alice',
    });
    const before = issuer.requests.length;
    expect(await resolver.resolve('Bearer alice')).toEqual(principal);
    expect(issuer.requests.length).toBe(before);
    expect(calls.getUser).toBe(1);
    resolver.forget('alice');
    await resolver.resolve('Bearer alice');
    expect(calls.getUser).toBe(2);
  });

  test('rejects tokens the provider refuses or that name no usable user', async () => {
    const { resolver } = resolverFor();
    tokens.nobody = { sub: 'x', [ORGANIZATION_ROLES_CLAIM]: [{ slug: 'acme', role: 'MEMBER' }] };
    tokens.weird = member('Alice Smith');
    tokens.outsider = member('alice', 'other');
    tokens.bare = { sub: 'x', preferred_username: 'alice' };
    tokens.broken = 500;
    expect((await failure(resolver.resolve('Bearer unknown'))).message).toContain(
      'invalid or has expired',
    );
    expect((await failure(resolver.resolve('Bearer nobody'))).status).toBe(403);
    expect((await failure(resolver.resolve('Bearer weird'))).message).toContain('no usable login');
    expect((await failure(resolver.resolve('Bearer outsider'))).message).toContain(
      'not a member of organization acme',
    );
    expect((await failure(resolver.resolve('Bearer bare'))).status).toBe(403);
    await expect(resolver.resolve('Bearer broken')).rejects.toThrow('userinfo returned 500');
  });

  test('checks the platform membership behind an identity', async () => {
    tokens.bob = member('bob');
    tokens.carol = member('carol');
    tokens.dave = member('dave');
    const { resolver, state: s } = resolverFor();
    expect((await failure(resolver.resolve('Bearer bob'))).message).toBe(
      'bob is not a member of acme',
    );
    expect((await failure(resolver.resolve('Bearer carol'))).message).toBe(
      'carol has no active platform user',
    );
    expect((await failure(resolver.resolve('Bearer dave'))).message).toBe(
      'dave has no active platform user',
    );
    s.tenants.acme = { metadata: { name: 'acme' }, spec: { suspended: true } };
    expect((await failure(resolver.resolve('Bearer alice'))).message).toBe(
      'account acme is suspended',
    );
    delete s.tenants.acme;
    expect((await failure(resolver.resolve('Bearer alice'))).status).toBe(404);
  });

  test('resolves API keys and maps key failures to 401', async () => {
    const { resolver, keys } = resolverFor();
    const issued = await createApiKey(keys, 'alice', 'ci', 3600);
    expect(await resolver.resolve(`Bearer ${issued.secret}`)).toEqual({
      user: 'alice',
      account: 'acme',
      role: 'developer',
      via: 'api-key',
      credentialId: issued.id,
    });
    const forged = issued.secret.slice(0, -1) + (issued.secret.endsWith('a') ? 'b' : 'a');
    const denied = await failure(resolver.resolve(`Bearer ${forged}`));
    expect(denied.status).toBe(401);
    expect(denied.message).toContain('unknown or revoked');
    const bobKey = await createApiKey(keys, 'bob', 'ci', 3600);
    expect((await failure(resolver.resolve(`Bearer ${bobKey.secret}`))).status).toBe(403);
  });
});
