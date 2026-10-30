import { afterAll, beforeAll, describe, expect, type Mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { caCertificate, leafCertificate } from '../../platform/src/tenancy/tls.ts';
import { configFromEnv as consoleConfig, main as consoleMain } from '../src/console.ts';
import { configFromEnv as controllerConfig, main as controllerMain } from '../src/controller.ts';
import { type FakeServer, json, serve } from './support/servers.ts';

/**
 * A TCP port that was free a moment ago, for the optional listeners, where `0` means "disabled".
 * The main listeners bind port `0` and the tests read the bound port from the returned server.
 */
function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port as number;
}

const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;

let log: Mock<typeof console.log>;
let issuer: FakeServer;
beforeAll(() => {
  log = spyOn(console, 'log').mockImplementation(() => {});
  issuer = serve(() => json({ error: 'starting' }, 503));
});
afterAll(() => {
  log.mockRestore();
  issuer.stop();
});

const audited = (event: string) =>
  log.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .find((entry) => entry.event === event);

/** The controller process entry point, with every listener it can bind. */
describe('controller main', () => {
  let dir: string;
  let api: FakeServer;
  let started: Awaited<ReturnType<typeof controllerMain>>;
  const ports = { whoami: 0, front: 0, pull: 0 };
  let mainPort: number;

  beforeAll(async () => {
    api = serve(() => json({}));
    dir = mkdtempSync(join(tmpdir(), 'controller-main-'));
    writeFileSync(
      join(dir, 'kubeconfig'),
      dump({
        'current-context': 'x',
        contexts: [{ name: 'x', context: { cluster: 'c', user: 'u' } }],
        clusters: [{ name: 'c', cluster: { server: api.url } }],
        users: [{ name: 'u', user: { token: 't' } }],
      }),
    );
    const ca = caCertificate('controller-main test CA', 1);
    const leaf = leafCertificate('localhost', ['localhost'], ['127.0.0.1'], 1, ca.cert, ca.key);
    writeFileSync(join(dir, 'tls.crt'), leaf.cert);
    writeFileSync(join(dir, 'tls.key'), leaf.key);
    for (const name of Object.keys(ports) as (keyof typeof ports)[]) ports[name] = freePort();
    started = await controllerMain(
      controllerConfig({
        TENANT_CONTROLLER_TENANT: 'acme',
        TENANT_CONTROLLER_HOST: '127.0.0.1',
        TENANT_CONTROLLER_PORT: '0',
        TENANT_CONTROLLER_KUBECONFIG: join(dir, 'kubeconfig'),
        TENANT_CONTROLLER_ISSUER: issuer.url,
        TENANT_CONTROLLER_TLS_CERT: join(dir, 'tls.crt'),
        TENANT_CONTROLLER_TLS_KEY: join(dir, 'tls.key'),
        TENANT_CONTROLLER_WHOAMI_PORT: String(ports.whoami),
        TENANT_CONTROLLER_REGISTRY_HOST: 'registry',
        TENANT_CONTROLLER_REGISTRY_FRONT_PORT: String(ports.front),
        TENANT_CONTROLLER_REGISTRY_PULL_PORT: String(ports.pull),
        TENANT_CONTROLLER_REGISTRY_PULL_TLS: 'false',
      }),
    );
    mainPort = started.server.port as number;
  });

  afterAll(async () => {
    started.controller.stop();
    started.server.stop(true);
    await started.whoami?.stop();
    await started.registryFront?.stop();
    await started.registryPull?.stop();
    api.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('serves the API over TLS on the configured port', async () => {
    const health = await fetch(`https://127.0.0.1:${mainPort}/-/healthz`, insecure);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, tenant: 'acme' });
  });

  test('binds the whoami listener over TLS', async () => {
    expect(started.whoami?.port).toBe(ports.whoami);
    const other = await fetch(`https://127.0.0.1:${ports.whoami}/elsewhere`, insecure);
    expect(other.status).toBe(404);
    expect(await other.text()).toContain('serves only GET /v1/auth/whoami');
  });

  test('binds the registry front over TLS and the host pull listener over plain HTTP', async () => {
    expect(started.registryFront?.port).toBe(ports.front);
    expect(started.registryPull?.port).toBe(ports.pull);
  });

  test('the registry front challenges an unauthenticated request for any method', async () => {
    for (const method of ['GET', 'POST']) {
      const front = await fetch(`https://127.0.0.1:${ports.front}/v2/`, { ...insecure, method });
      expect(front.status).toBe(401);
      expect(front.headers.get('www-authenticate')).toBe(
        'Basic realm="di-framework-tenant-registry"',
      );
    }
  });

  test('the host pull listener refuses a write method', async () => {
    const pull = await fetch(`http://127.0.0.1:${ports.pull}/v2/`, { method: 'POST' });
    expect(pull.status).toBe(405);
    expect(pull.headers.get('allow')).toBe('GET, HEAD');
  });

  test('audits the start with every listener', () => {
    expect(audited('controller.started')).toMatchObject({
      url: 'https://127.0.0.1:0',
      issuer: issuer.url,
      cluster: api.url,
      namespaces: ['di-tenant-acme', 'di-runtime-acme'],
      whoamiPort: ports.whoami,
      registryFrontPort: ports.front,
      registryPullPort: ports.pull,
    });
  });

  test('binds only the main listener, over plain HTTP, without TLS or extra ports', async () => {
    const plain = await controllerMain(
      controllerConfig({
        TENANT_CONTROLLER_TENANT: 'acme',
        TENANT_CONTROLLER_HOST: '127.0.0.1',
        TENANT_CONTROLLER_PORT: '0',
        TENANT_CONTROLLER_KUBECONFIG: join(dir, 'kubeconfig'),
        TENANT_CONTROLLER_ISSUER: issuer.url,
      }),
    );
    try {
      expect(plain.whoami).toBeUndefined();
      expect(plain.registryFront).toBeUndefined();
      expect(plain.registryPull).toBeUndefined();
      expect((await fetch(`http://127.0.0.1:${plain.server.port}/-/healthz`)).status).toBe(200);
    } finally {
      plain.controller.stop();
      plain.server.stop(true);
    }
  });
});

/** The console process entry point. */
describe('console main', () => {
  test('serves on the configured port and audits the start while discovery is pending', async () => {
    const started = await consoleMain(
      consoleConfig({
        TENANT_CONSOLE_TENANT: 'acme',
        TENANT_CONSOLE_CLIENT_SECRET: 's',
        TENANT_CONSOLE_HOST: '127.0.0.1',
        TENANT_CONSOLE_PORT: '0',
        TENANT_CONSOLE_ISSUER: issuer.url,
      }),
    );
    try {
      const health = await fetch(`http://127.0.0.1:${started.server.port}/healthz`);
      expect(await health.json()).toEqual({ ok: true, tenant: 'acme', discoveryReady: false });
      expect(audited('console.started')).toMatchObject({
        url: 'http://127.0.0.1:0',
        issuer: issuer.url,
        discoveryReady: false,
      });
    } finally {
      started.app.stop();
      started.server.stop(true);
    }
  });
});
