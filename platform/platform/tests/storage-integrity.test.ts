import { describe, expect, it, spyOn } from 'bun:test';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  type Condition,
  type ControllerConfig,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  STORAGE_RECORDS_CONFIG,
  type Tenant,
  VERSION,
} from '../src/tenancy/resources';
import type { StorageRecords } from '../src/tenancy/storage-records';
import {
  STORAGE_ANNOTATION,
  STORAGE_FORMAT_ANNOTATION,
  STORAGE_MOUNT_ANNOTATION,
} from '../src/tenancy/workload-storage';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
};
const n = names('alpha');

function key(value: {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
}) {
  return `${collection(value.apiVersion, value.kind, value.metadata.namespace)}/${value.metadata.name}`;
}

/** JSON merge patch (RFC 7386): null removes a key. */
function merge(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = merge(out[k], v);
  }
  return out;
}

class MemoryApi implements Api {
  objects = new Map<string, Resource>();
  operations: { method: string; path: string; body?: unknown }[] = [];
  logs = new Map<string, string>();
  failConfigMap = false;
  seed(value: Resource | Tenant): void {
    this.objects.set(key(value), structuredClone(value) as Resource);
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.operations.push({ method, path, body });
    const url = new URL(path, 'https://kubernetes');
    if (method === 'GET' && url.pathname.endsWith('/log')) {
      return (this.logs.get(url.pathname) ?? '') as T;
    }
    if (method === 'GET' && url.searchParams.has('labelSelector')) {
      const labels = (url.searchParams.get('labelSelector') as string)
        .split(',')
        .map((v) => v.split('='));
      return {
        items: [...this.objects.values()]
          .filter(
            (v) =>
              (collection(v.apiVersion, v.kind) === url.pathname ||
                collection(v.apiVersion, v.kind, v.metadata.namespace) === url.pathname) &&
              labels.every(([k, x]) => v.metadata.labels?.[k as string] === x),
          )
          .map(({ apiVersion: _version, kind: _kind, ...item }) => item),
      } as T;
    }
    const status = url.pathname.endsWith('/status');
    const target = url.pathname.replace(/\/status$/, '');
    const existing = this.objects.get(target);
    if (method === 'GET') {
      if (!existing) throw new ApiError(404, 'Not found');
      return structuredClone(existing) as T;
    }
    if (method === 'DELETE') {
      this.objects.delete(target);
      return {} as T;
    }
    if (method === 'PATCH') {
      const data = structuredClone(body) as Resource;
      if (
        this.failConfigMap &&
        data.kind === 'ConfigMap' &&
        data.metadata.name === STORAGE_RECORDS_CONFIG
      )
        throw new ApiError(500, 'boom');
      let value: Resource;
      if (status) {
        value = {
          ...(existing as Resource),
          status: merge(existing?.status, (data as unknown as { status: unknown }).status),
        };
      } else {
        value = {
          ...existing,
          ...data,
          metadata: { ...existing?.metadata, ...data.metadata },
        } as Resource;
        value.metadata.uid ??= `${value.metadata.name}-created-uid`;
        value.metadata.generation ??= 1;
        if (value.kind === 'Deployment')
          value.status = {
            observedGeneration: 1,
            readyReplicas: (value.spec as { replicas: number }).replicas,
          };
      }
      this.objects.set(target, value);
      return structuredClone(value) as T;
    }
    throw new Error(`Unexpected ${method}`);
  }
}

function tenant(integrity?: 'Off' | 'AEAD'): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      resourceVersion: '1',
      labels: { [INSTALLATION]: 'test' },
    },
    spec: integrity ? { storage: { integrity } } : {},
    status: { conditions: [] },
  };
}

function workload(
  name: string,
  opts: { key?: string; pglite?: boolean; mount?: string } = {},
): Resource {
  return {
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'WorkloadDeployment',
    metadata: {
      name,
      namespace: n.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'di-framework',
        ...(opts.key ? { 'di-framework.dev/workload': opts.key } : {}),
      },
      annotations: {
        [STORAGE_ANNOTATION]: 'true',
        ...(opts.pglite ? { [STORAGE_FORMAT_ANNOTATION]: 'pglite-encfs' } : {}),
        ...(opts.mount ? { [STORAGE_MOUNT_ANNOTATION]: opts.mount } : {}),
      },
    },
    spec: {
      template: { spec: { environment: n.namespace, components: [{ name, image: 'r/a:1' }] } },
    },
  };
}

type Terminated = { exitCode: number; message?: string; reason?: string };
function hostPod(
  uid: string,
  step?: {
    state?: { terminated?: Terminated; running?: object };
    lastState?: { terminated?: Terminated };
  },
  created = '2026-10-29T00:00:00Z',
): Resource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `host-${uid}`,
      uid,
      namespace: n.runtimeNamespace,
      creationTimestamp: created,
      labels: { 'wasmcloud.com/hostgroup': n.hostgroup, 'wasmcloud.com/name': 'hostgroup' },
    },
    status: {
      phase: 'Pending',
      ...(step ? { initContainerStatuses: [{ name: 'storage-mode', ...step }] } : {}),
    },
  };
}

