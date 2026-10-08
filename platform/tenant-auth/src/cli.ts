#!/usr/bin/env bun
/**
 * Prototype of the `di-framework platform login` surface. The CLI holds only identity-server
 * tokens (or an API key) in a JSON file and points kubectl at the tenant controller, which proxies
 * to Kubernetes with the user's own permissions. Existing kubectl-based commands keep working.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';

export interface Credential {
  console: string;
  account: string;
  user: string;
  role: string;
  via: 'identity' | 'api-key';
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  /** Access token expiry; absent for API keys. */
  expiresAt?: string;
  controller: { url: string; certificateAuthorityData?: string };
}
export type CredentialStore = Record<string, Credential>;

export const home = () => process.env.DI_FRAMEWORK_HOME ?? join(homedir(), '.di-framework');
const credentialsPath = () => join(home(), 'credentials.json');
export const kubeconfigPath = (account: string) => join(home(), 'kubeconfigs', `${account}.yaml`);
const DEFAULT_CONSOLE = process.env.TENANT_CONSOLE_URL ?? 'http://127.0.0.1:8787';

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
}
export function readStore(): CredentialStore {
  const path = credentialsPath();
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as CredentialStore) : {};
}
export function writeStore(store: CredentialStore): void {
  ensureDir(home());
  const path = credentialsPath();
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The token the controller accepts: the identity access token, or the API key itself. */
export const bearer = (credential: Credential) => credential.apiKey ?? credential.accessToken ?? '';

/** kubeconfig pointing kubectl at the tenant controller with the current bearer token. */
export function renderKubeconfig(credential: Credential): string {
  const name = `${credential.user}@${credential.account}`;
  return dump({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      {
        name: credential.account,
        cluster: {
          server: credential.controller.url,
          ...(credential.controller.certificateAuthorityData
            ? { 'certificate-authority-data': credential.controller.certificateAuthorityData }
            : {}),
        },
      },
    ],
    users: [{ name, user: { token: bearer(credential) } }],
    contexts: [
      {
        name,
        context: {
          cluster: credential.account,
          user: name,
          namespace: `di-tenant-${credential.account}`,
        },
      },
    ],
    'current-context': name,
  });
}
function writeKubeconfig(credential: Credential): string {
  const path = kubeconfigPath(credential.account);
  ensureDir(join(home(), 'kubeconfigs'));
  writeFileSync(path, renderKubeconfig(credential), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Parse `--flag value` pairs, a leading command, and positionals; `--` ends flag parsing. */
export function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string>;
  rest: string[];
} {
  const [command = 'help', ...tail] = argv;
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i] as string;
    if (arg === '--') {
      rest.push(...tail.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const value = tail[i + 1];
      if (value === undefined || value.startsWith('--')) flags[arg.slice(2)] = 'true';
      else {
        flags[arg.slice(2)] = value;
        i++;
      }
    } else rest.push(arg);
  }
  return { command, flags, rest };
}

class CliError extends Error {}

async function http<T>(
  base: string,
  path: string,
  init: RequestInit & { ca?: string } = {},
): Promise<T> {
  const { ca, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    tls: ca ? { ca } : undefined,
  } as RequestInit);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!response.ok) {
    let reason = `${path} returned ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      reason = parsed.error ?? parsed.message ?? reason;
    } catch {}
    throw new CliError(reason);
  }
  return JSON.parse(text) as T;
}
const jsonInit = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Call the tenant controller as this credential. */
async function controller<T>(
  credential: Credential,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const ca = credential.controller.certificateAuthorityData
    ? Buffer.from(credential.controller.certificateAuthorityData, 'base64').toString()
    : undefined;
  return http<T>(credential.controller.url, path, {
    ...init,
    ca,
    headers: {
      ...(init.headers as Record<string, string>),
      Authorization: `Bearer ${bearer(credential)}`,
    },
  });
}

interface Exchange {
  account: string;
  user: string;
  role: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  controller: Credential['controller'];
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' });
  } catch {}
}

/** Loopback listener, open the console's login URL, wait for the one-time code, exchange it. */
async function browserLogin(consoleUrl: string, open: boolean): Promise<Exchange> {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/callback') return new Response('not found', { status: 404 });
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.get('state') !== state) {
        reject(new CliError('the browser returned an unexpected login response'));
        return new Response('Login failed. Return to the terminal.', { status: 400 });
      }
      resolve(code);
      return new Response(
        '<!doctype html><title>Signed in</title><p style="font:16px system-ui;padding:24px">Signed in. You can close this window and return to the terminal.</p>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    },
  });
  try {
    const url = new URL(`${consoleUrl}/login`);
    url.searchParams.set('cli_callback', `http://127.0.0.1:${server.port}/callback`);
    url.searchParams.set('cli_state', state);
    console.error(`Opening your browser to sign in.\nIf it does not open, visit:\n  ${url}`);
    if (open) openBrowser(url.toString());
    const timeout = setTimeout(
      () => reject(new CliError('timed out waiting for the browser login')),
      300_000,
    );
    const code = await promise.finally(() => clearTimeout(timeout));
    return await http<Exchange>(consoleUrl, '/cli/exchange', jsonInit({ code }));
  } finally {
    server.stop(true);
  }
}

function load(account: string): Credential {
  const credential = readStore()[account];
  if (!credential)
    throw new CliError(`not logged in to ${account}; run: login --account ${account}`);
  return credential;
}
function save(credential: Credential): void {
  const store = readStore();
  store[credential.account] = credential;
  writeStore(store);
}

