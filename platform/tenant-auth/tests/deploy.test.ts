import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { deployBundle } from '@di-framework/tenant-cli/tests/support/deploy-bundle.ts';
import { Controller, configFromEnv } from '../src/controller.ts';
import type { Principal } from '../src/identity.ts';
import { KubeClient } from '../src/kube.ts';
import { FIELD_MANAGER } from '../src/v1/deploy.ts';
import { json, type Recorded, serve } from './support/servers.ts';

const WORKLOADS =
  '/apis/runtime.wasmcloud.dev/v1alpha1/namespaces/di-tenant-acme/workloaddeployments';
const CORE = '/api/v1/namespaces/di-tenant-acme';
const BINDINGS =
  '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-acme/servicebindings';

type Json = Record<string, unknown>;

/**
 * The controller over real HTTP, in front of a fake API server that mints `di-user-*` tokens,
 * keeps applied objects, and answers a server-side apply with the object it would store.
 */
describe('/v1/deploy', () => {
  const stored = new Map<string, Json>();
  /** Answers the next PATCH with this status and message instead of applying it. */
  let refusal: { status: number; message: string } | undefined;
  /** Answers every request with 401, to show a rejected user token. */
  let rejectToken = false;
  /** Answers the next PATCH with this response instead of applying it. */
  let rawPatch: (() => Response) | undefined;
  const api = serve((request: Recorded) => {
    if (request.pathname.endsWith('/token'))
      return json({
        status: {
          token: `sa-${request.pathname.split('/').at(-2)}`,
          expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    if (rejectToken) return json({ message: 'Unauthorized' }, 401);
    if (request.method === 'GET') {
      const object = stored.get(request.pathname);
      return object ? json(object) : json({ message: 'not found' }, 404);
    }
    if (rawPatch) return rawPatch();
    if (refusal) return json({ message: refusal.message }, refusal.status);
    const object = JSON.parse(request.body) as Json;
    const previous = stored.get(request.pathname);
    const generation = ((previous?.metadata as Json | undefined)?.generation as number) ?? 0;
    const result = {
      ...object,
      metadata: { ...(object.metadata as Json), generation: generation + 1 },
    };
    if (!request.path.includes('dryRun=All')) stored.set(request.pathname, result);
    return json(result);
  });
  const alice: Principal = {
    user: 'alice',
    account: 'acme',
    role: 'developer',
    via: 'identity',
    credentialId: 's',
  };
  const kube = new KubeClient({ server: api.url, token: 'admin' }, 'wasmcloud');
  const controller = new Controller(
    configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
    kube,
    { issuer: 'https://issuer.test' } as never,
    { resolve: async () => alice, forget: () => {} } as never,
    { kube, namespace: 'di-runtime-acme', tenant: 'acme' },
  );
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => controller.handle(r) });
  const base = `http://127.0.0.1:${server.port}`;
  let log: ReturnType<typeof spyOn>;
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => {
    log.mockRestore();
    server.stop(true);
    api.stop();
  });
  beforeEach(() => {
    stored.clear();
    api.requests.length = 0;
    refusal = undefined;
    rejectToken = false;
    rawPatch = undefined;
    for (const env of ['prod', 'staging']) seedSecret('api-token', env);
  });

  /** Stores a tenant Secret as `/v1/secrets` writes it; `labels` replaces its labels. */
  const seedSecret = (name: string, env: string, labels?: Record<string, string>) =>
    stored.set(`${CORE}/secrets/${name}.${env}`, {
      metadata: {
        name: `${name}.${env}`,
        labels: labels ?? {
          'platform.di-framework.dev/config': 'secret',
          'platform.di-framework.dev/env': env,
          'platform.di-framework.dev/secret': name,
        },
      },
    });
  /** Stores an environment's vars ConfigMap as `/v1/vars` writes it. */
  const seedVars = (env: string, data: Record<string, string>, labels?: Record<string, string>) =>
    stored.set(`${CORE}/configmaps/di-vars-${env}`, {
      metadata: {
        name: `di-vars-${env}`,
        labels: labels ?? {
          'platform.di-framework.dev/config': 'vars',
          'platform.di-framework.dev/env': env,
        },
      },
      data,
    });
  const workloads = () => [...stored.keys()].filter((key) => key.startsWith(WORKLOADS));

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer ok', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const patches = () => api.requests.filter((r) => r.method === 'PATCH');

  test('applies the bindings, then the workload, as the caller with the namespace and host selector', async () => {
    const response = await post('/v1/deploy', deployBundle());
    expect(response.status).toBe(202);
    const deployment = (await response.json()) as Json;
    expect(deployment).toMatchObject({
      id: 'web-prod.1',
      service: 'web',
      env: 'prod',
      status: 'pending',
      component: deployBundle().component,
    });
    expect(typeof deployment.createdAt).toBe('string');

    const [binding, workload] = patches();
    for (const request of [binding, workload]) {
      expect(request?.path).toEndWith(`?fieldManager=${FIELD_MANAGER}`);
      expect(request?.headers.get('content-type')).toBe('application/apply-patch+yaml');
      expect(request?.headers.get('authorization')).toBe('Bearer sa-di-user-alice');
    }
    expect(binding?.pathname).toBe(`${BINDINGS}/web-prod-cache`);
    expect(JSON.parse(binding?.body ?? '')).toEqual({
      apiVersion: 'platform.di-framework.dev/v1alpha1',
      kind: 'ServiceBinding',
      metadata: {
        name: 'web-prod-cache',
        namespace: 'di-tenant-acme',
        labels: { 'di-framework.dev/service': 'web', 'platform.di-framework.dev/env': 'prod' },
      },
      spec: { serviceName: 'cache', bindingName: 'cache', capability: 'keyvalue' },
    });
    expect(workload?.pathname).toBe(`${WORKLOADS}/web-prod`);
    const applied = JSON.parse(workload?.body ?? '') as {
      metadata: Json;
      spec: { replicas: number; template: { spec: Json } };
    };
    expect(applied.metadata).toEqual({
      name: 'web-prod',
      namespace: 'di-tenant-acme',
      labels: { 'di-framework.dev/service': 'web', 'platform.di-framework.dev/env': 'prod' },
    });
    expect(applied.spec.replicas).toBe(1);
    expect(applied.spec.template.spec.environment).toBe('di-tenant-acme');
    expect(applied.spec.template.spec.hostSelector).toEqual({ hostgroup: 'tenant-acme' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"deploy.applied"'));
  });

  test('injects the vars ConfigMap and the named secrets into every component and the service', async () => {
    seedSecret('db', 'staging');
    seedVars('staging', { MODE: 'x' });
    const bundle = deployBundle({ env: 'staging', secrets: ['api-token', 'db'] });
    const template = (bundle.workload.spec as { template: { spec: Json } }).template.spec;
    const image = (template.components as Json[])[0]?.image;
    template.components = [
      { name: 'web', image, localResources: { environment: { config: { A: '1' } } } },
      { name: 'worker', image },
    ];
    template.service = { name: 'svc' };
    for (const path of ['/v1/deploy/preview', '/v1/deploy']) {
      expect((await post(path, bundle)).status).toBeLessThan(300);
      // Each named Secret was read as the caller before applying.
      for (const object of ['api-token.staging', 'db.staging'])
        expect(
          api.requests
            .find((r) => r.method === 'GET' && r.pathname === `${CORE}/secrets/${object}`)
            ?.headers.get('authorization'),
        ).toBe('Bearer sa-di-user-alice');
      const applied = JSON.parse(patches().at(-1)?.body ?? '') as {
        metadata: { labels: Json };
        spec: { template: { spec: { components: Json[]; service: Json } } };
      };
      const sources = {
        configFrom: [{ name: 'di-vars-staging' }],
        secretFrom: [{ name: 'api-token.staging' }, { name: 'db.staging' }],
      };
      expect(applied.metadata.labels['platform.di-framework.dev/env']).toBe('staging');
      expect(applied.spec.template.spec.components).toEqual([
        { name: 'web', image, localResources: { environment: { config: { A: '1' }, ...sources } } },
        { name: 'worker', image, localResources: { environment: sources } },
      ]);
      expect(applied.spec.template.spec.service).toEqual({
        name: 'svc',
        localResources: { environment: sources },
      });
      api.requests.length = 0;
    }
  });

  test('an environment without a vars ConfigMap gets no configFrom', async () => {
    expect((await post('/v1/deploy', deployBundle({ env: 'staging' }))).status).toBe(202);
    const applied = JSON.parse(patches().at(-1)?.body ?? '') as {
      spec: { template: { spec: { components: Json[] } } };
    };
    expect(applied.spec.template.spec.components[0]?.localResources).toEqual({
      environment: { secretFrom: [{ name: 'api-token.staging' }] },
    });
  });

  test('a bundle without secrets or vars gets no environment sources', async () => {
    expect((await post('/v1/deploy', deployBundle({ secrets: [] }))).status).toBe(202);
    const applied = JSON.parse(patches().at(-1)?.body ?? '') as {
      spec: { template: { spec: { components: Json[] } } };
    };
    expect(applied.spec.template.spec.components[0]?.localResources).toEqual({ environment: {} });
  });

  test.each([
    [
      'a missing secret',
      () => stored.delete(`${CORE}/secrets/api-token.prod`),
      'secret api-token does not exist in prod',
    ],
    [
      'a secret without the config label',
      () =>
        seedSecret('api-token', 'prod', {
          'platform.di-framework.dev/env': 'prod',
          'platform.di-framework.dev/secret': 'api-token',
        }),
      'api-token.prod is not a tenant secret for api-token in prod',
    ],
    [
      'a secret labelled for another env',
      () =>
        seedSecret('api-token', 'prod', {
          'platform.di-framework.dev/config': 'secret',
          'platform.di-framework.dev/env': 'staging',
          'platform.di-framework.dev/secret': 'api-token',
        }),
      'api-token.prod is not a tenant secret for api-token in prod',
    ],
    [
      'a secret labelled with another name',
      () =>
        seedSecret('api-token', 'prod', {
          'platform.di-framework.dev/config': 'secret',
          'platform.di-framework.dev/env': 'prod',
          'platform.di-framework.dev/secret': 'other',
        }),
      'api-token.prod is not a tenant secret for api-token in prod',
    ],
    [
      'a vars ConfigMap without the config label',
      () => seedVars('prod', {}, { 'platform.di-framework.dev/env': 'prod' }),
      'di-vars-prod is not a tenant vars ConfigMap for prod',
    ],
    [
      'a vars ConfigMap labelled for another env',
      () =>
        seedVars(
          'prod',
          {},
          {
            'platform.di-framework.dev/config': 'vars',
            'platform.di-framework.dev/env': 'staging',
          },
        ),
      'di-vars-prod is not a tenant vars ConfigMap for prod',
    ],
    [
      'a var and a secret with the same environment variable',
      () => seedVars('prod', { API_TOKEN: 'v' }),
      'secret api-token and var API_TOKEN are both injected as API_TOKEN in prod',
    ],
  ])('%s is a 422 before anything is applied', async (_name, arrange, detail) => {
    arrange();
    for (const path of ['/v1/deploy', '/v1/deploy/preview']) {
      const response = await post(path, deployBundle());
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ status: 422, detail });
    }
    expect(patches()).toHaveLength(0);
  });

  test('an egress binding names its workload, and workload labels are kept', async () => {
    const bundle = deployBundle({
      bindings: [{ name: 'out', capability: 'egress', serviceName: 'api', config: {} }],
    });
    bundle.workload.metadata = { name: 'web-prod', labels: { 'app.di-framework.dev/team': 'a' } };
    expect((await post('/v1/deploy', bundle)).status).toBe(202);
    const [binding, workload] = patches();
    expect((JSON.parse(binding?.body ?? '') as { spec: Json }).spec.workloadName).toBe('web-prod');
    expect((JSON.parse(workload?.body ?? '') as { metadata: Json }).metadata.labels).toEqual({
      'app.di-framework.dev/team': 'a',
      'di-framework.dev/service': 'web',
      'platform.di-framework.dev/env': 'prod',
    });
  });

  test('preview dry-runs every object and reports create, update and unchanged', async () => {
    const first = await post('/v1/deploy/preview', deployBundle());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      env: 'prod',
      service: 'web',
      changes: [
        { kind: 'create', resource: 'ServiceBinding', name: 'web-prod-cache' },
        { kind: 'create', resource: 'WorkloadDeployment', name: 'web-prod' },
      ],
    });
    expect(
      patches().every((r) => r.path.endsWith(`fieldManager=${FIELD_MANAGER}&dryRun=All`)),
    ).toBe(true);
    expect(workloads()).toHaveLength(0);

    await post('/v1/deploy', deployBundle());
    const changed = deployBundle();
    (changed.workload.spec as Json).replicas = 3;
    const second = await post('/v1/deploy/preview', changed);
    expect(((await second.json()) as { changes: unknown }).changes).toEqual([
      { kind: 'unchanged', resource: 'ServiceBinding', name: 'web-prod-cache' },
      { kind: 'update', resource: 'WorkloadDeployment', name: 'web-prod', detail: 'spec.replicas' },
    ]);

    const relabelled = deployBundle();
    relabelled.workload.metadata = { labels: { 'app.di-framework.dev/team': 'b' } };
    const third = await post('/v1/deploy/preview', relabelled);
    expect(((await third.json()) as { changes: Json[] }).changes[1]?.detail).toBe(
      'metadata.labels',
    );
  });

  test('a workload without labels or spec fields compares as unchanged', async () => {
    const bundle = deployBundle({ bindings: [] });
    await post('/v1/deploy', bundle);
    const key = `${WORKLOADS}/web-prod`;
    const object = stored.get(key) as { metadata: Json; spec?: Json };
    delete object.metadata.labels;
    stored.set(key, object);
    const response = await post('/v1/deploy/preview', bundle);
    expect(((await response.json()) as { changes: Json[] }).changes).toEqual([
      {
        kind: 'update',
        resource: 'WorkloadDeployment',
        name: 'web-prod',
        detail: 'metadata.labels',
      },
    ]);
  });

  test.each([
    [{ service: 'Web' }, 'service must be a DNS label of at most 40 characters'],
    [
      { component: { reference: '', digest: 'sha256:ab' } },
      'component.reference must not be empty',
    ],
    [
      { component: { reference: 'r', digest: 'md5:ab' } },
      'component.digest must be a sha256 digest',
    ],
    [{ workload: { kind: 'Pod' } }, 'workload.kind must be WorkloadDeployment'],
    [
      { workload: { apiVersion: 'v1' } },
      'workload.apiVersion must be runtime.wasmcloud.dev/v1alpha1',
    ],
    [{ workload: { metadata: 'x' } }, 'workload.metadata must be an object'],
    [
      { workload: { metadata: { namespace: 'other' } } },
      'workload.metadata.namespace is set by the controller',
    ],
    [
      { workload: { metadata: { name: 'other' } } },
      'workload.metadata.name must be web-prod or absent',
    ],
    [{ workload: {} }, 'workload.spec.template.spec must be an object'],
    [{ workload: { spec: { template: {} } } }, 'workload.spec.template.spec must be an object'],
    [
      { workload: { spec: { template: { spec: { hostSelector: {} } } } } },
      'workload.spec.template.spec.hostSelector is set by the controller',
    ],
    [
      { workload: { spec: { template: { spec: { environment: 'x' } } } } },
      'workload.spec.template.spec.environment is set by the controller',
    ],
    [
      { workload: { spec: { template: { spec: { hostId: 'h' } } } } },
      'workload.spec.template.spec.hostId is set by the controller',
    ],
    [
      { bindings: [{ name: 'Cache', capability: 'keyvalue', serviceName: 'c' }] },
      'bindings[0].name must be a DNS label',
    ],
    [
      {
        bindings: [
          { name: 'c', capability: 'keyvalue', serviceName: 'c' },
          { name: 'c', capability: 'keyvalue', serviceName: 'c' },
        ],
      },
      'bindings[1].name repeats c',
    ],
    [
      { bindings: [{ name: 'c', capability: 'wasi:keyvalue', serviceName: 'c' }] },
      'bindings[0].capability must be one of keyvalue, messaging, blobstore, postgres, egress',
    ],
    [
      { bindings: [{ name: 'c', capability: 'keyvalue' }] },
      'bindings[0].serviceName must name a backing service in the tenant',
    ],
    [
      { bindings: [{ name: 'c', capability: 'keyvalue', serviceName: 'c', config: { a: 'b' } }] },
      'bindings[0].config is not supported by ServiceBinding',
    ],
    [{ secrets: ['Bad_Name'] }, 'secrets[0] must be a tenant secret name'],
    [{ secrets: ['di-binding-x'] }, 'secrets[0] must be a tenant secret name'],
    [{ secrets: ['a', 'a'] }, 'secrets[1] repeats a'],
    [
      { workload: { spec: { template: { spec: { components: [] } } } } },
      'workload.spec.template.spec.components must be a non-empty array of objects',
    ],
    [
      { workload: { spec: { template: { spec: { components: ['web'] } } } } },
      'workload.spec.template.spec.components must be a non-empty array of objects',
    ],
    [
      {
        workload: {
          spec: { template: { spec: { components: [{ image: 'r@sha256:ab' }], service: 'svc' } } },
        },
      },
      'workload.spec.template.spec.service must be an object',
    ],
    [
      {
        workload: {
          spec: {
            template: {
              spec: {
                components: [
                  {
                    image: 'r@sha256:ab',
                    localResources: { environment: { secretFrom: [{ name: 'di-binding-x' }] } },
                  },
                ],
              },
            },
          },
        },
      },
      'workload.spec.template.spec.components[0].localResources.environment.secretFrom is set by the controller',
    ],
    [
      {
        workload: {
          spec: {
            template: {
              spec: {
                components: [{ image: 'r@sha256:ab' }],
                service: { localResources: { environment: { configFrom: [] } } },
              },
            },
          },
        },
      },
      'workload.spec.template.spec.service.localResources.environment.configFrom is set by the controller',
    ],
    [
      {
        workload: {
          spec: {
            template: { spec: { components: [{ image: 'r:latest' }, { image: 'r@sha256:cd' }] } },
          },
        },
      },
      'workload does not run component.digest: no component image is pinned to it',
    ],
    [
      { workload: { metadata: { finalizers: [] } } },
      'workload.metadata.finalizers is not allowed; only labels and annotations pass through',
    ],
    [
      { workload: { metadata: { labels: { 'app.di-framework.dev/a': 1 } } } },
      'workload.metadata.labels must map strings to strings',
    ],
    [
      { workload: { metadata: { annotations: { team: 'a' } } } },
      'workload.metadata.annotations.team must start with app.di-framework.dev/',
    ],
  ] as const)(
    'refuses an invalid bundle with 422 before any cluster call (%o)',
    async (overrides, detail) => {
      for (const path of ['/v1/deploy', '/v1/deploy/preview']) {
        const response = await post(path, deployBundle(overrides as never));
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ status: 422, detail });
      }
      expect(api.requests).toHaveLength(0);
    },
  );

  test.each([
    [403, 'workloaddeployments is forbidden', 'Forbidden'],
    [409, 'Apply failed with 1 conflict', 'Conflict'],
    [422, 'denied by ValidatingAdmissionPolicy', 'Unprocessable Entity'],
  ])('maps a Kubernetes %d on apply to problem+json', async (status, message, title) => {
    refusal = { status, message };
    for (const path of ['/v1/deploy', '/v1/deploy/preview']) {
      const response = await post(path, deployBundle());
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ status, title, detail: message });
    }
  });

  test.each([
    ['a non-JSON 2xx body', () => new Response('not json', { status: 200 })],
    [
      'a connection reset mid-body',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"kind":'));
              controller.error(new Error('reset'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ],
  ])('an apply response that cannot be read (%s) is a 502', async (_name, respond) => {
    rawPatch = respond;
    const response = await post('/v1/deploy', deployBundle({ bindings: [] }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ status: 502 });
  });

  test('a token the API server keeps rejecting is a 502', async () => {
    rejectToken = true;
    const response = await post('/v1/deploy', deployBundle({ bindings: [] }));
    expect(response.status).toBe(502);
  });

  test('a token the API server rejects on a preview read is a 502', async () => {
    rejectToken = true;
    const response = await post('/v1/deploy/preview', deployBundle({ bindings: [] }));
    expect(response.status).toBe(502);
  });
});

