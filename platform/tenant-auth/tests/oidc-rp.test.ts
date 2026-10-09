import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
  discover,
  exchangeCode,
  type ProviderMetadata,
  refreshTokens,
  revokeToken,
  userinfo,
  verifyIdToken,
} from '../src/oidc.ts';
import { type FakeServer, json, serve } from './support/servers.ts';

async function keyPair(kid: string) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  const sign = async (
    claims: Record<string, unknown>,
    header: Record<string, unknown> = { alg: 'RS256', kid },
  ) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode(header)}.${encode(claims)}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(input),
    );
    return `${input}.${Buffer.from(signature).toString('base64url')}`;
  };
  return { jwk, sign };
}

describe('discover', () => {
  let issuer: FakeServer;
  let failures = 0;
  let document: Partial<ProviderMetadata> = {};
  beforeAll(() => {
    issuer = serve((request) => {
      if (request.path !== '/.well-known/openid-configuration') return json({}, 404);
      if (failures > 0) {
        failures--;
        return new Response('starting', { status: 503 });
      }
      return json(document);
    });
    document = {
      issuer: issuer.url,
      authorization_endpoint: `${issuer.url}/oauth2/authorize`,
      token_endpoint: `${issuer.url}/oauth2/token`,
      jwks_uri: `${issuer.url}/oauth2/jwks`,
    };
  });
  afterAll(() => issuer.stop());

  test('returns the metadata and strips a trailing slash', async () => {
    expect(await discover(`${issuer.url}/`, 1)).toEqual(document as ProviderMetadata);
  });
  test('retries a provider that is not ready yet', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      failures = 1;
      expect((await discover(issuer.url, 2)).issuer).toBe(issuer.url);
      expect(log.mock.calls[0]?.[0]).toContain('not ready (503)');
    } finally {
      log.mockRestore();
    }
  });
  test('gives up after the last attempt', async () => {
    failures = 1;
    await expect(discover(issuer.url, 1)).rejects.toThrow('returned 503');
    await expect(discover('http://127.0.0.1:1', 1)).rejects.toThrow('returned no response');
  });
  test('rejects an incomplete document', async () => {
    const { jwks_uri: _, ...partial } = document;
    document = partial;
    await expect(discover(issuer.url, 1)).rejects.toThrow('lacks jwks_uri');
  });
});

describe('token endpoint calls', () => {
  let issuer: FakeServer;
  let metadata: ProviderMetadata & { revocation_endpoint?: string };
  let fail = false;
  beforeAll(() => {
    issuer = serve((request) => {
      if (fail) return json({ error: 'invalid_grant' }, 400);
      if (request.path === '/oauth2/token') {
        const form = new URLSearchParams(request.body);
        return json({ access_token: `at-${form.get('grant_type')}`, token_type: 'Bearer' });
      }
      if (request.path === '/oauth2/revoke' || request.path === '/custom/revoke')
        return new Response(null, { status: 200 });
      if (request.pathname === '/userinfo') {
        const auth = request.headers.get('authorization');
        if (auth === 'Bearer good') return json({ sub: 'u1', preferred_username: 'alice' });
        if (auth === 'Bearer broken') return new Response('x', { status: 500 });
        return json({ error: 'invalid_token' }, 401);
      }
      return json({}, 404);
    });
    metadata = {
      issuer: issuer.url,
      authorization_endpoint: `${issuer.url}/oauth2/authorize`,
      token_endpoint: `${issuer.url}/oauth2/token`,
      jwks_uri: `${issuer.url}/oauth2/jwks`,
    };
  });
  afterAll(() => issuer.stop());
  const basic = Buffer.from('tenant-auth:s3cret').toString('base64');

  test('exchanges a code with the client credentials and PKCE verifier', async () => {
    const tokens = await exchangeCode(metadata, {
      clientId: 'tenant-auth',
      clientSecret: 's3cret',
      redirectUri: 'http://console/oidc/callback',
      code: 'c',
      codeVerifier: 'v',
    });
    expect(tokens.access_token).toBe('at-authorization_code');
    const sent = issuer.requests.at(-1);
    expect(sent?.headers.get('authorization')).toBe(`Basic ${basic}`);
    expect(new URLSearchParams(sent?.body).get('code_verifier')).toBe('v');
  });
  test('rotates a refresh token', async () => {
    const tokens = await refreshTokens(metadata, {
      clientId: 'tenant-auth',
      clientSecret: 's3cret',
      refreshToken: 'r',
    });
    expect(tokens.access_token).toBe('at-refresh_token');
    expect(new URLSearchParams(issuer.requests.at(-1)?.body).get('refresh_token')).toBe('r');
  });
  test('revokes at the advertised or the default endpoint', async () => {
    await revokeToken(metadata, 'tenant-auth', 's3cret', 'r');
    expect(issuer.requests.at(-1)?.path).toBe('/oauth2/revoke');
    await revokeToken(
      { ...metadata, revocation_endpoint: `${issuer.url}/custom/revoke` },
      'tenant-auth',
      's3cret',
      'r',
    );
    expect(issuer.requests.at(-1)?.path).toBe('/custom/revoke');
    expect(new URLSearchParams(issuer.requests.at(-1)?.body).get('token')).toBe('r');
  });
  test('resolves userinfo, treating a rejected token as no user', async () => {
    expect((await userinfo(metadata, 'good'))?.preferred_username).toBe('alice');
    expect(await userinfo(metadata, 'bad')).toBeUndefined();
    await expect(userinfo(metadata, 'broken')).rejects.toThrow('userinfo returned 500');
    await userinfo({ ...metadata, userinfo_endpoint: `${issuer.url}/userinfo?x=1` }, 'good');
    expect(issuer.requests.at(-1)?.path).toBe('/userinfo?x=1');
  });
  test('surfaces token endpoint errors with their body', async () => {
    fail = true;
    try {
      await expect(
        exchangeCode(metadata, {
          clientId: 'a',
          clientSecret: 'b',
          redirectUri: 'c',
          code: 'd',
          codeVerifier: 'e',
        }),
      ).rejects.toThrow('token endpoint returned 400: {"error":"invalid_grant"}');
      await expect(
        refreshTokens(metadata, { clientId: 'a', clientSecret: 'b', refreshToken: 'r' }),
      ).rejects.toThrow('returned 400');
    } finally {
      fail = false;
    }
  });
});

