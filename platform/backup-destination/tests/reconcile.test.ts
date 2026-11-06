import { describe, expect, test } from 'bun:test';
import { handle } from '../src/console.ts';
import { type Action, BACKUP_NOW, type ServiceView, type World } from '../src/model.ts';
import { reconcile } from '../src/reconcile.ts';
import {
  Cluster,
  IMAGE,
  NOW,
  pvcDestination,
  TENANT_UID,
  VOLUME,
  volumeWorld,
  workload,
} from './support/cluster.ts';

const OK = {
  ok: true,
  digest: `sha256:${'cd'.repeat(32)}`,
  bytes: 4096,
  objectKey: 'di-framework/alpha/workload-volumes/pgprove-app/uid-app1/20261013T033006Z/data.tar',
  fileCount: 1700,
  encfsKcv: '00112233445566778899aabbccddeeff',
  encfsMode: 'XTS',
  imageDigest: `sha256:${'ab'.repeat(32)}`,
};

const orders: ServiceView = {
  name: 'orders',
  uid: 'uid-orders',
  type: 'postgres',
  className: 'postgres-dedicated',
  storage: '1Gi',
  memory: '512Mi',
  cpu: '250m',
  ready: true,
  suspended: false,
  deleting: false,
};

function createdBackups(actions: Action[]): string[] {
  return actions.flatMap((action) =>
    action.type === 'create-backup'
      ? [String((action.body.metadata as { name?: string }).name)]
      : [],
  );
}

function statusFrom(actions: Action[]) {
  const found = actions.find((action) => action.type === 'destination-status');
  return found?.type === 'destination-status' ? found.status : undefined;
}

