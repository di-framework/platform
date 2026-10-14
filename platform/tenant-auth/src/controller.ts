/**
 * Tenant controller (prototype): an authenticating reverse proxy in front of the Kubernetes API
 * for one tenant. Requests arrive with an identity-server access token or a tenant API key. The
 * controller resolves the user, swaps in a short-lived token for that user's own ServiceAccount,
 * and forwards only requests that stay inside the tenant's namespaces. The platform's existing
 * roles, quotas, and admission policies apply unchanged; the Kubernetes token never leaves here.
 */
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { AuthError, IdentityResolver, type Principal } from './identity.ts';
import { createApiKey, type KeyStore, listApiKeys, revokeApiKey } from './keys.ts';
import {
  asUser,
  type ConfigMapResource,
  inClusterCredentials,
  KubeClient,
  KubeError,
  loadKubeconfig,
  MEMBERS_CONFIG,
  type UserResource,
  type UserTokens,
} from './kube.ts';
import { discover, type ProviderMetadata } from './oidc.ts';
import { type RegistryListener, serveRegistryListener } from './registry-listener.ts';
import { controllerSecretReader } from './v1/context.ts';
import { serveV1, TITLES } from './v1/index.ts';
import {
  PASSTHROUGH,
  servePassthrough,
  tenantUpstream,
  upstreamRequestHeaders,
} from './v1/proxy.ts';

export interface ControllerConfig {
  tenant: string;
  /** Admin kubeconfig for local runs; omitted in-cluster, where the pod's ServiceAccount is used. */
  kubeconfig?: string;
  context?: string;
  platformNamespace: string;
  issuer: string;
  /** Wait between issuer discovery attempts; doubles from `initialMs` up to `maxMs`. */
  discoveryBackoff?: { initialMs: number; maxMs: number };
  host: string;
  port: number;
  tlsCert?: string;
  tlsKey?: string;
  /** Lifetime of the ServiceAccount tokens the controller mints for itself to forward with. */
  tokenTtlSeconds: number;
  /** The identity server's public native client that the tenant CLI logs in with. */
  cliClientId: string;
  /**
   * Origin of the tenant's own OCI registry (platform#83), or undefined when the platform has not
   * configured one. Set from `TENANT_CONTROLLER_REGISTRY_URL`, where `{tenant}` stands for the tenant.
   */
  registryUrl?: string;
  /**
   * Whether the platform configured a registry for this tenant (`TENANT_CONTROLLER_REGISTRY_HOST`
   * is set). With no `registryUrl` it is configured but not served (a host conflict or a
   * suspended tenant), which `GET /v1/deploy/registry` reports differently from none.
   */
  registryConfigured: boolean;
  /**
   * Listener serving only `GET /v1/auth/whoami`, for the tenant registry component on the
   * tenant's hosts (platform#83). NetworkPolicy admits only the host pods to it. Unset: none.
   * With `tlsCert` and `tlsKey` it serves TLS with the same certificate as `port` (platform#113)
   * and, unless `whoamiTlsOnly`, plain HTTP on the same port too, so a registry still configured
   * with an `http://` URL keeps working during an upgrade. Without them: plain HTTP only.
   */
  whoamiPort?: number;
  /**
   * Refuse plain HTTP on the whoami listener (`TENANT_CONTROLLER_WHOAMI_TLS_ONLY=true`): only
   * TLS connections are served. Default false. Has no effect without a certificate.
   */
  whoamiTlsOnly?: boolean;
  /**
   * TLS listener (same certificate as `port`) that fronts the tenant registry: every request is
   * forwarded to the tenant hosts with `Host: registryHost`. The gateway passes TLS for the
   * registry's public host through to it, so registry credentials never cross plain HTTP before
   * the cluster. Unset: none.
   */
  registryFrontPort?: number;
  /** The registry workload's `wasi:http` host, sent as `Host` upstream. Default `registry`. */
  registryHost: string;
  /**
   * Largest request body the registry front accepts (`TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES`,
   * default 512 MiB, well above a Wasm component layer); larger is answered 413.
   */
  registryMaxBodyBytes: number;
  /**
   * How long the registry front waits for the registry's response headers once the request body
   * has been forwarded in full (`TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS`, default 60 s);
   * then it answers 504. Response bodies are bounded by the listener's idle timeout.
   */
  registryUpstreamTimeoutMs: number;
  /**
   * How long an upload may go without delivering a byte while the front waits for one
   * (`TENANT_CONTROLLER_REGISTRY_UPLOAD_IDLE_TIMEOUT_MS`, default 60 s); then the upload is cut
   * off with 408. A steady upload of any length succeeds; a stalled one cannot hold a slot.
   */
  registryUploadIdleTimeoutMs: number;
  /**
   * Registry requests in flight at once (`TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT`, default
   * 16); more are answered 503, so the front never starves the tenant API in the same process.
   */
  registryMaxConcurrent: number;
  /**
   * The tenant hosts' pull-only listener (platform#83 `:host-pull`): GET and HEAD forwarded like
   * the registry front. NetworkPolicy admits only the host pods. Unset: none.
   */
  registryPullPort?: number;
  /** Whether the pull listener uses TLS (default); false when hosts pull over plain HTTP. */
  registryPullTls: boolean;
  /**
   * How long a host pull waits for the registry workload to come up
   * (`TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS`, default 30 s; #197). After a host starts,
   * its workloads pull while `di-tenant-registry` on the same host is still starting; the pull
   * listener retries until the registry answers instead of failing the pull, which wash would
   * only retry about a minute later.
   */
  registryPullWaitMs: number;
  /**
   * In-cluster registry host workloads reference (`TENANT_CONTROLLER_REGISTRY_PULL_HOST`);
   * `/v1/deploy` points users at it when a workload names the public origin instead.
   */
  registryPullHost?: string;
  /**
   * File holding the host pull token (`TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE`): the whoami
   * listener answers it as a pull-only principal. Read on every call, so rotation needs no restart.
   */
  hostPullTokenFile?: string;
}

/** The whoami listener serves `GET` only, so it never needs a request body. */
export const WHOAMI_MAX_BODY_BYTES = 1024;

/**
 * Most connections the whoami listener holds at once. Only the tenant hosts' registry calls it;
 * each connection is relayed and holds three sockets (see `RegistryListenerOptions`).
 */
export const WHOAMI_MAX_CONNECTIONS = 256;

/**
 * How long a whoami caller may take to send a request before the listener answers, so a caller
 * trickling bytes cannot hold one of the {@link WHOAMI_MAX_CONNECTIONS}. Whoami takes no body.
 */
export const WHOAMI_REQUEST_TIMEOUT_SECONDS = 30;

