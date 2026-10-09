import { expect, test } from 'bun:test';
import { ControllerError, createClient, type DeployBundle } from '../src/client/index.ts';
import { fakeFetch, sse } from './support/fake-fetch.ts';

const bundle: DeployBundle = {
  env: 'prod',
  service: 'web',
  component: { reference: 'registry/web:1', digest: 'sha256:abc' },
  workload: { kind: 'WorkloadDeployment' },
  bindings: [{ name: 'db', capability: 'postgres', serviceName: 'orders' }],
  secrets: ['API_TOKEN'],
};

test('every operation hits its contract path with the bearer and the right body', async () => {
  const noContent = () => new Response(null, { status: 204 });
  const { fetch, calls } = fakeFetch({
    'GET /v1/auth/info': () => Response.json({ account: 'acme', issuer: 'i', clientId: 'c' }),
    'GET /v1/auth/whoami': () =>
      Response.json({ user: 'alice', account: 'acme', role: 'developer', via: 'identity' }),
    'POST /v1/auth/logout': noContent,
    'POST /v1/deploy/preview': () => Response.json({ env: 'prod', service: 'web', changes: [] }),
    'POST /v1/deploy': () => Response.json({ id: 'd1' }, { status: 202 }),
    'POST /v1/services': () => Response.json({ name: 'web' }, { status: 201 }),
    'POST /v1/services/web%20app/proxy': () =>
      Response.json({ url: 'wss://x', port: 8080 }, { status: 201 }),
    'GET /v1/deployments': () => Response.json({ items: [] }),
    'GET /v1/deployments/stats': () => Response.json({ services: 1 }),
    'POST /v1/deployments/rollback': () => Response.json({ id: 'd0' }, { status: 202 }),
    'GET /v1/secrets': () => Response.json({ env: 'prod', items: [] }),
    'PUT /v1/secrets/TOKEN': noContent,
    'PATCH /v1/secrets/TOKEN': noContent,
    'DELETE /v1/secrets/TOKEN': noContent,
    'GET /v1/vars': () => Response.json({ env: 'prod', items: [] }),
    'PUT /v1/vars/LEVEL': noContent,
    'PATCH /v1/vars/LEVEL': noContent,
    'DELETE /v1/vars/LEVEL': noContent,
  });
  const client = createClient({ baseUrl: 'https://controller.test/', token: 't0k', fetch });

  expect(await client.authInfo()).toEqual({ account: 'acme', issuer: 'i', clientId: 'c' });
  expect((await client.whoami()).user).toBe('alice');
  expect(await client.logout()).toBeUndefined();
  expect(await client.previewDeploy(bundle)).toEqual({ env: 'prod', service: 'web', changes: [] });
  expect((await client.deploy(bundle)).id).toBe('d1');
  expect((await client.createService({ env: 'prod', type: 'keyvalue', name: 'web' })).name).toBe(
    'web',
  );
  expect((await client.proxy('web app', { env: 'prod' })).port).toBe(8080);
  expect(await client.deployments({ env: 'prod', service: undefined })).toEqual({ items: [] });
  expect((await client.deploymentStats('prod')).services).toBe(1);
  expect((await client.rollback({ env: 'prod', service: 'web' })).id).toBe('d0');
  expect((await client.secrets('prod')).items).toEqual([]);
  await client.setSecret('prod', 'TOKEN', 's3');
  await client.updateSecret('prod', 'TOKEN', 's4');
  await client.unsetSecret('prod', 'TOKEN');
  expect((await client.vars('staging')).items).toEqual([]);
  await client.setVar('prod', 'LEVEL', 'debug');
  await client.updateVar('prod', 'LEVEL', 'info');
  await client.unsetVar('prod', 'LEVEL');

  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
    'GET https://controller.test/v1/auth/info',
    'GET https://controller.test/v1/auth/whoami',
    'POST https://controller.test/v1/auth/logout',
    'POST https://controller.test/v1/deploy/preview',
    'POST https://controller.test/v1/deploy',
    'POST https://controller.test/v1/services',
    'POST https://controller.test/v1/services/web%20app/proxy',
    'GET https://controller.test/v1/deployments?env=prod',
    'GET https://controller.test/v1/deployments/stats?env=prod',
    'POST https://controller.test/v1/deployments/rollback',
    'GET https://controller.test/v1/secrets?env=prod',
    'PUT https://controller.test/v1/secrets/TOKEN?env=prod',
    'PATCH https://controller.test/v1/secrets/TOKEN?env=prod',
    'DELETE https://controller.test/v1/secrets/TOKEN?env=prod',
    'GET https://controller.test/v1/vars?env=staging',
    'PUT https://controller.test/v1/vars/LEVEL?env=prod',
    'PATCH https://controller.test/v1/vars/LEVEL?env=prod',
    'DELETE https://controller.test/v1/vars/LEVEL?env=prod',
  ]);
  expect(calls[0]?.headers).toMatchObject({
    authorization: 'Bearer t0k',
    accept: 'application/json',
  });
  expect(calls[0]?.headers).not.toHaveProperty('content-type');
  expect(calls[4]).toMatchObject({ headers: { 'content-type': 'application/json' }, body: bundle });
  expect(calls[11]?.body).toEqual({ value: 's3' });
  expect(calls[13]?.body).toBeUndefined();
});

test('errors become ControllerError with the problem details when the body has them', async () => {
  const { fetch, calls } = fakeFetch({
    'GET /v1/auth/whoami': () =>
      Response.json(
        { title: 'Unauthorized', status: 401, detail: 'token expired' },
        { status: 401 },
      ),
    'GET /v1/auth/info': () => new Response('gateway timeout', { status: 504 }),
  });
  const client = createClient({ baseUrl: 'https://controller.test', fetch });
  const unauthorized = await client.whoami().catch((error: unknown) => error);
  expect(unauthorized).toBeInstanceOf(ControllerError);
  expect(unauthorized).toMatchObject({
    status: 401,
    message: 'token expired',
    problem: { title: 'Unauthorized' },
  });
  const timeout = (await client.authInfo().catch((error: unknown) => error)) as ControllerError;
  expect(timeout).toMatchObject({ status: 504, message: 'controller answered 504', problem: {} });
  expect(calls[0]?.headers).not.toHaveProperty('authorization');
});

test('logs streams log events and stops at end', async () => {
  const frames = [
    'event: log\ndata: {"timestamp":"t1","deployment":"d1","message":"one"}\n\n',
    'data: {"timestamp":"t2","deployment":"d1","message":"two"}\n\n',
    'event: heartbeat\ndata: {}\n\n',
    'event: end\ndata: \n\n',
    'event: log\ndata: {"timestamp":"t3","deployment":"d1","message":"after end"}\n\n',
  ].join('');
  const { fetch, calls } = fakeFetch({
    'GET /v1/services/web/logs': () => sse(frames),
    'GET /v1/services/quiet/logs': () => new Response(null, { status: 200 }),
  });
  const client = createClient({ baseUrl: 'https://controller.test', token: 't', fetch });
  const seen: string[] = [];
  for await (const event of client.logs('web', {
    env: 'prod',
    follow: true,
    tail: 5,
    since: undefined,
  })) {
    seen.push(event.message);
  }
  expect(seen).toEqual(['one', 'two']);
  expect(calls[0]).toMatchObject({
    url: 'https://controller.test/v1/services/web/logs?env=prod&follow=true&tail=5',
    headers: { accept: 'text/event-stream' },
  });
  const none: unknown[] = [];
  for await (const event of client.logs('quiet', { env: 'prod' })) none.push(event);
  expect(none).toEqual([]);
});
