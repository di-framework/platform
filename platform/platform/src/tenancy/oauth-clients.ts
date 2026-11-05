/**
 * Per-tenant OAuth clients (#59). Each tenant gets two clients in the identity server instead of
 * sharing the bootstrap `access` client: a confidential one for its console, whose secret lives in
 * the tenant's `tenant-console-oauth` Secret ({@link CONSOLE_OAUTH_SECRET}), and a public PKCE one
 * for its CLI, which the tenant controller names through `TENANT_CONTROLLER_CLI_CLIENT_ID`. Tenancy
 * reconcile registers them through {@link OAuthClientRegistry} and removal step R6 revokes them.
 *
 * The contract is the identity-server admin API, `/api/admin/oauth-clients` as
 * di-framework/identity-server#48 ships it (`docs/admin-oauth-clients.md` there): `audiences[]`
 * (token `aud` values), `tokenEndpointAuthMethod` (`client_secret_basic`, the default, or `none`
 * for a public PKCE client on loopback `http` redirects), a required `organizationSlug`, and
 * keyed creates and rotations. The tests run the contract against a fake admin API and, opt-in,
 * against a real identity server (`oauth-clients.test.ts`).
 *
 * Idempotency: create and rotate send an `Idempotency-Key` derived from the tenant uid, the client
 * role and (for rotate) the rotation version ({@link tenantIdempotencyKey}). The identity server
 * then derives the secret from the key (`ClientSecrets.sign`), so a repeated create replays 201
 * with the same secret and a repeated rotate of the same version returns the same secret.
 *
 * Known limits:
 * - Drift is not corrected: an existing client's redirect URIs, scopes, audiences and organization
 *   are never compared with the spec. The admin API has `PUT /api/admin/oauth-clients/:id`
 *   (`UpdateOAuthClientRequest`, which needs `organizationSlug` and cannot change the auth
 *   method); the seam gains `update` when something needs it.
 * - `delete` treats 404 as success, so a `baseUrl` with a wrong path prefix (the router answers
 *   404 for unknown `/api/*` paths) makes deletes look successful. `baseUrl` must be the origin.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TenantAuthConfig } from './resources';
import { tenantConsolePublicUrl, tenantControllerPublicUrl } from './resources';

/** The runtime-namespace Secret holding the console client's id and secret. */
export const CONSOLE_OAUTH_SECRET = 'tenant-console-oauth';
/** What the console and the CLI request; both bootstrap clients had the same scopes. */
export const TENANT_OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;
/** The CLI's loopback callback; the port is matched at authorize time (RFC 8252). */
export const CLI_REDIRECT_URI = 'http://127.0.0.1/callback';

/** A client the registry should hold. */
export interface OAuthClientSpec {
  clientId: string;
  /** The tenant the client belongs to; required by the admin API. */
  organizationSlug: string;
  redirectUris: string[];
  scopes: string[];
  /** Token `aud` values; the identity server defaults to `[clientId]`. */
  audiences: string[];
  /**
   * A public PKCE client (`tokenEndpointAuthMethod: none`) has no secret; its redirect URIs must
   * be loopback `http` URIs.
   */
  public: boolean;
}

/** A client as the registry reports it. */
export interface OAuthClientRecord extends OAuthClientSpec {
  /** Set once the client is deleted; the identity server keeps revoked ids. */
  revokedAt?: string;
  createdAt?: string;
}

/** What creating or rotating a client returns. `clientSecret` is absent for public clients. */
export interface OAuthClientCredentials {
  clientId: string;
  clientSecret?: string;
}

/**
 * The per-tenant client admin seam. Implementations: {@link HttpOAuthClientRegistry} (the
 * identity-server admin API) and the test fake.
 */
