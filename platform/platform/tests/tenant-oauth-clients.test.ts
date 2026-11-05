import { afterAll, describe, expect, it } from 'bun:test';
import { Controller, collection } from '../src/tenancy/controller';
import {
  CONSOLE_OAUTH_SECRET,
  type OAuthClientRegistry,
  oauthAdminError,
  tenantOAuthClientIds,
} from '../src/tenancy/oauth-clients';
import { REMOVAL_STEP_DEADLINE_MS, REMOVAL_STUCK } from '../src/tenancy/removal-sequence';
import {
  type ControllerConfig,
  FINALIZER,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  type Tenant,
  type TenantAuthConfig,
  VERSION,
} from '../src/tenancy/resources';
import { cfg as baseCfg, MemoryApi, START } from './support/controller-harness';
import { cutoverSeeds } from './support/cutover';
import { FakeIdentityAdmin } from './support/fake-identity-admin';

// #59: each tenant's own OAuth clients, registered in the identity server during reconcile and
// revoked with the tenant.

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

const IMAGE = `ghcr.io/di-framework/tenant-auth@sha256:${'a'.repeat(64)}`;
const auth: TenantAuthConfig = {
  image: IMAGE,
  issuer: 'http://identity.localhost:28180',
  oauthClient: { id: 'provisioner', secretName: 'tenant-auth-oauth' },
  consolePublicUrl: 'http://console.{tenant}.localhost:28180',
  controllerPublicUrl: 'https://controller.{tenant}.localhost:28180',
};
const cfg: ControllerConfig = { ...baseCfg, tenantAuth: auth };
const ready = [
  {
    type: 'Ready' as const,
    status: 'True' as const,
    observedGeneration: 1,
    reason: 'Reconciled',
    message: '',
    lastTransitionTime: '2026-01-01T00:00:00Z',
  },
];
type Deployment = Resource & {
  spec: { template: { spec: { containers: { env: { name: string; value?: string }[] }[] } } };
};

function tenant(name: string, uid = `${name}-uid`): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: { name, uid, generation: 1, labels: { [INSTALLATION]: 'test' } },
    spec: {},
  };
}
const path = (kind: string, namespace: string | undefined, name: string) =>
  `${collection(kind === 'Deployment' ? 'apps/v1' : 'v1', kind, namespace)}/${name}`;
const tenantPath = (name: string) => `${collection(VERSION, 'Tenant')}/${name}`;
const runtime = (name: string) => names(name).runtimeNamespace;
/** The Tenant as stored, to change in place. */
const live = (api: MemoryApi, name: string) =>
  api.objects.get(tenantPath(name)) as unknown as Tenant;
/** A copy of the stored Tenant, to assert on. */
const stored = (api: MemoryApi, name: string) =>
  structuredClone(live(api, name)) as Tenant | undefined;
const condition = (api: MemoryApi, name: string, type: string) =>
  stored(api, name)?.status?.conditions?.find((c) => c.type === type);
const env = (api: MemoryApi, name: string, deployment: string) =>
  Object.fromEntries(
    (
      (api.objects.get(path('Deployment', runtime(name), deployment)) as Deployment).spec.template
        .spec.containers[0]?.env ?? []
    ).flatMap((e) => (e.value === undefined ? [] : [[e.name, e.value]])),
  );
/** Ticks until `done`, at most six times. */
async function until(controller: Controller, done: () => boolean): Promise<void> {
  for (let i = 0; i < 6 && !done(); i++) await controller.tick();
}
const finalized = (api: MemoryApi, name: string) =>
  !stored(api, name)?.metadata.finalizers?.includes(FINALIZER);
const consoleSecret = (api: MemoryApi, name: string) =>
  api.objects.get(path('Secret', runtime(name), CONSOLE_OAUTH_SECRET)) as
    | (Resource & { data: Record<string, string> })
    | undefined;
const decode = (value: string | undefined) => Buffer.from(value ?? '', 'base64').toString();

