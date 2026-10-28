import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Console, type ConsoleConfig, configFromEnv } from '../src/console.ts';
import { type FakeServer, json, serve } from './support/servers.ts';

async function signer(kid: string) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  const sign = async (claims: Record<string, unknown>) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', kid })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(input),
    );
    return `${input}.${Buffer.from(signature).toString('base64url')}`;
  };
  return { jwk, sign };
}

/** A fake identity-server: discovery, JWKS, the token endpoint, and revocation. */
interface Issuer extends FakeServer {
  /** Nonce to embed in the ID token for an authorization code. */
  nonces: Map<string, string>;
  /** Access token lifetime handed out, in seconds. */
  expiresIn: number;
  omitIdToken: boolean;
  /** Fail every refresh_token grant. */
  failRefresh: boolean;
  /** When set, refresh_token grants wait for this before answering. */
  gate?: Promise<void>;
  refreshes: string[];
}

async function fakeIssuer(): Promise<Issuer> {
  const { jwk, sign } = await signer('k1');
  let rotation = 0;
  const state: Omit<Issuer, keyof FakeServer> = {
    nonces: new Map<string, string>(),
    expiresIn: 600,
    omitIdToken: false,
    failRefresh: false,
    gate: undefined,
    refreshes: [],
  };
  const server = serve(async (request) => {
    const state = fake;
    const url = server.url;
    if (request.pathname === '/.well-known/openid-configuration')
      return json({
        issuer: url,
        authorization_endpoint: `${url}/oauth2/authorize`,
        token_endpoint: `${url}/oauth2/token`,
        jwks_uri: `${url}/oauth2/jwks`,
      });
    if (request.pathname === '/oauth2/jwks') return json({ keys: [jwk] });
    if (request.pathname === '/oauth2/revoke') return new Response(null, { status: 200 });
    if (request.pathname !== '/oauth2/token') return json({}, 404);
    const form = new URLSearchParams(request.body);
    if (form.get('grant_type') === 'refresh_token') {
      state.refreshes.push(form.get('refresh_token') ?? '');
      await state.gate;
      if (state.failRefresh) return json({ error: 'invalid_grant' }, 400);
      rotation++;
      return json({
        access_token: `at-${rotation}`,
        refresh_token: `rt-${rotation}`,
        token_type: 'Bearer',
        expires_in: state.expiresIn,
      });
    }
    const code = form.get('code') ?? '';
    const nonce = state.nonces.get(code);
    return json({
      access_token: `at-${code}`,
      refresh_token: `rt-${code}`,
      token_type: 'Bearer',
      expires_in: state.expiresIn,
      id_token: state.omitIdToken
        ? undefined
        : await sign({
            iss: url,
            sub: 'u1',
            aud: 'tenant-auth',
            exp: Math.floor(Date.now() / 1000) + 600,
            nonce,
          }),
    });
  });
  // Tests change the knobs on the returned object, so the handler reads them from there.
  const fake: Issuer = Object.assign(server, state);
  return fake;
}

