import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Credential,
  exitWithError,
  kubeconfigPath,
  main,
  openBrowser,
  readStore,
  writeStore,
} from '../src/cli.ts';
import { type FakeServer, json, serve } from './support/servers.ts';

describe('openBrowser', () => {
  const platform = process.platform;
  const withPlatform = (value: string, fn: () => void) => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }
  };
  test('picks the opener for the platform and swallows spawn failures', () => {
    const commands: string[][] = [];
    const spawn = ((command: string[]) => {
      commands.push(command);
      return {} as never;
    }) as unknown as typeof Bun.spawn;
    withPlatform('darwin', () => openBrowser('http://x', spawn));
    withPlatform('win32', () => openBrowser('http://x', spawn));
    withPlatform('linux', () => openBrowser('http://x', spawn));
    expect(commands).toEqual([
      ['open', 'http://x'],
      ['cmd', '/c', 'start', '', 'http://x'],
      ['xdg-open', 'http://x'],
    ]);
    expect(() =>
      openBrowser('http://x', (() => {
        throw new Error('no browser');
      }) as unknown as typeof Bun.spawn),
    ).not.toThrow();
  });
});

describe('main', () => {
  let consoleServer: FakeServer;
  let controllerServer: FakeServer;
  let dir: string;
  const state = { logoutStatus: 204, exchangeStatus: 200 };
  const errors: string[] = [];
  const outputs: string[] = [];
  let stderr: ReturnType<typeof spyOn>;
  let stdout: ReturnType<typeof spyOn>;

  beforeAll(() => {
    controllerServer = serve((request) => {
      const token = request.headers.get('authorization')?.slice(7);
      if (token === 'dik_bad') return new Response('not json', { status: 401 });
      if (token !== 'access' && token !== 'access-2' && token !== 'dik_ok')
        return json({ message: 'the access token is invalid or has expired' }, 401);
      if (request.pathname === '/-/whoami')
        return json({
          user: 'alice',
          account: 'acme',
          role: 'developer',
          via: token === 'dik_ok' ? 'api-key' : 'identity',
        });
      if (request.pathname === '/-/keys' && request.method === 'GET')
        return json({ keys: [{ id: 'k1' }] });
      if (request.pathname === '/-/keys' && request.method === 'POST')
        return json(
          {
            id: 'k2',
            secret: 'dik_new',
            expiresAt: '2030-01-01T00:00:00Z',
            ...JSON.parse(request.body),
          },
          201,
        );
      if (request.pathname === '/-/keys/k2' && request.method === 'DELETE')
        return new Response(null, { status: 204 });
      return json({ message: `${request.pathname} is not a controller endpoint` }, 404);
    });
    consoleServer = serve((request) => {
      if (request.pathname === '/cli/info')
        return json({ account: 'acme', controller: { url: controllerServer.url } });
      if (request.pathname === '/cli/exchange') {
        if (state.exchangeStatus !== 200) return json({ error: 'bad code' }, state.exchangeStatus);
        return json({
          account: 'acme',
          user: 'alice',
          role: 'developer',
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: '2030-01-01T00:00:00Z',
          controller: { url: controllerServer.url },
        });
      }
      if (request.pathname === '/cli/refresh')
        return json({
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: '2031-01-01T00:00:00Z',
        });
      if (request.pathname === '/cli/logout')
        return new Response(null, { status: state.logoutStatus });
      return json({ error: 'nope' }, 404);
    });
  });
  afterAll(() => {
    consoleServer.stop();
    controllerServer.stop();
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tenant-cli-'));
    process.env.DI_FRAMEWORK_HOME = dir;
    stderr = spyOn(console, 'error').mockImplementation((line: string) => {
      errors.push(String(line));
    });
    stdout = spyOn(console, 'log').mockImplementation((line: string) => {
      outputs.push(String(line));
    });
  });
  afterEach(() => {
    stderr.mockRestore();
    stdout.mockRestore();
    errors.length = 0;
    outputs.length = 0;
    delete process.env.DI_FRAMEWORK_HOME;
    delete process.env.TENANT_AUTH_LOGIN_TIMEOUT_MS;
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (...argv: string[]) => main(argv);
  const seed = (overrides: Partial<Credential> = {}) => {
    const credential: Credential = {
      console: consoleServer.url,
      account: 'acme',
      user: 'alice',
      role: 'developer',
      via: 'identity',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: '2030-01-01T00:00:00Z',
      controller: { url: controllerServer.url },
      ...overrides,
    };
    writeStore({ acme: credential });
    return credential;
  };
  /** The login URL `login` printed after the given stderr line count. */
  const printedLoginUrl = async (since: number) => {
    for (let i = 0; i < 100 && !errors.slice(since).some((e) => e.includes('cli_callback')); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const printed = errors.slice(since).find((e) => e.includes('cli_callback')) ?? '';
    return new URL(printed.slice(printed.indexOf('http')).trim());
  };
  const callbackFor = (loginUrl: URL, mutate?: (url: URL) => void) => {
    const callback = new URL(loginUrl.searchParams.get('cli_callback') ?? '');
    callback.searchParams.set('code', 'one-time');
    callback.searchParams.set('state', loginUrl.searchParams.get('cli_state') ?? '');
    mutate?.(callback);
    return callback;
  };
  /** Complete the loopback login that `login` is waiting for, from the URL it printed. */
  const completeLogin = async (pending: Promise<number>, mutate?: (url: URL) => void) => {
    const browser = await fetch(callbackFor(await printedLoginUrl(0), mutate));
    return { code: await pending, browser };
  };

  test('logs in through the browser, writes the store and kubeconfig', async () => {
    const pending = run('login', '--console', `${consoleServer.url}/`, '--no-browser');
    const { code, browser } = await completeLogin(pending);
    expect(code).toBe(0);
    expect(browser.status).toBe(200);
    expect(readStore().acme).toMatchObject({
      user: 'alice',
      via: 'identity',
      accessToken: 'access',
    });
    expect(existsSync(kubeconfigPath('acme'))).toBe(true);
    expect(outputs[0]).toBe(`export KUBECONFIG=${kubeconfigPath('acme')}`);
  });
  test('opens the browser unless told not to', async () => {
    const spawn = spyOn(Bun, 'spawn').mockImplementation((() => ({})) as never);
    try {
      const { code } = await completeLogin(run('login', '--console', consoleServer.url));
      expect(code).toBe(0);
      expect(spawn).toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });
  test('rejects a callback with the wrong state', async () => {
    const outcome = run('login', '--console', consoleServer.url, '--no-browser').then(
      () => 'resolved',
      (error: unknown) => error,
    );
    // The CLI force-closes its listener as soon as it rejects, so the browser's answer may never arrive.
    fetch(
      callbackFor(await printedLoginUrl(0), (url) => url.searchParams.set('state', 'forged')),
    ).catch(() => undefined);
    expect(String(await outcome)).toContain('the browser returned an unexpected login response');
  });
  test('answers 404 on other loopback paths and keeps waiting', async () => {
    const pending = run('login', '--console', consoleServer.url, '--no-browser');
    const loginUrl = await printedLoginUrl(0);
    const elsewhere = await fetch(
      callbackFor(loginUrl, (url) => {
        url.pathname = '/elsewhere';
      }),
    );
    expect(elsewhere.status).toBe(404);
    expect((await fetch(callbackFor(loginUrl))).status).toBe(200);
    expect(await pending).toBe(0);
  });
  test('times out waiting for the browser', async () => {
    process.env.TENANT_AUTH_LOGIN_TIMEOUT_MS = '20';
    await expect(run('login', '--console', consoleServer.url, '--no-browser')).rejects.toThrow(
      'timed out',
    );
  });
  test('surfaces an exchange failure', async () => {
    state.exchangeStatus = 400;
    try {
      await expect(
        completeLogin(run('login', '--console', consoleServer.url, '--no-browser')).then(
          (r) => r.code,
        ),
      ).rejects.toThrow('bad code');
    } finally {
      state.exchangeStatus = 200;
    }
  });
  test('checks the account the console serves', async () => {
    await expect(
      run('login', '--console', consoleServer.url, '--account', 'other'),
    ).rejects.toThrow('serves account acme, not other');
  });
  test('logs in with an API key', async () => {
    expect(await run('login', '--console', consoleServer.url, '--api-key', 'dik_ok')).toBe(0);
    expect(readStore().acme).toMatchObject({ via: 'api-key', apiKey: 'dik_ok', user: 'alice' });
    await expect(
      run('login', '--console', consoleServer.url, '--api-key', 'dik_bad'),
    ).rejects.toThrow('/-/whoami returned 401');
    await expect(
      run('login', '--console', consoleServer.url, '--api-key', 'dik_nope'),
    ).rejects.toThrow('invalid or has expired');
  });
  test('requires an account and a login for the other commands', async () => {
    await expect(run('whoami')).rejects.toThrow('--account <tenant> is required');
    await expect(run('whoami', '--account', 'acme')).rejects.toThrow('not logged in to acme');
  });
  test('whoami and kubeconfig refresh an expiring token first', async () => {
    seed({ expiresAt: new Date(Date.now() + 1000).toISOString() });
    expect(await run('whoami', '--account', 'acme')).toBe(0);
    expect(JSON.parse(outputs[0] ?? '')).toMatchObject({
      user: 'alice',
      tokenExpiresAt: '2031-01-01T00:00:00Z',
    });
    expect(readStore().acme?.accessToken).toBe('access-2');
    expect(await run('kubeconfig', '--account', 'acme')).toBe(0);
    expect(outputs[1]).toBe(kubeconfigPath('acme'));
    seed({ expiresAt: new Date().toISOString(), refreshToken: undefined });
    await expect(run('whoami', '--account', 'acme')).rejects.toThrow('login has expired');
    seed({ via: 'api-key', apiKey: 'dik_ok', accessToken: undefined, expiresAt: undefined });
    expect(await run('whoami', '--account', 'acme')).toBe(0);
  });
  test('exec runs a command with the kubeconfig', async () => {
    seed();
    await expect(run('exec', '--account', 'acme')).rejects.toThrow('usage: exec');
    expect(
      await run('exec', '--account', 'acme', '--', 'sh', '-c', 'test -n "$KUBECONFIG" && exit 3'),
    ).toBe(3);
  });
  test('manages keys', async () => {
    seed();
    expect(await run('keys', '--account', 'acme')).toBe(0);
    expect(JSON.parse(outputs[0] ?? '')).toEqual([{ id: 'k1' }]);
    expect(await run('keys', 'create', '--account', 'acme', '--name', 'ci', '--days', '2')).toBe(0);
    expect(outputs[1]).toBe('dik_new');
    expect(JSON.parse(controllerServer.requests.at(-1)?.body ?? '')).toEqual({
      name: 'ci',
      ttlSeconds: 172_800,
    });
    expect(await run('keys', 'revoke', 'k2', '--account', 'acme')).toBe(0);
    await expect(run('keys', 'frobnicate', '--account', 'acme')).rejects.toThrow('usage: keys');
    await expect(run('keys', 'revoke', 'k9', '--account', 'acme')).rejects.toThrow(
      'not a controller endpoint',
    );
  });
  test('logout revokes at the console and forgets the account', async () => {
    seed();
    await run('kubeconfig', '--account', 'acme');
    expect(await run('logout', '--account', 'acme')).toBe(0);
    expect(readStore()).toEqual({});
    expect(existsSync(kubeconfigPath('acme'))).toBe(false);
    expect(consoleServer.requests.at(-1)?.path).toBe('/cli/logout');
    seed({ refreshToken: undefined });
    const before = consoleServer.requests.length;
    expect(await run('logout', '--account', 'acme')).toBe(0);
    expect(consoleServer.requests.length).toBe(before);
    state.logoutStatus = 500;
    seed();
    expect(await run('logout', '--account', 'acme')).toBe(0);
    state.logoutStatus = 204;
  });
  test('reports an escaped error and exits 1', async () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      exitWithError(new Error('plain'));
      await run('whoami').catch(exitWithError);
      expect(errors).toEqual(['Error: plain', '--account <tenant> is required']);
      expect(exit.mock.calls).toEqual([[1], [1]]);
    } finally {
      exit.mockRestore();
    }
  });
  test('prints usage', async () => {
    expect(await run()).toBe(0);
    expect(await run('bogus')).toBe(2);
    expect(errors[0]).toContain('usage:');
  });
});
