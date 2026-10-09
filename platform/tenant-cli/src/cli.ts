import { readFileSync } from 'node:fs';
import {
  type ControllerError,
  type CreateServiceRequest,
  createClient,
  type DeployBundle,
  type Env,
  type TenantClient,
} from './client/index.ts';
import {
  bearer,
  CliError,
  type Credential,
  load,
  needsRefresh,
  readStore,
  resolveAccount,
  writeStore,
} from './credentials.ts';
import { init } from './init.ts';
import {
  authorizationUrl,
  discover,
  exchangeCode,
  OidcError,
  pkce,
  randomToken,
  refreshTokens,
  revokeToken,
  type TokenResponse,
} from './oidc.ts';

export interface Io {
  stdout(line: string): void;
  stderr(line: string): void;
  /** Standard input, read whole; used by `--from-file -`. */
  stdin(): string;
  /** Opens a URL in the user's browser; `main.ts` spawns the platform opener. */
  open(url: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetch?: typeof fetch;
  /** How long `login` waits for the browser to come back; five minutes by default. */
  loginTimeoutMs?: number;
}

const SCOPE = 'openid profile email offline_access';

export interface Parsed {
  command: string;
  flags: Record<string, string>;
  positionals: string[];
}

const BOOLEAN_FLAGS = new Set(['json', 'follow', 'force', 'no-browser']);

/** `--flag value`, `--flag=value`, boolean flags, and positionals; `--` ends flag parsing. */
export function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (equals !== -1) flags[name] = arg.slice(equals + 1);
    else if (BOOLEAN_FLAGS.has(name)) flags[name] = 'true';
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new CliError(`--${name} needs a value`);
      flags[name] = value;
      i++;
    }
  }
  const [command = 'help', ...rest] = positionals;
  return { command, flags, positionals: rest };
}

export const USAGE = `di-tenant: the tenant CLI pilot. It talks to the tenant controller only.

  login --controller <url> [--account <tenant>] [--api-key <key>] [--no-browser]
  logout [--account <tenant>]
  whoami [--account <tenant>]
  deploy preview|apply --env <prod|staging> --bundle <file>
  logs --service <name> --env <env> [--deployment <id>] [--follow] [--since <dur>] [--tail <n>]
  services create <keyvalue|messaging|blobstore|postgres|egress> --name <name> --env <env> [--class <class>] [--storage <q>] [--memory <q>] [--cpu <q>] [--deletion-policy <Retain|Delete>] [--destination <host[:port],...>]
  deployments list|stats --env <env> [--service <name>]
  deployments rollback --service <name> --env <env> [--to <id>]
  secrets|vars list --env <env>
  secrets|vars set|update <name> --env <env> --from-file <path|->
  secrets|vars unset <name> --env <env>
  proxy --service <name> --env <env> [--port <n>]
  init [name] [--dir <path>] [--name <name>] [--force]

Shared flags: --env, --json, --account. The credential comes from the login on disk; there is no token argument.`;

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new CliError(`--${name} is required`);
  return value;
}

function requireEnv(flags: Record<string, string>): Env {
  const value = requireFlag(flags, 'env');
  if (value !== 'prod' && value !== 'staging') throw new CliError('--env must be prod or staging');
  return value;
}

const BACKING_TYPES: readonly string[] = [
  'keyvalue',
  'messaging',
  'blobstore',
  'postgres',
  'egress',
];

function integer(flags: Record<string, string>, name: string): number | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new CliError(`--${name} must be a whole number`);
  return parsed;
}

/** `--from-file <path>` or `-` for stdin: values never appear on the command line. */
function valueFrom(flags: Record<string, string>, io: Io): string {
  const source = requireFlag(flags, 'from-file');
  const raw = source === '-' ? io.stdin() : readFileSync(source, 'utf8');
  return raw.replace(/\r?\n$/, '');
}

function print(io: Io, flags: Record<string, string>, value: unknown, line: (v: never) => string) {
  io.stdout(flags.json === 'true' ? JSON.stringify(value, null, 2) : line(value as never));
}

/**
 * Resolves the credential on disk for the account, refreshing an identity token that is about to
 * expire, and builds a client with its bearer.
 */
