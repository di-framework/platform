import { describe, expect, it } from 'bun:test';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import { controllerClusterRoleRules } from '../src/tenancy/install';
import {
  bindsTenantOperatorRole,
  isTenantOperatorBinding,
  REMOVAL_STEP_ANNOTATION,
  REMOVAL_STEP_DEADLINE_MS,
  REMOVAL_STEPS,
  REMOVAL_STUCK,
  remainingSummary,
  removalProgress,
  removalStuckCondition,
  sweepsDeployment,
} from '../src/tenancy/removal-sequence';
import {
  COMPONENT,
  type ControllerConfig,
  FINALIZER,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  TENANT,
  type Tenant,
  VERSION,
} from '../src/tenancy/resources';
import {
  operatorNamespace,
  TENANT_OPERATOR_CLUSTER_ROLES,
  TENANT_OPERATOR_COMPONENT,
  tenantOperatorResources,
} from '../src/tenancy/tenant-operator';

// #541 m5: the removal sequence R1-R7, the R2 sweep exclusion, S1 and S2 (design-541 §4.5, §8.1).

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
};
const operatorCfg = {
  installation: 'test',
  namespace: 'wasmcloud',
  apiServer: { addresses: ['10.0.0.1'], port: 6443 },
};
const WASMCLOUD = 'runtime.wasmcloud.dev/v1alpha1';
const START = new Date('2026-10-29T00:00:00Z');

function tenant(name = 'alpha'): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: { name, uid: `${name}-uid`, generation: 1, labels: { [INSTALLATION]: 'test' } },
    spec: {},
  };
}
const key = (v: Resource | Tenant) =>
  `${collection(v.apiVersion, v.kind, v.metadata.namespace)}/${v.metadata.name}`;

/**
 * An in-memory API server. Like the real one, a DELETE of an object that still carries finalizers
 * only marks it for deletion; a namespace delete is immediate here.
 */
class FakeApi implements Api {
  objects = new Map<string, Resource>();
  operations: { method: string; path: string; body?: unknown }[] = [];
  seed(value: Resource | Tenant): void {
    this.objects.set(key(value), structuredClone(value) as Resource);
  }
  has(value: Resource): boolean {
    return this.objects.has(key(value));
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.operations.push({ method, path, body });
    const url = new URL(path, 'https://kubernetes');
    const data = structuredClone(body) as Resource;
    if (method === 'GET' && url.searchParams.has('labelSelector')) {
      const selector = url.searchParams.get('labelSelector')!;
      const labels = selector ? selector.split(',').map((v) => v.split('=')) : [];
      return {
        items: [...this.objects.values()]
          .filter(
            (v) =>
              (collection(v.apiVersion, v.kind) === url.pathname ||
                collection(v.apiVersion, v.kind, v.metadata.namespace) === url.pathname) &&
              labels.every(([k, x]) => v.metadata.labels?.[k!] === x),
          )
          .map(({ apiVersion: _version, kind: _kind, ...item }) => structuredClone(item)),
      } as T;
    }
    const target = url.pathname.replace(/\/status$/, '');
    const existing = this.objects.get(target);
    if (method === 'GET') {
      if (!existing) throw new ApiError(404, 'Not found');
      return structuredClone(existing) as T;
    }
    if (method === 'DELETE') {
      if (!existing) throw new ApiError(404, 'Not found');
      if (existing.kind !== 'Namespace' && existing.metadata.finalizers?.length)
        existing.metadata.deletionTimestamp ??= START.toISOString();
      else this.objects.delete(target);
      return {} as T;
    }
    if (method === 'PATCH') {
      const value = {
        ...existing,
        ...data,
        metadata: {
          ...existing?.metadata,
          ...data.metadata,
          annotations: { ...existing?.metadata.annotations, ...data.metadata?.annotations },
        },
      } as Resource;
      value.metadata.uid ??= `${value.metadata.name}-created-uid`;
      value.metadata.generation ??= 1;
      if (value.kind === 'Deployment')
        value.status = {
          observedGeneration: value.metadata.generation,
          replicas: (value.spec as { replicas: number }).replicas,
        };
      this.objects.set(target, value);
      return structuredClone(value) as T;
    }
    throw new Error(`Unexpected ${method}`);
  }
}