/**
 * Tenants `alpha` and `beta` past the scheduler cut-over, the provisioner secret in the platform
 * namespace, and a controller on the given registry (the fake's in-memory seam by default).
 */
function prepare(
  options: {
    registry?: OAuthClientRegistry;
    /** No injected registry: the controller builds the HTTP one from `tenantAuth`. */
    http?: boolean;
    config?: ControllerConfig;
    tenants?: Tenant[];
    now?: () => Date;
  } = {},
) {
  const api = new MemoryApi();
  const fake = new FakeIdentityAdmin();
  const tenants = options.tenants ?? [tenant('alpha'), tenant('beta')];
  for (const t of tenants) {
    api.seed(t);
    for (const value of cutoverSeeds(t, 'test')) api.seed(value);
    api.seed({
      apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
      kind: 'Host',
      metadata: {
        name: `${t.metadata.name}-host`,
        namespace: `di-operator-${t.metadata.name}`,
        labels: { hostgroup: `tenant-${t.metadata.name}` },
      },
      environment: `di-tenant-${t.metadata.name}`,
      status: { conditions: ready },
    });
  }
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'wasmcloud-runtime-tls', namespace: cfg.namespace },
    data: { 'ca.crt': 'test' },
  });
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'tenant-auth-oauth', namespace: cfg.namespace },
    data: { clientSecret: Buffer.from(fake.provisioner.clientSecret).toString('base64') },
  });
  const registry = options.registry ?? fake.registry();
  const controller = new Controller(
    api,
    options.config ?? cfg,
    async () => [],
    options.now ?? (() => START),
    options.http ? undefined : registry,
  );
  return { api, fake, controller, tenants };
}

