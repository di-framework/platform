/**
 * A small OpenID Connect relying party: discovery, PKCE authorization-code flow, and RS256 ID
 * token verification against the issuer's JWKS. The broker is a confidential client, so
 * identity-server needs no public-client or device-code support.
 */

export const ORGANIZATION_ROLES_CLAIM = 'https://gsio.ltd/claims/organization_roles';

export interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}
export interface OrganizationRole {
  slug: string;
  role: string;
}
export interface IdentityClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  preferred_username?: string;
  name?: string;
  email?: string;
  [ORGANIZATION_ROLES_CLAIM]?: OrganizationRole[];
  [claim: string]: unknown;
}
export interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
}

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** RFC 7636 S256 verifier and challenge. */
export async function pkce(
  verifier = randomToken(32),
): Promise<{ verifier: string; challenge: string }> {
  return { verifier, challenge: base64url(await sha256(verifier)) };
}

/**
 * Fetch provider metadata. A freshly started provider (or a Wasm guest still bootstrapping) can
 * answer 5xx or refuse connections for a while, so startup retries with backoff instead of
 * crashing the pod.
 */
export async function discover(issuer: string, attempts = 20): Promise<ProviderMetadata> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  let response: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) break;
    } catch {
      response = undefined;
    }
    if (attempt === attempts) break;
    console.error(
      `OIDC discovery at ${issuer} not ready (${response?.status ?? 'unreachable'}); retrying`,
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 2_000 * attempt)));
  }
  if (!response?.ok)
    throw new Error(`OIDC discovery at ${issuer} returned ${response?.status ?? 'no response'}`);
  const metadata = (await response.json()) as ProviderMetadata;
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)
    if (!metadata[field]) throw new Error(`OIDC discovery at ${issuer} lacks ${field}`);
  return metadata;
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}
export function authorizationUrl(
  metadata: ProviderMetadata,
  request: AuthorizationRequest,
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: request.scope,
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export interface CodeExchange {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}
export async function exchangeCode(
  metadata: ProviderMetadata,
  exchange: CodeExchange,
): Promise<TokenResponse> {
  const basic = Buffer.from(`${exchange.clientId}:${exchange.clientSecret}`).toString('base64');
  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: exchange.code,
      redirect_uri: exchange.redirectUri,
      code_verifier: exchange.codeVerifier,
    }),
  });
  if (!response.ok) {
    // The body is an OAuth error object, never a credential; the message helps debugging.
    throw new Error(`token endpoint returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

async function jwks(uri: string, force = false): Promise<Jwk[]> {
  const cached = jwksCache.get(uri);
  if (!force && cached && Date.now() - cached.fetchedAt < 300_000) return cached.keys;
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`JWKS at ${uri} returned ${response.status}`);
  const { keys } = (await response.json()) as { keys: Jwk[] };
  jwksCache.set(uri, { keys, fetchedAt: Date.now() });
  return keys;
}

export interface Verification {
  clientId: string;
  nonce: string;
  now?: number;
  /** Override key lookup, for tests. */
  keys?: Jwk[];
}

/** Verify an RS256 ID token's signature, issuer, audience, expiry, and nonce. */
export async function verifyIdToken(
  idToken: string,
  metadata: ProviderMetadata,
  verification: Verification,
): Promise<IdentityClaims> {
  const [rawHeader, rawPayload, rawSignature] = idToken.split('.');
  if (!rawHeader || !rawPayload || !rawSignature) throw new Error('ID token is not a JWS');
  const header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString()) as {
    alg: string;
    kid?: string;
  };
  if (header.alg !== 'RS256') throw new Error(`unsupported ID token algorithm ${header.alg}`);
  const find = (keys: Jwk[]) =>
    keys.find((k) => (header.kid ? k.kid === header.kid : k.kty === 'RSA'));
  let key = find(verification.keys ?? (await jwks(metadata.jwks_uri)));
  if (!key && !verification.keys) key = find(await jwks(metadata.jwks_uri, true));
  if (!key) throw new Error(`ID token key ${header.kid ?? '(none)'} is not published`);
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: key.kty, n: key.n, e: key.e },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    Buffer.from(rawSignature, 'base64url'),
    encoder.encode(`${rawHeader}.${rawPayload}`),
  );
  if (!valid) throw new Error('ID token signature is invalid');
  const claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString()) as IdentityClaims;
  const now = verification.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== metadata.issuer) throw new Error('ID token issuer mismatch');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(verification.clientId)) throw new Error('ID token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('ID token has expired');
  if (claims.nonce !== verification.nonce) throw new Error('ID token nonce mismatch');
  return claims;
}

export interface RefreshExchange {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}
/** Rotate a refresh token. identity-server revokes the whole family if an old one is replayed. */
export async function refreshTokens(
  metadata: ProviderMetadata,
  exchange: RefreshExchange,
): Promise<TokenResponse> {
  const basic = Buffer.from(`${exchange.clientId}:${exchange.clientSecret}`).toString('base64');
  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: exchange.refreshToken,
    }),
  });
  if (!response.ok)
    throw new Error(`token endpoint returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as TokenResponse;
}

/** Revoke a token (RFC 7009). Revoking the refresh token ends the whole authorization. */
export async function revokeToken(
  metadata: ProviderMetadata & { revocation_endpoint?: string },
  clientId: string,
  clientSecret: string,
  token: string,
): Promise<void> {
  const endpoint = metadata.revocation_endpoint ?? `${metadata.issuer}/oauth2/revoke`;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token }),
  });
}

/**
 * Resolve an access token to its user through UserInfo. The provider checks the token itself, so
 * a resource server needs no client secret. Returns undefined for a token the provider rejects.
 */
export async function userinfo(
  metadata: ProviderMetadata,
  accessToken: string,
): Promise<IdentityClaims | undefined> {
  const endpoint = metadata.userinfo_endpoint ?? `${metadata.issuer}/userinfo`;
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.status === 401 || response.status === 403) return undefined;
  if (!response.ok) throw new Error(`userinfo returned ${response.status}`);
  return (await response.json()) as IdentityClaims;
}
