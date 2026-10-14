import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { main } from '../src/gateway/gateway';

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
    try {
      await within(listening(port), 5_000, `the gateway process to listen\n${output}`);
      busy = new Client(port);
      await within(busy.connected(), 2_000, 'the client to connect');
      const slow = busy.get('/slow');
      await within(held, 2_000, 'the upstream to receive /slow');

      child.kill('SIGTERM');
      await within(
        (async () => {
          while (!(await refused(port))) await Bun.sleep(10);
        })(),
        2_000,
        'the listener to close',
      );
      expect(child.exitCode).toBeNull();

      release();
      const res = await within(slow, 2_000, 'the in-flight response');
      expect(res.body).toBe('ok');
      expect(res.headers.connection).toBe('close');
      expect(await within(exited, 5_000, `the process to exit\n${output}`)).toBe(0);
      expect(output).toContain('SIGTERM: drained, exiting');
    } finally {
      release();
      busy?.socket.destroy();
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
