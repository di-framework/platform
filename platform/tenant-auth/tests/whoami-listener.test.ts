import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caCertificate, leafCertificate } from '../../platform/src/tenancy/tls.ts';
import {
  Controller,
  configFromEnv,
  HOST_PULL_USER,
  serveWhoamiListener,
} from '../src/controller.ts';
import { AuthError } from '../src/identity.ts';
import type { RegistryListener } from '../src/registry-listener.ts';

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
      await expect(call(true, listener.port)).rejects.toThrow();
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
});
