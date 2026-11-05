import {
  ADMIN_SCOPE,
  OAuthAdminError,
  type OAuthClientCredentials,
  type OAuthClientRecord,
  type OAuthClientRegistry,
  oauthAdminError,
} from '../../src/tenancy/oauth-clients';

type AuthMethod = 'client_secret_basic' | 'none';

/** A stored client plus the `browser` flag the real service keeps. */
interface StoredClient extends OAuthClientRecord {
  browser: boolean;
}

/** A create or update request after the real service's normalisation. */
type ClientMetadata = Omit<StoredClient, 'revokedAt' | 'createdAt'>;

const ADMIN_SCOPES = ['admin:read', 'admin:write'];
/** `oauth_client_lifecycle.audiences` is `varchar(1000)`, comma-separated. */
const MAX_AUDIENCES_LENGTH = 1000;

/**
 * A fake of the identity-server admin OAuth client API (`/api/admin/oauth-clients`) as
 * di-framework/identity-server#48 ships it (`docs/admin-oauth-clients.md` there), plus the token
 * endpoint the platform controller mints its provisioner token at. Real-service references:
 * - `apps/api/src/guards/bearer-guard.ts`: `Bearer` matched case-insensitively; missing or unknown
 *   token 401 with `WWW-Authenticate`; GET/HEAD need `admin:read`, other methods `admin:write`,
 *   else 403.
 * - `packages/core/src/oauth/application/oauth-service.ts` `metadata`: `clientId` trimmed, 1-100
 *   characters; `organizationSlug` required, at most 128; `tokenEndpointAuthMethod`
 *   `client_secret_basic` (default) or `none`, anything else 400, fixed for life (an update that
 *   names the other method is 409); `redirectUris`/`scopes`/`audiences` trimmed, empty items and
 *   duplicates dropped; each audience without whitespace or commas, the stored list at most 1000
 *   characters; `browser` is implied for a public client; `browser` with no redirect URIs 400; a
 *   public client's redirect URIs must all be loopback `http` (`127.0.0.1` or `[::1]`, any port).
 * - `create`: a taken id is 409; with an `Idempotency-Key` a repeated create replays 201 with the
 *   same secret, and a different client under the same key (id, organization, method, `browser`,
 *   redirect URIs, scopes or audiences) is 409 (`replay`/`same`).
 * - `update`: unknown 404, revoked 409, otherwise the metadata is replaced (200).
 * - `rotate`: `version` trimmed and required (400), unknown 404, revoked or public 409; the secret
 *   is derived from (key, id, version) when keyed (`ClientSecrets.sign`), random otherwise.
 * - `revoke`: unknown 404, otherwise a soft revoke (204) that keeps the id.
 * - `POST /oauth2/token`: `client_credentials` for the provisioner client over HTTP basic auth,
 *   answering a bearer token with the admin scopes.
 * Use {@link registry} for the in-memory seam and {@link handle} (or {@link serve}) for the HTTP
 * surface; both share one store.
 */
export class FakeIdentityAdmin {
  readonly clients = new Map<string, StoredClient>();
  /** Every HTTP request served, as `METHOD path`. */
  readonly requests: string[] = [];
  /** The `Host` header of every HTTP request served. */
  readonly hosts: string[] = [];
  /** Bearer tokens and the scopes each grants. */
  readonly tokens = new Map<string, string[]>();
  /** The provisioner client `POST /oauth2/token` accepts, and the lifetime of its tokens. */
  provisioner = { clientId: 'provisioner', clientSecret: 'provisioner-secret', expiresIn: 600 };
  /** Idempotency key → the client id its create made. */
  private readonly createKeys = new Map<string, string>();
  private secrets = 0;
  private minted = 0;

  constructor(readonly token = 'admin-token') {
    this.tokens.set(token, ADMIN_SCOPES);
  }

  /** The in-memory {@link OAuthClientRegistry} over this store. */
  registry(): OAuthClientRegistry {
    /** Runs `operation` as a promise, so a thrown admin error becomes a rejection. */
    const later = <T>(operation: () => T): Promise<T> => Promise.resolve().then(operation);
    return {
      create: (spec, key) =>
        later(() =>
          this.create(
            normalise({
              ...spec,
              tokenEndpointAuthMethod: spec.public ? 'none' : 'client_secret_basic',
              browser: spec.redirectUris.length > 0,
            }),
            key,
          ),
        ),
      get: (clientId) => later(() => this.get(clientId)),
      rotate: (clientId, version, key) => later(() => this.rotate(clientId, { version }, key)),
      delete: (clientId) =>
        later(() => {
          if (this.clients.has(clientId)) this.revoke(clientId);
        }),
    };
  }