function hostPod(name: string, t = 'alpha'): Resource {
  const n = names(t);
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: n.runtimeNamespace,
      deletionTimestamp: START.toISOString(),
      finalizers: ['runtime.wasmcloud.dev/pod-host-finalizer'],
      labels: { 'wasmcloud.com/hostgroup': n.hostgroup, 'wasmcloud.com/name': 'hostgroup' },
    },
  };
}
function wasmcloud(kind: string, name: string, finalizers?: string[]): Resource {
  return {
    apiVersion: WASMCLOUD,
    kind,
    metadata: { name, namespace: names('alpha').namespace, ...(finalizers ? { finalizers } : {}) },
  };
}

/**
 * A reconciled Tenant `alpha` plus its rendered operator objects (the controller does not apply
 * them before m6, so the test seeds them as the cut-over will), and another tenant's RoleBinding.
 */
async function prepare(policy: 'Retain' | 'Delete' = 'Retain') {
  const api = new FakeApi();
  const clock = { now: new Date(START) };
  const controller = new Controller(
    api,
    cfg,
    async () => [],
    () => new Date(clock.now),
  );
  const t = tenant();
  t.spec.deletionPolicy = policy;
  api.seed(t);
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'wasmcloud-runtime-tls', namespace: cfg.namespace },
    data: { 'ca.crt': 'test' },
  });
  await controller.reconcileTenant(t);
  const operator = tenantOperatorResources(t, operatorCfg);
  for (const value of operator) api.seed(value);
  const operatorBindings = operator.filter((r) => r.kind === 'RoleBinding');
  const operatorDeployment = operator.find((r) => r.kind === 'Deployment')!;
  const operatorNs = operator.find((r) => r.kind === 'Namespace')!;
  const deleting = () => {
    t.metadata.deletionTimestamp = START.toISOString();
    api.seed(t);
  };
  const reconcile = () => controller.reconcileTenant(t);
  /** Reconciles until the Tenant's finalizer is gone (R7), at most six passes. */
  const drain = async () => {
    for (let i = 0; i < 6 && t.metadata.finalizers?.includes(FINALIZER); i++) await reconcile();
  };
  const deletes = (match: (path: string) => boolean) =>
    api.operations.filter((o) => o.method === 'DELETE' && match(o.path));
  return {
    api,
    clock,
    controller,
    t,
    operatorBindings,
    operatorDeployment,
    operatorNs,
    deleting,
    reconcile,
    drain,
    deletes,
  };
}
const condition = (t: Tenant, type: string) => t.status?.conditions?.find((c) => c.type === type);
const tenantNamespaces = (t = 'alpha') => {
  const n = names(t);
  return [n.namespace, n.runtimeNamespace, n.apiKeysNamespace].map(
    (name) => `${collection('v1', 'Namespace')}/${name}`,
  );
};

