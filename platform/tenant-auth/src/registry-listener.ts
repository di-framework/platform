/**
 * HTTP(S) listener for the registry front and the hosts' pull listener (platform#83), built on
 * `node:http` rather than `Bun.serve`.
 *
 * `Bun.serve` re-frames every streamed response body as `Transfer-Encoding: chunked` and drops the
 * `Content-Length` the handler set, so a blob GET relayed from the registry reached clients without
 * its length (platform#197). oras then opens a second connection for a HEAD while the body is
 * still unread, which stalls behind it over `kubectl port-forward`. `node:http` writes the headers
 * the handler returns as they are, so the registry's `Content-Length` reaches the client and the
 * body is streamed against it, never buffered.
 *
 * It keeps what the registry listeners relied on from `Bun.serve`: an idle timeout that any data
 * flow resets, a request body cap that also applies to chunked bodies (413), the client address,
 * and a request signal that aborts when the client goes away.
 *
 * The whoami listener uses it too (platform#113): over TLS, and for callers still configured with
 * an `http://` URL during an upgrade, over plain HTTP on the same port (`acceptPlainHttp`). The
 * relay that serves both passes the client's own address on to the handler, so the option is safe
 * on any listener that reads it.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { problem } from '@di-framework/tenant-cli/src/api/handlers.ts';

/** The `server` argument the registry handlers take, as `Bun.serve` passes it. */
export interface ClientAddress {
  requestIP(request: Request): { address: string } | null;
}

export interface RegistryListenerOptions {
  hostname: string;
  /** TCP port; 0 picks a free one (see {@link RegistryListener.port}). */
  port: number;
  /** PEM certificate and key; plain HTTP without them. */
  tls?: { cert: string; key: string };
  /**
   * With `tls`, also answer plain-HTTP clients on the same port: a connection whose first byte
   * opens a TLS handshake is served over TLS, any other over plain HTTP. Each protocol is served
   * by its own listener on loopback; the handler still sees the client's own address, not the
   * loopback hop's. Without `tls` it changes nothing.
   */
  acceptPlainHttp?: boolean;
  /**
   * Most client connections held open at once; further ones are closed as they arrive. Unset: no
   * limit. With `acceptPlainHttp`, each one holds three sockets (client, relay hop, and the inner
   * listener's end of it), so this bounds three times as many descriptors.
   */
  maxConnections?: number;
  /** A socket with no data flow for this long is closed. */
  idleTimeoutSeconds: number;
  /** Largest request body accepted, declared or chunked; larger ones are answered 413. */
  maxRequestBodySize: number;
  fetch: (request: Request, server: ClientAddress) => Response | Promise<Response>;
}

export interface RegistryListener {
  readonly port: number;
  /** Stops accepting connections and closes the open ones. */
  stop(): Promise<void>;
}

/** Statuses whose responses never carry a body. */
const NO_BODY = new Set([204, 205, 304]);

export async function serveRegistryListener(
  options: RegistryListenerOptions,
): Promise<RegistryListener> {
  if (options.tls && options.acceptPlainHttp) return serveTlsAndPlain(options, options.tls);
  return serveSingle(options);
}

/** The first byte of a TLS connection: a handshake record (content type 22). */
const TLS_HANDSHAKE = 0x16;

/**
 * TLS and plain HTTP on one port (`acceptPlainHttp`): each connection is relayed, by its first
 * byte, to a loopback listener for its protocol. The idle timeout applies to the client socket as
 * well as to the inner listeners.
 *
 * A client may half-close once its request is sent (`allowHalfOpen`): its end is passed on to the
 * inner listener and the response still comes back. The relay hop's local port names the client
 * it carries, so the inner listeners hand the handler the client's address rather than loopback.
 */
