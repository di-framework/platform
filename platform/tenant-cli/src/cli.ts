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
  readStore,
  resolveAccount,
  writeStore,
} from './credentials.ts';
import { init } from './init.ts';

export interface Io {
  stdout(line: string): void;
  stderr(line: string): void;
  /** Standard input, read whole; used by `--from-file -`. */
  stdin(): string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetch?: typeof fetch;
}

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
  services create <http|cron|worker> --name <name> --env <env> [--port <n>] [--route <pattern>] [--schedule <cron>] [--command <argv>]
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

/** Resolves the credential on disk for the account and builds a client with its bearer. */
function session(
  flags: Record<string, string>,
  io: Io,
): { credential: Credential; client: TenantClient } {
  const account = resolveAccount(flags.account, io.env, readStore(io.env));
  const credential = load(account, io.env);
  const client = createClient({
    baseUrl: credential.controller.url,
    token: bearer(credential),
    fetch: io.fetch,
  });
  return { credential, client };
}

async function login(flags: Record<string, string>, io: Io): Promise<number> {
  const controller = requireFlag(flags, 'controller').replace(/\/$/, '');
  const info = await createClient({ baseUrl: controller, fetch: io.fetch }).authInfo();
  if (flags.account && info.account !== flags.account) {
    throw new CliError(`${controller} serves account ${info.account}, not ${flags.account}`);
  }
  const apiKey = flags['api-key'];
  if (!apiKey) {
    io.stderr(
      `Browser login against ${info.issuer} (client ${info.clientId}) is not implemented in the pilot yet; pass --api-key, or log in with the tenant-auth CLI to seed the credential.`,
    );
    return 2;
  }
  const who = await createClient({ baseUrl: controller, token: apiKey, fetch: io.fetch }).whoami();
  const credential: Credential = {
    account: info.account,
    user: who.user,
    role: who.role,
    via: 'api-key',
    apiKey,
    controller: { url: controller },
  };
  const store = readStore(io.env);
  store[info.account] = credential;
  writeStore(store, io.env);
  io.stderr(`Logged in to ${info.account} as ${who.user} (${who.role}) via api-key.`);
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
      const { credential, client } = session(flags, io);
      await client.logout();
      const store = readStore(io.env);
      delete store[credential.account];
      writeStore(store, io.env);
      io.stderr(`Logged out of ${credential.account}.`);
      return 0;
    }
    case 'whoami': {
      const { client } = session(flags, io);
      const who = await client.whoami();
      print(io, flags, who, () => `${who.user} (${who.role}) in ${who.account} via ${who.via}`);
      return 0;
    }
    case 'deploy': {
      if (sub !== 'preview' && sub !== 'apply') throw new CliError('usage: deploy preview|apply');
      const env = requireEnv(flags);
      const bundle = JSON.parse(readFileSync(requireFlag(flags, 'bundle'), 'utf8')) as DeployBundle;
      bundle.env = env;
      const { client } = session(flags, io);
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
      const { client } = session(flags, io);
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
        throw new CliError('usage: services create <http|cron|worker> --name <name>');
      const type = rest[0];
      if (type !== 'http' && type !== 'cron' && type !== 'worker') {
        throw new CliError('service type must be http, cron, or worker');
      }
      const request: CreateServiceRequest = {
        env: requireEnv(flags),
        type,
        name: requireFlag(flags, 'name'),
        port: integer(flags, 'port'),
        route: flags.route,
        schedule: flags.schedule,
        command: flags.command?.split(' '),
      };
      const { client } = session(flags, io);
      const service = await client.createService(request);
      print(
        io,
        flags,
        service,
        () => `created ${service.type} service ${service.name} in ${service.env}`,
      );
      return 0;
    }
    case 'deployments': {
      const env = requireEnv(flags);
      const { client } = session(flags, io);
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
      const { client } = session(flags, io);
      const secret = command === 'secrets';
      if (sub === 'list') {
        const list = secret ? await client.secrets(env) : await client.vars(env);
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
      const { client } = session(flags, io);
      const sessionInfo = await client.proxy(requireFlag(flags, 'service'), {
        env: requireEnv(flags),
        port: integer(flags, 'port'),
      });
      print(
        io,
        flags,
        sessionInfo,
        () =>
          `tunnel to port ${sessionInfo.port}: ${sessionInfo.url} (until ${sessionInfo.expiresAt})`,
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
