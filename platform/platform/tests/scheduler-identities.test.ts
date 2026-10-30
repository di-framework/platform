import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import {
  COMPONENT,
  INSTALLATION,
  names,
  OWNER,
  TENANT,
  type Tenant,
  VERSION,
} from '../src/tenancy/resources';
import {
  type IdentityApi,
  SCHEDULER_IDENTITY_COMPONENT,
  SCHEDULER_IDENTITY_PENDING,
  TENANT_HOST_SECRET,
  TENANT_OPERATOR_SECRET,
  TenantSchedulerIdentities,
} from '../src/tenancy/scheduler-identities';
import {
  bootstrapSchedulerPki,
  CA_KEYS,
  IDENTITIES_KEY,
  type IdentityRecord,
  parseIdentityRecord,
  SCHEDULER_CA_SECRET,
  SCHEDULER_IDENTITIES,
  SCHEDULER_LEAF_DAYS,
  serializeIdentityRecord,
  tenantHostUser,
  tenantOperatorUser,
} from '../src/tenancy/scheduler-pki';
import {
  RENEWAL_OVERLAP_MS,
  RENEWAL_STALLED,
  ROTATE_ANNOTATION,
  SCHEDULER_TLS_ANNOTATION,
  schedulerCertDigest,
} from '../src/tenancy/scheduler-pki-rotation';
import { certificateNames, issuedBy, leafCertificate } from '../src/tenancy/tls';

// #541 m6c: the controller issues each tenant's scheduler NATS identities (design-541 §4.5).

const NS = 'wasmcloud';
const PKI = `${NS}-scheduler-pki`;
const INSTALL = 'di-test';
const DAY = 86_400_000;
const T0 = new Date('2026-10-30T00:00:00.000Z');
const RUNTIME = names('alpha').runtimeNamespace;
const OPERATOR_NS = 'di-operator-alpha';

const caPath = `/api/v1/namespaces/${PKI}/secrets/${SCHEDULER_CA_SECRET}`;
const recordPath = `/api/v1/namespaces/${PKI}/configmaps/${SCHEDULER_IDENTITIES}`;
const hostPath = `/api/v1/namespaces/${RUNTIME}/secrets/${TENANT_HOST_SECRET}`;
const operatorPath = `/api/v1/namespaces/${OPERATOR_NS}/secrets/${TENANT_OPERATOR_SECRET}`;
const tenantPath = `/apis/${VERSION}/tenants/alpha`;
const nsPath = (name: string) => `/api/v1/namespaces/${name}`;
const deploymentPath = `/apis/apps/v1/namespaces/${RUNTIME}/deployments/hostgroup-tenant-alpha`;

interface Stored {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  type?: string;
  data?: Record<string, string>;
  status?: Record<string, unknown>;
  [field: string]: unknown;
}

/**
 * An in-memory API server for the paths issuance uses. PUT and status PATCH honour
 * `resourceVersion`; a Secret LIST can be made stale, as a watch cache can be.
 */
