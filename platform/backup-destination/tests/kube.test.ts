import { describe, expect, test } from 'bun:test';
import { applyActions, type KubeClient, KubeError, loadWorld } from '../src/kube.ts';
import {
  acquireLease,
  LEASE_SECONDS,
  leaderTick,
  microTime,
  releaseLease,
  singleFlight,
} from '../src/leader.ts';
import { FINALIZER, LEDGER, opJobName, statusOf } from '../src/model.ts';
import { IMAGE, NOW, TENANT_UID, VOLUME, volumeWorld } from './support/cluster.ts';

const RUNTIME = '/apis/runtime.wasmcloud.dev/v1alpha1/namespaces/di-tenant-alpha';
const CRD = '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-alpha';
const owner = (kind: string, name: string, uid = '') => ({
  ownerReferences: [{ kind, name, uid, controller: true }],
});

const routes = new Map<string, unknown>([
  [
    `${RUNTIME}/workloaddeployments`,
    {
      items: [
        {
          metadata: {
            name: 'identity',
            uid: 'uid-identity',
            annotations: { 'di-framework.dev/persistent-storage': 'true' },
          },
          spec: {
            replicas: 2,
            template: {
              spec: {
                components: [
                  { image: 'ghcr.io/acme/other:1' },
                  {
                    image: IMAGE,
                    localResources: { volumeMounts: [{ name: 'di-storage', mountPath: '/data' }] },
                  },
                ],
              },
            },
          },
          status: { currentReplicas: 1 },
        },
        {
          metadata: { name: 'svc', uid: 'uid-svc', deletionTimestamp: 't' },
          spec: { template: { spec: { service: { image: 'ghcr.io/acme/svc:1' } } } },
        },
        { metadata: { name: 'bare', uid: 'uid-bare' }, spec: {}, status: { currentReplicas: 'x' } },
        { metadata: { name: 'no-uid' } },
      ],
    },
  ],
  [
    `${RUNTIME}/workloadreplicasets`,
    {
      items: [
        {
          metadata: {
            name: 'identity-rs1',
            ...owner('WorkloadDeployment', 'identity', 'uid-identity'),
          },
        },
        {
          metadata: {
            name: 'identity-rs0',
            ...owner('WorkloadDeployment', 'identity', 'uid-identity'),
          },
        },
        { metadata: { name: 'stranger', ...owner('WorkloadDeployment', 'x', 'uid-x') } },
      ],
    },
  ],
  [
    `${RUNTIME}/workloads`,
    {
      items: [
        { metadata: { name: 'w1', ...owner('WorkloadReplicaSet', 'identity-rs1') } },
        { metadata: { name: 'w2', ...owner('WorkloadReplicaSet', 'identity-rs0') } },
        { metadata: { name: 'w3', ...owner('WorkloadReplicaSet', 'stranger') } },
        { metadata: { name: 'w4' } },
      ],
    },
  ],
  [
    '/apis/apps/v1/namespaces/di-runtime-alpha/deployments/hostgroup-tenant-alpha',
    { metadata: { labels: { 'platform.di-framework.dev/owner-uid': TENANT_UID } } },
  ],
  [
    `/api/v1/namespaces/di-tenant-alpha/configmaps/${LEDGER}`,
    {
      metadata: { resourceVersion: '41' },
      data: {
        identity: JSON.stringify({ replicas: 2, heldBy: 'Backup/v1', since: NOW }),
        old: JSON.stringify({ replicas: 1, heldBy: 'Backup/x' }),
        junk: 'not json',
        partial: JSON.stringify({ replicas: 'two', heldBy: 'Backup/v1' }),
      },
    },
  ],
  [
    '/api/v1/namespaces/di-runtime-alpha/pods',
    {
      items: [
        {
          metadata: { name: 'host-0', labels: { 'wasmcloud.com/hostgroup': 'tenant-alpha' } },
          spec: {
            nodeName: 'node-a',
            volumes: [
              { name: 'ws-identity', hostPath: { path: VOLUME } },
              { name: 'tmp', emptyDir: {} },
            ],
          },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
        },
        {
          metadata: {
            name: 'host-old',
            labels: { 'wasmcloud.com/hostgroup': 'tenant-alpha' },
            deletionTimestamp: 't',
          },
          spec: { nodeName: 'node-b', volumes: [{ name: 'ws', hostPath: { path: VOLUME } }] },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
        },
        { metadata: { name: 'host-new', labels: { 'wasmcloud.com/hostgroup': 'tenant-alpha' } } },
        { metadata: { name: 'other', labels: { 'wasmcloud.com/hostgroup': 'tenant-beta' } } },
        {
          metadata: { name: 'copy-abc', ownerReferences: [{ kind: 'Job', name: 'copy' }] },
          status: { phase: 'Pending' },
        },
        {
          metadata: { name: 'probe-abc', ownerReferences: [{ kind: 'Job', name: 'probe' }] },
          status: { phase: 'Pending', containerStatuses: [{ state: { running: {} } }] },
        },
        {
          metadata: { name: 'probe-old', ownerReferences: [{ kind: 'Job', name: 'probe' }] },
          status: { phase: 'Failed' },
        },
      ],
    },
  ],
  [
    `${CRD}/backups`,
    {
      items: [
        {
          metadata: {
            name: 'v1',
            creationTimestamp: NOW,
            resourceVersion: '17',
            finalizers: [FINALIZER],
            deletionTimestamp: NOW,
          },
          spec: {
            serviceName: 'identity',
            destinationName: 'pvc',
            type: 'workload-volume',
            source: { kind: 'workload-volume', workloadName: 'identity' },
          },
          status: { phase: 'Running', message: 'scaling', volume: { stage: 'ScalingDown' } },
        },
        { metadata: { name: 'v2' }, spec: { source: { kind: 'other' } }, status: { volume: [] } },
      ],
    },
  ],
  [
    `${CRD}/backuprestores`,
    {
      items: [
        {
          metadata: { name: 'r1', resourceVersion: '5' },
          spec: {
            sourceBackupName: 'v1',
            targetWorkloadName: 'identity',
            force: true,
            expectedKcv: 'ab'.repeat(16),
          },
          status: { volume: { stage: 'Copying' } },
        },
      ],
    },
  ],
  [
    '/apis/batch/v1/namespaces/di-runtime-alpha/jobs',
    {
      items: [
        {
          metadata: {
            name: 'copy',
            labels: {
              'platform.di-framework.dev/backup-kind': 'volume-copy',
              'platform.di-framework.dev/backup-name': 'v1',
            },
          },
          status: { conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] },
        },
        {
          metadata: {
            name: 'put-back',
            labels: { 'platform.di-framework.dev/backup-kind': 'volume-restore' },
          },
          status: { conditions: 'bad' },
        },
        {
          metadata: {
            name: 'probe',
            labels: { 'platform.di-framework.dev/backup-kind': 'volume-probe' },
          },
          status: {},
        },
      ],
    },
  ],
]);