describe('verifyIdToken against a published JWKS', () => {
  let issuer: FakeServer;
  let published: JsonWebKey[] = [];
  let jwksStatus = 200;
  const now = 1_700_000_000;
  beforeAll(() => {
    issuer = serve((request) =>
      request.pathname === '/oauth2/jwks' ? json({ keys: published }, jwksStatus) : json({}, 404),
    );
  });
  afterAll(() => issuer.stop());
  const metadataFor = (path: string): ProviderMetadata => ({
    issuer: 'https://issuer.test',
    authorization_endpoint: 'https://issuer.test/oauth2/authorize',
    token_endpoint: 'https://issuer.test/oauth2/token',
    jwks_uri: `${issuer.url}${path}`,
  });
  const claims = {
    iss: 'https://issuer.test',
    aud: 'tenant-auth',
    exp: now + 60,
    nonce: 'n',
    sub: 'u1',
  };
  const verification = { clientId: 'tenant-auth', nonce: 'n', now };

  test('fetches the keys once, then refetches when a kid is unknown', async () => {
    const first = await keyPair('k1');
    const second = await keyPair('k2');
    published = [first.jwk];
    const metadata = metadataFor('/oauth2/jwks');
    expect((await verifyIdToken(await first.sign(claims), metadata, verification)).sub).toBe('u1');
    expect((await verifyIdToken(await first.sign(claims), metadata, verification)).sub).toBe('u1');
    expect(issuer.requests).toHaveLength(1);
    published = [first.jwk, second.jwk];
    expect((await verifyIdToken(await second.sign(claims), metadata, verification)).sub).toBe('u1');
    expect(issuer.requests).toHaveLength(2);
    const third = await keyPair('k3');
    await expect(verifyIdToken(await third.sign(claims), metadata, verification)).rejects.toThrow(
      'key k3 is not published',
    );
  });
  test('matches an RSA key without a kid', async () => {
    const pair = await keyPair('ignored');
    const { kid: _, ...bare } = pair.jwk;
    published = [bare];
    const token = await pair.sign(claims, { alg: 'RS256' });
    expect((await verifyIdToken(token, metadataFor('/oauth2/jwks?v=2'), verification)).sub).toBe(
      'u1',
    );
  });
  test('rejects malformed tokens and other algorithms', async () => {
    const pair = await keyPair('k1');
    await expect(verifyIdToken('nope', metadataFor('/oauth2/jwks'), verification)).rejects.toThrow(
      'not a JWS',
    );
    await expect(
      verifyIdToken(
        await pair.sign(claims, { alg: 'HS256', kid: 'k1' }),
        metadataFor('/oauth2/jwks'),
        {
          ...verification,
          keys: [pair.jwk],
        },
      ),
    ).rejects.toThrow('unsupported ID token algorithm HS256');
    await expect(
      verifyIdToken(await pair.sign(claims), metadataFor('/oauth2/jwks'), {
        ...verification,
        keys: [],
      }),
    ).rejects.toThrow('not published');
  });
  test('reports a JWKS endpoint failure', async () => {
    jwksStatus = 500;
    const pair = await keyPair('k9');
    await expect(
      verifyIdToken(await pair.sign(claims), metadataFor('/oauth2/jwks?v=3'), verification),
    ).rejects.toThrow('JWKS at');
  });
});
