import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  SCHEDULER_TLS_COPY,
  TENANT,
  TENANT_HOST_SECRET,
} from '../src/tenancy/resources';
import {
  bootstrapSchedulerPki,
  IDENTITIES_KEY,
  parseIdentityRecord,
  SCHEDULER_LEAF_RENEW_DAYS,
} from '../src/tenancy/scheduler-pki';
import {
  ROTATE_ANNOTATION,
  SCHEDULER_TLS_ANNOTATION,
  schedulerCertDigest,
} from '../src/tenancy/scheduler-pki-rotation';
import { TENANT_OPERATOR_PROPAGATION_MS } from '../src/tenancy/tenant-operator';
import {
  cfg,
  MemoryApi,
  prepare as prepareHarness,
  recordPath,
  START,
  stored,
  tenantPath,
} from './support/controller-harness';
import { API_SERVER_SLICE } from './support/cutover';
import { PropagationInvariant } from './support/propagation-invariant';

// #541 m6e: the controller applies each tenant's own runtime-operator, then moves its hosts onto
// the issued identity `di-scheduler-host-tls`, then deletes the copy of `wasmcloud-runtime-tls`.

const n = names('alpha');
const OPERATOR_NS = 'di-operator-alpha';
const operatorPath = `${collection('apps/v1', 'Deployment', OPERATOR_NS)}/runtime-operator`;
const hostsPath = `${collection('apps/v1', 'Deployment', n.runtimeNamespace)}/hostgroup-${n.hostgroup}`;
const hostSecretPath = `${collection('v1', 'Secret', n.runtimeNamespace)}/${TENANT_HOST_SECRET}`;
const operatorSecretPath = `${collection('v1', 'Secret', OPERATOR_NS)}/di-scheduler-operator-tls`;
const copyPath = `${collection('v1', 'Secret', n.runtimeNamespace)}/${SCHEDULER_TLS_COPY}`;
const clock = { now: START };
const advance = (ms: number) => {
  clock.now = new Date(clock.now.getTime() + ms);
};

/** The harness API, with Deployments that roll out at once unless `held`. */
class CutoverApi extends MemoryApi {
  /** Deployment names whose rollout does not complete. */
  held = new Set<string>();
  /** The host Deployment's applies fail, as a refused apply does (probe B1 of the #613 review). */
  refuseHosts = false;
  override async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.refuseHosts && method === 'PATCH' && path.startsWith(`${hostsPath}?`))
      throw new ApiError(422, 'host apply refused');
    const result = await super.call<Resource>(method, path, body);
    if (method === 'PATCH' && path.includes('/deployments/') && !path.includes('/status')) {
      const target = new URL(path, 'https://kubernetes').pathname;
      const value = this.objects.get(target) as Resource;
      const replicas = (value.spec as { replicas?: number } | undefined)?.replicas ?? 1;
      const done = this.held.has(value.metadata.name) ? 0 : replicas;
      value.status = {
        observedGeneration: value.metadata.generation,
        replicas,
        updatedReplicas: done,
        readyReplicas: done,
      };
      return structuredClone(value) as T;
    }
    return result as T;
  }
  /** Paths of the server-side applies, in order. */
  applies(): string[] {
    return this.operations
      .filter((o) => o.method === 'PATCH' && o.path.includes('fieldManager='))
      .map((o) => o.path.split('?')[0] as string);
  }
}

/**
 * The harness with the m6e-E invariant checked after every tick: each identity Secret holds a
 * certificate whose user has propagated, or the previous user, still admitted.
 */
const prepare = async (pki = true) => {
  const { api, controller } = await prepareHarness(new CutoverApi(), { pki }, () => clock.now);
  api.seed(API_SERVER_SLICE);
  const invariant = checked(api, controller);
  return { api, controller, invariant };
};
function checked(api: MemoryApi, controller: { tick(): Promise<void> }) {
  const invariant = new PropagationInvariant(api, () => clock.now);
  const tick = controller.tick.bind(controller);
  controller.tick = async () => {
    await tick();
    invariant.check();
  };
  return invariant;
}

/**
 * Ticks until the operator Deployment exists: the record and the accounts write, the tick that
 * sees the users named, the one after the wait that writes the Secrets (m6e-E), and the one that
 * creates the operator now that its Secret exists.
 */
async function throughPropagation(controller: { tick(): Promise<void> }) {
  await controller.tick();
  await controller.tick();
  advance(TENANT_OPERATOR_PROPAGATION_MS);
  await controller.tick();
  await controller.tick();
}

const hostTemplate = (api: MemoryApi) =>
  (
    api.objects.get(hostsPath) as unknown as {
      spec: {
        template: {
          metadata: { annotations: Record<string, string> };
          spec: { volumes: { name: string; secret?: { secretName: string } }[] };
        };
      };
    }
  ).spec.template;

const hostCert = (api: MemoryApi) =>
  Buffer.from(
    (api.objects.get(hostSecretPath)?.data as Record<string, string> | undefined)?.[
      'tls.crt'
    ] as string,
    'base64',
  ).toString('utf8');

const readyCondition = (api: MemoryApi) =>
  stored(api).status?.conditions?.find((c) => c.type === 'Ready');

const registerHost = (api: MemoryApi, namespace = OPERATOR_NS) =>
  api.seed({
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'Host',
    metadata: { name: 'alpha-host', namespace, labels: { hostgroup: n.hostgroup } },
    environment: n.namespace,
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  } as unknown as Resource);

const copy = (labels: Record<string, string>): Resource => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name: SCHEDULER_TLS_COPY, namespace: n.runtimeNamespace, labels },
  data: { 'ca.crt': 'b2xk' },
});
const owned = { [INSTALLATION]: 'test', [OWNER]: 'alpha-uid', [TENANT]: 'alpha' };

const pod = (name: string, secretName: string, options: { terminating?: boolean } = {}) =>
  ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: n.runtimeNamespace,
      ...(options.terminating ? { deletionTimestamp: '2026-10-30T00:00:00Z' } : {}),
    },
    spec: { volumes: [{ name: 'scheduler', secret: { secretName } }] },
  }) as unknown as Resource;

let logs: ReturnType<typeof spyOn>[];
beforeEach(() => {
  clock.now = START;
  logs = (['log', 'warn', 'error'] as const).map((m) =>
    spyOn(console, m).mockImplementation(() => {}),
  );
});
afterEach(() => {
  for (const log of logs) log.mockRestore();
});

