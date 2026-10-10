import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
} from 'node:http';
import {
  connect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import {
  createServer as createTlsServer,
  type Server as TlsServer,
  connect as tlsConnect,
} from 'node:tls';
import {
  consoleUpstream,
  controllerUpstream,
  createEdge,
  createGateway,
  endToEndHeaders,
  type GatewayOptions,
  main,
  routeRequest,
  serverName,
  tenantUpstream,
  upstreamHeaders,
} from '../src/gateway/gateway';
import { validName } from '../src/tenancy/resources';
import { selfSignedCertificate } from '../src/tenancy/tls';

describe('routeRequest', () => {
  it('routes <route-host>.<tenant>.localhost to the tenant with the route host', () => {
    expect(routeRequest('mesh-site.meshtastic.localhost')).toEqual({
      kind: 'tenant',
      tenant: 'meshtastic',
      host: 'mesh-site',
    });
    expect(routeRequest('mesh-site.meshtastic.localhost:28180')).toEqual({
      kind: 'tenant',
      tenant: 'meshtastic',
      host: 'mesh-site',
    });
  });

  it('keeps every label before the tenant as the route host, never a fixed host list', () => {
    expect(routeRequest('api.v2.shop.alpha.localhost:80')).toEqual({
      kind: 'tenant',
      tenant: 'alpha',
      host: 'api.v2.shop',
    });
    expect(routeRequest('any_thing.alpha.localhost')).toMatchObject({ host: 'any_thing' });
  });

  it('is case-insensitive and accepts a fully qualified trailing dot', () => {
    expect(routeRequest('Mesh-Site.MeshTastic.LOCALHOST.:1')).toEqual({
      kind: 'tenant',
      tenant: 'meshtastic',
      host: 'mesh-site',
    });
  });

  it('sends every other host to the default host group', () => {
    for (const host of [
      'localhost',
      'localhost:28180',
      'meshtastic.localhost',
      'meshtastic.localhost:28180',
      '127.0.0.1:28180',
      '127.0.0.1',
      'example.com',
      'mesh-site.meshtastic.example.com',
      'mesh-site.meshtastic.localhost.example',
      '[::1]',
      '[::1]:28180',
    ])
      expect(routeRequest(host)).toEqual({ kind: 'default' });
  });

  it('only treats a valid tenant name as a tenant', () => {
    for (const host of [
      'site.1alpha.localhost',
      'site.al--pha.localhost',
      'site.al_pha.localhost',
      `site.${'a'.repeat(41)}.localhost`,
    ]) {
      expect(routeRequest(host)).toEqual({ kind: 'default' });
      const tenant = host.split('.')[1];
      expect(validName(tenant)).toBe(false);
    }
    const longest = `site.${'a'.repeat(40)}.localhost`;
    expect(routeRequest(longest)).toMatchObject({ kind: 'tenant', tenant: 'a'.repeat(40) });
  });

  it('rejects missing and malformed Host headers', () => {
    for (const host of [
      undefined,
      '',
      '.meshtastic.localhost',
      'mesh..meshtastic.localhost',
      'mesh site.meshtastic.localhost',
      '-site.meshtastic.localhost',
      'site-.meshtastic.localhost',
      'site.meshtastic-.localhost',
      'site.meshtastic.localhost:',
      'site.meshtastic.localhost:99999',
      'site.meshtastic.localhost:1:2',
      'site.meshtastic.localhost:abc',
      'user@site.meshtastic.localhost',
      'site.meshtastic.localhost/path',
      `${'a'.repeat(64)}.meshtastic.localhost`,
      `${'a.'.repeat(120)}meshtastic.localhost`,
      '[::1',
      '[::1]:x',
      '[zz]',
    ])
      expect(routeRequest(host).kind).toBe('invalid');
    expect(routeRequest(undefined)).toEqual({ kind: 'invalid', reason: 'missing Host header' });
  });
});

describe('header handling', () => {
  it('names the tenant runtime di-http Service as the only tenant upstream', () => {
    expect(tenantUpstream('meshtastic')).toEqual({
      hostname: 'di-http.di-runtime-meshtastic.svc.cluster.local',
      port: 80,
    });
  });

  it('drops hop-by-hop headers and those named by Connection', () => {
    expect(
      endToEndHeaders({
        connection: 'keep-alive, X-Secret',
        'keep-alive': 'timeout=5',
        'x-secret': '1',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        te: 'trailers',
        'proxy-authorization': 'Basic x',
        'set-cookie': ['a=1', 'b=2'],
        'content-type': 'text/plain',
      }),
    ).toEqual({ 'set-cookie': ['a=1', 'b=2'], 'content-type': 'text/plain' });
    expect(endToEndHeaders({ accept: '*/*', missing: undefined })).toEqual({ accept: '*/*' });
  });

  it('overwrites the forwarding headers', () => {
    const req = {
      headers: {
        host: 'site.alpha.localhost:28180',
        'x-forwarded-for': '10.0.0.1',
        'x-forwarded-host': 'evil',
        'x-forwarded-proto': 'https',
        forwarded: 'for=10.0.0.1',
        accept: '*/*',
      } as IncomingHttpHeaders,
      socket: { remoteAddress: '192.0.2.7' },
    } as unknown as IncomingMessage;
    expect(upstreamHeaders(req, { kind: 'tenant', tenant: 'alpha', host: 'site' })).toEqual({
      host: 'site',
      accept: '*/*',
      'x-forwarded-for': '192.0.2.7',
      'x-forwarded-host': 'site.alpha.localhost:28180',
      'x-forwarded-proto': 'http',
    });
    const closed = { ...req, socket: {} } as unknown as IncomingMessage;
    expect(upstreamHeaders(closed, { kind: 'default' })).toMatchObject({
      host: 'site.alpha.localhost:28180',
      'x-forwarded-for': '',
    });
  });
});

type Seen = { url?: string; method?: string; headers: IncomingHttpHeaders; body: string };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

function send(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: string[] },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/',
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    for (const chunk of options.body ?? []) req.write(chunk);
    req.end();
  });
}