describe('#657: backup-now annotation across workload-volume and BackingService sources', () => {
  test('triggers on-demand Backups for every enrolled workload-volume source on a destination with no BackingServices', () => {
    const app1 = workload({ name: 'pgprove-app', uid: 'uid-app1' });
    const app2 = workload({ name: 'pgprove-app2', uid: 'uid-app2' });
    const dest = {
      ...pvcDestination({
        schedule: 'none',
        sources: [
          { kind: 'workload-volume', workloadName: 'pgprove-app', schedule: 'none' },
          { kind: 'workload-volume', workloadName: 'pgprove-app2', schedule: 'none' },
          {
            kind: 'workload-volume',
            workloadName: 'suspended-app',
            schedule: 'none',
            suspend: true,
          },
        ],
      }),
      status: {},
      annotations: { [BACKUP_NOW]: '2026-10-13T03:29:55.000Z' },
    };
    const w = volumeWorld({
      destination: dest,
      destinations: [dest],
      workloads: [app1, app2],
    });
    const actions = reconcile(w);

    expect(createdBackups(actions)).toEqual([
      `di-volume-pgprove-app-${Date.parse(NOW) / 1000}`,
      `di-volume-pgprove-app2-${Date.parse(NOW) / 1000}`,
    ]);
    expect(actions).toContainEqual({
      type: 'clear-annotation',
      name: 'pvc',
      key: BACKUP_NOW,
    });
    expect(statusFrom(actions)?.lastAttemptTime).toBe(NOW);
  });

  test('console destination-level Backup now runs an end-to-end cold copy of a workload-volume source', () => {
    const appPath = `/var/lib/kubesolo/di-tenants/${TENANT_UID}/workloads/pgprove-app`;
    const dest = {
      ...pvcDestination({
        schedule: 'none',
        sources: [{ kind: 'workload-volume', workloadName: 'pgprove-app', schedule: 'none' }],
      }),
      status: {},
    };
    const cluster = new Cluster(
      volumeWorld({
        destination: dest,
        destinations: [dest],
        workloads: [workload({ name: 'pgprove-app', uid: 'uid-app1', image: IMAGE })],
        hosts: [
          { name: 'hostgroup-tenant-alpha-0', node: 'node-a', ready: true, hostPaths: [appPath] },
        ],
      }),
    );

    const posted = handle('POST', '/backups', 'destination=pvc', cluster.world);
    expect(posted.status).toBe(200);
    cluster.apply(posted.actions);
    expect(cluster.destination()?.annotations[BACKUP_NOW]).toBe(NOW);

    // Tick 1: consumes backup-now and creates the Backup object.
    const tick1 = cluster.tick();
    expect(createdBackups(tick1)).toHaveLength(1);
    expect(cluster.destination()?.annotations[BACKUP_NOW]).toBeUndefined();
    expect(cluster.world.backups).toHaveLength(1);

    // Subsequent ticks place, scale down, copy, and restore replicas.
    cluster.tick();
    cluster.tick();
    expect(cluster.replicas('pgprove-app')).toBe(0);
    cluster.instances('pgprove-app', 0);
    cluster.tick();
    cluster.finishJob('Succeeded', OK);
    cluster.tick();
    expect(cluster.backup()?.phase).toBe('Succeeded');
    expect(cluster.replicas('pgprove-app')).toBe(2);
  });

  test('avoids duplicate workload-volume Backups when Pending, Running, scheduled on the same tick, or already created for the request', () => {
    const dest = {
      ...pvcDestination({
        schedule: 'none',
        sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule: 'none' }],
      }),
      status: {},
      annotations: { [BACKUP_NOW]: '2026-10-13T03:29:55.000Z' },
    };

    // 1. Already Pending (phase undefined).
    const pendingActions = reconcile(
      volumeWorld({
        destination: dest,
        destinations: [dest],
        backups: [
          {
            name: 'di-volume-identity-pending',
            serviceName: 'identity',
            destinationName: 'pvc',
            uid: 'uid-identity',
            type: 'workload-volume',
            className: '',
            storage: '1Gi',
            createdAt: '2026-10-13T03:29:50.000Z',
            source: { kind: 'workload-volume', workloadName: 'identity' },
          },
        ],
      }),
    );
    expect(createdBackups(pendingActions)).toEqual([]);
    expect(pendingActions).toContainEqual({
      type: 'clear-annotation',
      name: 'pvc',
      key: BACKUP_NOW,
    });

    // 2. Already created for this backup-now request (by createdAt > forced or matching name), even if Succeeded.
    const alreadyCreated = reconcile(
      volumeWorld({
        destination: dest,
        destinations: [dest],
        backups: [
          {
            name: 'di-volume-identity-done',
            serviceName: 'identity',
            destinationName: 'pvc',
            uid: 'uid-identity',
            type: 'workload-volume',
            className: '',
            storage: '1Gi',
            createdAt: '2026-10-13T03:29:58.000Z',
            phase: 'Succeeded',
            source: { kind: 'workload-volume', workloadName: 'identity' },
          },
        ],
      }),
    );
    expect(createdBackups(alreadyCreated)).toEqual([]);

    // 3. Scheduled cron for the source fires on the same tick as backup-now: only one Backup is created.
    const scheduledDest = {
      ...pvcDestination({
        schedule: 'none',
        sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule: '30 3 * * *' }],
      }),
      status: {
        sources: [
          {
            kind: 'workload-volume' as const,
            workloadName: 'identity',
            schedule: '30 3 * * *',
            scheduleStatus: 'Armed' as const,
            lastScheduledTime: '2026-10-13T03:00:00.000Z',
          },
        ],
      },
      annotations: { [BACKUP_NOW]: NOW },
    };
    const bothDue = reconcile(
      volumeWorld({ destination: scheduledDest, destinations: [scheduledDest] }),
    );
    expect(createdBackups(bothDue)).toHaveLength(1);

    // 4. Stale annotation where lastAttemptTime > forced or lastAttemptTime === forced with attempt recorded.
    const stale = reconcile(
      volumeWorld({
        destination: {
          ...dest,
          status: {
            lastAttemptTime: '2026-10-13T03:30:00.000Z',
            services: [
              { name: 'orders', type: 'postgres', lastAttemptTime: '2026-10-13T03:30:00.000Z' },
            ],
          },
          annotations: { [BACKUP_NOW]: '2026-10-13T03:29:00.000Z' },
        },
        services: [orders],
      }),
    );
    expect(createdBackups(stale)).toEqual([`di-volume-identity-${Date.parse(NOW) / 1000}`]);
    expect(stale).toContainEqual({ type: 'clear-annotation', name: 'pvc', key: BACKUP_NOW });

    const exactSameStamp = reconcile(
      volumeWorld({
        destination: {
          ...dest,
          status: {
            lastAttemptTime: NOW,
            services: [{ name: 'orders', type: 'postgres', lastAttemptTime: NOW }],
          },
          annotations: { [BACKUP_NOW]: NOW },
        },
        services: [orders],
        backups: [
          {
            name: `di-volume-identity-${Date.parse(NOW) / 1000}`,
            serviceName: 'identity',
            destinationName: 'pvc',
            uid: 'uid-identity',
            type: 'workload-volume',
            className: '',
            storage: '1Gi',
            createdAt: NOW,
            phase: 'Succeeded',
            source: { kind: 'workload-volume', workloadName: 'identity' },
          },
        ],
      }),
    );
    expect(createdBackups(exactSameStamp)).toEqual([]);

    // 5. Non-ISO backup-now value (e.g. "true"): triggers when lastAttemptTime !== now, skips when already attempted at now.
    const tokenDest = {
      ...dest,
      status: { lastAttemptTime: '2026-10-13T02:00:00.000Z' },
      annotations: { [BACKUP_NOW]: 'true' },
    };
    expect(
      createdBackups(
        reconcile(
          volumeWorld({
            destination: tokenDest,
            destinations: [tokenDest],
            services: [orders],
          }),
        ),
      ),
    ).toEqual([
      `di-volume-identity-${Date.parse(NOW) / 1000}`,
      `di-backup-orders-${Date.parse(NOW) / 1000}`,
    ]);

    const tokenAlreadyAttempted = {
      ...dest,
      status: {
        lastAttemptTime: NOW,
        services: [{ name: 'orders', type: 'postgres', lastAttemptTime: NOW }],
      },
      annotations: { [BACKUP_NOW]: 'true' },
    };
    expect(
      createdBackups(
        reconcile(
          volumeWorld({
            destination: tokenAlreadyAttempted,
            destinations: [tokenAlreadyAttempted],
            services: [orders],
            backups: [
              {
                name: `di-volume-identity-${Date.parse(NOW) / 1000}`,
                serviceName: 'identity',
                destinationName: 'pvc',
                uid: 'uid-identity',
                type: 'workload-volume',
                className: '',
                storage: '1Gi',
                createdAt: NOW,
                phase: 'Succeeded',
                source: { kind: 'workload-volume', workloadName: 'identity' },
              },
            ],
          }),
        ),
      ),
    ).toEqual([]);
  });

  test('keeps backup-now pending and does not advance lastAttemptTime when workload-volume state read fails', () => {
    const dest = {
      ...pvcDestination({
        schedule: 'none',
        sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule: 'none' }],
      }),
      status: { lastAttemptTime: '2026-10-13T01:00:00.000Z' },
      annotations: { [BACKUP_NOW]: '2026-10-13T03:29:55.000Z' },
    };

    // Transient failure via unknown workloads/ledger, missing storageRecords, or explicit volumes: undefined.
    const unknownWorkloads = reconcile(
      volumeWorld({
        destination: dest,
        destinations: [dest],
        workloads: undefined,
        ledger: undefined,
      }),
    );
    expect(unknownWorkloads.some((action) => action.type === 'clear-annotation')).toBe(false);
    expect(createdBackups(unknownWorkloads)).toEqual([]);
    expect(statusFrom(unknownWorkloads)?.lastAttemptTime).toBe('2026-10-13T01:00:00.000Z');

    const missingRecords = reconcile(
      volumeWorld({
        destination: dest,
        destinations: [dest],
        storageRecords: undefined,
      }),
    );
    expect(missingRecords.some((action) => action.type === 'clear-annotation')).toBe(false);
    expect(statusFrom(missingRecords)?.lastAttemptTime).toBe('2026-10-13T01:00:00.000Z');

    const explicitVolumesUndefined = reconcile({
      ...volumeWorld({ destination: dest, destinations: [dest] }),
      volumes: undefined,
    } as World);
    expect(explicitVolumesUndefined.some((action) => action.type === 'clear-annotation')).toBe(
      false,
    );
    expect(statusFrom(explicitVolumesUndefined)?.lastAttemptTime).toBe('2026-10-13T01:00:00.000Z');

    // On the next tick when volume state is read, the kept backup-now annotation triggers the backup.
    const cluster = new Cluster(volumeWorld({ destination: dest, destinations: [dest] }));
    cluster.tick(3, { unknown: true });
    expect(cluster.destination()?.annotations[BACKUP_NOW]).toBe('2026-10-13T03:29:55.000Z');
    expect(cluster.world.backups).toEqual([]);

    const recovered = cluster.tick();
    expect(createdBackups(recovered)).toHaveLength(1);
    expect(cluster.destination()?.annotations[BACKUP_NOW]).toBeUndefined();
    expect(cluster.destination()?.status.lastAttemptTime).toBe(cluster.world.now);
  });

  test('consumes backup-now without advancing lastAttemptTime when the destination has no ready services and no enrolled volume sources', () => {
    const emptyDest = {
      ...pvcDestination({ schedule: 'none', sources: [] }),
      status: { lastAttemptTime: '2026-10-13T01:00:00.000Z' },
      annotations: { [BACKUP_NOW]: '2026-10-13T03:29:55.000Z' },
    };
    const emptyActions = reconcile(
      volumeWorld({
        destination: emptyDest,
        destinations: [emptyDest],
        services: [],
      }),
    );
    expect(emptyActions).toContainEqual({
      type: 'clear-annotation',
      name: 'pvc',
      key: BACKUP_NOW,
    });
    expect(createdBackups(emptyActions)).toEqual([]);
    expect(statusFrom(emptyActions)?.lastAttemptTime).toBe('2026-10-13T01:00:00.000Z');

    // Also when services exist but none are ready/eligible (unready, suspended, deleting, oversized).
    const unreadyActions = reconcile(
      volumeWorld({
        destination: { ...emptyDest, status: {} },
        destinations: [{ ...emptyDest, status: {} }],
        services: [
          { ...orders, name: 'cold', ready: false },
          { ...orders, name: 'paused', suspended: true },
          { ...orders, name: 'gone', deleting: true },
          { ...orders, name: 'huge', storage: '5Gi' },
        ],
      }),
    );
    expect(unreadyActions).toContainEqual({
      type: 'clear-annotation',
      name: 'pvc',
      key: BACKUP_NOW,
    });
    expect(createdBackups(unreadyActions)).toEqual([]);
    expect(statusFrom(unreadyActions)?.lastAttemptTime).toBeUndefined();
  });

  test('triggers both BackingService dump and workload-volume Backup when both source kinds are enrolled', () => {
    const dest = {
      ...pvcDestination({
        schedule: 'none',
        sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule: 'none' }],
      }),
      status: {},
      annotations: { [BACKUP_NOW]: NOW },
    };
    const actions = reconcile(
      volumeWorld({
        destination: dest,
        destinations: [dest],
        services: [{ ...orders, storage: 'unparseable' }],
        hosts: [
          { name: 'hostgroup-tenant-alpha-0', node: 'node-a', ready: true, hostPaths: [VOLUME] },
        ],
      }),
    );
    expect(createdBackups(actions)).toEqual([
      `di-volume-identity-${Date.parse(NOW) / 1000}`,
      `di-backup-orders-${Date.parse(NOW) / 1000}`,
    ]);
    expect(actions).toContainEqual({
      type: 'clear-annotation',
      name: 'pvc',
      key: BACKUP_NOW,
    });
    expect(statusFrom(actions)?.lastAttemptTime).toBe(NOW);
  });

  test('does not block BackingService on-demand or cron dumps when volume state is unreadable while backup-now is held', () => {
    const dest = {
      ...pvcDestination({
        schedule: '30 3 * * *',
        sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule: 'none' }],
      }),
      status: { lastAttemptTime: '2026-10-13T01:00:00.000Z' },
      annotations: { [BACKUP_NOW]: '2026-10-13T03:29:55.000Z' },
    };

    // Tick 1: volume state is unreadable (`volumes: undefined` / missing RBAC).
    // BackingService dump still runs and advances lastAttemptTime, while backup-now is held for the volume.
    const tick1World = {
      ...volumeWorld({
        destination: dest,
        destinations: [dest],
        services: [orders],
        workloads: undefined,
        ledger: undefined,
      }),
      volumes: undefined,
    } as World;
    const tick1 = reconcile(tick1World);
    expect(createdBackups(tick1)).toEqual([`di-backup-orders-${Date.parse(NOW) / 1000}`]);
    expect(tick1.some((action) => action.type === 'clear-annotation')).toBe(false);
    const status1 = statusFrom(tick1);
    expect(status1?.lastAttemptTime).toBe(NOW);

    // Tick 1b: if volume state remains unreadable on subsequent tick after the service dump finished,
    // the service is not re-dumped for the same backup-now, and backup-now remains held.
    const afterDumpDest = {
      ...dest,
      status: {
        ...status1,
        services: [
          {
            name: 'orders',
            type: 'postgres',
            lastAttemptTime: NOW,
            lastBackupName: `di-backup-orders-${Date.parse(NOW) / 1000}`,
            lastReason: 'Completed',
            lastSuccessTime: NOW,
          },
        ],
      },
    };
    const tick1b = reconcile({
      ...volumeWorld({
        destination: afterDumpDest,
        destinations: [afterDumpDest],
        services: [orders],
        workloads: undefined,
        ledger: undefined,
      }),
      volumes: undefined,
    } as World);
    expect(createdBackups(tick1b)).toEqual([]);
    expect(tick1b.some((action) => action.type === 'clear-annotation')).toBe(false);

    // Scheduled cron dumps also continue to run when due even while backup-now is held by missing volume RBAC.
    const nextCronNow = '2026-10-14T03:30:05.000Z';
    const cronWhileHeld = reconcile({
      ...volumeWorld({
        now: nextCronNow,
        destination: afterDumpDest,
        destinations: [afterDumpDest],
        services: [orders],
        workloads: undefined,
        ledger: undefined,
      }),
      volumes: undefined,
    } as World);
    expect(createdBackups(cronWhileHeld)).toEqual([
      `di-backup-orders-${Date.parse(nextCronNow) / 1000}`,
    ]);
    expect(cronWhileHeld.some((action) => action.type === 'clear-annotation')).toBe(false);

    // Tick 2: when volume state becomes readable, the held backup-now creates the workload-volume Backup
    // without re-dumping the BackingService, and clears backup-now.
    const tick2Now = '2026-10-13T03:30:10.000Z';
    const tick2 = reconcile(
      volumeWorld({
        now: tick2Now,
        destination: afterDumpDest,
        destinations: [afterDumpDest],
        services: [orders],
      }),
    );
    expect(createdBackups(tick2)).toEqual([`di-volume-identity-${Date.parse(tick2Now) / 1000}`]);
    expect(tick2).toContainEqual({
      type: 'clear-annotation',
      name: 'pvc',
      key: BACKUP_NOW,
    });
    expect(statusFrom(tick2)?.lastAttemptTime).toBe(tick2Now);
  });
});