export interface OAuthClientRegistry {
  /**
   * Registers `spec`. Throws {@link OAuthClientConflict} if the id exists, revoked or not, unless
   * `idempotencyKey` repeats the create that made it (then it replays the same credentials).
   */
  create(spec: OAuthClientSpec, idempotencyKey?: string): Promise<OAuthClientCredentials>;
  /** The client, revoked ones included; `undefined` if it never existed. */
  get(clientId: string): Promise<OAuthClientRecord | undefined>;
  /**
   * Issues a new secret for a confidential client. The identity server requires a non-empty
   * `version` but only uses it with `idempotencyKey`: the secret is then derived from both, so
   * repeating a rotation returns the same secret. Without a key every call issues a random one.
   * Throws {@link OAuthClientNotFound} for an unknown id and {@link OAuthClientConflict} for a
   * revoked or public client.
   */
  rotate(
    clientId: string,
    version: string,
    idempotencyKey?: string,
  ): Promise<OAuthClientCredentials>;
  /** Revokes the client. Idempotent: unknown and already revoked ids succeed. */
  delete(clientId: string): Promise<void>;
}

/** The admin API refused a request; `status` is its HTTP status. */
export class OAuthAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
/** The id is taken, or the client is revoked or public where that is not allowed (409). */
export class OAuthClientConflict extends OAuthAdminError {}
/** The client id is revoked and can never be reused: stop, do not retry. */
export class OAuthClientRevoked extends OAuthClientConflict {}
/** No client has that id (404). */
export class OAuthClientNotFound extends OAuthAdminError {}

/** The admin error for `status`, typed for the statuses the contract names. */
export function oauthAdminError(status: number, message: string): OAuthAdminError {
  if (status === 409) return new OAuthClientConflict(status, message);
  if (status === 404) return new OAuthClientNotFound(status, message);
  return new OAuthAdminError(status, message);
}

/** The tenant identity client ids derive from. */
export interface TenantRef {
  name: string;
  /** The Tenant object's uid; a tenant recreated under the same name gets new ids. */
  uid: string;
}

/** The ids of a tenant's console and CLI clients (at most 100 characters, as the API allows). */
export function tenantOAuthClientIds(tenant: TenantRef): { console: string; cli: string } {
  const base = `tenant-${tenant.name}-${tenant.uid.replaceAll('-', '').slice(0, 8)}`;
  return { console: `${base}-console`, cli: `${base}-cli` };
}

/** The `Idempotency-Key` for an operation on one of a tenant's clients. */
export function tenantIdempotencyKey(
  tenant: TenantRef,
  role: 'console' | 'cli',
  operation: 'create' | `rotate-${string}`,
): string {
  return `platform-tenant-${tenant.uid}-${role}-${operation}`;
}

/** Where a tenant's clients redirect and what they may request. */
export interface TenantOAuthOptions {
  /** The console's authorization-code callback URLs. */
  consoleRedirectUris: string[];
  /** The CLI's loopback callback URLs. */
  cliRedirectUris: string[];
  scopes: string[];
  audiences: string[];
}

/**
 * The options reconcile registers a tenant's clients with: the console's `/oidc/callback` on its
 * public URL, the CLI's loopback callback, the scopes both request, and the tenant controller's
 * public URL as the token audience (it is the resource server both clients call).
 */
export function tenantOAuthOptions(tenant: string, auth: TenantAuthConfig): TenantOAuthOptions {
  return {
    consoleRedirectUris: [`${tenantConsolePublicUrl(tenant, auth)}/oidc/callback`],
    cliRedirectUris: [CLI_REDIRECT_URI],
    scopes: [...TENANT_OAUTH_SCOPES],
    audiences: [tenantControllerPublicUrl(tenant, auth)],
  };
}

/** The two clients a tenant should have. */
export function tenantOAuthClients(
  tenant: TenantRef,
  options: TenantOAuthOptions,
): { console: OAuthClientSpec; cli: OAuthClientSpec } {
  const ids = tenantOAuthClientIds(tenant);
  const common = {
    organizationSlug: tenant.name,
    scopes: options.scopes,
    audiences: options.audiences,
  };
  return {
    console: {
      ...common,
      clientId: ids.console,
      redirectUris: options.consoleRedirectUris,
      public: false,
    },
    cli: { ...common, clientId: ids.cli, redirectUris: options.cliRedirectUris, public: true },
  };
}