function client(overrides: Partial<KubeClient> = {}): KubeClient {
  return {
    async get(path: string) {
      if (routes.has(path)) return routes.get(path);
      if (path.endsWith('/secrets/di-backup-destination')) throw new KubeError(404, 'missing');
      return { items: [] };
    },
    async post() {
      return {};
    },
    async patch() {
      return {};
    },
    async remove() {},
    ...overrides,
  };
}

describe('loading workload volume state', () => {
  test('loads workloads, instances, hosts, the ledger, Job pods, and object metadata', async () => {
    const loaded = await loadWorld(
      client(),
      'di-tenant-alpha',
      'image:dev',
      NOW,
      '/var/lib/kubesolo',
    );
    expect(loaded.workloads).toEqual([
      {
        name: 'identity',
        uid: 'uid-identity',
        replicas: 2,
        instances: 2,
        labels: {},
        annotations: { 'di-framework.dev/persistent-storage': 'true' },
        image: IMAGE,
        deleting: false,
      },
      expect.objectContaining({
        name: 'svc',
        replicas: 1,
        instances: 0,
        image: 'ghcr.io/acme/svc:1',
        deleting: true,
      }),
      expect.objectContaining({ name: 'bare', instances: 0, image: undefined }),
    ]);
    expect(loaded.ledger).toEqual({
      resourceVersion: '41',
      entries: {
        identity: { replicas: 2, heldBy: 'Backup/v1', since: NOW },
        old: { replicas: 1, heldBy: 'Backup/x', since: '' },
      },
    });
    expect(loaded.hosts).toEqual([
      { name: 'host-0', node: 'node-a', ready: true, hostPaths: [VOLUME] },
      { name: 'host-old', node: 'node-b', ready: false, terminating: true, hostPaths: [VOLUME] },
      { name: 'host-new', node: undefined, ready: false, hostPaths: [] },
    ]);
    expect(loaded.tenantUid).toBe(TENANT_UID);
    expect(loaded.storageRoot).toBe('/var/lib/kubesolo');
    expect(loaded.backups[0]).toMatchObject({
      source: { kind: 'workload-volume', workloadName: 'identity' },
      volume: { stage: 'ScalingDown' },
      message: 'scaling',
      resourceVersion: '17',
      finalizers: [FINALIZER],
      deleting: true,
    });
    expect(loaded.backups[1]?.source).toBeUndefined();
    expect(loaded.backups[1]?.volume).toBeUndefined();
    expect(loaded.backups[1]?.resourceVersion).toBeUndefined();
    expect(loaded.restores[0]).toMatchObject({
      targetServiceName: '',
      targetWorkloadName: 'identity',
      force: true,
      expectedKcv: 'ab'.repeat(16),
      volume: { stage: 'Copying' },
      resourceVersion: '5',
    });
    expect(loaded.jobs).toEqual([
      expect.objectContaining({
        name: 'copy',
        backupKind: 'volume-copy',
        phase: 'Failed',
        failedReason: 'DeadlineExceeded',
        started: false,
        activePods: 1,
      }),
      expect.objectContaining({
        name: 'put-back',
        backupKind: 'volume-restore',
        phase: 'Running',
        started: false,
        activePods: 0,
      }),
      expect.objectContaining({
        name: 'probe',
        backupKind: 'volume-probe',
        started: true,
        activePods: 1,
      }),
    ]);
  });

  test('any failed read leaves the volume state unknown, never empty; a 404 is absent', async () => {
    const failing = (fragment: string, error: unknown) =>
      client({
        async get(path: string) {
          if (path.includes(fragment)) throw error;
          return client().get(path);
        },
      });
    for (const fragment of [
      '/workloaddeployments',
      '/workloadreplicasets',
      '/workloads',
      '/deployments/hostgroup',
      `/configmaps/${LEDGER}`,
    ]) {
      for (const error of [
        new KubeError(503, 'unavailable'),
        new KubeError(403, 'forbidden'),
        new Error('timeout'),
      ]) {
        const loaded = await loadWorld(failing(fragment, error), 'di-tenant-alpha', 'i', NOW);
        expect(loaded.workloads).toBeUndefined();
        expect(loaded.ledger).toBeUndefined();
        // Services are still backed up: the rest of the world loads.
        expect(loaded.backups).toHaveLength(2);
      }
    }
    const noLedger = await loadWorld(
      failing(`/configmaps/${LEDGER}`, new KubeError(404, 'not found')),
      'di-tenant-alpha',
      'i',
      NOW,
    );
    expect(noLedger.ledger).toEqual({ entries: {} });
    expect(noLedger.workloads).toHaveLength(3);
    const noHost = await loadWorld(
      failing('/deployments/hostgroup', new KubeError(404, 'not found')),
      'di-tenant-alpha',
      'i',
      NOW,
    );
    expect(noHost.workloads).toHaveLength(3);
    expect(noHost.tenantUid).toBeUndefined();
    // A list the rest of the world needs still fails the whole tick.
    await expect(
      loadWorld(failing('/backups', new KubeError(500, 'down')), 'di-tenant-alpha', 'i', NOW),
    ).rejects.toThrow('down');
  });
});

