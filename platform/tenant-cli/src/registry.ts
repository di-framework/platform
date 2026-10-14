import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './credentials.ts';

/**
 * The credential file `registry login` writes: the Docker `config.json` format, which docker,
 * oras, and helm read by default and podman reads through `--authfile` / `REGISTRY_AUTH_FILE`.
 * `--config` wins, then `$DOCKER_CONFIG/config.json`, then `~/.docker/config.json`.
 */
export function dockerConfigPath(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  if (flag) return flag;
  if (env.DOCKER_CONFIG) return join(env.DOCKER_CONFIG, 'config.json');
  return join(env.HOME ?? homedir(), '.docker', 'config.json');
}

interface DockerConfig {
  auths?: Record<string, { auth?: string; [key: string]: unknown }>;
  credsStore?: string;
  credHelpers?: Record<string, string>;
  [key: string]: unknown;
}

function readConfig(path: string): DockerConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as DockerConfig;
  } catch {
    // Reported below; never overwrite a file that cannot be read back.
  }
  throw new CliError(`${path} is not a JSON object; refusing to overwrite it`);
}

function writeConfig(path: string, config: DockerConfig): void {
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Stores `username:password` for `host` under `auths`, keeping every other entry and key.
 * Returns a warning when a credential helper would shadow the entry.
 */
export function storeRegistryAuth(
  path: string,
  host: string,
  username: string,
  password: string,
): string | undefined {
  const config = readConfig(path);
  config.auths = {
    ...config.auths,
    [host]: { auth: Buffer.from(`${username}:${password}`).toString('base64') },
  };
  writeConfig(path, config);
  const helper = config.credHelpers?.[host] ?? config.credsStore;
  return helper
    ? `warning: ${path} names the credential helper "${helper}", which docker consults instead of this entry; use --with docker to log in through it`
    : undefined;
}

/** Drops the `auths` entry for `host`; true when there was one. */
export function removeRegistryAuth(path: string, host: string): boolean {
  const config = readConfig(path);
  if (!config.auths?.[host]) return false;
  delete config.auths[host];
  writeConfig(path, config);
  return true;
}

export const LOGIN_TOOLS = ['docker', 'podman', 'oras'] as const;
export type LoginTool = (typeof LOGIN_TOOLS)[number];

/**
 * The `<tool> login` command line; the password goes to its stdin, never into argv. A plain
 * `http:` origin (loopback or in-cluster only) needs the tool's plain-HTTP switch.
 */
export function loginCommand(
  tool: LoginTool,
  host: string,
  username: string,
  plainHttp: boolean,
): string[] {
  const command = [tool, 'login', host, '--username', username, '--password-stdin'];
  if (plainHttp && tool === 'oras') command.push('--plain-http');
  if (plainHttp && tool === 'podman') command.push('--tls-verify=false');
  return command;
}