/**
 * The console secret `tenant-console-oauth` holds for `consoleClientId` (base64, as Secret data),
 * or `undefined` when the Secret is missing, holds another client's secret (a tenant recreated
 * under the same name in a retained namespace) or has none.
 */
export function storedConsoleSecret(
  data: Record<string, string> | undefined,
  consoleClientId: string,
): string | undefined {
  const clientId = Buffer.from(data?.clientId ?? '', 'base64').toString();
  return clientId === consoleClientId && data?.clientSecret ? data.clientSecret : undefined;
}

/**
 * Makes sure the tenant's clients exist. A new console client returns its secret; an existing one
 * returns none unless `consoleSecretStored` is false (the secret was never stored, e.g. reconcile
 * stopped between create and writing `tenant-console-oauth`), in which case it is rotated to
 * `rotationVersion`. Creates and rotations are keyed, so a concurrent or repeated reconcile gets
 * the same secret back. A keyed create that answers 409 is retried once before the client is
 * re-read: on a database that commits every statement on its own (the wasmCloud guest) a create
 * that loses a race with another reconcile's can answer 409 while the winner's idempotency record
 * is not committed yet, and re-reading at once would rotate a console secret the winner is about
 * to store. The retry replays the winner's 201 with the same secret; a 409 that persists (the id
 * is taken under another key) re-reads the client and carries on. A revoked client throws
 * {@link OAuthClientRevoked}: its id cannot be reused. The CLI client is ensured first so a
 * failure there cannot strand a fresh console secret.
 */
export async function ensureTenantOAuthClients(
  registry: OAuthClientRegistry,
  tenant: TenantRef,
  options: TenantOAuthOptions & { consoleSecretStored: boolean; rotationVersion: string },
): Promise<{ console: OAuthClientCredentials; cli: OAuthClientCredentials }> {
  const specs = tenantOAuthClients(tenant, options);
  const existing = async (spec: OAuthClientSpec, role: 'console' | 'cli', needSecret: boolean) => {
    const client = await registry.get(spec.clientId);
    if (!client) return undefined;
    if (client.revokedAt)
      throw new OAuthClientRevoked(409, `OAuth client ${spec.clientId} is revoked`);
    if (!needSecret) return { clientId: spec.clientId };
    const operation = `rotate-${options.rotationVersion}` as const;
    const key = tenantIdempotencyKey(tenant, role, operation);
    return registry.rotate(spec.clientId, options.rotationVersion, key);
  };
  const ensure = async (spec: OAuthClientSpec, role: 'console' | 'cli', needSecret: boolean) => {
    const found = await existing(spec, role, needSecret);
    if (found) return found;
    const key = tenantIdempotencyKey(tenant, role, 'create');
    let conflict: OAuthClientConflict | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await registry.create(spec, key);
      } catch (error) {
        if (!(error instanceof OAuthClientConflict)) throw error;
        conflict = error;
      }
    }
    const raced = await existing(spec, role, needSecret);
    if (raced) return raced;
    throw conflict;
  };
  const cli = await ensure(specs.cli, 'cli', false);
  return { console: await ensure(specs.console, 'console', !options.consoleSecretStored), cli };
}

/**
 * Revokes the tenant's clients, each on its own, and returns the ones that could not be revoked
 * with why. Safe to repeat: a revoked or unknown id succeeds.
 */
export async function removeTenantOAuthClients(
  registry: OAuthClientRegistry,
  tenant: TenantRef,
): Promise<{ clientId: string; error: unknown }[]> {
  const ids = tenantOAuthClientIds(tenant);
  const failed: { clientId: string; error: unknown }[] = [];
  for (const clientId of [ids.console, ids.cli]) {
    try {
      await registry.delete(clientId);
    } catch (error) {
      failed.push({ clientId, error });
    }
  }
  return failed;
}