  /** Serves one request: the admin API, or the token endpoint. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);
    this.hosts.push(request.headers.get('host') ?? '');
    if (url.pathname === '/oauth2/token') return this.tokenEndpoint(request);
    const denied = this.authorize(request);
    if (denied) return denied;
    const match = /^\/api\/admin\/oauth-clients(?:\/([^/]+))?(\/rotate-secret)?$/.exec(
      url.pathname,
    );
    if (!match) return new Response(null, { status: 404 });
    const id = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
    try {
      return await this.route(request, id, Boolean(match[2]));
    } catch (error) {
      if (error instanceof OAuthAdminError) return new Response(null, { status: error.status });
      throw error;
    }
  }

  /** Listens on a loopback port; stop the returned server when done. */
  serve(): ReturnType<typeof Bun.serve> {
    return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => this.handle(request) });
  }

  private async tokenEndpoint(request: Request): Promise<Response> {
    const match = /^Basic\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
    const [clientId, clientSecret] = Buffer.from(match?.[1] ?? '', 'base64')
      .toString()
      .split(':')
      .map((part) => decodeURIComponent(part));
    const form = new URLSearchParams(await request.text());
    if (request.method !== 'POST' || form.get('grant_type') !== 'client_credentials')
      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
    const { provisioner } = this;
    if (clientId !== provisioner.clientId || clientSecret !== provisioner.clientSecret)
      return Response.json({ error: 'invalid_client' }, { status: 401 });
    this.minted += 1;
    const token = `minted-${this.minted}`;
    this.tokens.set(token, (form.get('scope') ?? ADMIN_SCOPE).split(' '));
    return Response.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: provisioner.expiresIn,
    });
  }

  private authorize(request: Request): Response | undefined {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
    const scopes = match?.[1] ? this.tokens.get(match[1]) : undefined;
    if (!scopes)
      return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
    const read = request.method === 'GET' || request.method === 'HEAD';
    const scope = read ? 'admin:read' : 'admin:write';
    if (scopes.includes(scope)) return undefined;
    const challenge = `Bearer error="insufficient_scope", scope="${scope}"`;
    return new Response(null, { status: 403, headers: { 'www-authenticate': challenge } });
  }

  private async route(request: Request, id: string | undefined, rotate: boolean) {
    const method = request.method;
    const key = request.headers.get('idempotency-key') ?? undefined;
    if (id === undefined && method === 'GET')
      return Response.json([...this.clients.values()].map(clientResponse));
    if (id === undefined && method === 'POST')
      return secretResponse(this.create(normalise(await request.json()), key), 201);
    if (id !== undefined && rotate && method === 'POST')
      return secretResponse(this.rotate(id, await request.json(), key), 200);
    if (id !== undefined && !rotate && method === 'GET') {
      const client = this.clients.get(id);
      return client ? Response.json(clientResponse(client)) : new Response(null, { status: 404 });
    }
    if (id !== undefined && !rotate && method === 'PUT')
      return Response.json(clientResponse(this.update(id, await request.json())));
    if (id !== undefined && !rotate && method === 'DELETE') {
      if (!this.clients.has(id)) return new Response(null, { status: 404 });
      this.revoke(id);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }

  private create(request: ClientMetadata, key?: string): OAuthClientCredentials {
    const replayed = key === undefined ? undefined : this.createKeys.get(key);
    if (replayed !== undefined) {
      const existing = this.clients.get(replayed);
      if (!existing || !same(existing, request)) throw oauthAdminError(409, 'key reused');
      return this.credentials(request, key, `create:${request.clientId}`);
    }
    if (this.clients.has(request.clientId))
      throw oauthAdminError(409, `${request.clientId} exists`);
    this.clients.set(request.clientId, { ...request, createdAt: new Date(0).toISOString() });
    if (key !== undefined) this.createKeys.set(key, request.clientId);
    return this.credentials(request, key, `create:${request.clientId}`);
  }

  private get(clientId: string): OAuthClientRecord | undefined {
    const client = this.clients.get(clientId);
    if (!client) return undefined;
    const { browser: _browser, ...record } = structuredClone(client);
    return record;
  }

  /** `OAuthService.update`: the stored metadata replaced; the auth method cannot change. */
  private update(clientId: string, raw: Record<string, unknown>): StoredClient {
    const existing = this.clients.get(clientId);
    if (!existing) throw oauthAdminError(404, `${clientId} not found`);
    const request = normalise({ ...raw, clientId }, existing);
    if (existing.revokedAt) throw oauthAdminError(409, `${clientId} is revoked`);
    const updated = { ...existing, ...request };
    this.clients.set(clientId, updated);
    return updated;
  }

  private rotate(clientId: string, raw: Record<string, unknown>, key?: string) {
    const version = text(raw.version);
    if (!version) throw oauthAdminError(400, 'version is required');
    const client = this.clients.get(clientId);
    if (!client) throw oauthAdminError(404, `${clientId} not found`);
    if (client.revokedAt || client.public) throw oauthAdminError(409, `${clientId} cannot rotate`);
    return this.credentials({ ...client, public: false }, key, `rotate:${clientId}:${version}`);
  }

  private revoke(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client && !client.revokedAt) client.revokedAt = new Date(0).toISOString();
  }

  /** `ClientSecrets.sign`: derived from the key when there is one, otherwise fresh. */
  private credentials(client: ClientMetadata, key: string | undefined, operation: string) {
    if (client.public) return { clientId: client.clientId };
    if (key !== undefined) {
      const digest = new Bun.CryptoHasher('sha256').update(`${key}\0${operation}`).digest('hex');
      return { clientId: client.clientId, clientSecret: `fake-secret-${digest.slice(0, 16)}` };
    }
    this.secrets += 1;
    return { clientId: client.clientId, clientSecret: `fake-secret-${this.secrets}` };
  }
}

