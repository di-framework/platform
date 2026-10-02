/**
 * Platform HTTP gateway (di-framework/kube#2). Runs from a ConfigMap on the stock Node image,
 * so it imports Node built-ins only.
 *
 * `Host: <route-host>.<tenant>.localhost[:port]` reaches only that tenant's `di-http` Service,
 * with `Host: <route-host>`. Every other Host reaches the default host group unchanged.
 */
import {
  Agent,
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';

export type Route =
  | { kind: 'tenant'; tenant: string; host: string }
  | { kind: 'default' }
  | { kind: 'invalid'; reason: string };

export interface Upstream {
  hostname: string;
  port: number;
}

export interface GatewayOptions {
  defaultUpstream: Upstream;
  /** Where a tenant route is sent; only overridden by tests. */
  tenantUpstream?: (tenant: string) => Upstream;
  /** Idle time allowed on an upstream connection before the response completes. */
  upstreamTimeoutMs?: number;
}

/** Same rule as tenant names in the platform CRDs (`validName`). */
const TENANT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const LABEL = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function invalid(reason: string): Route {
  return { kind: 'invalid', reason };
}

/** Pure routing decision from the request Host header. */
export function routeRequest(hostHeader: string | undefined): Route {
  if (!hostHeader) return invalid('missing Host header');
  const value = hostHeader.toLowerCase();
  if (value.startsWith('['))
    return /^\[[0-9a-f:.]+\](:[0-9]{1,5})?$/.test(value)
      ? { kind: 'default' }
      : invalid('malformed Host header');
  const match = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match || Number(match[2] ?? 0) > 65535) return invalid('malformed Host header');
  const name = (match[1] as string).replace(/\.$/, '');
  const labels = name.split('.');
  if (name.length > 253 || !labels.every((label) => label.length <= 63 && LABEL.test(label)))
    return invalid('malformed Host header');
  if (labels.length < 3 || labels[labels.length - 1] !== 'localhost') return { kind: 'default' };
  const tenant = labels[labels.length - 2] as string;
  if (tenant.length > 40 || !TENANT_NAME.test(tenant)) return { kind: 'default' };
  return { kind: 'tenant', tenant, host: labels.slice(0, -2).join('.') };
}

export function tenantUpstream(tenant: string): Upstream {
  return { hostname: `di-http.di-runtime-${tenant}.svc.cluster.local`, port: 80 };
}

/** Drop hop-by-hop headers, including any named by `Connection`. */
export function endToEndHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase()),
  );
  const result: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers))
    if (value !== undefined && !HOP_BY_HOP.has(key) && !named.has(key)) result[key] = value;
  return result;
}

/** Upstream request headers. The forwarding headers are always replaced, never appended to:
 * workloads trust them to tell gateway traffic apart from in-cluster control calls. */
export function upstreamHeaders(
  req: IncomingMessage,
  route: Exclude<Route, { kind: 'invalid' }>,
): OutgoingHttpHeaders {
  const headers = endToEndHeaders(req.headers);
  delete headers.forwarded;
  headers.host = route.kind === 'tenant' ? route.host : req.headers.host;
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
  headers['x-forwarded-host'] = req.headers.host;
  headers['x-forwarded-proto'] = 'http';
  return headers;
}

function respond(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message),
  });
  res.end(message);
}

