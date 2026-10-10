import { afterAll, beforeAll, type Mock, spyOn } from 'bun:test';
import { Controller, configFromEnv } from '../../src/controller.ts';
import { AuthError, type Principal } from '../../src/identity.ts';
import { KubeClient } from '../../src/kube.ts';
import { type FakeServer, type Handler, json, serve } from './servers.ts';

export const alice: Principal = {
  user: 'alice',
  account: 'acme',
  role: 'developer',
  via: 'identity',
  credentialId: 's',
};
export const bob: Principal = { ...alice, user: 'bob', role: 'viewer' };

export interface ServedController {
  /** The fake Kubernetes API server behind the controller. */
  api: FakeServer;
  /** Base URL of the served controller. */
  base: string;
  /** The `console.log` spy, installed for the duration of the enclosing `describe`. */
  log: Mock<typeof console.log>;
}

/**
 * Serves a Controller for tenant `acme` over real HTTP in front of a fake API server, with a fake
 * resolver that maps each `Bearer <key>` of `principals` to its principal (anything else is a 401).
 * Registers `beforeAll`/`afterAll` in the calling `describe` to spy on `console.log` and tear down.
 */
export function servedController(options: {
  env?: Record<string, string>;
  api?: Handler;
  principals: Record<string, Principal>;
}): ServedController {
  const api = serve(options.api ?? (() => json({})));
  const kube = new KubeClient({ server: api.url, token: 'admin' }, 'wasmcloud');
  const controller = new Controller(
    configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme', ...options.env }),
    kube,
    { issuer: 'https://issuer.test' } as never,
    {
      resolve: async (authorization: string | null) => {
        const bearer = authorization?.replace(/^Bearer /, '');
        if (bearer && Object.hasOwn(options.principals, bearer)) return options.principals[bearer];
        throw new AuthError(401, 'a bearer token is required');
      },
      forget: () => {},
    } as never,
    { kube, namespace: 'di-runtime-acme', tenant: 'acme' },
  );
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => controller.handle(r) });
  const served = { api, base: `http://127.0.0.1:${server.port}` } as ServedController;
  beforeAll(() => {
    served.log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => {
    served.log.mockRestore();
    server.stop(true);
    api.stop();
  });
  return served;
}
