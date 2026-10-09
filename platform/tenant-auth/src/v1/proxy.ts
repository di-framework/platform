/**
 * The service HTTP proxy behind `POST /v1/services/:service/proxy`: short-lived sessions kept in
 * controller memory, and the passthrough the controller serves at the session URL. The session
 * URL is not a contract operation. HTTP only; WebSocket and SPDY need a contract extension.
 */
import { randomBytes } from 'node:crypto';
import { problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { MAX_BODY_BYTES } from '@di-framework/tenant-cli/src/api/routes.ts';
import type { Principal } from '../identity.ts';
import { permits } from './policy.ts';

export const SERVICE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const SESSION_TTL_MS = 15 * 60_000;
/** Live sessions one user may hold; issuing another evicts that user's oldest. */
export const MAX_SESSIONS_PER_USER = 16;
/** Live sessions the controller holds in total; past this, issuing is refused. */
export const MAX_SESSIONS = 10_000;
/** Expired sessions are swept on insert at most this often, or whenever the store is full. */
const SWEEP_INTERVAL_MS = 60_000;
/**
 * The tenant gateway's upstream idle timeout (`platform/src/gateway/gateway.ts`): the longest
 * the service may stay silent, waiting for its headers or between body chunks.
 */
export const PROXY_TIMEOUT_MS = 60_000;
/** The session URL: `/v1/services/<service>/proxy/<session>[/<path>]`. */
export const PASSTHROUGH = /^\/v1\/services\/([^/]+)\/proxy\/([A-Za-z0-9_-]{43})(\/.*)?$/;

export interface ProxySession {
  id: string;
  tenant: string;
  user: string;
  service: string;
  env: string;
  expiresAt: number;
}

/**
 * Sessions live in controller memory, so the controller must run as a single replica
 * (platform#58) until they move to shared storage.
 */
export class ProxySessions {
  private readonly sessions = new Map<string, ProxySession>();
  /** Each user's session ids, oldest first. */
  private readonly byUser = new Map<string, Set<string>>();
  private nextSweep = 0;

  constructor(
    private readonly maxPerUser = MAX_SESSIONS_PER_USER,
    private readonly maxTotal = MAX_SESSIONS,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  /** A new session, or undefined when the controller already holds `maxTotal` live ones. */
  issue(
    binding: Omit<ProxySession, 'id' | 'expiresAt'>,
    ttlMs = SESSION_TTL_MS,
  ): ProxySession | undefined {
    const now = Date.now();
    if (now >= this.nextSweep || this.sessions.size >= this.maxTotal) {
      this.nextSweep = now + SWEEP_INTERVAL_MS;
      for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.drop(id);
    }
    const own = this.byUser.get(binding.user) ?? new Set<string>();
    while (own.size >= this.maxPerUser) this.drop(own.values().next().value as string);
    if (this.sessions.size >= this.maxTotal) return undefined;
    const session = {
      ...binding,
      id: randomBytes(32).toString('base64url'),
      expiresAt: now + ttlMs,
    };
    this.sessions.set(session.id, session);
    own.add(session.id);
    this.byUser.set(binding.user, own);
    return session;
  }

  /** The live session with this id, if any; an expired one is dropped. */
  get(id: string): ProxySession | undefined {
    const session = this.sessions.get(id);
    if (session && session.expiresAt <= Date.now()) {
      this.drop(id);
      return undefined;
    }
    return session;
  }

  private drop(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    const own = this.byUser.get(session.user) as Set<string>;
    own.delete(id);
    if (own.size === 0) this.byUser.delete(session.user);
  }
}

export const proxySessions = new ProxySessions();

/**
 * The tenant's HTTP upstream, as in `tenantUpstream` of `platform/src/gateway/gateway.ts`.
 * The controller needs NetworkPolicy egress to the hostgroup pods' port 9191 (platform#58).
 */
export const tenantUpstream = (tenant: string) =>
  `http://di-http.di-runtime-${tenant}.svc.cluster.local:80`;

/**
 * Caller headers never forwarded to a service: credentials, identity, workload control,
 * forwarding (replaced below) and hop-by-hop. `impersonate-*` is dropped by prefix.
 */
const STRIPPED_REQUEST = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'connection',
  'proxy-connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'content-length',
  'transfer-encoding',
  'forwarded',
  'via',
  'x-real-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-prefix',
  'x-forwarded-server',
  'x-forwarded-by',
  'x-di-control-token',
]);
const STRIPPED_REQUEST_PREFIX = 'impersonate-';
/** A service may not set cookies on the controller's origin. */
const STRIPPED_RESPONSE = new Set([
  'set-cookie',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
]);

