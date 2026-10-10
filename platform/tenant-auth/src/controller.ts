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
import { controllerSecretReader } from './v1/context.ts';
import { serveV1 } from './v1/index.ts';
import {
  PASSTHROUGH,
  servePassthrough,
  tenantUpstream,
  upstreamRequestHeaders,
} from './v1/proxy.ts';

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
  /**
   * Origin of the tenant's own OCI registry (platform#83), or undefined when the platform has not
   * configured one. Set from `TENANT_CONTROLLER_REGISTRY_URL`, where `{tenant}` stands for the tenant.
   */
  registryUrl?: string;
  /**
   * Plain-HTTP listener serving only `GET /v1/auth/whoami`, for the tenant registry component on
   * the tenant's hosts (platform#83). NetworkPolicy admits only the host pods to it. Unset: none.
   */
  whoamiPort?: number;
  /**
   * TLS listener (same certificate as `port`) that fronts the tenant registry: every request is
   * forwarded to the tenant hosts with `Host: registryHost`. The gateway passes TLS for the
   * registry's public host through to it, so registry credentials never cross plain HTTP before
   * the cluster. Unset: none.
   */
  registryFrontPort?: number;
  /** The registry workload's `wasi:http` host, sent as `Host` upstream. Default `registry`. */
  registryHost: string;
  /**
   * Largest request body the registry front accepts (`TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES`,
   * default 512 MiB, well above a Wasm component layer); larger is answered 413.
   */
  registryMaxBodyBytes: number;
  /**
   * How long the registry front waits for the registry's response headers once the request body
   * has been forwarded in full (`TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS`, default 60 s);
   * then it answers 504. Response bodies are bounded by the listener's idle timeout.
   */
  registryUpstreamTimeoutMs: number;
  /**
   * How long an upload may go without delivering a byte while the front waits for one
   * (`TENANT_CONTROLLER_REGISTRY_UPLOAD_IDLE_TIMEOUT_MS`, default 60 s); then the upload is cut
   * off with 408. A steady upload of any length succeeds; a stalled one cannot hold a slot.
   */
  registryUploadIdleTimeoutMs: number;
  /**
   * Registry requests in flight at once (`TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT`, default
   * 16); more are answered 503, so the front never starves the tenant API in the same process.
   */
  registryMaxConcurrent: number;
}

/** Idle timeout of the registry front's client sockets; any data flow resets it (Bun's max is 255). */
export const REGISTRY_IDLE_TIMEOUT_SECONDS = 120;
const DEFAULT_REGISTRY_MAX_BODY_BYTES = 512 * 1024 * 1024;

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`${name} must be a positive integer`);
  return number;
}

/**
 * True for hosts where plain `http://` cannot leave the machine or cluster: loopback and in-cluster
 * Service names. Same rule as `platform/oci-registry` (`is_cluster_local`).
 */
function isClusterLocal(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return (host.endsWith('.svc') || host.endsWith('.svc.cluster.local')) && !host.startsWith('.');
}

/**
 * Resolves `{tenant}` in a registry URL pattern and checks it is a bare http(s) origin. Clients send
 * their identity token or `dik_` key to this origin as the Basic password, so plain `http://` is
 * accepted only for loopback and in-cluster hosts. Errors never echo the value, which may carry a
 * credential.
 */