describe('removal sequence helpers (#541 m5)', () => {
  it('names the seven steps in order with a 15-minute deadline', () => {
    expect([...REMOVAL_STEPS]).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
    expect(REMOVAL_STEP_DEADLINE_MS).toBe(15 * 60 * 1000);
    expect(REMOVAL_STEP_ANNOTATION).toBe('platform.di-framework.dev/removal-step');
  });
  it('starts a step clock on a new step and keeps it on the same step', () => {
    const fresh = removalProgress(undefined, 'R2', START);
    expect(fresh).toEqual({ annotation: `R2@${START.toISOString()}`, since: START, stuck: false });
    const later = new Date(START.getTime() + REMOVAL_STEP_DEADLINE_MS - 1);
    expect(removalProgress(fresh.annotation, 'R2', later).stuck).toBe(false);
    const due = new Date(START.getTime() + REMOVAL_STEP_DEADLINE_MS);
    expect(removalProgress(fresh.annotation, 'R2', due)).toMatchObject({
      since: START,
      stuck: true,
    });
    // A different step, or an unreadable record, restarts the clock.
    expect(removalProgress(fresh.annotation, 'R3', due)).toMatchObject({
      since: due,
      stuck: false,
    });
    expect(removalProgress('R2@garbage', 'R2', due)).toMatchObject({ since: due, stuck: false });
    expect(removalProgress('R2', 'R2', due)).toMatchObject({ since: due, stuck: false });
  });
  it('builds RemovalStuck with the step as reason and the remaining objects in the message', () => {
    const remaining = ['workload/b', 'workload/a', 'c', 'd', 'e', 'f', 'g'];
    expect(remainingSummary(remaining)).toBe('c, d, e, f, g, and 2 more');
    expect(removalStuckCondition('R3', ['workload/a'], START, 4)).toEqual({
      type: REMOVAL_STUCK,
      status: 'True',
      reason: 'R3',
      message: `Removal step R3 has not completed since ${START.toISOString()}; remaining: workload/a`,
      observedGeneration: 4,
      lastTransitionTime: new Date(START.getTime() + REMOVAL_STEP_DEADLINE_MS).toISOString(),
    });
  });
  it('S1: keeps a binding only when its roleRef AND its subject are the tenant operator', () => {
    const t = tenant();
    const [binding] = tenantOperatorResources(t, operatorCfg).filter(
      (r) => r.kind === 'RoleBinding',
    );
    expect(isTenantOperatorBinding(binding!, 'alpha')).toBe(true);
    // The other tenant's operator is not this tenant's.
    expect(isTenantOperatorBinding(binding!, 'beta')).toBe(false);
    // roleRef alone: another subject, or an extra subject, is revoked.
    const otherSubject = {
      ...binding!,
      subjects: [{ kind: 'ServiceAccount', name: 'di-user-alice', namespace: 'wasmcloud' }],
    };
    expect(bindsTenantOperatorRole(otherSubject)).toBe(true);
    expect(isTenantOperatorBinding(otherSubject, 'alpha')).toBe(false);
    const extra = {
      ...binding!,
      subjects: [...(binding!.subjects as unknown[]), { kind: 'User', name: 'mallory' }],
    };
    expect(isTenantOperatorBinding(extra, 'alpha')).toBe(false);
    expect(isTenantOperatorBinding({ ...binding!, subjects: [] }, 'alpha')).toBe(false);
    expect(isTenantOperatorBinding({ ...binding!, subjects: undefined }, 'alpha')).toBe(false);
    // Subject alone: any other roleRef is revoked.
    for (const roleRef of [
      { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
      {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: TENANT_OPERATOR_CLUSTER_ROLES.self,
      },
      { apiGroup: 'example.com', kind: 'ClusterRole', name: TENANT_OPERATOR_CLUSTER_ROLES.self },
      undefined,
    ]) {
      const value = { ...binding!, roleRef };
      expect(bindsTenantOperatorRole(value)).toBe(false);
      expect(isTenantOperatorBinding(value, 'alpha')).toBe(false);
    }
    expect(
      bindsTenantOperatorRole({
        ...binding!,
        roleRef: { ...(binding!.roleRef as object), name: undefined },
      }),
    ).toBe(false);
    // A ClusterRoleBinding is never kept.
    expect(isTenantOperatorBinding({ ...binding!, kind: 'ClusterRoleBinding' }, 'alpha')).toBe(
      false,
    );
  });
  it('the R2 sweep skips the tenant operator by namespace and by component label', () => {
    const d = (namespace: string, labels: Record<string, string> = {}): Resource => ({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'x', namespace, labels },
    });
    expect(sweepsDeployment(d('di-runtime-alpha'), 'alpha')).toBe(true);
    expect(sweepsDeployment(d(operatorNamespace('alpha')), 'alpha')).toBe(false);
    expect(
      sweepsDeployment(d('di-runtime-alpha', { [COMPONENT]: TENANT_OPERATOR_COMPONENT }), 'alpha'),
    ).toBe(false);
    // Another tenant's operator namespace is not this tenant's.
    expect(sweepsDeployment(d(operatorNamespace('beta')), 'alpha')).toBe(true);
    expect(sweepsDeployment({ ...d('x'), metadata: { name: 'x' } }, 'alpha')).toBe(true);
  });
  it('the operator Deployment carries the component label', () => {
    const deployment = tenantOperatorResources(tenant(), operatorCfg).find(
      (r) => r.kind === 'Deployment',
    )!;
    expect(deployment.metadata.labels?.[COMPONENT]).toBe(TENANT_OPERATOR_COMPONENT);
  });
});

