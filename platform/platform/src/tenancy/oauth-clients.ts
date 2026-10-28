/**
 * Per-tenant OAuth clients (#59). Each tenant gets two clients in the identity server instead of
 * sharing the bootstrap `tenantAuth.oauthClient`: a confidential one for its console and a public
 * PKCE one for its CLI. Tenancy reconcile registers them through {@link OAuthClientRegistry}, an
 * injected seam, and removes them with the tenant.
 *
 * The contract follows the identity-server admin API (`/api/admin/oauth-clients`, schemas
 * `CreateOAuthClientRequest`, `OAuthClientResponse`, `OAuthClientSecretResponse`,
 * `RotateOAuthClientSecretRequest`) plus the fields di-framework/identity-server#48 proposes:
 * `audiences[]`, public PKCE clients, and a required `organizationSlug`. #48 has not merged, so
 * the wire names of those additions (`audiences`, `public`) are provisional. Until it is released
 * (gate G05) the tests run the contract against a fake admin API; nothing in the controller calls
 * this module yet.
 */

/** A client the registry should hold. */
export interface OAuthClientSpec {
  clientId: string;
  /** The tenant the client belongs to; #48 makes it required for tenant clients. */
  organizationSlug: string;
  redirectUris: string[];
  scopes: string[];
  /** Token `aud` values (#48); the identity server defaults to `[clientId]`. */
  audiences: string[];
  /** A public PKCE client (token endpoint auth `none`, #48) has no secret. */
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
  /** Registers `spec`. Throws {@link OAuthClientConflict} if the id exists, revoked or not. */
  create(spec: OAuthClientSpec): Promise<OAuthClientCredentials>;
  /** The client, revoked ones included; `undefined` if it never existed. */
  get(clientId: string): Promise<OAuthClientRecord | undefined>;
  /**
   * Issues a new secret for a confidential client. `version` names the rotation (the identity
   * server requires it). Throws {@link OAuthClientNotFound} for an unknown id and
   * {@link OAuthClientConflict} for a revoked or public client.
   */
  rotate(clientId: string, version: string): Promise<OAuthClientCredentials>;
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

/** Where a tenant's clients redirect and what they may request. */
export interface TenantOAuthOptions {
  /** The console's authorization-code callback URLs. */
  consoleRedirectUris: string[];
  /** The CLI's loopback callback URLs. */
  cliRedirectUris: string[];
  scopes: string[];
  audiences: string[];
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
 * Makes sure the tenant's clients exist. A new console client returns its secret; an existing one
 * returns none unless `consoleSecretStored` is false (the secret was never stored, e.g. reconcile
 * stopped between create and writing `tenant-console-oauth`), in which case it is rotated to
 * `rotationVersion`. A revoked client is a conflict: its id cannot be reused.
 */
export async function ensureTenantOAuthClients(
  registry: OAuthClientRegistry,
  tenant: TenantRef,
  options: TenantOAuthOptions & { consoleSecretStored: boolean; rotationVersion: string },
): Promise<{ console: OAuthClientCredentials; cli: OAuthClientCredentials }> {
  const specs = tenantOAuthClients(tenant, options);
  const ensure = async (spec: OAuthClientSpec, needSecret: boolean) => {
    const existing = await registry.get(spec.clientId);
    if (!existing) return registry.create(spec);
    if (existing.revokedAt)
      throw new OAuthClientConflict(409, `OAuth client ${spec.clientId} is revoked`);
    if (needSecret) return registry.rotate(spec.clientId, options.rotationVersion);
    return { clientId: spec.clientId };
  };
  return {
    console: await ensure(specs.console, !options.consoleSecretStored),
    cli: await ensure(specs.cli, false),
  };
}

/** Revokes the tenant's clients; safe to repeat. */
export async function removeTenantOAuthClients(
  registry: OAuthClientRegistry,
  tenant: TenantRef,
): Promise<void> {
  const ids = tenantOAuthClientIds(tenant);
  await registry.delete(ids.console);
  await registry.delete(ids.cli);
}

/** `OAuthClientResponse` with the #48 additions. */
interface OAuthClientResponse {
  client_id: string;
  organization_slug?: string | null;
  redirect_uris?: string[];
  scopes?: string[];
  audiences?: string[];
  public?: boolean;
  revoked_at?: string | null;
  created_at?: string;
}

/** Connection settings for {@link HttpOAuthClientRegistry}. */
export interface HttpOAuthClientRegistryOptions {
  /** The identity server origin, e.g. `https://identity.example.com`. */
  baseUrl: string;
  /** The admin bearer token (the provisioner token in reconcile). */
  token: () => string | Promise<string>;
  fetch?: (request: Request) => Promise<Response>;
}

/** {@link OAuthClientRegistry} over the identity-server admin HTTP API. */
export class HttpOAuthClientRegistry implements OAuthClientRegistry {
  private readonly fetch: (request: Request) => Promise<Response>;
  constructor(private readonly options: HttpOAuthClientRegistryOptions) {
    this.fetch = options.fetch ?? ((request) => fetch(request));
  }

  async create(spec: OAuthClientSpec): Promise<OAuthClientCredentials> {
    const response = await this.call('POST', '', {
      clientId: spec.clientId,
      organizationSlug: spec.organizationSlug,
      redirectUris: spec.redirectUris,
      scopes: spec.scopes,
      audiences: spec.audiences,
      public: spec.public,
      browser: spec.redirectUris.length > 0,
    });
    return credentials(await response.json(), spec.public);
  }

  async get(clientId: string): Promise<OAuthClientRecord | undefined> {
    const response = await this.call('GET', `/${encodeURIComponent(clientId)}`, undefined, [404]);
    if (response.status === 404) return undefined;
    const body = (await response.json()) as OAuthClientResponse;
    return {
      clientId: body.client_id,
      organizationSlug: body.organization_slug ?? '',
      redirectUris: body.redirect_uris ?? [],
      scopes: body.scopes ?? [],
      audiences: body.audiences ?? [],
      public: body.public ?? false,
      ...(body.revoked_at ? { revokedAt: body.revoked_at } : {}),
      ...(body.created_at ? { createdAt: body.created_at } : {}),
    };
  }

  async rotate(clientId: string, version: string): Promise<OAuthClientCredentials> {
    const path = `/${encodeURIComponent(clientId)}/rotate-secret`;
    const response = await this.call('POST', path, { version });
    return credentials(await response.json(), false);
  }

  async delete(clientId: string): Promise<void> {
    await this.call('DELETE', `/${encodeURIComponent(clientId)}`, undefined, [404]);
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    allowed: number[] = [],
  ): Promise<Response> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/api/admin/oauth-clients${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.options.token()}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetch(
      new Request(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    if (response.ok || allowed.includes(response.status)) return response;
    throw oauthAdminError(response.status, `${method} ${url}: HTTP ${response.status}`);
  }
}

function credentials(body: unknown, isPublic: boolean): OAuthClientCredentials {
  const value = body as { client_id: string; client_secret?: string };
  if (isPublic || !value.client_secret) return { clientId: value.client_id };
  return { clientId: value.client_id, clientSecret: value.client_secret };
}
