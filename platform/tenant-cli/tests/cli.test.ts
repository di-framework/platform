import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Io, parseArgs, run, USAGE } from '../src/cli.ts';
import { type Credential, readStore, writeStore } from '../src/credentials.ts';
import { pkce } from '../src/oidc.ts';
import { fakeFetch, type Recorded, sse } from './support/fake-fetch.ts';

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!condition()) throw new Error('condition never held');
}

let scratch: string;
let env: NodeJS.ProcessEnv;
const out: string[] = [];
const err: string[] = [];
let stdin = '';
const opened: string[] = [];

const credential: Credential = {
  account: 'acme',
  user: 'alice',
  role: 'developer',
  via: 'api-key',
  apiKey: 'dik_x',
  controller: { url: 'https://controller.test' },
};

function io(fetch?: typeof globalThis.fetch, loginTimeoutMs?: number): Io {
  return {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdin: () => stdin,
    open: (url) => opened.push(url),
    env,
    cwd: scratch,
    fetch,
    loginTimeoutMs,
  };
}

const issuer = {
  issuer: 'https://issuer.test',
  authorization_endpoint: 'https://issuer.test/oauth2/authorize',
  token_endpoint: 'https://issuer.test/oauth2/token',
  revocation_endpoint: 'https://issuer.test/oauth2/revoke',
};

/** The browser's part: follow the printed authorize URL back to the CLI's loopback callback. */
async function browserReturns(query: Record<string, string>): Promise<Response> {
  const authorize = new URL(opened.at(-1) as string);
  const callback = new URL(authorize.searchParams.get('redirect_uri') as string);
  const params = { state: authorize.searchParams.get('state') as string, ...query };
  callback.search = new URLSearchParams(params).toString();
  return fetch(callback);
}

const json = (value: unknown, status = 200) => Response.json(value, { status });
const noContent = () => new Response(null, { status: 204 });

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tenant-cli-'));
  env = { DI_FRAMEWORK_HOME: join(scratch, 'home') };
  out.length = 0;
  err.length = 0;
  stdin = '';
  opened.length = 0;
  writeStore({ acme: credential }, env);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('parseArgs', () => {
  test('flags with values, equals, booleans, and -- passthrough', () => {
    expect(
      parseArgs(['logs', '--service', 'web', '--env=prod', '--follow', '--', '--raw']),
    ).toEqual({
      command: 'logs',
      flags: { service: 'web', env: 'prod', follow: 'true' },
      positionals: ['--raw'],
    });
    expect(parseArgs([])).toEqual({ command: 'help', flags: {}, positionals: [] });
    expect(() => parseArgs(['logs', '--service'])).toThrow('--service needs a value');
    expect(() => parseArgs(['logs', '--service', '--env'])).toThrow('--service needs a value');
  });
});