describe('S2: the tenant operator is rendered whatever the suspension state (#541 m5)', () => {
  it('renders the same Deployment at one replica and the same bindings when suspended', () => {
    const active = tenantOperatorResources(tenant(), operatorCfg);
    const t = tenant();
    t.spec.suspended = true;
    const suspended = tenantOperatorResources(t, operatorCfg);
    expect(suspended).toEqual(active);
    const deployment = suspended.find((r) => r.kind === 'Deployment')!;
    expect((deployment.spec as { replicas: number }).replicas).toBe(1);
    expect(suspended.filter((r) => r.kind === 'RoleBinding').map((r) => r.metadata.name)).toEqual(
      Object.values(TENANT_OPERATOR_CLUSTER_ROLES),
    );
  });
  it('suspending a Tenant revokes its other bindings, never the operator ones, and leaves the operator replicas', async () => {
    const { api, t, operatorBindings, operatorDeployment, reconcile, deletes } = await prepare();
    const other = {
      ...operatorBindings[0]!,
      metadata: { ...operatorBindings[0]!.metadata, name: 'impostor' },
      subjects: [{ kind: 'ServiceAccount', name: 'default', namespace: 'di-tenant-alpha' }],
    };
    api.seed(other);
    // The operator's ServiceAccount bound to some other role is revoked too (S1, subject alone).
    const subjectOnly = {
      ...operatorBindings[1]!,
      metadata: { ...operatorBindings[1]!.metadata, name: 'operator-elsewhere' },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'edit' },
    };
    api.seed(subjectOnly);
    const viewerBindings = [...api.objects.values()].filter(
      (r) => r.kind === 'RoleBinding' && !operatorBindings.some((b) => key(b) === key(r)),
    );
    expect(viewerBindings.map((b) => b.metadata.name).sort()).toEqual([
      'impostor',
      'operator-elsewhere',
    ]);
    t.spec.suspended = true;
    api.seed(t);
    api.operations = [];
    await reconcile();
    for (const binding of operatorBindings) {
      expect(api.has(binding)).toBe(true);
      expect(deletes((p) => p === key(binding))).toEqual([]);
    }
    for (const binding of viewerBindings) expect(api.has(binding)).toBe(false);
    expect(
      api.operations.filter(
        (o) => o.path.startsWith(key(operatorDeployment)) && o.method !== 'GET',
      ),
    ).toEqual([]);
    expect((api.objects.get(key(operatorDeployment))!.spec as { replicas: number }).replicas).toBe(
      1,
    );
  });
});

