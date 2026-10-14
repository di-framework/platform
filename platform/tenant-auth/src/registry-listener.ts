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
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
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
  const addresses = new WeakMap<Request, string>();
  const client: ClientAddress = {
    requestIP: (request) => {
      const address = addresses.get(request);
      return address ? { address } : null;
    },
  };
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    serveOne(req, res, options, client, addresses).catch(() => res.destroy());
  };
  const server: Server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handle)
    : createHttpServer(handle);
  // Uploads may take long; only idleness ends them (the handler has its own stall timeout).
  server.requestTimeout = 0;
  server.setTimeout(options.idleTimeoutSeconds * 1000, (socket) => socket.destroy());
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
): Promise<void> {
  const method = req.method ?? 'GET';
  const declared = req.headers['content-length'];
  if (declared !== undefined && !(Number(declared) <= options.maxRequestBodySize)) {
    req.resume();
    return send(req, res, tooLarge(options.maxRequestBodySize), true);
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
  const scheme = options.tls ? 'https' : 'http';
  const authority = req.headers.host ?? `${options.hostname}:${options.port}`;
  const request = new Request(`${scheme}://${authority}${req.url ?? '/'}`, {
    method,
    headers,
    body: upload?.stream ?? null,
    signal: gone.signal,
    duplex: 'half',
  } as RequestInit);
  if (req.socket.remoteAddress) addresses.set(request, req.socket.remoteAddress);
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
  res.writeHead(response.status, headers);
  if (!response.body || req.method === 'HEAD' || NO_BODY.has(response.status)) {
    await response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const closed = new Promise<void>((resolve) => res.once('close', resolve));
  closed.then(() => {
    if (!res.writableFinished) reader.cancel().catch(() => {});
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
