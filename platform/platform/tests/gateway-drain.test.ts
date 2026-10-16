import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createServer as createTlsServer, connect as tlsConnect } from 'node:tls';
import {
  createEdge,
  createGateway,
  defaultUpstreamOf,
  drain,
  type GatewayOptions,
  main,
} from '../src/gateway/gateway';
import { selfSignedCertificate } from '../src/tenancy/tls';

/**
 * SIGTERM drain (#223) against real listeners: an upstream whose `/slow` answer waits for the
 * test, and the gateway started by `main` with a fake signal source and exit. Every wait is
 * bounded, so a regression fails fast instead of hanging.
 */

/** Resolve `promise`, or reject after `ms` with `what` in the message. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: Timer | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

type Response = { status: number; headers: Record<string, string>; body: string };

/** A raw HTTP/1.1 client connection, so the test controls keep-alive and sees `Connection`. */
class Client {
  readonly socket: Socket;
  readonly closed: Promise<void>;
  private data = '';
  private waiting?: () => void;

  constructor(port: number) {
    this.socket = connect(port, '127.0.0.1');
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.data += chunk;
      this.waiting?.();
    });
    this.socket.on('error', () => {});
    this.closed = new Promise((resolve) => this.socket.once('close', () => resolve()));
  }

  connected(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('error', reject);
    });
  }

  /** Send a GET and resolve with the next complete response (header names lower-cased). */
  get(path: string): Promise<Response> {
    this.socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    return this.next();
  }

  /** Data received so far that no response has consumed (an upgraded tunnel's bytes). */
  received(): string {
    return this.data;
  }

  /** Resolve once `text` has been received. */
  receive(text: string): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.data.includes(text)) return;
        this.waiting = undefined;
        resolve();
      };
      this.waiting = check;
      check();
    });
  }

  /** Resolve with the next complete response. */
  next(): Promise<Response> {
    return new Promise((resolve) => {
      const parse = () => {
        const end = this.data.indexOf('\r\n\r\n');
        if (end < 0) return;
        const [statusLine, ...lines] = this.data.slice(0, end).split('\r\n');
        const headers: Record<string, string> = {};
        for (const line of lines) {
          const at = line.indexOf(':');
          headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
        }
        const length = Number(headers['content-length'] ?? 0);
        if (this.data.length < end + 4 + length) return;
        const body = this.data.slice(end + 4, end + 4 + length);
        this.data = this.data.slice(end + 4 + length);
        this.waiting = undefined;
        resolve({ status: Number(statusLine?.split(' ')[1]), headers, body });
      };
      this.waiting = parse;
      parse();
    });
  }
}

/** Whether a new TCP connection to `port` is refused. */
function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

