import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { caCertificate, leafCertificate } from '../../platform/src/tenancy/tls.ts';
import {
  Controller,
  configFromEnv,
  HOST_PULL_USER,
  serveWhoamiListener,
} from '../src/controller.ts';
import { AuthError } from '../src/identity.ts';
import {
  HopAddresses,
  type RegistryListener,
  serveRegistryListener,
} from '../src/registry-listener.ts';

/** The name the tenant registry calls the whoami listener by (platform#113). */
const CONTROLLER_NAME = 'tenant-controller.di-runtime-acme.svc';

interface Answer {
  status: number;
  body: string;
}

/**
 * The whoami listener as the controller runs it (platform#113): TLS with the controller
 * certificate, which the registry verifies against the tenant CA under the Service name it calls,
 * and plain HTTP on the same port for a registry still configured with `http://` during an upgrade.
 */
describe('whoami listener over TLS (#113)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whoami-listener-'));
  const tokenFile = join(dir, 'host-pull-token');
  const TOKEN = 'w'.repeat(43);
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const ca = caCertificate('tenant-controller CA (di-runtime-acme)', 30);
  const leaf = leafCertificate(CONTROLLER_NAME, [CONTROLLER_NAME], [], 30, ca.cert, ca.key);
  const config = configFromEnv({
    TENANT_CONTROLLER_TENANT: 'acme',
    TENANT_CONTROLLER_WHOAMI_PORT: '8789',
    TENANT_CONTROLLER_REGISTRY_HOST: 'registry',
    TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE: tokenFile,
  });
  const controller = new Controller(
    config,
    {} as never,
    { issuer: 'https://issuer.test' } as never,
    {
      resolve: async () => {
        throw new AuthError(401, 'the access token is invalid or has expired');
      },
      forget: () => {},
    } as never,
    {} as never,
  );
  const tls = { cert: leaf.cert, key: leaf.key };
  let both: RegistryListener;
  let tlsOnly: RegistryListener;
  let plainOnly: RegistryListener;
  let log: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    log = spyOn(console, 'log').mockImplementation(() => {});
    const local = { ...config, host: '127.0.0.1' };
    both = await serveWhoamiListener(controller, local, 0, tls);
    tlsOnly = await serveWhoamiListener(controller, { ...local, whoamiTlsOnly: true }, 0, tls);
    plainOnly = await serveWhoamiListener(controller, local, 0, undefined);
  });
  afterAll(async () => {
    await Promise.all([both.stop(), tlsOnly.stop(), plainOnly.stop()]);
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (
    secure: boolean,
    port: number,
    path = '/v1/auth/whoami',
    authorization = `Bearer ${TOKEN}`,
  ) =>
    new Promise<Answer>((resolve, reject) => {
      const options = {
        host: '127.0.0.1',
        port,
        path,
        headers: { authorization },
        agent: false,
      };
      const done = (res: import('node:http').IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      };
      // The registry's view: the tenant CA is the only trust anchor, and the name it calls is
      // the Service name, which the certificate has to cover.
      const req = secure
        ? httpsRequest({ ...options, ca: ca.cert, servername: CONTROLLER_NAME }, done)
        : httpRequest(options, done);
      req.on('error', reject);
      req.end();
    });

  test('answers over TLS with the controller certificate, verified by the tenant CA', async () => {
    const answer = await call(true, both.port);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ user: HOST_PULL_USER, via: 'host-pull' });
  });

  test('still answers plain HTTP on the same port for a registry not yet switched', async () => {
    const answer = await call(false, both.port);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ user: HOST_PULL_USER, via: 'host-pull' });
  });

  test('serves the same contract over both: 404 elsewhere, 401 for a bad token', async () => {
    for (const secure of [true, false]) {
      expect((await call(secure, both.port, '/v2/')).status).toBe(404);
      expect((await call(secure, both.port, '/v1/auth/whoami', 'Bearer nope')).status).toBe(401);
    }
  });

  test('a TLS-only listener refuses plain HTTP', async () => {
    expect((await call(true, tlsOnly.port)).status).toBe(200);
    await expect(call(false, tlsOnly.port)).rejects.toThrow();
  });

  test('without a certificate the listener stays plain HTTP', async () => {
    expect((await call(false, plainOnly.port)).status).toBe(200);
    await expect(call(true, plainOnly.port)).rejects.toThrow();
  });

  test('a certificate without the Service name fails verification', async () => {
    const other = leafCertificate(
      'tenant-controller',
      ['tenant-controller'],
      [],
      30,
      ca.cert,
      ca.key,
    );
    const listener = await serveWhoamiListener(
      controller,
      { host: '127.0.0.1', whoamiTlsOnly: true },
      0,
      other,
    );
    try {
      // Refused for the name alone: the chain itself verifies against the tenant CA.
      await expect(call(true, listener.port)).rejects.toMatchObject({
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      });
    } finally {
      await listener.stop();
    }
  });

  test('fails to start on a taken port, leaving nothing listening', async () => {
    await expect(
      serveWhoamiListener(controller, { host: '127.0.0.1' }, both.port, tls),
    ).rejects.toThrow();
    expect((await call(true, both.port)).status).toBe(200);
  });

  test('a client that goes away before sending anything is dropped', async () => {
    const socket = connect(both.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.destroy();
    expect((await call(false, both.port)).status).toBe(200);
  });

  test('a plain client that half-closes after its request still gets the response', async () => {
    const socket = connect(both.port, '127.0.0.1');
    let raw = '';
    socket.on('data', (chunk: Buffer) => {
      raw += chunk;
    });
    const ended = new Promise<void>((resolve, reject) => {
      socket.once('end', () => resolve());
      socket.once('error', reject);
    });
    socket.end(
      `GET /v1/auth/whoami HTTP/1.1\r\nHost: ${CONTROLLER_NAME}\r\n` +
        `Authorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`,
    );
    await ended;
    socket.destroy();
    expect(raw).toStartWith('HTTP/1.1 200');
    expect(raw).toContain(HOST_PULL_USER);
  });
});

