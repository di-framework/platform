/**
 * Minimal Kubernetes client. The controller uses it with a credential that can read tenancy CRs,
 * mint ServiceAccount tokens for its tenant's members, and keep API-key Secrets. The prototype
 * reads an admin kubeconfig; in-cluster it would use its projected ServiceAccount token.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { load } from 'js-yaml';

export const PLATFORM_GROUP = 'platform.di-framework.dev';
export const PLATFORM_VERSION = 'v1alpha1';

export interface Membership {
  tenant: string;
  role: 'developer' | 'viewer';
}
export interface UserResource {
  metadata: { name: string; uid?: string };
  spec: { suspended?: boolean; memberships: Membership[] };
  status?: { conditions?: { type: string; status: string; reason?: string }[] };
}
export interface TenantResource {
  metadata: { name: string };
  spec: { suspended?: boolean };
}
export interface SecretResource {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
  };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  type?: string;
}
export interface MintedToken {
  token: string;
  expirationTimestamp: string;
}

export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface KubeCredentials {
  server: string;
  /** PEM certificate authority, when the kubeconfig carries one. */
  ca?: string;
  token?: string;
  /** Projected ServiceAccount token path, re-read per request because kubelet rotates it. */
  tokenFile?: string;
  cert?: string;
  key?: string;
}

/** Credentials of the pod's own ServiceAccount, as the platform controller uses them. */
export function inClusterCredentials(
  directory = '/var/run/secrets/kubernetes.io/serviceaccount',
  env = process.env,
): KubeCredentials {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host || !existsSync(`${directory}/token`)) throw new Error('not running inside a cluster');
  return {
    server: `https://${host}:${env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443'}`,
    ca: readFileSync(`${directory}/ca.crt`, 'utf8'),
    tokenFile: `${directory}/token`,
  };
}

interface Kubeconfig {
  'current-context'?: string;
  contexts?: { name: string; context: { cluster: string; user: string } }[];
  clusters?: {
    name: string;
    cluster: {
      server: string;
      'certificate-authority-data'?: string;
      'certificate-authority'?: string;
    };
  }[];
  users?: {
    name: string;
    user: {
      token?: string;
      'client-certificate-data'?: string;
      'client-key-data'?: string;
      'client-certificate'?: string;
      'client-key'?: string;
    };
  }[];
}

const decode = (value: string) => Buffer.from(value, 'base64').toString('utf8');

/** Resolve one context of a kubeconfig file into connection credentials. */
export function loadKubeconfig(path: string, contextName?: string): KubeCredentials {
  const doc = load(readFileSync(path, 'utf8')) as Kubeconfig;
  const name = contextName ?? doc['current-context'];
  const context = doc.contexts?.find((c) => c.name === name)?.context;
  if (!context) throw new Error(`kubeconfig ${path} has no context ${name ?? '(current)'}`);
  const cluster = doc.clusters?.find((c) => c.name === context.cluster)?.cluster;
  const user = doc.users?.find((u) => u.name === context.user)?.user;
  if (!cluster || !user) throw new Error(`kubeconfig ${path}: context ${name} is incomplete`);
  const relative = (file: string) => readFileSync(resolve(dirname(path), file), 'utf8');
  return {
    server: cluster.server,
    ca: cluster['certificate-authority-data']
      ? decode(cluster['certificate-authority-data'])
      : cluster['certificate-authority']
        ? relative(cluster['certificate-authority'])
        : undefined,
    token: user.token,
    cert: user['client-certificate-data']
      ? decode(user['client-certificate-data'])
      : user['client-certificate']
        ? relative(user['client-certificate'])
        : undefined,
    key: user['client-key-data']
      ? decode(user['client-key-data'])
      : user['client-key']
        ? relative(user['client-key'])
        : undefined,
  };
}

const usersPath = `/apis/${PLATFORM_GROUP}/${PLATFORM_VERSION}/users`;
const tenantsPath = `/apis/${PLATFORM_GROUP}/${PLATFORM_VERSION}/tenants`;

export class KubeClient {
  constructor(
    private readonly credentials: KubeCredentials,
    readonly platformNamespace: string,
  ) {}