describe('per-tenant OAuth clients in reconcile (#59)', () => {
  it('registers a console and a CLI client per tenant and wires the pair to them', async () => {
    const { api, fake, controller } = prepare();
    await controller.tick();
    const alpha = tenantOAuthClientIds({ name: 'alpha', uid: 'alpha-uid' });
    const beta = tenantOAuthClientIds({ name: 'beta', uid: 'beta-uid' });
    expect([...fake.clients.keys()].sort()).toEqual(
      [alpha.console, alpha.cli, beta.console, beta.cli].sort(),
    );
    expect(fake.clients.get(alpha.console)).toMatchObject({
      organizationSlug: 'alpha',
      redirectUris: ['http://console.alpha.localhost:28180/oidc/callback'],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      audiences: ['https://controller.alpha.localhost:28180'],
      public: false,
      browser: true,
    });
    expect(fake.clients.get(beta.cli)).toMatchObject({
      organizationSlug: 'beta',
      redirectUris: ['http://127.0.0.1/callback'],
      audiences: ['https://controller.beta.localhost:28180'],
      public: true,
    });
    // Each console gets its own Secret with its own client; the two secrets differ.
    const secrets = { alpha: consoleSecret(api, 'alpha')!, beta: consoleSecret(api, 'beta')! };
    expect(decode(secrets.alpha.data.clientId)).toBe(alpha.console);
    expect(decode(secrets.beta.data.clientId)).toBe(beta.console);
    expect(decode(secrets.alpha.data.clientSecret)).toStartWith('fake-secret-');
    expect(secrets.alpha.data.clientSecret).not.toBe(secrets.beta.data.clientSecret);
    expect(secrets.alpha.metadata.labels).toMatchObject({ [OWNER]: 'alpha-uid' });
    // The pair is wired to the tenant's clients; the shared bootstrap client is gone.
    expect(env(api, 'alpha', 'tenant-console')).toMatchObject({
      TENANT_CONSOLE_CLIENT_ID: alpha.console,
    });
    expect(env(api, 'beta', 'tenant-console')).toMatchObject({
      TENANT_CONSOLE_CLIENT_ID: beta.console,
    });
    expect(env(api, 'alpha', 'tenant-controller')).toMatchObject({
      TENANT_CONTROLLER_CLI_CLIENT_ID: alpha.cli,
    });
    expect(env(api, 'beta', 'tenant-controller')).toMatchObject({
      TENANT_CONTROLLER_CLI_CLIENT_ID: beta.cli,
    });
    for (const name of ['alpha', 'beta'])
      for (const deployment of ['tenant-console', 'tenant-controller'])
        expect(Object.values(env(api, name, deployment))).not.toContain('access');
    // The provisioner credentials stay in the platform namespace.
    const leaked = [...api.objects.entries()].filter(
      ([key, value]) =>
        !key.includes(`/namespaces/${cfg.namespace}/`) &&
        JSON.stringify(value).includes(fake.provisioner.clientSecret),
    );
    expect(leaked).toEqual([]);
    expect(condition(api, 'alpha', 'TenantAuthReady')).toMatchObject({ reason: 'Provisioning' });
  });

  it('keeps the clients and the stored secret on later passes', async () => {
    const fake = new FakeIdentityAdmin();
    const calls: string[] = [];
    const inner = fake.registry();
    const registry: OAuthClientRegistry = {
      ...inner,
      create: (spec, key) => {
        calls.push(`create ${spec.clientId}`);
        return inner.create(spec, key);
      },
      rotate: (id, version, key) => {
        calls.push(`rotate ${id}`);
        return inner.rotate(id, version, key);
      },
    };
    const { api, controller } = prepare({ registry, tenants: [tenant('alpha')] });
    await controller.tick();
    const first = consoleSecret(api, 'alpha')!.data;
    await controller.tick();
    await controller.tick();
    expect(consoleSecret(api, 'alpha')!.data).toEqual(first);
    expect(calls).toEqual([
      'create tenant-alpha-alphauid-cli',
      'create tenant-alpha-alphauid-console',
    ]);
    expect(fake.clients.size).toBe(2);
  });

  it('issues the console secret again when the Secret is lost or belongs to another client', async () => {
    const { api, fake, controller } = prepare({ tenants: [tenant('alpha')] });
    await controller.tick();
    const first = consoleSecret(api, 'alpha')!.data;
    // Lost between the create and the write: rotated, deterministically per Tenant.
    api.objects.delete(path('Secret', runtime('alpha'), CONSOLE_OAUTH_SECRET));
    await controller.tick();
    const rotated = consoleSecret(api, 'alpha')!.data;
    expect(rotated.clientId).toBe(first.clientId);
    expect(rotated.clientSecret).not.toBe(first.clientSecret);
    await controller.tick();
    expect(consoleSecret(api, 'alpha')!.data).toEqual(rotated);
    api.objects.delete(path('Secret', runtime('alpha'), CONSOLE_OAUTH_SECRET));
    await controller.tick();
    expect(consoleSecret(api, 'alpha')!.data).toEqual(rotated);
    expect(fake.clients.size).toBe(2);
    // A Secret this installation did not write for the Tenant is not trusted either: the secret
    // is issued again, and the apply then refuses the foreign Secret as before.
    const foreign = consoleSecret(api, 'alpha')!;
    foreign.metadata.labels = { ...foreign.metadata.labels, [OWNER]: 'someone-else' };
    await controller.tick();
    expect(condition(api, 'alpha', 'TenantAuthReady')).toMatchObject({
      status: 'False',
      reason: 'ReconcileError',
      message: expect.stringContaining('Refusing to adopt Secret'),
    });
    // Owned again: the stored secret (the rotated one) is trusted, and nothing is rotated.
    foreign.metadata.labels[OWNER] = 'alpha-uid';
    await controller.tick();
    expect(consoleSecret(api, 'alpha')!.data).toEqual(rotated);
    expect(condition(api, 'alpha', 'TenantAuthReady')).toMatchObject({ reason: 'Provisioning' });
  });

  it('reports an identity server failure on TenantAuthReady and keeps the pair running', async () => {
    const fake = new FakeIdentityAdmin();
    let down = false;
    const inner = fake.registry();
    const registry: OAuthClientRegistry = {
      ...inner,
      get: (id) => {
        if (down) throw oauthAdminError(503, 'GET /api/admin/oauth-clients: HTTP 503');
        return inner.get(id);
      },
    };
    const { api, controller } = prepare({ registry, tenants: [tenant('alpha')] });
    await controller.tick();
    expect(condition(api, 'alpha', 'TenantAuthReady')).toMatchObject({ reason: 'Provisioning' });
    down = true;
    await controller.tick();
    expect(condition(api, 'alpha', 'TenantAuthReady')).toMatchObject({
      status: 'False',
      reason: 'OAuthClientError',
      message: 'GET /api/admin/oauth-clients: HTTP 503',
    });
    expect(api.objects.get(path('Deployment', runtime('alpha'), 'tenant-console'))).toBeDefined();
    expect(consoleSecret(api, 'alpha')).toBeDefined();
    // A client revoked behind the controller's back cannot be reused: reported, never recreated.
    down = false;
    await inner.delete(tenantOAuthClientIds({ name: 'alpha', uid: 'alpha-uid' }).console);
    await controller.tick();
    expect(condition(api, 'alpha', 'TenantAuthReady')).toMatchObject({
      reason: 'OAuthClientError',
      message: 'OAuth client tenant-alpha-alphauid-console is revoked',
    });
    expect(fake.clients.size).toBe(2);
  });

  it('talks to the identity server over HTTP as the provisioner client by default', async () => {
    const fake = new FakeIdentityAdmin();
    const server = fake.serve();
    servers.push(server);
    const upstream: TenantAuthConfig = {
      ...auth,
      issuer: 'http://identity.alpha.localhost:28180',
      issuerUpstream: `127.0.0.1:${server.port}`,
      issuerUpstreamPodPort: server.port,
    };
    // The platform Secret `prepare` seeds holds the provisioner secret the fake server accepts.
    const { api, controller } = prepare({
      http: true,
      config: { ...cfg, tenantAuth: upstream },
      tenants: [tenant('alpha')],
    });
    await controller.tick();
    await controller.tick();
    expect(fake.clients.size).toBe(2);
    expect(decode(consoleSecret(api, 'alpha')!.data.clientSecret)).toStartWith('fake-secret-');
    expect(condition(api, 'alpha', 'TenantAuthReady')).toMatchObject({ reason: 'Provisioning' });
    // Through the upstream, under the issuer's Host; one token for both passes.
    expect(new Set(fake.hosts)).toEqual(new Set(['identity.alpha.localhost:28180']));
    expect(fake.requests.filter((r) => r === 'POST /oauth2/token')).toHaveLength(1);
    // The identity server restarted and forgot its tokens: minted again, once.
    fake.tokens.clear();
    await controller.tick();
    expect(fake.requests.filter((r) => r === 'POST /oauth2/token')).toHaveLength(2);
    expect(condition(api, 'alpha', 'TenantAuthReady')).toMatchObject({ reason: 'Provisioning' });
    // A wrong provisioner secret is an admin error; a missing Secret a configuration error.
    fake.provisioner.clientSecret = 'rotated';
    fake.tokens.clear();
    await controller.tick();
    expect(condition(api, 'alpha', 'TenantAuthReady')).toMatchObject({
      reason: 'OAuthClientError',
      message: expect.stringContaining(
        '/oauth2/token: HTTP 401 for provisioner client provisioner',
      ),
    });
    api.objects.delete(path('Secret', cfg.namespace, 'tenant-auth-oauth'));
    await controller.tick();
    expect(condition(api, 'alpha', 'TenantAuthReady')).toMatchObject({
      reason: 'ReconcileError',
      message:
        'Secret wasmcloud/tenant-auth-oauth (tenantAuth.oauthClient.secretName) has no key clientSecret',
    });
  });
});

