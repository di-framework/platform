import { expect, test } from 'bun:test';
import {
  authorizationUrl,
  discover,
  exchangeCode,
  OidcError,
  pkce,
  randomToken,
  refreshTokens,
  revokeToken,
} from '../src/oidc.ts';
import { fakeFetch, type Recorded } from './support/fake-fetch.ts';

const metadata = {
  issuer: 'https://issuer.test',
  authorization_endpoint: 'https://issuer.test/oauth2/authorize',
  token_endpoint: 'https://issuer.test/oauth2/token',
};

test('pkce derives the S256 challenge of the verifier (RFC 7636 appendix B)', async () => {
  const known = await pkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  expect(known.challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const fresh = await pkce();
  expect(fresh.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(randomToken(16)).toHaveLength(22);
});

test('discovery needs the three endpoints and an ok answer', async () => {
  const { fetch } = fakeFetch({
    'GET /.well-known/openid-configuration': () => Response.json(metadata),
  });
  expect(await discover('https://issuer.test/', fetch)).toEqual(metadata);
  const { fetch: partial } = fakeFetch({
    'GET /.well-known/openid-configuration': () => Response.json({ issuer: 'x' }),
  });
  await expect(discover('https://issuer.test', partial)).rejects.toThrow(
    'lacks authorization_endpoint',
  );
  const { fetch: elsewhere } = fakeFetch({
    'GET /.well-known/openid-configuration': () =>
      Response.json({ ...metadata, token_endpoint: 'https://attacker.test/oauth2/token' }),
  });
  await expect(discover('https://issuer.test', elsewhere)).rejects.toThrow(
    'token_endpoint is not under the issuer',
  );
  const { fetch: down } = fakeFetch({});
  await expect(discover('https://issuer.test', down)).rejects.toMatchObject({
    name: 'OidcError',
    status: 404,
  });
});

test('the authorization URL carries the PKCE challenge and the loopback redirect', () => {
  const url = new URL(
    authorizationUrl(metadata, {
      clientId: 'tenant-cli',
      redirectUri: 'http://127.0.0.1:5000/callback',
      scope: 'openid',
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
    }),
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: 'code',
    client_id: 'tenant-cli',
    redirect_uri: 'http://127.0.0.1:5000/callback',
    scope: 'openid',
    state: 's',
    nonce: 'n',
    code_challenge: 'c',
    code_challenge_method: 'S256',
  });
});

test('code and refresh grants send the public client id only, and surface OAuth errors', async () => {
  const seen: Recorded[] = [];
  const { fetch } = fakeFetch({
    'POST /oauth2/token': (call: Recorded) => {
      seen.push(call);
      const form = call.body as Record<string, string>;
      if (form.code === 'bad') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (form.code === 'broken') return new Response('html', { status: 502 });
      return Response.json({ access_token: 'a', token_type: 'Bearer', expires_in: 60 });
    },
  });
  await exchangeCode(
    metadata,
    { clientId: 'tenant-cli', redirectUri: 'r', code: 'ok', codeVerifier: 'v' },
    fetch,
  );
  await refreshTokens(metadata, { clientId: 'tenant-cli', refreshToken: 'rt' }, fetch);
  expect(seen.map((call) => call.body)).toEqual([
    {
      grant_type: 'authorization_code',
      client_id: 'tenant-cli',
      code: 'ok',
      redirect_uri: 'r',
      code_verifier: 'v',
    },
    { grant_type: 'refresh_token', client_id: 'tenant-cli', refresh_token: 'rt' },
  ]);
  expect(seen[0]?.headers.authorization).toBeUndefined();
  await expect(
    exchangeCode(
      metadata,
      { clientId: 'c', redirectUri: 'r', code: 'bad', codeVerifier: 'v' },
      fetch,
    ),
  ).rejects.toThrow('token endpoint refused the authorization_code grant: invalid_grant');
  const broken = await exchangeCode(
    metadata,
    { clientId: 'c', redirectUri: 'r', code: 'broken', codeVerifier: 'v' },
    fetch,
  ).catch((error: unknown) => error);
  expect(broken).toBeInstanceOf(OidcError);
  expect(broken).toMatchObject({
    status: 502,
    message: 'token endpoint refused the authorization_code grant: 502',
  });
});

test('revocation posts the token with the client id and swallows failures', async () => {
  const { fetch, calls } = fakeFetch({
    'POST /oauth2/revoke': () => new Response(null, { status: 200 }),
  });
  await revokeToken(metadata, 'tenant-cli', 'rt', fetch);
  expect(calls[0]).toMatchObject({
    url: 'https://issuer.test/oauth2/revoke',
    body: { token: 'rt', client_id: 'tenant-cli' },
  });
  await revokeToken(
    { ...metadata, revocation_endpoint: 'https://issuer.test/revoke2' },
    'c',
    't',
    fetch,
  );
  expect(calls[1]?.url).toBe('https://issuer.test/revoke2');
  const down = (async () => {
    throw new TypeError('offline');
  }) as unknown as typeof globalThis.fetch;
  await expect(revokeToken(metadata, 'c', 't', down)).resolves.toBeUndefined();
});