/**
 * The whoami listener (platform#83) on `port`: with `tls`, TLS with the controller certificate
 * (platform#113), which the tenant hosts trust through `--http-client-ca-path`, and plain HTTP on
 * the same port unless `whoamiTlsOnly`, for a registry whose config still names `http://` while
 * an upgrade rolls out. Without `tls`, plain HTTP as before.
 */
export function serveWhoamiListener(
  controller: Pick<Controller, 'handleWhoami'>,
  config: Pick<ControllerConfig, 'host' | 'whoamiTlsOnly'>,
  port: number,
  tls: { cert: string; key: string } | undefined,
): Promise<RegistryListener> {
  return serveRegistryListener({
    hostname: config.host,
    port,
    tls,
    acceptPlainHttp: !config.whoamiTlsOnly,
    // Token refreshes through the identity guest can take longer than Bun's 10 s default.
    idleTimeoutSeconds: 120,
    maxRequestBodySize: WHOAMI_MAX_BODY_BYTES,
    maxConnections: WHOAMI_MAX_CONNECTIONS,
    requestTimeoutSeconds: WHOAMI_REQUEST_TIMEOUT_SECONDS,
    fetch: (request) => controller.handleWhoami(request),
  });
}

/** Idle timeout of the registry front's client sockets; any data flow resets it. */
export const REGISTRY_IDLE_TIMEOUT_SECONDS = 120;

/**
 * The body cap on the hosts' pull listener (S2 of the platform#83 `:host-pull` review): it serves
 * GET and HEAD only and never forwards a body, so anything larger is refused by the listener.
 */
export const REGISTRY_PULL_MAX_BODY_BYTES = 1024;
const DEFAULT_REGISTRY_MAX_BODY_BYTES = 512 * 1024 * 1024;
/** Backoff between host pull attempts while the registry is starting (#197). */
const REGISTRY_PULL_RETRY_INITIAL_MS = 250;
const REGISTRY_PULL_RETRY_MAX_MS = 2_000;

/**
 * Whether a host's answer comes from the host rather than the registry workload: wash answers a
 * `Host` no workload serves yet with an empty 404 (and its own gateway errors with an empty 502 or
 * 503), while the registry's errors always carry an OCI JSON body with its `content-type`.
 */
export function registryNotServing(response: Response): boolean {
  return [404, 502, 503].includes(response.status) && !response.headers.has('content-type');
}

/** Largest registry error body read for its OCI code; the registry's own is about 120 bytes. */
const REGISTRY_ERROR_BODY_MAX_BYTES = 16 * 1024;

/**
 * Whether a registry answer is its own `503` with OCI error code `UNAVAILABLE`: the registry sends
 * it while the tenant controller's whoami cannot be reached (a controller restart, an identity
 * issuer outage), so a host pull may wait it out like a registry that is still starting.
 *
 * On a GET, only a JSON body of at most {@link REGISTRY_ERROR_BODY_MAX_BYTES} is read, from a
 * clone, so the response stays whole; a body that is cut off, unreadable, not JSON, or not read
 * before `signal` aborts is not `UNAVAILABLE`. A HEAD answer has no body to read the code from, so
 * any `503` with a JSON `content-type` counts: that is the registry's only `503` (its `unavailable`
 * answer in `oci-registry/src/auth.rs`), while the host's own gateway errors carry no content type.
 */
export async function registryUnavailable(
  response: Response,
  options: { head?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (response.status !== 503) return false;
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(type.trim())) return false;
  if (options.head) return true;
  if (!response.body) return false;
  const text = await readCapped(response.clone(), REGISTRY_ERROR_BODY_MAX_BYTES, options.signal);
  if (text === undefined) return false;
  try {
    const body = JSON.parse(text) as { errors?: unknown };
    return (
      Array.isArray(body.errors) &&
      body.errors.some(
        (error) =>
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === 'UNAVAILABLE',
      )
    );
  } catch {
    return false;
  }
}

/** A response body as text, or undefined when it exceeds `max`, fails, or `signal` aborts. */
async function readCapped(
  response: Response,
  max: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const stop = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal?.aborted) return undefined;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        stop();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  if (signal?.aborted) return undefined;
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A slot of a registry request pool; both calls are idempotent. */
interface PoolSlot {
  /** Takes the slot; false when the pool is full. */
  acquire(): boolean;
  release(): void;
}

function poolSlot(pool: { inFlight: number }, max: number): PoolSlot {
  let held = false;
  return {
    acquire() {
      if (held) return true;
      if (pool.inFlight >= max) return false;
      pool.inFlight++;
      held = true;
      return true;
    },
    release() {
      if (!held) return;
      held = false;
      pool.inFlight--;
    },
  };
}

function registryBusy(): Response {
  return problem(503, 'Service Unavailable', 'the tenant registry is busy; retry shortly');
}

/** One host pull attempt: the answer, or the connection failure (an abort is rethrown). */
async function attemptPull(
  send: () => Promise<Response>,
  signal: AbortSignal,
): Promise<{ response?: Response; failure?: unknown }> {
  try {
    return { response: await send() };
  } catch (error) {
    if (signal.aborted) throw error;
    return { failure: error };
  }
}

/** The last attempt's answer, or its failure once the wait is over. */
function settle(outcome: { response?: Response; failure?: unknown }): Response {
  if (outcome.response) return outcome.response;
  throw outcome.failure;
}

/**
 * Pauses `delay`, doubling it each time, until a slot is free again; returns the next delay, or
 * undefined when none frees up before `deadline`.
 */
async function pauseForSlot(
  delay: number,
  deadline: number,
  signal: AbortSignal,
  slot: PoolSlot,
): Promise<number | undefined> {
  let next = delay;
  for (;;) {
    await pause(next, signal);
    next = Math.min(next * 2, REGISTRY_PULL_RETRY_MAX_MS);
    if (slot.acquire()) return next;
    if (Date.now() + next > deadline) return undefined;
  }
}

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`${name} must be a positive integer`);
  return number;
}

/**
 * True for hosts where plain `http://` cannot leave the machine or cluster: loopback and in-cluster
 * Service names. Same rule as `platform/oci-registry` (`is_cluster_local`).
 */
function isClusterLocal(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return (host.endsWith('.svc') || host.endsWith('.svc.cluster.local')) && !host.startsWith('.');
}

/**
 * Resolves `{tenant}` in a registry URL pattern and checks it is a bare http(s) origin. Clients send
 * their identity token or `dik_` key to this origin as the Basic password, so plain `http://` is
 * accepted only for loopback and in-cluster hosts. Errors never echo the value, which may carry a
 * credential.
 */