async function session(
  flags: Record<string, string>,
  io: Io,
): Promise<{ credential: Credential; client: TenantClient }> {
  const store = readStore(io.env);
  const account = resolveAccount(flags.account, io.env, store);
  let credential = load(account, io.env);
  if (needsRefresh(credential)) {
    credential = await refresh(credential, io);
    store[account] = credential;
    writeStore(store, io.env);
  }
  const client = createClient({
    baseUrl: credential.controller.url,
    token: bearer(credential),
    fetch: io.fetch,
  });
  return { credential, client };
}

/** The refresh grant at the issuer, with the public client id; identity rotates the token. */
async function refresh(credential: Credential, io: Io): Promise<Credential> {
  if (!credential.issuer || !credential.clientId || !credential.refreshToken) {
    throw new CliError('the login cannot be refreshed; run login again');
  }
  const metadata = await discover(credential.issuer, io.fetch);
  let tokens: TokenResponse;
  try {
    tokens = await refreshTokens(
      metadata,
      { clientId: credential.clientId, refreshToken: credential.refreshToken },
      io.fetch,
    );
  } catch (error) {
    if (error instanceof OidcError) {
      throw new CliError(`the login has expired (${error.message}); run login again`);
    }
    throw error;
  }
  return { ...credential, ...issued(tokens, credential.refreshToken) };
}

function issued(tokens: TokenResponse, previousRefresh?: string) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previousRefresh,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
}

const page = (text: string, status = 200) =>
  new Response(
    `<!doctype html><title>di-tenant</title><p style="font:16px system-ui;padding:24px">${text}</p>`,
    { status, headers: { 'content-type': 'text/html' } },
  );

/**
 * RFC 8252 browser login: a loopback listener on a free port is the redirect URI, the browser
 * signs in at the issuer, and the code comes back with the PKCE verifier, no client secret.
 */
async function browserLogin(
  info: { account: string; issuer: string; clientId: string },
  flags: Record<string, string>,
  io: Io,
): Promise<TokenResponse> {
  const metadata = await discover(info.issuer, io.fetch);
  const { verifier, challenge } = await pkce();
  const state = randomToken(16);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/callback') return page('Not found.', 404);
      const refused = url.searchParams.get('error');
      if (refused) {
        reject(new CliError(`the identity server refused the login: ${refused}`));
        return page('Login failed. Return to the terminal.', 400);
      }
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.get('state') !== state) {
        reject(new CliError('the browser returned an unexpected login response'));
        return page('Login failed. Return to the terminal.', 400);
      }
      resolve(code);
      return page('Signed in. You can close this window and return to the terminal.');
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  try {
    const url = authorizationUrl(metadata, {
      clientId: info.clientId,
      redirectUri,
      scope: SCOPE,
      state,
      nonce: randomToken(16),
      codeChallenge: challenge,
    });
    io.stderr(
      `Opening your browser to sign in to ${info.account} at ${info.issuer}.\nIf it does not open, visit:\n  ${url}`,
    );
    if (flags['no-browser'] !== 'true') io.open(url);
    const timer = setTimeout(
      () => reject(new CliError('timed out waiting for the browser login')),
      io.loginTimeoutMs ?? 300_000,
    );
    const code = await promise.finally(() => clearTimeout(timer));
    return await exchangeCode(
      metadata,
      { clientId: info.clientId, redirectUri, code, codeVerifier: verifier },
      io.fetch,
    );
  } finally {
    await server.stop();
  }
}