describe('per-tenant gating (#541 m6e)', () => {
  it('applies the operator objects in order, the Deployment only once its Secret holds a propagated user, then the hosts', async () => {
    const { api, controller } = await prepare();
    await controller.tick();
    const first = api.applies();
    const operator = first.filter((p) => p.includes(OPERATOR_NS) || p.includes('operator'));
    expect(operator).toEqual([
      `${collection('v1', 'Namespace')}/${OPERATOR_NS}`,
      `${collection('v1', 'ServiceAccount', OPERATOR_NS)}/runtime-operator`,
      `${collection('rbac.authorization.k8s.io/v1', 'RoleBinding', OPERATOR_NS)}/di-tenant-operator-self`,
      `${collection('rbac.authorization.k8s.io/v1', 'RoleBinding', n.namespace)}/di-tenant-operator-workloads`,
      `${collection('rbac.authorization.k8s.io/v1', 'RoleBinding', n.runtimeNamespace)}/di-tenant-operator-hosts`,
      `${collection('networking.k8s.io/v1', 'NetworkPolicy', OPERATOR_NS)}/di-operator-egress`,
      `${collection('networking.k8s.io/v1', 'NetworkPolicy', OPERATOR_NS)}/di-operator-ingress`,
    ]);
    // The tick recorded the identities and wrote the accounts file; no Secret before the wait
    // (m6e-E), so no operator and no hosts either.
    expect(api.objects.has(operatorSecretPath)).toBe(false);
    expect(api.objects.has(hostSecretPath)).toBe(false);
    expect(api.objects.has(operatorPath)).toBe(false);
    expect(api.objects.has(hostsPath)).toBe(false);
    // The file names the users now; the wait starts here.
    await controller.tick();
    advance(TENANT_OPERATOR_PROPAGATION_MS - 1);
    await controller.tick();
    expect(api.objects.has(operatorSecretPath)).toBe(false);
    expect(api.objects.has(operatorPath)).toBe(false);
    advance(1);
    await controller.tick();
    // Both Secrets are written at the end of the pass, after the operator's apply.
    expect(api.objects.has(operatorSecretPath)).toBe(true);
    expect(api.objects.has(hostSecretPath)).toBe(true);
    expect(api.objects.has(operatorPath)).toBe(false);
    api.operations.length = 0;
    await controller.tick();
    const applies = api.applies();
    expect(applies.indexOf(operatorPath)).toBeGreaterThan(-1);
    // The operator was Ready in this pass, so the hosts follow it.
    expect(applies.indexOf(hostsPath)).toBeGreaterThan(applies.indexOf(operatorPath));
  });

  it('holds the hosts while the operator is not Ready, and keeps applying an existing operator', async () => {
    const { api, controller } = await prepare();
    api.held.add('runtime-operator');
    await throughPropagation(controller);
    expect(api.objects.has(operatorPath)).toBe(true);
    expect(api.objects.has(hostsPath)).toBe(false);
    expect(readyCondition(api)).toMatchObject({ status: 'False' });
    // An existing operator is applied on every pass, with no further wait.
    api.operations.length = 0;
    await controller.tick();
    expect(api.applies()).toContain(operatorPath);
    api.held.delete('runtime-operator');
    await controller.tick();
    expect(api.objects.has(hostsPath)).toBe(true);
  });

  // W1 of the #613 review: only the first move onto di-scheduler-host-tls waits for the operator.
  describe('once the hosts are on their own identity, an unready operator holds nothing', () => {
    const tenantSpec = (api: MemoryApi) =>
      (
        api.objects.get(tenantPath) as unknown as {
          spec: { suspended?: boolean; runtime?: { replicas?: number } };
        }
      ).spec;
    const hostReplicas = (api: MemoryApi) =>
      (api.objects.get(hostsPath)?.spec as { replicas: number } | undefined)?.replicas;
    /** Steady state, then the operator's rollout held. */
    const cutOverThenHold = async () => {
      const { api, controller } = await prepare();
      await throughPropagation(controller);
      expect(hostReplicas(api)).toBe(1);
      api.held.add('runtime-operator');
      await controller.tick();
      return { api, controller };
    };

    it("scales a suspended Tenant's hosts to zero", async () => {
      const { api, controller } = await cutOverThenHold();
      tenantSpec(api).suspended = true;
      await controller.tick();
      await controller.tick();
      expect(hostReplicas(api)).toBe(0);
    });

    it('applies a replica change', async () => {
      const { api, controller } = await cutOverThenHold();
      tenantSpec(api).runtime = { ...tenantSpec(api).runtime, replicas: 3 };
      await controller.tick();
      expect(hostReplicas(api)).toBe(3);
      // Not Ready: the operator is not.
      expect(readyCondition(api)).toMatchObject({ status: 'False' });
    });

    it('rolls a renewed certificate', async () => {
      const { api, controller } = await cutOverThenHold();
      const before = hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION];
      api.objects.delete(hostSecretPath);
      await controller.tick();
      await controller.tick();
      // m6e-E: no Secret until the new user has propagated, so a pod that starts meanwhile waits
      // for the volume; the template is left as it is.
      expect(api.objects.has(hostSecretPath)).toBe(false);
      expect(hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION]).toBe(before);
      advance(TENANT_OPERATOR_PROPAGATION_MS);
      await controller.tick();
      expect(api.objects.has(hostSecretPath)).toBe(true);
      await controller.tick();
      const after = hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION];
      expect(after).not.toBe(before);
      expect(after).toBe(schedulerCertDigest(hostCert(api)));
    });

    const legacyHosts = (replicas: number) =>
      ({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: `hostgroup-${n.hostgroup}`,
          namespace: n.runtimeNamespace,
          labels: owned,
        },
        spec: {
          replicas,
          template: {
            spec: { volumes: [{ name: 'scheduler', secret: { secretName: SCHEDULER_TLS_COPY } }] },
          },
        },
      }) as unknown as Resource;

    // P1 of the #613 round-2 review: suspended during the upgrade, before its operator is Ready.
    it("scales a suspended Tenant's pre-cut-over hosts to zero while its operator is not Ready", async () => {
      const { api, controller } = await prepare();
      api.held.add('runtime-operator');
      await throughPropagation(controller);
      api.seed(legacyHosts(2));
      await controller.tick();
      expect(hostReplicas(api)).toBe(2);
      tenantSpec(api).suspended = true;
      await controller.tick();
      await controller.tick();
      expect(hostReplicas(api)).toBe(0);
    });

    // P3 of the #613 round-2 review: no host identity was ever issued.
    it("scales a suspended Tenant's pre-cut-over hosts to zero when its host identity is not issued", async () => {
      const { api, controller } = await prepare(false);
      api.seed(legacyHosts(2));
      await controller.tick();
      expect(hostReplicas(api)).toBe(2);
      tenantSpec(api).suspended = true;
      await controller.tick();
      await controller.tick();
      expect(hostReplicas(api)).toBe(0);
      expect(api.objects.has(hostSecretPath)).toBe(false);
      // Rendered with no digest; the first issued one is rolled after its propagation wait.
      expect(hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION]).toBe('');
      // A Deployment already on the issued identity keeps the digest it carries.
      hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION] = 'kept';
      await controller.tick();
      expect(hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION]).toBe('kept');
    });

    // W1 of the #613 round-3 review: a template rendered while suspended with an empty digest has
    // not moved; unsuspended, it is held at zero until the operator is Ready, then rolls once.
    /** Ticks with the operator held, then released; the distinct `replicas:digest` templates seen. */
    const rollout = async (api: CutoverApi, controller: { tick(): Promise<void> }) => {
      const seen: string[] = [];
      const record = () => {
        const value = `${hostReplicas(api)}:${hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION]}`;
        if (seen.at(-1) !== value) seen.push(value);
      };
      api.held.add('runtime-operator');
      record();
      for (let i = 0; i < 4; i++) {
        await controller.tick();
        record();
        advance(TENANT_OPERATOR_PROPAGATION_MS);
      }
      expect(seen).toEqual(['0:']);
      api.held.delete('runtime-operator');
      await controller.tick();
      record();
      await controller.tick();
      record();
      return seen;
    };

    it('holds hosts unsuspended after a suspended first tick until the operator is Ready, then rolls once', async () => {
      const { api, controller } = await prepare();
      api.seed(legacyHosts(2));
      tenantSpec(api).suspended = true;
      await controller.tick();
      expect(hostReplicas(api)).toBe(0);
      tenantSpec(api).suspended = false;
      const seen = await rollout(api, controller);
      expect(seen).toEqual(['0:', `1:${schedulerCertDigest(hostCert(api))}`]);
    });

    // W1 of the #613 round-4 review: a second suspended tick sees the issued digest; it must not
    // move the template before the operator is Ready.
    it('holds hosts suspended for two first ticks until the operator is Ready, then rolls once', async () => {
      const { api, controller } = await prepare();
      api.seed(legacyHosts(2));
      tenantSpec(api).suspended = true;
      await controller.tick();
      await controller.tick();
      expect(hostReplicas(api)).toBe(0);
      tenantSpec(api).suspended = false;
      const seen = await rollout(api, controller);
      expect(seen).toEqual(['0:', `1:${schedulerCertDigest(hostCert(api))}`]);
    });

    it('holds hosts suspended before issuance until the operator is Ready, then rolls once', async () => {
      const { api, controller, invariant } = await prepare(false);
      api.seed(legacyHosts(2));
      tenantSpec(api).suspended = true;
      await controller.tick();
      await controller.tick();
      tenantSpec(api).suspended = false;
      await controller.tick();
      await bootstrapSchedulerPki(api, cfg, clock.now);
      invariant.trust();
      const seen = await rollout(api, controller);
      expect(seen).toEqual(['0:', `1:${schedulerCertDigest(hostCert(api))}`]);
    });

    it('still holds hosts that mount the copy, and creates none, until the operator is Ready', async () => {
      const { api, controller } = await prepare();
      api.held.add('runtime-operator');
      await throughPropagation(controller);
      // A pre-cut-over host Deployment on the copy is left as it is.
      const legacy = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: `hostgroup-${n.hostgroup}`,
          namespace: n.runtimeNamespace,
          labels: owned,
        },
        spec: {
          replicas: 1,
          template: {
            spec: { volumes: [{ name: 'scheduler', secret: { secretName: SCHEDULER_TLS_COPY } }] },
          },
        },
      } as unknown as Resource;
      api.seed(legacy);
      await controller.tick();
      expect(JSON.stringify(api.objects.get(hostsPath))).toContain(SCHEDULER_TLS_COPY);
      api.held.delete('runtime-operator');
      await controller.tick();
      expect(hostTemplate(api).spec.volumes).toContainEqual({
        name: 'scheduler',
        secret: { secretName: TENANT_HOST_SECRET },
      });
    });
  });

  it('restarts the wait when the file stops naming the operator user', async () => {
    const { api, controller } = await prepare();
    await controller.tick();
    await controller.tick();
    // The accounts file loses the operator (a refused render keeps an older one): no Secret.
    const accountsPath = `${collection('v1', 'ConfigMap', 'wasmcloud')}/di-scheduler-nats-accounts`;
    const accounts = api.objects.get(accountsPath) as Resource;
    const text = (accounts.data as Record<string, string>)['accounts.conf'] as string;
    (accounts.data as Record<string, string>)['accounts.conf'] = text.replace(
      /\.operator\.di-tenant-alpha\./g,
      '.gone.',
    );
    advance(TENANT_OPERATOR_PROPAGATION_MS);
    // This pass reads the edited file before the writer restores it, so the wait restarts. The
    // hosts user stayed named, so its Secret is written.
    await controller.tick();
    expect(api.objects.has(operatorSecretPath)).toBe(false);
    expect(api.objects.has(hostSecretPath)).toBe(true);
    await controller.tick();
    advance(TENANT_OPERATOR_PROPAGATION_MS - 1);
    await controller.tick();
    expect(api.objects.has(operatorSecretPath)).toBe(false);
    advance(1);
    await controller.tick();
    expect(api.objects.has(operatorSecretPath)).toBe(true);
    await controller.tick();
    expect(api.objects.has(operatorPath)).toBe(true);
  });

  it('applies nothing of the operator while the API server endpoints are unknown', async () => {
    const { api, controller } = await prepare();
    api.objects.delete(
      `${collection('discovery.k8s.io/v1', 'EndpointSlice', 'default')}/kubernetes`,
    );
    await throughPropagation(controller);
    expect(api.applies().some((p) => p.includes(OPERATOR_NS))).toBe(false);
    expect(api.objects.has(hostsPath)).toBe(false);
  });

  it('waits for the record before it creates an operator', async () => {
    const { api, controller } = await prepare(false);
    await throughPropagation(controller);
    expect(api.applies()).toContain(`${collection('v1', 'Namespace')}/${OPERATOR_NS}`);
    expect(api.objects.has(operatorPath)).toBe(false);
  });

  it('reports a failed operator apply on the Tenant and still issues identities', async () => {
    const { api, controller } = await prepare();
    const call = api.call.bind(api);
    spyOn(api, 'call').mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === 'PATCH' && path.includes('/serviceaccounts/runtime-operator'))
        throw new ApiError(500, 'boom');
      return call(method, path, body);
    });
    await controller.tick();
    expect(readyCondition(api)).toMatchObject({ status: 'False', reason: 'ReconcileError' });
    await controller.tick();
    advance(TENANT_OPERATOR_PROPAGATION_MS);
    await controller.tick();
    expect(readyCondition(api)).toMatchObject({ status: 'False', reason: 'ReconcileError' });
    expect(api.objects.has(hostSecretPath)).toBe(true);
  });
});