describe('gateway SIGTERM drain (#223)', () => {
  let upstream: Server;
  let upstreamPort: number;
  let held: Promise<void>;
  let release: () => void;
  const upstreamSockets = new Set<Socket>();
  const clients: Client[] = [];
  let log: ReturnType<typeof spyOn>;
  let errors: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    log = spyOn(console, 'log').mockImplementation(() => {});
    errors = spyOn(console, 'error').mockImplementation(() => {});
    let seen: () => void = () => {};
    held = new Promise((resolve) => {
      seen = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    upstream = createServer((req, res) => {
      const answer = (body: string) => {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      };
      if (req.url === '/slow') {
        seen();
        void released.then(() => answer('slow done'));
        return;
      }
      // Never answered: only the drain bound ends it.
      if (req.url === '/hang') {
        seen();
        return;
      }
      answer('fast');
    });
    upstream.on('upgrade', (_req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n',
      );
      socket.on('data', (chunk) => socket.write(`echo:${chunk}`));
      socket.on('end', () => socket.end());
    });
    upstream.on('connection', (socket) => {
      upstreamSockets.add(socket);
      socket.on('close', () => upstreamSockets.delete(socket));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as { port: number }).port;
  });

  afterEach(async () => {
    log.mockRestore();
    errors.mockRestore();
    release();
    for (const client of clients.splice(0)) client.socket.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  });

  async function startGateway(drainTimeoutMs: number) {
    const signals = new EventEmitter();
    let exited: (code: number) => void = () => {};
    const exit = new Promise<number>((resolve) => {
      exited = resolve;
    });
    let exitCalled = false;
    const server = main(
      {
        GATEWAY_CONFIG: JSON.stringify({
          port: 0,
          defaultUpstream: `127.0.0.1:${upstreamPort}`,
          drainTimeoutMs,
        }),
      },
      signals,
      (code) => {
        exitCalled = true;
        exited(code);
      },
    );
    await within(
      new Promise((resolve) => server.once('listening', resolve)),
      2_000,
      'the gateway to listen',
    );
    const port = (server.address() as { port: number }).port;
    return { signals, exit, exitCalled: () => exitCalled, port };
  }

  async function client(port: number): Promise<Client> {
    const c = new Client(port);
    clients.push(c);
    await within(c.connected(), 2_000, 'a client to connect');
    return c;
  }

  it('refuses new connections, closes idle ones and finishes in-flight requests', async () => {
    const gateway = await startGateway(5_000);

    // An idle keep-alive connection, and one with a request in flight.
    const idle = await client(gateway.port);
    const first = await within(idle.get('/fast'), 2_000, 'the fast response');
    expect(first.body).toBe('fast');
    expect(first.headers.connection).not.toBe('close');
    const busy = await client(gateway.port);
    const slow = busy.get('/slow');
    await within(held, 2_000, 'the upstream to receive /slow');
    // A partly sent request is covered under Node below: Bun's HTTP server sockets do not
    // count `bytesRead`.

    gateway.signals.emit('SIGTERM');

    await within(idle.closed, 2_000, 'the idle keep-alive connection to close');
    expect(await within(refused(gateway.port), 2_000, 'a new connection attempt')).toBe(true);
    // The in-flight request still holds the drain open.
    await Bun.sleep(50);
    expect(gateway.exitCalled()).toBe(false);

    release();
    const res = await within(slow, 2_000, 'the in-flight response');
    expect(res.status).toBe(200);
    expect(res.body).toBe('slow done');
    expect(res.headers.connection).toBe('close');
    await within(busy.closed, 2_000, 'the drained connection to close');
    expect(await within(gateway.exit, 2_000, 'the gateway to exit')).toBe(0);
  });

  it('closes what is still open once the drain bound passes, then exits', async () => {
    const gateway = await startGateway(150);
    const busy = await client(gateway.port);
    void busy.get('/hang');
    await within(held, 2_000, 'the upstream to receive /hang');

    const started = performance.now();
    gateway.signals.emit('SIGTERM');
    expect(await within(gateway.exit, 2_000, 'the gateway to exit')).toBe(0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    await within(busy.closed, 2_000, 'the hung connection to close');
  });

  it('keeps an upgraded tunnel open through the drain until a peer closes it', async () => {
    const gateway = await startGateway(5_000);
    const tunnel = await client(gateway.port);
    let received = '';
    const echoed = (text: string) =>
      within(
        new Promise<void>((resolve) => {
          const check = () => {
            if (!received.includes(text)) return;
            tunnel.socket.off('data', onData);
            resolve();
          };
          const onData = (chunk: string) => {
            received += chunk;
            check();
          };
          tunnel.socket.on('data', onData);
          check();
        }),
        2_000,
        `the tunnel to echo ${text}`,
      );
    tunnel.socket.write(
      'GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n',
    );
    await echoed('101 Switching Protocols');

    gateway.signals.emit('SIGTERM');
    expect(await within(refused(gateway.port), 2_000, 'a new connection attempt')).toBe(true);
    tunnel.socket.write('still-open');
    await echoed('echo:still-open');
    expect(gateway.exitCalled()).toBe(false);

    tunnel.socket.end();
    expect(await within(gateway.exit, 2_000, 'the gateway to exit')).toBe(0);
  });

  it('exits at once when nothing is open', async () => {
    const gateway = await startGateway(5_000);
    const started = performance.now();
    gateway.signals.emit('SIGTERM');
    expect(await within(gateway.exit, 2_000, 'the gateway to exit')).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(await within(refused(gateway.port), 2_000, 'a new connection attempt')).toBe(true);
  });
});

/**
 * The compiled script under Node, as the pod runs it: a real SIGTERM to a real process. The
 * in-process tests above run on Bun's `node:http`; this one proves the same drain on Node's.
 */
describe('gateway process drain under Node (#223)', () => {
  it('finishes the in-flight request, refuses new connections and exits 0 on SIGTERM', async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const upstream = createServer((req, res) => {
      if (req.url === '/slow') seen();
      void (req.url === '/slow' ? released : Promise.resolve()).then(() => {
        res.writeHead(200, { 'content-length': 2 });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const port = await freePort();
    const child = spawn('node', [join(import.meta.dir, '../dist/gateway/gateway.js')], {
      env: {
        ...process.env,
        GATEWAY_CONFIG: JSON.stringify({
          port,
          defaultUpstream: `127.0.0.1:${upstreamPort}`,
          drainTimeoutMs: 5_000,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    let busy: Client | undefined;
    let partial: Client | undefined;
    let silent: Client | undefined;
    try {
      await within(listening(port), 5_000, `the gateway process to listen\n${output}`);
      busy = new Client(port);
      await within(busy.connected(), 2_000, 'the client to connect');
      const slow = busy.get('/slow');
      await within(held, 2_000, 'the upstream to receive /slow');
      // A keep-alive connection whose next request's headers are only partly sent (#223 S1).
      partial = new Client(port);
      await within(partial.connected(), 2_000, 'the partial client to connect');
      expect((await within(partial.get('/fast'), 2_000, 'the first response')).body).toBe('ok');
      partial.socket.write('GET /fast HTTP/1.1\r\nHo');
      // A connection opened before SIGTERM that sends its request only afterwards.
      silent = new Client(port);
      await within(silent.connected(), 2_000, 'the silent client to connect');
      await Bun.sleep(50);

      child.kill('SIGTERM');
      await within(
        (async () => {
          while (!(await refused(port))) await Bun.sleep(10);
        })(),
        2_000,
        'the listener to close',
      );
      expect(child.exitCode).toBeNull();

      partial.socket.write('st: localhost\r\n\r\n');
      const answered = await within(partial.next(), 2_000, 'the partly sent request');
      expect(answered.body).toBe('ok');
      expect(answered.headers.connection).toBe('close');
      const late = await within(silent.get('/fast'), 2_000, 'the silent connection request');
      expect(late.body).toBe('ok');
      expect(late.headers.connection).toBe('close');

      release();
      const res = await within(slow, 2_000, 'the in-flight response');
      expect(res.body).toBe('ok');
      expect(res.headers.connection).toBe('close');
      expect(await within(exited, 5_000, `the process to exit\n${output}`)).toBe(0);
      expect(output).toContain('SIGTERM: drained, exiting');
    } finally {
      release();
      busy?.socket.destroy();
      partial?.socket.destroy();
      silent?.socket.destroy();
      if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listening(port: number): Promise<void> {
  while (await refused(port)) await Bun.sleep(20);
}

/** Upstreams for the edge drain: tenant HTTP (`/slow` held until released, WebSocket echo) and
 * a TLS controller that echoes. */
async function edgeUpstreams() {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const sockets = new Set<Socket>();
  const http = createServer((req, res) => {
    if (req.url === '/slow') seen();
    void (req.url === '/slow' ? released : Promise.resolve()).then(() => {
      res.writeHead(200, { 'content-length': 2 });
      res.end('ok');
    });
  });
  http.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n',
    );
    socket.on('data', (chunk) => socket.write(`echo:${chunk}`));
    socket.on('end', () => socket.end());
  });
  const pem = selfSignedCertificate('tenant-controller', ['controller.alpha.localhost'], [], 1);
  const controller = createTlsServer({ cert: pem.cert, key: pem.key }, (socket) => {
    socket.on('data', (chunk) => socket.write(`tls:${chunk}`));
    socket.on('end', () => socket.end());
  });
  for (const server of [http, controller])
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => controller.listen(0, '127.0.0.1', resolve));
  return {
    httpPort: (http.address() as { port: number }).port,
    controllerPort: (controller.address() as { port: number }).port,
    held,
    release,
    async close() {
      release();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => http.close(resolve));
      await new Promise((resolve) => controller.close(resolve));
    },
  };
}

/** A gateway listening through the edge (controller routed), started in-process or under Node. */
interface EdgeGateway {
  port: number;
  terminate(): void;
  /** The drain's result, once it has finished. */
  drained: Promise<string>;
  /** Whether the HTTP server has closed, which releases the upstream keep-alive pool. */
  serverClosed(): boolean;
}

const DRAIN_BOUND_MS = 1_000;

/**
 * Edge-mode drain (#223 W1). Before SIGTERM: an idle keep-alive connection, a connection still
 * being classified (no byte sent), a keep-alive connection whose next request is partly sent,
 * an in-flight request, a WebSocket tunnel and a TLS passthrough pipe. After it: the idle one is
 * closed, new connections are refused, the others are answered with `Connection: close`, the
 * tunnel and the pipe keep echoing until the bound, and only then is the HTTP server (and its
 * upstream pool) closed.
 */
async function edgeDrainScenario(
  gateway: EdgeGateway,
  upstreams: Awaited<ReturnType<typeof edgeUpstreams>>,
  opened: Client[],
): Promise<void> {
  const open = async () => {
    const c = new Client(gateway.port);
    opened.push(c);
    await within(c.connected(), 2_000, 'a client to connect');
    return c;
  };
  const idle = await open();
  expect((await within(idle.get('/'), 2_000, 'the idle client response')).body).toBe('ok');
  const classifying = await open();
  const partial = await open();
  await within(partial.get('/'), 2_000, 'the partial client response');
  partial.socket.write('GET / HTTP/1.1\r\nHo');
  const busy = await open();
  const slow = busy.get('/slow');
  await within(upstreams.held, 2_000, 'the upstream to receive /slow');
  const tunnel = await open();
  tunnel.socket.write(
    'GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n',
  );
  await within(tunnel.receive('101 Switching Protocols'), 2_000, 'the tunnel to upgrade');
  const tls = tlsConnect({
    port: gateway.port,
    host: '127.0.0.1',
    servername: 'controller.alpha.localhost',
    rejectUnauthorized: false,
  });
  tls.setEncoding('utf8');
  tls.on('error', () => {});
  let tlsData = '';
  tls.on('data', (chunk: string) => {
    tlsData += chunk;
  });
  const tlsClosed = new Promise<void>((resolve) => tls.once('close', () => resolve()));
  const tlsEcho = (text: string) =>
    within(
      (async () => {
        while (!tlsData.includes(`tls:${text}`)) await Bun.sleep(5);
      })(),
      2_000,
      `the passthrough pipe to echo ${text}`,
    );
  await within(
    new Promise<void>((resolve) => tls.once('secureConnect', () => resolve())),
    2_000,
    'the passthrough handshake',
  );
  tls.write('before');
  await tlsEcho('before');
  await Bun.sleep(50);

  const started = performance.now();
  gateway.terminate();

  await within(idle.closed, 2_000, 'the idle keep-alive connection to close');
  expect(await within(refused(gateway.port), 2_000, 'a new connection attempt')).toBe(true);

  const first = await within(classifying.get('/'), 2_000, 'the classifying connection');
  expect(first.body).toBe('ok');
  expect(first.headers.connection).toBe('close');

  partial.socket.write('st: localhost\r\n\r\n');
  const answered = await within(partial.next(), 2_000, 'the partly sent request');
  expect(answered.body).toBe('ok');
  expect(answered.headers.connection).toBe('close');

  upstreams.release();
  const res = await within(slow, 2_000, 'the in-flight response');
  expect(res.body).toBe('ok');
  expect(res.headers.connection).toBe('close');

  tunnel.socket.write('after');
  await within(tunnel.receive('echo:after'), 2_000, 'the tunnel to echo after SIGTERM');
  tls.write('after');
  await tlsEcho('after');
  // The pool serves the drain: the HTTP server closes only once the drain has finished.
  expect(gateway.serverClosed()).toBe(false);

  // The tunnel and the pipe hold the drain open until its bound.
  expect(await within(gateway.drained, 5_000, 'the drain to finish')).toBe('timeout');
  expect(performance.now() - started).toBeGreaterThanOrEqual(DRAIN_BOUND_MS - 50);
  await within(tunnel.closed, 2_000, 'the tunnel to close at the bound');
  await within(tlsClosed, 2_000, 'the passthrough pipe to close at the bound');
  await within(
    (async () => {
      while (!gateway.serverClosed()) await Bun.sleep(5);
    })(),
    2_000,
    'the HTTP server to close after the drain',
  );
}

describe('gateway SIGTERM drain behind the edge (#223)', () => {
  let upstreams: Awaited<ReturnType<typeof edgeUpstreams>>;
  const opened: Client[] = [];
  let log: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    log = spyOn(console, 'error').mockImplementation(() => {});
    upstreams = await edgeUpstreams();
  });

  afterEach(async () => {
    log.mockRestore();
    for (const c of opened.splice(0)) c.socket.destroy();
    await upstreams.close();
  });

  const options = (): GatewayOptions => ({
    defaultUpstream: { hostname: '127.0.0.1', port: upstreams.httpPort },
    tenantAuthRoutes: { controller: 'controller' },
    controllerUpstream: () => ({ hostname: '127.0.0.1', port: upstreams.controllerPort }),
  });

  it('drains in-process (Bun)', async () => {
    const server = createGateway(options());
    const edge = createEdge(server, options());
    // Bun never emits 'close' for an HTTP server that did not listen, so watch the call; the
    // Node test below watches the event.
    const close = spyOn(server, 'close');
    await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve));
    let finish: (result: string) => void = () => {};
    const drained = new Promise<string>((resolve) => {
      finish = resolve;
    });
    await edgeDrainScenario(
      {
        port: (edge.address() as { port: number }).port,
        terminate: () => void drain(server, edge, DRAIN_BOUND_MS).then(finish),
        drained,
        serverClosed: () => close.mock.calls.length > 0,
      },
      upstreams,
      opened,
    );
  });

  it('drains under Node from the built script', async () => {
    const port = await freePort();
    const script = `
      const { createGateway, createEdge, drain } = require(${JSON.stringify(join(import.meta.dir, '../dist/gateway/gateway.js'))});
      const options = ${JSON.stringify(options())};
      options.controllerUpstream = () => ({ hostname: '127.0.0.1', port: ${upstreams.controllerPort} });
      const server = createGateway(options);
      const edge = createEdge(server, options);
      server.on('close', () => console.log('server closed'));
      process.once('SIGTERM', () => {
        drain(server, edge, ${DRAIN_BOUND_MS}).then((result) => {
          console.log('drain: ' + result);
          setTimeout(() => process.exit(0), 50);
        });
      });
      edge.listen(${port}, '127.0.0.1');
    `;
    const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      await within(listening(port), 5_000, `the gateway process to listen\n${output}`);
      const drained = within(
        (async () => {
          for (;;) {
            const match = /drain: (\w+)/.exec(output);
            if (match) return match[1] as string;
            await Bun.sleep(5);
          }
        })(),
        5_000,
        `the Node drain to finish\n${output}`,
      );
      // Not awaited until the scenario reads it, after SIGTERM.
      drained.catch(() => {});
      await edgeDrainScenario(
        {
          port,
          terminate: () => child.kill('SIGTERM'),
          drained,
          serverClosed: () => output.includes('server closed'),
        },
        upstreams,
        opened,
      );
      expect(await within(exited, 2_000, `the process to exit\n${output}`)).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

/**
 * routeAliases rollout scenario (#223): requests to an aliased route succeed during a gateway
 * drain triggered by a rollout.
 */
describe('routeAliases during SIGTERM drain (#223)', () => {
  let upstream: Server;
  let upstreamPort: number;
  let held: Promise<void>;
  let release: () => void;

  beforeEach(async () => {
    let seen: () => void = () => {};
    held = new Promise((resolve) => {
      seen = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    upstream = createServer((req, res) => {
      const answer = (body: string) => {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      };
      if (req.url === '/slow') {
        seen();
        void released.then(() => answer('slow done'));
        return;
      }
      answer('fast');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as { port: number }).port;
  });

  afterEach(async () => {
    release();
    for (const socket of Array.from((upstream.connections ?? []) as unknown as Set<Socket>)) {
      socket.destroy();
    }
    await new Promise((resolve) => upstream.close(resolve));
  });

  it('routes requests to aliased tenant during drain', async () => {
    const signals = new EventEmitter();
    let exited: (code: number) => void = () => {};
    const exit = new Promise<number>((resolve) => {
      exited = resolve;
    });

    const server = main(
      {
        GATEWAY_CONFIG: JSON.stringify({
          port: 0,
          defaultUpstream: `127.0.0.1:${upstreamPort}`,
          tenantUpstream: (_tenant: string) => ({
            hostname: '127.0.0.1',
            port: upstreamPort,
          }),
          routeAliases: { 'api.alpha': 'api.beta' }, // alpha.api -> beta.api
          drainTimeoutMs: 5_000,
        }),
      },
      signals,
      (code) => {
        exited(code);
      },
    );

    await within(
      new Promise((resolve) => server.once('listening', resolve)),
      2_000,
      'the gateway to listen',
    );
    const port = (server.address() as { port: number }).port;

    const clients: Client[] = [];
    try {
      // Request to the aliased route should reach the upstream.
      const aliasedClient = new Client(port);
      clients.push(aliasedClient);
      await within(aliasedClient.connected(), 2_000, 'aliased client to connect');

      // Make a request through the alias (api.alpha.localhost -> api.beta.localhost).
      const firstRes = await within(aliasedClient.get('/'), 2_000, 'first aliased response');
      expect(firstRes.body).toBe('fast');

      // Now make a slow request on a second client.
      const slowClient = new Client(port);
      clients.push(slowClient);
      await within(slowClient.connected(), 2_000, 'slow client to connect');
      const slowPromise = slowClient.get('/slow');
      await within(held, 2_000, 'the upstream to receive /slow');

      // Trigger SIGTERM (simulating the rollout).
      signals.emit('SIGTERM');

      // New connections should be refused.
      await within(
        (async () => {
          while (!(await refused(port))) await Bun.sleep(10);
        })(),
        2_000,
        'the listener to close',
      );

      // The slow request should still complete successfully.
      release();
      const slowRes = await within(slowPromise, 2_000, 'the slow response');
      expect(slowRes.status).toBe(200);
      expect(slowRes.body).toBe('slow done');
      expect(slowRes.headers.connection).toBe('close');

      // The gateway should exit.
      expect(await within(exit, 2_000, 'the gateway to exit')).toBe(0);
    } finally {
      for (const c of clients) c.socket.destroy();
    }
  });
});

describe('gateway defaultUpstream (#223)', () => {
  it('takes a bare host as port 80, or host:port', () => {
    expect(defaultUpstreamOf('wasmcloud-http.wasmcloud.svc.cluster.local')).toEqual({
      hostname: 'wasmcloud-http.wasmcloud.svc.cluster.local',
      port: 80,
    });
    expect(defaultUpstreamOf('127.0.0.1:1')).toEqual({ hostname: '127.0.0.1', port: 1 });
    expect(defaultUpstreamOf('127.0.0.1:65535')).toEqual({ hostname: '127.0.0.1', port: 65_535 });
  });

  it.each(['0', '65536', '99999', '000000'])('refuses to start with port %s', (port) => {
    const env = { GATEWAY_CONFIG: JSON.stringify({ port: 0, defaultUpstream: `h:${port}` }) };
    expect(() => main(env)).toThrow(
      `GATEWAY_CONFIG defaultUpstream port must be between 1 and 65535; received ${port}`,
    );
  });
});
