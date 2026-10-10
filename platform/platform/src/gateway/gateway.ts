/**
 * Platform HTTP gateway (di-framework/kube#2). Runs from a ConfigMap on the stock Node image,
 * so it imports Node built-ins only.
 *
 * `Host: <route-host>.<tenant>.localhost[:port]` reaches only that tenant's `di-http` Service,
 * with `Host: <route-host>`. Every other Host reaches the default host group unchanged.
 *
 * With tenant-auth routes configured (#58), `<console>.<tenant>.localhost` reaches that tenant's
 * `tenant-console` over HTTP, and a TLS connection whose SNI is `<controller>.<tenant>.localhost`
 * is passed through, unterminated, to `tenant-controller`, which serves its own certificate.
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
import {
  connect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import type { Duplex } from 'node:stream';

export type Route =
  | { kind: 'tenant'; tenant: string; host: string }
  | { kind: 'console'; tenant: string }
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
  /** Route-host labels for each tenant's console and controller; absent, neither is routed. */
  tenantAuthRoutes?: { console?: string; controller?: string };
  /** Where a console route is sent; only overridden by tests. */
  consoleUpstream?: (tenant: string) => Upstream;
  /** Where a controller TLS connection is sent; only overridden by tests. */
  controllerUpstream?: (tenant: string) => Upstream;
  /** Edge only: time a new connection has to send enough bytes to be classified (default 10 s). */
  classifyTimeoutMs?: number;
  /** Edge only: idle time allowed on a controller passthrough pipe (default 5 min). */
  passthroughIdleMs?: number;
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

export function consoleUpstream(tenant: string): Upstream {
  return { hostname: `tenant-console.di-runtime-${tenant}.svc.cluster.local`, port: 8787 };
}

export function controllerUpstream(tenant: string): Upstream {
  return { hostname: `tenant-controller.di-runtime-${tenant}.svc.cluster.local`, port: 8788 };
}

/** Largest TLS plaintext record: a 5-byte header and at most 16 KiB of body (RFC 8446 5.1). */
const MAX_RECORD = 5 + 16_384;

class Malformed extends Error {}

function check(ok: boolean): void {
  if (!ok) throw new Malformed();
}

/**
 * The SNI host name of a TLS ClientHello, if the first record holds the whole hello and it
 * carries a `host_name` entry. Every length is bounded by the record, handshake, extensions and
 * extension that contain it; anything that overruns returns `undefined` rather than clamping.
 * A ClientHello split across several TLS records is not reassembled: it returns `undefined`, so
 * the edge closes that connection (clients send the hello in one record in practice).
 */
export function serverName(record: Buffer): string | undefined {
  try {
    check(record.length >= 9 && record[0] === 0x16 && record[5] === 0x01); // ClientHello
    const recordEnd = 5 + record.readUInt16BE(3);
    const end = 9 + record.readUIntBE(6, 3);
    check(recordEnd <= MAX_RECORD && recordEnd <= record.length && end <= recordEnd);
    let at = 9;
    const skip = (size: number) => {
      at += size;
      check(at <= end);
    };
    const read = (size: 1 | 2) => {
      skip(size);
      return record.readUIntBE(at - size, size);
    };
    skip(2 + 32); // version, random
    skip(read(1)); // session id
    skip(read(2)); // cipher suites
    skip(read(1)); // compression methods
    const extensionsEnd = read(2) + at;
    check(extensionsEnd <= end);
    while (at < extensionsEnd) {
      const type = read(2);
      const extensionEnd = read(2) + at;
      check(extensionEnd <= extensionsEnd);
      if (type === 0) {
        // server_name: list length (2), name type (1, 0 = host_name), name length (2), name
        const listEnd = read(2) + at;
        check(listEnd <= extensionEnd && read(1) === 0);
        const nameEnd = read(2) + at;
        check(nameEnd <= listEnd);
        return record.toString('ascii', at, nameEnd);
      }
      at = extensionEnd;
    }
  } catch {
    /* truncated or malformed */
  }
  return undefined;
}