describe('applying actions', () => {
  type Call = [string, string, unknown?];
  const recorder = (respond: (method: string, path: string, body?: unknown) => unknown) => {
    const calls: Call[] = [];
    const api: KubeClient = {
      async get(path) {
        calls.push(['GET', path]);
        return respond('GET', path);
      },
      async post(path, body) {
        calls.push(['POST', path, body]);
        return respond('POST', path, body);
      },
      async patch(path, body) {
        calls.push(['PATCH', path, body]);
        return respond('PATCH', path, body);
      },
      async remove(path) {
        calls.push(['DELETE', path]);
        respond('DELETE', path);
      },
    };
    return { calls, api };
  };

  test('threads resourceVersion through one tick and stops on a conflict', async () => {
    let version = 17;
    const { calls, api } = recorder((method, path, body) => {
      const sent = (body as { metadata?: { resourceVersion?: string } } | undefined)?.metadata
        ?.resourceVersion;
      if (method === 'PATCH' && path.includes('/backups/') && sent !== String(version)) {
        throw new KubeError(409, 'conflict');
      }
      version += 1;
      return { metadata: { resourceVersion: String(version) } };
    });
    await applyActions(api, volumeWorld(), [
      { type: 'backup-status', name: 'b', status: { phase: 'Running' }, resourceVersion: '17' },
      {
        type: 'finalizers',
        resource: 'backups',
        name: 'b',
        finalizers: [FINALIZER],
        resourceVersion: '17',
      },
      { type: 'backup-status', name: 'b', status: { phase: 'Succeeded' }, resourceVersion: '17' },
    ]);
    expect(
      calls.map(
        (call) => (call[2] as { metadata: { resourceVersion: string } }).metadata.resourceVersion,
      ),
    ).toEqual(['17', '18', '19']);
    expect(calls[0]?.[1]).toBe(`${CRD}/backups/b/status`);
    expect(calls[1]).toEqual([
      'PATCH',
      `${CRD}/backups/b`,
      { metadata: { resourceVersion: '18', finalizers: [FINALIZER] } },
    ]);

    // A stale writer: its first write conflicts and nothing after it runs.
    calls.length = 0;
    await expect(
      applyActions(api, volumeWorld(), [
        { type: 'restore-status', name: 'r', status: {}, resourceVersion: '1' },
        { type: 'backup-status', name: 'b', status: { phase: 'Failed' }, resourceVersion: '3' },
        { type: 'scale-workload', name: 'identity', replicas: 2 },
      ]),
    ).rejects.toThrow('conflict');
    expect(calls.map((call) => call[1])).toEqual([
      `${CRD}/backuprestores/r/status`,
      `${CRD}/backups/b/status`,
    ]);
    // Without a known version the write carries no precondition.
    calls.length = 0;
    await applyActions(recorder(() => ({})).api, volumeWorld(), [
      { type: 'restore-status', name: 'r', status: {} },
    ]);
  });

  test('a 404 skips a scale or a delete, a 409 on a create is success, anything else stops', async () => {
    const answer = (status: number) =>
      recorder(() => {
        throw new KubeError(status, `failed ${status}`);
      }).api;
    const world = volumeWorld();
    await applyActions(answer(404), world, [
      { type: 'scale-workload', name: 'gone', replicas: 2 },
      { type: 'delete-job', name: 'j' },
      { type: 'delete-backup', name: 'b' },
      { type: 'finalizers', resource: 'backuprestores', name: 'r', finalizers: [] },
    ]);
    await applyActions(answer(409), world, [
      { type: 'create-job', body: { metadata: { namespace: 'di-runtime-alpha', name: 'j' } } },
      { type: 'create-backup', body: {} },
      { type: 'create-restore', body: {} },
    ]);
    await expect(
      applyActions(answer(500), world, [{ type: 'scale-workload', name: 'x', replicas: 2 }]),
    ).rejects.toThrow('failed 500');
    await expect(
      applyActions(answer(403), world, [{ type: 'create-job', body: { metadata: {} } }]),
    ).rejects.toThrow('failed 403');
    await expect(
      applyActions(answer(409), world, [{ type: 'scale-workload', name: 'x', replicas: 2 }]),
    ).rejects.toThrow('failed 409');
  });

  test('scales through the scale subresource and deletes a Job in the background', async () => {
    const { calls, api } = recorder(() => ({}));
    await applyActions(api, volumeWorld(), [
      { type: 'scale-workload', name: 'identity', replicas: 0 },
      { type: 'delete-job', name: 'di-volume-identity-1' },
    ]);
    expect(calls).toEqual([
      ['PATCH', `${RUNTIME}/workloaddeployments/identity/scale`, { spec: { replicas: 0 } }],
      [
        'DELETE',
        '/apis/batch/v1/namespaces/di-runtime-alpha/jobs/di-volume-identity-1?propagationPolicy=Background',
      ],
    ]);
  });

  test('creates the ledger on the first hold, then patches it under its version', async () => {
    let version = 40;
    const { calls, api } = recorder(() => {
      version += 1;
      return { metadata: { resourceVersion: String(version) } };
    });
    const entry = { replicas: 2, heldBy: 'Backup/b', since: NOW };
    await applyActions(api, volumeWorld({ ledger: { entries: {} } }), [
      { type: 'ledger', set: { identity: entry, other: null } },
      { type: 'ledger', set: { identity: null } },
    ]);
    expect(calls).toEqual([
      [
        'POST',
        '/api/v1/namespaces/di-tenant-alpha/configmaps',
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: LEDGER,
            namespace: 'di-tenant-alpha',
            labels: { 'platform.di-framework.dev/component': 'backup-operator' },
          },
          data: { identity: JSON.stringify(entry) },
        },
      ],
      [
        'PATCH',
        `/api/v1/namespaces/di-tenant-alpha/configmaps/${LEDGER}`,
        { metadata: { resourceVersion: '41' }, data: { identity: null } },
      ],
    ]);
    // Only removals on a ledger that does not exist: nothing to write.
    calls.length = 0;
    await applyActions(api, volumeWorld(), [{ type: 'ledger', set: { identity: null } }]);
    expect(calls).toEqual([]);
    await applyActions(api, volumeWorld(), [
      { type: 'ledger', set: { identity: null }, resourceVersion: '9' },
    ]);
    expect(calls[0]?.[2]).toEqual({ metadata: { resourceVersion: '9' }, data: { identity: null } });
  });
});