/** Waits for `socket` to close, or fails after `ms`. */
const closedWithin = (socket: Socket, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still open after ${ms} ms`)), ms);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * The relay behind `acceptPlainHttp` (#329): it bounds connections and idleness on the client
 * side, and passes the client's own address to the handler, so it is safe on listeners that read
 * it (the registry front and pull listeners pass it on).
 */
describe('TLS and plain HTTP relay (#329)', () => {
  const ca = caCertificate('relay CA', 30);
  const leaf = leafCertificate(
    'localhost',
    ['localhost'],
    ['127.0.0.1', '::1'],
    30,
    ca.cert,
    ca.key,
  );
  const tls = { cert: leaf.cert, key: leaf.key };
  const serve = (overrides: Partial<Parameters<typeof serveRegistryListener>[0]> = {}) =>
    serveRegistryListener({
      hostname: '127.0.0.1',
      port: 0,
      tls,
      acceptPlainHttp: true,
      idleTimeoutSeconds: 120,
      maxRequestBodySize: 1024,
      fetch: (request, server) =>
        Response.json({ address: server.requestIP(request)?.address ?? null }),
      ...overrides,
    });
  const ask = (secure: boolean, host: string, port: number) =>
    new Promise<string>((resolve, reject) => {
      const options = { host, port, path: '/', agent: false };
      const done = (res: import('node:http').IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
      };
      const req = secure
        ? httpsRequest({ ...options, ca: ca.cert, servername: 'localhost' }, done)
        : httpRequest(options, done);
      req.on('error', reject);
      req.end();
    });
  const opened = async (port: number) => {
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    return socket;
  };

  test('closes a client that connects and sends nothing after the idle timeout', async () => {
    const listener = await serve({ idleTimeoutSeconds: 1 });
    const socket = await opened(listener.port);
    try {
      await closedWithin(socket, 5_000);
    } finally {
      socket.destroy();
      await listener.stop();
    }
  });

  test('closes connections beyond maxConnections, and accepts again once one ends', async () => {
    const listener = await serve({ maxConnections: 1 });
    const held = await opened(listener.port);
    const extra = await opened(listener.port);
    try {
      // Closed by the listener well before the idle timeout would.
      await closedWithin(extra, 5_000);
      held.end();
      await closedWithin(held, 5_000);
      expect(JSON.parse(await ask(false, '127.0.0.1', listener.port))).toEqual({
        address: '127.0.0.1',
      });
    } finally {
      held.destroy();
      extra.destroy();
      await listener.stop();
    }
  });

  test("hands the handler the client's address over both protocols, not the hop's", async () => {
    // On ::1 the client's address differs from the relay hop's (127.0.0.1).
    const listener = await serve({ hostname: '::1' });
    try {
      for (const secure of [true, false])
        expect(JSON.parse(await ask(secure, '::1', listener.port))).toEqual({ address: '::1' });
    } finally {
      await listener.stop();
    }
  });

  test('keeps a TLS hop and a plain hop open at once, each with its own client address', async () => {
    // Dual-stack: the plain client comes from 127.0.0.1, the TLS client from ::1.
    const listener = await serve({ hostname: '::' });
    const plainSocket = connect(listener.port, '127.0.0.1');
    const tlsSocket = tlsConnect({
      host: '::1',
      port: listener.port,
      ca: ca.cert,
      servername: 'localhost',
    });
    const answer = (socket: Socket) =>
      new Promise<string>((resolve, reject) => {
        let raw = '';
        const read = (chunk: Buffer) => {
          raw += chunk;
          // The JSON body, chunked: complete once the last chunk has come.
          const body = /\{.*\}/.exec(raw);
          if (body && raw.endsWith('\r\n0\r\n\r\n')) {
            socket.off('data', read);
            resolve(body[0]);
          }
        };
        socket.on('data', read);
        socket.once('error', reject);
        socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
      });
    try {
      await Promise.all([
        new Promise((resolve) => plainSocket.once('connect', resolve)),
        new Promise((resolve) => tlsSocket.once('secureConnect', resolve)),
      ]);
      // Both hops stay open across both requests, and twice over in alternation.
      for (let round = 0; round < 2; round++) {
        expect(JSON.parse(await answer(tlsSocket))).toEqual({ address: '::1' });
        expect(JSON.parse(await answer(plainSocket)).address).toEndWith('127.0.0.1');
      }
    } finally {
      plainSocket.destroy();
      tlsSocket.destroy();
      await listener.stop();
    }
  });

  test('closes a client trickling its request after requestTimeoutSeconds', async () => {
    const listener = await serve({ requestTimeoutSeconds: 1 });
    const socket = await opened(listener.port);
    socket.on('error', () => {});
    socket.write('GET / HTTP/1.1\r\n');
    // Never idle, never finished: only the request deadline ends it.
    const trickle = setInterval(() => socket.write('X-Slow: 1\r\n'), 200);
    try {
      await closedWithin(socket, 5_000);
    } finally {
      clearInterval(trickle);
      socket.destroy();
      await listener.stop();
    }
  });

  test('with requestTimeoutSeconds, a TLS-only or plain-only listener serves only its protocol', async () => {
    const tlsOnly = await serve({ acceptPlainHttp: false, requestTimeoutSeconds: 5 });
    const plainOnly = await serve({ tls: undefined, requestTimeoutSeconds: 5 });
    try {
      expect(JSON.parse(await ask(true, '127.0.0.1', tlsOnly.port))).toEqual({
        address: '127.0.0.1',
      });
      await expect(ask(false, '127.0.0.1', tlsOnly.port)).rejects.toThrow();
      expect(JSON.parse(await ask(false, '127.0.0.1', plainOnly.port))).toEqual({
        address: '127.0.0.1',
      });
      await expect(ask(true, '127.0.0.1', plainOnly.port)).rejects.toThrow();
    } finally {
      await Promise.all([tlsOnly.stop(), plainOnly.stop()]);
    }
  });

  test('frees the slot of a client that keeps its side open after a complete response', async () => {
    const listener = await serve({ maxConnections: 1 });
    const lingering = connect({ port: listener.port, host: '127.0.0.1', allowHalfOpen: true });
    let raw = '';
    lingering.on('data', (chunk: Buffer) => {
      raw += chunk;
    });
    const ended = new Promise((resolve) => lingering.once('end', resolve));
    lingering.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    try {
      await ended;
      expect(raw).toStartWith('HTTP/1.1 200');
      // The response is complete but the client never closes: after a short grace, well before
      // the 120 s idle timeout, its slot takes a new connection.
      const started = Date.now();
      for (;;) {
        const answer = await ask(false, '127.0.0.1', listener.port).catch(() => undefined);
        if (answer !== undefined) {
          expect(JSON.parse(answer)).toEqual({ address: '127.0.0.1' });
          break;
        }
        expect(Date.now() - started).toBeLessThan(8_000);
        await Bun.sleep(250);
      }
    } finally {
      lingering.destroy();
      await listener.stop();
    }
  }, 10_000);
});

/** The relay's per-listener table of client addresses (#329 review W1). */
describe('HopAddresses', () => {
  test('the same local port to two inner listeners keeps two addresses', () => {
    const secure = new HopAddresses();
    const plain = new HopAddresses();
    const releaseSecure = secure.claim(40000, '10.0.0.1');
    plain.claim(40000, '10.0.0.2');
    expect(secure.lookup(40000)).toBe('10.0.0.1');
    expect(plain.lookup(40000)).toBe('10.0.0.2');
    releaseSecure();
    expect(secure.lookup(40000)).toBeUndefined();
    expect(plain.lookup(40000)).toBe('10.0.0.2');
  });

  test("a reused port's new entry survives the old hop's release", () => {
    const hops = new HopAddresses();
    const releaseOld = hops.claim(40001, '10.0.0.1');
    const releaseNew = hops.claim(40001, '10.0.0.2');
    releaseOld();
    expect(hops.lookup(40001)).toBe('10.0.0.2');
    releaseNew();
    expect(hops.lookup(40001)).toBeUndefined();
    expect(hops.lookup(undefined)).toBeUndefined();
  });
});