/** `OAuthClientResponse` as identity-server#48 answers it. */
interface OAuthClientResponse {
  client_id: string;
  organization_slug?: string | null;
  redirect_uris?: string[];
  scopes?: string[];
  audiences?: string[];
  token_endpoint_auth_method?: 'client_secret_basic' | 'none';
  revoked_at?: string | null;
  created_at?: string;
}

/** Connection settings for {@link HttpOAuthClientRegistry}. */
export interface HttpOAuthClientRegistryOptions {
  /**
   * The identity server origin only, e.g. `https://identity.example.com`, with no path: a wrong
   * path prefix answers 404, which `get` reports as missing and `delete` as success.
   */
  baseUrl: string;
  /** The admin bearer token (the provisioner client's in reconcile). */
  token: () => string | Promise<string>;
  /**
   * Called when the admin API answers 401 for a token; the request is then sent once more with a
   * fresh `token()`. For a cached token the identity server no longer knows (it restarted).
   */
  forgetToken?: () => void;
  fetch?: (request: Request) => Promise<Response>;
}

/** {@link OAuthClientRegistry} over the identity-server admin HTTP API. */
export class HttpOAuthClientRegistry implements OAuthClientRegistry {
  private readonly fetch: (request: Request) => Promise<Response>;
  constructor(private readonly options: HttpOAuthClientRegistryOptions) {
    this.fetch = options.fetch ?? ((request) => fetch(request));
  }

  async create(spec: OAuthClientSpec, idempotencyKey?: string): Promise<OAuthClientCredentials> {
    const response = await this.call('POST', '', idempotencyKey, {
      clientId: spec.clientId,
      organizationSlug: spec.organizationSlug,
      redirectUris: spec.redirectUris,
      scopes: spec.scopes,
      audiences: spec.audiences,
      tokenEndpointAuthMethod: spec.public ? 'none' : 'client_secret_basic',
      browser: spec.redirectUris.length > 0,
    });
    return credentials(response, await response.json(), spec.public);
  }

  async get(clientId: string): Promise<OAuthClientRecord | undefined> {
    const path = `/${encodeURIComponent(clientId)}`;
    const response = await this.call('GET', path, undefined, undefined, [404]);
    if (response.status === 404) return undefined;
    const body = (await response.json()) as OAuthClientResponse;
    return {
      clientId: body.client_id,
      organizationSlug: body.organization_slug ?? '',
      redirectUris: body.redirect_uris ?? [],
      scopes: body.scopes ?? [],
      audiences: body.audiences ?? [],
      public: body.token_endpoint_auth_method === 'none',
      ...(body.revoked_at ? { revokedAt: body.revoked_at } : {}),
      ...(body.created_at ? { createdAt: body.created_at } : {}),
    };
  }

  async rotate(
    clientId: string,
    version: string,
    idempotencyKey?: string,
  ): Promise<OAuthClientCredentials> {
    const path = `/${encodeURIComponent(clientId)}/rotate-secret`;
    const response = await this.call('POST', path, idempotencyKey, { version });
    return credentials(response, await response.json(), false);
  }

  async delete(clientId: string): Promise<void> {
    await this.call('DELETE', `/${encodeURIComponent(clientId)}`, undefined, undefined, [404]);
  }

  private async call(
    method: string,
    path: string,
    idempotencyKey: string | undefined,
    body?: unknown,
    allowed: number[] = [],
  ): Promise<Response> {
    const url = `${trimSlashes(this.options.baseUrl)}/api/admin/oauth-clients${path}`;
    let response = await this.send(method, url, idempotencyKey, body);
    if (response.status === 401 && this.options.forgetToken) {
      this.options.forgetToken();
      response = await this.send(method, url, idempotencyKey, body);
    }
    if (response.ok || allowed.includes(response.status)) return response;
    throw oauthAdminError(response.status, `${method} ${url}: HTTP ${response.status}`);
  }