async function login(flags: Record<string, string>, io: Io): Promise<number> {
  const controller = requireFlag(flags, 'controller').replace(/\/$/, '');
  const info = await createClient({ baseUrl: controller, fetch: io.fetch }).authInfo();
  if (flags.account && info.account !== flags.account) {
    throw new CliError(`${controller} serves account ${info.account}, not ${flags.account}`);
  }
  const apiKey = flags['api-key'];
  const tokens = apiKey ? undefined : await browserLogin(info, flags, io);
  const token = apiKey ?? (tokens as TokenResponse).access_token;
  const who = await createClient({ baseUrl: controller, token, fetch: io.fetch }).whoami();
  const base = {
    account: info.account,
    user: who.user,
    role: who.role,
    controller: { url: controller },
  };
  const credential: Credential = apiKey
    ? { ...base, via: 'api-key', apiKey }
    : {
        ...base,
        via: 'identity',
        issuer: info.issuer,
        clientId: info.clientId,
        ...issued(tokens as TokenResponse),
      };
  const store = readStore(io.env);
  store[info.account] = credential;
  writeStore(store, io.env);
  io.stderr(`Logged in to ${info.account} as ${who.user} (${who.role}) via ${credential.via}.`);
  return 0;
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(parseArgs(argv), io);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(error.message);
      return error.exitCode;
    }
    if (error instanceof OidcError) {
      io.stderr(`identity: ${error.message}`);
      return 1;
    }
    if ((error as ControllerError).name === 'ControllerError') {
      const failure = error as ControllerError;
      io.stderr(`controller: ${failure.status} ${failure.message}`);
      return 1;
    }
    throw error;
  }
}

