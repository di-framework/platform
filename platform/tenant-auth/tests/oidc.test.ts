import { describe, expect, test } from 'bun:test';
import { authorizationUrl, pkce, verifyIdToken } from '../src/oidc.ts';

const metadata = {
  issuer: 'https://issuer.test',
  authorization_endpoint: 'https://issuer.test/oauth2/authorize',
  token_endpoint: 'https://issuer.test/oauth2/token',
  jwks_uri: 'https://issuer.test/oauth2/jwks',
};

async function signedToken(claims: Record<string, unknown>, kid = 'k1') {
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
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode({ alg: 'RS256', kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  return { token: `${signingInput}.${Buffer.from(signature).toString('base64url')}`, jwk };
}

describe('pkce', () => {
  test('matches the RFC 7636 appendix B vector', async () => {
    const { challenge } = await pkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  test('generates distinct verifiers', async () => {
    expect((await pkce()).verifier).not.toBe((await pkce()).verifier);
  });
});

describe('authorizationUrl', () => {
  test('carries S256 and the state and nonce', () => {
    const url = new URL(
      authorizationUrl(metadata, {
        clientId: 'tenant-auth',
        redirectUri: 'http://127.0.0.1:8787/oidc/callback',
        scope: 'openid profile',
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
      }),
    );
    expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('s');
    expect(url.searchParams.get('nonce')).toBe('n');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('verifyIdToken', () => {
  const now = 1_700_000_000;
  const base = {
    iss: metadata.issuer,
    aud: 'tenant-auth',
    exp: now + 60,
    nonce: 'n',
    sub: 'u1',
    preferred_username: 'alice',
  };

  test('accepts a valid token and returns its claims', async () => {
    const { token, jwk } = await signedToken(base);
    const claims = await verifyIdToken(token, metadata, {
      clientId: 'tenant-auth',
      nonce: 'n',
      now,
      keys: [jwk],
    });
    expect(claims.preferred_username).toBe('alice');
  });
  test.each([
    ['issuer', { iss: 'https://other.test' }, 'issuer'],
    ['audience', { aud: 'someone-else' }, 'audience'],
    ['expiry', { exp: now - 1 }, 'expired'],
    ['nonce', { nonce: 'x' }, 'nonce'],
  ])('rejects a bad %s', async (_, override, reason) => {
    const { token, jwk } = await signedToken({ ...base, ...override });
    await expect(
      verifyIdToken(token, metadata, { clientId: 'tenant-auth', nonce: 'n', now, keys: [jwk] }),
    ).rejects.toThrow(reason);
  });
  test('rejects a token signed by another key', async () => {
    const { token } = await signedToken(base);
    const { jwk } = await signedToken(base);
    await expect(
      verifyIdToken(token, metadata, { clientId: 'tenant-auth', nonce: 'n', now, keys: [jwk] }),
    ).rejects.toThrow('signature');
  });
});
