import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { Controller, configFromEnv } from '../src/controller.ts';
import { type FakeServer, json, serve } from './support/servers.ts';

/** Polls until `condition` holds; fails the test (by throwing) after `timeoutMs`. */
async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * platform#225: the listeners bind before the issuer answers. Drives the real `Controller.start`
 * against an issuer that is down first and comes up later, over real HTTP listeners.
 */
describe('Controller.start with the issuer unreachable at first', () => {
  const HOST_PULL = 'host-pull-secret';
  let issuerUp = false;
  let issuer: FakeServer;
  let api: FakeServer;
  let dir: string;
  let controller: Controller;
  let main: ReturnType<typeof Bun.serve>;
  let whoami: ReturnType<typeof Bun.serve>;
  let startedIn: number;
  let startedWithoutProvider: boolean;

  const mainCall = (path: string) => fetch(`http://127.0.0.1:${main.port}${path}`);
  const whoamiCall = (authorization: string) =>
    fetch(`http://127.0.0.1:${whoami.port}/v1/auth/whoami`, { headers: { authorization } });

  beforeAll(async () => {
    issuer = serve((request) => {
      if (!issuerUp) return json({ error: 'starting' }, 503);
      if (request.pathname === '/.well-known/openid-configuration')
        return json({
          issuer: issuer.url,
          authorization_endpoint: `${issuer.url}/a`,
          token_endpoint: `${issuer.url}/t`,
          jwks_uri: `${issuer.url}/j`,
          userinfo_endpoint: `${issuer.url}/userinfo`,
        });
      return json({}, 401); // userinfo: the token is not valid
    });
    api = serve(() => json({}));
    dir = mkdtempSync(join(tmpdir(), 'discovery-pending-'));
    writeFileSync(
      join(dir, 'kubeconfig'),
      dump({
        'current-context': 'x',
        contexts: [{ name: 'x', context: { cluster: 'c', user: 'u' } }],
        clusters: [{ name: 'c', cluster: { server: api.url } }],
        users: [{ name: 'u', user: { token: 't' } }],
      }),
    );
    writeFileSync(join(dir, 'host-pull'), HOST_PULL);

    const began = performance.now();
    controller = await Controller.start({
      ...configFromEnv({
        TENANT_CONTROLLER_TENANT: 'acme',
        TENANT_CONTROLLER_KUBECONFIG: join(dir, 'kubeconfig'),
        TENANT_CONTROLLER_ISSUER: issuer.url,
        TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE: join(dir, 'host-pull'),
      }),
      discoveryBackoff: { initialMs: 10, maxMs: 40 },
    });
    startedIn = performance.now() - began;
    startedWithoutProvider = controller.provider === null;
    main = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, server) => controller.handle(request, server),
    });
    whoami = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => controller.handleWhoami(request),
    });
  });

  afterAll(() => {
    controller.stop();
    main.stop(true);
    whoami.stop(true);
    issuer.stop();
    api.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('start returns without waiting for the issuer, and the listeners bind', () => {
    expect(startedWithoutProvider).toBe(true);
    // A start that awaited discovery would never return while the issuer is down.
    expect(startedIn).toBeLessThan(1_000);
    expect(main.port).toBeGreaterThan(0);
    expect(whoami.port).toBeGreaterThan(0);
  });

  test('issuer-dependent routes answer 503 with Retry-After while discovery is pending', async () => {
    const health = await mainCall('/-/healthz');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, discoveryReady: false });

    const info = await mainCall('/v1/auth/info');
    expect(info.status).toBe(503);
    expect(Number(info.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    const authed = await fetch(`http://127.0.0.1:${main.port}/-/whoami`, {
      headers: { authorization: 'Bearer an-identity-access-token' },
    });
    expect(authed.status).toBe(503);
    expect(Number(authed.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    const identityToken = await whoamiCall('Bearer an-identity-access-token');
    expect(identityToken.status).toBe(503);
    expect(Number(identityToken.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(identityToken.headers.get('content-type')).toContain('problem+json');
  });

  test('the issuer-independent host pull token is accepted while pending', async () => {
    const response = await whoamiCall(`Bearer ${HOST_PULL}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ via: 'host-pull', account: 'acme' });
  });

  test('the same controller recovers when the issuer comes up, without a restart', async () => {
    issuerUp = true;
    await controller.discovered;
    await eventually(() => controller.provider !== null);

    const info = await mainCall('/v1/auth/info');
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ account: 'acme', issuer: issuer.url });

    // The identity token now reaches the issuer (which rejects it) rather than getting a 503.
    expect((await whoamiCall('Bearer an-identity-access-token')).status).toBe(401);
    expect(
      ((await (await mainCall('/-/healthz')).json()) as { discoveryReady: boolean }).discoveryReady,
    ).toBe(true);
  });

  test('stop() ends discovery for a controller whose issuer never answers', async () => {
    const down = await Controller.start({
      ...configFromEnv({
        TENANT_CONTROLLER_TENANT: 'acme',
        TENANT_CONTROLLER_KUBECONFIG: join(dir, 'kubeconfig'),
        TENANT_CONTROLLER_ISSUER: 'http://127.0.0.1:1',
      }),
      discoveryBackoff: { initialMs: 10, maxMs: 40 },
    });
    expect(down.provider).toBeNull();
    down.stop();
    await down.discovered;
    expect(down.provider).toBeNull();
  });
});