  private async send(
    method: string,
    url: string,
    idempotencyKey: string | undefined,
    body: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.options.token()}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const request = new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      return await this.fetch(request);
    } catch (error) {
      throw unreachable(request, error);
    }
  }
}

/**
 * A request that got no HTTP answer (DNS, connection, TLS, abort or timeout): an admin error with
 * status 0, so reconcile reports it as an identity-server failure. Already typed errors pass.
 */
function unreachable(request: Request, error: unknown): OAuthAdminError {
  if (error instanceof OAuthAdminError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new OAuthAdminError(0, `${request.method} ${request.url}: ${message}`);
}

/**
 * The credentials in a create or rotate response. A public client must come back without a secret
 * and a confidential one with it; anything else means the server did not create what was asked
 * (e.g. a server before #48 ignores the auth method), so it fails instead of dropping or missing a
 * secret.
 */
function credentials(response: Response, body: unknown, isPublic: boolean): OAuthClientCredentials {
  const value = body as { client_id: string; client_secret?: string };
  const where = `${response.url || 'oauth-clients'}: HTTP ${response.status}`;
  if (isPublic && value.client_secret)
    throw new OAuthAdminError(response.status, `${where}: server did not honour public`);
  if (isPublic) return { clientId: value.client_id };
  if (!value.client_secret)
    throw new OAuthAdminError(
      response.status,
      `${where}: no client_secret for a confidential client`,
    );
  return { clientId: value.client_id, clientSecret: value.client_secret };
}

function trimSlashes(url: string): string {
  let result = url;
  while (result.endsWith('/')) result = result.slice(0, -1);
  return result;
}

/** How the platform controller reaches the identity server and authenticates to its admin API. */
export interface IdentityAdminOptions {
  /** The issuer (`tenantAuth.issuer`): the token endpoint and the admin API live under it. */
  issuer: string;
  /**
   * The `host[:port]` requests are sent to instead of the issuer's own, under the issuer's `Host`
   * (and TLS server name), as the tenant pods' sidecar and `hostAliases` do; see
   * {@link identityAdminUpstream}.
   */
  upstream?: string;
  /** The provisioner client (`AUTH_PROVISIONER_CLIENT_ID`); its secret is read when a token is minted. */
  clientId: string;
  clientSecret: () => Promise<string>;
  fetch?: (request: Request) => Promise<Response>;
  /** How long one request may take (default {@link REQUEST_TIMEOUT_MS}). */
  timeoutMs?: number;
  now?: () => number;
}

/** What the admin API needs: `admin:read` for reads and `admin:write` for writes. */
export const ADMIN_SCOPE = 'admin:read admin:write';
/** A token is minted again this long before it expires. */
const TOKEN_SLACK_MS = 30_000;
/**
 * The limit on one token or admin request. Reconcile runs every tenant's calls in sequence, so
 * an identity server that accepts connections and then hangs must not hold a tick for minutes.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Where the platform controller sends identity requests: `tenantAuth.issuerUpstream`, else
 * `tenantAuth.issuerIp` with the issuer's port (what the tenant pods' sidecar targets and their
 * `hostAliases` resolve to), else nothing, i.e. the issuer as named.
 */
export function identityAdminUpstream(auth: TenantAuthConfig): string | undefined {
  if (auth.issuerUpstream) return auth.issuerUpstream;
  if (!auth.issuerIp) return undefined;
  const issuer = new URL(auth.issuer);
  return `${auth.issuerIp}:${issuer.port || (issuer.protocol === 'https:' ? 443 : 80)}`;
}

/** The fetch-like transport the admin registry and the token mint send through. */
export interface AdminFetchOptions {
  upstream?: string;
  fetch?: (request: Request) => Promise<Response>;
  timeoutMs?: number;
}

/**
 * The transport for identity requests: every request is limited to `timeoutMs`, and one that gets
 * no HTTP answer rejects with an {@link OAuthAdminError} of status 0. With `upstream`, requests go
 * to that `host[:port]` over `node:http`/`node:https` under the issuer's `Host` header and TLS
 * server name: the gateway routes by `Host`, and Node's `fetch` (the runtime the controller runs
 * on) silently replaces an explicit `Host` with the connected host. Without `upstream`, `fetch`
 * as given (the global one by default).
 */
export function adminFetch(
  options: AdminFetchOptions = {},
): (request: Request) => Promise<Response> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetcher = options.fetch ?? ((request: Request) => fetch(request));
  const [, hostname = '', port = ''] =
    /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(options.upstream ?? '') ?? [];
  return async (request) => {
    try {
      if (options.upstream)
        return await viaUpstream(request, hostname.replace(/^\[|\]$/g, ''), port, timeoutMs);
      // The limit holds whether or not the fetch honours the signal.
      const signal = AbortSignal.timeout(timeoutMs);
      const expired = new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
      return await Promise.race([fetcher(new Request(request, { signal })), expired]);
    } catch (error) {
      throw unreachable(request, error);
    }
  };
}