describe('tenant removal revokes the OAuth clients (#59)', () => {
  /** Marks `name` for deletion under `policy`; its Host is gone, as the operator's stop leaves it. */
  function deleting(api: MemoryApi, name: string, policy: 'Delete' | 'Retain') {
    const t = live(api, name);
    t.metadata.deletionTimestamp = START.toISOString();
    t.spec.deletionPolicy = policy;
    api.objects.delete(
      `${collection('runtime.wasmcloud.dev/v1alpha1', 'Host', `di-operator-${name}`)}/${name}-host`,
    );
  }

  it('revokes the deleted tenant’s clients in R6 and leaves the other tenant’s', async () => {
    const { api, fake, controller } = prepare();
    await controller.tick();
    deleting(api, 'alpha', 'Delete');
    await until(controller, () => finalized(api, 'alpha'));
    expect(finalized(api, 'alpha')).toBe(true);
    const alpha = tenantOAuthClientIds({ name: 'alpha', uid: 'alpha-uid' });
    const beta = tenantOAuthClientIds({ name: 'beta', uid: 'beta-uid' });
    expect(fake.clients.get(alpha.console)?.revokedAt).toBeString();
    expect(fake.clients.get(alpha.cli)?.revokedAt).toBeString();
    expect(fake.clients.get(beta.console)?.revokedAt).toBeUndefined();
    expect(fake.clients.get(beta.cli)?.revokedAt).toBeUndefined();
    expect(consoleSecret(api, 'beta')).toBeDefined();
  });

  it('revokes them under Retain too', async () => {
    const { api, fake, controller } = prepare({ tenants: [tenant('alpha')] });
    await controller.tick();
    deleting(api, 'alpha', 'Retain');
    await until(controller, () => finalized(api, 'alpha'));
    expect(finalized(api, 'alpha')).toBe(true);
    expect([...fake.clients.values()].every((client) => client.revokedAt)).toBe(true);
    expect(api.objects.has(`${collection('v1', 'Namespace')}/${runtime('alpha')}`)).toBe(true);
  });

  it('waits on a client it cannot revoke, reports RemovalStuck past the deadline, and never forces', async () => {
    const fake = new FakeIdentityAdmin();
    const inner = fake.registry();
    const ids = tenantOAuthClientIds({ name: 'alpha', uid: 'alpha-uid' });
    let down = true;
    const registry: OAuthClientRegistry = {
      ...inner,
      delete: (id) => {
        if (down && id === ids.console) throw oauthAdminError(503, 'identity down');
        return inner.delete(id);
      },
    };
    const clock = { now: new Date(START) };
    const { api, controller } = prepare({
      registry,
      tenants: [tenant('alpha')],
      now: () => new Date(clock.now),
    });
    await controller.tick();
    deleting(api, 'alpha', 'Delete');
    // The namespaces go in the same step and are gone a pass later; the client stays.
    const message = () => condition(api, 'alpha', 'Ready')?.message ?? '';
    await until(
      controller,
      () => message().includes('oauthclient') && !message().includes('namespace/'),
    );
    expect(message()).toBe(`Delete: removal step R6 waits for oauthclient/${ids.console}`);
    expect(fake.clients.get(ids.cli)?.revokedAt).toBeString();
    expect(finalized(api, 'alpha')).toBe(false);
    clock.now = new Date(START.getTime() + REMOVAL_STEP_DEADLINE_MS);
    await controller.tick();
    expect(condition(api, 'alpha', REMOVAL_STUCK)).toMatchObject({
      reason: 'R6',
      message: expect.stringContaining(`remaining: oauthclient/${ids.console}`),
    });
    expect(finalized(api, 'alpha')).toBe(false);
    down = false;
    await controller.tick();
    expect(finalized(api, 'alpha')).toBe(true);
    expect(fake.clients.get(ids.console)?.revokedAt).toBeString();
  });

  it('removes a tenant without tenantAuth as before', async () => {
    const { api, fake, controller } = prepare({ config: baseCfg, tenants: [tenant('alpha')] });
    await controller.tick();
    deleting(api, 'alpha', 'Delete');
    await until(controller, () => finalized(api, 'alpha'));
    expect(finalized(api, 'alpha')).toBe(true);
    expect(fake.clients.size).toBe(0);
  });
});
