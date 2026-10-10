import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { deployBundle } from '@di-framework/tenant-cli/tests/support/deploy-bundle.ts';
// Pinned to the platform's log projection, which keys logs by these labels (platform#103).
import {
  APPLICATION,
  applicationKey,
  MANAGED_BY,
  MANAGED_BY_VALUE,
  WORKLOAD,
} from '../../platform/src/tenancy/log-projection.ts';
import { Controller, configFromEnv } from '../src/controller.ts';
import type { Principal } from '../src/identity.ts';
import { KubeClient } from '../src/kube.ts';
import {
  FIELD_MANAGER,
  HISTORY_PER_SERVICE_ENV,
  HISTORY_TENANT_BUDGET,
  RESERVE_ATTEMPTS,
  UPDATE_ATTEMPTS,
} from '../src/v1/deploy.ts';
import { json, type Recorded, serve } from './support/servers.ts';

const WORKLOADS =
  '/apis/runtime.wasmcloud.dev/v1alpha1/namespaces/di-tenant-acme/workloaddeployments';
const CORE = '/api/v1/namespaces/di-tenant-acme';
const BINDINGS =
  '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-acme/servicebindings';

type Json = Record<string, unknown>;

/** The labels a rendered ServiceBinding carries for service `web` in `prod`, as the CLI renders. */
const BINDING_LABELS = {
  [MANAGED_BY]: MANAGED_BY_VALUE,
  'di-framework.dev/service': 'web',
  'platform.di-framework.dev/env': 'prod',
};
/** The labels the rendered WorkloadDeployment carries: `name` is its own name, as the CLI's. */
const LABELS = {
  ...BINDING_LABELS,
  'app.kubernetes.io/name': 'web-prod',
  [APPLICATION]: 'web',
};

/**
 * The controller over real HTTP, in front of a fake API server that mints `di-user-*` tokens,
 * keeps applied objects, and answers a server-side apply with the object it would store.
 */