/** `request` sent to `hostname:port` with `node:http(s)`, under the issuer's `Host` and server name. */
async function viaUpstream(
  request: Request,
  hostname: string,
  port: string,
  timeoutMs: number,
): Promise<Response> {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:';
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  headers.host = url.host;
  if (body) headers['content-length'] = String(body.byteLength);
  return new Promise<Response>((resolve, reject) => {
    const sent = (secure ? httpsRequest : httpRequest)(
      {
        hostname,
        port: port || (secure ? 443 : 80),
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        ...(secure ? { servername: url.hostname } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          clearTimeout(timer);
          const status = response.statusCode ?? 0;
          const responseHeaders: [string, string][] = [];
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined)
              responseHeaders.push([key, Array.isArray(value) ? value.join(', ') : value]);
          const payload =
            chunks.length && ![204, 205, 304].includes(status) ? Buffer.concat(chunks) : null;
          resolve(new Response(payload, { status, headers: responseHeaders }));
        });
      },
    );
    const timer = setTimeout(
      () => sent.destroy(new Error(`timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    sent.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    sent.end(body);
  });
}

/**
 * The provisioner client's access token for the admin API (`client_credentials`, as the identity
 * server's own `gas` provider mints it), cached until shortly before it expires. `forget` drops
 * the cached token so the next call mints a new one.
 */
export function provisionerToken(options: IdentityAdminOptions): {
  get: () => Promise<string>;
  forget: () => void;
} {
  const fetcher = adminFetch(options);
  const now = options.now ?? Date.now;
  const url = `${trimSlashes(options.issuer)}/oauth2/token`;
  let cached: { token: string; expiresAt: number } | undefined;
  return {
    forget: () => {
      cached = undefined;
    },
    get: async () => {
      if (cached && cached.expiresAt - TOKEN_SLACK_MS > now()) return cached.token;
      cached = undefined;
      const secret = await options.clientSecret();
      const basic = Buffer.from(
        `${encodeURIComponent(options.clientId)}:${encodeURIComponent(secret)}`,
      ).toString('base64');
      const request = new Request(url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: ADMIN_SCOPE }),
      });
      let response: Response;
      try {
        response = await fetcher(request);
      } catch (error) {
        throw unreachable(request, error);
      }
      if (!response.ok)
        throw new OAuthAdminError(
          response.status,
          `POST ${url}: HTTP ${response.status} for provisioner client ${options.clientId}`,
        );
      const body = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token)
        throw new OAuthAdminError(response.status, `POST ${url}: no access_token in the response`);
      cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 0) * 1000 };
      return cached.token;
    },
  };
}

/** The admin API behind `options.issuer`, authenticated as the provisioner client. */
export function identityAdminRegistry(options: IdentityAdminOptions): OAuthClientRegistry {
  const token = provisionerToken(options);
  return new HttpOAuthClientRegistry({
    baseUrl: options.issuer,
    token: token.get,
    forgetToken: token.forget,
    fetch: adminFetch(options),
  });
}