/** A fake tenant controller that answers the console's calls as the user. */
interface Controller extends FakeServer {
  /** Paths that answer with a non-JSON 500, to exercise unexpected failures. */
  broken: Set<string>;
  /** Paths that answer with a controller error status and message. */
  failing: Map<string, { status: number; message: string }>;
}
function fakeController(): Controller {
  const broken = new Set<string>();
  const failing = new Map<string, { status: number; message: string }>();
  const key = {
    id: '0123456789abcdef',
    name: 'ci',
    tenant: 'acme',
    user: 'alice',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-08T00:00:00.000Z',
  };
  const ns = 'di-tenant-acme';
  const workloads = `/apis/runtime.wasmcloud.dev/v1alpha1/namespaces/${ns}/workloaddeployments`;
  /** The labels /v1/deploy renders on service web's WorkloadDeployment in `env`. */
  const v1 = (env: string) => ({
    metadata: {
      name: `web-${env}`,
      labels: {
        'app.kubernetes.io/managed-by': 'di-framework',
        'app.kubernetes.io/name': `web-${env}`,
        'di-framework.dev/application': 'web',
        'di-framework.dev/service': 'web',
        'platform.di-framework.dev/env': env,
      },
    },
  });
  const ring = (lines: [string, string][], labels: Record<string, string> = {}) => ({
    metadata: { labels: { 'di-framework.dev/application': 'web', ...labels } },
    data: {
      lines: lines.map(([line]) => line).join('\n'),
      deployments: JSON.stringify(lines.map(([, deployment]) => deployment)),
    },
  });
  const server = serve((request) => {
    if (broken.has(request.pathname)) return new Response('not json', { status: 200 });
    const failure = failing.get(request.pathname);
    if (failure) return json({ message: failure.message }, failure.status);
    switch (`${request.method} ${request.pathname}`) {
      case 'GET /-/whoami':
        return json({ account: 'acme', user: 'alice', role: 'admin', via: 'oidc' });
      case `GET ${workloads}`:
        return json({
          items: [
            {
              metadata: { name: 'hello', creationTimestamp: '2026-10-01T00:00:00Z' },
              status: { conditions: [{ type: 'Ready', status: 'True', message: 'running' }] },
            },
            { metadata: { name: 'pending' } },
            v1('staging'),
            { metadata: { name: 'web', labels: { 'di-framework.dev/application': 'web' } } },
            v1('prod'),
          ],
        });
      case `GET ${workloads}/hello`:
      case `GET ${workloads}/empty`:
      case `GET ${workloads}/forbidden`:
        return json({ metadata: { name: request.pathname.split('/').at(-1) } });
      case `GET ${workloads}/web-prod`:
        return json(v1('prod'));
      case `GET ${workloads}/web-staging`:
        return json(v1('staging'));
      case `GET ${workloads}/web`:
        return json({
          metadata: { name: 'web', labels: { 'di-framework.dev/application': 'web' } },
        });
      // Per-env projection of web-prod, and the CLI workload `web`'s own projection.
      case `GET /api/v1/namespaces/${ns}/configmaps/di-logs-web.prod`:
        return json(
          ring([['2026-10-01T00:00:01Z INFO prod up', 'web-prod']], {
            'platform.di-framework.dev/env': 'prod',
          }),
        );
      // Shared by staging and prod before #106; web-staging has no per-env one yet.
      case `GET /api/v1/namespaces/${ns}/configmaps/di-logs-web`:
        return json(
          ring([
            ['2026-10-01T00:00:00Z INFO staging up', 'web-staging'],
            ['2026-10-01T00:00:00Z INFO old prod line', 'web-prod'],
            ['2026-10-01T00:00:02Z INFO cli up', 'web'],
            ['2026-10-01T00:00:03Z INFO unattributed', ''],
          ]),
        );
      case `GET /apis/platform.di-framework.dev/v1alpha1/namespaces/${ns}/backingservices`:
        return json({ items: [{ metadata: { name: 'db' }, spec: { class: 'sqlite' } }] });
      case `GET /api/v1/namespaces/${ns}/configmaps/di-logs-hello`:
        return json({
          data: {
            lines: 'line one\nline two\nline three',
            failures: JSON.stringify({ hello: { message: 'not a line' } }),
          },
        });
      case `GET /api/v1/namespaces/${ns}/configmaps/di-logs-empty`:
        return json({});
      case `GET /api/v1/namespaces/${ns}/configmaps/di-logs-forbidden`:
        return json({ message: 'logs are not yours' }, 403);
      case 'GET /-/members':
        return json({ members: [{ user: 'alice', role: 'admin', suspended: false }] });
      case 'GET /-/keys':
        return json({ keys: [key] });
      case 'POST /-/keys':
        return json({ ...key, ...JSON.parse(request.body), secret: 'dik_secret' }, 201);
      case `DELETE /-/keys/${key.id}`:
        return new Response(null, { status: 204 });
      case 'DELETE /-/keys/fedcba9876543210':
        return new Response('gone', { status: 500 });
      default:
        return json({ message: 'no such thing' }, 404);
    }
  });
  return Object.assign(server, { broken, failing });
}