describe('hosts on di-scheduler-host-tls (#541 m6e)', () => {
  it('mounts the issued identity and carries its certificate digest, which follows a rotation', async () => {
    const { api, controller } = await prepare();
    await throughPropagation(controller);
    const template = hostTemplate(api);
    expect(template.spec.volumes).toContainEqual({
      name: 'scheduler',
      secret: { secretName: TENANT_HOST_SECRET },
    });
    expect(JSON.stringify(template)).not.toContain(SCHEDULER_TLS_COPY);
    expect(template.metadata.annotations[SCHEDULER_TLS_ANNOTATION]).toBe(
      schedulerCertDigest(hostCert(api)),
    );
    // Deleting the Secret re-issues it with no previous user, so the running pods are refused
    // at the next accounts reload. The Secret is written only once the new user has been in the
    // accounts file for the propagation wait (m6e-E), so new pods wait for the volume rather than
    // being refused at start; the template is left as it is meanwhile, then rolls onto it.
    const before = template.metadata.annotations[SCHEDULER_TLS_ANNOTATION];
    api.objects.delete(hostSecretPath);
    await controller.tick();
    await controller.tick();
    expect(hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION]).toBe(before);
    advance(TENANT_OPERATOR_PROPAGATION_MS - 1);
    await controller.tick();
    expect(api.objects.has(hostSecretPath)).toBe(false);
    expect(hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION]).toBe(before);
    advance(1);
    await controller.tick();
    expect(api.objects.has(hostSecretPath)).toBe(true);
    expect(hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION]).toBe(before);
    await controller.tick();
    const after = hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION];
    expect(after).not.toBe(before);
    expect(after).toBe(schedulerCertDigest(hostCert(api)));
  });

  it('renders no hosts from a host Secret this controller did not issue', async () => {
    const { api, controller } = await prepare();
    await throughPropagation(controller);
    api.objects.delete(hostsPath);
    const secret = api.objects.get(hostSecretPath) as Resource;
    secret.metadata.labels = { ...secret.metadata.labels, [OWNER]: 'someone-else' };
    // Issuance refuses the foreign Secret (SecretNotOwned), and the hosts are not rendered from it.
    await controller.tick();
    expect(api.objects.has(hostsPath)).toBe(false);
  });

  // S1 of the #613 round-3 review: a suspended Tenant whose host identity is not issued is not Ready.
  it('reports a suspended Tenant without an issued host identity not Ready', async () => {
    const { api, controller } = await prepare();
    await throughPropagation(controller);
    registerHost(api);
    (stored(api).spec as { suspended?: boolean }).suspended = true;
    await controller.tick();
    await controller.tick();
    expect(readyCondition(api)).toMatchObject({ status: 'True', reason: 'Suspended' });
    api.objects.delete(hostSecretPath);
    await controller.tick();
    expect(readyCondition(api)).toMatchObject({ status: 'False', reason: 'Suspended' });
  });

  // P2 of the #613 round-2 review: Ready needs the operator Ready, not only the hosts.
  it('reports not Ready once the operator stops being Ready', async () => {
    const { api, controller } = await prepare();
    await throughPropagation(controller);
    registerHost(api);
    await controller.tick();
    expect(readyCondition(api)).toMatchObject({ status: 'True', reason: 'Reconciled' });
    api.held.add('runtime-operator');
    await controller.tick();
    await controller.tick();
    expect(readyCondition(api)).toMatchObject({ status: 'False' });
  });

  // S4 of the #613 round-2 review: the API server's EndpointSlices are read once per tick.
  it('reads the API server endpoints once per tick, for every Tenant', async () => {
    const { api, controller } = await prepare();
    const { tenant } = await import('./support/controller-harness');
    const beta = tenant();
    beta.metadata = { ...beta.metadata, name: 'beta', uid: 'beta-uid' };
    api.seed(beta);
    await throughPropagation(controller);
    api.operations.length = 0;
    await controller.tick();
    const reads = api.operations.filter(
      (o) => o.method === 'GET' && o.path.includes('/endpointslices'),
    );
    expect(reads).toHaveLength(1);
    expect(api.objects.has(operatorPath)).toBe(true);
    expect(
      api.objects.has(
        `${collection('apps/v1', 'Deployment', 'di-operator-beta')}/runtime-operator`,
      ),
    ).toBe(true);
  });

  it('looks the Hosts up in di-operator-<t> for the readiness gate', async () => {
    const { api, controller } = await prepare();
    await throughPropagation(controller);
    await controller.tick();
    // Operator Ready and hosts rolled, but no registered Host yet.
    expect(readyCondition(api)).toMatchObject({ status: 'False' });
    // A Host in the platform namespace is not this tenant's.
    registerHost(api, 'wasmcloud');
    await controller.tick();
    expect(readyCondition(api)).toMatchObject({ status: 'False' });
    registerHost(api);
    await controller.tick();
    expect(readyCondition(api)).toMatchObject({ status: 'True', reason: 'Reconciled' });
    expect(
      api.operations.some(
        (o) =>
          o.method === 'GET' &&
          o.path.startsWith(
            `${collection('runtime.wasmcloud.dev/v1alpha1', 'Host', OPERATOR_NS)}?labelSelector=`,
          ),
      ),
    ).toBe(true);
  });

  it('is not Ready while the hosts have not rolled out', async () => {
    const { api, controller } = await prepare();
    registerHost(api);
    api.held.add(`hostgroup-${n.hostgroup}`);
    await throughPropagation(controller);
    await controller.tick();
    expect(api.objects.has(hostsPath)).toBe(true);
    expect(readyCondition(api)).toMatchObject({ status: 'False' });
    api.held.clear();
    await controller.tick();
    expect(readyCondition(api)).toMatchObject({ status: 'True' });
  });
});