async function serveTlsAndPlain(
  options: RegistryListenerOptions,
  tls: { cert: string; key: string },
): Promise<RegistryListener> {
  // The client address behind each relay hop, by the hop's local port.
  const clients = new Map<number, string>();
  const addressOf = (socket: Socket) =>
    socket.remotePort === undefined ? undefined : clients.get(socket.remotePort);
  const inner = {
    ...options,
    hostname: '127.0.0.1',
    port: 0,
    acceptPlainHttp: false,
    maxConnections: undefined,
  };
  // Loopback on a free port each: these do not fail where the public port could.
  const secure = await serveSingle({ ...inner, tls }, addressOf);
  const plain = await serveSingle({ ...inner, tls: undefined }, addressOf);
  const stopInner = () => Promise.all([secure.stop(), plain.stop()]).then(() => {});
  const sockets = new Set<Socket>();
  const server = createNetServer({ allowHalfOpen: true }, (client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    client.setTimeout(options.idleTimeoutSeconds * 1000, () => client.destroy());
    // A client that ends before sending anything has nothing to relay.
    const ended = () => client.destroy();
    client.once('end', ended);
    client.once('data', (first: Buffer) => {
      client.off('end', ended);
      client.pause();
      const target = first[0] === TLS_HANDSHAKE ? secure.port : plain.port;
      const upstream = connect(target, '127.0.0.1');
      sockets.add(upstream);
      let hop: number | undefined;
      upstream.once('close', () => {
        sockets.delete(upstream);
        if (hop !== undefined) clients.delete(hop);
        // After a complete response the pipe has ended the client, which then closes once that
        // is flushed; otherwise the inner side failed and nothing more will come.
        if (!client.writableEnded) client.destroy();
      });
      upstream.on('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        hop = upstream.localPort;
        if (hop !== undefined && client.remoteAddress) clients.set(hop, client.remoteAddress);
        upstream.write(first);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    });
  });
  if (options.maxConnections !== undefined) server.maxConnections = options.maxConnections;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.hostname, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch(async (error) => {
    await stopInner();
    throw error;
  });
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : options.port,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      await stopInner();
    },
  };
}

/**
 * One `node:http(s)` server. `addressOf`, set for the relay's inner listeners, names the client
 * behind a connection; without it the connection's own peer address is the client's.
 */
async function serveSingle(
  options: RegistryListenerOptions,
  addressOf?: (socket: Socket) => string | undefined,
): Promise<RegistryListener> {
  const addresses = new WeakMap<Request, string>();
  const client: ClientAddress = {
    requestIP: (request) => {
      const address = addresses.get(request);
      return address ? { address } : null;
    },
  };
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    // Anything unexpected still gets an answer when none has started; otherwise the connection ends.
    const address = addressOf ? addressOf(req.socket) : req.socket.remoteAddress;
    serveOne(req, res, options, client, addresses, address).catch(() =>
      res.headersSent ? res.destroy() : res.writeHead(500, { connection: 'close' }).end(),
    );
  };
  const server: Server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handle)
    : createHttpServer(handle);
  // Uploads may take long; only idleness ends them (the handler has its own stall timeout).
  server.requestTimeout = 0;
  server.setTimeout(options.idleTimeoutSeconds * 1000, (socket) => socket.destroy());
  if (options.maxConnections !== undefined) server.maxConnections = options.maxConnections;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : options.port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function serveOne(
  req: IncomingMessage,
  res: ServerResponse,
  options: RegistryListenerOptions,
  client: ClientAddress,
  addresses: WeakMap<Request, string>,
  address: string | undefined,
): Promise<void> {
  const method = req.method ?? 'GET';
  const declared = req.headers['content-length'];
  const size = Number(declared);
  if (declared !== undefined && (Number.isNaN(size) || size > options.maxRequestBodySize)) {
    req.resume();
    return send(req, res, tooLarge(options.maxRequestBodySize), true);
  }
  const url = requestUrl(req, options);
  if (!url) {
    req.resume();
    return send(req, res, badRequest(), true);
  }
  // Ends the handler's request when the client goes away before the response is complete.
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });
  const upload =
    method === 'GET' || method === 'HEAD' ? null : requestBody(req, options.maxRequestBodySize);
  if (upload === null) req.resume();
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
    headers.append(req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string);
  const request = new Request(url, {
    method,
    headers,
    body: upload?.stream ?? null,
    signal: gone.signal,
    duplex: 'half',
  } as RequestInit);
  if (address) addresses.set(request, address);
  let response: Response;
  try {
    response = await options.fetch(request, client);
  } catch {
    response = problem(500, 'Internal Server Error', 'the request could not be handled');
  }
  if (upload?.state.overflowed) {
    await response.body?.cancel().catch(() => {});
    return send(req, res, tooLarge(options.maxRequestBodySize), true);
  }
  // A body the handler left unread is dropped, and the connection closed after the response.
  return send(req, res, response, upload?.state.dropped ?? false);
}