function rawHead(status: number, message: string, headers: [string, string][]): string {
  return `HTTP/1.1 ${status} ${message}\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;
}

function pairs(raw: string[]): [string, string][] {
  const result: [string, string][] = [];
  for (let i = 0; i < raw.length; i += 2) result.push([raw[i] as string, raw[i + 1] as string]);
  return result;
}

class UpstreamTimeout extends Error {}

/** Resolve the route for a request, or explain why it is rejected. */
function target(
  req: IncomingMessage,
  options: GatewayOptions,
): { route: Exclude<Route, { kind: 'invalid' }>; upstream: Upstream } | { error: string } {
  // Absolute-form targets carry their own authority; only origin-form is routed by Host.
  if (!req.url?.startsWith('/')) return { error: 'malformed request target' };
  const route = routeRequest(req.headers.host);
  if (route.kind === 'invalid') return { error: route.reason };
  const upstream =
    route.kind === 'tenant'
      ? (options.tenantUpstream ?? tenantUpstream)(route.tenant)
      : options.defaultUpstream;
  return { route, upstream };
}

export function createGateway(options: GatewayOptions): Server {
  const timeout = options.upstreamTimeoutMs ?? 60_000;
  const agent = new Agent({ keepAlive: true, maxSockets: 256 });
  const server = createServer((req, res) => {
    const resolved = target(req, options);
    if ('error' in resolved) {
      req.resume();
      respond(res, 400, `Bad Request: ${resolved.error}\n`);
      return;
    }
    const proxy = request({
      agent,
      hostname: resolved.upstream.hostname,
      port: resolved.upstream.port,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, resolved.route),
    });
    proxy.setTimeout(timeout, () => proxy.destroy(new UpstreamTimeout()));
    proxy.on('response', (upstream) => {
      res.writeHead(upstream.statusCode as number, endToEndHeaders(upstream.headers));
      upstream.pipe(res);
      // A truncated upstream body must not look complete to the client.
      upstream.on('error', () => res.destroy());
      upstream.on('close', () => {
        if (!upstream.complete) res.destroy();
      });
    });
    proxy.on('error', (error) => {
      console.error(`${resolved.upstream.hostname}: ${error.message || error.name}`);
      if (res.headersSent) res.destroy();
      else if (error instanceof UpstreamTimeout) respond(res, 504, 'Gateway Timeout\n');
      else respond(res, 502, 'Bad Gateway\n');
    });
    res.on('close', () => {
      if (!res.writableFinished) proxy.destroy();
    });
    req.pipe(proxy);
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const resolved = target(req, options);
    if ('error' in resolved) {
      socket.end(rawHead(400, 'Bad Request', [['connection', 'close']]));
      return;
    }
    const proxy = request({
      hostname: resolved.upstream.hostname,
      port: resolved.upstream.port,
      method: req.method,
      path: req.url,
      headers: {
        ...upstreamHeaders(req, resolved.route),
        connection: 'Upgrade',
        upgrade: req.headers.upgrade,
      },
    });
    proxy.setTimeout(timeout, () => proxy.destroy(new UpstreamTimeout()));
    proxy.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
      proxy.setTimeout(0);
      upstreamSocket.setTimeout(0);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      socket.write(
        rawHead(
          upstream.statusCode as number,
          upstream.statusMessage as string,
          pairs(upstream.rawHeaders),
        ),
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
    });
    // The upstream declined the upgrade: relay its answer and close.
    proxy.on('response', (upstream) => {
      const headers = pairs(upstream.rawHeaders).filter(
        ([key]) => !HOP_BY_HOP.has(key.toLowerCase()),
      );
      socket.write(
        rawHead(upstream.statusCode as number, upstream.statusMessage as string, [
          ...headers,
          ['connection', 'close'],
        ]),
      );
      upstream.pipe(socket);
    });
    proxy.on('error', (error) => {
      console.error(`${resolved.upstream.hostname}: ${error.message || error.name}`);
      socket.end(
        error instanceof UpstreamTimeout
          ? rawHead(504, 'Gateway Timeout', [['connection', 'close']])
          : rawHead(502, 'Bad Gateway', [['connection', 'close']]),
      );
    });
    proxy.end();
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  server.on('close', () => agent.destroy());
  return server;
}

export interface GatewayConfig {
  port?: number;
  defaultUpstream: string;
  upstreamTimeoutMs?: number;
}

export function main(
  env: NodeJS.ProcessEnv = process.env,
  signals: NodeJS.EventEmitter = process,
): Server {
  const cfg = JSON.parse(env.GATEWAY_CONFIG ?? '{}') as Partial<GatewayConfig>;
  if (!cfg.defaultUpstream) throw new Error('Missing GATEWAY_CONFIG');
  const server = createGateway({
    defaultUpstream: { hostname: cfg.defaultUpstream, port: 80 },
    upstreamTimeoutMs: cfg.upstreamTimeoutMs,
  });
  server.listen(cfg.port ?? 8080);
  signals.once('SIGTERM', () => server.close());
  return server;
}

if (require.main === module) main();