describe('the copied di-scheduler-tls (#541 m6e)', () => {
  it('is deleted once the hosts rolled, no pod mounts it and it is this Tenant’s', async () => {
    const { api, controller } = await prepare();
    api.seed(copy(owned));
    await throughPropagation(controller);
    expect(api.objects.has(copyPath)).toBe(false);
    const deletes = api.operations.filter((o) => o.method === 'DELETE' && o.path === copyPath);
    expect(deletes).toHaveLength(1);
  });

  it('stays while the host Deployment has not rolled out', async () => {
    const { api, controller } = await prepare();
    api.seed(copy(owned));
    api.held.add(`hostgroup-${n.hostgroup}`);
    await throughPropagation(controller);
    await controller.tick();
    expect(api.objects.has(hostsPath)).toBe(true);
    expect(api.objects.has(copyPath)).toBe(true);
  });

  it('stays while a pod in di-runtime-<t> mounts it, terminating ones included', async () => {
    for (const options of [{}, { terminating: true }]) {
      clock.now = START;
      const { api, controller } = await prepare();
      api.seed(copy(owned));
      api.seed(pod('old-host', SCHEDULER_TLS_COPY, options));
      await throughPropagation(controller);
      await controller.tick();
      expect(api.objects.has(copyPath)).toBe(true);
      api.objects.delete(`${collection('v1', 'Pod', n.runtimeNamespace)}/old-host`);
      await controller.tick();
      expect(api.objects.has(copyPath)).toBe(false);
    }
  });

  it('stays while a pod mounts it through a projected volume', async () => {
    const { api, controller } = await prepare();
    api.seed(copy(owned));
    api.seed({
      ...pod('projected', 'unrelated'),
      spec: {
        volumes: [
          { name: 'plain', configMap: { name: 'x' } },
          { name: 'all', projected: { sources: [{ secret: { name: SCHEDULER_TLS_COPY } }] } },
        ],
      },
    } as unknown as Resource);
    // A pod mounting something else never holds it.
    api.seed(pod('other', TENANT_HOST_SECRET));
    await throughPropagation(controller);
    await controller.tick();
    expect(api.objects.has(copyPath)).toBe(true);
  });

  it('is never deleted without this installation’s and Tenant’s owner labels', async () => {
    for (const labels of [
      { ...owned, [INSTALLATION]: 'other' },
      { ...owned, [OWNER]: 'other-uid' },
      {},
    ]) {
      clock.now = START;
      const { api, controller } = await prepare();
      api.seed(copy(labels));
      await throughPropagation(controller);
      await controller.tick();
      expect(api.objects.has(copyPath)).toBe(true);
    }
  });

  it('is deleted for a suspended Tenant once its zero-replica template is observed', async () => {
    const { api, controller } = await prepare();
    const tenant = api.objects.get(tenantPath) as unknown as { spec: { suspended?: boolean } };
    tenant.spec.suspended = true;
    api.seed(copy(owned));
    await throughPropagation(controller);
    // The operator keeps running while suspended (S2); the hosts are at zero.
    expect(
      (api.objects.get(operatorPath)?.spec as { replicas: number } | undefined)?.replicas,
    ).toBe(1);
    expect((api.objects.get(hostsPath)?.spec as { replicas: number } | undefined)?.replicas).toBe(
      0,
    );
    expect(hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION]).toBe(
      schedulerCertDigest(hostCert(api)),
    );
    expect(api.objects.has(copyPath)).toBe(false);
  });
});