/** Bytes needed before the first TLS record is complete. */
function recordLength(buffer: Buffer): number {
  return buffer.length < 5 ? 5 : 5 + buffer.readUInt16BE(3);
}

/** Pipe a TLS connection for `<controller>.<tenant>.localhost` to that tenant's controller. */
function passThrough(socket: Socket, hello: Buffer, options: GatewayOptions): void {
  const route = routeRequest(serverName(hello));
  if (route.kind !== 'tenant' || route.host !== options.tenantAuthRoutes?.controller) {
    socket.destroy();
    return;
  }
  const target = (options.controllerUpstream ?? controllerUpstream)(route.tenant);
  const upstream = connect(target.port, target.hostname);
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  const idle = options.passthroughIdleMs ?? 300_000;
  socket.setTimeout(idle, close);
  upstream.setTimeout(idle, close);
  upstream.on('error', (error) => {
    console.error(`${target.hostname}: ${error.message || error.name}`);
    close();
  });
  socket.on('close', close);
  upstream.on('close', close);
  upstream.write(hello);
  socket.pipe(upstream).pipe(socket);
  socket.resume();
}

/**
 * The gateway's listener when the controller is routed: it peeks at each connection, passes a
 * TLS handshake (first byte 0x16) through by SNI, and hands anything else to the HTTP `server`.
 * A connection must be classified within `classifyTimeoutMs` (slowloris), and at most one
 * maximum-size TLS record (plus the read that completes it) is buffered; a record header that
 * claims more is closed at once. The timeout is cleared before the handoff, so the HTTP server's
 * own timeouts, or the passthrough idle timeout, take over.
 */
export function createEdge(server: Server, options: GatewayOptions): NetServer {
  return createNetServer((socket) => {
    socket.on('error', () => socket.destroy());
    const stalled = () => socket.destroy();
    socket.setTimeout(options.classifyTimeoutMs ?? 10_000, stalled);
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const needed = buffer[0] === 0x16 ? recordLength(buffer) : 0;
      if (needed > MAX_RECORD) {
        socket.destroy();
        return;
      }
      if (buffer.length < needed) return;
      socket.off('data', onData);
      socket.pause();
      socket.setTimeout(0);
      socket.off('timeout', stalled);
      if (needed) {
        passThrough(socket, buffer, options);
        return;
      }
      socket.unshift(buffer);
      server.emit('connection', socket);
      socket.resume();
    };
    socket.on('data', onData);
  });
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
  if (route.kind === 'tenant' && options.tenantAuthRoutes?.controller === route.host)
    return { error: 'the controller host is served over TLS only' };
  if (route.kind === 'tenant' && options.tenantAuthRoutes?.console === route.host)
    // The console builds its links from its public URL, so it keeps the original Host.
    return {
      route: { kind: 'console', tenant: route.tenant },
      upstream: (options.consoleUpstream ?? consoleUpstream)(route.tenant),
    };
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
  tenantAuthRoutes?: { console?: string; controller?: string };
}

export function main(
  env: NodeJS.ProcessEnv = process.env,
  signals: NodeJS.EventEmitter = process,
): Server {
  const cfg = JSON.parse(env.GATEWAY_CONFIG ?? '{}') as Partial<GatewayConfig>;
  if (!cfg.defaultUpstream) throw new Error('Missing GATEWAY_CONFIG');
  const options: GatewayOptions = {
    defaultUpstream: { hostname: cfg.defaultUpstream, port: 80 },
    upstreamTimeoutMs: cfg.upstreamTimeoutMs,
    tenantAuthRoutes: cfg.tenantAuthRoutes,
  };
  const server = createGateway(options);
  // TLS passthrough needs the raw connection, so a routed controller puts the edge in front.
  const listener = cfg.tenantAuthRoutes?.controller ? createEdge(server, options) : server;
  listener.listen(cfg.port ?? 8080);
  signals.once('SIGTERM', () => {
    listener.close();
    if (listener !== server) server.close();
  });
  return server;
}

if (require.main === module) main();