describe('/v1/deploy against an unreachable API server', () => {
  test('a network failure on apply is a 502', async () => {
    const tokens = serve(() =>
      json({
        status: { token: 't', expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString() },
      }),
    );
    const alice = { user: 'alice', account: 'acme', role: 'developer', via: 'identity' } as const;
    const minting = new KubeClient({ server: tokens.url, token: 'admin' }, 'wasmcloud');
    // Tokens mint against a live server; user requests go to a closed port.
    const dead = new KubeClient({ server: 'http://127.0.0.1:1', token: 'admin' }, 'wasmcloud');
    Object.defineProperty(dead, 'call', { value: minting.call.bind(minting) });
    const controller = new Controller(
      configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
      dead,
      { issuer: 'https://issuer.test' } as never,
      { resolve: async () => alice, forget: () => {} } as never,
      { kube: dead, namespace: 'di-runtime-acme', tenant: 'acme' },
    );
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const response = await controller.handle(
        new Request('http://controller.test/v1/deploy', {
          method: 'POST',
          headers: { authorization: 'Bearer ok', 'content-type': 'application/json' },
          body: JSON.stringify(deployBundle({ bindings: [] })),
        }),
      );
      expect(response.status).toBe(502);
    } finally {
      log.mockRestore();
      tokens.stop();
    }
  });
});
