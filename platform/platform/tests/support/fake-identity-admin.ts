import {
  OAuthClientConflict,
  type OAuthClientCredentials,
  OAuthClientNotFound,
  type OAuthClientRecord,
  type OAuthClientRegistry,
  type OAuthClientSpec,
  oauthAdminError,
} from '../../src/tenancy/oauth-clients';

/**
 * A fake of the identity-server admin OAuth client API (`/api/admin/oauth-clients`) with the
 * fields di-framework/identity-server#48 proposes (`audiences`, `public`, required
 * `organizationSlug`). It mirrors the real service's statuses: 201 create, 409 for a taken id,
 * 404 for an unknown one, 409 when rotating a revoked client, 400 when `version` is missing, and
 * a soft revoke (204) that keeps the id. Use {@link registry} for the in-memory seam and
 * {@link handle} (or {@link serve}) for the HTTP surface; both share one store.
 */
export class FakeIdentityAdmin {
  readonly clients = new Map<string, OAuthClientRecord>();
  /** Every HTTP request served, as `METHOD path`. */
  readonly requests: string[] = [];
  private secrets = 0;

  constructor(readonly token = 'admin-token') {}

  /** The in-memory {@link OAuthClientRegistry} over this store. */
  registry(): OAuthClientRegistry {
    return {
      create: async (spec) => this.create(spec),
      get: async (clientId) => this.get(clientId),
      rotate: async (clientId, version) => this.rotate(clientId, version),
      delete: async (clientId) => this.delete(clientId),
    };
  }

  /** Serves one admin API request. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);
    if (request.headers.get('authorization') !== `Bearer ${this.token}`)
      return new Response(null, { status: 401 });
    const match = /^\/api\/admin\/oauth-clients(?:\/([^/]+))?(\/rotate-secret)?$/.exec(
      url.pathname,
    );
    if (!match) return new Response(null, { status: 404 });
    const id = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
    try {
      return await this.route(request, id, Boolean(match[2]));
    } catch (error) {
      if (error instanceof OAuthClientConflict || error instanceof OAuthClientNotFound)
        return new Response(null, { status: error.status });
      throw error;
    }
  }

  /** Listens on a loopback port; stop the returned server when done. */
  serve(): ReturnType<typeof Bun.serve> {
    return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => this.handle(request) });
  }

  private async route(request: Request, id: string | undefined, rotate: boolean) {
    const method = request.method;
    if (id === undefined && method === 'POST') {
      const body = (await request.json()) as Partial<OAuthClientSpec>;
      if (!body.clientId || !body.organizationSlug) return new Response(null, { status: 400 });
      return secretResponse(this.create(body as OAuthClientSpec), 201);
    }
    if (id !== undefined && rotate && method === 'POST') {
      const { version } = (await request.json()) as { version?: string };
      if (!version) return new Response(null, { status: 400 });
      return secretResponse(this.rotate(id, version), 200);
    }
    if (id !== undefined && !rotate && method === 'GET') {
      const client = this.get(id);
      return client ? Response.json(clientResponse(client)) : new Response(null, { status: 404 });
    }
    if (id !== undefined && !rotate && method === 'DELETE') {
      if (!this.clients.has(id)) return new Response(null, { status: 404 });
      this.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }

  private create(spec: OAuthClientSpec): OAuthClientCredentials {
    if (this.clients.has(spec.clientId)) throw oauthAdminError(409, `${spec.clientId} exists`);
    this.clients.set(spec.clientId, {
      clientId: spec.clientId,
      organizationSlug: spec.organizationSlug,
      redirectUris: [...spec.redirectUris],
      scopes: [...spec.scopes],
      audiences: [...(spec.audiences ?? [])],
      public: Boolean(spec.public),
      createdAt: new Date(0).toISOString(),
    });
    return spec.public
      ? { clientId: spec.clientId }
      : { clientId: spec.clientId, clientSecret: this.secret() };
  }

  private get(clientId: string): OAuthClientRecord | undefined {
    const client = this.clients.get(clientId);
    return client && structuredClone(client);
  }

  private rotate(clientId: string, version: string): OAuthClientCredentials {
    const client = this.clients.get(clientId);
    if (!client) throw oauthAdminError(404, `${clientId} not found`);
    if (client.revokedAt || client.public)
      throw oauthAdminError(409, `${clientId} cannot rotate (${version})`);
    return { clientId, clientSecret: this.secret() };
  }

  private delete(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client && !client.revokedAt) client.revokedAt = new Date(0).toISOString();
  }

  private secret(): string {
    this.secrets += 1;
    return `fake-secret-${this.secrets}`;
  }
}

function secretResponse(credentials: OAuthClientCredentials, status: number): Response {
  return Response.json(
    { client_id: credentials.clientId, client_secret: credentials.clientSecret },
    { status },
  );
}

function clientResponse(client: OAuthClientRecord) {
  return {
    client_id: client.clientId,
    organization_slug: client.organizationSlug,
    redirect_uris: client.redirectUris,
    scopes: client.scopes,
    audiences: client.audiences,
    public: client.public,
    browser: client.redirectUris.length > 0,
    revoked_at: client.revokedAt ?? null,
    created_at: client.createdAt,
  };
}