export function registryOrigin(pattern: string | undefined, tenant: string): string | undefined {
  if (!pattern) return undefined;
  const name = 'TENANT_CONTROLLER_REGISTRY_URL';
  let url: URL;
  try {
    url = new URL(pattern.replaceAll('{tenant}', tenant));
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error(`${name} must be an http(s) origin: unsupported scheme`);
  if (url.username || url.password)
    throw new Error(`${name} must be an http(s) origin: userinfo is not allowed`);
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error(
      `${name} must be an http(s) origin: path, query and fragment are not allowed (${url.host})`,
    );
  if (url.protocol === 'http:' && !isClusterLocal(url.hostname))
    throw new Error(
      `${name} must use https:// unless the host is loopback or *.svc / *.svc.cluster.local (${url.host})`,
    );
  return url.origin;
}

function optionalPort(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be a TCP port`);
  return port;
}

/**
 * Relays `body` and calls `release` once it ends: drained, failed, or cancelled by the client
 * (which also cancels the upstream body, aborting its request).
 */
function releasing(
  body: ReadableStream<Uint8Array> | null,
  release: () => void,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    release();
    return null;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        release();
        controller.close();
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

/**
 * Relays an upload and reports how it ends: `stalled` when no byte arrived for `idleMs` while one
 * was wanted (the read is cancelled), `done` once the body has been read in full.
 */
function watchingUpload(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  on: { stalled: () => void; done: () => void },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const timer = setTimeout(() => {
        on.stalled();
        reader.cancel().catch(() => {});
      }, idleMs);
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        on.done();
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The registry's own challenge (`platform/oci-registry` `auth::challenge`), answered at the front. */
function registryChallenge(): Response {
  return new Response('{"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="di-framework-tenant-registry"',
      'content-type': 'application/json',
      'docker-distribution-api-version': 'registry/2.0',
    },
  });
}

/** The user the whoami listener reports for the host pull token. */
export const HOST_PULL_USER = 'system:tenant-host';

/**
 * The single `Content-Encoding` values `fetch` decodes before handing out the body. A proxied
 * body sent with one of these is already plain, so the header must not be relayed (#71); any
 * other value (a multi-coding list, an unknown coding) leaves the body untouched and is relayed as is.
 */
const DECODED_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd']);

/**
 * Whether `fetch` already decoded a body sent with this `Content-Encoding`: it ignores empty and
 * `identity` entries in a list, and decodes what is left only when that is one known coding.
 */
function fetchDecoded(header: string): boolean {
  const codings = header
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '' && coding !== 'identity');
  return codings.length === 0 || (codings.length === 1 && DECODED_ENCODINGS.has(codings[0] ?? ''));
}

/** Headers never relayed back from the registry: hop-by-hop. */
const HOP_BY_HOP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding']);

export function configFromEnv(env = process.env): ControllerConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const tenant = required('TENANT_CONTROLLER_TENANT');
  return {
    tenant,
    kubeconfig: env.TENANT_CONTROLLER_KUBECONFIG,
    context: env.TENANT_CONTROLLER_CONTEXT,
    platformNamespace: env.TENANT_CONTROLLER_PLATFORM_NAMESPACE ?? 'wasmcloud',
    issuer: env.TENANT_CONTROLLER_ISSUER ?? 'http://localhost:4180',
    host: env.TENANT_CONTROLLER_HOST ?? '127.0.0.1',
    port: Number(env.TENANT_CONTROLLER_PORT ?? 8788),
    tlsCert: env.TENANT_CONTROLLER_TLS_CERT,
    tlsKey: env.TENANT_CONTROLLER_TLS_KEY,
    tokenTtlSeconds: Number(env.TENANT_CONTROLLER_TOKEN_TTL ?? 3600),
    cliClientId: env.TENANT_CONTROLLER_CLI_CLIENT_ID ?? 'tenant-cli',
    registryUrl: registryOrigin(env.TENANT_CONTROLLER_REGISTRY_URL, tenant),
    whoamiPort: optionalPort(env.TENANT_CONTROLLER_WHOAMI_PORT, 'TENANT_CONTROLLER_WHOAMI_PORT'),
    whoamiTlsOnly: env.TENANT_CONTROLLER_WHOAMI_TLS_ONLY === 'true',
    registryFrontPort: optionalPort(
      env.TENANT_CONTROLLER_REGISTRY_FRONT_PORT,
      'TENANT_CONTROLLER_REGISTRY_FRONT_PORT',
    ),
    registryConfigured: !!env.TENANT_CONTROLLER_REGISTRY_HOST,
    registryHost: env.TENANT_CONTROLLER_REGISTRY_HOST || 'registry',
    registryMaxBodyBytes: positiveInteger(
      env.TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES,
      'TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES',
      DEFAULT_REGISTRY_MAX_BODY_BYTES,
    ),
    registryUpstreamTimeoutMs: positiveInteger(
      env.TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS,
      'TENANT_CONTROLLER_REGISTRY_UPSTREAM_TIMEOUT_MS',
      60_000,
    ),
    registryUploadIdleTimeoutMs: positiveInteger(
      env.TENANT_CONTROLLER_REGISTRY_UPLOAD_IDLE_TIMEOUT_MS,
      'TENANT_CONTROLLER_REGISTRY_UPLOAD_IDLE_TIMEOUT_MS',
      60_000,
    ),
    registryMaxConcurrent: positiveInteger(
      env.TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT,
      'TENANT_CONTROLLER_REGISTRY_MAX_CONCURRENT',
      16,
    ),
    registryPullPort: optionalPort(
      env.TENANT_CONTROLLER_REGISTRY_PULL_PORT,
      'TENANT_CONTROLLER_REGISTRY_PULL_PORT',
    ),
    registryPullTls: env.TENANT_CONTROLLER_REGISTRY_PULL_TLS !== 'false',
    registryPullWaitMs: positiveInteger(
      env.TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS,
      'TENANT_CONTROLLER_REGISTRY_PULL_WAIT_MS',
      30_000,
    ),
    registryPullHost: env.TENANT_CONTROLLER_REGISTRY_PULL_HOST || undefined,
    hostPullTokenFile: env.TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE || undefined,
  };
}

export const tenantNamespaces = (tenant: string) => [`di-tenant-${tenant}`, `di-runtime-${tenant}`];

/** Characters `encodeURIComponent` escapes that a path segment may carry as they are. */
const SEGMENT_SAFE = /%(3A|40|24|26|2B|2C|3B|3D)/g;

/**
 * The one spelling of an API server path that the proxy checks and forwards (#116), or
 * `undefined` when the path is ambiguous. Each segment is percent-decoded once and re-encoded the
 * same way, so `%73ecrets` and `secrets` are one path to the policy and to the API server.
 * Refused, rather than guessed at: a path not starting with `/`, an empty segment other than a
 * trailing slash (`//secrets`), a malformed escape, and any segment that decodes to `.` or `..`,
 * or to text containing `/`, `\`, `%` (double encoding) or a control character.
 */
export function canonicalPath(pathname: string): string | undefined {
  if (!pathname.startsWith('/')) return undefined;
  const segments = pathname.slice(1).split('/');
  const out: string[] = [];
  for (const [index, raw] of segments.entries()) {
    if (raw === '') {
      if (index === segments.length - 1) {
        out.push('');
        continue;
      }
      return undefined;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused.
    if (decoded === '.' || decoded === '..' || /[/\\%\u0000-\u001f\u007f]/.test(decoded))
      return undefined;
    out.push(encodeURIComponent(decoded).replace(SEGMENT_SAFE, (kept) => decodeURIComponent(kept)));
  }
  return `/${out.join('/')}`;
}

/**
 * Which API server paths a tenant user may reach through this controller. Namespaced paths must
 * name one of the tenant's namespaces; discovery and self-subject reviews are allowed so kubectl
 * works; everything cluster-scoped is refused regardless of the user's RBAC. The decision is made
 * on `canonicalPath(pathname)`, and a path without one is refused (#116).
 */
export function allowed(method: string, rawPathname: string, tenant: string): boolean {
  const pathname = canonicalPath(rawPathname);
  if (pathname === undefined) return false;
  const namespaces = tenantNamespaces(tenant);
  const namespaced =
    /^\/api\/v1\/namespaces\/([^/]+)(\/|$)/.exec(pathname) ??
    /^\/apis\/[^/]+\/[^/]+\/namespaces\/([^/]+)(\/|$)/.exec(pathname);
  if (namespaced?.[1]) return namespaces.includes(namespaced[1]);
  if (method === 'GET' || method === 'HEAD') {
    if (/^\/api(\/v1)?\/?$/.test(pathname) || /^\/apis(\/[^/]+(\/[^/]+)?)?\/?$/.test(pathname))
      return true; // discovery
    if (pathname === '/version' || pathname.startsWith('/openapi/')) return true;
  }
  if (method === 'POST') {
    return [
      '/apis/authentication.k8s.io/v1/selfsubjectreviews',
      '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
      '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews',
    ].includes(pathname);
  }
  return false;
}

/** Secret objects and collections in any namespace, matched on the canonical path (#116). */
const SECRET_PATH = /^\/api\/v1\/namespaces\/[^/]+\/secrets(\/|$)/;

/** A Kubernetes Status object, so kubectl prints the reason instead of a parse error. */
const status = (code: number, reason: string, message: string) =>
  new Response(
    JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: code < 400 ? 'Success' : 'Failure',
      message,
      reason,
      code,
    }),
    { status: code, headers: { 'Content-Type': 'application/json' } },
  );
const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * The `/v1` contract's paths, whose every error is an RFC 9457 problem+json (the contract's
 * `Problem`). Everything else the main listener serves keeps the Kubernetes Status shape.
 */
const isV1 = (pathname: string) => pathname.startsWith('/v1/');

/** The `/v1` bearer challenge (RFC 6750). */
const BEARER_CHALLENGE = 'Bearer realm="di-framework-tenant"';

/**
 * A non-empty bearer token was sent. Only then does a 401 say `invalid_token`: a request with no
 * credential, another scheme, or an empty `Bearer` gets the bare challenge (RFC 6750 §3.1).
 */
const BEARER_PRESENTED = /^Bearer\s+\S/i;

/**
 * An {@link AuthError} as a `/v1` problem: 401 carries the bearer challenge. The detail is the
 * error's fixed message, which never quotes the credential (platform#97).
 */
function v1Refusal(error: AuthError, authorization: string | null): Response {
  const response = problem(error.status, TITLES[error.status] ?? 'Client Error', error.message);
  if (error.status === 401)
    response.headers.set(
      'www-authenticate',
      BEARER_PRESENTED.test(authorization ?? '')
        ? `${BEARER_CHALLENGE}, error="invalid_token"`
        : BEARER_CHALLENGE,
    );
  return response;
}

/** An {@link AuthError} in the caller's shape: a problem under `/v1/`, a Kubernetes Status elsewhere. */
function refusal(request: Request, url: URL, error: AuthError): Response {
  if (isV1(url.pathname)) return v1Refusal(error, request.headers.get('authorization'));
  return status(error.status, error.status === 401 ? 'Unauthorized' : 'Forbidden', error.message);
}

/** A 502 with a fixed message (platform#84), in the caller's shape like {@link refusal}. */
function unavailable(url: URL, message: string): Response {
  return isV1(url.pathname)
    ? problem(502, 'Bad Gateway', message)
    : status(502, 'ServiceUnavailable', message);
}

/** A `docker-content-length` value usable as `Content-Length`: plain digits, safe integer (a duplicated header joins with a comma and fails). */
export function parseSideContentLength(value: string | null): string | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  return Number.isSafeInteger(Number(value)) ? String(Number(value)) : undefined;
}

/** Pending until the issuer answers; `retryAfterSeconds` is the wait until the next attempt. */
type DiscoveryState =
  | { status: 'pending'; retryAfterSeconds: number }
  | { status: 'complete'; provider: ProviderMetadata };

const DISCOVERY_BACKOFF_DEFAULT = { initialMs: 1_000, maxMs: 30_000 };

export class Controller {
  private readonly serviceAccountTokens = new Map<string, { token: string; expiresAt: number }>();
  /** Where proxy sessions forward to; only overridden by tests. */
  proxyUpstream: (tenant: string) => string = tenantUpstream;
  private discoveryState: DiscoveryState;
  private readonly discoveryAbort = new AbortController();
  private discoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeDiscoverySleep: (() => void) | undefined;
  private markDiscovered: () => void = () => {};
  /** Resolves once the issuer has been discovered (or the controller was stopped). */
  readonly discovered: Promise<void> = new Promise((resolve) => {
    this.markDiscovered = resolve;
  });

  constructor(
    readonly config: ControllerConfig,
    readonly kube: KubeClient,
    provider: ProviderMetadata | null,
    readonly identity: IdentityResolver,
    readonly keys: KeyStore,
  ) {
    this.discoveryState = provider
      ? { status: 'complete', provider }
      : { status: 'pending', retryAfterSeconds: 1 };
    if (provider) this.markDiscovered();
  }

  /** Provider metadata; null until discovery completes. */
  get provider(): ProviderMetadata | null {
    return this.discoveryState.status === 'complete' ? this.discoveryState.provider : null;
  }

  /**
   * Builds the controller and starts issuer discovery in the background. It resolves at once, so
   * the listeners can bind while the issuer is still coming up (platform#225).
   */
  static async start(config: ControllerConfig): Promise<Controller> {
    const credentials = config.kubeconfig
      ? loadKubeconfig(config.kubeconfig, config.context)
      : inClusterCredentials();
    const kube = new KubeClient(credentials, config.platformNamespace);
    const keys: KeyStore = {
      kube,
      namespace: `di-runtime-${config.tenant}`,
      tenant: config.tenant,
    };
    const controller = new Controller(
      config,
      kube,
      null,
      new IdentityResolver(kube, null, config.tenant, keys),
      keys,
    );
    void controller.discoverInBackground();
    return controller;
  }

  /** Stops background discovery: aborts an in-flight attempt and clears the retry timer. */
  stop(): void {
    this.discoveryAbort.abort();
    clearTimeout(this.discoveryTimer);
    this.wakeDiscoverySleep?.();
    this.markDiscovered();
  }

  /**
   * Attempts discovery until it succeeds or the controller stops. The wait between attempts
   * doubles from `initialMs` up to `maxMs`; it never gives up, since the issuer may come up at
   * any time and the controller has to recover without a restart.
   */
  private async discoverInBackground(): Promise<void> {
    const { initialMs, maxMs } = this.config.discoveryBackoff ?? DISCOVERY_BACKOFF_DEFAULT;
    const signal = this.discoveryAbort.signal;
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        const provider = await discover(this.config.issuer, 1, signal);
        this.discoveryState = { status: 'complete', provider };
        this.identity.setProvider(provider);
        this.audit('discovery.succeeded', { issuer: this.config.issuer });
        this.markDiscovered();
        return;
      } catch (error) {
        if (signal.aborted) return;
        const delayMs = Math.min(maxMs, initialMs * 2 ** attempt);
        this.discoveryState = {
          status: 'pending',
          retryAfterSeconds: Math.max(1, Math.ceil(delayMs / 1000)),
        };
        this.audit('discovery.failed', {
          error: (error as Error).message,
          issuer: this.config.issuer,
          retryInMs: delayMs,
        });
        await this.sleepUnlessStopped(delayMs);
      }
    }
  }

  private sleepUnlessStopped(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wakeDiscoverySleep = resolve;
      this.discoveryTimer = setTimeout(resolve, ms);
    });
  }

  private isDiscoveryReady(): boolean {
    return this.discoveryState.status === 'complete';
  }

  private getProvider(): ProviderMetadata {
    if (this.discoveryState.status === 'complete') return this.discoveryState.provider;
    throw new Error('issuer discovery is not yet complete');
  }

  private serviceUnavailableUntilDiscovery(): Response {
    const retryAfter =
      this.discoveryState.status === 'pending' ? this.discoveryState.retryAfterSeconds : 1;
    const response = problem(
      503,
      'Service Unavailable',
      'issuer discovery is pending; retry shortly',
    );
    response.headers.set('retry-after', String(retryAfter));
    return response;
  }

  audit(event: string, fields: Record<string, unknown> = {}): void {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        tenant: this.config.tenant,
        event,
        ...fields,
      }),
    );
  }

  /** The user's own ServiceAccount token, minted on demand and cached until shortly before expiry. */
  private async serviceAccountToken(user: string): Promise<string> {
    const cached = this.serviceAccountTokens.get(user);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const minted = await this.kube.mintServiceAccountToken(
      `di-user-${user}`,
      this.config.tokenTtlSeconds,
    );
    this.serviceAccountTokens.set(user, {
      token: minted.token,
      expiresAt: Date.parse(minted.expirationTimestamp),
    });
    this.audit('token.minted', { user, expiresAt: minted.expirationTimestamp });
    return minted.token;
  }

  /** The users' ServiceAccount tokens; forgetting one also drops the cached identity. */
  private readonly userTokens: UserTokens = {
    token: (user) => this.serviceAccountToken(user),
    forget: (user) => {
      this.serviceAccountTokens.delete(user);
      this.identity.forget(user);
    },
  };

  /** `server` (Bun's) supplies the caller's address for the proxy's `X-Forwarded-For`. */
  async handle(
    request: Request,
    server?: { requestIP(request: Request): { address: string } | null },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/-/healthz') {
      return json({
        ok: true,
        tenant: this.config.tenant,
        discoveryReady: this.isDiscoveryReady(),
      });
    }
    // The one public operation of the `/v1` contract: what a CLI needs before it has a credential.
    if (request.method === 'GET' && url.pathname === '/v1/auth/info') {
      if (!this.isDiscoveryReady()) return this.serviceUnavailableUntilDiscovery();
      return json({
        account: this.config.tenant,
        issuer: this.getProvider().issuer,
        clientId: this.config.cliClientId,
      });
    }
    let principal: Principal;
    try {
      principal = await this.identity.resolve(request.headers.get('authorization'));
    } catch (error) {
      if (error instanceof AuthError) {
        this.audit('request.denied', {
          method: request.method,
          path: url.pathname,
          status: error.status,
          reason: error.message,
        });
        // 503 from discovery pending should pass through
        if (error.status === 503) {
          return this.serviceUnavailableUntilDiscovery();
        }
        return refusal(request, url, error);
      }
      this.audit('request.failed', { path: url.pathname, reason: String(error) });
      return unavailable(url, 'the identity provider or cluster is unavailable');
    }
    // A proxy session URL (not a contract operation): forwarded to the session's service.
    const clientAddress = server?.requestIP(request)?.address;
    const session = PASSTHROUGH.exec(url.pathname);
    if (session) {
      try {
        return await servePassthrough(request, url, session, {
          tenant: this.config.tenant,
          principal,
          upstream: this.proxyUpstream(this.config.tenant),
          audit: (event, fields) => this.audit(event, fields),
          clientAddress,
        });
      } catch (error) {
        // A client abort mid-body, or anything else unexpected: audited, never echoed.
        this.audit('request.failed', {
          user: principal.user,
          path: url.pathname,
          reason: String(error),
        });
        return problem(502, 'Bad Gateway', 'the service could not be reached');
      }
    }
    try {
      if (url.pathname.startsWith('/-/') || url.pathname.startsWith('/v1/'))
        return await this.own(request, url, principal);
      return await this.proxy(request, url, principal);
    } catch (error) {
      if (error instanceof AuthError) return refusal(request, url, error);
      // The reason can name ServiceAccounts, namespaces, RBAC text, or the API server URL: it
      // stays in the audit, and the caller gets a fixed message (platform#84).
      const reason = error instanceof KubeError ? error.message : String(error);
      this.audit('request.failed', { user: principal.user, path: url.pathname, reason });
      return unavailable(url, 'the cluster request failed');
    }
  }

  /**
   * The whoami-only listener (platform#83): `GET /v1/auth/whoami` with the same answer as the
   * main listener, and nothing else. Every error is a problem+json, as the `/v1` contract says.
   */
  async handleWhoami(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/auth/whoami')
      return problem(404, 'Not Found', 'this listener serves only GET /v1/auth/whoami');
    if (request.method !== 'GET') {
      const response = problem(405, 'Method Not Allowed', 'only GET is allowed');
      response.headers.set('allow', 'GET');
      return response;
    }
    const authorization = request.headers.get('authorization');
    if (this.isHostPullToken(authorization))
      return json({
        user: HOST_PULL_USER,
        account: this.config.tenant,
        role: 'viewer',
        via: 'host-pull',
        credentialId: 'host-pull',
      });
    try {
      return json(await this.identity.resolve(authorization));
    } catch (error) {
      if (error instanceof AuthError) {
        this.audit('request.denied', {
          method: request.method,
          path: url.pathname,
          listener: 'whoami',
          status: error.status,
          reason: error.message,
        });
        if (error.status === 503) return this.serviceUnavailableUntilDiscovery();
        return v1Refusal(error, authorization);
      }
      this.audit('request.failed', {
        path: url.pathname,
        listener: 'whoami',
        reason: String(error),
      });
      return problem(502, 'Bad Gateway', 'the identity provider or cluster is unavailable');
    }
  }

  /**
   * Whether `authorization` is `Bearer <host pull token>` (platform#83 `:host-pull`). Only the
   * whoami listener, which NetworkPolicy opens to the tenant's host pods alone, accepts it; the
   * main listener never does. The token file is read each time, so a rotated token applies at
   * once; a missing or empty file accepts nothing.
   */
  private isHostPullToken(authorization: string | null): boolean {
    if (!authorization?.startsWith('Bearer ')) return false;
    return this.matchesHostPullToken(authorization.slice(7).trim());
  }

  /**
   * Whether `authorization` is Basic credentials whose password is the host pull token (W2 of the
   * platform#83 `:host-pull` review). The public registry front refuses those, so the host
   * credential works only through the hosts' pull listener.
   */
  private isHostPullBasic(authorization: string): boolean {
    let decoded: string;
    try {
      decoded = atob(authorization.slice(6).trim());
    } catch {
      return false;
    }
    const colon = decoded.indexOf(':');
    return colon >= 0 && this.matchesHostPullToken(decoded.slice(colon + 1).trim());
  }

  /** Constant-time comparison against the current token file; a missing or empty file matches nothing. */
  private matchesHostPullToken(candidate: string): boolean {
    if (!this.config.hostPullTokenFile) return false;
    let expected: Buffer;
    try {
      expected = Buffer.from(readFileSync(this.config.hostPullTokenFile, 'utf8').trim());
    } catch {
      return false;
    }
    const presented = Buffer.from(candidate);
    return (
      expected.length > 0 &&
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  }

  /**
   * The hosts' pull listener (platform#83 `:host-pull`): the registry front for GET and HEAD only,
   * so nothing can be pushed or deleted through it whatever credential arrives.
   */
  async handleRegistryPull(
    request: Request,
    server?: { requestIP(request: Request): { address: string } | null },
  ): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      await request.body?.cancel().catch(() => {});
      const response = problem(405, 'Method Not Allowed', 'this listener only serves pulls');
      response.headers.set('allow', 'GET, HEAD');
      return response;
    }
    // A pull never carries a body (S2): whatever arrives (the listener caps it) is dropped.
    await request.body?.cancel().catch(() => {});
    return this.forwardRegistry(request, server, this.pullPool, false);
  }

  /**
   * The registry front (platform#83): forwards every request, credentials included (the registry
   * authorizes it by calling whoami), to the tenant hosts with `Host: registryHost`, streaming
   * both bodies. The controller does not authenticate here; it only terminates TLS.
   *
   * It is reachable without credentials, so it is bounded: at most `registryMaxConcurrent`
   * requests at once (503 beyond), bodies up to `registryMaxBodyBytes` (413 beyond; the listener
   * enforces the same cap on chunked bodies), an upload that delivers nothing for
   * `registryUploadIdleTimeoutMs` is cut off (408), and once the body is forwarded in full the
   * registry has `registryUpstreamTimeoutMs` for its response headers (504). A request without
   * Basic credentials gets the registry's own challenge here and takes no slot, since the
   * registry would challenge it anyway. A client that goes away aborts the upstream request, and
   * a failed upstream ends the client response. Error answers never carry upstream details.
   */
  async handleRegistry(
    request: Request,
    server?: { requestIP(request: Request): { address: string } | null },
  ): Promise<Response> {
    // The host pull token is for the hosts' pull listener only (W2): refused here, unforwarded.
    const authorization = request.headers.get('authorization');
    if (/^basic /i.test(authorization ?? '') && this.isHostPullBasic(authorization as string)) {
      await request.body?.cancel().catch(() => {});
      this.audit('request.denied', {
        method: request.method,
        path: new URL(request.url).pathname,
        listener: 'registry',
        status: 401,
        reason: 'the host pull credential is not accepted on the public registry front',
      });
      return registryChallenge();
    }
    return this.forwardRegistry(request, server, this.frontPool, true);
  }

  /**
   * Forwards one registry request upstream, holding a slot of `pool` while it is in flight. The
   * front and the hosts' pull listener have separate pools (S1), so public traffic cannot starve
   * host pulls. `withBody` is false for the pull listener, which never forwards a body (S2).
   */
  private async forwardRegistry(
    request: Request,
    server: { requestIP(request: Request): { address: string } | null } | undefined,
    pool: { inFlight: number },
    withBody: boolean,
  ): Promise<Response> {
    const url = new URL(request.url);
    const length = request.headers.get('content-length');
    // A length that is not a number counts as too large.
    if (
      length &&
      (Number.isNaN(Number(length)) || Number(length) > this.config.registryMaxBodyBytes)
    )
      return problem(
        413,
        'Content Too Large',
        `request bodies are limited to ${this.config.registryMaxBodyBytes} bytes`,
      );
    const authorization = request.headers.get('authorization');
    if (!/^basic /i.test(authorization ?? '')) {
      await request.body?.cancel().catch(() => {});
      return registryChallenge();
    }
    const slot = poolSlot(pool, this.config.registryMaxConcurrent);
    if (!slot.acquire()) return registryBusy();
    const release = slot.release;
    const headers = upstreamRequestHeaders(
      request,
      url,
      this.config.registryHost,
      server?.requestIP(request)?.address,
    );
    headers.set('authorization', authorization as string);
    if (length && withBody) headers.set('content-length', length);
    // The upstream request ends with the client's, when the upload stalls, or when the headers
    // take too long once the body has been sent (W5 of the platform#83 review).
    const timeout = new AbortController();
    const stall = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A registry that answers before the upload ends (a 401, say) must not be aborted later.
    let answered = false;
    const armHeaderTimer = () => {
      if (answered) return;
      timer = setTimeout(() => timeout.abort(), this.config.registryUpstreamTimeoutMs);
    };
    const body =
      withBody && request.body
        ? watchingUpload(request.body, this.config.registryUploadIdleTimeoutMs, {
            stalled: () => stall.abort(),
            done: armHeaderTimer,
          })
        : null;
    if (!body && withBody) armHeaderTimer();
    const signal = AbortSignal.any([request.signal, timeout.signal, stall.signal]);
    const send = () =>
      fetch(`${this.proxyUpstream(this.config.tenant)}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body,
        duplex: 'half',
        redirect: 'manual',
        decompress: false,
        signal,
      } as RequestInit);
    let upstream: Response;
    try {
      // A host pull carries no body, so it can be resent while the registry is starting (#197).
      // Each attempt gets the full header timeout, so the wait is bounded only by
      // `registryPullWaitMs` and never ends in a 504 while the host keeps answering.
      const attempt = async () => {
        armHeaderTimer();
        try {
          return await send();
        } finally {
          clearTimeout(timer);
        }
      };
      const answer = withBody
        ? await send()
        : await this.untilRegistryAnswers(attempt, signal, url, slot, request.method === 'HEAD');
      // No slot came free for a waiting pull before its wait was over (it holds none).
      if (!answer) return registryBusy();
      upstream = answer;
    } catch (error) {
      release();
      const timedOut = timeout.signal.aborted;
      const stalled = stall.signal.aborted;
      this.audit('request.failed', {
        path: url.pathname,
        listener: 'registry',
        reason: stalled ? 'upload stalled' : timedOut ? 'upstream timeout' : String(error),
      });
      if (stalled) return problem(408, 'Request Timeout', 'the request body stopped arriving');
      return timedOut
        ? problem(504, 'Gateway Timeout', 'the tenant registry did not answer in time')
        : problem(502, 'Bad Gateway', 'the tenant registry could not be reached');
    } finally {
      answered = true;
      clearTimeout(timer);
    }
    const out = new Headers();
    const dockerContentLength = upstream.headers.get('docker-content-length');
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_RESPONSE.has(name) && name !== 'docker-content-length') {
        out.append(name, value);
      }
    });
    // The registry's host rejects a declared `Content-Length` on an empty HEAD body, so the registry
    // sends the size as `docker-content-length` on HEAD; restore it here. Accept only a single
    // plain-digit safe integer, otherwise drop it. A GET keeps the registry's own `Content-Length`,
    // which the registry listener writes as is (#197).
    if (request.method === 'HEAD') {
      const length = parseSideContentLength(dockerContentLength);
      if (length !== undefined) out.set('content-length', length);
    }
    return new Response(releasing(upstream.body, release), {
      status: upstream.status,
      headers: out,
    });
  }

  /**
   * Sends a host pull until the registry workload answers it (#197), for at most
   * `registryPullWaitMs`. After a host (re)start its workloads pull while `di-tenant-registry` on
   * the same host is still starting: the host then refuses the connection, or answers the empty
   * 404 wash gives a `Host` no workload serves yet. Both are retried with a short backoff, as is
   * the registry's own `503 UNAVAILABLE` (it cannot reach this controller's whoami yet; told by
   * its OCI code on a GET and by its JSON `content-type` on a HEAD, see
   * {@link registryUnavailable}); any other answer from the registry itself (its errors are OCI
   * JSON) is final. Reading a `503` body for its code is bounded by `registryUpstreamTimeoutMs`.
   * The wait is bounded and only delays this one pull, so a host that serves the registry is never
   * held back by it.
   *
   * The pool slot is given back between attempts, so pulls waiting out a host restart do not
   * turn away the other pulls; an attempt takes a slot again first, and a pull that finds none
   * free before the wait is over gets undefined (answered as busy).
   */
  private async untilRegistryAnswers(
    send: () => Promise<Response>,
    signal: AbortSignal,
    url: URL,
    slot: PoolSlot,
    head: boolean,
  ): Promise<Response | undefined> {
    const deadline = Date.now() + this.config.registryPullWaitMs;
    let delay = REGISTRY_PULL_RETRY_INITIAL_MS;
    for (let tries = 0; ; tries++) {
      const outcome = await attemptPull(send, signal);
      const reason = await this.pullRetryReason(outcome, signal, head);
      // Without a reason to retry, the attempt has the registry's final answer.
      if (reason === undefined) return outcome.response;
      if (Date.now() + delay > deadline) return settle(outcome);
      await outcome.response?.body?.cancel().catch(() => {});
      if (tries === 0)
        this.audit('registry.waiting', { path: url.pathname, listener: 'registry-pull', reason });
      slot.release();
      const next = await pauseForSlot(delay, deadline, signal, slot);
      if (next === undefined) return undefined;
      delay = next;
    }
  }

  /**
   * Why a host pull attempt is retried (#197), or undefined when its answer is final: a failed
   * attempt, the host's own answer while the registry is not serving, or the registry's
   * `503 UNAVAILABLE`. Only a `503` can be that, so only a `503` starts a body-read timer.
   */
  private async pullRetryReason(
    outcome: { response?: Response; failure?: unknown },
    signal: AbortSignal,
    head: boolean,
  ): Promise<string | undefined> {
    const { response } = outcome;
    if (!response) return String(outcome.failure);
    if (registryNotServing(response))
      return `the host answered ${response.status} before the registry was serving`;
    if (response.status !== 503) return undefined;
    const bodyRead = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.config.registryUpstreamTimeoutMs),
    ]);
    const unavailable = await registryUnavailable(response, { head, signal: bodyRead });
    signal.throwIfAborted();
    return unavailable ? 'the registry answered 503 UNAVAILABLE' : undefined;
  }

  /** Registry front requests in flight (see {@link handleRegistry}). */
  private readonly frontPool = { inFlight: 0 };
  /** Host pull listener requests in flight (see {@link handleRegistryPull}); separate from the front's (S1). */
  private readonly pullPool = { inFlight: 0 };

  // The controller's own API: identity, API keys, members.

  private async own(request: Request, url: URL, principal: Principal): Promise<Response> {
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /-/whoami' || route === 'GET /v1/auth/whoami') return json(principal);
    // The CLI revokes its identity token at the issuer itself; the controller only drops its caches.
    if (route === 'POST /v1/auth/logout') {
      this.userTokens.forget(principal.user);
      this.audit('logout', { user: principal.user, via: principal.via });
      return new Response(null, { status: 204 });
    }
    if (route === 'GET /-/keys')
      return json({ keys: await listApiKeys(this.keys, principal.user) });
    if (route === 'POST /-/keys') {
      if (principal.via !== 'identity')
        throw new AuthError(403, 'API keys can only be created from a login');
      const body = (await request.json()) as { name?: string; ttlSeconds?: number };
      const name = (body.name ?? '').trim();
      const ttl = Number(body.ttlSeconds);
      if (!name || name.length > 64 || !Number.isInteger(ttl) || ttl < 60 || ttl > 365 * 86_400)
        throw new AuthError(400, 'name and ttlSeconds (60..31536000) are required');
      const issued = await createApiKey(this.keys, principal.user, name, ttl);
      this.audit('apikey.created', {
        user: principal.user,
        id: issued.id,
        name,
        expiresAt: issued.expiresAt,
      });
      return json(issued, 201);
    }
    const revoke = /^DELETE \/-\/keys\/([0-9a-f]{16})$/.exec(route);
    if (revoke?.[1]) {
      if (!(await revokeApiKey(this.keys, principal.user, revoke[1])))
        throw new AuthError(404, 'no such key');
      this.audit('apikey.revoked', { user: principal.user, id: revoke[1] });
      return new Response(null, { status: 204 });
    }
    if (route === 'GET /-/members') {
      const members = (await this.memberUsers())
        .flatMap((u) =>
          u.spec.memberships
            .filter((m) => m.tenant === this.config.tenant)
            .map((m) => ({
              user: u.metadata.name,
              role: m.role,
              suspended: u.spec.suspended === true,
            })),
        )
        .sort((a, b) => a.user.localeCompare(b.user));
      return json({ members });
    }
    // The `/v1` contract goes through the generated routes, which validate the request and hand
    // it to the resource modules under `v1/`.
    if (url.pathname.startsWith('/v1/'))
      return serveV1(request, {
        tenant: this.config.tenant,
        principal,
        registryUrl: this.config.registryUrl,
        registryConfigured: this.config.registryConfigured,
        registryHost: this.config.registryHost,
        registryPullHost: this.config.registryPullHost,
        asUser: () => asUser(this.kube, this.userTokens, principal),
        asController: () => controllerSecretReader(this.kube),
        audit: (event, fields) => this.audit(event, fields),
      });
    return status(404, 'NotFound', `${url.pathname} is not a controller endpoint`);
  }

  /**
   * The Users behind `/-/members`. The platform lists the tenant's active members in
   * {@link MEMBERS_CONFIG} and lets the controller read only those Users (#321), so each is read by
   * name. A platform that predates it has no such ConfigMap (or no grant on it, a 403) and still
   * lets the controller list every User, which is the fallback.
   */
  private async memberUsers(): Promise<UserResource[]> {
    let published: ConfigMapResource | undefined;
    try {
      published = await this.kube.getConfigMap(this.keys.namespace, MEMBERS_CONFIG);
    } catch (error) {
      if (!(error instanceof KubeError && error.status === 403)) throw error;
    }
    if (!published) return (await this.kube.listUsers()).items;
    const names: unknown = JSON.parse(published.data?.members ?? '[]');
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string'))
      throw new Error(`${MEMBERS_CONFIG} does not list member names`);
    const users = await Promise.all(names.map((name) => this.kube.getUser(name)));
    return users.filter((user): user is UserResource => user !== undefined);
  }

  // The Kubernetes API proxy.

  private async proxy(request: Request, url: URL, principal: Principal): Promise<Response> {
    // The policy, the Secret redaction and the upstream request all use one canonical path, so
    // an encoded spelling cannot pass the check and then mean something else upstream (#116).
    const path = canonicalPath(url.pathname);
    if (path === undefined || !allowed(request.method, path, this.config.tenant)) {
      this.audit('request.denied', {
        user: principal.user,
        method: request.method,
        path: url.pathname,
        status: 403,
        reason: 'outside tenant',
      });
      return status(
        403,
        'Forbidden',
        `${request.method} ${url.pathname} is outside account ${this.config.tenant}`,
      );
    }
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.arrayBuffer();
    const upstream = await asUser(this.kube, this.userTokens, principal).fetch(
      request.method,
      `${path}${url.search}`,
      { headers: request.headers, body },
    );
    this.audit('request.proxied', {
      user: principal.user,
      via: principal.via,
      method: request.method,
      path,
      status: upstream.status,
    });
    // A Secret DELETE answers with the deleted object, data included (#112): developers may delete
    // Secrets but never read them, so a successful one is reported as a bare Status.
    if (request.method === 'DELETE' && SECRET_PATH.test(path) && upstream.ok) {
      await upstream.body?.cancel();
      return status(upstream.status, 'Success', 'secret deleted; its contents are not returned');
    }
    // The relayed body is re-framed, so its length is the response's own to compute; a coding
    // `fetch` already decoded is gone from the body and must go from the headers too (#71).
    const out = new Headers(upstream.headers);
    for (const name of ['content-length', 'transfer-encoding', 'connection']) out.delete(name);
    const encoding = out.get('content-encoding');
    if (encoding !== null && fetchDecoded(encoding)) out.delete('content-encoding');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
}