/**
 * The URL the handler sees: the request target resolved against this listener's own origin, never
 * against the client's `Host` header (which stays in the headers), so `Host` cannot rewrite the
 * path. An absolute-form target is accepted only for the host the request names in `Host`; any
 * other target, or one that does not parse, is undefined (answered 400).
 */
export function requestUrl(
  req: Pick<IncomingMessage, 'url' | 'headers'>,
  options: Pick<RegistryListenerOptions, 'hostname' | 'tls'>,
): URL | undefined {
  const scheme = options.tls ? 'https' : 'http';
  const host = options.hostname.includes(':') ? `[${options.hostname}]` : options.hostname;
  const origin = `${scheme}://${host}`;
  let target = req.url ?? '';
  // A request target has no fragment; one with `#` would reach the handler cut short.
  if (target.includes('#')) return undefined;
  if (!target.startsWith('/')) {
    const absolute = URL.parse(target);
    const named = req.headers.host?.toLowerCase();
    if (
      !absolute ||
      !['http:', 'https:'].includes(absolute.protocol) ||
      absolute.username !== '' ||
      absolute.password !== '' ||
      absolute.host.toLowerCase() !== named
    )
      return undefined;
    target = `${absolute.pathname}${absolute.search}`;
  }
  const url = URL.parse(`${origin}${target}`);
  return url && url.origin === URL.parse(origin)?.origin ? url : undefined;
}

function badRequest(): Response {
  return problem(400, 'Bad Request', 'the request target is not valid');
}

function tooLarge(max: number): Response {
  return problem(413, 'Content Too Large', `request bodies are limited to ${max} bytes`);
}

/**
 * The request body as a stream. Reading pauses the socket until the handler wants more, so a slow
 * upstream slows the client. Past `max` bytes the stream errors (`overflowed`); once the handler
 * cancels it or it overflows, the rest is read and dropped (`dropped`) rather than the socket
 * destroyed, so the answer still reaches a client that is still sending.
 */
function requestBody(
  req: IncomingMessage,
  max: number,
): { stream: ReadableStream<Uint8Array>; state: { overflowed: boolean; dropped: boolean } } {
  const state = { overflowed: false, dropped: false };
  let received = 0;
  const chunks = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const drop = () => {
    state.dropped = true;
    req.on('data', () => {});
    req.resume();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: IteratorResult<Buffer>;
      try {
        next = await chunks.next();
      } catch (error) {
        return controller.error(error);
      }
      if (next.done) return controller.close();
      received += next.value.length;
      if (received > max) {
        state.overflowed = true;
        drop();
        return controller.error(new Error('request body too large'));
      }
      controller.enqueue(
        new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.length),
      );
    },
    cancel() {
      drop();
    },
  });
  return { stream, state };
}

/**
 * Writes `response` as the handler built it: its status and headers (`Content-Length` included)
 * unchanged, its body streamed with backpressure. A body that fails mid-way destroys the
 * connection, so a client never takes a truncated body for a complete one.
 */
async function send(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
  close: boolean,
): Promise<void> {
  const headers: OutgoingHttpHeaders = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (close) headers.connection = 'close';
  try {
    res.writeHead(response.status, headers);
  } catch {
    // A header value `Headers` allows but node refuses: cancelling the body lets the handler
    // release what it holds for it (the registry pool slot) before the connection goes.
    await response.body?.cancel().catch(() => {});
    res.destroy();
    return;
  }
  if (!response.body || req.method === 'HEAD' || NO_BODY.has(response.status)) {
    await response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const closed = new Promise<void>((resolve) => {
    res.once('close', () => {
      if (!res.writableFinished) reader.cancel().catch(() => {});
      resolve();
    });
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) return;
      if (!res.write(value))
        await Promise.race([new Promise<void>((resolve) => res.once('drain', resolve)), closed]);
    }
    res.end();
  } catch {
    res.destroy();
  }
}
