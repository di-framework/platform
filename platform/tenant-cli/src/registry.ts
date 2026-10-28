import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError } from './credentials.ts';

/** A registry origin the CLI may send a credential to, checked by `registryOrigin`. */
export interface RegistryOrigin {
  /** `scheme://host[:port]`, no path, userinfo, query, or fragment. */
  origin: string;
  /** `host[:port]`, the login server name the tools take. */
  host: string;
  /** True for an `http:` origin, which is only accepted for loopback and in-cluster hosts. */
  plainHttp: boolean;
}

/** One DNS label: letters, digits, and inner hyphens, so a host never starts with `-`. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(String.raw`^${LABEL}(?:\.${LABEL})*$`);
const IPV6 = /^\[[0-9a-f:.]+\]$/;

/** Loopback and in-cluster hosts: the only ones a credential may reach over plain HTTP. */
function isClusterLocal(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return hostname.endsWith('.svc') || hostname.endsWith('.svc.cluster.local');
}

/**
 * Checks the registry URL the controller returned before any credential is sent to it. It is at
 * least as strict as the controller's rule for `TENANT_CONTROLLER_REGISTRY_URL` (a bare `https:`
 * origin, or `http:` for loopback and `*.svc` / `*.svc.cluster.local` only), plus a hostname
 * syntax check: the host must be a DNS name of letter/digit/hyphen labels (no `_`, no trailing
 * dot), IPv4, or a bracketed IPv6 address, so it can never be read as a command-line flag. The URL
 * parser already refuses a port that is not a number up to 65535. Errors never echo the value,
 * which could carry userinfo.
 */
export function registryOrigin(value: string): RegistryOrigin {
  const refuse = (why: string): never => {
    throw new CliError(`the controller returned an unusable registry URL: ${why}`);
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse('not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') refuse('the scheme must be https');
  if (url.username || url.password) refuse('userinfo is not allowed');
  if (url.pathname !== '/' || url.search || url.hash)
    refuse('path, query, and fragment are not allowed');
  const hostname = url.hostname.toLowerCase();
  if (!HOSTNAME.test(hostname) && !IPV6.test(hostname)) refuse('the host is not a valid hostname');
  const plainHttp = url.protocol === 'http:';
  if (plainHttp && !isClusterLocal(hostname)) {
    refuse('plain http is only allowed for loopback and in-cluster hosts');
  }
  return { origin: url.origin, host: url.host, plainHttp };
}

/** The Basic username the registry ignores; anything else could break `user:password`. */
export function registryUsername(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value) || value.startsWith('-')) {
    throw new CliError('the controller returned an unusable registry username');
  }
  return value;
}

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

/** The file a write lands in: the path itself, or what it links to (a dotfiles symlink stays). */
function writeTarget(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  try {
    if (lstatSync(path).isSymbolicLink()) return resolve(dirname(path), readlinkSync(path));
  } catch {
    // No file and no link: write the path itself.
  }
  return path;
}

/**
 * Writes the config atomically: a fresh 0600 file in the same directory, flushed, then renamed
 * over the target. The token never lands in an existing (possibly 0644) file, and a failed write
 * leaves the previous config, with every other registry's entry, in place.
 */
function writeConfig(path: string, config: DockerConfig): void {
  const target = writeTarget(path);
  const directory = dirname(target);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * The sha256 of an `auths` entry as JSON: recorded with the account at `registry login`, so a
 * logout only removes the entry while it is still the one this CLI wrote. Docker keys entries by
 * host alone, and tenants often share one (`localhost:<port>`), so another account's login or a
 * manual `docker login` may have replaced it since.
 */
export function entryFingerprint(entry: unknown): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

/**
 * Stores `username:password` for `host` under `auths`, keeping every other entry and key.
 * Returns the entry's fingerprint, and a warning when a credential helper would shadow it.
 */
export function storeRegistryAuth(
  path: string,
  host: string,
  username: string,
  password: string,
): { fingerprint: string; warning?: string } {
  const config = readConfig(path);
  const entry = { auth: Buffer.from(`${username}:${password}`).toString('base64') };
  config.auths = { ...config.auths, [host]: entry };
  writeConfig(path, config);
  const fingerprint = entryFingerprint(entry);
  const helper = config.credHelpers?.[host] ?? config.credsStore;
  if (!helper) return { fingerprint };
  return {
    fingerprint,
    warning: `warning: ${path} names the credential helper "${helper}", which docker consults instead of this entry; use --with docker to log in through it`,
  };
}

/**
 * Drops the `auths` entry for `host`. With a `fingerprint`, only while the entry still matches it
 * (`changed` otherwise, and the entry stays); without one, whatever it holds (`registry logout
 * --host`).
 */
export function removeRegistryAuth(
  path: string,
  host: string,
  fingerprint?: string,
): 'removed' | 'absent' | 'changed' {
  const config = readConfig(path);
  const entry = config.auths?.[host];
  if (!config.auths || !entry) return 'absent';
  if (fingerprint !== undefined && entryFingerprint(entry) !== fingerprint) return 'changed';
  delete config.auths[host];
  writeConfig(path, config);
  return 'removed';
}

export const LOGIN_TOOLS = ['docker', 'podman', 'oras'] as const;
export type LoginTool = (typeof LOGIN_TOOLS)[number];

export function loginTool(value: string): LoginTool {
  const tool = LOGIN_TOOLS.find((t) => t === value);
  if (!tool) throw new CliError(`--with must be one of ${LOGIN_TOOLS.join(', ')}`);
  return tool;
}

/**
 * The `<tool> login` command line. The password goes to its stdin, never into argv; options use
 * the `--name=value` form, and `--` ends them before the validated host, so nothing the
 * controller returns can be parsed as a flag. A plain `http:` origin (loopback or in-cluster only)
 * needs the tool's plain-HTTP switch.
 */
export function loginCommand(
  tool: LoginTool,
  registry: RegistryOrigin,
  username: string,
): string[] {
  const command: string[] = [tool, 'login', `--username=${username}`, '--password-stdin'];
  if (registry.plainHttp && tool === 'oras') command.push('--plain-http');
  if (registry.plainHttp && tool === 'podman') command.push('--tls-verify=false');
  command.push('--', registry.host);
  return command;
}

/** `<tool> logout -- <host>`: undoes a `--with` login in the tool's own credential store. */
export function logoutCommand(tool: LoginTool, host: string): string[] {
  return [tool, 'logout', '--', host];
}