describe('/v1/deploy', () => {
  const stored = new Map<string, Json>();
  /** Answers the next PATCH with this status and message instead of applying it. */
  let refusal: { status: number; message: string } | undefined;
  /** Answers every request (or only PATCHes, or only workload requests) with 401. */
  let rejectToken: boolean | 'patch' | 'workloads' = false;
  /** Answers the next PATCH with this response instead of applying it. */
  let rawPatch: (() => Response) | undefined;
  /** Answers the next ConfigMap POSTs with these instead of creating them. */
  const postFailures: { status: number; message: string }[] = [];
  /** Answers this many next PUTs with 409, as a concurrent writer would cause. */
  let putConflicts = 0;
  /** Paths a concurrent deploy deletes just before this one does: the DELETE gets a 404. */
  const raced = new Set<string>();
  const api = serve((request: Recorded) => {
    if (request.pathname.endsWith('/token'))
      return json({
        status: {
          token: `sa-${request.pathname.split('/').at(-2)}`,
          expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    if (
      rejectToken === true ||
      (rejectToken === 'patch' && request.method === 'PATCH') ||
      (rejectToken === 'workloads' && request.pathname.startsWith(WORKLOADS))
    )
      return json({ message: 'Unauthorized' }, 401);
    // RBAC per token (#112): a member's `sa-*` token may not read or patch Secrets.
    if (
      request.pathname.startsWith(`${CORE}/secrets`) &&
      request.headers.get('authorization')?.startsWith('Bearer sa-') &&
      ['GET', 'PATCH'].includes(request.method)
    )
      return json({ message: 'secrets is forbidden' }, 403);
    const selector = new URL(request.path, 'http://x').searchParams.get('labelSelector');
    if (request.method === 'GET' && selector !== null) {
      const wanted = selector.split(',').map((term) => term.split('='));
      const items = [...stored.entries()]
        .filter(([key]) => key.startsWith(`${request.pathname}/`))
        .map(([, object]) => object)
        .filter((object) => {
          const labels = ((object.metadata as Json).labels ?? {}) as Record<string, string>;
          return wanted.every(([key, value]) =>
            value === undefined ? (key as string) in labels : labels[key as string] === value,
          );
        });
      // A metadata-only list (PartialObjectMetadataList) drops everything but metadata.
      const metadataOnly = request.headers.get('accept')?.includes('as=PartialObjectMetadataList');
      return json({
        items: metadataOnly ? items.map((object) => ({ metadata: object.metadata })) : items,
      });
    }
    if (request.method === 'GET') {
      const object = stored.get(request.pathname);
      return object ? json(object) : json({ message: 'not found' }, 404);
    }
    if (request.method === 'POST') {
      const failure = postFailures.shift();
      if (failure) return json({ message: failure.message }, failure.status);
      const object = JSON.parse(request.body) as Json;
      const key = `${request.pathname}/${(object.metadata as Json).name}`;
      if (stored.has(key)) return json({ message: 'already exists' }, 409);
      stored.set(key, object);
      return json(object, 201);
    }
    if (request.method === 'PUT') {
      if (putConflicts > 0) {
        putConflicts--;
        return json({ message: 'the object has been modified' }, 409);
      }
      if (!stored.has(request.pathname)) return json({ message: 'not found' }, 404);
      stored.set(request.pathname, JSON.parse(request.body) as Json);
      return json(JSON.parse(request.body));
    }
    if (request.method === 'DELETE') {
      if (raced.delete(request.pathname)) stored.delete(request.pathname);
      if (!stored.delete(request.pathname)) return json({ message: 'not found' }, 404);
      return json({ status: 'Success' });
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
  let caller: Principal = alice;
  const kube = new KubeClient({ server: api.url, token: 'admin' }, 'wasmcloud');
  const controller = new Controller(
    configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
    kube,
    { issuer: 'https://issuer.test' } as never,
    { resolve: async () => caller, forget: () => {} } as never,
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
    postFailures.length = 0;
    putConflicts = 0;
    raced.clear();
    caller = alice;
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
        labels: BINDING_LABELS,
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
      labels: LABELS,
      // The workload names the revision it runs (platform#55:history).
      annotations: { 'platform.di-framework.dev/revision': 'web-prod.1' },
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
      // Each named Secret was checked as the controller before applying (#112).
      for (const object of ['api-token.staging', 'db.staging'])
        expect(
          api.requests
            .find((r) => r.method === 'GET' && r.pathname === `${CORE}/secrets/${object}`)
            ?.headers.get('authorization'),
        ).toBe('Bearer admin');
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
      ...LABELS,
    });
  });

  test('the rendered workload matches the log projection selector and keys logs by service', async () => {
    expect((await post('/v1/deploy', deployBundle())).status).toBe(202);
    const stored_ = stored.get(`${WORKLOADS}/web-prod`) as { metadata: Json };
    const labels = stored_.metadata.labels as Record<string, string>;
    // The selector projectLogs lists WorkloadDeployments with (platform controller.ts).
    expect(labels[MANAGED_BY]).toBe(MANAGED_BY_VALUE);
    expect(labels[APPLICATION]).toBe('web');
    expect(labels[WORKLOAD]).toBeUndefined();
    expect(applicationKey({ name: 'web-prod', labels })).toBe('web');
  });

  test('app.kubernetes.io/name is the WorkloadDeployment name, so a CLI destroy of the service spares it', async () => {
    expect((await post('/v1/deploy', deployBundle({ env: 'staging' }))).status).toBe(202);
    const labels = (stored.get(`${WORKLOADS}/web-staging`) as { metadata: Json }).metadata
      .labels as Record<string, string>;
    expect(labels['app.kubernetes.io/name']).toBe('web-staging');
    expect(labels[APPLICATION]).toBe('web');
  });

  test.each([
    MANAGED_BY,
    'app.kubernetes.io/name',
    'di-framework.dev/application',
    'di-framework.dev/workload',
  ])('a bundle cannot set the %s label', async (label) => {
    const bundle = deployBundle();
    bundle.workload.metadata = { labels: { [label]: 'other' } };
    const response = await post('/v1/deploy', bundle);
    expect(response.status).toBe(422);
    expect(api.requests).toHaveLength(0);
  });

  test('the wasi:http host interface gets <service>-<env> as its host', async () => {
    const bundle = deployBundle();
    const hostInterfaces = (bundle.workload as { spec: { template: { spec: Json } } }).spec.template
      .spec.hostInterfaces as Json[];
    delete hostInterfaces[0]?.config;
    expect((await post('/v1/deploy', bundle)).status).toBe(202);
    const [, workload] = patches();
    const applied = JSON.parse(workload?.body ?? '') as {
      spec: { template: { spec: { hostInterfaces: Json[] } } };
    };
    expect(applied.spec.template.spec.hostInterfaces).toEqual([
      {
        namespace: 'wasi',
        package: 'http',
        version: '0.3.0',
        interfaces: ['handler'],
        config: { host: 'web-prod' },
      },
      { namespace: 'wasi', package: 'logging', version: '0.1.0-draft', interfaces: ['logging'] },
    ]);
  });

  test('staging and prod of one service render distinct hosts', async () => {
    const hosts: unknown[] = [];
    for (const env of ['staging', 'prod'] as const) {
      expect((await post('/v1/deploy', deployBundle({ env }))).status).toBe(202);
      const applied = JSON.parse(patches().at(-1)?.body ?? '') as {
        spec: { template: { spec: { hostInterfaces: { config: Json }[] } } };
      };
      hosts.push(applied.spec.template.spec.hostInterfaces[0]?.config.host);
    }
    expect(hosts).toEqual(['web-staging', 'web-prod']);
  });

  test('setting the host keeps the other config keys of the wasi:http host interface', async () => {
    const bundle = deployBundle({ service: 'api' });
    const hostInterfaces = (bundle.workload as { spec: { template: { spec: Json } } }).spec.template
      .spec.hostInterfaces as Json[];
    (hostInterfaces[0] as Json).config = { path: '/api' };
    expect((await post('/v1/deploy', bundle)).status).toBe(202);
    const applied = JSON.parse(patches().at(-1)?.body ?? '') as {
      spec: { template: { spec: { hostInterfaces: Json[] } } };
    };
    expect(applied.spec.template.spec.hostInterfaces[0]?.config).toEqual({
      path: '/api',
      host: 'api-prod',
    });
  });

  test('a bundle for another service passes with the fixture host derived from it', async () => {
    expect(
      (await post('/v1/deploy/preview', deployBundle({ service: 'api', env: 'staging' }))).status,
    ).toBe(200);
  });

  test('a workload without host interfaces is applied unchanged', async () => {
    const bundle = deployBundle();
    delete (bundle.workload as { spec: { template: { spec: Json } } }).spec.template.spec
      .hostInterfaces;
    expect((await post('/v1/deploy', bundle)).status).toBe(202);
  });

  const http = (entry: Json | string) => ({
    workload: {
      spec: {
        template: {
          spec: {
            components: [
              {
                image: 'r@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              },
            ],
            hostInterfaces:
              typeof entry === 'string'
                ? entry
                : [{ namespace: 'wasi', package: 'http', ...entry }],
          },
        },
      },
    },
  });
  const at = 'workload.spec.template.spec.hostInterfaces[0]';
  test.each([
    [
      http({ version: '0.3.0', interfaces: ['handler'], config: { host: 'other' } }),
      `${at}.config.host must be web-prod, the service and env, or absent`,
    ],
    [
      http({ version: '0.3.0', interfaces: ['handler'], config: { host: 'web' } }),
      `${at}.config.host must be web-prod, the service and env, or absent`,
    ],
    [
      http({ interfaces: ['incoming-handler'] }),
      `${at} declares wasi:http incoming-handler without a version; hosts serve wasi:http@0.3.0 handler`,
    ],
    [
      http({ version: '0.2.0', interfaces: ['handler'] }),
      `${at} must be wasi:http@0.3.0 with interfaces [handler]`,
    ],
    [
      http({ version: '0.3.0', interfaces: ['client'] }),
      `${at} must be wasi:http@0.3.0 with interfaces [handler]`,
    ],
    [http({ interfaces: 'handler' }), `${at} must be wasi:http@0.3.0 with interfaces [handler]`],
    [
      http({ version: '0.3.0', interfaces: ['handler'], config: 'web' }),
      `${at}.config must be an object`,
    ],
    [http('wasi:http'), 'workload.spec.template.spec.hostInterfaces must be an array'],
  ] as const)(
    'refuses an unservable wasi:http host interface with 422 (%#)',
    async (overrides, detail) => {
      for (const path of ['/v1/deploy', '/v1/deploy/preview']) {
        const response = await post(path, deployBundle(overrides as never));
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ status: 422, detail });
      }
      expect(api.requests).toHaveLength(0);
    },
  );

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

  test('a token the API server keeps rejecting on apply is a 502', async () => {
    rejectToken = 'patch';
    const response = await post('/v1/deploy', deployBundle({ bindings: [] }));
    expect(response.status).toBe(502);
  });

  test('a token the API server rejects on the config reads is a 502', async () => {
    rejectToken = true;
    expect((await post('/v1/deploy', deployBundle())).status).toBe(502);
  });

  describe('history (platform#55:history)', () => {
    const REVISIONS = `${CORE}/configmaps/di-deploy-`;
    const revision = (id: string) => stored.get(`${REVISIONS}${id}`) as Json | undefined;
    const revisionKeys = () => [...stored.keys()].filter((key) => key.startsWith(REVISIONS));
    const get = (path: string) =>
      fetch(`${base}${path}`, { headers: { authorization: 'Bearer ok' } });
    const deployed = async (bundle = deployBundle()) => {
      const response = await post('/v1/deploy', bundle);
      expect(response.status).toBe(202);
      return (await response.json()) as Json;
    };
    const withReplicas = (replicas: number, overrides = {}) => {
      const bundle = deployBundle(overrides);
      (bundle.workload.spec as Json).replicas = replicas;
      return bundle;
    };
    /** Sets the live Ready condition the platform reports on a WorkloadDeployment. */
    const setReady = (name: string, status: string, lastTransitionTime?: string) => {
      const key = `${WORKLOADS}/${name}`;
      stored.set(key, {
        ...(stored.get(key) as Json),
        status: { conditions: [{ type: 'Ready', status, lastTransitionTime }] },
      });
    };
    const appliedReplicas = () =>
      (JSON.parse(patches().at(-1)?.body ?? '') as { spec: { replicas: number } }).spec.replicas;

    test('each deploy stores a labelled revision ConfigMap with the bundle and its digest', async () => {
      expect((await deployed()).id).toBe('web-prod.1');
      const second = withReplicas(2);
      expect(await deployed(second)).toMatchObject({ id: 'web-prod.2', status: 'pending' });
      const stored2 = revision('web-prod.2') as {
        metadata: { labels: Record<string, string>; annotations: Record<string, string> };
        data: { bundle: string; digest: string };
      };
      expect(stored2.metadata.labels).toEqual({
        'platform.di-framework.dev/deploy-revision': '2',
        'di-framework.dev/service': 'web',
        'platform.di-framework.dev/env': 'prod',
      });
      expect(JSON.parse(stored2.data.bundle)).toEqual(second);
      const hex = new Bun.CryptoHasher('sha256').update(stored2.data.bundle).digest('hex');
      expect(stored2.data.digest).toBe(`sha256:${hex}`);
      // Every cluster call is made with the caller's own token, except the Secret existence
      // checks, which run as the controller (#112).
      for (const request of api.requests.filter((r) => !r.pathname.endsWith('/token')))
        expect(request.headers.get('authorization')).toBe(
          request.method === 'GET' && request.pathname.startsWith(`${CORE}/secrets/`)
            ? 'Bearer admin'
            : 'Bearer sa-di-user-alice',
        );
      expect(
        api.requests.some((r) => r.method === 'POST' && r.pathname === `${CORE}/configmaps`),
      ).toBe(true);
    });

    test('revisions are not vars and not logs', async () => {
      await deployed();
      const vars = await get('/v1/vars?env=prod');
      expect(vars.status).toBe(200);
      expect(await vars.json()).toEqual({ env: 'prod', items: [] });
      expect((await get('/v1/services/web/logs?env=prod')).status).toBe(404);
      // A redeploy still treats the environment as having no vars ConfigMap.
      await deployed();
      const applied = JSON.parse(patches().at(-1)?.body ?? '') as {
        spec: { template: { spec: { components: Json[] } } };
      };
      expect(
        (
          (applied.spec.template.spec.components[0] as { localResources: Json })
            .localResources as Json
        ).environment,
      ).toEqual({ secretFrom: [{ name: 'api-token.prod' }] });
    });

    /**
     * Stores a revision as a deploy would have; `state` absent is a revision that went live.
     * `running` also stores its WorkloadDeployment naming it, as the deploy applied it.
     */
    const seedRevision = (
      service: string,
      env: string,
      n: number,
      options: {
        createdAt?: string;
        state?: string;
        bundle?: string;
        digest?: string;
        label?: string;
        component?: string;
        running?: boolean;
      } = {},
    ) => {
      const bundle =
        options.bundle ??
        JSON.stringify(deployBundle({ service, env: env as 'prod', bindings: [] }));
      stored.set(`${REVISIONS}${service}-${env}.${n}`, {
        metadata: {
          name: `di-deploy-${service}-${env}.${n}`,
          labels: {
            'platform.di-framework.dev/deploy-revision': options.label ?? String(n),
            'di-framework.dev/service': service,
            'platform.di-framework.dev/env': env,
          },
          annotations: {
            'platform.di-framework.dev/created-at':
              options.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
            'platform.di-framework.dev/component':
              options.component ?? JSON.stringify(deployBundle().component),
            ...(options.state ? { 'platform.di-framework.dev/revision-state': options.state } : {}),
          },
        },
        data: {
          bundle,
          digest:
            options.digest ??
            `sha256:${new Bun.CryptoHasher('sha256').update(bundle).digest('hex')}`,
        },
      });
      if (options.running) runs(`${service}-${env}`, `${service}-${env}.${n}`);
    };
    /** Stores (or points) the WorkloadDeployment `name` as one that runs revision `id`. */
    const runs = (name: string, id: string) => {
      const key = `${WORKLOADS}/${name}`;
      const object = (stored.get(key) ?? {
        metadata: { name, labels: { [MANAGED_BY]: MANAGED_BY_VALUE } },
      }) as { metadata: Json };
      stored.set(key, {
        ...object,
        metadata: {
          ...object.metadata,
          annotations: { 'platform.di-framework.dev/revision': id },
        },
      });
    };
    const stateOf = (id: string) =>
      ((revision(id)?.metadata as Json | undefined)?.annotations as Json | undefined)?.[
        'platform.di-framework.dev/revision-state'
      ];
    const listed = async (query = 'env=prod') =>
      ((await (await get(`/v1/deployments?${query}`)).json()) as { items: Json[] }).items.map(
        (item) => [item.id, item.status],
      );

    test(`keeps at most ${HISTORY_PER_SERVICE_ENV} revisions per service and environment`, async () => {
      for (let n = 1; n <= 10; n++) seedRevision('web', 'prod', n, { state: 'replaced' });
      seedRevision('web', 'prod', 10);
      await deployed(deployBundle({ env: 'staging' }));
      expect((await deployed()).id).toBe('web-prod.11');
      expect(revisionKeys().filter((key) => key.includes('web-prod'))).toHaveLength(10);
      expect(revision('web-prod.1')).toBeUndefined();
      expect(revision('web-prod.2')).toBeDefined();
      expect(revision('web-staging.1')).toBeDefined();
      expect(stateOf('web-prod.11')).toBe('live');
      expect(stateOf('web-prod.10')).toBe('replaced');
    });

    test(`keeps at most ${HISTORY_TENANT_BUDGET} revisions in the tenant, oldest first, before creating`, async () => {
      // Four services with ten revisions each fill the budget; `a` is the oldest.
      for (const [index, service] of ['a', 'b', 'c', 'd'].entries())
        for (let n = 1; n <= 10; n++)
          seedRevision(service, 'prod', n, {
            createdAt: new Date(Date.UTC(2026, 0, 1 + index, 0, n)).toISOString(),
            ...(n < 10 ? { state: 'replaced' } : {}),
          });
      expect((await deployed()).id).toBe('web-prod.1');
      expect(revisionKeys()).toHaveLength(HISTORY_TENANT_BUDGET);
      expect(revision('a-prod.1')).toBeUndefined();
      expect(revision('a-prod.2')).toBeDefined();
      // The delete ran before the create.
      const writes = api.requests.filter(
        (r) => r.pathname.startsWith(`${CORE}/configmaps`) && ['POST', 'DELETE'].includes(r.method),
      );
      expect(writes.map((r) => r.method)).toEqual(['DELETE', 'POST']);
    });

    test('a live revision whose workload is gone or runs another revision is pruned', async () => {
      // s1 was destroyed, s2 runs a revision other than its live one; the rest run theirs.
      for (let n = 1; n <= HISTORY_TENANT_BUDGET; n++)
        seedRevision(`s${n}`, 'prod', 1, {
          running: n > 2,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
        });
      runs('s2-prod', 's2-prod.9');
      expect((await deployed()).id).toBe('web-prod.1');
      expect(revisionKeys()).toHaveLength(HISTORY_TENANT_BUDGET);
      expect(revision('s1-prod.1')).toBeUndefined();
      expect(revision('s2-prod.1')).toBeDefined();
      expect(stateOf('s2-prod.1')).toBe('replaced');
    });

    test('a 507 before anything is applied when running revisions fill the tenant budget', async () => {
      for (let n = 1; n <= HISTORY_TENANT_BUDGET; n++)
        seedRevision(`s${n}`, 'prod', 1, { running: true });
      const response = await post('/v1/deploy', deployBundle());
      expect(response.status).toBe(507);
      expect(((await response.json()) as Json).detail).toBe(
        `the ${HISTORY_TENANT_BUDGET} revisions running workloads fill the tenant's deploy history budget of ${HISTORY_TENANT_BUDGET}, so nothing was applied`,
      );
      expect(patches()).toHaveLength(0);
      expect(revisionKeys()).toHaveLength(HISTORY_TENANT_BUDGET);
      expect(api.requests.some((r) => ['POST', 'DELETE'].includes(r.method))).toBe(false);
    });

    test('revisions are listed as metadata only, and only a rollback target is fetched whole', async () => {
      await deployed(withReplicas(1));
      await deployed(withReplicas(2));
      api.requests.length = 0;
      expect((await post('/v1/deployments/rollback', { env: 'prod', service: 'web' })).status).toBe(
        202,
      );
      const reads = api.requests.filter(
        (r) => r.method === 'GET' && r.pathname.startsWith(`${CORE}/configmaps`),
      );
      const lists = reads.filter((r) => r.path.includes('labelSelector'));
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists)
        expect(list.headers.get('accept')).toBe(
          'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1',
        );
      // The target bundle, then the revisions the marks re-read.
      expect(reads.filter((r) => !r.path.includes('labelSelector'))[0]?.pathname).toBe(
        `${REVISIONS}web-prod.1`,
      );
    });

    test('a bundle cannot set the annotation that names the running revision', async () => {
      const bundle = deployBundle();
      bundle.workload.metadata = { annotations: { 'platform.di-framework.dev/revision': 'x' } };
      const response = await post('/v1/deploy', bundle);
      expect(response.status).toBe(422);
      expect(patches()).toHaveLength(0);
    });

    test('a crash between apply and mark is repaired from the workload on the next read and deploy', async () => {
      await deployed(withReplicas(1));
      // The marks of web-prod.2 fail, as when the controller restarts after the apply.
      putConflicts = UPDATE_ATTEMPTS;
      await deployed(withReplicas(2));
      expect(stateOf('web-prod.2')).toBe('pending');
      expect(stateOf('web-prod.1')).toBe('live');
      setReady('web-prod', 'True', '2026-10-01T00:00:00Z');
      expect(await listed()).toEqual([
        ['web-prod.2', 'ready'],
        ['web-prod.1', 'pending'],
      ]);
      const stats = (await (await get('/v1/deployments/stats?env=prod')).json()) as Json;
      expect(stats).toMatchObject({ deployments: 2, ready: 1 });
      // Reads do not write; the next deploy does.
      expect(stateOf('web-prod.2')).toBe('pending');
      await deployed(withReplicas(3));
      expect(stateOf('web-prod.3')).toBe('live');
      expect(stateOf('web-prod.2')).toBe('replaced');
      expect(stateOf('web-prod.1')).toBe('replaced');
      const rollback = await post('/v1/deployments/rollback', { env: 'prod', service: 'web' });
      expect(((await rollback.json()) as Json).id).toBe('web-prod.4');
      expect(appliedReplicas()).toBe(2);
    });

    test('out-of-order concurrent applies: the revision the workload runs is the live one', async () => {
      await deployed(withReplicas(1));
      // Deploy B reserved web-prod.3 and applied first; deploy A (web-prod.2) applied last, and
      // both marked their revision live.
      seedRevision('web', 'prod', 2, {
        bundle: JSON.stringify(withReplicas(2)),
        running: true,
      });
      seedRevision('web', 'prod', 3, { bundle: JSON.stringify(withReplicas(3)) });
      expect((await listed('env=prod&service=web')).map(([id]) => id)).toEqual([
        'web-prod.3',
        'web-prod.2',
        'web-prod.1',
      ]);
      const response = await post('/v1/deployments/rollback', { env: 'prod', service: 'web' });
      expect(((await response.json()) as Json).id).toBe('web-prod.4');
      // The default target is the revision before the running web-prod.2, not before web-prod.3.
      expect(appliedReplicas()).toBe(1);
      expect(stateOf('web-prod.3')).toBe('replaced');
      expect(stateOf('web-prod.2')).toBe('replaced');
      expect(stateOf('web-prod.4')).toBe('live');
    });

    test('rollback of a stored bundle that fails its digest or is incomplete is a 422', async () => {
      const cases: [Parameters<typeof seedRevision>[3], string][] = [
        [{ digest: 'sha256:0' }, 'does not match its stored digest'],
        [{ bundle: '{not json' }, 'stores a bundle that is not JSON'],
        [{ bundle: JSON.stringify({ service: 'web', env: 'prod' }) }, 'incomplete bundle'],
        [
          { bundle: JSON.stringify({ ...deployBundle({ bindings: [] }), secrets: [1] }) },
          'incomplete bundle',
        ],
      ];
      for (const [options, detail] of cases) {
        stored.clear();
        seedRevision('web', 'prod', 1, { state: 'replaced', ...options });
        seedRevision('web', 'prod', 2, { running: true });
        const response = await post('/v1/deployments/rollback', { env: 'prod', service: 'web' });
        expect(response.status).toBe(422);
        expect(((await response.json()) as Json).detail).toContain(detail);
      }
      expect(patches()).toHaveLength(0);
    });

    test('a prune that a concurrent deploy already made counts as done', async () => {
      for (let n = 1; n <= 10; n++) seedRevision('web', 'prod', n, { state: 'replaced' });
      seedRevision('web', 'prod', 10);
      raced.add(`${REVISIONS}web-prod.1`);
      expect((await deployed()).id).toBe('web-prod.11');
      expect(revision('web-prod.1')).toBeUndefined();
    });

    test('a full ConfigMap quota is a 507 before anything is applied', async () => {
      postFailures.push({
        status: 403,
        message: 'configmaps "di-deploy-web-prod.1" is forbidden: exceeded quota: di-tenant-quota',
      });
      const response = await post('/v1/deploy', deployBundle());
      expect(response.status).toBe(507);
      expect(((await response.json()) as Json).detail).toContain('nothing was applied');
      expect(patches()).toHaveLength(0);
      expect(workloads()).toHaveLength(0);
      expect(revisionKeys()).toHaveLength(0);
    });

    test('another refusal of the revision POST is passed through before anything is applied', async () => {
      postFailures.push({ status: 403, message: 'forbidden' });
      expect((await post('/v1/deploy', deployBundle())).status).toBe(403);
      expect(patches()).toHaveLength(0);
    });

    test('a revision number a concurrent deploy took is skipped for the next one', async () => {
      postFailures.push({ status: 409, message: 'already exists' });
      expect((await deployed()).id).toBe('web-prod.2');
      expect(stateOf('web-prod.2')).toBe('live');
    });

    test(`${RESERVE_ATTEMPTS} taken revision numbers are a 409 before anything is applied`, async () => {
      for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++)
        postFailures.push({ status: 409, message: 'already exists' });
      const response = await post('/v1/deploy', deployBundle());
      expect(response.status).toBe(409);
      expect(patches()).toHaveLength(0);
    });

    test('a revision is pending while it applies, and failed when the apply fails', async () => {
      await deployed();
      rawPatch = () => {
        expect(stateOf('web-prod.2')).toBe('pending');
        return json({ message: 'admission webhook denied' }, 422);
      };
      expect((await post('/v1/deploy', withReplicas(2))).status).toBe(422);
      expect(stateOf('web-prod.2')).toBe('failed');
      expect(stateOf('web-prod.1')).toBe('live');
      expect(await listed()).toEqual([
        ['web-prod.2', 'failed'],
        ['web-prod.1', 'pending'],
      ]);
      const stats = (await (await get('/v1/deployments/stats?env=prod')).json()) as Json;
      expect(stats).toMatchObject({ services: 1, deployments: 1 });
      // The next deploy replaces the revision that went live, not the failed one.
      rawPatch = undefined;
      await deployed();
      expect(stateOf('web-prod.1')).toBe('replaced');
      expect(stateOf('web-prod.2')).toBe('failed');
      const toFailed = { env: 'prod', service: 'web', to: 'web-prod.2' };
      expect((await post('/v1/deployments/rollback', toFailed)).status).toBe(404);
      const rollback = await post('/v1/deployments/rollback', { env: 'prod', service: 'web' });
      expect(((await rollback.json()) as Json).id).toBe('web-prod.4');
      expect(
        (((revision('web-prod.4') as Json).metadata as Json).annotations as Json)[
          'platform.di-framework.dev/rollback-of'
        ],
      ).toBe('web-prod.1');
    });

    test('a pending revision of a deploy still applying is listed but not counted', async () => {
      await deployed();
      seedRevision('web', 'prod', 2, { state: 'pending' });
      expect(await listed()).toEqual([
        ['web-prod.2', 'pending'],
        ['web-prod.1', 'pending'],
      ]);
      const stats = (await (await get('/v1/deployments/stats?env=prod')).json()) as Json;
      expect(stats).toMatchObject({ deployments: 1 });
      const rollback = await post('/v1/deployments/rollback', {
        env: 'prod',
        service: 'web',
        to: 'web-prod.2',
      });
      expect(rollback.status).toBe(404);
    });

    test('marking revisions re-reads them after a 409', async () => {
      await deployed();
      putConflicts = 2;
      expect((await deployed()).id).toBe('web-prod.2');
      expect(stateOf('web-prod.2')).toBe('live');
      expect(stateOf('web-prod.1')).toBe('replaced');
    });

    test(`a revision that keeps changing after ${UPDATE_ATTEMPTS} tries is logged, and the deploy still answers 202`, async () => {
      putConflicts = UPDATE_ATTEMPTS;
      expect((await post('/v1/deploy', deployBundle())).status).toBe(202);
      expect(workloads()).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"deploy.history-mark-failed"'));
    });

    test('a revision deleted while it is marked is skipped', async () => {
      await deployed();
      // A concurrent deploy prunes web-prod.1 between this deploy's read and its write.
      const original = stored.get.bind(stored);
      let reads = 0;
      const spy = spyOn(stored, 'get').mockImplementation((key: string) => {
        if (key === `${REVISIONS}web-prod.1` && ++reads === 1) {
          const object = original(key);
          stored.delete(key);
          return object;
        }
        return original(key);
      });
      try {
        putConflicts = 0;
        const response = await post('/v1/deploy', withReplicas(2));
        expect(response.status).toBe(202);
      } finally {
        spy.mockRestore();
      }
    });

    test('order within a service comes from <n>, across services from created-at then name', async () => {
      // web-prod.2 was created on a clock behind web-prod.1's, at the same instant as api-prod.1.
      seedRevision('web', 'prod', 1, { createdAt: '2026-01-02T00:00:00.000Z', state: 'replaced' });
      seedRevision('web', 'prod', 2, { createdAt: '2026-01-01T00:00:00.000Z', running: true });
      seedRevision('api', 'prod', 1, { createdAt: '2026-01-01T00:00:00.000Z' });
      const items = await listed();
      expect(items.map(([id]) => id)).toEqual(['web-prod.2', 'api-prod.1', 'web-prod.1']);
      const response = await post('/v1/deployments/rollback', { env: 'prod', service: 'web' });
      expect(response.status).toBe(202);
      expect(((await response.json()) as Json).id).toBe('web-prod.3');
      expect(
        (((revision('web-prod.3') as Json).metadata as Json).annotations as Json)[
          'platform.di-framework.dev/rollback-of'
        ],
      ).toBe('web-prod.1');
      expect(stateOf('web-prod.2')).toBe('replaced');
    });

    test('hand-edited revisions are skipped with a logged reason', async () => {
      await deployed();
      seedRevision('web', 'prod', 7, { label: 'seven' });
      seedRevision('web', 'prod', 8, { component: '{not json' });
      seedRevision('web', 'prod', 9, { component: JSON.stringify({ reference: 1 }) });
      seedRevision('web', 'prod', 11, { state: 'unknown' });
      stored.set(`${REVISIONS}web-prod.12`, {
        metadata: {
          name: 'di-deploy-web-prod.12',
          labels: {
            'platform.di-framework.dev/deploy-revision': '13',
            'di-framework.dev/service': 'web',
            'platform.di-framework.dev/env': 'prod',
          },
        },
      });
      seedRevision('Web', 'prod', 14);
      expect(await listed()).toEqual([['web-prod.1', 'pending']]);
      expect((await deployed()).id).toBe('web-prod.2');
      expect((await post('/v1/deployments/rollback', { env: 'prod', service: 'web' })).status).toBe(
        202,
      );
      for (const reason of [
        'is not a positive integer',
        'component is not JSON',
        'component is not a component',
        'is not a known state',
        'name is not di-deploy-web-prod.13',
        'service or env label is invalid',
      ])
        expect(log).toHaveBeenCalledWith(expect.stringContaining(reason));
    });

    test('a service that is not a DNS label is a 422 before any selector is built', async () => {
      const list = await get('/v1/deployments?env=prod&service=a,b');
      expect(list.status).toBe(422);
      const rollback = await post('/v1/deployments/rollback', { env: 'prod', service: 'a,b' });
      expect(rollback.status).toBe(422);
      expect(api.requests.some((r) => r.pathname.startsWith(`${CORE}/configmaps`))).toBe(false);
    });

    test('a revision reports rolling until the platform observes the applied generation', async () => {
      await deployed();
      const key = `${WORKLOADS}/web-prod`;
      const object = stored.get(key) as { metadata: Json };
      stored.set(key, {
        ...object,
        metadata: { ...object.metadata, generation: 2 },
        status: {
          observedGeneration: 1,
          conditions: [
            { type: 'Ready', status: 'True', lastTransitionTime: '2026-01-01T00:00:00Z' },
          ],
        },
      });
      expect(await listed()).toEqual([['web-prod.1', 'rolling']]);
      stored.set(key, {
        ...object,
        metadata: { ...object.metadata, generation: 2 },
        status: {
          conditions: [
            { type: 'Ready', status: 'True', observedGeneration: 2, lastTransitionTime: 'x' },
          ],
        },
      });
      expect(await listed()).toEqual([['web-prod.1', 'ready']]);
    });

    test('a bundle too big to store is a 422 before anything is applied', async () => {
      const bundle = deployBundle();
      bundle.workload.metadata = {
        annotations: { 'app.di-framework.dev/blob': 'x'.repeat(1_000_000) },
      };
      const response = await post('/v1/deploy', bundle);
      expect(response.status).toBe(422);
      expect(((await response.json()) as Json).detail).toContain('deploy history stores at most');
      expect(patches()).toHaveLength(0);
      expect(revisionKeys()).toHaveLength(0);
    });

    test('deployments lists revisions newest first with live and recorded status', async () => {
      await deployed();
      setReady('web-prod', 'True', '2026-10-01T00:00:00Z');
      await deployed(withReplicas(2));
      setReady('web-prod', 'Unknown');
      await deployed(deployBundle({ service: 'api', bindings: [] }));
      setReady('api-prod', 'False');
      // Created in the same instant: services order by name, revisions of one service by <n>.
      for (const id of ['web-prod.1', 'web-prod.2', 'api-prod.1'])
        (((revision(id) as Json).metadata as Json).annotations as Json)[
          'platform.di-framework.dev/created-at'
        ] = '2026-01-01T00:00:00.000Z';

      const response = await get('/v1/deployments?env=prod');
      expect(response.status).toBe(200);
      const { items } = (await response.json()) as { items: Json[] };
      expect(items.map((item) => [item.id, item.status])).toEqual([
        ['api-prod.1', 'failed'],
        ['web-prod.2', 'rolling'],
        ['web-prod.1', 'ready'],
      ]);
      expect(items[2]).toMatchObject({
        service: 'web',
        env: 'prod',
        component: deployBundle().component,
        readyAt: '2026-10-01T00:00:00Z',
      });
      expect(typeof items[0]?.createdAt).toBe('string');

      setReady('web-prod', 'True', '2026-10-02T00:00:00Z');
      const filtered = (await (await get('/v1/deployments?env=prod&service=web')).json()) as {
        items: Json[];
      };
      expect(filtered.items.map((item) => item.id)).toEqual(['web-prod.2', 'web-prod.1']);
      expect(filtered.items[0]).toMatchObject({ status: 'ready', readyAt: '2026-10-02T00:00:00Z' });
      expect(
        ((await (await get('/v1/deployments?env=staging')).json()) as { items: Json[] }).items,
      ).toEqual([]);
    });

    test('deploymentStats summarizes the revisions and the live workloads', async () => {
      await deployed();
      await deployed();
      await deployed(deployBundle({ service: 'api', bindings: [] }));
      await deployed(deployBundle({ service: 'job', bindings: [] }));
      setReady('web-prod', 'True');
      setReady('api-prod', 'False');
      const stats = (await (await get('/v1/deployments/stats?env=prod')).json()) as Json;
      expect(stats).toMatchObject({
        env: 'prod',
        services: 3,
        deployments: 4,
        ready: 1,
        failed: 1,
      });
      expect(typeof stats.lastDeployedAt).toBe('string');
      expect(await (await get('/v1/deployments/stats?env=staging')).json()).toEqual({
        env: 'staging',
        services: 0,
        deployments: 0,
        ready: 0,
        failed: 0,
      });
    });

    test('rollback re-applies the previous revision and records it as a new one', async () => {
      await deployed(withReplicas(1));
      await deployed(withReplicas(3));
      const response = await post('/v1/deployments/rollback', { env: 'prod', service: 'web' });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ id: 'web-prod.3', status: 'pending' });
      expect(appliedReplicas()).toBe(1);
      const applied = JSON.parse(patches().at(-1)?.body ?? '') as {
        spec: { template: { spec: Json } };
      };
      // Rendered like a deploy: namespace environment, host selector and injected secrets.
      expect(applied.spec.template.spec.hostSelector).toEqual({ hostgroup: 'tenant-acme' });
      expect(
        (((revision('web-prod.3') as Json).metadata as Json).annotations as Json)[
          'platform.di-framework.dev/rollback-of'
        ],
      ).toBe('web-prod.1');
      const { items } = (await (await get('/v1/deployments?env=prod&service=web')).json()) as {
        items: Json[];
      };
      expect(items.map((item) => [item.id, item.status])).toEqual([
        ['web-prod.3', 'pending'],
        ['web-prod.2', 'rolled-back'],
        ['web-prod.1', 'pending'],
      ]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"deploy.rolled-back"'));
    });

    test('rollback --to re-applies the named revision', async () => {
      await deployed(withReplicas(1));
      await deployed(withReplicas(2));
      await deployed(withReplicas(3));
      const response = await post('/v1/deployments/rollback', {
        env: 'prod',
        service: 'web',
        to: 'web-prod.1',
      });
      expect(response.status).toBe(202);
      expect(((await response.json()) as Json).id).toBe('web-prod.4');
      expect(appliedReplicas()).toBe(1);
    });

    test('rollback to a missing revision, or with no earlier one, is a 404', async () => {
      await deployed();
      for (const body of [
        { env: 'prod', service: 'web', to: 'web-prod.9' },
        { env: 'prod', service: 'web', to: 'api-prod.1' },
        { env: 'prod', service: 'web' },
      ]) {
        const response = await post('/v1/deployments/rollback', body);
        expect(response.status).toBe(404);
      }
    });

    test('rollback validates the stored bundle again', async () => {
      seedSecret('db', 'prod');
      await deployed(deployBundle({ secrets: ['api-token', 'db'] }));
      await deployed();
      stored.delete(`${CORE}/secrets/db.prod`);
      const response = await post('/v1/deployments/rollback', { env: 'prod', service: 'web' });
      expect(response.status).toBe(422);
      expect(((await response.json()) as Json).detail).toBe('secret db does not exist in prod');
      // The re-validation reads the Secret as the controller (#112).
      expect(
        api.requests
          .filter((r) => r.method === 'GET' && r.pathname === `${CORE}/secrets/db.prod`)
          .at(-1)
          ?.headers.get('authorization'),
      ).toBe('Bearer admin');
    });

    test('bindings a bundle no longer declares are pruned, and preview reports them as delete', async () => {
      const both = deployBundle({
        bindings: [
          { name: 'cache', capability: 'keyvalue', serviceName: 'cache' },
          { name: 'queue', capability: 'messaging', serviceName: 'queue' },
        ],
      });
      await deployed(both);
      // Another service's binding with the same env is not this deploy's to prune.
      stored.set(`${BINDINGS}/api-prod-queue`, {
        metadata: {
          name: 'api-prod-queue',
          labels: { ...BINDING_LABELS, 'di-framework.dev/service': 'api' },
        },
      });
      const preview = await post('/v1/deploy/preview', deployBundle());
      expect(((await preview.json()) as { changes: Json[] }).changes).toContainEqual({
        kind: 'delete',
        resource: 'ServiceBinding',
        name: 'web-prod-queue',
      });
      expect(stored.has(`${BINDINGS}/web-prod-queue`)).toBe(true);

      await deployed();
      expect(stored.has(`${BINDINGS}/web-prod-queue`)).toBe(false);
      expect(stored.has(`${BINDINGS}/web-prod-cache`)).toBe(true);
      expect(stored.has(`${BINDINGS}/api-prod-queue`)).toBe(true);

      // Rolling back to the bundle with the queue binding brings it back; forward prunes it again.
      await post('/v1/deployments/rollback', { env: 'prod', service: 'web' });
      expect(stored.has(`${BINDINGS}/web-prod-queue`)).toBe(true);
      await post('/v1/deployments/rollback', { env: 'prod', service: 'web' });
      expect(stored.has(`${BINDINGS}/web-prod-queue`)).toBe(false);
      const deletes = api.requests.filter((r) => r.method === 'DELETE');
      expect(
        deletes.every((r) => r.headers.get('authorization') === 'Bearer sa-di-user-alice'),
      ).toBe(true);
    });

    test('a viewer may list and summarize deployments but not roll back', async () => {
      await deployed();
      await deployed();
      caller = { ...alice, user: 'vic', role: 'viewer' };
      expect((await get('/v1/deployments?env=prod')).status).toBe(200);
      expect((await get('/v1/deployments/stats?env=prod')).status).toBe(200);
      expect((await post('/v1/deployments/rollback', { env: 'prod', service: 'web' })).status).toBe(
        403,
      );
      expect((await post('/v1/deploy', deployBundle())).status).toBe(403);
      const reads = api.requests.filter(
        (r) =>
          !r.pathname.endsWith('/token') &&
          r.headers.get('authorization') === 'Bearer sa-di-user-vic',
      );
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((r) => r.method === 'GET')).toBe(true);
    });
  });

  test('a token the API server rejects on a preview read is a 502', async () => {
    rejectToken = 'workloads';
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
    // Tokens mint against a live server; user reads find nothing, and an apply drops the socket.
    const dropping = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket, data) {
          const head = data.toString();
          if (head.startsWith('PATCH ')) return void socket.end();
          // History lists find no revisions, and the revision reservation succeeds.
          if (head.startsWith('POST ') || head.includes('labelSelector='))
            return void socket.end(
              'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}',
            );
          socket.end(
            'HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}',
          );
        },
      },
    });
    const dead = new KubeClient(
      { server: `http://127.0.0.1:${dropping.port}`, token: 'admin' },
      'wasmcloud',
    );
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
          body: JSON.stringify(deployBundle({ bindings: [], secrets: [] })),
        }),
      );
      expect(response.status).toBe(502);
    } finally {
      log.mockRestore();
      tokens.stop();
      dropping.stop(true);
    }
  });
});
