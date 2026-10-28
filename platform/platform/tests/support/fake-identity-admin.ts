import {
  OAuthAdminError,
  type OAuthClientCredentials,
  type OAuthClientRecord,
  type OAuthClientRegistry,
  oauthAdminError,
} from '../../src/tenancy/oauth-clients';

/** A stored client plus the `browser` flag the real service keeps. */
interface StoredClient extends OAuthClientRecord {
  browser: boolean;
}

/** A create request after the real service's normalisation. */
type CreateRequest = Omit<StoredClient, 'revokedAt' | 'createdAt'>;

const ADMIN_SCOPES = ['admin:read', 'admin:write'];

/**
 * A fake of the identity-server admin OAuth client API (`/api/admin/oauth-clients`), modelled on
 * identity-server `72e9dae`, plus the fields di-framework/identity-server#48 proposes (see
 * `PROVISIONAL_48`). Real-service references:
 * - `apps/api/src/guards/bearer-guard.ts`: `Bearer` matched case-insensitively; missing or unknown
 *   token 401 with `WWW-Authenticate`; GET/HEAD need `admin:read`, other methods `admin:write`,
 *   else 403.
 * - `packages/core/src/oauth/application/oauth-service.ts` `create`: `clientId` trimmed, 1-100
 *   characters; `organizationSlug` trimmed, at most 128; `redirectUris`/`scopes` default to `[]`
 *   (`JsonBody.texts`); `browser: true` with no redirect URIs is 400; a taken id is 409; with an
 *   `Idempotency-Key` a repeated create replays 201 with the same secret, and a different body
 *   under the same key is 409 (`replay`/`same`).
 * - `rotate`: `version` trimmed and required (400), unknown 404, revoked 409; the secret is
 *   derived from (key, id, version) when keyed (`ClientSecrets.sign`), random otherwise.
 * - `revoke`: unknown 404, otherwise a soft revoke (204) that keeps the id.
 * Use {@link registry} for the in-memory seam and {@link handle} (or {@link serve}) for the HTTP
 * surface; both share one store.
 */
export class FakeIdentityAdmin {
  readonly clients = new Map<string, StoredClient>();
  /** Every HTTP request served, as `METHOD path`. */
  readonly requests: string[] = [];
  /** Bearer tokens and the scopes each grants. */
  readonly tokens = new Map<string, string[]>();
  /** Idempotency key → the client id its create made. */
  private readonly createKeys = new Map<string, string>();
  private secrets = 0;

  constructor(readonly token = 'admin-token') {
    this.tokens.set(token, ADMIN_SCOPES);
  }

  /** The in-memory {@link OAuthClientRegistry} over this store. */
  registry(): OAuthClientRegistry {
    return {
      create: async (spec, key) =>
        this.create({ ...spec, browser: spec.redirectUris.length > 0 }, key),
      get: async (clientId) => this.get(clientId),
      rotate: async (clientId, version, key) => this.rotate(clientId, { version }, key),
      delete: async (clientId) => {
        if (this.clients.has(clientId)) this.revoke(clientId);
      },
    };
  }

  /** Serves one admin API request. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);
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
    if (id === undefined && method === 'POST')
      return secretResponse(this.create(await request.json(), key), 201);
    if (id !== undefined && rotate && method === 'POST')
      return secretResponse(this.rotate(id, await request.json(), key), 200);
    if (id !== undefined && !rotate && method === 'GET') {
      const client = this.clients.get(id);
      return client ? Response.json(clientResponse(client)) : new Response(null, { status: 404 });
    }
    if (id !== undefined && !rotate && method === 'DELETE') {
      if (!this.clients.has(id)) return new Response(null, { status: 404 });
      this.revoke(id);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }

  private create(raw: Record<string, unknown>, key?: string): OAuthClientCredentials {
    const request = normalise(raw);
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

  private rotate(clientId: string, raw: Record<string, unknown>, key?: string) {
    const version = text(raw.version);
    if (!version) throw oauthAdminError(400, 'version is required');
    const client = this.clients.get(clientId);
    if (!client) throw oauthAdminError(404, `${clientId} not found`);
    // #48 provisional: refusing to rotate a public client.
    if (client.revokedAt || client.public) throw oauthAdminError(409, `${clientId} cannot rotate`);
    return this.credentials({ ...client, public: false }, key, `rotate:${clientId}:${version}`);
  }

  private revoke(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client && !client.revokedAt) client.revokedAt = new Date(0).toISOString();
  }

  /** `ClientSecrets.sign`: derived from the key when there is one, otherwise fresh. */
  private credentials(client: CreateRequest, key: string | undefined, operation: string) {
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

/** `JsonBody.texts`: the string items of an array, or `[]`. */
function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/** Validates and normalises a create body the way `OAuthService.create` does. */
function normalise(raw: Record<string, unknown>): CreateRequest {
  const clientId = text(raw.clientId);
  const organizationSlug = text(raw.organizationSlug);
  const redirectUris = texts(raw.redirectUris);
  const browser = raw.browser === true;
  const invalid =
    !clientId ||
    clientId.length > 100 ||
    organizationSlug.length > 128 ||
    (browser && redirectUris.length === 0) ||
    // #48 provisional: organizationSlug required.
    !organizationSlug;
  if (invalid) throw oauthAdminError(400, 'invalid create request');
  return {
    clientId,
    organizationSlug,
    redirectUris,
    scopes: texts(raw.scopes),
    audiences: texts(raw.audiences),
    public: raw.public === true,
    browser,
  };
}

/** `OAuthService.same`: the replayed create asked for the same client. */
function same(existing: StoredClient, request: CreateRequest): boolean {
  const sameSet = (left: string[], right: string[]) =>
    left.length === right.length && [...left].sort().join('\n') === [...right].sort().join('\n');
  return (
    existing.clientId === request.clientId &&
    existing.organizationSlug === request.organizationSlug &&
    existing.browser === request.browser &&
    sameSet(existing.redirectUris, request.redirectUris) &&
    sameSet(existing.scopes, request.scopes)
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
    public: client.public,
    browser: client.browser,
    revoked_at: client.revokedAt ?? null,
    created_at: client.createdAt,
  };
}