/** `JsonBody.text`: a trimmed string, or `''`. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `JsonBody.texts` then `unique`: trimmed string items, empty ones and duplicates dropped. */
function texts(value: unknown): string[] {
  const items = Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  return [...new Set(items.map((item: string) => item.trim()).filter((item) => item.length > 0))];
}

/** RFC 8252 section 7.3: `http` on `127.0.0.1` or `[::1]`, any port. */
function isLoopbackRedirect(uri: string): boolean {
  if (!URL.canParse(uri)) return false;
  const url = new URL(uri);
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}

/** An `aud` value: non-empty, and storable in the comma-separated column. */
function validAudience(value: string): boolean {
  return !/[\s,]/.test(value);
}

/**
 * Validates and normalises a create or update body the way `OAuthService.metadata` does. With
 * `existing` (an update) the auth method may be repeated but not changed (409).
 */
function normalise(raw: Record<string, unknown>, existing?: StoredClient): ClientMetadata {
  const clientId = text(raw.clientId);
  const organizationSlug = text(raw.organizationSlug);
  const invalid = !clientId || clientId.length > 100 || !organizationSlug;
  if (invalid || organizationSlug.length > 128) throw oauthAdminError(400, 'invalid request');
  const method = raw.tokenEndpointAuthMethod;
  const existingMethod = existing && (existing.public ? 'none' : 'client_secret_basic');
  const tokenEndpointAuthMethod = (method ?? existingMethod ?? 'client_secret_basic') as AuthMethod;
  if (tokenEndpointAuthMethod !== 'client_secret_basic' && tokenEndpointAuthMethod !== 'none')
    throw oauthAdminError(400, 'invalid tokenEndpointAuthMethod');
  if (existingMethod && tokenEndpointAuthMethod !== existingMethod)
    throw oauthAdminError(409, 'tokenEndpointAuthMethod cannot change');
  const redirectUris = texts(raw.redirectUris);
  const audiences = texts(raw.audiences);
  if (!audiences.every(validAudience) || audiences.join(',').length > MAX_AUDIENCES_LENGTH)
    throw oauthAdminError(400, 'invalid audiences');
  const isPublic = tokenEndpointAuthMethod === 'none';
  const browser = isPublic || raw.browser === true;
  if (browser && redirectUris.length === 0) throw oauthAdminError(400, 'redirectUris required');
  if (isPublic && !redirectUris.every(isLoopbackRedirect))
    throw oauthAdminError(400, 'public clients redirect to loopback only');
  return {
    clientId,
    organizationSlug,
    redirectUris,
    scopes: texts(raw.scopes),
    audiences,
    public: isPublic,
    browser,
  };
}

/** `OAuthService.same`: the replayed create asked for the same client. */
function same(existing: StoredClient, request: ClientMetadata): boolean {
  const sorted = (items: string[]) => [...items].sort((a, b) => a.localeCompare(b)).join('\n');
  const sameSet = (left: string[], right: string[]) =>
    left.length === right.length && sorted(left) === sorted(right);
  return (
    existing.clientId === request.clientId &&
    existing.organizationSlug === request.organizationSlug &&
    existing.browser === request.browser &&
    existing.public === request.public &&
    sameSet(existing.redirectUris, request.redirectUris) &&
    sameSet(existing.scopes, request.scopes) &&
    sameSet(existing.audiences, request.audiences)
  );
}

function secretResponse(credentials: OAuthClientCredentials, status: number): Response {
  return Response.json(
    { client_id: credentials.clientId, client_secret: credentials.clientSecret },
    { status },
  );
}

function clientResponse(client: StoredClient) {
  return {
    client_id: client.clientId,
    organization_slug: client.organizationSlug,
    redirect_uris: client.redirectUris,
    scopes: client.scopes,
    audiences: client.audiences,
    browser: client.browser,
    token_endpoint_auth_method: client.public ? 'none' : 'client_secret_basic',
    revoked_at: client.revokedAt ?? null,
    created_at: client.createdAt,
  };
}