/** Make sure the credential's access token is good for at least a minute. */
async function fresh(credential: Credential): Promise<Credential> {
  if (credential.via === 'api-key') return credential;
  if (credential.expiresAt && Date.parse(credential.expiresAt) - Date.now() > 60_000)
    return credential;
  if (!credential.refreshToken) throw new CliError('the login has expired; run login again');
  const next = await http<{ accessToken: string; refreshToken?: string; expiresAt: string }>(
    credential.console,
    '/cli/refresh',
    jsonInit({ refreshToken: credential.refreshToken }),
  );
  const updated = { ...credential, ...next };
  save(updated);
  return updated;
}

export async function main(argv: string[]): Promise<number> {
  const { command, flags, rest } = parseArgs(argv);
  const account = flags.account ?? '';
  const needAccount = () => {
    if (!account) throw new CliError('--account <tenant> is required');
    return account;
  };
  switch (command) {
    case 'login': {
      const consoleUrl = (flags.console ?? DEFAULT_CONSOLE).replace(/\/$/, '');
      const info = await http<{ account: string; controller: Credential['controller'] }>(
        consoleUrl,
        '/cli/info',
        { method: 'GET' },
      );
      if (account && info.account !== account)
        throw new CliError(`${consoleUrl} serves account ${info.account}, not ${account}`);
      let credential: Credential;
      if (flags['api-key']) {
        const probe: Credential = {
          console: consoleUrl,
          account: info.account,
          user: '',
          role: '',
          via: 'api-key',
          apiKey: flags['api-key'],
          controller: info.controller,
        };
        const who = await controller<{ user: string; role: string }>(probe, '/-/whoami');
        credential = { ...probe, user: who.user, role: who.role };
      } else {
        const result = await browserLogin(consoleUrl, flags['no-browser'] !== 'true');
        credential = {
          console: consoleUrl,
          account: result.account,
          user: result.user,
          role: result.role,
          via: 'identity',
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
          controller: result.controller,
        };
      }
      save(credential);
      const path = writeKubeconfig(credential);
      console.error(
        `Logged in to ${credential.account} as ${credential.user} (${credential.role}) via ${credential.via}.`,
      );
      console.log(`export KUBECONFIG=${path}`);
      return 0;
    }
    case 'kubeconfig': {
      const credential = await fresh(load(needAccount()));
      console.log(writeKubeconfig(credential));
      return 0;
    }
    case 'exec': {
      // Refresh, rewrite the kubeconfig, and run the command with KUBECONFIG set.
      const credential = await fresh(load(needAccount()));
      const path = writeKubeconfig(credential);
      if (rest.length === 0)
        throw new CliError('usage: exec --account <tenant> -- <command> [args]');
      const child = Bun.spawn(rest, {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: { ...process.env, KUBECONFIG: path },
      });
      return await child.exited;
    }
    case 'whoami': {
      const credential = await fresh(load(needAccount()));
      const who = await controller<Record<string, unknown>>(credential, '/-/whoami');
      console.log(
        JSON.stringify(
          {
            ...who,
            console: credential.console,
            controller: credential.controller.url,
            tokenExpiresAt: credential.expiresAt,
            kubeconfig: kubeconfigPath(credential.account),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    case 'logout': {
      const credential = load(needAccount());
      if (credential.refreshToken)
        await http(
          credential.console,
          '/cli/logout',
          jsonInit({ refreshToken: credential.refreshToken }),
        ).catch(() => undefined);
      const store = readStore();
      delete store[credential.account];
      writeStore(store);
      const path = kubeconfigPath(credential.account);
      if (existsSync(path)) unlinkSync(path);
      console.error(`Logged out of ${credential.account}.`);
      return 0;
    }
    case 'keys': {
      const credential = await fresh(load(needAccount()));
      const [action = 'list', id] = rest;
      if (action === 'list') {
        const { keys } = await controller<{ keys: unknown[] }>(credential, '/-/keys');
        console.log(JSON.stringify(keys, null, 2));
      } else if (action === 'create') {
        const days = Number(flags.days ?? 7);
        const issued = await controller<{ id: string; secret: string; expiresAt: string }>(
          credential,
          '/-/keys',
          jsonInit({ name: flags.name ?? 'cli', ttlSeconds: Math.round(days * 86_400) }),
        );
        console.error(
          `Created key ${issued.id}, expires ${issued.expiresAt}. Copy it now; it is not shown again.`,
        );
        console.log(issued.secret);
      } else if (action === 'revoke' && id) {
        await controller(credential, `/-/keys/${id}`, { method: 'DELETE' });
        console.error(`Revoked key ${id}.`);
      } else
        throw new CliError(
          'usage: keys list | keys create --name <n> --days <d> | keys revoke <id>',
        );
      return 0;
    }
    default:
      console.error(`usage:
  login [--account <tenant>] [--console <url>] [--api-key <key>] [--no-browser]
  kubeconfig --account <tenant>                  # refresh and print the kubeconfig path
  exec --account <tenant> -- kubectl get pods    # run a command with KUBECONFIG set
  whoami --account <tenant>
  logout --account <tenant>
  keys list|create|revoke --account <tenant> [--name <n>] [--days <d>]`);
      return command === 'help' ? 0 : 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof CliError ? error.message : String(error));
      process.exit(1);
    },
  );
}
