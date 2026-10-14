import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { selfSignedCertificate } from '../../platform/src/tenancy/tls.ts';
import {
  Controller,
  configFromEnv,
  REGISTRY_IDLE_TIMEOUT_SECONDS,
  REGISTRY_PULL_MAX_BODY_BYTES,
} from '../src/controller.ts';
import {
  type RegistryListener,
  requestUrl,
  serveRegistryListener,
} from '../src/registry-listener.ts';

/**
 * The registry front and the hosts' pull listener as they run (#197): `Controller` handlers behind
 * `serveRegistryListener`, in front of an upstream that frames responses the way the registry
 * component's host does (an explicit `Content-Length` and a body written in pieces).
 */
describe('registry listener keeps the registry Content-Length (#197)', () => {
  const BLOB = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
  const DIGEST = `sha256:${createHash('sha256').update(BLOB).digest('hex')}`;
  const BLOB_PATH = `/v2/acme/app/blobs/${DIGEST}`;
  /** Last request the upstream saw, and whether it was aborted before its response finished. */
  const seen: { headers?: IncomingHttpHeaders; url?: string; aborted?: boolean } = {};
  const seenUrl = () => seen.url;
  const upstream: Server = createServer(async (req, res) => {
    // One connection per request: Bun's `node:http` server, reused by `fetch`'s pool after a
    // streamed response, now and then never ends the next chunked request body.
    res.shouldKeepAlive = false;
    seen.headers = req.headers;
    seen.url = req.url;
    seen.aborted = false;
    res.on('close', () => {
      if (!res.writableFinished) seen.aborted = true;
    });
    if (req.url === BLOB_PATH && req.method === 'HEAD') {
      // The registry's HEAD: the size in the side header, an empty body.
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'docker-content-digest': DIGEST,
        'docker-content-length': String(BLOB.length),
      });
      return res.end();
    }
    if (req.url === BLOB_PATH) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'docker-content-digest': DIGEST,
        'content-length': String(BLOB.length),
      });
      for (let at = 0; at < BLOB.length; at += 64 * 1024) {
        if (res.destroyed) return;
        res.write(BLOB.subarray(at, at + 64 * 1024));
        await Bun.sleep(2);
      }
      return res.end();
    }
    if (req.url === '/v2/acme/app/blobs/sha256:endless') {
      res.writeHead(200, { 'content-length': '100000000' });
      const tick = setInterval(() => res.write(new Uint8Array(1024)), 5);
      res.on('close', () => clearInterval(tick));
      return;
    }
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
    });
    req.on('end', () => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received }));
    });
  });

  const MAX_BODY = 64 * 1024;
  const controller = new Controller(
    configFromEnv({
      TENANT_CONTROLLER_TENANT: 'acme',
      TENANT_CONTROLLER_REGISTRY_FRONT_PORT: '8790',
      TENANT_CONTROLLER_REGISTRY_HOST: 'registry',
      TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES: String(MAX_BODY),
    }),
    {} as never,
    { issuer: 'https://issuer.test' } as never,
    {} as never,
    {} as never,
  );
  const tls = selfSignedCertificate('tenant-controller', ['localhost'], ['127.0.0.1'], 1);
  let front: RegistryListener;
  let pull: RegistryListener;
  let log: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    log = spyOn(console, 'log').mockImplementation(() => {});
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const { port } = upstream.address() as { port: number };
    controller.proxyUpstream = () => `http://127.0.0.1:${port}`;
    front = await serveRegistryListener({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert: tls.cert, key: tls.key },
      idleTimeoutSeconds: REGISTRY_IDLE_TIMEOUT_SECONDS,
      maxRequestBodySize: MAX_BODY,
      fetch: (request, server) => controller.handleRegistry(request, server),
    });
    pull = await serveRegistryListener({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeoutSeconds: REGISTRY_IDLE_TIMEOUT_SECONDS,
      maxRequestBodySize: REGISTRY_PULL_MAX_BODY_BYTES,
      fetch: (request, server) => controller.handleRegistryPull(request, server),
    });
  });
  afterAll(async () => {
    await front.stop();
    await pull.stop();
    upstream.closeAllConnections();
    upstream.close();
    log.mockRestore();
  });

  interface Raw {
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }
  /** One request over the wire, so the response framing headers are the ones actually sent. */
  const send = (
    listener: 'front' | 'pull',
    method: string,
    path: string,
    body?: { chunks: Uint8Array[]; length?: number },
  ) =>
    new Promise<Raw>((resolve, reject) => {
      const options = {
        host: '127.0.0.1',
        port: listener === 'front' ? front.port : pull.port,
        method,
        path,
        headers: {
          authorization: 'Basic eDpvaw==',
          ...(body?.length !== undefined ? { 'content-length': String(body.length) } : {}),
        },
        rejectUnauthorized: false,
        agent: false,
      };
      const done = (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      };
      const req = listener === 'front' ? httpsRequest(options, done) : httpRequest(options, done);
      req.on('error', reject);
      for (const chunk of body?.chunks ?? []) req.write(chunk);
      req.end();
    });

  test('a blob GET through the registry front carries Content-Length and is not chunked', async () => {
    const response = await send('front', 'GET', BLOB_PATH);
    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe(String(BLOB.length));
    expect(response.headers['transfer-encoding']).toBeUndefined();
    expect(response.headers['docker-content-digest']).toBe(DIGEST);
    expect(response.body).toHaveLength(BLOB.length);
    expect(`sha256:${createHash('sha256').update(response.body).digest('hex')}`).toBe(DIGEST);
  });

  test('a blob HEAD through the registry front carries Content-Length and no side header', async () => {
    const response = await send('front', 'HEAD', BLOB_PATH);
    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe(String(BLOB.length));
    expect(response.headers['docker-content-length']).toBeUndefined();
    expect(response.headers['transfer-encoding']).toBeUndefined();
    expect(response.body).toHaveLength(0);
  });

  test('the hosts pull listener keeps Content-Length on GET and HEAD too', async () => {
    const get = await send('pull', 'GET', BLOB_PATH);
    expect(get.headers['content-length']).toBe(String(BLOB.length));
    expect(get.headers['transfer-encoding']).toBeUndefined();
    expect(get.body).toHaveLength(BLOB.length);
    const head = await send('pull', 'HEAD', BLOB_PATH);
    expect(head.headers['content-length']).toBe(String(BLOB.length));
    expect(head.body).toHaveLength(0);
  });

  test('passes the client address and the request through to the handler', async () => {
    await send('front', 'GET', BLOB_PATH);
    expect(seen.headers?.['x-forwarded-for']).toBe('127.0.0.1');
    expect(seen.headers?.host).toBe('registry');
    expect(seen.headers?.authorization).toBe('Basic eDpvaw==');
  });

  /** A raw request head on the pull listener; resolves with the status line and the response. */
  const rawHead = (head: string) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = connect(pull.port, '127.0.0.1', () => socket.write(head));
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
      socket.on('error', reject);
    });
  const status = (raw: string) => Number(raw.split(' ')[1]);

  test('the client Host header never changes the path the registry sees (C1/W1)', async () => {
    for (const host of ['evil#', 'evil/v2/other/..', 'a b', 'registry.example:99999']) {
      delete seen.url;
      const raw = await rawHead(
        `HEAD ${BLOB_PATH} HTTP/1.1\r\nhost: ${host}\r\nauthorization: Basic eDpvaw==\r\nconnection: close\r\n\r\n`,
      );
      expect(status(raw)).toBe(200);
      expect(raw.toLowerCase()).toContain(`content-length: ${BLOB.length}`);
      expect(seenUrl()).toBe(BLOB_PATH);
    }
  });

  test('an absolute-form target is accepted only for the host it names', async () => {
    delete seen.url;
    const same = await rawHead(
      `HEAD http://tenant-registry.svc${BLOB_PATH} HTTP/1.1\r\nhost: tenant-registry.svc\r\nauthorization: Basic eDpvaw==\r\nconnection: close\r\n\r\n`,
    );
    expect(status(same)).toBe(200);
    expect(seenUrl()).toBe(BLOB_PATH);
    delete seen.url;
    for (const target of [
      `http://other.example${BLOB_PATH}`,
      `http://user:pw@tenant-registry.svc${BLOB_PATH}`,
      `ftp://tenant-registry.svc${BLOB_PATH}`,
      'tenant-registry.svc:80',
      '*',
      `${BLOB_PATH}#fragment`,
    ]) {
      const raw = await rawHead(
        `GET ${target} HTTP/1.1\r\nhost: tenant-registry.svc\r\nauthorization: Basic eDpvaw==\r\nconnection: close\r\n\r\n`,
      );
      expect({ target, status: status(raw) }).toEqual({ target, status: 400 });
    }
    expect(seenUrl()).toBeUndefined();
  });

  test('an unexpected failure before the answer starts is answered 500, not dropped', async () => {
    const listener = await serveRegistryListener({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeoutSeconds: 5,
      maxRequestBodySize: 1024,
      // Not a Response: writing it fails before any header is sent.
      fetch: () => undefined as never,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/v2/`);
      expect(response.status).toBe(500);
    } finally {
      await listener.stop();
    }
  });

  test('response headers node refuses cancel the body (the handler frees its slot)', async () => {
    const cancelled = Promise.withResolvers<void>();
    const listener = await serveRegistryListener({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeoutSeconds: 5,
      maxRequestBodySize: 1024,
      fetch: () =>
        new Response(new ReadableStream({ cancel: () => cancelled.resolve() }), {
          headers: { 'x-bad': 'a\u0001b' },
        }),
    });
    try {
      await expect(fetch(`http://127.0.0.1:${listener.port}/v2/`)).rejects.toBeDefined();
      await cancelled.promise;
    } finally {
      await listener.stop();
    }
  });

  test('a response body that fails partway ends the connection', async () => {
    const listener = await serveRegistryListener({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeoutSeconds: 5,
      maxRequestBodySize: 1024,
      fetch: () =>
        new Response(
          new ReadableStream({
            async pull(c) {
              c.enqueue(new TextEncoder().encode('partial'));
              await Bun.sleep(10);
              c.error(new Error('upstream reset'));
            },
          }),
          { headers: { 'content-length': '64' } },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/v2/`);
      await expect(response.text()).rejects.toBeDefined();
    } finally {
      await listener.stop();
    }
  });

  test('requestUrl resolves against the listener origin', () => {
    const at = (url: string, host?: string, hostname = '127.0.0.1', tls = false) =>
      requestUrl(
        { url, headers: host === undefined ? {} : { host } },
        { hostname, tls: tls ? { cert: '', key: '' } : undefined },
      )?.href;
    expect(at('/v2/x?n=1', 'evil#')).toBe('http://127.0.0.1/v2/x?n=1');
    expect(at('//other/v2/x', 'h')).toBe('http://127.0.0.1//other/v2/x');
    expect(at('/v2/x', undefined, '::1', true)).toBe('https://[::1]/v2/x');
    expect(at('http://H:8080/v2/x', 'h:8080')).toBe('http://127.0.0.1/v2/x');
    expect(at('http://h/v2/x')).toBeUndefined();
    expect(at('/v2/x', 'h', 'bad host')).toBeUndefined();
  });

  test('streams an upload under the cap, chunked or declared', async () => {
    const chunked = await send('front', 'PATCH', '/v2/acme/app/blobs/uploads/1', {
      chunks: [new Uint8Array(1000), new Uint8Array(2000)],
    });
    expect(chunked.status).toBe(202);
    expect(JSON.parse(chunked.body.toString())).toEqual({ received: 3000 });
    const declared = await send('front', 'PUT', '/v2/acme/app/blobs/uploads/1', {
      chunks: [new Uint8Array(500)],
      length: 500,
    });
    expect(JSON.parse(declared.body.toString())).toEqual({ received: 500 });
  });

  test('an upload the handler answers without reading still gets its answer', async () => {
    // Without Basic credentials the front answers the registry challenge and drops the body.
    const response = await new Promise<Raw>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: front.port,
          method: 'PATCH',
          path: '/v2/acme/app/blobs/uploads/1',
          rejectUnauthorized: false,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on('error', reject);
      req.write(new Uint8Array(4096));
      req.end();
    });
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Basic realm="di-framework-tenant-registry"');
    expect(response.headers.connection).toBe('close');
  });

  test('refuses a chunked body over the cap with 413', async () => {
    const chunks = Array.from({ length: 5 }, () => new Uint8Array(MAX_BODY / 2));
    const response = await send('front', 'PATCH', '/v2/acme/app/blobs/uploads/1', {
      chunks,
    }).catch(() => undefined);
    expect(response?.status).toBe(413);
    expect(response?.headers['content-type']).toBe('application/problem+json');
  });

  test('refuses a declared body over the cap with 413 before reading it', async () => {
    const response = await send('front', 'PUT', '/v2/acme/app/blobs/uploads/1', {
      chunks: [],
      length: MAX_BODY + 1,
    }).catch(() => undefined);
    expect(response?.status).toBe(413);
  });

  test('a handler that throws is answered 500 without details', async () => {
    const failing = await serveRegistryListener({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeoutSeconds: 5,
      maxRequestBodySize: 1024,
      fetch: () => {
        throw new Error('secret detail');
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${failing.port}/v2/`);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('secret detail');
    } finally {
      await failing.stop();
    }
  });

  test('a client that goes away mid-upload fails the forwarded body', async () => {
    let failure: unknown;
    const reached = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const listener = await serveRegistryListener({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeoutSeconds: 5,
      maxRequestBodySize: 1 << 20,
      fetch: async (request) => {
        const reader = request.body?.getReader();
        try {
          for (;;) {
            const { done } = (await reader?.read()) ?? { done: true };
            reached.resolve();
            if (done) break;
          }
        } catch (error) {
          failure = error;
        }
        ended.resolve();
        return new Response('read');
      },
    });
    try {
      const socket = connect(listener.port, '127.0.0.1', () => {
        socket.write(
          'PATCH /v2/acme/app/blobs/uploads/1 HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n',
        );
      });
      await reached.promise;
      socket.destroy();
      await ended.promise;
      expect(failure).toBeDefined();
    } finally {
      await listener.stop();
    }
  });

  test('a client that goes away mid-body aborts the upstream response', async () => {
    delete seen.aborted;
    const upstreamAborted = () => seen.aborted;
    await new Promise<void>((resolve) => {
      const socket = connect(pull.port, '127.0.0.1', () => {
        socket.write(
          'GET /v2/acme/app/blobs/sha256:endless HTTP/1.1\r\nhost: x\r\nauthorization: Basic eDpvaw==\r\n\r\n',
        );
      });
      socket.once('data', () => {
        socket.destroy();
        resolve();
      });
    });
    for (let i = 0; i < 50 && upstreamAborted() !== true; i++) await Bun.sleep(10);
    expect(upstreamAborted()).toBe(true);
  });
});
