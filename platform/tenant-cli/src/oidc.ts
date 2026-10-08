/**
 * The identity-server side of a login, for a public native client (RFC 8252): OpenID discovery,
 * PKCE, the authorization URL, and the code, refresh, and revocation calls, all without a
 * client secret. `client_id` alone identifies the CLI; the code verifier is what protects it.
 */

export interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export class OidcError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OidcError';
  }
}

type Fetch = typeof fetch;

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkce(
  verifier = randomToken(32),
): Promise<{ verifier: string; challenge: string }> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export async function discover(issuer: string, doFetch: Fetch = fetch): Promise<ProviderMetadata> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const response = await doFetch(url);
  if (!response.ok)
    throw new OidcError(`discovery at ${issuer} answered ${response.status}`, response.status);
  const metadata = (await response.json()) as Partial<ProviderMetadata>;
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint'] as const) {
    if (!metadata[field]) throw new OidcError(`discovery at ${issuer} lacks ${field}`);
  }
  return metadata as ProviderMetadata;
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

async function tokenRequest(
  endpoint: string,
  form: Record<string, string>,
  doFetch: Fetch,
): Promise<TokenResponse> {
  const response = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  if (!response.ok) {
    let code = `${response.status}`;
    try {
      code = String(((await response.json()) as { error?: string }).error ?? code);
    } catch {
      // No OAuth error body; the status is the message.
    }
    throw new OidcError(
      `token endpoint refused the ${form.grant_type} grant: ${code}`,
      response.status,
    );
  }
  return (await response.json()) as TokenResponse;
}

export function exchangeCode(
  metadata: ProviderMetadata,
  exchange: { clientId: string; redirectUri: string; code: string; codeVerifier: string },
  doFetch: Fetch = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    metadata.token_endpoint,
    {
      grant_type: 'authorization_code',
      client_id: exchange.clientId,
      code: exchange.code,
      redirect_uri: exchange.redirectUri,
      code_verifier: exchange.codeVerifier,
    },
    doFetch,
  );
}

/** Rotates the refresh token; identity-server revokes the family if the old one is replayed. */
export function refreshTokens(
  metadata: ProviderMetadata,
  exchange: { clientId: string; refreshToken: string },
  doFetch: Fetch = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    metadata.token_endpoint,
    {
      grant_type: 'refresh_token',
      client_id: exchange.clientId,
      refresh_token: exchange.refreshToken,
    },
    doFetch,
  );
}

/** RFC 7009; revoking the refresh token ends the whole authorization. Failures are ignored. */
export async function revokeToken(
  metadata: ProviderMetadata,
  clientId: string,
  token: string,
  doFetch: Fetch = fetch,
): Promise<void> {
  const endpoint = metadata.revocation_endpoint ?? `${metadata.issuer}/oauth2/revoke`;
  try {
    await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: clientId }),
    });
  } catch {
    // The credential is forgotten locally either way; the token expires on its own.
  }
}