describe('a Tenant being deleted keeps its operator through R3 (owner decision 4)', () => {
  /** A cut-over tenant with a registered Host, then marked for deletion. */
  async function deleting() {
    const { api, controller } = await prepare();
    registerHost(api);
    await throughPropagation(controller);
    const tenant = api.objects.get(tenantPath) as unknown as {
      metadata: { deletionTimestamp?: string; finalizers?: string[] };
    };
    tenant.metadata.deletionTimestamp = '2026-10-30T01:00:00Z';
    api.operations.length = 0;
    return { api, controller };
  }
  const record = (api: MemoryApi) =>
    parseIdentityRecord(
      (api.objects.get(recordPath)?.data as Record<string, string> | undefined)?.[
        IDENTITIES_KEY
      ] as string,
    );

  it('keeps applying the operator and issuing its identity while R2 waits for the hosts', async () => {
    const { api, controller } = await deleting();
    await controller.tick();
    expect(stored(api).status?.conditions?.[0]?.message).toContain('removal step R2');
    expect(api.applies()).toContain(operatorPath);
    // R1 dropped the hosts' identity; the operator's stays and is re-issued when it is missing.
    expect(record(api)['tenant/alpha/hosts']).toBeUndefined();
    expect(record(api)['tenant/alpha/operator']).toBeDefined();
    api.objects.delete(operatorSecretPath);
    await controller.tick();
    // Re-issued once its new user has propagated (m6e-E).
    expect(api.objects.has(operatorSecretPath)).toBe(false);
    await controller.tick();
    advance(TENANT_OPERATOR_PROPAGATION_MS);
    await controller.tick();
    expect(api.objects.has(operatorSecretPath)).toBe(true);
    // The hosts' identity is not issued again.
    expect(record(api)['tenant/alpha/hosts']).toBeUndefined();
    // The operator is never scaled down by the R2 sweep.
    expect(
      (api.objects.get(operatorPath)?.spec as { replicas: number } | undefined)?.replicas,
    ).toBe(1);
  });

  it('stops applying the operator once R1-R3 are complete', async () => {
    const { api, controller } = await deleting();
    api.objects.delete(
      `${collection('runtime.wasmcloud.dev/v1alpha1', 'Host', OPERATOR_NS)}/alpha-host`,
    );
    await controller.tick();
    expect(api.applies()).not.toContain(operatorPath);
    expect(record(api)['tenant/alpha/operator']).toBeUndefined();
  });

  it('logs a failed operator apply during removal and keeps reporting the step', async () => {
    const { api, controller } = await deleting();
    const call = api.call.bind(api);
    spyOn(api, 'call').mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === 'PATCH' && path.includes(`/namespaces/${OPERATOR_NS}?`))
        throw new ApiError(500, 'boom');
      return call(method, path, body);
    });
    await controller.tick();
    expect(stored(api).status?.conditions?.[0]?.message).toContain('removal step R2');
    expect(logs[1]).toHaveBeenCalledWith(
      expect.stringContaining('Tenant/alpha: keeping its runtime-operator during removal failed'),
    );
  });

  it('R5 deletes a leftover copy it owns, never a foreign one', async () => {
    for (const [labels, gone] of [
      [owned, true],
      [{ ...owned, [OWNER]: 'other-uid' }, false],
    ] as const) {
      clock.now = START;
      const { api, controller } = await deleting();
      api.objects.delete(
        `${collection('runtime.wasmcloud.dev/v1alpha1', 'Host', OPERATOR_NS)}/alpha-host`,
      );
      api.seed(copy(labels));
      await controller.tick();
      expect(api.objects.has(copyPath)).toBe(!gone);
    }
  });
});