  get server(): string {
    return this.credentials.server;
  }
  /** PEM certificate authority of the API server, when known. */
  get ca(): string | undefined {
    return this.credentials.ca;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { server, ca, tokenFile, cert, key } = this.credentials;
    const token =
      this.credentials.token ?? (tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${server}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Bun-specific: pin the cluster CA and present the client certificate when there is no token.
      tls: { ca, ...(token ? {} : { cert, key }) },
      signal: AbortSignal.timeout(15_000),
    } as RequestInit);
    const text = await response.text();
    if (!response.ok) {
      let reason = `${method} ${path.split('?')[0]} returned ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) reason = parsed.message;
      } catch {}
      throw new KubeError(response.status, reason);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async optional<T>(path: string): Promise<T | undefined> {
    try {
      return await this.call<T>('GET', path);
    } catch (error) {
      if (error instanceof KubeError && error.status === 404) return undefined;
      throw error;
    }
  }

  getUser(name: string): Promise<UserResource | undefined> {
    return this.optional(`${usersPath}/${encodeURIComponent(name)}`);
  }
  listUsers(): Promise<{ items: UserResource[] }> {
    return this.call('GET', usersPath);
  }
  getTenant(name: string): Promise<TenantResource | undefined> {
    return this.optional(`${tenantsPath}/${encodeURIComponent(name)}`);
  }

  /**
   * Mint a bound, expiring token for a ServiceAccount through the TokenRequest API. The API
   * server rejects it as soon as the ServiceAccount is deleted. The token never leaves the
   * controller: it is only ever attached to requests the controller forwards.
   */
  async mintServiceAccountToken(
    serviceAccount: string,
    expirationSeconds: number,
  ): Promise<MintedToken> {
    const result = await this.call<{ status: MintedToken }>(
      'POST',
      `/api/v1/namespaces/${this.platformNamespace}/serviceaccounts/${encodeURIComponent(serviceAccount)}/token`,
      {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenRequest',
        spec: { expirationSeconds },
      },
    );
    return result.status;
  }

  listSecrets(namespace: string, labelSelector: string): Promise<{ items: SecretResource[] }> {
    return this.call(
      'GET',
      `/api/v1/namespaces/${namespace}/secrets?labelSelector=${encodeURIComponent(labelSelector)}`,
    );
  }
  getSecret(namespace: string, name: string): Promise<SecretResource | undefined> {
    return this.optional(`/api/v1/namespaces/${namespace}/secrets/${encodeURIComponent(name)}`);
  }
  createSecret(namespace: string, secret: SecretResource): Promise<SecretResource> {
    return this.call('POST', `/api/v1/namespaces/${namespace}/secrets`, {
      apiVersion: 'v1',
      kind: 'Secret',
      ...secret,
    });
  }
  deleteSecret(namespace: string, name: string): Promise<void> {
    return this.call(
      'DELETE',
      `/api/v1/namespaces/${namespace}/secrets/${encodeURIComponent(name)}`,
    );
  }
}

/** Mints and caches the ServiceAccount tokens a user's requests are sent with. */
export interface UserTokens {
  /** A token for the user's `di-user-<user>` ServiceAccount. */
  token(user: string): Promise<string>;
  /** Drop a cached token, so the next call mints a fresh one. */
  forget(user: string): void;
}

export interface AsUserInit {
  headers?: HeadersInit;
  body?: BodyInit;
}

/** Talks to the API server as one user, with that user's own ServiceAccount and RBAC. */
export interface UserKube {
  readonly user: string;
  /** Sends one request (path with query string) to the API server and returns its raw response. */
  fetch(method: string, path: string, init?: AsUserInit): Promise<Response>;
}

/**
 * Binds the API server to the calling user: requests carry a token for the user's own
 * `di-user-<user>` ServiceAccount instead of the controller's credential, so the platform's
 * roles, quotas and admission policies apply to them exactly as they do to the proxy.
 * Refuses when there is no user.
 */
export function asUser(
  kube: KubeClient,
  tokens: UserTokens,
  principal: { user: string } | undefined,
): UserKube {
  const user = principal?.user;
  if (!user) throw new KubeError(401, 'no user to act as');
  const send = (method: string, path: string, init: AsUserInit, token: string) => {
    const headers = new Headers(init.headers);
    for (const name of [
      'authorization',
      'host',
      'connection',
      'content-length',
      'transfer-encoding',
    ])
      headers.delete(name);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(`${kube.server}${path}`, {
      method,
      headers,
      body: init.body,
      redirect: 'manual',
      tls: { ca: kube.ca },
    } as RequestInit);
  };
  return {
    user,
    async fetch(method, path, init = {}) {
      const response = await send(method, path, init, await tokens.token(user));
      if (response.status !== 401) return response;
      // The cached token belongs to a ServiceAccount that was deleted and recreated (for example
      // after a suspend and unsuspend). Mint a fresh one and retry once.
      tokens.forget(user);
      return send(method, path, init, await tokens.token(user));
    },
  };
}