class FakeApi implements IdentityApi {
  readonly objects = new Map<string, Stored>();
  readonly calls: { method: string; path: string }[] = [];
  private version = 1;
  /** The Secret LIST answers from this snapshot instead of the store (a stale cache). */
  staleSecrets?: Stored[];
  /** The status PATCH keeps nothing of `schedulerIdentity`, as a CRD without the field prunes it. */
  pruneSchedulerIdentity = false;
  /** Fails every call with this method and path. */
  failing?: { method: string; path: string; code: number };
  seed(path: string, value: Stored): void {
    this.objects.set(path, {
      ...structuredClone(value),
      metadata: { ...value.metadata, resourceVersion: String(this.version++) },
    });
  }
  writes(): string[] {
    return this.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path });
    const error = (code: number) =>
      Object.assign(new Error(`${method} ${path.split('?')[0]} returned ${code}`), { code });
    if (this.failing?.method === method && this.failing.path === path)
      throw error(this.failing.code);
    const url = new URL(path, 'https://kubernetes');
    if (method === 'GET' && url.pathname === '/api/v1/secrets') {
      const selector = (url.searchParams.get('labelSelector') ?? '')
        .split(',')
        .map((s) => s.split('='));
      const all =
        this.staleSecrets ??
        [...this.objects.entries()]
          .filter(([key]) => /\/secrets\/[^/]+$/.test(key))
          .map(([, v]) => v);
      return {
        items: structuredClone(
          all.filter((v) => selector.every(([k, x]) => v.metadata.labels?.[k as string] === x)),
        ),
      } as T;
    }
    const value = structuredClone(body) as Stored;
    if (method === 'GET') {
      const found = this.objects.get(path);
      if (!found) throw error(404);
      return structuredClone(found) as T;
    }
    if (method === 'POST') {
      const key = `${path}/${value.metadata.name}`;
      if (this.objects.has(key)) throw error(409);
      value.metadata.resourceVersion = String(this.version++);
      this.objects.set(key, value);
      return structuredClone(value) as T;
    }
    if (method === 'PUT') {
      const found = this.objects.get(path);
      if (!found) throw error(404);
      if (value.metadata.resourceVersion !== found.metadata.resourceVersion) throw error(409);
      value.metadata.resourceVersion = String(this.version++);
      this.objects.set(path, value);
      return structuredClone(value) as T;
    }
    if (method === 'PATCH' && path.endsWith('/status')) {
      const target = path.slice(0, -'/status'.length);
      const found = this.objects.get(target);
      if (!found) throw error(404);
      if (value.metadata.resourceVersion !== found.metadata.resourceVersion) throw error(409);
      const next = {
        ...found,
        metadata: { ...found.metadata, resourceVersion: String(this.version++) },
        status: { ...found.status, ...value.status },
      };
      if (this.pruneSchedulerIdentity) delete next.status.schedulerIdentity;
      this.objects.set(target, next);
      return structuredClone(next) as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
  data(path: string, key: string): string {
    return Buffer.from(this.objects.get(path)?.data?.[key] ?? '', 'base64').toString();
  }
  record(): IdentityRecord {
    return parseIdentityRecord(this.objects.get(recordPath)?.data?.[IDENTITIES_KEY] ?? '');
  }
}

function tenant(annotations: Record<string, string> = {}): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: INSTALL },
      annotations,
    },
    spec: {},
  };
}

/** A clock the tests move. */
const clock = { now: T0 };
/** Deterministic issuance IDs: 0101.., 0202.., ... */
function counter() {
  let n = 0;
  return (size: number) => Buffer.alloc(size, ++n);
}

/** A cluster with the PKI namespace, both CAs and the record, as the bootstrap Job leaves it. */
async function cluster(options: { operatorNamespace?: boolean } = {}) {
  const api = new FakeApi();
  api.seed(nsPath(PKI), { metadata: { name: PKI } });
  await bootstrapSchedulerPki(api, { installation: INSTALL, namespace: NS }, T0);
  api.seed(tenantPath, tenant() as unknown as Stored);
  if (options.operatorNamespace)
    api.seed(nsPath(OPERATOR_NS), {
      metadata: { name: OPERATOR_NS, labels: { [INSTALLATION]: INSTALL, [OWNER]: 'alpha-uid' } },
    });
  api.calls.length = 0;
  const identities = new TenantSchedulerIdentities(
    api,
    { installation: INSTALL, namespace: NS },
    () => clock.now,
    counter(),
  );
  return { api, identities };
}

const ca = (api: FakeApi, kind: 'platform' | 'tenant') => ({
  cert: api.data(caPath, CA_KEYS[kind].cert),
  key: api.data(caPath, CA_KEYS[kind].key),
});
const leafOf = (api: FakeApi, path: string) => ({
  cert: api.data(path, 'tls.crt'),
  key: api.data(path, 'tls.key'),
});
const userOf = (api: FakeApi, path: string) => certificateNames(api.data(path, 'tls.crt'))?.dns;

let warn: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  clock.now = T0;
  warn = spyOn(console, 'warn').mockImplementation(() => {});
  log = spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
});