it('waits again for a re-created Tenant', async () => {
  const { api, controller } = await prepare();
  await controller.tick();
  await controller.tick();
  api.objects.delete(tenantPath);
  await controller.tick();
  // Re-created: the wait starts over.
  const { tenant } = await import('./support/controller-harness');
  api.seed(tenant());
  advance(TENANT_OPERATOR_PROPAGATION_MS);
  await controller.tick();
  expect(api.objects.has(operatorPath)).toBe(false);
});

// The gating of the host Deployment in `hostTlsFor` over every state it can meet (#613 rounds 4, 5).
// Invariants:
// - I1: hosts never run on di-scheduler-host-tls before the tenant operator is Ready and the
//   hosts user has propagated, unless their template has already moved.
// - I2: a suspended Tenant has zero host replicas.
// - I3: a moved template (it mounts di-scheduler-host-tls and carries a non-empty digest) never
//   loses its digest, and rolls again only for a renewal.
// - I4: Ready needs the operator Ready, the host identity issued and the hosts rolled; a
//   suspended Tenant reports Ready (reason Suspended) on the same terms.
describe('host gating matrix (#541 m6e)', () => {
  type Operator = 'missing' | 'not Ready' | 'Ready';
  /**
   * `none`: no host Secret, template on the copy; `foreign`: the same with another digest `old`
   * (S2 of the #613 round-5 review). Issued, not moved: `copy` (template on the copy),
   * `annotated` (on the copy with another digest `old`), `empty` (on the issued Secret, digest '').
   */
  type Identity = 'none' | 'foreign' | 'copy' | 'annotated' | 'empty' | 'moved';
  /** Replicas, mounted Secret, digest (`d` the issued one, `-` none), Tenant Ready. */
  type Cell = [number, 'copy' | 'host', '-' | '' | 'd' | 'old', 'True' | 'False'];
  const ON_COPY: Cell = [2, 'copy', '-', 'False'];
  const ON_ANNOTATED_COPY: Cell = [2, 'copy', 'old', 'False'];
  const HELD_EMPTY: Cell = [0, 'host', '', 'False'];
  const MOVED_UNREADY: Cell = [1, 'host', 'd', 'False'];
  const MOVED_READY: Cell = [1, 'host', 'd', 'True'];
  const OFF_MOVED_UNREADY: Cell = [0, 'host', 'd', 'False'];
  const OFF_MOVED_READY: Cell = [0, 'host', 'd', 'True'];
  const unready: Record<Identity, Cell> = {
    none: ON_COPY,
    foreign: ON_ANNOTATED_COPY,
    copy: ON_COPY,
    annotated: ON_ANNOTATED_COPY,
    empty: HELD_EMPTY,
    moved: MOVED_UNREADY,
  };
  const suspendedUnready: Record<Identity, Cell> = {
    none: HELD_EMPTY,
    foreign: HELD_EMPTY,
    copy: HELD_EMPTY,
    annotated: HELD_EMPTY,
    empty: HELD_EMPTY,
    moved: OFF_MOVED_UNREADY,
  };
  const expected: Record<'running' | 'suspended', Record<Operator, Record<Identity, Cell>>> = {
    running: {
      missing: unready,
      'not Ready': unready,
      Ready: {
        none: ON_COPY,
        foreign: ON_ANNOTATED_COPY,
        copy: MOVED_READY,
        annotated: MOVED_READY,
        empty: MOVED_READY,
        moved: MOVED_READY,
      },
    },
    suspended: {
      missing: suspendedUnready,
      'not Ready': suspendedUnready,
      Ready: {
        none: HELD_EMPTY,
        foreign: HELD_EMPTY,
        copy: OFF_MOVED_READY,
        annotated: OFF_MOVED_READY,
        empty: OFF_MOVED_READY,
        moved: OFF_MOVED_READY,
      },
    },
  };

  const hosts = (replicas: number, secretName: string, digest?: string) =>
    ({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: `hostgroup-${n.hostgroup}`, namespace: n.runtimeNamespace, labels: owned },
      spec: {
        replicas,
        template: {
          ...(digest === undefined
            ? {}
            : { metadata: { annotations: { [SCHEDULER_TLS_ANNOTATION]: digest } } }),
          spec: { volumes: [{ name: 'scheduler', secret: { secretName } }] },
        },
      },
    }) as unknown as Resource;

  /**
   * The tenant with its host identity issued and its operator in `operator` state, before the
   * observed tick. `missing`: the API server endpoints are unknown, so the operator is never
   * applied (nor its identity issued).
   */
  const withOperator = async (operator: Operator) => {
    const { api, controller } = await prepare();
    registerHost(api);
    if (operator === 'not Ready') api.held.add('runtime-operator');
    if (operator === 'missing')
      api.objects.delete(
        `${collection('discovery.k8s.io/v1', 'EndpointSlice', 'default')}/kubernetes`,
      );
    await throughPropagation(controller);
    return { api, controller };
  };

  const seedHosts = (api: CutoverApi, identity: Identity) => {
    const digest = schedulerCertDigest(hostCert(api));
    if (identity === 'none' || identity === 'foreign') api.objects.delete(hostSecretPath);
    api.seed(
      {
        none: hosts(2, SCHEDULER_TLS_COPY),
        foreign: hosts(2, SCHEDULER_TLS_COPY, 'old'),
        copy: hosts(2, SCHEDULER_TLS_COPY),
        annotated: hosts(2, SCHEDULER_TLS_COPY, 'old'),
        empty: hosts(0, TENANT_HOST_SECRET, ''),
        moved: hosts(2, TENANT_HOST_SECRET, digest),
      }[identity],
    );
    return digest;
  };

  const observe = (api: CutoverApi, digest: string): Cell => {
    const template = hostTemplate(api);
    const annotation = template.metadata?.annotations?.[SCHEDULER_TLS_ANNOTATION];
    const secret = template.spec.volumes.find((v) => v.name === 'scheduler')?.secret?.secretName;
    return [
      (api.objects.get(hostsPath)?.spec as { replicas: number } | undefined)?.replicas ?? -1,
      secret === TENANT_HOST_SECRET ? 'host' : 'copy',
      annotation === undefined ? '-' : annotation === digest ? 'd' : (annotation as ''),
      readyCondition(api)?.status as 'True' | 'False',
    ];
  };
  const suspend = (api: CutoverApi, value: boolean) => {
    (stored(api).spec as { suspended?: boolean }).suspended = value;
  };

  for (const [state, operators] of Object.entries(expected))
    for (const [operator, identities] of Object.entries(operators))
      for (const [identity, cell] of Object.entries(identities))
        it(`${state}, operator ${operator}, identity ${identity}: ${cell.join(' ')}`, async () => {
          const { api, controller } = await withOperator(operator as Operator);
          const digest = seedHosts(api, identity as Identity);
          suspend(api, state === 'suspended');
          await controller.tick();
          expect(observe(api, digest)).toEqual(cell);
        });

  /** `replicas:digest` after each step and its tick, `d` for the issued digest. */
  const trace = async (
    identity: Identity,
    operator: Operator,
    steps: ((api: CutoverApi) => void)[],
  ) => {
    const { api, controller } = await withOperator(operator);
    seedHosts(api, identity);
    const seen: string[] = [];
    for (const step of steps) {
      step(api);
      await controller.tick();
      const [replicas, , digest] = observe(api, schedulerCertDigest(hostCert(api)));
      seen.push(`${replicas}:${digest}`);
    }
    return seen;
  };
  const stay = () => {};
  const wait = () => advance(TENANT_OPERATOR_PROPAGATION_MS);
  const suspendStep = (api: CutoverApi) => suspend(api, true);
  const unsuspendStep = (api: CutoverApi) => {
    suspend(api, false);
    wait();
  };
  const release = (api: CutoverApi) => api.held.delete('runtime-operator');

  it('suspend and unsuspend while the operator is not Ready: hosts on the copy are held, then roll once', async () => {
    const seen = await trace('copy', 'not Ready', [
      stay,
      suspendStep,
      wait,
      unsuspendStep,
      wait,
      release,
      stay,
    ]);
    expect(seen).toEqual(['2:-', '0:', '0:', '0:', '0:', '1:d', '1:d']);
  });

  it('suspend and unsuspend while the operator is not Ready: moved hosts keep their digest', async () => {
    const seen = await trace('moved', 'not Ready', [stay, suspendStep, wait, unsuspendStep, wait]);
    expect(seen).toEqual(['1:d', '0:d', '0:d', '1:d', '1:d']);
  });

  // W1 of the #613 round-6 review (m6e-E): a pod that starts reads the Secret, whatever the
  // template's annotation says. So the trace records, per tick, the replicas and the certificate
  // the Secret holds (`old`, `new`, or `none` while it waits), and the template's digest. The
  // invariant check after every tick asserts that what the Secret holds has propagated, or is the
  // previous user still admitted.
  const certOf = (api: CutoverApi, old: string) => {
    if (!api.objects.has(hostSecretPath)) return 'none';
    return schedulerCertDigest(hostCert(api)) === old ? 'old' : 'new';
  };
  /** `replicas:secret:template` after each tick, every 20 s from the change, unsuspended at the third. */
  const renewSuspended = async (renew: (api: CutoverApi) => void) => {
    const { api, controller } = await withOperator('Ready');
    const old = seedHosts(api, 'moved');
    await controller.tick();
    suspend(api, true);
    await controller.tick();
    renew(api);
    const seen: string[] = [];
    for (let i = 0; i < 9; i++) {
      if (i === 2) suspend(api, false);
      await controller.tick();
      const [replicas] = observe(api, old);
      const annotation = hostTemplate(api).metadata.annotations[SCHEDULER_TLS_ANNOTATION];
      seen.push(`${replicas}:${certOf(api, old)}:${annotation === old ? 'old' : 'new'}`);
      advance(20_000);
    }
    return seen;
  };
  // No previous user: the Secret is gone from the first tick until the new user has been named for
  // the wait (seen at the second tick, 20 s in; written at the end of the eighth, 140 s in). The
  // unsuspended Tenant's hosts stay at zero meanwhile (no issued identity: left as it is), then
  // start once, on the new certificate.
  const REVOKED_THEN_ISSUED = [
    '0:none:old',
    '0:none:old',
    '0:none:old',
    '0:none:old',
    '0:none:old',
    '0:none:old',
    '0:none:old',
    '0:new:old',
    '1:new:new',
  ];

  it('suspended, the host Secret deleted, then unsuspended: hosts start once, on the propagated certificate', async () => {
    expect(await renewSuspended((api) => api.objects.delete(hostSecretPath))).toEqual(
      REVOKED_THEN_ISSUED,
    );
  });

  it('suspended, a forced rotation, then unsuspended: the revoked certificate leaves the Secret at once', async () => {
    expect(
      await renewSuspended((api) => {
        stored(api).metadata.annotations = {
          ...stored(api).metadata.annotations,
          [ROTATE_ANNOTATION]: 'r1',
        };
      }),
    ).toEqual(REVOKED_THEN_ISSUED);
  });

  it('suspended across a routine renewal, then unsuspended: hosts start on the previous certificate, still admitted', async () => {
    expect(
      await renewSuspended((api) => {
        const notAfter = new X509Certificate(hostCert(api)).validTo;
        clock.now = new Date(
          new Date(notAfter).getTime() - SCHEDULER_LEAF_RENEW_DAYS * 86_400_000 + 1000,
        );
      }),
    ).toEqual([
      '0:old:old',
      '0:old:old',
      '1:old:old',
      '1:old:old',
      '1:old:old',
      '1:old:old',
      '1:old:old',
      '1:new:old',
      '1:new:new',
    ]);
  });
});