async function dispatch(parsed: Parsed, io: Io): Promise<number> {
  const { command, flags, positionals } = parsed;
  const [sub, ...rest] = positionals;
  switch (command) {
    case 'help':
      io.stdout(USAGE);
      return 0;
    case 'login':
      return login(flags, io);
    case 'logout': {
      // Tell the controller first, while the token is still valid, then revoke the refresh token
      // at the issuer, then forget the credential. A failure anywhere still forgets it.
      const store = readStore(io.env);
      const account = resolveAccount(flags.account, io.env, store);
      const credential = load(account, io.env);
      try {
        await createClient({
          baseUrl: credential.controller.url,
          token: bearer(credential),
          fetch: io.fetch,
        }).logout();
      } catch {
        // An expired or already revoked token; nothing to tell the controller.
      }
      if (credential.via === 'identity' && credential.refreshToken && credential.issuer) {
        await revokeToken(
          await discover(credential.issuer, io.fetch),
          credential.clientId ?? '',
          credential.refreshToken,
          io.fetch,
        );
      }
      delete store[account];
      writeStore(store, io.env);
      io.stderr(`Logged out of ${account}.`);
      return 0;
    }
    case 'whoami': {
      const { client } = await session(flags, io);
      const who = await client.whoami();
      print(io, flags, who, () => `${who.user} (${who.role}) in ${who.account} via ${who.via}`);
      return 0;
    }
    case 'deploy': {
      if (sub !== 'preview' && sub !== 'apply') throw new CliError('usage: deploy preview|apply');
      const env = requireEnv(flags);
      const bundle = JSON.parse(readFileSync(requireFlag(flags, 'bundle'), 'utf8')) as DeployBundle;
      bundle.env = env;
      const { client } = await session(flags, io);
      if (sub === 'preview') {
        const plan = await client.previewDeploy(bundle);
        print(io, flags, plan, () =>
          plan.changes.length === 0
            ? `${plan.service} in ${plan.env}: no changes`
            : plan.changes.map((c) => `${c.kind} ${c.resource}/${c.name}`).join('\n'),
        );
        return 0;
      }
      const deployment = await client.deploy(bundle);
      print(
        io,
        flags,
        deployment,
        () => `${deployment.service} in ${deployment.env}: ${deployment.id} ${deployment.status}`,
      );
      return 0;
    }
    case 'logs': {
      const { client } = await session(flags, io);
      const stream = client.logs(requireFlag(flags, 'service'), {
        env: requireEnv(flags),
        deployment: flags.deployment,
        follow: flags.follow === 'true',
        since: flags.since,
        tail: integer(flags, 'tail'),
      });
      for await (const event of stream) {
        print(
          io,
          flags,
          event,
          () => `${event.timestamp} ${event.deployment} ${event.level ?? 'info'} ${event.message}`,
        );
      }
      return 0;
    }
    case 'services': {
      if (sub !== 'create')
        throw new CliError(
          'usage: services create <keyvalue|messaging|blobstore|postgres|egress> --name <name>',
        );
      const type = rest[0] as CreateServiceRequest['type'];
      if (!BACKING_TYPES.includes(type)) {
        throw new CliError(
          'service type must be keyvalue, messaging, blobstore, postgres, or egress (http, cron and worker services come from deploy)',
        );
      }
      const policy = flags['deletion-policy'];
      if (policy !== undefined && policy !== 'Retain' && policy !== 'Delete')
        throw new CliError('--deletion-policy must be Retain or Delete');
      const sizing = { storage: flags.storage, memory: flags.memory, cpu: flags.cpu };
      const request: CreateServiceRequest = {
        env: requireEnv(flags),
        type,
        name: requireFlag(flags, 'name'),
        className: flags.class,
        parameters: Object.values(sizing).some((v) => v !== undefined) ? sizing : undefined,
        deletionPolicy: policy,
        destinations: flags.destination?.split(',').filter((d) => d !== ''),
      };
      const { client } = await session(flags, io);
      const service = await client.createService(request);
      print(
        io,
        flags,
        service,
        () =>
          `created ${service.type} service ${service.name} (${service.className}) in ${service.env}`,
      );
      return 0;
    }
    case 'deployments': {
      const env = requireEnv(flags);
      const { client } = await session(flags, io);
      if (sub === 'list') {
        const list = await client.deployments({ env, service: flags.service });
        print(io, flags, list, () =>
          list.items.length === 0
            ? `no deployments in ${env}`
            : list.items.map((d) => `${d.id} ${d.service} ${d.status} ${d.createdAt}`).join('\n'),
        );
        return 0;
      }
      if (sub === 'stats') {
        const stats = await client.deploymentStats(env);
        print(
          io,
          flags,
          stats,
          () =>
            `${env}: ${stats.services} services, ${stats.deployments} deployments, ${stats.ready} ready, ${stats.failed} failed`,
        );
        return 0;
      }
      if (sub === 'rollback') {
        const deployment = await client.rollback({
          env,
          service: requireFlag(flags, 'service'),
          to: flags.to,
        });
        print(
          io,
          flags,
          deployment,
          () => `${deployment.service} in ${env}: rolling back to ${deployment.id}`,
        );
        return 0;
      }
      throw new CliError('usage: deployments list|stats|rollback');
    }
    case 'secrets':
    case 'vars': {
      const env = requireEnv(flags);
      const { client } = await session(flags, io);
      const secret = command === 'secrets';
      if (sub === 'list') {
        const list: { items: { name: string; value?: string }[] } = secret
          ? await client.secrets(env)
          : await client.vars(env);
        print(io, flags, list, () =>
          list.items.length === 0
            ? `no ${command} in ${env}`
            : list.items.map((e) => (secret ? e.name : `${e.name}=${e.value ?? ''}`)).join('\n'),
        );
        return 0;
      }
      const name = rest[0];
      if (!name || (sub !== 'set' && sub !== 'update' && sub !== 'unset')) {
        throw new CliError(`usage: ${command} list|set|update|unset <name>`);
      }
      if (sub === 'unset')
        await (secret ? client.unsetSecret(env, name) : client.unsetVar(env, name));
      else {
        const value = valueFrom(flags, io);
        if (sub === 'set')
          await (secret ? client.setSecret(env, name, value) : client.setVar(env, name, value));
        else
          await (secret
            ? client.updateSecret(env, name, value)
            : client.updateVar(env, name, value));
      }
      io.stderr(`${sub} ${command.slice(0, -1)} ${name} in ${env}`);
      return 0;
    }
    case 'proxy': {
      const { client } = await session(flags, io);
      const sessionInfo = await client.proxy(requireFlag(flags, 'service'), {
        env: requireEnv(flags),
        port: integer(flags, 'port'),
      });
      print(
        io,
        flags,
        sessionInfo,
        () =>
          `proxy session until ${sessionInfo.expiresAt}: send HTTP requests to ${sessionInfo.url}/<path> with your bearer, e.g. curl -H "Authorization: Bearer $TOKEN" ${sessionInfo.url}/`,
      );
      return 0;
    }
    case 'init': {
      const seeded = init({
        name: sub,
        dir: flags.dir,
        projectName: flags.name,
        force: flags.force === 'true',
        cwd: io.cwd,
      });
      print(io, flags, seeded, () => `seeded ${seeded.directory}: ${seeded.files.join(', ')}`);
      return 0;
    }
    default:
      throw new CliError(`unknown command ${command}\n\n${USAGE}`, 2);
  }
}