describe('tenant scheduler identity issuance (#541 m6c)', () => {
  it('does nothing, and reports nothing, on an installation without the scheduler PKI namespace', async () => {
    const api = new FakeApi();
    const identities = new TenantSchedulerIdentities(
      api,
      { installation: INSTALL, namespace: NS },
      () => T0,
    );
    expect(await identities.reconcile(tenant())).toEqual([]);
    expect(api.writes()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports pending issuance while the CA is missing, retries each poll, and logs once', async () => {
    const api = new FakeApi();
    api.seed(nsPath(PKI), { metadata: { name: PKI } });
    const identities = new TenantSchedulerIdentities(
      api,
      { installation: INSTALL, namespace: NS },
      () => clock.now,
    );
    const conditions = [];
    for (let i = 0; i < 4; i++) conditions.push(await identities.reconcile(tenant()));
    expect(conditions[0]).toEqual([
      {
        type: SCHEDULER_IDENTITY_PENDING,
        status: 'True',
        reason: 'CaNotReady',
        message: `Waiting for the scheduler PKI bootstrap Job to create ${PKI}/${SCHEDULER_CA_SECRET}`,
        observedGeneration: 1,
        lastTransitionTime: T0.toISOString(),
      },
    ]);
    // The same condition every poll, so the Tenant status is not rewritten.
    for (const c of conditions) expect(c).toEqual(conditions[0] as never);
    expect(api.calls.filter((c) => c.path === caPath)).toHaveLength(4);
    expect(api.writes()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    // The Job completes: the next poll issues, and the change is logged once.
    await bootstrapSchedulerPki(api, { installation: INSTALL, namespace: NS }, T0);
    api.seed(tenantPath, tenant() as unknown as Stored);
    expect(await identities.reconcile(tenant())).toEqual([]);
    expect(api.objects.has(hostPath)).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toBe('Tenant/alpha: scheduler identities issued');
  });

  it('reports pending issuance while the record is missing or a CA does not verify, naming no key', async () => {
    const { api, identities } = await cluster();
    const record = api.objects.get(recordPath) as Stored;
    api.objects.delete(recordPath);
    expect((await identities.reconcile(tenant()))[0]).toMatchObject({
      reason: 'CaNotReady',
      message: `Waiting for the scheduler PKI bootstrap Job to create ${PKI}/${SCHEDULER_IDENTITIES}`,
    });
    api.objects.set(recordPath, record);
    const secret = api.objects.get(caPath) as Stored;
    const key = secret.data?.[CA_KEYS.tenant.key] as string;
    (secret.data as Record<string, string>)[CA_KEYS.tenant.key] = secret.data?.[
      CA_KEYS.platform.key
    ] as string;
    const [pending] = await identities.reconcile(tenant());
    expect(pending).toMatchObject({
      type: SCHEDULER_IDENTITY_PENDING,
      reason: 'CaNotReady',
      message: `${PKI}/${SCHEDULER_CA_SECRET}: the tenant CA certificate or key is missing or does not match`,
    });
    expect(JSON.stringify(pending)).not.toContain(key);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE KEY');
    expect(api.writes()).toEqual([]);
  });

  it('issues the hosts identity from the tenant CA, writing the record first', async () => {
    const { api, identities } = await cluster();
    expect(await identities.reconcile(tenant())).toEqual([]);
    expect(api.writes()).toEqual([
      `PUT ${recordPath}`,
      `POST /api/v1/namespaces/${RUNTIME}/secrets`,
    ]);
    const id = api.record()['tenant/alpha/hosts']?.current as string;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // The operator waits for its namespace, which the cut-over creates.
    expect(api.record()['tenant/alpha/operator']).toBeUndefined();
    const secret = api.objects.get(hostPath) as Stored;
    expect(secret.type).toBe('kubernetes.io/tls');
    expect(secret.metadata.labels).toEqual({
      [INSTALLATION]: INSTALL,
      [OWNER]: 'alpha-uid',
      [TENANT]: 'alpha',
      [COMPONENT]: SCHEDULER_IDENTITY_COMPONENT,
    });
    const leaf = leafOf(api, hostPath);
    expect(issuedBy(ca(api, 'tenant').cert, leaf.cert, leaf.key)).toBe(true);
    expect(issuedBy(ca(api, 'platform').cert, leaf.cert, leaf.key)).toBe(false);
    expect(userOf(api, hostPath)).toEqual([tenantHostUser('alpha', id)]);
    expect(api.data(hostPath, 'ca.crt')).toBe(ca(api, 'platform').cert);
    const x509 = new X509Certificate(leaf.cert);
    expect(new Date(x509.validTo).getTime() - new Date(x509.validFrom).getTime()).toBeGreaterThan(
      (SCHEDULER_LEAF_DAYS - 1) * DAY,
    );
  });

  it('issues the operator identity from the platform CA once di-operator-<t> exists', async () => {
    const { api, identities } = await cluster({ operatorNamespace: true });
    await identities.reconcile(tenant());
    const record = api.record();
    const id = record['tenant/alpha/operator']?.current as string;
    expect(id).not.toBe(record['tenant/alpha/hosts']?.current);
    const leaf = leafOf(api, operatorPath);
    expect(issuedBy(ca(api, 'platform').cert, leaf.cert, leaf.key)).toBe(true);
    expect(userOf(api, operatorPath)).toEqual([tenantOperatorUser('alpha', id)]);
  });

  it('writes nothing in a steady state over many polls', async () => {
    const { api, identities } = await cluster({ operatorNamespace: true });
    await identities.reconcile(tenant());
    api.calls.length = 0;
    for (let i = 0; i < 10; i++) {
      clock.now = new Date(T0.getTime() + i * DAY);
      expect(await identities.reconcile(tenant())).toEqual([]);
    }
    expect(api.writes()).toEqual([]);
    // Observed through one LIST, never re-read by name while nothing is issued.
    expect(api.calls.filter((c) => c.path === hostPath || c.path === operatorPath)).toEqual([]);
  });

  it('renews in the renewal window, keeping the previous user, then settles', async () => {
    const { api, identities } = await cluster({ operatorNamespace: true });
    await identities.reconcile(tenant());
    const before = api.record();
    api.calls.length = 0;
    clock.now = new Date(T0.getTime() + 61 * DAY);
    expect(await identities.reconcile(tenant())).toEqual([]);
    const renewed = api.record();
    for (const key of ['tenant/alpha/hosts', 'tenant/alpha/operator']) {
      expect(renewed[key]?.previous).toBe(before[key]?.current as string);
      expect(renewed[key]?.current).not.toBe(before[key]?.current as string);
      expect(renewed[key]?.previousUntil).toBe(
        new Date(clock.now.getTime() + RENEWAL_OVERLAP_MS).toISOString(),
      );
    }
    expect(api.writes()).toEqual([`PUT ${recordPath}`, `PUT ${hostPath}`, `PUT ${operatorPath}`]);
    expect(userOf(api, hostPath)).toEqual([
      tenantHostUser('alpha', renewed['tenant/alpha/hosts']?.current as string),
    ]);
    // Within the overlap nothing more is written.
    api.calls.length = 0;
    await identities.reconcile(tenant());
    expect(api.writes()).toEqual([]);
    // Past it the operator drops its previous user once; the hosts keep theirs, since no rollout
    // of the new certificate is observed, and the stall is reported without any write.
    clock.now = new Date(clock.now.getTime() + RENEWAL_OVERLAP_MS);
    const [stalled] = await identities.reconcile(tenant());
    expect(stalled).toMatchObject({
      type: RENEWAL_STALLED,
      reason: 'RolloutNotObserved',
      message: expect.stringContaining(`Deployment ${RUNTIME}/hostgroup-tenant-alpha`),
    });
    expect(api.writes()).toEqual([`PUT ${recordPath}`]);
    expect(api.record()['tenant/alpha/operator']?.previous).toBeUndefined();
    expect(api.record()['tenant/alpha/hosts']?.previous).toBeDefined();
    api.calls.length = 0;
    for (let i = 0; i < 3; i++) await identities.reconcile(tenant());
    expect(api.writes()).toEqual([]);
  });

  it('drops the hosts previous user once the rollout of the new certificate is observed', async () => {
    const { api, identities } = await cluster();
    await identities.reconcile(tenant());
    clock.now = new Date(T0.getTime() + 61 * DAY);
    await identities.reconcile(tenant());
    const digest = schedulerCertDigest(api.data(hostPath, 'tls.crt'));
    const rollout = (status: Record<string, number>) =>
      api.seed(deploymentPath, {
        metadata: { name: 'hostgroup-tenant-alpha', generation: 2 } as Stored['metadata'],
        spec: {
          replicas: 1,
          template: { metadata: { annotations: { [SCHEDULER_TLS_ANNOTATION]: digest } } },
        },
        status,
      });
    // Not observed yet, then updated but not ready, then updated and ready but stale: kept.
    for (const status of <Record<string, number>[]>[
      { observedGeneration: 1 },
      { observedGeneration: 2, updatedReplicas: 1, readyReplicas: 0 },
      { observedGeneration: 2, updatedReplicas: 0, readyReplicas: 1 },
    ]) {
      rollout(status);
      await identities.reconcile(tenant());
      expect(api.record()['tenant/alpha/hosts']?.previous).toBeDefined();
    }
    rollout({ observedGeneration: 2, updatedReplicas: 1, readyReplicas: 1 });
    expect(await identities.reconcile(tenant())).toEqual([]);
    expect(api.record()['tenant/alpha/hosts']?.previous).toBeUndefined();
    api.seed(deploymentPath, { metadata: { name: 'hostgroup-tenant-alpha' } });
    api.calls.length = 0;
    await identities.reconcile(tenant());
    expect(api.writes()).toEqual([]);
  });

  it('rotates on the Tenant annotation once, recording it after the record and before issuance', async () => {
    const { api, identities } = await cluster({ operatorNamespace: true });
    await identities.reconcile(tenant());
    const before = api.record();
    api.calls.length = 0;
    const t = tenant({ [ROTATE_ANNOTATION]: 'r1' });
    // The annotation as the API server holds it.
    api.seed(tenantPath, structuredClone(t) as unknown as Stored);
    t.metadata.resourceVersion = api.objects.get(tenantPath)?.metadata.resourceVersion;
    await identities.reconcile(t);
    expect(api.writes()).toEqual([
      `PUT ${recordPath}`,
      `PATCH ${tenantPath}/status`,
      `PUT ${hostPath}`,
      `PUT ${operatorPath}`,
    ]);
    const after = api.record();
    for (const key of ['tenant/alpha/hosts', 'tenant/alpha/operator']) {
      expect(after[key]?.current).not.toBe(before[key]?.current as string);
      expect(after[key]?.previous).toBeUndefined();
    }
    expect(t.status?.schedulerIdentity).toEqual({ rotation: 'r1' });
    expect(api.objects.get(tenantPath)?.status?.schedulerIdentity).toEqual({ rotation: 'r1' });
    // Handled: later polls write nothing.
    api.calls.length = 0;
    for (let i = 0; i < 3; i++) await identities.reconcile(t);
    expect(api.writes()).toEqual([]);
  });

  it('does not rotate again for a Tenant from a stale LIST that lacks the handled rotation', async () => {
    const { api, identities } = await cluster();
    await identities.reconcile(tenant());
    const stored = api.objects.get(tenantPath) as Stored;
    api.objects.set(tenantPath, { ...stored, status: { schedulerIdentity: { rotation: 'r1' } } });
    api.calls.length = 0;
    await identities.reconcile(tenant({ [ROTATE_ANNOTATION]: 'r1' }));
    expect(api.writes()).toEqual([]);
  });

  it('re-issues a Secret deleted out of band under a new ID, revoking the old one', async () => {
    const { api, identities } = await cluster();
    await identities.reconcile(tenant());
    const old = api.record()['tenant/alpha/hosts']?.current;
    api.objects.delete(hostPath);
    api.calls.length = 0;
    await identities.reconcile(tenant());
    expect(api.writes()).toEqual([
      `PUT ${recordPath}`,
      `POST /api/v1/namespaces/${RUNTIME}/secrets`,
    ]);
    const entry = api.record()['tenant/alpha/hosts'];
    expect(entry?.current).not.toBe(old as string);
    expect(entry?.previous).toBeUndefined();
    expect(userOf(api, hostPath)).toEqual([tenantHostUser('alpha', entry?.current as string)]);
  });

  it('reads the Secret fresh before issuing, so a stale LIST issues nothing', async () => {
    const { api, identities } = await cluster();
    await identities.reconcile(tenant());
    const record = serializeIdentityRecord(api.record());
    const cert = api.data(hostPath, 'tls.crt');
    // The LIST still answers from before the first issuance.
    api.staleSecrets = [];
    api.calls.length = 0;
    for (let i = 0; i < 3; i++) expect(await identities.reconcile(tenant())).toEqual([]);
    expect(api.writes()).toEqual([]);
    expect(api.calls.filter((c) => c.method === 'GET' && c.path === hostPath)).toHaveLength(3);
    expect(serializeIdentityRecord(api.record())).toBe(record);
    expect(api.data(hostPath, 'tls.crt')).toBe(cert);
  });

  it('re-issues for the recorded ID a certificate that does not verify, drawing no new ID', async () => {
    const { api, identities } = await cluster();
    await identities.reconcile(tenant());
    const id = api.record()['tenant/alpha/hosts']?.current as string;
    const secret = api.objects.get(hostPath) as Stored;
    (secret.data as Record<string, string>)['tls.crt'] = Buffer.from('garbage').toString('base64');
    api.calls.length = 0;
    await identities.reconcile(tenant());
    expect(api.writes()).toEqual([`PUT ${hostPath}`]);
    expect(userOf(api, hostPath)).toEqual([tenantHostUser('alpha', id)]);
  });

  it('re-issues a certificate that names another tenant, for the recorded ID', async () => {
    const { api, identities } = await cluster();
    await identities.reconcile(tenant());
    const id = api.record()['tenant/alpha/hosts']?.current as string;
    const record = api.record();
    record['tenant/alpha/hosts'] = { current: 'cccccccccccccccc' };
    const stored = api.objects.get(recordPath) as Stored;
    api.objects.set(recordPath, {
      ...stored,
      data: { [IDENTITIES_KEY]: serializeIdentityRecord(record) },
    });
    api.calls.length = 0;
    await identities.reconcile(tenant());
    // The Secret carries `id`, the record `cccc…`: the issuance is pending, so it is retried for
    // the recorded ID without a new one.
    expect(api.writes()).toEqual([`PUT ${hostPath}`]);
    expect(userOf(api, hostPath)).toEqual([tenantHostUser('alpha', 'cccccccccccccccc')]);
    expect(id).not.toBe('cccccccccccccccc');
  });

  it('re-issues a certificate from the tenant CA that names another tenant with the recorded ID', async () => {
    const { api, identities } = await cluster();
    await identities.reconcile(tenant());
    const id = api.record()['tenant/alpha/hosts']?.current as string;
    const tenantCa = ca(api, 'tenant');
    const beta = tenantHostUser('beta', id);
    const leaf = leafCertificate(beta, [beta], [], 90, tenantCa.cert, tenantCa.key, T0, 'client');
    const secret = api.objects.get(hostPath) as Stored;
    secret.data = {
      ...secret.data,
      'tls.crt': Buffer.from(leaf.cert).toString('base64'),
      'tls.key': Buffer.from(leaf.key).toString('base64'),
    };
    api.calls.length = 0;
    await identities.reconcile(tenant());
    expect(api.writes()).toEqual([`PUT ${hostPath}`]);
    expect(userOf(api, hostPath)).toEqual([tenantHostUser('alpha', id)]);
  });

  it('issues no operator identity into a di-operator-<t> this installation did not create for the Tenant', async () => {
    for (const labels of <Record<string, string>[]>[
      {},
      { [INSTALLATION]: 'other', [OWNER]: 'alpha-uid' },
      { [INSTALLATION]: INSTALL, [OWNER]: 'other-uid' },
    ]) {
      const { api, identities } = await cluster();
      api.seed(nsPath(OPERATOR_NS), { metadata: { name: OPERATOR_NS, labels } });
      expect(await identities.reconcile(tenant())).toEqual([]);
      expect(api.objects.has(operatorPath)).toBe(false);
      expect(api.record()['tenant/alpha/operator']).toBeUndefined();
      expect(api.writes().filter((w) => w.includes(OPERATOR_NS))).toEqual([]);
    }
  });

  it('applies a rotation once when the API server does not keep the handled value, and says so once', async () => {
    const { api, identities } = await cluster();
    await identities.reconcile(tenant());
    api.pruneSchedulerIdentity = true;
    const t = tenant({ [ROTATE_ANNOTATION]: 'r1' });
    api.seed(tenantPath, structuredClone(t) as unknown as Stored);
    const before = api.record()['tenant/alpha/hosts']?.current;
    api.calls.length = 0;
    const [pending] = await identities.reconcile(tenant({ [ROTATE_ANNOTATION]: 'r1' }));
    expect(pending).toMatchObject({
      type: SCHEDULER_IDENTITY_PENDING,
      reason: 'RotationNotPersisted',
    });
    const rotated = api.record()['tenant/alpha/hosts']?.current;
    expect(rotated).not.toBe(before as string);
    expect(userOf(api, hostPath)).toEqual([tenantHostUser('alpha', rotated as string)]);
    // Later polls (each from a LIST without the handled value) neither rotate nor write.
    api.calls.length = 0;
    for (let i = 0; i < 4; i++) {
      const [again] = await identities.reconcile(tenant({ [ROTATE_ANNOTATION]: 'r1' }));
      expect(again?.reason).toBe('RotationNotPersisted');
    }
    expect(api.writes()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    // A new rotation value is applied again; forgetting the tenant clears the memory.
    identities.forget(new Set(['alpha']));
    identities.forget(new Set());
    api.calls.length = 0;
    await identities.reconcile(tenant({ [ROTATE_ANNOTATION]: 'r1' }));
    expect(api.writes()).toContain(`PATCH ${tenantPath}/status`);
  });

  it('sends the fresh Tenant resourceVersion with the rotation, so a stale LIST does not conflict', async () => {
    const { api, identities } = await cluster();
    await identities.reconcile(tenant());
    api.seed(tenantPath, tenant({ [ROTATE_ANNOTATION]: 'r1' }) as unknown as Stored);
    const stale = tenant({ [ROTATE_ANNOTATION]: 'r1' });
    stale.metadata.resourceVersion = '0';
    expect(await identities.reconcile(stale)).toEqual([]);
    expect(api.objects.get(tenantPath)?.status?.schedulerIdentity).toEqual({ rotation: 'r1' });
  });

  it('refuses to issue over a Secret it did not write', async () => {
    const { api, identities } = await cluster();
    // No labels, and (S6) this installation's and Tenant's labels without the component label.
    for (const labels of <Record<string, string>[]>[
      {},
      { [INSTALLATION]: INSTALL, [OWNER]: 'alpha-uid', [TENANT]: 'alpha' },
    ]) {
      api.seed(hostPath, { metadata: { name: TENANT_HOST_SECRET, namespace: RUNTIME, labels } });
      const [pending] = await identities.reconcile(tenant());
      expect(pending).toMatchObject({ type: SCHEDULER_IDENTITY_PENDING, reason: 'SecretNotOwned' });
      expect(api.writes()).toEqual([]);
    }
  });

  it('reports a failing issuance as pending, without throwing', async () => {
    const { api, identities } = await cluster();
    api.failing = { method: 'POST', path: `/api/v1/namespaces/${RUNTIME}/secrets`, code: 403 };
    const [pending] = await identities.reconcile(tenant());
    expect(pending).toMatchObject({
      type: SCHEDULER_IDENTITY_PENDING,
      reason: 'IssuanceFailed',
      message: `Scheduler identity issuance failed: POST /api/v1/namespaces/${RUNTIME}/secrets returned 403`,
    });
    api.failing = { method: 'GET', path: recordPath, code: 500 };
    expect((await identities.reconcile(tenant()))[0]?.reason).toBe('IssuanceFailed');
    api.failing = undefined;
    const failure = new TenantSchedulerIdentities(
      { call: () => Promise.reject('down') },
      { installation: INSTALL, namespace: NS },
      () => T0,
    );
    expect((await failure.reconcile(tenant()))[0]?.message).toBe(
      'Scheduler identity issuance failed: down',
    );
  });

  it('drops a tenant entry from the record for removal steps R1 and R4', async () => {
    const { api, identities } = await cluster({ operatorNamespace: true });
    await identities.reconcile(tenant());
    api.calls.length = 0;
    await identities.drop('alpha', 'hosts');
    expect(api.record()['tenant/alpha/hosts']).toBeUndefined();
    expect(api.record()['tenant/alpha/operator']).toBeDefined();
    await identities.drop('alpha', 'hosts');
    await identities.drop('alpha', 'operator');
    expect(Object.keys(api.record()).filter((k) => k.startsWith('tenant/'))).toEqual([]);
    expect(api.writes()).toEqual([`PUT ${recordPath}`, `PUT ${recordPath}`]);
    api.objects.delete(recordPath);
    await identities.drop('alpha', 'operator');
  });

  it('forgets the logged state of tenants that are gone', async () => {
    const api = new FakeApi();
    api.seed(nsPath(PKI), { metadata: { name: PKI } });
    const identities = new TenantSchedulerIdentities(
      api,
      { installation: INSTALL, namespace: NS },
      () => T0,
    );
    await identities.reconcile(tenant());
    identities.forget(new Set(['alpha']));
    await identities.reconcile(tenant());
    expect(warn).toHaveBeenCalledTimes(1);
    identities.forget(new Set());
    await identities.reconcile(tenant());
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