describe('Tenant removal R1-R7 (#541 m5)', () => {
  for (const policy of ['Retain', 'Delete'] as const) {
    it(`${policy}: R2 never patches the tenant operator Deployment, by namespace or by label`, async () => {
      const { api, operatorDeployment, deleting, reconcile } = await prepare(policy);
      // A Deployment the tenant owns outside di-operator-<t> but labelled as the operator.
      const labelled = structuredClone(operatorDeployment);
      labelled.metadata.namespace = names('alpha').runtimeNamespace;
      labelled.metadata.name = 'labelled-operator';
      api.seed(labelled);
      api.seed(hostPod('host-1'));
      deleting();
      api.operations = [];
      await reconcile();
      const patched = api.operations
        .filter((o) => o.method === 'PATCH' && o.path.includes('/deployments/'))
        .map((o) => o.path);
      expect(patched.length).toBeGreaterThan(0);
      expect(patched.some((p) => p.startsWith(key(operatorDeployment)))).toBe(false);
      expect(patched.some((p) => p.startsWith(key(labelled)))).toBe(false);
      expect(
        (api.objects.get(key(operatorDeployment))!.spec as { replicas: number }).replicas,
      ).toBe(1);
      // Every other Deployment of the tenant is at zero.
      for (const d of [...api.objects.values()].filter(
        (r) =>
          r.kind === 'Deployment' &&
          r.metadata.labels?.[OWNER] === 'alpha-uid' &&
          r.metadata.labels?.[COMPONENT] !== TENANT_OPERATOR_COMPONENT,
      ))
        expect((d.spec as { replicas: number }).replicas).toBe(0);
    });

    it(`${policy}: revoke keeps the operator bindings and no namespace is deleted before R5 completes`, async () => {
      const { api, t, operatorBindings, operatorNs, deleting, reconcile, drain, deletes } =
        await prepare(policy);
      api.seed(hostPod('host-1'));
      api.seed({
        apiVersion: WASMCLOUD,
        kind: 'Host',
        metadata: { name: 'host-1', namespace: operatorNamespace('alpha') },
      });
      deleting();
      api.operations = [];
      await reconcile();
      // Blocked at R2: the operator keeps every binding; nothing namespaced is deleted.
      for (const binding of operatorBindings) expect(api.has(binding)).toBe(true);
      expect(deletes((p) => p.includes('/rolebindings/di-tenant-operator-'))).toEqual([]);
      expect(deletes((p) => p.startsWith('/api/v1/namespaces/') && !p.includes('/', 19))).toEqual(
        [],
      );
      expect(condition(t, 'Ready')).toMatchObject({
        reason: 'Removing',
        message: `${policy}: removal step R2 waits for host/host-1, pod/host-1`,
      });
      api.objects.delete(key(hostPod('host-1')));
      await reconcile();
      // Still R2, now on the Host the operator has not removed yet.
      expect(condition(t, 'Ready')).toMatchObject({
        reason: 'Removing',
        message: `${policy}: removal step R2 waits for host/host-1`,
      });
      expect(deletes((p) => p.includes('/rolebindings/di-tenant-operator-'))).toEqual([]);
      api.objects.delete(
        `/apis/runtime.wasmcloud.dev/v1alpha1/namespaces/di-operator-alpha/hosts/host-1`,
      );
      // Through R5 and R6 to R7.
      await drain();
      expect(t.metadata.finalizers ?? []).not.toContain(FINALIZER);
      for (const binding of operatorBindings) expect(api.has(binding)).toBe(false);
      expect(api.has(operatorNs)).toBe(false);
      const order = api.operations.map((o) => `${o.method} ${o.path}`);
      const lastBinding = Math.max(
        ...operatorBindings.map((b) => order.indexOf(`DELETE ${key(b)}`)),
      );
      const operatorNsDelete = order.indexOf(`DELETE ${key(operatorNs)}`);
      expect(lastBinding).toBeGreaterThan(-1);
      expect(operatorNsDelete).toBeGreaterThan(lastBinding);
      const tenantNsDeletes = tenantNamespaces().map((p) => order.indexOf(`DELETE ${p}`));
      if (policy === 'Delete') {
        for (const index of tenantNsDeletes) expect(index).toBeGreaterThan(operatorNsDelete);
        for (const p of tenantNamespaces()) expect(api.objects.has(p)).toBe(false);
      } else {
        // R6 under Retain keeps them.
        expect(tenantNsDeletes).toEqual([-1, -1, -1]);
        for (const p of tenantNamespaces()) expect(api.objects.has(p)).toBe(true);
      }
    });

    it(`${policy}: R2 sets RemovalStuck at its deadline and continues once the cause is cleared`, async () => {
      const { api, clock, t, deleting, reconcile, drain } = await prepare(policy);
      api.seed(hostPod('host-1'));
      deleting();
      await reconcile();
      expect(t.metadata.annotations?.[REMOVAL_STEP_ANNOTATION]).toBe(`R2@${START.toISOString()}`);
      expect(condition(t, REMOVAL_STUCK)).toBeUndefined();
      clock.now = new Date(START.getTime() + REMOVAL_STEP_DEADLINE_MS - 1000);
      await reconcile();
      expect(condition(t, REMOVAL_STUCK)).toBeUndefined();
      clock.now = new Date(START.getTime() + REMOVAL_STEP_DEADLINE_MS);
      await reconcile();
      expect(condition(t, REMOVAL_STUCK)).toMatchObject({
        status: 'True',
        reason: 'R2',
        message: expect.stringContaining('remaining: pod/host-1'),
      });
      // Retried, never forced: the finalizer stays.
      expect(t.metadata.finalizers).toContain(FINALIZER);
      api.objects.delete(key(hostPod('host-1')));
      await drain();
      expect(t.metadata.finalizers ?? []).not.toContain(FINALIZER);
    });
  }

  it('R2 waits for Deployments that have not reported zero replicas', async () => {
    const { api, t, deleting, reconcile } = await prepare();
    const original = api.call.bind(api);
    api.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const result = await original<Resource>(method, path, body);
      if (method === 'PATCH' && path.includes('/deployments/'))
        result.status = { observedGeneration: 0 };
      return result as T;
    };
    deleting();
    await reconcile();
    expect(condition(t, 'Ready')).toMatchObject({
      reason: 'Removing',
      message: expect.stringMatching(/^Retain: removal step R2 waits for deployment\//),
    });
    expect(t.metadata.finalizers).toContain(FINALIZER);
  });

  it('Delete R3: deletes WorkloadDeployments and waits for finalizers and Artifacts, then RemovalStuck names them', async () => {
    const { api, clock, t, deleting, reconcile, drain, deletes } = await prepare('Delete');
    const wd = wasmcloud('WorkloadDeployment', 'app');
    const held = wasmcloud('Workload', 'app-x', ['example.com/foreign']);
    const free = wasmcloud('Workload', 'app-y');
    const rs = wasmcloud('WorkloadReplicaSet', 'app-rs', ['runtime.wasmcloud.dev/finalizer']);
    const artifact = wasmcloud('Artifact', 'blob');
    for (const v of [wd, held, free, rs, artifact]) api.seed(v);
    deleting();
    await reconcile();
    expect(api.has(wd)).toBe(false);
    expect(deletes((p) => p === key(held) || p === key(artifact))).toEqual([]);
    expect(condition(t, 'Ready')).toMatchObject({
      reason: 'Removing',
      message:
        'Delete: removal step R3 waits for artifact/blob, workload/app-x, workloadreplicaset/app-rs',
    });
    // No namespace delete before R5.
    expect(deletes((p) => tenantNamespaces().includes(p))).toEqual([]);
    expect(t.metadata.annotations?.[REMOVAL_STEP_ANNOTATION]).toBe(`R3@${START.toISOString()}`);
    clock.now = new Date(START.getTime() + REMOVAL_STEP_DEADLINE_MS);
    await reconcile();
    expect(condition(t, REMOVAL_STUCK)).toMatchObject({ reason: 'R3' });
    expect(condition(t, REMOVAL_STUCK)?.message).toContain('workload/app-x');
    // A WorkloadDeployment already being deleted is not deleted again.
    const terminating = wasmcloud('WorkloadDeployment', 'old', ['runtime.wasmcloud.dev/finalizer']);
    terminating.metadata.deletionTimestamp = START.toISOString();
    api.seed(terminating);
    api.operations = [];
    await reconcile();
    expect(deletes((p) => p === key(terminating))).toEqual([]);
    api.objects.delete(key(terminating));
    // Clearing the foreign finalizer, the operator's, and the Artifact lets removal continue.
    for (const v of [held, rs, artifact]) api.objects.delete(key(v));
    await reconcile();
    expect(condition(t, REMOVAL_STUCK)).toBeUndefined();
    await drain();
    expect(t.metadata.finalizers ?? []).not.toContain(FINALIZER);
  });

  it("Retain R3: m5 keeps today's path and leaves workload objects alone", async () => {
    const { api, t, deleting, drain, deletes } = await prepare('Retain');
    const wd = wasmcloud('WorkloadDeployment', 'app', ['runtime.wasmcloud.dev/finalizer']);
    const held = wasmcloud('Workload', 'app-x', ['runtime.wasmcloud.dev/finalizer']);
    for (const v of [wd, held]) api.seed(v);
    deleting();
    await drain();
    expect(t.metadata.finalizers ?? []).not.toContain(FINALIZER);
    expect(api.has(wd) && api.has(held)).toBe(true);
    expect(deletes((p) => p.includes('/runtime.wasmcloud.dev/'))).toEqual([]);
  });

  it('R5 refuses a foreign di-operator namespace and never deletes the tenant namespaces', async () => {
    const { api, t, operatorNs, deleting, reconcile, deletes } = await prepare('Delete');
    api.seed({ ...operatorNs, metadata: { ...operatorNs.metadata, labels: {} } });
    deleting();
    await expect(reconcile()).rejects.toThrow(
      'Refusing to delete foreign namespace di-operator-alpha',
    );
    expect(deletes((p) => tenantNamespaces().includes(p))).toEqual([]);
    expect(t.metadata.finalizers).toContain(FINALIZER);
  });

  it('R5 reports the bindings and namespace it is removing while they remain', async () => {
    const { api, t, operatorBindings, deleting, reconcile } = await prepare('Retain');
    // The API server keeps the bindings for one pass (for example, a slow delete).
    for (const binding of operatorBindings)
      api.objects.get(key(binding))!.metadata.finalizers = ['example.com/hold'];
    deleting();
    await reconcile();
    expect(condition(t, 'Ready')?.message).toStartWith(
      'Retain: removal step R5 waits for rolebinding/di-operator-alpha/di-tenant-operator-self',
    );
    for (const binding of operatorBindings) api.objects.delete(key(binding));
    // The namespace delete is immediate here, so the next pass reaches R7.
    await reconcile();
    expect(t.metadata.annotations?.[REMOVAL_STEP_ANNOTATION]).toStartWith('R5@');
    await reconcile();
    expect(t.metadata.finalizers ?? []).not.toContain(FINALIZER);
  });

  it('R6 under Delete reports the namespaces it waits for; another tenant is untouched', async () => {
    const { api, t, deleting, reconcile } = await prepare('Delete');
    const other = tenantNamespaces('beta')[0]!;
    api.seed({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'di-tenant-beta',
        labels: { [OWNER]: 'beta-uid', [INSTALLATION]: 'test', [TENANT]: 'beta' },
      },
    });
    deleting();
    // The first pass ends at R5 on di-operator-alpha, the second at R6.
    await reconcile();
    await reconcile();
    expect(condition(t, 'Ready')?.message).toBe(
      'Delete: removal step R6 waits for namespace/di-apikeys-alpha, namespace/di-runtime-alpha, namespace/di-tenant-alpha',
    );
    expect(api.objects.has(other)).toBe(true);
    await reconcile();
    expect(t.metadata.finalizers ?? []).not.toContain(FINALIZER);
  });
});

describe('controller RBAC for removal (#541 m5)', () => {
  it('holds patch on workloads and artifacts, not on workloadreplicasets', () => {
    const rules = controllerClusterRoleRules().filter(
      (r) => r.apiGroups.includes('runtime.wasmcloud.dev') && r.verbs.includes('patch'),
    );
    const patched = new Set(rules.flatMap((r) => r.resources));
    expect(patched.has('workloads')).toBe(true);
    expect(patched.has('artifacts')).toBe(true);
    expect(patched.has('workloadreplicasets')).toBe(false);
    // The rule names no other verb than patch.
    expect(rules.find((r) => r.resources.includes('artifacts'))?.verbs).toEqual(['patch']);
  });
});