// #541 m6e-E: an identity Secret holds only a certificate whose user has propagated, or the
// previous user still admitted (checked after every tick by `prepare`). These are the sequences of
// the #613 round-5 (B1) and round-6 (R1-R6) probes; R1-R3 are the `renewSuspended` cases above.
describe('renewed Secrets only after their user propagated (#541 m6e-E)', () => {
  const spec = (api: MemoryApi) =>
    stored(api).spec as { suspended?: boolean; runtime?: { replicas?: number } };
  const secretOf = (api: MemoryApi, old: string) => {
    if (!api.objects.has(hostSecretPath)) return 'none';
    return schedulerCertDigest(hostCert(api)) === old ? 'old' : 'new';
  };
  /** `replicas:volume:secret:template` of the host Deployment, `old`/`new` against `old`. */
  const row = (api: MemoryApi, old: string) => {
    const replicas = ((api.objects.get(hostsPath) as Resource).spec as { replicas: number })
      .replicas;
    const template = hostTemplate(api);
    const volume = template.spec.volumes.find((v) => v.name === 'scheduler')?.secret?.secretName;
    const digest = template.metadata?.annotations?.[SCHEDULER_TLS_ANNOTATION];
    const named = digest === old ? 'old' : 'new';
    return [
      replicas,
      volume === TENANT_HOST_SECRET ? 'host' : 'copy',
      secretOf(api, old),
      digest === undefined ? '-' : named,
    ].join(':');
  };
  /** Cut over and moved: the operator Ready, the hosts on the issued certificate. */
  const moved = async () => {
    const { api, controller } = await prepare();
    await throughPropagation(controller);
    return { api, controller, old: schedulerCertDigest(hostCert(api)) };
  };
  const rotate = (api: MemoryApi, value: string) => {
    stored(api).metadata.annotations = { [ROTATE_ANNOTATION]: value };
  };
  /** Ticks `count` times, 20 s apart, after `before(i)`; the rows after each. */
  const run = async (
    api: MemoryApi,
    controller: { tick(): Promise<void> },
    old: string,
    count: number,
    before: (i: number) => void = () => {},
  ) => {
    const seen: string[] = [];
    for (let i = 0; i < count; i++) {
      advance(20_000);
      before(i);
      await controller.tick();
      seen.push(row(api, old));
    }
    return seen;
  };

  it('B1: a host Secret re-issued before the first move is written only after its user propagated', async () => {
    const { api, controller } = await prepare();
    api.seed({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: `hostgroup-${n.hostgroup}`, namespace: n.runtimeNamespace, labels: owned },
      spec: {
        replicas: 2,
        template: {
          spec: { volumes: [{ name: 'scheduler', secret: { secretName: SCHEDULER_TLS_COPY } }] },
        },
      },
    } as unknown as Resource);
    api.refuseHosts = true;
    await throughPropagation(controller);
    const old = schedulerCertDigest(hostCert(api));
    // Not moved, the operator Ready: the Secret is re-issued, then the host apply recovers.
    api.objects.delete(hostSecretPath);
    await controller.tick();
    api.refuseHosts = false;
    // Left on the copy while no Secret exists; the first move takes the propagated certificate.
    expect(await run(api, controller, old, 8)).toEqual([
      '2:copy:none:-',
      '2:copy:none:-',
      '2:copy:none:-',
      '2:copy:none:-',
      '2:copy:none:-',
      '2:copy:none:-',
      '2:copy:new:-',
      '1:host:new:new',
    ]);
  });

  it('R4: running, a forced rotation, replicas raised inside the wait: no pod reads a revoked or unloaded certificate', async () => {
    const { api, controller, old } = await moved();
    rotate(api, 'r1');
    const seen = await run(api, controller, old, 9, (i) => {
      if (i === 2) spec(api).runtime = { replicas: 2 };
    });
    // The revoked certificate leaves the Secret at the first tick, and the Deployment is left as it
    // is meanwhile (no issued identity), so the second replica comes with the new certificate.
    expect(seen).toEqual([
      '1:host:none:old',
      '1:host:none:old',
      '1:host:none:old',
      '1:host:none:old',
      '1:host:none:old',
      '1:host:none:old',
      '1:host:none:old',
      '1:host:new:old',
      '2:host:new:new',
    ]);
  });

  it('R5: suspended, the Secret deleted and unsuspended in one tick, then a controller restart', async () => {
    const { api, controller, old } = await moved();
    spec(api).suspended = true;
    await controller.tick();
    api.objects.delete(hostSecretPath);
    spec(api).suspended = false;
    await controller.tick();
    advance(60_000);
    // A new process does not know the recorded ID waits: it draws another and waits again.
    const restarted = new Controller(
      api,
      cfg,
      async () => [],
      () => clock.now,
    );
    checked(api, restarted);
    expect(await run(api, restarted, old, 9)).toEqual([
      '0:host:none:old',
      '0:host:none:old',
      '0:host:none:old',
      '0:host:none:old',
      '0:host:none:old',
      '0:host:none:old',
      '0:host:none:old',
      '0:host:new:old',
      '1:host:new:new',
    ]);
  });

  it('R6: the operator not Ready, suspended, a forced rotation, then unsuspended', async () => {
    const { api, controller, old } = await moved();
    api.held.add('runtime-operator');
    spec(api).suspended = true;
    await controller.tick();
    rotate(api, 'r1');
    await controller.tick();
    const seen = await run(api, controller, old, 9, (i) => {
      if (i === 0) spec(api).suspended = false;
    });
    // A moved template is applied whatever the operator does; the hosts wait only for the Secret.
    expect(seen).toEqual([
      '0:host:none:old',
      '0:host:none:old',
      '0:host:none:old',
      '0:host:none:old',
      '0:host:none:old',
      '0:host:none:old',
      '0:host:new:old',
      '1:host:new:new',
      '1:host:new:new',
    ]);
  });

  it('keeps the operator Secret on its previous certificate through a renewal, then writes the new one', async () => {
    const { api, controller } = await moved();
    const operatorCert = () =>
      ((api.objects.get(operatorSecretPath) as Resource).data as Record<string, string>)['tls.crt'];
    const first = operatorCert();
    const notAfter = new X509Certificate(hostCert(api)).validTo;
    clock.now = new Date(Date.parse(notAfter) - SCHEDULER_LEAF_RENEW_DAYS * 86_400_000 + 1000);
    await controller.tick();
    await controller.tick();
    advance(TENANT_OPERATOR_PROPAGATION_MS - 1);
    await controller.tick();
    expect(operatorCert()).toBe(first);
    advance(1);
    await controller.tick();
    expect(operatorCert()).not.toBe(first);
  });
});