describe('run', () => {
  test('help, unknown commands, and usage errors', async () => {
    expect(await run([], io())).toBe(0);
    expect(out[0]).toBe(USAGE);
    expect(await run(['nope'], io())).toBe(2);
    expect(err[0]).toContain('unknown command nope');
    expect(await run(['deploy', 'sideways'], io())).toBe(1);
    expect(await run(['deploy', 'apply', '--env', 'qa'], io())).toBe(1);
    expect(err.at(-1)).toBe('--env must be prod or staging');
    expect(await run(['deploy', 'apply', '--env', 'prod'], io())).toBe(1);
    expect(err.at(-1)).toBe('--bundle is required');
    expect(await run(['services', 'list'], io())).toBe(1);
    expect(await run(['services', 'create', 'lambda', '--env', 'prod'], io())).toBe(1);
    expect(err.at(-1)).toBe('service type must be http, cron, or worker');
    expect(await run(['deployments', 'prune', '--env', 'prod'], io())).toBe(1);
    expect(await run(['secrets', 'rotate', '--env', 'prod'], io())).toBe(1);
    expect(await run(['logs', '--service', 'web', '--env', 'prod', '--tail', 'x'], io())).toBe(1);
    expect(err.at(-1)).toBe('--tail must be a whole number');
  });

  test('login needs a controller, checks the account, and stores an API-key credential', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/auth/info': () =>
        json({ account: 'acme', issuer: 'https://issuer.test', clientId: 'tenant-cli' }),
      'GET /v1/auth/whoami': () =>
        json({ user: 'bob', account: 'acme', role: 'viewer', via: 'api-key' }),
    });
    expect(await run(['login'], io(fetch))).toBe(1);
    expect(err.at(-1)).toBe('--controller is required');
    expect(
      await run(
        ['login', '--controller', 'https://controller.test/', '--account', 'beta'],
        io(fetch),
      ),
    ).toBe(1);
    expect(err.at(-1)).toContain('serves account acme, not beta');
    expect(
      await run(
        ['login', '--controller', 'https://controller.test', '--api-key', 'dik_new'],
        io(fetch),
      ),
    ).toBe(0);
    expect(err.at(-1)).toBe('Logged in to acme as bob (viewer) via api-key.');
    expect(readStore(env).acme).toMatchObject({ user: 'bob', apiKey: 'dik_new', via: 'api-key' });
    expect(calls.at(-1)?.headers.authorization).toBe('Bearer dik_new');
    expect(opened).toEqual([]);
  });

  test('login runs the PKCE browser flow against the issuer and stores the identity tokens', async () => {
    let exchange: Recorded | undefined;
    const { fetch, calls } = fakeFetch({
      'GET /v1/auth/info': () =>
        json({ account: 'acme', issuer: 'https://issuer.test', clientId: 'tenant-cli' }),
      'GET /.well-known/openid-configuration': () => json(issuer),
      'POST /oauth2/token': (call: Recorded) => {
        exchange = call;
        return json({
          access_token: 'at-1',
          token_type: 'Bearer',
          expires_in: 600,
          refresh_token: 'rt-1',
          id_token: 'id',
        });
      },
      'GET /v1/auth/whoami': () =>
        json({ user: 'alice', account: 'acme', role: 'developer', via: 'identity' }),
    });
    const pending = run(['login', '--controller', 'https://controller.test'], io(fetch, 5_000));
    await waitFor(() => opened.length === 1);
    const authorize = new URL(opened[0] as string);
    expect(authorize.origin + authorize.pathname).toBe('https://issuer.test/oauth2/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('tenant-cli');
    expect(authorize.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect(err.at(-1)).toContain('Opening your browser to sign in to acme at https://issuer.test');

    const notFound = await fetch(
      new URL('/other', authorize.searchParams.get('redirect_uri') as string).href,
    );
    expect(notFound.status).toBe(404);
    const returned = await browserReturns({ code: 'the-code' });
    expect(returned.status).toBe(200);
    expect(await returned.text()).toContain('Signed in');
    expect(await pending).toBe(0);
    expect(err.at(-1)).toBe('Logged in to acme as alice (developer) via identity.');

    // The code went to the token endpoint with the verifier that matches the challenge, no secret.
    const form = exchange?.body as Record<string, string>;
    expect(form).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'tenant-cli',
      code: 'the-code',
    });
    expect(form.client_secret).toBeUndefined();
    expect((await pkce(form.code_verifier)).challenge).toBe(
      authorize.searchParams.get('code_challenge') as string,
    );
    expect(exchange?.headers.authorization).toBeUndefined();
    expect(calls.find((call) => call.url.endsWith('/v1/auth/whoami'))?.headers.authorization).toBe(
      'Bearer at-1',
    );
    expect(readStore(env).acme).toMatchObject({
      via: 'identity',
      user: 'alice',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      issuer: 'https://issuer.test',
      clientId: 'tenant-cli',
    });
    expect(Date.parse(readStore(env).acme?.expiresAt as string)).toBeGreaterThan(
      Date.now() + 500_000,
    );
  });

  test('login refuses a bad callback, a refusal, a timeout, and an unreachable issuer', async () => {
    const { fetch } = fakeFetch({
      'GET /v1/auth/info': () =>
        json({ account: 'acme', issuer: 'https://issuer.test', clientId: 'tenant-cli' }),
      'GET /.well-known/openid-configuration': () => json(issuer),
    });
    const bad = run(
      ['login', '--controller', 'https://controller.test', '--no-browser'],
      io(fetch, 5_000),
    );
    await waitFor(() => err.some((line) => line.includes('If it does not open')));
    expect(opened).toEqual([]);
    const url = new URL((err.at(-1) as string).split('\n').at(-1)?.trim() as string);
    opened.push(url.toString());
    const wrongState = await browserReturns({ code: 'x', state: 'forged' });
    expect(wrongState.status).toBe(400);
    expect(await bad).toBe(1);
    expect(err.at(-1)).toBe('the browser returned an unexpected login response');

    const refused = run(['login', '--controller', 'https://controller.test'], io(fetch, 5_000));
    await waitFor(() => opened.length === 2);
    expect((await browserReturns({ error: 'access_denied' })).status).toBe(400);
    expect(await refused).toBe(1);
    expect(err.at(-1)).toBe('the identity server refused the login: access_denied');

    expect(await run(['login', '--controller', 'https://controller.test'], io(fetch, 50))).toBe(1);
    expect(err.at(-1)).toBe('timed out waiting for the browser login');

    const { fetch: down } = fakeFetch({
      'GET /v1/auth/info': () =>
        json({ account: 'acme', issuer: 'https://issuer.test', clientId: 'tenant-cli' }),
      'GET /.well-known/openid-configuration': () => new Response('nope', { status: 503 }),
    });
    expect(await run(['login', '--controller', 'https://controller.test'], io(down))).toBe(1);
    expect(err.at(-1)).toBe('identity: discovery at https://issuer.test answered 503');
  });

  test('an expiring identity login is refreshed before a command and failures ask for login', async () => {
    const identity: Credential = {
      ...credential,
      via: 'identity',
      apiKey: undefined,
      accessToken: 'old',
      refreshToken: 'rt-old',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      issuer: 'https://issuer.test',
      clientId: 'tenant-cli',
    };
    writeStore({ acme: identity }, env);
    let grant: Recorded | undefined;
    const { fetch, calls } = fakeFetch({
      'GET /.well-known/openid-configuration': () => json(issuer),
      'POST /oauth2/token': (call: Recorded) => {
        grant = call;
        return json({
          access_token: 'new',
          token_type: 'Bearer',
          expires_in: 600,
          refresh_token: 'rt-new',
        });
      },
      'GET /v1/auth/whoami': () =>
        json({ user: 'alice', account: 'acme', role: 'developer', via: 'identity' }),
    });
    expect(await run(['whoami'], io(fetch))).toBe(0);
    expect(grant?.body).toEqual({
      grant_type: 'refresh_token',
      client_id: 'tenant-cli',
      refresh_token: 'rt-old',
    });
    expect(calls.at(-1)?.headers.authorization).toBe('Bearer new');
    expect(readStore(env).acme).toMatchObject({ accessToken: 'new', refreshToken: 'rt-new' });
    // Fresh now: no second refresh.
    expect(await run(['whoami'], io(fetch))).toBe(0);
    expect(calls.filter((call) => call.url.endsWith('/oauth2/token'))).toHaveLength(1);

    writeStore({ acme: identity }, env);
    const { fetch: expired } = fakeFetch({
      'GET /.well-known/openid-configuration': () => json(issuer),
      'POST /oauth2/token': () => json({ error: 'invalid_grant' }, 400),
    });
    expect(await run(['whoami'], io(expired))).toBe(1);
    expect(err.at(-1)).toBe(
      'the login has expired (token endpoint refused the refresh_token grant: invalid_grant); run login again',
    );

    writeStore({ acme: { ...identity, issuer: undefined } }, env);
    expect(await run(['whoami'], io(expired))).toBe(1);
    expect(err.at(-1)).toBe('the login cannot be refreshed; run login again');

    writeStore({ acme: identity }, env);
    const broken = (async () => {
      throw new TypeError('issuer unreachable');
    }) as unknown as typeof globalThis.fetch;
    await expect(run(['whoami'], io(broken))).rejects.toThrow('issuer unreachable');

    writeStore({ acme: identity }, env);
    const { fetch: dropped } = fakeFetch({
      'GET /.well-known/openid-configuration': () => json(issuer),
      'POST /oauth2/token': () => {
        throw new TypeError('connection reset');
      },
    });
    await expect(run(['whoami'], io(dropped))).rejects.toThrow('connection reset');
  });

  test('logout tells the controller, revokes at the issuer, and forgets the account', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/auth/logout': noContent });
    expect(await run(['logout'], io(fetch))).toBe(0);
    expect(readStore(env)).toEqual({});
    expect(calls.map((call) => call.url)).toEqual(['https://controller.test/v1/auth/logout']);
    expect(await run(['whoami'], io(fetch))).toBe(1);
    expect(err.at(-1)).toContain('not logged in');

    writeStore(
      {
        acme: {
          ...credential,
          via: 'identity',
          apiKey: undefined,
          accessToken: 'expired',
          refreshToken: 'rt',
          expiresAt: '2000-01-01T00:00:00Z',
          issuer: 'https://issuer.test',
          clientId: 'tenant-cli',
        },
      },
      env,
    );
    const { fetch: issuerFetch, calls: issuerCalls } = fakeFetch({
      'GET /.well-known/openid-configuration': () => json(issuer),
      'POST /oauth2/revoke': noContent,
    });
    expect(await run(['logout'], io(issuerFetch))).toBe(0);
    // The expired token skipped the controller; the refresh token was still revoked.
    expect(issuerCalls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /.well-known/openid-configuration',
      'POST /oauth2/revoke',
    ]);
    expect(issuerCalls[1]?.body).toEqual({ token: 'rt', client_id: 'tenant-cli' });
    expect(readStore(env)).toEqual({});
  });

  test('whoami prints a line or JSON', async () => {
    const who = { user: 'alice', account: 'acme', role: 'developer', via: 'api-key' };
    const { fetch } = fakeFetch({ 'GET /v1/auth/whoami': () => json(who) });
    expect(await run(['whoami', '--account', 'acme'], io(fetch))).toBe(0);
    expect(out.at(-1)).toBe('alice (developer) in acme via api-key');
    expect(await run(['whoami', '--json'], io(fetch))).toBe(0);
    expect(JSON.parse(out.at(-1) as string)).toEqual(who);
  });

  test('deploy preview and apply send the bundle file with the env applied', async () => {
    const bundlePath = join(scratch, 'bundle.json');
    writeFileSync(
      bundlePath,
      JSON.stringify({
        env: 'staging',
        service: 'web',
        component: { reference: 'r', digest: 'd' },
        workload: {},
        bindings: [],
        secrets: [],
      }),
    );
    const { fetch, calls } = fakeFetch({
      'POST /v1/deploy/preview': (call: Recorded) =>
        json({
          env: 'prod',
          service: 'web',
          changes: (call.body as { secrets: string[] }).secrets.length
            ? []
            : [{ kind: 'create', resource: 'WorkloadDeployment', name: 'web' }],
        }),
      'POST /v1/deploy': () =>
        json({ id: 'd1', service: 'web', env: 'prod', status: 'rolling' }, 202),
    });
    expect(
      await run(['deploy', 'preview', '--env', 'prod', '--bundle', bundlePath], io(fetch)),
    ).toBe(0);
    expect(out.at(-1)).toBe('create WorkloadDeployment/web');
    expect(calls[0]?.body).toMatchObject({ env: 'prod', service: 'web' });
    writeFileSync(
      bundlePath,
      JSON.stringify({
        env: 'prod',
        service: 'web',
        component: {},
        workload: {},
        bindings: [],
        secrets: ['S'],
      }),
    );
    expect(
      await run(['deploy', 'preview', '--env', 'prod', '--bundle', bundlePath], io(fetch)),
    ).toBe(0);
    expect(out.at(-1)).toBe('web in prod: no changes');
    expect(await run(['deploy', 'apply', '--env', 'prod', '--bundle', bundlePath], io(fetch))).toBe(
      0,
    );
    expect(out.at(-1)).toBe('web in prod: d1 rolling');
  });

  test('logs prints each streamed event', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/services/web/logs': () =>
        sse(
          'event: log\ndata: {"timestamp":"t1","deployment":"d1","level":"warn","message":"slow"}\n\ndata: {"timestamp":"t2","deployment":"d1","message":"ok"}\n\nevent: end\ndata:\n\n',
        ),
    });
    expect(
      await run(
        ['logs', '--service', 'web', '--env', 'prod', '--follow', '--tail', '2', '--since', '10m'],
        io(fetch),
      ),
    ).toBe(0);
    expect(out).toEqual(['t1 d1 warn slow', 't2 d1 info ok']);
    expect(calls[0]?.url).toBe(
      'https://controller.test/v1/services/web/logs?env=prod&follow=true&since=10m&tail=2',
    );
    expect(await run(['logs', '--service', 'web', '--env', 'prod', '--json'], io(fetch))).toBe(0);
    expect(JSON.parse(out.at(-1) as string)).toMatchObject({ message: 'ok' });
  });

  test('services create carries the type-specific fields', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v1/services': (call: Recorded) =>
        json({ ...(call.body as object), createdAt: 'now' }, 201),
    });
    expect(
      await run(
        [
          'services',
          'create',
          'worker',
          '--name',
          'jobs',
          '--env',
          'prod',
          '--command',
          'bun run worker',
        ],
        io(fetch),
      ),
    ).toBe(0);
    expect(calls[0]?.body).toEqual({
      env: 'prod',
      type: 'worker',
      name: 'jobs',
      command: ['bun', 'run', 'worker'],
    });
    expect(out.at(-1)).toBe('created worker service jobs in prod');
    expect(
      await run(
        [
          'services',
          'create',
          'http',
          '--name',
          'web',
          '--env',
          'prod',
          '--port',
          '8080',
          '--route',
          '/api',
        ],
        io(fetch),
      ),
    ).toBe(0);
    expect(calls[1]?.body).toEqual({
      env: 'prod',
      type: 'http',
      name: 'web',
      port: 8080,
      route: '/api',
    });
    expect(
      await run(
        [
          'services',
          'create',
          'cron',
          '--name',
          'nightly',
          '--env',
          'prod',
          '--schedule',
          '0 2 * * *',
        ],
        io(fetch),
      ),
    ).toBe(0);
    expect(calls[2]?.body).toMatchObject({ type: 'cron', schedule: '0 2 * * *' });
  });

  test('deployments list, stats, and rollback', async () => {
    let items: unknown[] = [];
    const { fetch } = fakeFetch({
      'GET /v1/deployments': () => json({ items }),
      'GET /v1/deployments/stats': () =>
        json({ env: 'prod', services: 2, deployments: 5, ready: 4, failed: 1 }),
      'POST /v1/deployments/rollback': (call: Recorded) =>
        json({ id: (call.body as { to?: string }).to ?? 'previous', service: 'web' }, 202),
    });
    expect(await run(['deployments', 'list', '--env', 'prod'], io(fetch))).toBe(0);
    expect(out.at(-1)).toBe('no deployments in prod');
    items = [{ id: 'd1', service: 'web', status: 'ready', createdAt: 'now' }];
    expect(await run(['deployments', 'list', '--env', 'prod', '--service', 'web'], io(fetch))).toBe(
      0,
    );
    expect(out.at(-1)).toBe('d1 web ready now');
    expect(await run(['deployments', 'stats', '--env', 'prod'], io(fetch))).toBe(0);
    expect(out.at(-1)).toBe('prod: 2 services, 5 deployments, 4 ready, 1 failed');
    expect(
      await run(
        ['deployments', 'rollback', '--env', 'prod', '--service', 'web', '--to', 'd0'],
        io(fetch),
      ),
    ).toBe(0);
    expect(out.at(-1)).toBe('web in prod: rolling back to d0');
  });

  test('secrets and vars read values from a file or stdin, never the command line', async () => {
    const bodies: unknown[] = [];
    const record = (call: Recorded) => {
      bodies.push(call.body);
      return noContent();
    };
    const { fetch } = fakeFetch({
      'GET /v1/secrets': () => json({ env: 'prod', items: [{ name: 'TOKEN', updatedAt: 'now' }] }),
      'GET /v1/vars': () => json({ env: 'prod', items: [] }),
      'PUT /v1/secrets/TOKEN': record,
      'PATCH /v1/secrets/TOKEN': record,
      'DELETE /v1/secrets/TOKEN': record,
      'PUT /v1/vars/LEVEL': record,
      'PATCH /v1/vars/LEVEL': record,
      'DELETE /v1/vars/LEVEL': record,
    });
    const file = join(scratch, 'value.txt');
    writeFileSync(file, 's3cret\n');
    expect(await run(['secrets', 'list', '--env', 'prod'], io(fetch))).toBe(0);
    expect(out.at(-1)).toBe('TOKEN');
    expect(await run(['vars', 'list', '--env', 'prod'], io(fetch))).toBe(0);
    expect(out.at(-1)).toBe('no vars in prod');
    expect(
      await run(['secrets', 'set', 'TOKEN', '--env', 'prod', '--from-file', file], io(fetch)),
    ).toBe(0);
    stdin = 'from-stdin';
    expect(
      await run(['secrets', 'update', 'TOKEN', '--env', 'prod', '--from-file', '-'], io(fetch)),
    ).toBe(0);
    expect(await run(['secrets', 'unset', 'TOKEN', '--env', 'prod'], io(fetch))).toBe(0);
    expect(
      await run(['vars', 'set', 'LEVEL', '--env', 'prod', '--from-file', file], io(fetch)),
    ).toBe(0);
    expect(
      await run(['vars', 'update', 'LEVEL', '--env', 'prod', '--from-file', '-'], io(fetch)),
    ).toBe(0);
    expect(await run(['vars', 'unset', 'LEVEL', '--env', 'prod'], io(fetch))).toBe(0);
    expect(bodies).toEqual([
      { value: 's3cret' },
      { value: 'from-stdin' },
      undefined,
      { value: 's3cret' },
      { value: 'from-stdin' },
      undefined,
    ]);
    expect(err.at(-1)).toBe('unset var LEVEL in prod');
    expect(await run(['vars', 'set', '--env', 'prod'], io(fetch))).toBe(1);
    expect(err.at(-1)).toBe('usage: vars list|set|update|unset <name>');
  });

  test('vars list shows values and proxy prints the tunnel', async () => {
    const { fetch } = fakeFetch({
      'GET /v1/vars': () =>
        json({
          env: 'prod',
          items: [
            { name: 'LEVEL', value: 'info', updatedAt: 'now' },
            { name: 'EMPTY', updatedAt: 'now' },
          ],
        }),
      'POST /v1/services/web/proxy': () =>
        json({ url: 'wss://controller.test/t/1', port: 8080, expiresAt: 'later' }, 201),
    });
    expect(await run(['vars', 'list', '--env', 'prod'], io(fetch))).toBe(0);
    expect(out.at(-1)).toBe('LEVEL=info\nEMPTY=');
    expect(
      await run(['proxy', '--service', 'web', '--env', 'prod', '--port', '8080'], io(fetch)),
    ).toBe(0);
    expect(out.at(-1)).toBe('tunnel to port 8080: wss://controller.test/t/1 (until later)');
  });

  test('controller errors are reported with their status, other errors propagate', async () => {
    const { fetch } = fakeFetch({
      'GET /v1/auth/whoami': () =>
        json(
          {
            title: 'Not Implemented',
            status: 501,
            detail: 'whoami is not implemented in the pilot yet',
          },
          501,
        ),
    });
    expect(await run(['whoami'], io(fetch))).toBe(1);
    expect(err.at(-1)).toBe('controller: 501 whoami is not implemented in the pilot yet');
    const broken = (async () => {
      throw new TypeError('socket closed');
    }) as unknown as typeof globalThis.fetch;
    await expect(run(['whoami'], io(broken))).rejects.toThrow('socket closed');
  });

  test('init seeds a project without touching the controller', async () => {
    expect(await run(['init', 'orders', '--name', 'orders-api'], io())).toBe(0);
    expect(out.at(-1)).toContain('seeded');
    expect(existsSync(join(scratch, 'orders', 'src', 'app.ts'))).toBe(true);
    expect(await run(['init', 'orders'], io())).toBe(1);
    expect(await run(['init', 'orders', '--force', '--json'], io())).toBe(0);
    expect(JSON.parse(out.at(-1) as string).files).toHaveLength(3);
  });
});
