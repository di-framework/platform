/**
 * Tenant console (prototype). One per tenant, deployed in the tenant's namespace. It is the
 * OpenID Connect relying party to identity-server: it signs users in, hands the CLI the resulting
 * identity tokens, refreshes them, and renders pages by calling the tenant controller with the
 * user's own token, so it holds no cluster credential of its own.
 */
import { readFileSync } from 'node:fs';
import {
  keys as keysPage,
  landing,
  logs as logsPage,
  members as membersPage,
  message,
  overview,
  type Who,
} from './html.ts';
import type { ApiKey, IssuedApiKey } from './keys.ts';
import {
  authorizationUrl,
  discover,
  exchangeCode,
  type ProviderMetadata,
  pkce,
  randomToken,
  refreshTokens,
  revokeToken,
  type TokenResponse,
  verifyIdToken,
} from './oidc.ts';

export interface ConsoleConfig {
  tenant: string;
  controllerUrl: string;
  /** What the CLI should put in its kubeconfig; differs from controllerUrl inside a cluster. */
  controllerPublicUrl: string;
  /** PEM CA for the controller when it uses a private certificate. */
  controllerCa?: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  host: string;
  port: number;
  publicUrl: string;
}

export function configFromEnv(env = process.env): ConsoleConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const host = env.TENANT_CONSOLE_HOST ?? '127.0.0.1';
  const port = Number(env.TENANT_CONSOLE_PORT ?? 8787);
  return {
    tenant: required('TENANT_CONSOLE_TENANT'),
    controllerUrl: (env.TENANT_CONSOLE_CONTROLLER_URL ?? 'https://127.0.0.1:8788').replace(
      /\/$/,
      '',
    ),
    controllerPublicUrl: (
      env.TENANT_CONSOLE_CONTROLLER_PUBLIC_URL ??
      env.TENANT_CONSOLE_CONTROLLER_URL ??
      'https://127.0.0.1:8788'
    ).replace(/\/$/, ''),
    controllerCa: env.TENANT_CONSOLE_CONTROLLER_CA
      ? readFileSync(env.TENANT_CONSOLE_CONTROLLER_CA, 'utf8')
      : undefined,
    issuer: env.TENANT_CONSOLE_ISSUER ?? 'http://localhost:4180',
    clientId: env.TENANT_CONSOLE_CLIENT_ID ?? 'tenant-auth',
    clientSecret: required('TENANT_CONSOLE_CLIENT_SECRET'),
    host,
    port,
    publicUrl: env.TENANT_CONSOLE_PUBLIC_URL ?? `http://${host}:${port}`,
  };
}

const CLI_CALLBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/callback$/;
const FLOW_TTL_MS = 600_000;
const CODE_TTL_MS = 120_000;
const SESSION_TTL_MS = 12 * 3_600_000;
const FLOW_COOKIE = 'tenant_console_flow';
const SESSION_COOKIE = 'tenant_console_session';
const PLATFORM_API = '/apis/platform.di-framework.dev/v1alpha1';
const WASMCLOUD_API = '/apis/runtime.wasmcloud.dev/v1alpha1';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** ms epoch */
  accessExpiresAt: number;
}
interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
  cli?: { callback: string; state: string };
}
interface Session extends Tokens, Who {
  expiresAt: number;
}
interface Principal extends Who {
  via: string;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });
const redirect = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 302, headers: { Location: location, ...headers } });
const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const cookies = (request: Request): Record<string, string> =>
  Object.fromEntries(
    (request.headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== ''),
  );
const fromTokens = (tokens: TokenResponse): Tokens => ({
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token,
  accessExpiresAt: Date.now() + (tokens.expires_in ?? 600) * 1000,
});

export class Console {
  private readonly flows = new Map<string, Flow>();
  private readonly codes = new Map<
    string,
    { tokens: Tokens; principal: Principal; createdAt: number }
  >();
  private readonly sessions = new Map<string, Session>();

  constructor(
    readonly config: ConsoleConfig,
    readonly provider: ProviderMetadata,
  ) {}

