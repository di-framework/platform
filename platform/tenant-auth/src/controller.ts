/**
 * Tenant controller (prototype): an authenticating reverse proxy in front of the Kubernetes API
 * for one tenant. Requests arrive with an identity-server access token or a tenant API key. The
 * controller resolves the user, swaps in a short-lived token for that user's own ServiceAccount,
 * and forwards only requests that stay inside the tenant's namespaces. The platform's existing
 * roles, quotas, and admission policies apply unchanged; the Kubernetes token never leaves here.
 */
import { readFileSync } from 'node:fs';
import { problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { AuthError, IdentityResolver, type Principal } from './identity.ts';
import { createApiKey, type KeyStore, listApiKeys, revokeApiKey } from './keys.ts';
import {
  asUser,
  inClusterCredentials,
  KubeClient,
  KubeError,
  loadKubeconfig,
  type UserTokens,
} from './kube.ts';
import { discover, type ProviderMetadata } from './oidc.ts';
import { serveV1 } from './v1/index.ts';
import { PASSTHROUGH, servePassthrough, tenantUpstream } from './v1/proxy.ts';

export interface ControllerConfig {
  tenant: string;
  /** Admin kubeconfig for local runs; omitted in-cluster, where the pod's ServiceAccount is used. */
  kubeconfig?: string;
  context?: string;
  platformNamespace: string;
  issuer: string;
  host: string;
  port: number;
  tlsCert?: string;
  tlsKey?: string;
  /** Lifetime of the ServiceAccount tokens the controller mints for itself to forward with. */
  tokenTtlSeconds: number;
  /** The identity server's public native client that the tenant CLI logs in with. */
  cliClientId: string;
}

export function configFromEnv(env = process.env): ControllerConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    tenant: required('TENANT_CONTROLLER_TENANT'),
    kubeconfig: env.TENANT_CONTROLLER_KUBECONFIG,
    context: env.TENANT_CONTROLLER_CONTEXT,
    platformNamespace: env.TENANT_CONTROLLER_PLATFORM_NAMESPACE ?? 'wasmcloud',
    issuer: env.TENANT_CONTROLLER_ISSUER ?? 'http://localhost:4180',
    host: env.TENANT_CONTROLLER_HOST ?? '127.0.0.1',
    port: Number(env.TENANT_CONTROLLER_PORT ?? 8788),
    tlsCert: env.TENANT_CONTROLLER_TLS_CERT,
    tlsKey: env.TENANT_CONTROLLER_TLS_KEY,
    tokenTtlSeconds: Number(env.TENANT_CONTROLLER_TOKEN_TTL ?? 3600),
    cliClientId: env.TENANT_CONTROLLER_CLI_CLIENT_ID ?? 'tenant-cli',
  };
}

export const tenantNamespaces = (tenant: string) => [`di-tenant-${tenant}`, `di-runtime-${tenant}`];

/**
 * Which API server paths a tenant user may reach through this controller. Namespaced paths must
 * name one of the tenant's namespaces; discovery and self-subject reviews are allowed so kubectl
 * works; everything cluster-scoped is refused regardless of the user's RBAC.
 */
export function allowed(method: string, pathname: string, tenant: string): boolean {
  const namespaces = tenantNamespaces(tenant);
  const namespaced =
    /^\/api\/v1\/namespaces\/([^/]+)(\/|$)/.exec(pathname) ??
    /^\/apis\/[^/]+\/[^/]+\/namespaces\/([^/]+)(\/|$)/.exec(pathname);
  if (namespaced?.[1]) return namespaces.includes(namespaced[1]);
  if (method === 'GET' || method === 'HEAD') {
    if (/^\/api(\/v1)?\/?$/.test(pathname) || /^\/apis(\/[^/]+(\/[^/]+)?)?\/?$/.test(pathname))
      return true; // discovery
    if (pathname === '/version' || pathname.startsWith('/openapi/')) return true;
  }
  if (method === 'POST') {
    return [
      '/apis/authentication.k8s.io/v1/selfsubjectreviews',
      '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
      '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews',
    ].includes(pathname);
  }
  return false;
}

/** A Kubernetes Status object, so kubectl prints the reason instead of a parse error. */
const status = (code: number, reason: string, message: string) =>
  new Response(
    JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Failure',
      message,
      reason,
      code,
    }),
    { status: code, headers: { 'Content-Type': 'application/json' } },
  );
const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });

export class Controller {
  private readonly serviceAccountTokens = new Map<string, { token: string; expiresAt: number }>();
  /** Where proxy sessions forward to; only overridden by tests. */
  proxyUpstream: (tenant: string) => string = tenantUpstream;

  constructor(
    readonly config: ControllerConfig,
    readonly kube: KubeClient,
    readonly provider: ProviderMetadata,
    readonly identity: IdentityResolver,
    readonly keys: KeyStore,
  ) {}

  static async start(config: ControllerConfig): Promise<Controller> {
    const credentials = config.kubeconfig
      ? loadKubeconfig(config.kubeconfig, config.context)
      : inClusterCredentials();
    const kube = new KubeClient(credentials, config.platformNamespace);
    const provider = await discover(config.issuer);
    const keys: KeyStore = {
      kube,
      namespace: `di-runtime-${config.tenant}`,
      tenant: config.tenant,
    };
    return new Controller(
      config,
      kube,
      provider,
      new IdentityResolver(kube, provider, config.tenant, keys),
      keys,
    );
  }

  audit(event: string, fields: Record<string, unknown> = {}): void {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        tenant: this.config.tenant,
        event,
        ...fields,
      }),
    );
  }

  /** The user's own ServiceAccount token, minted on demand and cached until shortly before expiry. */
  private async serviceAccountToken(user: string): Promise<string> {
    const cached = this.serviceAccountTokens.get(user);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const minted = await this.kube.mintServiceAccountToken(
      `di-user-${user}`,
      this.config.tokenTtlSeconds,
    );
    this.serviceAccountTokens.set(user, {
      token: minted.token,
      expiresAt: Date.parse(minted.expirationTimestamp),
    });
    this.audit('token.minted', { user, expiresAt: minted.expirationTimestamp });
    return minted.token;
  }

  /** The users' ServiceAccount tokens; forgetting one also drops the cached identity. */
  private readonly userTokens: UserTokens = {
    token: (user) => this.serviceAccountToken(user),
    forget: (user) => {
      this.serviceAccountTokens.delete(user);
      this.identity.forget(user);
    },
  };

  /** `server` (Bun's) supplies the caller's address for the proxy's `X-Forwarded-For`. */
  async handle(
    request: Request,
    server?: { requestIP(request: Request): { address: string } | null },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/-/healthz') return json({ ok: true, tenant: this.config.tenant });
    // The one public operation of the `/v1` contract: what a CLI needs before it has a credential.
    if (request.method === 'GET' && url.pathname === '/v1/auth/info') {
      return json({
        account: this.config.tenant,
        issuer: this.provider.issuer,
        clientId: this.config.cliClientId,
      });
    }
    let principal: Principal;
    try {
      principal = await this.identity.resolve(request.headers.get('authorization'));
    } catch (error) {
      if (error instanceof AuthError) {
        this.audit('request.denied', {
          method: request.method,
          path: url.pathname,
          status: error.status,
          reason: error.message,
        });
        return status(
          error.status,
          error.status === 401 ? 'Unauthorized' : 'Forbidden',
          error.message,
        );
      }
      this.audit('request.failed', { path: url.pathname, reason: String(error) });
      return status(502, 'ServiceUnavailable', 'the identity provider or cluster is unavailable');
    }
    // A proxy session URL (not a contract operation): forwarded to the session's service.
    const clientAddress = server?.requestIP(request)?.address;
    const session = PASSTHROUGH.exec(url.pathname);
    if (session) {
      try {
        return await servePassthrough(request, url, session, {
          tenant: this.config.tenant,
          principal,
          upstream: this.proxyUpstream(this.config.tenant),
          audit: (event, fields) => this.audit(event, fields),
          clientAddress,
        });
      } catch (error) {
        // A client abort mid-body, or anything else unexpected: audited, never echoed.
        this.audit('request.failed', {
          user: principal.user,
          path: url.pathname,
          reason: String(error),
        });
        return problem(502, 'Bad Gateway', 'the service could not be reached');
      }
    }
    try {
      if (url.pathname.startsWith('/-/') || url.pathname.startsWith('/v1/'))
        return await this.own(request, url, principal);
      return await this.proxy(request, url, principal);
    } catch (error) {
      if (error instanceof AuthError)
        return status(
          error.status,
          error.status === 401 ? 'Unauthorized' : 'Forbidden',
          error.message,
        );
      const reason = error instanceof KubeError ? error.message : String(error);
      this.audit('request.failed', { user: principal.user, path: url.pathname, reason });
      return status(502, 'ServiceUnavailable', reason);
    }
  }

  // The controller's own API: identity, API keys, members.

  private async own(request: Request, url: URL, principal: Principal): Promise<Response> {
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /-/whoami' || route === 'GET /v1/auth/whoami') return json(principal);
    // The CLI revokes its identity token at the issuer itself; the controller only drops its caches.
    if (route === 'POST /v1/auth/logout') {
      this.userTokens.forget(principal.user);
      this.audit('logout', { user: principal.user, via: principal.via });
      return new Response(null, { status: 204 });
    }
    if (route === 'GET /-/keys')
      return json({ keys: await listApiKeys(this.keys, principal.user) });
    if (route === 'POST /-/keys') {
      if (principal.via !== 'identity')
        throw new AuthError(403, 'API keys can only be created from a login');
      const body = (await request.json()) as { name?: string; ttlSeconds?: number };
      const name = (body.name ?? '').trim();
      const ttl = Number(body.ttlSeconds);
      if (!name || name.length > 64 || !Number.isInteger(ttl) || ttl < 60 || ttl > 365 * 86_400)
        throw new AuthError(400, 'name and ttlSeconds (60..31536000) are required');
      const issued = await createApiKey(this.keys, principal.user, name, ttl);
      this.audit('apikey.created', {
        user: principal.user,
        id: issued.id,
        name,
        expiresAt: issued.expiresAt,
      });
      return json(issued, 201);
    }
    const revoke = /^DELETE \/-\/keys\/([0-9a-f]{16})$/.exec(route);
    if (revoke?.[1]) {
      if (!(await revokeApiKey(this.keys, principal.user, revoke[1])))
        throw new AuthError(404, 'no such key');
      this.audit('apikey.revoked', { user: principal.user, id: revoke[1] });
      return new Response(null, { status: 204 });
    }
    if (route === 'GET /-/members') {
      const { items } = await this.kube.listUsers();
      const members = items
        .flatMap((u) =>
          u.spec.memberships
            .filter((m) => m.tenant === this.config.tenant)
            .map((m) => ({
              user: u.metadata.name,
              role: m.role,
              suspended: u.spec.suspended === true,
            })),
        )
        .sort((a, b) => a.user.localeCompare(b.user));
      return json({ members });
    }
    // The `/v1` contract goes through the generated routes, which validate the request and hand
    // it to the resource modules under `v1/`.
    if (url.pathname.startsWith('/v1/'))
      return serveV1(request, {
        tenant: this.config.tenant,
        principal,
        asUser: () => asUser(this.kube, this.userTokens, principal),
        asController: () => this.kube,
        audit: (event, fields) => this.audit(event, fields),
      });
    return status(404, 'NotFound', `${url.pathname} is not a controller endpoint`);
  }

  // The Kubernetes API proxy.

  private async proxy(request: Request, url: URL, principal: Principal): Promise<Response> {
    if (!allowed(request.method, url.pathname, this.config.tenant)) {
      this.audit('request.denied', {
        user: principal.user,
        method: request.method,
        path: url.pathname,
        status: 403,
        reason: 'outside tenant',
      });
      return status(
        403,
        'Forbidden',
        `${request.method} ${url.pathname} is outside account ${this.config.tenant}`,
      );
    }
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.arrayBuffer();
    const upstream = await asUser(this.kube, this.userTokens, principal).fetch(
      request.method,
      `${url.pathname}${url.search}`,
      { headers: request.headers, body },
    );
    this.audit('request.proxied', {
      user: principal.user,
      via: principal.via,
      method: request.method,
      path: url.pathname,
      status: upstream.status,
    });
    const out = new Headers(upstream.headers);
    for (const name of ['content-length', 'transfer-encoding', 'connection']) out.delete(name);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
}

if (import.meta.main) {
  const config = configFromEnv();
  const controller = await Controller.start(config);
  const tls =
    config.tlsCert && config.tlsKey
      ? { cert: readFileSync(config.tlsCert, 'utf8'), key: readFileSync(config.tlsKey, 'utf8') }
      : undefined;
  Bun.serve({
    hostname: config.host,
    port: config.port,
    tls,
    // Token refreshes through the identity guest can take longer than Bun's 10 s default.
    idleTimeout: 120,
    fetch: (request, server) => controller.handle(request, server),
  });
  controller.audit('controller.started', {
    url: `${tls ? 'https' : 'http'}://${config.host}:${config.port}`,
    issuer: config.issuer,
    cluster: controller.kube.server,
    namespaces: tenantNamespaces(config.tenant),
  });
}
