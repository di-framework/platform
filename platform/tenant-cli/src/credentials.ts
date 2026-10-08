import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * One account's credential. The file and shape are the ones `platform/tenant-auth`'s CLI writes
 * (`$DI_FRAMEWORK_HOME/credentials.json`), so a login made there seeds the pilot. The pilot
 * reads `controller.url` and the token; it never writes a kubeconfig.
 */
export interface Credential {
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
  console?: string;
}

export type CredentialStore = Record<string, Credential>;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const home = (env: NodeJS.ProcessEnv = process.env): string =>
  env.DI_FRAMEWORK_HOME ?? join(homedir(), '.di-framework');

const credentialsPath = (env?: NodeJS.ProcessEnv) => join(home(env), 'credentials.json');

export function readStore(env?: NodeJS.ProcessEnv): CredentialStore {
  const path = credentialsPath(env);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as CredentialStore) : {};
}

export function writeStore(store: CredentialStore, env?: NodeJS.ProcessEnv): void {
  const directory = home(env);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = credentialsPath(env);
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The bearer a credential presents: the API key, or the identity access token while it lasts. */
export function bearer(credential: Credential): string {
  if (credential.apiKey) return credential.apiKey;
  if (!credential.accessToken) throw new CliError('the credential holds no token; log in again');
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) {
    throw new CliError('the login has expired; run login again');
  }
  return credential.accessToken;
}

/**
 * The account a command runs against: `--account`, then `DI_TENANT_ACCOUNT`, then the only
 * credential on disk.
 */
export function resolveAccount(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  store: CredentialStore,
): string {
  const named = flag ?? env.DI_TENANT_ACCOUNT;
  if (named) return named;
  const accounts = Object.keys(store);
  if (accounts.length === 1) return accounts[0] as string;
  throw new CliError(
    accounts.length === 0
      ? 'not logged in; run: login --controller <url> --account <tenant>'
      : `--account <tenant> is required; logged in to ${accounts.join(', ')}`,
  );
}

export function load(account: string, env?: NodeJS.ProcessEnv): Credential {
  const credential = readStore(env)[account];
  if (!credential)
    throw new CliError(`not logged in to ${account}; run: login --account ${account}`);
  return credential;
}