  static async start(config: ConsoleConfig): Promise<Console> {
    return new Console(config, await discover(config.issuer));
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

  private get redirectUri(): string {
    return `${this.config.publicUrl}/oidc/callback`;
  }
  private get controllerInfo() {
    return {
      url: this.config.controllerPublicUrl,
      certificateAuthorityData: this.config.controllerCa
        ? Buffer.from(this.config.controllerCa).toString('base64')
        : undefined,
    };
  }

  /** Call the controller as the user. */
  private async controller<T>(
    path: string,
    accessToken: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.config.controllerUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${accessToken}`,
      },
      tls: this.config.controllerCa ? { ca: this.config.controllerCa } : undefined,
    } as RequestInit);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!response.ok) {
      let reason = `controller returned ${response.status}`;
      try {
        reason = (JSON.parse(text) as { message?: string }).message ?? reason;
      } catch {}
      throw new HttpError(response.status, reason);
    }
    return JSON.parse(text) as T;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, flow] of this.flows)
      if (now - flow.createdAt > FLOW_TTL_MS) this.flows.delete(id);
    for (const [id, code] of this.codes)
      if (now - code.createdAt > CODE_TTL_MS) this.codes.delete(id);
    for (const [id, session] of this.sessions)
      if (now > session.expiresAt) this.sessions.delete(id);
  }

  private async sessionFor(request: Request): Promise<Session | undefined> {
    const session = this.sessions.get(cookies(request)[SESSION_COOKIE] ?? '');
    if (!session || session.expiresAt < Date.now()) return undefined;
    if (session.accessExpiresAt - Date.now() < 30_000 && session.refreshToken) {
      const fresh = fromTokens(
        await refreshTokens(this.provider, {
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          refreshToken: session.refreshToken,
        }),
      );
      Object.assign(session, fresh);
    }
    return session;
  }

  private sameOrigin(request: Request): void {
    if (request.headers.get('origin') !== new URL(this.config.publicUrl).origin)
      throw new HttpError(403, 'cross-site form submission rejected');
  }

  async handle(request: Request): Promise<Response> {
    this.sweep();
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const api = url.pathname.startsWith('/cli/');
    try {
      if (route === 'GET /healthz') return json({ ok: true, tenant: this.config.tenant });
      if (route === 'GET /cli/info')
        return json({
          account: this.config.tenant,
          issuer: this.config.issuer,
          controller: this.controllerInfo,
        });
      if (route === 'GET /login') return this.login(url);
      if (route === 'GET /oidc/callback') return await this.callback(request, url);
      if (route === 'GET /logout') return this.logout(request);
      if (route === 'POST /cli/exchange') return await this.cliExchange(request);
      if (route === 'POST /cli/refresh') return await this.cliRefresh(request);
      if (route === 'POST /cli/logout') return await this.cliLogout(request);
      const session = await this.sessionFor(request);
      if (!session)
        return api ? json({ error: 'not signed in' }, 401) : html(landing(this.config.tenant));
      if (route === 'GET /') return await this.overview(session);
      if (route === 'GET /keys') return await this.keys(session);
      if (route === 'POST /keys') return await this.createKey(request, session);
      const revoke = /^POST \/keys\/([0-9a-f]{16})\/revoke$/.exec(route);
      if (revoke?.[1]) return await this.revokeKey(request, session, revoke[1]);
      if (route === 'GET /members') return await this.members(session);
      const logs = /^GET \/logs\/([a-z0-9-]+)$/.exec(route);
      if (logs?.[1]) return await this.logs(session, logs[1]);
      return html(message('Not found', `${url.pathname} is not a page here.`, true), 404);
    } catch (error) {
      if (error instanceof HttpError) {
        this.audit('request.denied', { route, status: error.status, reason: error.message });
        return api
          ? json({ error: error.message }, error.status)
          : html(message('Access denied', error.message, true), error.status);
      }
      this.audit('request.failed', { route, reason: String(error) });
      return api
        ? json({ error: 'internal error' }, 500)
        : html(message('Something went wrong', String(error), true), 500);
    }
  }

  // Sign-in

  private async login(url: URL): Promise<Response> {
    const callback = url.searchParams.get('cli_callback');
    const cliState = url.searchParams.get('cli_state');
    let cli: Flow['cli'];
    if (callback !== null || cliState !== null) {
      if (!callback || !CLI_CALLBACK.test(callback) || !cliState)
        throw new HttpError(400, 'cli_callback must be a loopback URL and cli_state is required');
      cli = { callback, state: cliState };
    }
    const { verifier, challenge } = await pkce();
    const flow: Flow = {
      state: randomToken(16),
      nonce: randomToken(16),
      verifier,
      createdAt: Date.now(),
      cli,
    };
    const id = randomToken(24);
    this.flows.set(id, flow);
    const location = authorizationUrl(this.provider, {
      clientId: this.config.clientId,
      redirectUri: this.redirectUri,
      scope: 'openid profile email offline_access',
      state: flow.state,
      nonce: flow.nonce,
      codeChallenge: challenge,
    });
    return redirect(location, { 'Set-Cookie': cookie(FLOW_COOKIE, id, FLOW_TTL_MS / 1000) });
  }

  private async callback(request: Request, url: URL): Promise<Response> {
    const id = cookies(request)[FLOW_COOKIE] ?? '';
    const flow = this.flows.get(id);
    this.flows.delete(id);
    if (!flow || Date.now() - flow.createdAt > FLOW_TTL_MS)
      throw new HttpError(400, 'the login attempt has expired; start again');
    const failure = url.searchParams.get('error');
    if (failure) throw new HttpError(403, `identity provider refused: ${failure}`);
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.get('state') !== flow.state)
      throw new HttpError(400, 'the login response does not match the attempt');
    const response = await exchangeCode(this.provider, {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.redirectUri,
      code,
      codeVerifier: flow.verifier,
    });
    if (!response.id_token) throw new HttpError(502, 'identity provider returned no ID token');
    await verifyIdToken(response.id_token, this.provider, {
      clientId: this.config.clientId,
      nonce: flow.nonce,
    });
    const tokens = fromTokens(response);
    // The controller decides whether this identity is a member of the tenant.
    const principal = await this.controller<Principal>('/-/whoami', tokens.accessToken);
    this.audit('login.succeeded', {
      user: principal.user,
      role: principal.role,
      via: flow.cli ? 'cli' : 'browser',
    });
    const headers = new Headers({ 'Set-Cookie': cookie(FLOW_COOKIE, '', 0) });
    if (flow.cli) {
      const oneTime = randomToken(32);
      this.codes.set(oneTime, { tokens, principal, createdAt: Date.now() });
      const target = new URL(flow.cli.callback);
      target.searchParams.set('code', oneTime);
      target.searchParams.set('state', flow.cli.state);
      headers.set('Location', target.toString());
      return new Response(null, { status: 302, headers });
    }
    const sid = randomToken(32);
    this.sessions.set(sid, { ...tokens, ...principal, expiresAt: Date.now() + SESSION_TTL_MS });
    headers.append('Set-Cookie', cookie(SESSION_COOKIE, sid, SESSION_TTL_MS / 1000));
    headers.set('Location', '/');
    return new Response(null, { status: 302, headers });
  }

  private logout(request: Request): Response {
    const sid = cookies(request)[SESSION_COOKIE] ?? '';
    const session = this.sessions.get(sid);
    this.sessions.delete(sid);
    if (session?.refreshToken)
      void revokeToken(
        this.provider,
        this.config.clientId,
        this.config.clientSecret,
        session.refreshToken,
      );
    return redirect('/', { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
  }

  // CLI token hand-off. The CLI only ever holds identity-server tokens.

  private async cliExchange(request: Request): Promise<Response> {
    const { code } = (await request.json()) as { code?: string };
    const pending = code ? this.codes.get(code) : undefined;
    if (code) this.codes.delete(code);
    if (!pending || Date.now() - pending.createdAt > CODE_TTL_MS)
      throw new HttpError(400, 'the login code is invalid or has expired');
    return json({
      ...pending.principal,
      accessToken: pending.tokens.accessToken,
      refreshToken: pending.tokens.refreshToken,
      expiresAt: new Date(pending.tokens.accessExpiresAt).toISOString(),
      controller: this.controllerInfo,
    });
  }

  private async cliRefresh(request: Request): Promise<Response> {
    const { refreshToken } = (await request.json()) as { refreshToken?: string };
    if (!refreshToken) throw new HttpError(400, 'refreshToken is required');
    let response: TokenResponse;
    try {
      response = await refreshTokens(this.provider, {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken,
      });
    } catch {
      throw new HttpError(401, 'the login has expired; sign in again');
    }
    const tokens = fromTokens(response);
    this.audit('token.refreshed', {});
    return json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(tokens.accessExpiresAt).toISOString(),
    });
  }

  private async cliLogout(request: Request): Promise<Response> {
    const { refreshToken } = (await request.json()) as { refreshToken?: string };
    if (refreshToken)
      await revokeToken(
        this.provider,
        this.config.clientId,
        this.config.clientSecret,
        refreshToken,
      );
    this.audit('logout', {});
    return new Response(null, { status: 204 });
  }

  // Pages, all rendered from controller calls made as the signed-in user.

  private get tenantNamespace(): string {
    return `di-tenant-${this.config.tenant}`;
  }

  private async overview(session: Session): Promise<Response> {
    interface Item {
      metadata: { name: string; creationTimestamp?: string };
      spec?: { class?: string };
      status?: { conditions?: { type: string; status: string; message?: string }[] };
    }
    const ready = (item: Item) => item.status?.conditions?.find((c) => c.type === 'Ready');
    const [deployments, services] = await Promise.all([
      this.controller<{ items: Item[] }>(
        `${WASMCLOUD_API}/namespaces/${this.tenantNamespace}/workloaddeployments`,
        session.accessToken,
      ),
      this.controller<{ items: Item[] }>(
        `${PLATFORM_API}/namespaces/${this.tenantNamespace}/backingservices`,
        session.accessToken,
      ),
    ]);
    return html(
      overview(
        session,
        deployments.items.map((d) => ({
          name: d.metadata.name,
          ready: ready(d)?.status,
          message: ready(d)?.message,
          age: d.metadata.creationTimestamp,
        })),
        services.items.map((s) => ({
          name: s.metadata.name,
          class: s.spec?.class,
          ready: ready(s)?.status,
        })),
      ),
    );
  }

  private async logs(session: Session, app: string): Promise<Response> {
    let entries: string[] = [];
    try {
      const configMap = await this.controller<{ data?: Record<string, string> }>(
        `/api/v1/namespaces/${this.tenantNamespace}/configmaps/di-logs-${app}`,
        session.accessToken,
      );
      entries = Object.values(configMap.data ?? {})
        .flatMap((chunk) => chunk.split('\n'))
        .filter(Boolean)
        .slice(-500);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error;
    }
    return html(logsPage(session, app, entries));
  }

  private async members(session: Session): Promise<Response> {
    const { members } = await this.controller<{
      members: { user: string; role: string; suspended: boolean }[];
    }>('/-/members', session.accessToken);
    return html(membersPage(session, members));
  }

  private async keys(session: Session, issued?: IssuedApiKey, error?: string): Promise<Response> {
    const { keys } = await this.controller<{ keys: ApiKey[] }>('/-/keys', session.accessToken);
    return html(keysPage(session, keys, issued, error), error ? 400 : 200);
  }

  private async createKey(request: Request, session: Session): Promise<Response> {
    this.sameOrigin(request);
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim();
    const days = Number(form.get('days'));
    if (!name || name.length > 64 || !Number.isInteger(days) || days < 1 || days > 365)
      return this.keys(session, undefined, 'Give the key a name and an expiry.');
    const issued = await this.controller<IssuedApiKey>('/-/keys', session.accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ttlSeconds: days * 86_400 }),
    });
    return this.keys(session, issued);
  }

  private async revokeKey(request: Request, session: Session, id: string): Promise<Response> {
    this.sameOrigin(request);
    await this.controller(`/-/keys/${id}`, session.accessToken, { method: 'DELETE' }).catch(
      (error) => {
        if (!(error instanceof HttpError && error.status === 404)) throw error;
      },
    );
    return redirect('/keys');
  }
}

if (import.meta.main) {
  const config = configFromEnv();
  const app = await Console.start(config);
  Bun.serve({
    hostname: config.host,
    port: config.port,
    // The OIDC callback waits for the identity server's token exchange, which verifies the
    // client secret with Argon2id; on the Wasm guest that takes about 30 s, past Bun's 10 s default.
    idleTimeout: 120,
    fetch: (request) => app.handle(request),
  });
  app.audit('console.started', {
    url: config.publicUrl,
    issuer: config.issuer,
    controller: config.controllerUrl,
  });
}