let issuer: Issuer;
let controller: Controller;
let log: ReturnType<typeof spyOn<typeof console, 'log'>>;
const PUBLIC_URL = 'https://console.example';

beforeAll(async () => {
  issuer = await fakeIssuer();
  controller = fakeController();
  log = spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  log.mockRestore();
  issuer.stop();
  controller.stop();
});
afterEach(() => {
  issuer.expiresIn = 600;
  issuer.omitIdToken = false;
  issuer.failRefresh = false;
  issuer.gate = undefined;
  issuer.refreshes.length = 0;
  controller.broken.clear();
  controller.failing.clear();
});

const config = (overrides: Partial<ConsoleConfig> = {}): ConsoleConfig => ({
  tenant: 'acme',
  controllerUrl: controller.url,
  controllerPublicUrl: 'https://controller.example',
  issuer: issuer.url,
  clientId: 'tenant-auth',
  clientSecret: 's3cret',
  host: '127.0.0.1',
  port: 0,
  publicUrl: PUBLIC_URL,
  ...overrides,
});

const get = (app: Console, path: string, headers: Record<string, string> = {}) =>
  app.handle(new Request(`${PUBLIC_URL}${path}`, { headers }));
const post = (app: Console, path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  app.handle(new Request(`${PUBLIC_URL}${path}`, { method: 'POST', body, headers }));
const setCookie = (response: Response) => response.headers.getSetCookie().join('; ');
const cookieValue = (response: Response, name: string) =>
  new RegExp(`${name}=([^;]*)`).exec(setCookie(response))?.[1] ?? '';

/** Wait for a condition driven by another request, failing after a second. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

let codes = 0;
/** Run the browser (or CLI) sign-in flow and return the callback response. */
async function signIn(app: Console, query = ''): Promise<Response> {
  const login = await get(app, `/login${query}`);
  expect(login.status).toBe(302);
  const authorize = new URL(login.headers.get('location') ?? '');
  const flow = cookieValue(login, 'tenant_console_flow');
  const code = `code-${++codes}`;
  issuer.nonces.set(code, authorize.searchParams.get('nonce') ?? '');
  return get(app, `/oidc/callback?code=${code}&state=${authorize.searchParams.get('state')}`, {
    cookie: `tenant_console_flow=${flow}`,
  });
}
async function session(app: Console): Promise<string> {
  const response = await signIn(app);
  expect(response.headers.get('location')).toBe('/');
  return `tenant_console_session=${cookieValue(response, 'tenant_console_session')}`;
}

describe('configFromEnv', () => {
  test('requires the tenant and client secret', () => {
    expect(() => configFromEnv({})).toThrow('TENANT_CONSOLE_TENANT is required');
    expect(() => configFromEnv({ TENANT_CONSOLE_TENANT: 'acme' })).toThrow(
      'TENANT_CONSOLE_CLIENT_SECRET is required',
    );
  });
  test('fills in defaults', () => {
    expect(
      configFromEnv({ TENANT_CONSOLE_TENANT: 'acme', TENANT_CONSOLE_CLIENT_SECRET: 's' }),
    ).toEqual({
      tenant: 'acme',
      controllerUrl: 'https://127.0.0.1:8788',
      controllerPublicUrl: 'https://127.0.0.1:8788',
      controllerCa: undefined,
      issuer: 'http://localhost:4180',
      clientId: 'tenant-auth',
      clientSecret: 's',
      host: '127.0.0.1',
      port: 8787,
      publicUrl: 'http://127.0.0.1:8787',
    });
  });
  test('reads overrides and the controller CA file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'console-ca-'));
    try {
      writeFileSync(join(dir, 'ca.pem'), 'PEM');
      const loaded = configFromEnv({
        TENANT_CONSOLE_TENANT: 'acme',
        TENANT_CONSOLE_CLIENT_SECRET: 's',
        TENANT_CONSOLE_HOST: '0.0.0.0',
        TENANT_CONSOLE_PORT: '9000',
        TENANT_CONSOLE_CONTROLLER_URL: 'https://controller.internal/',
        TENANT_CONSOLE_CONTROLLER_CA: join(dir, 'ca.pem'),
        TENANT_CONSOLE_ISSUER: 'https://id.example',
        TENANT_CONSOLE_CLIENT_ID: 'console',
        TENANT_CONSOLE_PUBLIC_URL: 'https://acme.example',
      });
      expect(loaded).toMatchObject({
        controllerUrl: 'https://controller.internal',
        controllerPublicUrl: 'https://controller.internal',
        controllerCa: 'PEM',
        issuer: 'https://id.example',
        clientId: 'console',
        port: 9000,
        publicUrl: 'https://acme.example',
      });
      expect(
        configFromEnv({
          TENANT_CONSOLE_TENANT: 'acme',
          TENANT_CONSOLE_CLIENT_SECRET: 's',
          TENANT_CONSOLE_CONTROLLER_PUBLIC_URL: 'https://public.example/',
        }).controllerPublicUrl,
      ).toBe('https://public.example');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Console', () => {
  let app: Console;
  beforeAll(async () => {
    app = await Console.start(config());
    await app.discovered;
  });

  test('serves health and CLI discovery', async () => {
    expect(await (await get(app, '/healthz')).json()).toEqual({
      ok: true,
      tenant: 'acme',
      discoveryReady: true,
    });
    expect(await (await get(app, '/cli/info')).json()).toEqual({
      account: 'acme',
      issuer: issuer.url,
      controller: { url: 'https://controller.example' },
    });
    const withCa = new Console(config({ controllerCa: 'PEM' }), app.provider);
    expect(
      ((await (await get(withCa, '/cli/info')).json()) as { controller: unknown }).controller,
    ).toEqual({
      url: 'https://controller.example',
      certificateAuthorityData: Buffer.from('PEM').toString('base64'),
    });
  });

  test('shows the landing page and rejects the API without a session', async () => {
    const landing = await get(app, '/');
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain('Sign in');
    const api = await get(app, '/cli/whatever');
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'not signed in' });
  });

  test('starts a PKCE login', async () => {
    const response = await get(app, '/login');
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(`${issuer.url}/oauth2/authorize`);
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/oidc/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(cookieValue(response, 'tenant_console_flow')).not.toBe('');
  });

  test('rejects a CLI login without a loopback callback', async () => {
    const response = await get(app, '/login?cli_callback=https://evil.example/callback');
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('cli_callback must be a loopback URL');
  });

  test('rejects callbacks that do not match a login attempt', async () => {
    expect((await get(app, '/oidc/callback?code=x')).status).toBe(400);
    const flowFor = async () =>
      `tenant_console_flow=${cookieValue(await get(app, '/login'), 'tenant_console_flow')}`;
    const refused = await get(app, '/oidc/callback?error=access_denied', {
      cookie: await flowFor(),
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('identity provider refused: access_denied');
    const mismatch = await get(app, '/oidc/callback?code=x&state=wrong', {
      cookie: await flowFor(),
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain('does not match the attempt');
  });

  test('requires an ID token from the provider', async () => {
    issuer.omitIdToken = true;
    const response = await signIn(app);
    expect(response.status).toBe(502);
    const page = await response.text();
    expect(page).toContain('Something went wrong');
    expect(page).not.toContain('returned no ID token');
  });

  test('signs a browser in and renders pages as the user', async () => {
    const cookie = await session(app);
    const overview = await get(app, '/', { cookie });
    const page = await overview.text();
    expect(overview.status).toBe(200);
    expect(page).toContain('Signed in as <strong>alice</strong>');
    expect(page).toContain('/logs/hello');
    expect(page).toContain('sqlite');
    const auth = controller.requests.at(-1)?.headers.get('authorization');
    expect(auth).toMatch(/^Bearer at-code-/);

    expect(await (await get(app, '/members', { cookie })).text()).toContain('active');
    expect(await (await get(app, '/keys', { cookie })).text()).toContain('0123456789abcdef');
    const hello = await (await get(app, '/logs/hello', { cookie })).text();
    expect(hello).toContain('line three');
    expect(hello).not.toContain('not a line');
    expect(await (await get(app, '/logs/empty', { cookie })).text()).toContain('No projected');
    expect(await (await get(app, '/logs/missing', { cookie })).text()).toContain('No projected');
    const forbidden = await get(app, '/logs/forbidden', { cookie });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toContain('logs are not yours');
    const missing = await get(app, '/nowhere', { cookie });
    expect(missing.status).toBe(404);
  });

  test('groups deployments by application and env, with logs per deployment (#106)', async () => {
    const cookie = await session(app);
    const page = await (await get(app, '/', { cookie })).text();
    const rows = [
      ...page.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td><td><a href="\/logs\/([^"]+)"/g),
    ].map((m) => m.slice(1).join(' '));
    expect(rows).toEqual([
      'hello  hello',
      'pending  pending',
      'web  web',
      'web prod web-prod',
      'web staging web-staging',
    ]);
    const prod = await (await get(app, '/logs/web-prod', { cookie })).text();
    expect(prod).toContain('web · prod');
    expect(prod).toContain('prod up');
    expect(prod).not.toContain('staging up');
    // Not moved out of the shared ConfigMap yet: only web-staging's lines are shown.
    const staging = await (await get(app, '/logs/web-staging', { cookie })).text();
    expect(staging).toContain('staging up');
    for (const other of ['old prod line', 'cli up', 'unattributed'])
      expect(staging).not.toContain(other);
    // The CLI workload `web` reads its own projection, never a /v1 env's.
    const cli = await (await get(app, '/logs/web', { cookie })).text();
    expect(cli).toContain('cli up');
    expect(cli).toContain('unattributed');
    expect(cli).not.toContain('staging up');
  });

  test('creates and revokes API keys from same-origin forms', async () => {
    const cookie = await session(app);
    const form = (fields: Record<string, string>) => new URLSearchParams(fields);
    const origin = { cookie, origin: PUBLIC_URL };

    const crossSite = await post(app, '/keys', form({ name: 'ci', days: '7' }), { cookie });
    expect(crossSite.status).toBe(403);
    const invalid = await post(app, '/keys', form({ name: '', days: '7' }), origin);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('Give the key a name');
    const created = await post(app, '/keys', form({ name: 'ci', days: '7' }), origin);
    expect(created.status).toBe(200);
    expect(await created.text()).toContain('dik_secret');
    expect(JSON.parse(controller.requests.at(-2)?.body ?? '{}')).toEqual({
      name: 'ci',
      ttlSeconds: 7 * 86_400,
    });

    const revoked = await post(app, '/keys/0123456789abcdef/revoke', '', origin);
    expect(revoked.headers.get('location')).toBe('/keys');
    const unknown = await post(app, '/keys/aaaaaaaaaaaaaaaa/revoke', '', origin);
    expect(unknown.headers.get('location')).toBe('/keys');
    const failed = await post(app, '/keys/fedcba9876543210/revoke', '', origin);
    expect(failed.status).toBe(500);
    const failedPage = await failed.text();
    expect(failedPage).toContain('Something went wrong');
    expect(failedPage).not.toContain('controller returned 500');
  });

  test('hands the CLI its tokens through a one-time code', async () => {
    const response = await signIn(
      app,
      '?cli_callback=http://127.0.0.1:4567/callback&cli_state=cli-state',
    );
    const target = new URL(response.headers.get('location') ?? '');
    expect(target.origin + target.pathname).toBe('http://127.0.0.1:4567/callback');
    expect(target.searchParams.get('state')).toBe('cli-state');
    const code = target.searchParams.get('code') ?? '';
    const exchanged = await post(app, '/cli/exchange', JSON.stringify({ code }));
    expect(await exchanged.json()).toMatchObject({
      user: 'alice',
      accessToken: expect.stringMatching(/^at-code-/),
      refreshToken: expect.stringMatching(/^rt-code-/),
      controller: { url: 'https://controller.example' },
    });
    const replayed = await post(app, '/cli/exchange', JSON.stringify({ code }));
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toEqual({ error: 'the login code is invalid or has expired' });
    expect((await post(app, '/cli/exchange', JSON.stringify({}))).status).toBe(400);
  });

  test('refreshes and revokes CLI tokens', async () => {
    expect((await post(app, '/cli/refresh', JSON.stringify({}))).status).toBe(400);
    const refreshed = await post(app, '/cli/refresh', JSON.stringify({ refreshToken: 'rt-x' }));
    expect(await refreshed.json()).toMatchObject({ accessToken: expect.stringMatching(/^at-/) });
    issuer.failRefresh = true;
    const expired = await post(app, '/cli/refresh', JSON.stringify({ refreshToken: 'rt-x' }));
    expect(expired.status).toBe(401);

    const before = issuer.requests.length;
    expect((await post(app, '/cli/logout', JSON.stringify({ refreshToken: 'rt-x' }))).status).toBe(
      204,
    );
    expect(issuer.requests.slice(before).map((r) => r.pathname)).toEqual(['/oauth2/revoke']);
    expect((await post(app, '/cli/logout', JSON.stringify({}))).status).toBe(204);
  });

  test('signs a browser out and revokes its refresh token', async () => {
    const cookie = await session(app);
    const before = issuer.requests.length;
    const response = await get(app, '/logout', { cookie });
    expect(response.headers.get('location')).toBe('/');
    expect(setCookie(response)).toContain('tenant_console_session=;');
    // Revocation is fire-and-forget, so wait for it to reach the provider.
    await until(() => issuer.requests.length > before);
    expect(issuer.requests.slice(before).map((r) => r.pathname)).toEqual(['/oauth2/revoke']);
    expect(await (await get(app, '/', { cookie })).text()).toContain('Sign in');
    expect((await get(app, '/logout')).status).toBe(302);
  });

  test('forgets expired flows, codes, and sessions', async () => {
    const cookie = await session(app);
    const login = await get(app, '/login');
    const flow = `tenant_console_flow=${cookieValue(login, 'tenant_console_flow')}`;
    const cli = await signIn(app, '?cli_callback=http://127.0.0.1:4567/callback&cli_state=s');
    const code = new URL(cli.headers.get('location') ?? '').searchParams.get('code');
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now + 13 * 3_600_000);
    try {
      expect(await (await get(app, '/', { cookie })).text()).toContain('Sign in');
      expect((await get(app, '/oidc/callback?code=x', { cookie: flow })).status).toBe(400);
      expect((await post(app, '/cli/exchange', JSON.stringify({ code }))).status).toBe(400);
    } finally {
      clock.mockRestore();
    }
  });

  test('treats a session past its lifetime as signed out before the sweep runs', async () => {
    const cookie = await session(app);
    const now = Date.now();
    // sweep() reads the clock first and sees the session alive; sessionFor reads it later.
    let calls = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() =>
      ++calls === 1 ? now : now + 13 * 3_600_000,
    );
    try {
      expect(await (await get(app, '/', { cookie })).text()).toContain('Sign in');
    } finally {
      clock.mockRestore();
    }
  });
});

describe('session refresh', () => {
  let app: Console;
  beforeAll(async () => {
    app = await Console.start(config());
    await app.discovered;
  });

  test('concurrent requests near expiry share exactly one refresh', async () => {
    issuer.expiresIn = 10;
    const cookie = await session(app);
    let release = () => {};
    issuer.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    issuer.expiresIn = 600;
    const pending = Promise.all([
      get(app, '/members', { cookie }),
      get(app, '/keys', { cookie }),
      get(app, '/', { cookie }),
    ]);
    // Every request has reached sessionFor before the first refresh is even sent.
    await until(() => issuer.refreshes.length > 0);
    await Bun.sleep(20);
    release();
    const responses = await pending;
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(issuer.refreshes).toHaveLength(1);
    expect(issuer.refreshes[0]).toMatch(/^rt-code-/);

    // The rotated tokens are used from then on, and a fresh token needs no further refresh.
    const auth = controller.requests.at(-1)?.headers.get('authorization');
    expect(auth).toMatch(/^Bearer at-\d+$/);
    expect((await get(app, '/members', { cookie })).status).toBe(200);
    expect(issuer.refreshes).toHaveLength(1);
  });

  test('a failed refresh drops the session and asks the user to sign in again', async () => {
    issuer.expiresIn = 10;
    const cookie = await session(app);
    issuer.failRefresh = true;
    const [first, second] = await Promise.all([
      get(app, '/', { cookie }),
      get(app, '/members', { cookie }),
    ]);
    expect(issuer.refreshes).toHaveLength(1);
    for (const response of [first, second]) {
      expect(response.status).toBe(200);
      expect(setCookie(response)).toContain('tenant_console_session=;');
      const page = await response.text();
      expect(page).toContain('Your session has expired. Sign in again.');
      expect(page).not.toContain('invalid_grant');
    }
    expect(JSON.stringify(log.mock.calls)).toContain('session.refresh_failed');

    // The session is gone: no further refresh is attempted and the plain landing page shows.
    const after = await get(app, '/', { cookie });
    expect(await after.text()).not.toContain('session has expired');
    expect(issuer.refreshes).toHaveLength(1);
  });

  test('a failed refresh answers the API with 401', async () => {
    issuer.expiresIn = 10;
    const cookie = await session(app);
    issuer.failRefresh = true;
    const response = await get(app, '/cli/whatever', { cookie });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'the session has expired; sign in again' });
    expect(setCookie(response)).toContain('tenant_console_session=;');
  });
});