export function registryOrigin(pattern: string | undefined, tenant: string): string | undefined {
  if (!pattern) return undefined;
  const name = 'TENANT_CONTROLLER_REGISTRY_URL';
  let url: URL;
  try {
    url = new URL(pattern.replaceAll('{tenant}', tenant));
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error(`${name} must be an http(s) origin: unsupported scheme`);
  if (url.username || url.password)
    throw new Error(`${name} must be an http(s) origin: userinfo is not allowed`);
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error(
      `${name} must be an http(s) origin: path, query and fragment are not allowed (${url.host})`,
    );
  if (url.protocol === 'http:' && !isClusterLocal(url.hostname))
    throw new Error(
      `${name} must use https:// unless the host is loopback or *.svc / *.svc.cluster.local (${url.host})`,
    );
  return url.origin;
}

function optionalPort(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be a TCP port`);
  return port;
}

/**
 * Relays `body` and calls `release` once it ends: drained, failed, or cancelled by the client
 * (which also cancels the upstream body, aborting its request).
 */
function releasing(
  body: ReadableStream<Uint8Array> | null,
  release: () => void,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    release();
    return null;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        release();
        controller.close();
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

/**
 * Relays an upload and reports how it ends: `stalled` when no byte arrived for `idleMs` while one
 * was wanted (the read is cancelled), `done` once the body has been read in full.
 */
function watchingUpload(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  on: { stalled: () => void; done: () => void },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const timer = setTimeout(() => {
        on.stalled();
        reader.cancel().catch(() => {});
      }, idleMs);
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        on.done();
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The registry's own challenge (`platform/oci-registry` `auth::challenge`), answered at the front. */
function registryChallenge(): Response {
  return new Response('{"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="di-framework-tenant-registry"',
      'content-type': 'application/json',
      'docker-distribution-api-version': 'registry/2.0',
    },
  });
}

/** Headers never relayed back from the registry: hop-by-hop. */
const HOP_BY_HOP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding']);

export function configFromEnv(env = process.env): ControllerConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const tenant = required('TENANT_CONTROLLER_TENANT');
  return {
    tenant,
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
    registryUrl: registryOrigin(env.TENANT_CONTROLLER_REGISTRY_URL, tenant),
    whoamiPort: optionalPort(env.TENANT_CONTROLLER_WHOAMI_PORT, 'TENANT_CONTROLLER_WHOAMI_PORT'),
    registryFrontPort: optionalPort(
      env.TENANT_CONTROLLER_REGISTRY_FRONT_PORT,
      'TENANT_CONTROLLER_REGISTRY_FRONT_PORT',
    ),
    registryHost: env.TENANT_CONTROLLER_REGISTRY_HOST || 'registry',
    registryMaxBodyBytes: positiveInteger(
      env.TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES,
      'TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES',
      DEFAULT_REGISTRY_MAX_BODY_BYTES,
    ),
    registryUpstreamTimeoutMs: positiveInteger(
      env.TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS,
      'TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS',
      60_000,
    ),
    registryUploadIdleTimeoutMs: positiveInteger(
      env.TENANT_CONTROLLER_REGISTRY_UPLOAD_IDLE_TIMEOUT_MS,
      'TENANT_CONTROLLER_REGISTRY_UPLOAD_IDLE_TIMEOUT_MS',
      60_000,
    ),
    registryMaxConcurrent: positiveInteger(
      env.TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT,
      'TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT',
      16,
    ),
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

/** Secret objects and collections in any namespace, as the raw proxy sees them. */
const SECRET_PATH = /^\/api\/v1\/namespaces\/[^/]+\/secrets(\/|$)/;

/** A Kubernetes Status object, so kubectl prints the reason instead of a parse error. */
const status = (code: number, reason: string, message: string) =>
  new Response(
    JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: code < 400 ? 'Success' : 'Failure',
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

  /**
   * The whoami-only listener (platform#83): `GET /v1/auth/whoami` with the same answer as the
   * main listener, and nothing else. Every error is a problem+json, as the `/v1` contract says.
   */
  async handleWhoami(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/auth/whoami')
      return problem(404, 'Not Found', 'this listener serves only GET /v1/auth/whoami');
    if (request.method !== 'GET') {
      const response = problem(405, 'Method Not Allowed', 'only GET is allowed');
      response.headers.set('allow', 'GET');
      return response;
    }
    try {
      return json(await this.identity.resolve(request.headers.get('authorization')));
    } catch (error) {
      if (error instanceof AuthError) {
        this.audit('request.denied', {
          method: request.method,
          path: url.pathname,
          listener: 'whoami',
          status: error.status,
          reason: error.message,
        });
        return problem(
          error.status,
          error.status === 401 ? 'Unauthorized' : 'Forbidden',
          error.message,
        );
      }
      this.audit('request.failed', {
        path: url.pathname,
        listener: 'whoami',
        reason: String(error),
      });
      return problem(502, 'Bad Gateway', 'the identity provider or cluster is unavailable');
    }
  }

  /**
   * The registry front (platform#83): forwards every request, credentials included (the registry
   * authorizes it by calling whoami), to the tenant hosts with `Host: registryHost`, streaming
   * both bodies. The controller does not authenticate here; it only terminates TLS.
   *
   * It is reachable without credentials, so it is bounded: at most `registryMaxConcurrent`
   * requests at once (503 beyond), bodies up to `registryMaxBodyBytes` (413 beyond; the listener
   * enforces the same cap on chunked bodies), an upload that delivers nothing for
   * `registryUploadIdleTimeoutMs` is cut off (408), and once the body is forwarded in full the
   * registry has `registryUpstreamTimeoutMs` for its response headers (504). A request without
   * Basic credentials gets the registry's own challenge here and takes no slot, since the
   * registry would challenge it anyway. A client that goes away aborts the upstream request, and
   * a failed upstream ends the client response. Error answers never carry upstream details.
   */
  async handleRegistry(
    request: Request,
    server?: { requestIP(request: Request): { address: string } | null },
  ): Promise<Response> {
    const url = new URL(request.url);
    const length = request.headers.get('content-length');
    // A length that is not a number counts as too large.
    if (
      length &&
      (Number.isNaN(Number(length)) || Number(length) > this.config.registryMaxBodyBytes)
    )
      return problem(
        413,
        'Content Too Large',
        `request bodies are limited to ${this.config.registryMaxBodyBytes} bytes`,
      );
    const authorization = request.headers.get('authorization');
    if (!/^basic /i.test(authorization ?? '')) {
      await request.body?.cancel().catch(() => {});
      return registryChallenge();
    }
    if (this.registryInFlight >= this.config.registryMaxConcurrent)
      return problem(503, 'Service Unavailable', 'the tenant registry is busy; retry shortly');
    this.registryInFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.registryInFlight--;
    };
    const headers = upstreamRequestHeaders(
      request,
      url,
      this.config.registryHost,
      server?.requestIP(request)?.address,
    );
    headers.set('authorization', authorization as string);
    if (length) headers.set('content-length', length);
    // The upstream request ends with the client's, when the upload stalls, or when the headers
    // take too long once the body has been sent (W5 of the platform#83 review).
    const timeout = new AbortController();
    const stall = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A registry that answers before the upload ends (a 401, say) must not be aborted later.
    let answered = false;
    const armHeaderTimer = () => {
      if (answered) return;
      timer = setTimeout(() => timeout.abort(), this.config.registryUpstreamTimeoutMs);
    };
    const body = request.body
      ? watchingUpload(request.body, this.config.registryUploadIdleTimeoutMs, {
          stalled: () => stall.abort(),
          done: armHeaderTimer,
        })
      : null;
    if (!body) armHeaderTimer();
    let upstream: Response;
    try {
      upstream = await fetch(
        `${this.proxyUpstream(this.config.tenant)}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers,
          body,
          duplex: 'half',
          redirect: 'manual',
          decompress: false,
          signal: AbortSignal.any([request.signal, timeout.signal, stall.signal]),
        } as RequestInit,
      );
    } catch (error) {
      release();
      const timedOut = timeout.signal.aborted;
      const stalled = stall.signal.aborted;
      this.audit('request.failed', {
        path: url.pathname,
        listener: 'registry',
        reason: stalled ? 'upload stalled' : timedOut ? 'upstream timeout' : String(error),
      });
      if (stalled) return problem(408, 'Request Timeout', 'the request body stopped arriving');
      return timedOut
        ? problem(504, 'Gateway Timeout', 'the tenant registry did not answer in time')
        : problem(502, 'Bad Gateway', 'the tenant registry could not be reached');
    } finally {
      answered = true;
      clearTimeout(timer);
    }
    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_RESPONSE.has(name)) out.append(name, value);
    });
    return new Response(releasing(upstream.body, release), {
      status: upstream.status,
      headers: out,
    });
  }

  /** Registry front requests in flight (see {@link handleRegistry}). */
  private registryInFlight = 0;

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
        registryUrl: this.config.registryUrl,
        registryHost: this.config.registryHost,
        asUser: () => asUser(this.kube, this.userTokens, principal),
        asController: () => controllerSecretReader(this.kube),
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
    // A Secret DELETE answers with the deleted object, data included (#112): developers may delete
    // Secrets but never read them, so a successful one is reported as a bare Status.
    if (request.method === 'DELETE' && SECRET_PATH.test(url.pathname) && upstream.ok) {
      await upstream.body?.cancel();
      return status(upstream.status, 'Success', 'secret deleted; its contents are not returned');
    }
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
  // The registry's whoami callback stays inside the cluster, so it is plain HTTP (platform#83).
  if (config.whoamiPort)
    Bun.serve({
      hostname: config.host,
      port: config.whoamiPort,
      idleTimeout: 120,
      fetch: (request) => controller.handleWhoami(request),
    });
  if (config.registryFrontPort)
    Bun.serve({
      hostname: config.host,
      port: config.registryFrontPort,
      tls,
      // Bounded (W2 of the platform#83 review): data flow resets the idle timeout, and bodies
      // beyond the cap are refused here too when they are chunked.
      idleTimeout: REGISTRY_IDLE_TIMEOUT_SECONDS,
      maxRequestBodySize: config.registryMaxBodyBytes,
      fetch: (request, server) => controller.handleRegistry(request, server),
    });
  controller.audit('controller.started', {
    url: `${tls ? 'https' : 'http'}://${config.host}:${config.port}`,
    issuer: config.issuer,
    cluster: controller.kube.server,
    namespaces: tenantNamespaces(config.tenant),
    whoamiPort: config.whoamiPort,
    registryFrontPort: config.registryFrontPort,
  });
}