if (import.meta.main) {
  const config = configFromEnv();
  const controller = await Controller.start(config);
  const tls =
    config.tlsCert && config.tlsKey
      ? { cert: readFileSync(config.tlsCert, 'utf8'), key: readFileSync(config.tlsKey, 'utf8') }
      : undefined;
  Bun.serve({
    hostname: config.host,
    port: config.port,
    tls,
    // Token refreshes through the identity guest can take longer than Bun's 10 s default.
    idleTimeout: 120,
    fetch: (request, server) => controller.handle(request, server),
  });
  if (config.whoamiPort) await serveWhoamiListener(controller, config, config.whoamiPort, tls);
  // The registry listeners run on `node:http`, not `Bun.serve`, so a streamed blob keeps the
  // registry's `Content-Length` (#197; see `registry-listener.ts`).
  if (config.registryFrontPort)
    await serveRegistryListener({
      hostname: config.host,
      port: config.registryFrontPort,
      tls,
      // Bounded (W2 of the platform#83 review): data flow resets the idle timeout, and bodies
      // beyond the cap are refused here too when they are chunked.
      idleTimeoutSeconds: REGISTRY_IDLE_TIMEOUT_SECONDS,
      maxRequestBodySize: config.registryMaxBodyBytes,
      fetch: (request, server) => controller.handleRegistry(request, server),
    });
  // The tenant hosts' pulls (platform#83 `:host-pull`): TLS unless they pull over plain HTTP.
  if (config.registryPullPort)
    await serveRegistryListener({
      hostname: config.host,
      port: config.registryPullPort,
      tls: config.registryPullTls ? tls : undefined,
      idleTimeoutSeconds: REGISTRY_IDLE_TIMEOUT_SECONDS,
      maxRequestBodySize: REGISTRY_PULL_MAX_BODY_BYTES,
      fetch: (request, server) => controller.handleRegistryPull(request, server),
    });
  controller.audit('controller.started', {
    url: `${tls ? 'https' : 'http'}://${config.host}:${config.port}`,
    issuer: config.issuer,
    cluster: controller.kube.server,
    namespaces: tenantNamespaces(config.tenant),
    whoamiPort: config.whoamiPort,
    registryFrontPort: config.registryFrontPort,
    registryPullPort: config.registryPullPort,
  });
}