/**
 * The headers sent to the service. Like the tenant gateway, the forwarding headers are always
 * replaced, never appended to: workloads with `DI_CONTROL_REJECT_FORWARDED=1` refuse their
 * `/_di/*` and `/_actors/*` control paths to any request carrying them, so proxied traffic must
 * always read as external.
 */
export function upstreamRequestHeaders(
  request: Request,
  url: URL,
  host: string,
  clientAddress?: string,
): Headers {
  const named = new Set(
    (request.headers.get('connection') ?? '').split(',').map((token) => token.trim().toLowerCase()),
  );
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (STRIPPED_REQUEST.has(name) || named.has(name) || name.startsWith(STRIPPED_REQUEST_PREFIX))
      return;
    headers.set(name, value);
  });
  headers.set('host', host);
  headers.set('x-forwarded-for', clientAddress || 'unknown');
  headers.set('x-forwarded-host', request.headers.get('host') || url.host);
  headers.set('x-forwarded-proto', url.protocol.slice(0, -1));
  return headers;
}

/** The response headers sent back: service content is contained on the controller's origin. */
function responseHeaders(upstream: Response, prefix: string): Headers {
  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!STRIPPED_RESPONSE.has(name)) out.append(name, value);
  });
  // A relative redirect stays under the session URL rather than escaping to the controller root.
  const location = out.get('location');
  if (location?.startsWith('/') && !location.startsWith('//'))
    out.set('location', `${prefix}${location}`);
  out.set('x-content-type-options', 'nosniff');
  out.set('content-security-policy', 'sandbox');
  return out;
}

async function readCapped(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export interface PassthroughOptions {
  tenant: string;
  principal: Principal;
  upstream: string;
  audit(event: string, fields?: Record<string, unknown>): void;
  sessions?: ProxySessions;
  /** The idle timeout: how long the service may stay silent. */
  timeoutMs?: number;
  /** The caller's address, sent as `X-Forwarded-For`. */
  clientAddress?: string;
}

/** Forwards one request on a session URL to the session's service and streams the answer back. */
export async function servePassthrough(
  request: Request,
  url: URL,
  match: RegExpExecArray,
  options: PassthroughOptions,
): Promise<Response> {
  const { principal, tenant } = options;
  const [, service, id, path = '/'] = match as unknown as [string, string, string, string?];
  const deny = (status: number, title: string, detail: string) => {
    options.audit('request.denied', { user: principal.user, path: url.pathname, status, detail });
    return problem(status, title, detail);
  };
  if (!permits('proxy', principal.role))
    return deny(403, 'Forbidden', `a ${principal.role} may not use a proxy session`);
  const session = (options.sessions ?? proxySessions).get(id);
  if (!session || session.service !== service || session.tenant !== tenant)
    return deny(404, 'Not Found', 'no such proxy session, or it expired');
  if (session.user !== principal.user)
    return deny(403, 'Forbidden', 'the proxy session belongs to another user');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES)
    return problem(413, 'Content Too Large', `the request body exceeds ${MAX_BODY_BYTES} bytes`);
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await readCapped(request);
  if (body === undefined && request.method !== 'GET' && request.method !== 'HEAD')
    return problem(413, 'Content Too Large', `the request body exceeds ${MAX_BODY_BYTES} bytes`);
  const headers = upstreamRequestHeaders(
    request,
    url,
    `${service}-${session.env}`,
    options.clientAddress,
  );
  // An idle timeout, as the gateway has: re-armed on every body chunk, so long downloads and
  // streamed responses keep going while the service keeps sending.
  const idle = new AbortController();
  const idleMs = options.timeoutMs ?? PROXY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleMs);
  };
  const disarm = () => clearTimeout(timer);
  let upstream: Response;
  arm();
  try {
    upstream = await fetch(`${options.upstream}${path}${url.search}`, {
      method: request.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: 'manual',
      // Pass encoded bytes through with their Content-Encoding intact.
      decompress: false,
      signal: idle.signal,
    });
  } catch (error) {
    disarm();
    options.audit('request.failed', {
      user: principal.user,
      service,
      path: url.pathname,
      reason: String(error),
    });
    return idle.signal.aborted
      ? problem(504, 'Gateway Timeout', 'the service did not answer in time')
      : problem(502, 'Bad Gateway', 'the service could not be reached');
  }
  options.audit('proxy.forwarded', {
    user: principal.user,
    service,
    env: session.env,
    method: request.method,
    path,
    status: upstream.status,
  });
  const out = responseHeaders(upstream, `/v1/services/${service}/proxy/${id}`);
  arm();
  const stream = upstream.body
    ? upstream.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            arm();
            controller.enqueue(chunk);
          },
          flush: disarm,
        }),
      )
    : null;
  if (!stream) disarm();
  return new Response(stream, { status: upstream.status, headers: out });
}