describe('unexpected failures', () => {
  let app: Console;
  beforeAll(async () => {
    app = await Console.start(config());
    await app.discovered;
  });

  test('the 500 page does not leak the error text', async () => {
    const cookie = await session(app);
    controller.broken.add('/-/members');
    log.mockClear();
    const response = await get(app, '/members', { cookie });
    expect(response.status).toBe(500);
    const page = await response.text();
    expect(page).toContain('Something went wrong');
    expect(page).toContain('The console could not complete the request.');
    expect(page).not.toContain('SyntaxError');
    expect(page).not.toContain('JSON');
    // The detail is still logged server-side.
    const logged = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(logged).toMatchObject({ event: 'request.failed', route: 'GET /members' });
    expect(logged.reason).toContain('SyntaxError');
  });

  test('a controller 502 shows a generic page, not its message (#84)', async () => {
    const cookie = await session(app);
    controller.failing.set('/-/members', {
      status: 502,
      message:
        'GET /api/v1/namespaces/wasmcloud/serviceaccounts failed: TypeError: https://10.0.0.1:6443',
    });
    log.mockClear();
    const response = await get(app, '/members', { cookie });
    expect(response.status).toBe(502);
    const page = await response.text();
    expect(page).toContain('Something went wrong');
    expect(page).not.toContain('Access denied');
    expect(page).not.toContain('10.0.0.1');
    expect(page).not.toContain('serviceaccounts');
    const logged = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(logged).toMatchObject({ event: 'request.failed', route: 'GET /members', status: 502 });
    expect(logged.reason).toContain('10.0.0.1');
  });

  test('the API answers a generic 500', async () => {
    const response = await post(app, '/cli/exchange', 'not json');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal error' });
  });
});