describe('leader election and single flight', () => {
  const lease = (spec: Record<string, unknown>, resourceVersion = '3') => ({
    metadata: { resourceVersion },
    spec,
  });
  const leaseClient = (
    current: unknown,
    write: (method: string, body: unknown) => unknown = () => ({}),
  ) => {
    const writes: [string, unknown][] = [];
    const api: KubeClient = {
      async get() {
        if (current instanceof Error) throw current;
        return current;
      },
      async post(_path, body) {
        writes.push(['POST', body]);
        return write('POST', body);
      },
      async patch(_path, body) {
        writes.push(['PATCH', body]);
        return write('PATCH', body);
      },
      async remove() {},
    };
    return { api, writes };
  };
  const now = new Date(NOW);

  test('creates, renews, waits for, and takes over the Lease', async () => {
    expect(microTime(now)).toBe('2026-10-13T03:30:00.000000Z');
    const absent = leaseClient(new KubeError(404, 'none'));
    expect(await acquireLease(absent.api, 'ns', 'me', now)).toBe(true);
    expect(absent.writes[0]?.[1]).toMatchObject({
      metadata: { name: 'di-backup-operator', namespace: 'ns' },
      spec: { holderIdentity: 'me', leaseDurationSeconds: LEASE_SECONDS, leaseTransitions: 0 },
    });
    const raced = leaseClient(new KubeError(404, 'none'), () => {
      throw new KubeError(409, 'exists');
    });
    expect(await acquireLease(raced.api, 'ns', 'me', now)).toBe(false);
    expect(await acquireLease(leaseClient(new KubeError(500, 'down')).api, 'ns', 'me', now)).toBe(
      false,
    );

    const renewTime = microTime(new Date(now.getTime() - 5000));
    const mine = leaseClient(lease({ holderIdentity: 'me', renewTime, leaseDurationSeconds: 15 }));
    expect(await acquireLease(mine.api, 'ns', 'me', now)).toBe(true);
    expect(mine.writes[0]?.[1]).toEqual({
      metadata: { resourceVersion: '3' },
      spec: { renewTime: microTime(now), leaseDurationSeconds: LEASE_SECONDS },
    });
    const theirs = leaseClient(
      lease({ holderIdentity: 'other', renewTime, leaseDurationSeconds: 15 }),
    );
    expect(await acquireLease(theirs.api, 'ns', 'me', now)).toBe(false);
    expect(theirs.writes).toEqual([]);

    const expired = leaseClient(
      lease({
        holderIdentity: 'other',
        renewTime: microTime(new Date(now.getTime() - 16_000)),
        leaseDurationSeconds: 15,
        leaseTransitions: 4,
      }),
    );
    expect(await acquireLease(expired.api, 'ns', 'me', now)).toBe(true);
    expect(expired.writes[0]?.[1]).toMatchObject({
      metadata: { resourceVersion: '3' },
      spec: { holderIdentity: 'me', leaseTransitions: 5 },
    });
    // Two candidates take over the same expired Lease: the second write conflicts.
    const lost = leaseClient(lease({ holderIdentity: '', renewTime: 'garbage' }), () => {
      throw new KubeError(409, 'conflict');
    });
    expect(await acquireLease(lost.api, 'ns', 'me', now)).toBe(false);
    const released = leaseClient(lease({}));
    expect(await acquireLease(released.api, 'ns', 'me', now)).toBe(true);
  });

  test('releases only its own Lease, best effort', async () => {
    const mine = leaseClient(lease({ holderIdentity: 'me' }));
    await releaseLease(mine.api, 'ns', 'me');
    expect(mine.writes).toEqual([
      [
        'PATCH',
        { metadata: { resourceVersion: '3' }, spec: { holderIdentity: null, renewTime: null } },
      ],
    ]);
    const theirs = leaseClient(lease({ holderIdentity: 'other' }));
    await releaseLease(theirs.api, 'ns', 'me');
    expect(theirs.writes).toEqual([]);
    await releaseLease(leaseClient(new KubeError(500, 'down')).api, 'ns', 'me');
  });

  test('a tick never overlaps the previous one, and only the leader reconciles', async () => {
    let release: () => void = () => undefined;
    let runs = 0;
    const tick = singleFlight(async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = tick();
    expect(await tick()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(runs).toBe(1);
    const failing = singleFlight(async () => {
      throw new Error('boom');
    });
    await expect(failing()).rejects.toThrow('boom');
    await expect(failing()).rejects.toThrow('boom');

    let reconciled = 0;
    const follower = leaderTick({
      client: leaseClient(lease({ holderIdentity: 'other', renewTime: microTime(now) })).api,
      namespace: 'ns',
      identity: 'me',
      clock: () => now,
      reconcile: async () => {
        reconciled += 1;
      },
    });
    await follower();
    expect(reconciled).toBe(0);
    const leader = leaderTick({
      client: leaseClient(new KubeError(404, 'none')).api,
      namespace: 'ns',
      identity: 'me',
      reconcile: async () => {
        reconciled += 1;
      },
    });
    await leader();
    expect(reconciled).toBe(1);
  });

  test('names and status helpers', () => {
    expect(opJobName('di-vcopy', 'di-volume-identity-1760326200')).toBe(
      'di-vcopy-di-volume-identity-1760326200',
    );
    const long = opJobName('di-vrestore', `restore-volume-${'a'.repeat(60)}`);
    expect(long.length).toBe(63);
    expect(long).toMatch(/^di-vrestore-restore-volume-a+-[0-9a-f]{8}$/);
    expect(statusOf(new KubeError(404, 'x'))).toBe(404);
    expect(statusOf(new Error('x'))).toBeUndefined();
    expect(statusOf(undefined)).toBeUndefined();
  });
});
