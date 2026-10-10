import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, configFromEnv, HOST_PULL_USER } from '../src/controller.ts';
import { AuthError } from '../src/identity.ts';
import { serve } from './support/servers.ts';

/** The host pull credential and the hosts' pull-only listener (platform#83 `:host-pull`). */
describe('host pull', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-pull-'));
  const tokenFile = join(dir, 'host-pull-token');
  const TOKEN = 'h'.repeat(43);
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const env = {
    TENANT_CONTROLLER_TENANT: 'acme',
    TENANT_CONTROLLER_WHOAMI_PORT: '8789',
    TENANT_CONTROLLER_REGISTRY_FRONT_PORT: '8790',
    TENANT_CONTROLLER_REGISTRY_PULL_PORT: '8791',
    TENANT_CONTROLLER_REGISTRY_HOST: 'registry',
    TENANT_CONTROLLER_REGISTRY_PULL_HOST: 'tenant-registry.di-runtime-acme.svc',
    TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE: tokenFile,
  };
  const resolved: (string | null)[] = [];
  const make = (overrides: Record<string, string | undefined> = {}) =>
    new Controller(
      configFromEnv({ ...env, ...overrides }),
      {} as never,
      { issuer: 'https://issuer.test' } as never,
      {
        // Users only: the identity resolver never knows the host token.
        resolve: async (authorization: string | null) => {
          resolved.push(authorization);
          throw new AuthError(401, 'the access token is invalid or has expired');
        },
        forget: () => {},
      } as never,
      {} as never,
    );
  const controller = make();
  const hosts = serve(
    (request) => new Response(`pulled ${request.method} ${request.path}`, { status: 200 }),
  );
  controller.proxyUpstream = () => hosts.url;
  let log: ReturnType<typeof spyOn>;
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => {
    log.mockRestore();
    hosts.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const whoami = (target: Controller, authorization?: string) =>
    target.handleWhoami(
      new Request('http://tenant-controller.di-runtime-acme.svc:8789/v1/auth/whoami', {
        headers: authorization ? { authorization } : {},
      }),
    );

  test('reads the pull listener, its scheme, the pull host and the token file from the environment', () => {
    expect(configFromEnv(env)).toMatchObject({
      registryPullPort: 8791,
      registryPullTls: true,
      registryPullHost: 'tenant-registry.di-runtime-acme.svc',
      hostPullTokenFile: tokenFile,
    });
    expect(
      configFromEnv({ ...env, TENANT_CONTROLLER_REGISTRY_PULL_TLS: 'false' }).registryPullTls,
    ).toBe(false);
    const defaults = configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' });
    expect(defaults.registryPullPort).toBeUndefined();
    expect(defaults.registryPullTls).toBe(true);
    expect(defaults.registryPullHost).toBeUndefined();
    expect(defaults.hostPullTokenFile).toBeUndefined();
    expect(() =>
      configFromEnv({
        TENANT_CONTROLLER_TENANT: 'acme',
        TENANT_CONTROLLER_REGISTRY_PULL_PORT: '0',
      }),
    ).toThrow('TENANT_CONTROLLER_REGISTRY_PULL_PORT must be a TCP port');
  });

  test('the whoami listener answers the host token as a pull-only (viewer) principal', async () => {
    const before = resolved.length;
    const response = await whoami(controller, `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: HOST_PULL_USER,
      account: 'acme',
      role: 'viewer',
      via: 'host-pull',
      credentialId: 'host-pull',
    });
    // Never handed to the identity resolver.
    expect(resolved.length).toBe(before);
  });

  test('anything but the exact token goes to the identity resolver', async () => {
    for (const authorization of [
      `Bearer ${TOKEN.slice(1)}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${'g'.repeat(43)}`,
      `Basic ${TOKEN}`,
      'Bearer',
    ]) {
      const response = await whoami(controller, authorization);
      expect(response.status).toBe(401);
      expect(resolved.at(-1)).toBe(authorization);
    }
    expect((await whoami(controller)).status).toBe(401);
  });

  test('the main listener never accepts the host token', async () => {
    const response = await controller.handle(
      new Request('https://tenant-controller:8788/v1/auth/whoami', {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(response.status).toBe(401);
    expect(resolved.at(-1)).toBe(`Bearer ${TOKEN}`);
  });

  test('a rotated token applies at once, and a missing or empty file accepts nothing', async () => {
    const rotated = 'r'.repeat(43);
    writeFileSync(tokenFile, rotated);
    try {
      expect((await whoami(controller, `Bearer ${rotated}`)).status).toBe(200);
      expect((await whoami(controller, `Bearer ${TOKEN}`)).status).toBe(401);
      writeFileSync(tokenFile, '\n');
      expect((await whoami(controller, 'Bearer ')).status).toBe(401);
      expect((await whoami(controller, `Bearer ${rotated}`)).status).toBe(401);
    } finally {
      writeFileSync(tokenFile, TOKEN);
    }
    const missing = make({ TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE: join(dir, 'absent') });
    expect((await whoami(missing, `Bearer ${TOKEN}`)).status).toBe(401);
    const unset = make({ TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE: undefined });
    expect((await whoami(unset, `Bearer ${TOKEN}`)).status).toBe(401);
  });

  test('the pull listener forwards GET and HEAD like the registry front', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await controller.handleRegistryPull(
        new Request('https://tenant-registry.di-runtime-acme.svc/v2/app/manifests/1.0', {
          method,
          headers: { authorization: `Basic ${btoa(`tenant-host:${TOKEN}`)}` },
        }),
      );
      expect(response.status).toBe(200);
      const seen = hosts.requests.at(-1)!;
      expect(seen.method).toBe(method);
      expect(seen.headers.get('host')).toBe('registry');
      expect(seen.headers.get('authorization')).toBe(`Basic ${btoa(`tenant-host:${TOKEN}`)}`);
    }
    expect(
      await (
        await controller.handleRegistryPull(
          new Request('https://tenant-registry.di-runtime-acme.svc/v2/app/manifests/1.0', {
            headers: { authorization: 'Basic eDpvaw==' },
          }),
        )
      ).text(),
    ).toBe('pulled GET /v2/app/manifests/1.0');
  });

  test('the pull listener refuses every write, whatever the credential', async () => {
    const before = hosts.requests.length;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await controller.handleRegistryPull(
        new Request('https://tenant-registry.di-runtime-acme.svc/v2/app/blobs/uploads/', {
          method,
          headers: { authorization: 'Basic eDpvaw==' },
          body: method === 'DELETE' ? undefined : 'layer-bytes',
        }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(response.headers.get('content-type')).toBe('application/problem+json');
    }
    expect(hosts.requests.length).toBe(before);
  });
});