/** Write a raw request and collect the whole raw response until the gateway closes it. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => {
      socket.destroy();
      resolve(data);
    });
    socket.on('error', reject);
  });
}

describe('gateway proxy', () => {
  let upstream: Server;
  let gateway: Server;
  let upstreamPort: number;
  let port: number;
  const seen: Seen[] = [];
  const tenants: string[] = [];
  const sockets = new Set<Socket>();
  let log: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    seen.length = 0;
    tenants.length = 0;
    log = spyOn(console, 'error').mockImplementation(() => {});
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, headers: req.headers, body });
        if (req.url === '/stream') {
          res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] });
          res.write('one,');
          setTimeout(() => res.end('two'), 20);
          return;
        }
        if (req.url === '/slow') return;
        if (req.url === '/break') {
          res.writeHead(200);
          res.write('partial');
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        res.writeHead(201, { 'x-upstream': 'yes', connection: 'keep-alive' });
        res.end(`hello ${req.headers.host}`);
      });
    });
    upstream.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    upstream.on('upgrade', (req, socket, head) => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body: String(head) });
      if (req.url === '/refuse') {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\nX-Why: nope\r\n\r\nno way');
        return;
      }
      if (req.url === '/slow') return;
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n',
      );
      socket.write('welcome;');
      socket.on('data', (chunk) => socket.write(`echo:${chunk}`));
    });
    upstreamPort = await listen(upstream);
    gateway = createGateway({
      defaultUpstream: { hostname: '127.0.0.1', port: upstreamPort },
      tenantUpstream: (tenant) => {
        tenants.push(tenant);
        return { hostname: '127.0.0.1', port: upstreamPort };
      },
      upstreamTimeoutMs: 200,
    });
    port = await listen(gateway);
  });

  afterEach(async () => {
    log.mockRestore();
    for (const socket of sockets) socket.destroy();
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });

  it('forwards a tenant route with the route host and forwarding headers', async () => {
    const res = await send(port, {
      path: '/a?b=1',
      headers: {
        host: 'mesh-site.meshtastic.localhost:28180',
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-host': 'spoofed',
        'x-forwarded-proto': 'https',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toBe('hello mesh-site');
    expect(res.headers['x-upstream']).toBe('yes');
    expect(tenants).toEqual(['meshtastic']);
    expect(seen[0]).toMatchObject({ url: '/a?b=1', method: 'GET' });
    expect(seen[0]?.headers).toMatchObject({
      host: 'mesh-site',
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': 'mesh-site.meshtastic.localhost:28180',
      'x-forwarded-proto': 'http',
    });
  });

  it('sends other hosts to the default upstream with Host unchanged', async () => {
    const res = await send(port, { headers: { host: '127.0.0.1:28180' } });
    expect(res.body).toBe('hello 127.0.0.1:28180');
    expect(tenants).toEqual([]);
    expect(seen[0]?.headers['x-forwarded-host']).toBe('127.0.0.1:28180');
  });

  it('streams request and response bodies', async () => {
    const res = await send(port, {
      path: '/stream',
      method: 'POST',
      headers: { host: 'site.alpha.localhost' },
      body: ['first ', 'second'],
    });
    expect(res.body).toBe('one,two');
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(seen[0]?.body).toBe('first second');
    expect(seen[0]?.headers['transfer-encoding']).toBe('chunked');
  });

  it('answers 400 for a malformed Host or request target', async () => {
    const bad = await send(port, { headers: { host: 'bad host.alpha.localhost' } });
    expect(bad.status).toBe(400);
    expect(bad.body).toBe('Bad Request: malformed Host header\n');
    const missing = await raw(port, 'GET / HTTP/1.0\r\n\r\n');
    expect(missing).toStartWith('HTTP/1.1 400 Bad Request');
    expect(missing).toContain('missing Host header');
    const absolute = await raw(
      port,
      'GET http://site.alpha.localhost/ HTTP/1.1\r\nHost: site.alpha.localhost\r\nConnection: close\r\n\r\n',
    );
    expect(absolute).toContain('malformed request target');
    expect(seen).toEqual([]);
  });

  it('answers 502 when the upstream is unreachable', async () => {
    const closed = createServer();
    const deadPort = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const unreachable = createGateway({
      defaultUpstream: { hostname: '127.0.0.1', port: deadPort },
    });
    const gatewayPort = await listen(unreachable);
    try {
      const res = await send(gatewayPort, { headers: { host: 'other.example' } });
      expect(res.status).toBe(502);
      expect(res.body).toBe('Bad Gateway\n');
    } finally {
      await new Promise((resolve) => unreachable.close(resolve));
    }
  });

  it('answers 504 when the upstream stays silent', async () => {
    const res = await send(port, { path: '/slow', headers: { host: 'site.alpha.localhost' } });
    expect(res.status).toBe(504);
    expect(res.body).toBe('Gateway Timeout\n');
  });

  it('cuts the client response when the upstream fails mid-body', async () => {
    await expect(
      send(port, { path: '/break', headers: { host: 'site.alpha.localhost' } }),
    ).rejects.toThrow();
  });

  it('cancels the upstream request when the client goes away', async () => {
    const closed = new Promise<void>((resolve) => {
      upstream.once('request', (req: IncomingMessage) => req.socket.once('close', resolve));
    });
    const socket = connect(port, '127.0.0.1', () =>
      socket.write('GET /slow HTTP/1.1\r\nHost: site.alpha.localhost\r\n\r\n'),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await closed;
  });

  it('passes upgrades through in both directions', async () => {
    const text = await new Promise<string>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/ws',
        headers: { host: 'chat.alpha.localhost', connection: 'Upgrade', upgrade: 'echo' },
      });
      req.on('upgrade', (res, socket, head) => {
        let data = String(head);
        expect(res.statusCode).toBe(101);
        socket.on('data', (chunk) => {
          data += chunk;
          if (data.includes('echo:ping')) {
            socket.destroy();
            resolve(data);
          }
        });
        socket.write('ping');
      });
      req.on('error', reject);
      req.end();
    });
    expect(text).toBe('welcome;echo:ping');
    expect(seen[0]?.headers).toMatchObject({
      host: 'chat',
      connection: 'Upgrade',
      upgrade: 'echo',
      'x-forwarded-proto': 'http',
    });
  });

  it('forwards bytes the client sent along with the upgrade request', async () => {
    const response = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () =>
        socket.write(
          'GET /ws HTTP/1.1\r\nHost: chat.alpha.localhost\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\nearly',
        ),
      );
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        data += chunk;
        if (data.includes('echo:early')) {
          socket.destroy();
          resolve(data);
        }
      });
    });
    expect(response).toStartWith('HTTP/1.1 101 Switching Protocols\r\n');
  });

  it('relays a declined upgrade and closes', async () => {
    const response = await raw(
      port,
      'GET /refuse HTTP/1.1\r\nHost: chat.alpha.localhost\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n',
    );
    expect(response).toStartWith('HTTP/1.1 403 Forbidden\r\n');
    expect(response).toContain('X-Why: nope\r\n');
    expect(response).toContain('connection: close\r\n');
    expect(response).toEndWith('\r\n\r\nno way');
  });

  it('rejects an upgrade with a malformed Host', async () => {
    const response = await raw(
      port,
      'GET /ws HTTP/1.1\r\nHost: bad host\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n',
    );
    expect(response).toBe('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    expect(seen).toEqual([]);
  });

  it('answers 502 or 504 when an upgrade cannot reach the upstream', async () => {
    const slow = await raw(
      port,
      'GET /slow HTTP/1.1\r\nHost: chat.alpha.localhost\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n',
    );
    expect(slow).toBe('HTTP/1.1 504 Gateway Timeout\r\nconnection: close\r\n\r\n');
    const closed = createServer();
    const deadPort = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const unreachable = createGateway({
      defaultUpstream: { hostname: '127.0.0.1', port: deadPort },
    });
    const gatewayPort = await listen(unreachable);
    try {
      const response = await raw(
        gatewayPort,
        'GET / HTTP/1.1\r\nHost: example\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n',
      );
      expect(response).toBe('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n');
    } finally {
      await new Promise((resolve) => unreachable.close(resolve));
    }
  });

  it('closes the client when the upgraded upstream connection drops', async () => {
    const ended = new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () =>
        socket.write(
          'GET /ws HTTP/1.1\r\nHost: chat.alpha.localhost\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n',
        ),
      );
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        data += chunk;
        if (data.includes('welcome;')) for (const s of sockets) s.destroy();
      });
      socket.on('close', () => resolve(data));
    });
    expect(await ended).toContain('welcome;');
  });
});

describe('gateway process', () => {
  it('requires its configuration', () => {
    expect(() => main({})).toThrow('Missing GATEWAY_CONFIG');
  });

  it('listens on the configured port and stops on SIGTERM', async () => {
    const signals = new EventEmitter();
    const server = main(
      {
        GATEWAY_CONFIG: JSON.stringify({ port: 0, defaultUpstream: '127.0.0.1' }),
      },
      signals,
    );
    await new Promise((resolve) => server.once('listening', resolve));
    expect(server.listening).toBe(true);
    expect(server.headersTimeout).toBe(30_000);
    expect(server.requestTimeout).toBe(300_000);
    const closed = new Promise((resolve) => server.once('close', resolve));
    signals.emit('SIGTERM');
    await closed;
    expect(server.listening).toBe(false);
  });
});

describe('tenant-auth routes (#58:routes)', () => {
  const pem = selfSignedCertificate('tenant-controller', ['controller.alpha.localhost'], [], 30);
  let upstream: Server;
  let controller: TlsServer;
  let gateway: Server;
  let edge: NetServer;
  let port: number;
  let upstreamPort: number;
  let controllerPort: number;
  const seen: IncomingHttpHeaders[] = [];
  let log: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    seen.length = 0;
    log = spyOn(console, 'error').mockImplementation(() => {});
    upstream = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      res.end(`upstream ${req.headers.host}`);
    });
    upstreamPort = await listen(upstream);
    controller = createTlsServer({ cert: pem.cert, key: pem.key }, (socket) =>
      socket.end('controller says hi'),
    );
    await new Promise<void>((resolve) => controller.listen(0, '127.0.0.1', resolve));
    controllerPort = (controller.address() as { port: number }).port;
    const options: GatewayOptions = {
      defaultUpstream: { hostname: '127.0.0.1', port: upstreamPort },
      tenantUpstream: () => ({ hostname: '127.0.0.1', port: upstreamPort }),
      tenantAuthRoutes: { console: 'console', controller: 'controller' },
      consoleUpstream: (tenant) => {
        expect(tenant).toBe('alpha');
        return { hostname: '127.0.0.1', port: upstreamPort };
      },
      controllerUpstream: (tenant) => {
        expect(tenant).toBe('alpha');
        return { hostname: '127.0.0.1', port: controllerPort };
      },
    };
    gateway = createGateway(options);
    edge = createEdge(gateway, options);
    port = await listen(edge as Server);
  });

  afterEach(async () => {
    log.mockRestore();
    gateway.closeAllConnections();
    gateway.close();
    await new Promise((resolve) => edge.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    controller.close();
  });

  /** TLS through the gateway; resolves with what the far end sent, or `closed`. */
  const tlsThrough = (servername?: string, target = port) =>
    new Promise<string>((resolve) => {
      const socket = tlsConnect({ host: '127.0.0.1', port: target, servername, ca: pem.cert });
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('error', () => resolve('closed'));
      socket.on('close', () => resolve(data || 'closed'));
    });

  it('names the in-cluster console and controller Services', () => {
    expect(consoleUpstream('alpha')).toEqual({
      hostname: 'tenant-console.di-runtime-alpha.svc.cluster.local',
      port: 8787,
    });
    expect(controllerUpstream('alpha')).toEqual({
      hostname: 'tenant-controller.di-runtime-alpha.svc.cluster.local',
      port: 8788,
    });
  });

  it('sends the console host to the console with its original Host', async () => {
    const res = await send(port, { headers: { host: 'console.alpha.localhost:28180' } });
    expect(res.body).toBe('upstream console.alpha.localhost:28180');
    expect(seen[0]?.['x-forwarded-host']).toBe('console.alpha.localhost:28180');
    // Other route hosts still reach the tenant workloads, and other hosts the default group.
    expect((await send(port, { headers: { host: 'site.alpha.localhost' } })).body).toBe(
      'upstream site',
    );
    expect((await send(port, { headers: { host: 'example.com' } })).body).toBe(
      'upstream example.com',
    );
  });

  it('serves the controller host over TLS only', async () => {
    const res = await send(port, { headers: { host: 'controller.alpha.localhost:28180' } });
    expect(res.status).toBe(400);
    expect(res.body).toContain('the controller host is served over TLS only');
  });

  it('passes TLS for the controller host through to the controller certificate', async () => {
    expect(await tlsThrough('controller.alpha.localhost')).toBe('controller says hi');
  });

  it('closes TLS for any other server name, or none', async () => {
    expect(await tlsThrough('console.alpha.localhost')).toBe('closed');
    expect(await tlsThrough('controller.example.com')).toBe('closed');
    expect(await tlsThrough(undefined)).toBe('closed');
  });

  it('reassembles a ClientHello split across reads', async () => {
    // Capture a real ClientHello, then replay it in pieces.
    const hello = await new Promise<Buffer>((resolve) => {
      const capture = createNetServer((socket) =>
        socket.once('data', (chunk: Buffer) => {
          socket.destroy();
          capture.close();
          resolve(chunk);
        }),
      );
      capture.listen(0, '127.0.0.1', () => {
        const client = tlsConnect({
          host: '127.0.0.1',
          port: (capture.address() as { port: number }).port,
          servername: 'controller.alpha.localhost',
        });
        client.on('error', () => {});
      });
    });
    expect(serverName(hello)).toBe('controller.alpha.localhost');
    const reply = await new Promise<number>((resolve) => {
      const socket = connect(port, '127.0.0.1', async () => {
        socket.write(hello.subarray(0, 3));
        await Bun.sleep(20);
        socket.write(hello.subarray(3, 40));
        await Bun.sleep(20);
        socket.write(hello.subarray(40));
      });
      socket.once('data', (chunk: Buffer) => {
        socket.destroy();
        resolve(chunk[0] as number);
      });
    });
    expect(reply).toBe(0x16); // the controller's ServerHello
  });

  it('closes the client when the controller is unreachable', async () => {
    await new Promise((resolve) => controller.close(resolve));
    controller = createTlsServer({});
    expect(await tlsThrough('controller.alpha.localhost')).toBe('closed');
    expect(log).toHaveBeenCalled();
  });

  it('finds no server name in a truncated record', () => {
    expect(serverName(Buffer.from([0x16, 3, 1, 0, 1, 1]))).toBeUndefined();
  });

  it('listens through the edge when the controller is routed, and stops on SIGTERM', async () => {
    const free = createNetServer();
    const target = await listen(free as Server);
    await new Promise((resolve) => free.close(resolve));
    const signals = new EventEmitter();
    const server = main(
      {
        GATEWAY_CONFIG: JSON.stringify({
          port: target,
          defaultUpstream: '127.0.0.1',
          tenantAuthRoutes: { controller: 'controller' },
        }),
      },
      signals,
    );
    expect(server.listening).toBe(false); // the edge listens in front of it
    await Bun.sleep(20);
    expect(await tlsThrough('other.alpha.localhost', target)).toBe('closed');
    signals.emit('SIGTERM');
    await Bun.sleep(20);
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect(target, '127.0.0.1');
      socket.on('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });
});