/**
 * #489: the console serves while its issuer is unreachable and recovers without a restart,
 * instead of exiting after a discovery retry budget (which crash-looped the pod).
 */
describe('Console.start with the issuer unreachable at first', () => {
  let issuerUp = false;
  let gate: FakeServer;
  let app: Console;
  let server: ReturnType<typeof Bun.serve>;
  let startedIn: number;

  beforeAll(async () => {
    // Answers 503 until `issuerUp`, then serves the fake issuer's own discovery document.
    gate = serve((request) => {
      if (!issuerUp) return json({ error: 'starting' }, 503);
      if (request.pathname === '/.well-known/openid-configuration')
        return fetch(`${issuer.url}/.well-known/openid-configuration`);
      return json({}, 404);
    });
    log.mockClear();
    const began = performance.now();
    app = await Console.start({
      ...config({ issuer: gate.url }),
      discoveryBackoff: { initialMs: 10, maxMs: 40 },
    });
    startedIn = performance.now() - began;
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => app.handle(r) });
  });
  afterAll(() => {
    app.stop();
    server.stop(true);
    gate.stop();
  });

  test('start returns at once and /healthz serves over HTTP, reporting discovery pending', async () => {
    expect(startedIn).toBeLessThan(1_000);
    expect(app.provider).toBeNull();
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, tenant: 'acme', discoveryReady: false });
    await until(() => JSON.stringify(log.mock.calls).includes('discovery.failed'));
  });

  test('issuer-independent routes still answer', async () => {
    expect(await (await get(app, '/cli/info')).json()).toMatchObject({
      account: 'acme',
      issuer: gate.url,
    });
    const landing = await get(app, '/');
    expect(landing.status).toBe(200);
    const body = await landing.text();
    expect(body).toContain('Sign-in is unavailable');
    expect(body).not.toContain('>Sign in</button>');
    expect((await get(app, '/cli/anything')).status).toBe(401);
  });

  test('issuer-dependent routes answer 503 with Retry-After, not an error page or a 401', async () => {
    const login = await get(app, '/login');
    expect(login.status).toBe(503);
    expect(Number(login.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const page = await login.text();
    expect(page).toContain('Sign-in unavailable');
    expect(page).not.toContain('Something went wrong');

    for (const path of ['/cli/refresh', '/cli/logout']) {
      const response = await post(app, path, JSON.stringify({ refreshToken: 'rt' }));
      expect(response.status).toBe(503);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(await response.json()).toEqual({
        error: 'the identity provider is not reachable yet; retry shortly',
      });
    }
  });

  test('the same console recovers when the issuer comes up, without a restart', async () => {
    issuerUp = true;
    await app.discovered;
    expect(app.provider?.issuer).toBe(issuer.url);
    expect(await (await get(app, '/healthz')).json()).toMatchObject({ discoveryReady: true });
    expect(JSON.stringify(log.mock.calls)).toContain('discovery.succeeded');
    const landing = await (await get(app, '/')).text();
    expect(landing).not.toContain('Sign-in is unavailable');
    expect(landing).toContain('>Sign in</button>');
    const cookie = await session(app);
    expect((await get(app, '/members', { cookie })).status).toBe(200);
  });

  test('stop() ends discovery for a console whose issuer never answers', async () => {
    const down = await Console.start({
      ...config({ issuer: 'http://127.0.0.1:1' }),
      discoveryBackoff: { initialMs: 10, maxMs: 40 },
    });
    const failures = () =>
      log.mock.calls.filter(
        ([line]) =>
          String(line).includes('discovery.failed') && String(line).includes('127.0.0.1:1'),
      ).length;
    await until(() => failures() > 0);
    down.stop();
    await down.discovered;
    const atStop = failures();
    // Longer than maxMs: a loop still running would log another attempt in this window.
    await Bun.sleep(100);
    expect(failures()).toBe(atStop);
    expect(down.provider).toBeNull();
  });
});