function prepare(t: Tenant = tenant()) {
  const api = new MemoryApi();
  api.seed(t);
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'wasmcloud-runtime-tls', namespace: cfg.namespace },
    data: { 'ca.crt': 'test' },
  });
  return { api, controller: new Controller(api, cfg), t };
}

const records = (api: MemoryApi) =>
  ((api.objects.get(key(tenant())) as Resource).status as { storage?: { keys?: StorageRecords } })
    .storage?.keys;
const condition = (t: Tenant) =>
  t.status?.conditions?.find((c) => c.type === 'StorageIntegrity') as Condition;
const hostSpec = (api: MemoryApi) =>
  (
    (
      api.objects.get(
        key({
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: `hostgroup-${n.hostgroup}`, namespace: n.runtimeNamespace },
        }),
      ) as Resource
    ).spec as { template: { spec: { initContainers: { name: string; args?: string[] }[] } } }
  ).template.spec;
const logPath = (uid: string) => `${collection('v1', 'Pod', n.runtimeNamespace)}/host-${uid}/log`;

describe('storage records in the tenant reconcile (#200)', () => {
  it('records keys before the host pod that mounts them, and reserves pglite keys requested AEAD', async () => {
    const { api, controller, t } = prepare(tenant('AEAD'));
    api.seed(workload('db', { pglite: true }));
    api.seed(workload('act', { mount: '/data/actors' }));
    await controller.reconcileTenant(t, []);
    expect(records(api)).toEqual({
      db: { kind: 'PgliteEncfs', requested: 'AEAD' },
      act: { kind: 'Other' },
    });
    const statusWrite = api.operations.findIndex(
      (o) => o.method === 'PATCH' && o.path.endsWith('/tenants/alpha/status'),
    );
    const hostWrite = api.operations.findIndex(
      (o) => o.method === 'PATCH' && o.path.includes(`/deployments/hostgroup-${n.hostgroup}`),
    );
    expect(statusWrite).toBeGreaterThanOrEqual(0);
    expect(statusWrite).toBeLessThan(hostWrite);
    const mode = hostSpec(api).initContainers.find((c) => c.name === 'storage-mode');
    expect(mode?.args).toEqual([
      '--root=/var/lib/di-framework/tenant-workloads',
      '--mounts=/var/lib/di-framework/workloads',
      '--keys=act,db',
      '--reserve=db',
    ]);
    const copy = api.objects.get(
      key({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: STORAGE_RECORDS_CONFIG, namespace: n.runtimeNamespace },
      }),
    ) as Resource & { data: Record<string, string> };
    expect(copy.metadata.labels).toMatchObject({ [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' });
    expect(JSON.parse(copy.data.keys as string)).toEqual({
      act: { kind: 'Other' },
      db: { kind: 'PgliteEncfs', requested: 'AEAD' },
    });
    expect(condition(t)).toMatchObject({ status: 'Unknown', reason: 'AwaitingObservation' });
    // The patch goes only to workloads whose key is recorded with their kind.
    const patches = api.operations.length;
    await controller.reconcileWorkloadStorage(t);
    expect(
      api.operations
        .slice(patches)
        .filter((o) => o.method === 'PATCH')
        .map((o) => o.path.split('?')[0]),
    ).toEqual([
      `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', n.namespace)}/db`,
      `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', n.namespace)}/act`,
    ]);
  });

  it('reads the listing once per host pod, records modes and backfills other directories', async () => {
    const { api, controller, t } = prepare(tenant('AEAD'));
    api.seed(workload('db', { pglite: true }));
    api.seed(workload('act', { mount: '/data/actors' }));
    await controller.reconcileTenant(t, []);
    api.seed(hostPod('p1', { state: { terminated: { exitCode: 0 } } }));
    api.logs.set(
      logPath('p1'),
      'act unencrypted\ndb reserved\nold xts\nfree empty\ndone count=4\n',
    );
    await controller.reconcileTenant(t, []);
    expect(records(api)).toEqual({
      db: { kind: 'PgliteEncfs', requested: 'AEAD', mode: 'AEAD', observed: 'reserved' },
      act: { kind: 'Other', mode: 'NotEncfs', observed: 'unencrypted' },
      old: { kind: 'PgliteEncfs', mode: 'XTS', observed: 'xts' },
    });
    expect(condition(t)).toMatchObject({ status: 'True', reason: 'AsRecorded' });
    await controller.reconcileTenant(t, []);
    expect(api.operations.filter((o) => o.path.includes('/log')).map((o) => o.path)).toEqual([
      `${logPath('p1')}?container=storage-mode`,
    ]);
    // A newer host pod's listing marks the directory that is gone, then the entry is pruned.
    api.seed(hostPod('p2', { state: { terminated: { exitCode: 0 } } }, '2026-10-29T01:00:00Z'));
    api.logs.set(logPath('p2'), 'act unencrypted\ndb aead\ndone count=2');
    await controller.reconcileTenant(t, []);
    expect(records(api)?.old).toEqual({ kind: 'PgliteEncfs', mode: 'XTS', observed: 'absent' });
    expect(records(api)?.db?.observed).toBe('aead');
    await controller.reconcileTenant(t, []);
    expect(records(api)?.old).toBeUndefined();
  });

  it('reports a failed storage-mode step from its terminated state', async () => {
    const { api, controller, t } = prepare(tenant('AEAD'));
    api.seed(workload('db', { pglite: true }));
    api.seed(
      hostPod('p1', {
        state: { running: {} },
        lastState: {
          terminated: {
            exitCode: 1,
            message: 'db: non-regular entry at a marker name; not reserved\n',
          },
        },
      }),
    );
    await controller.reconcileTenant(t, []);
    expect(condition(t)).toMatchObject({
      status: 'False',
      reason: 'ObservationFailed',
      message: expect.stringContaining('storage-mode in host-p1 exited 1: db: non-regular entry'),
    });
    api.seed(hostPod('p1', { state: { terminated: { exitCode: 2, reason: 'Error' } } }));
    await controller.reconcileTenant(t, []);
    expect(condition(t).message).toStartWith('storage-mode in host-p1 exited 2: Error');
    api.seed(hostPod('p1', { state: { terminated: { exitCode: 137 } } }));
    await controller.reconcileTenant(t, []);
    expect(condition(t).message).toStartWith(
      'storage-mode in host-p1 exited 137: no termination message',
    );
  });

  it('treats an incomplete listing as a failed observation and a running step as pending', async () => {
    const { api, controller, t } = prepare();
    api.seed(workload('db', { pglite: true }));
    api.seed(hostPod('p1', { state: { terminated: { exitCode: 0 } } }));
    api.logs.set(logPath('p1'), 'db empty\n');
    await controller.reconcileTenant(t, []);
    expect(condition(t)).toMatchObject({
      reason: 'ObservationFailed',
      message:
        'storage-mode in host-p1 printed an incomplete listing (also AwaitingObservation: 1)',
    });
    for (const pod of [
      hostPod('p1'),
      hostPod('p1', { state: { running: {} } }),
      hostPod('p1', { state: { running: {} }, lastState: { terminated: { exitCode: 0 } } }),
    ]) {
      api.seed(pod);
      await controller.reconcileTenant(t, []);
      expect(condition(t)).toMatchObject({ status: 'Unknown', reason: 'AwaitingObservation' });
    }
    // A pod without a uid is not observed either.
    api.seed({ ...hostPod('p1'), metadata: { ...hostPod('p1').metadata, uid: undefined } });
    await controller.reconcileTenant(t, []);
    expect(condition(t).reason).toBe('AwaitingObservation');
  });

  it('withholds storage from workloads of both kinds on one key', async () => {
    const { api, controller, t } = prepare(tenant('AEAD'));
    api.seed(workload('a', { key: 'mesh', pglite: true }));
    api.seed(workload('b', { key: 'mesh' }));
    await controller.reconcileTenant(t, []);
    expect(records(api)).toEqual({});
    expect(hostSpec(api).initContainers.find((c) => c.name === 'storage-mode')?.args).toContain(
      '--keys=',
    );
    expect(condition(t)).toMatchObject({ status: 'False', reason: 'StorageKindConflict' });
    const before = api.operations.length;
    await controller.reconcileWorkloadStorage(t);
    expect(api.operations.slice(before).filter((o) => o.method === 'PATCH')).toEqual([]);
  });

  it('never adopts a di-storage-records ConfigMap it did not write', async () => {
    const { api, controller, t } = prepare();
    const foreign = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: STORAGE_RECORDS_CONFIG, namespace: n.runtimeNamespace },
      data: { keys: '{"db":{"kind":"PgliteEncfs","mode":"XTS"}}' },
    };
    api.seed(foreign);
    api.seed(workload('db', { pglite: true }));
    await controller.reconcileTenant(t, []);
    expect(api.objects.get(key(foreign))).toEqual(foreign);
    expect(condition(t)).toMatchObject({
      status: 'False',
      reason: 'StorageRecordsForeign',
      message: expect.stringContaining(
        `ConfigMap ${n.runtimeNamespace}/${STORAGE_RECORDS_CONFIG} was not written by this controller`,
      ),
    });
    expect(t.status?.conditions?.find((c) => c.type === 'Ready')?.reason).not.toBe(
      'ReconcileError',
    );
  });

  it('reports any other failure to write the copy as a reconcile error', async () => {
    const { api, controller, t } = prepare();
    api.failConfigMap = true;
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await controller.reconcileTenant(t, []);
    } finally {
      log.mockRestore();
    }
    expect(t.status?.conditions?.find((c) => c.type === 'Ready')).toMatchObject({
      reason: 'ReconcileError',
    });
    expect(condition(t)).toBeDefined();
  });
});
