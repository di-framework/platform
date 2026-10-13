import { describe, expect, test } from 'bun:test';
import {
  storageKey as platformKey,
  nodeStoragePath as platformPath,
} from '../../platform/src/tenancy/workload-storage.ts';
import { handle, render } from '../src/console.ts';
import {
  type Action,
  type BackupView,
  storageKeyOf,
  volumePath,
  type WorkloadView,
} from '../src/model.ts';
import { reconcile, reconcileAll } from '../src/reconcile.ts';
import {
  backupKeys,
  expiredVolumeBackups,
  requestBackup,
  resolveVolume,
  startRestore,
} from '../src/workload.ts';
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
  objectKey: 'di-framework/alpha/workload-volumes/identity/uid-identity/20261013T033003Z/data.tar',
  fileCount: 1767,
  encfsKcv: '00112233445566778899aabbccddeeff',
  imageDigest: `sha256:${'ab'.repeat(32)}`,
};

/** A cluster with one requested on-demand backup of `identity`. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

function requested(overrides: Parameters<typeof volumeWorld>[0] = {}): Cluster {
  const cluster = new Cluster(volumeWorld(overrides));
  const world = cluster.world;
  cluster.apply([requestBackup(world, must(world.destination), 'identity')]);
  return cluster;
}

function job(actions: Action[]): Record<string, unknown> {
  const created = actions.find((action) => action.type === 'create-job');
  if (created?.type !== 'create-job') throw new Error('no Job created');
  return created.body;
}

describe('cold copy of a workload volume', () => {
  test('records replicas, scales to 0, waits, copies on the volume node, and gives the replicas back', () => {
    const cluster = requested();
    const start = cluster.tick();
    // The replicas are on record before the workload is scaled.
    expect(cluster.types(start).slice(0, 2)).toEqual(['backup-status', 'scale-workload']);
    expect(start[0]).toMatchObject({
      type: 'backup-status',
      status: {
        phase: 'Running',
        reason: 'ScalingDown',
        volume: {
          stage: 'ScalingDown',
          members: [{ name: 'identity', replicas: 2 }],
          node: 'node-a',
          hostPath: VOLUME,
          storageKey: 'identity',
          image: IMAGE,
        },
      },
    });
    expect(start[1]).toEqual({ type: 'scale-workload', name: 'identity', replicas: 0 });
    expect(cluster.replicas()).toBe(0);

    // Instances still running: nothing new happens.
    expect(cluster.tick().some((action) => action.type === 'create-job')).toBe(false);
    cluster.instances('identity', 0);
    const copy = cluster.tick();
    const body = job(copy);
    const text = JSON.stringify(body);
    expect(text).toContain('"platform.di-framework.dev/backup-kind":"volume-copy"');
    expect(text).toContain(
      '"matchFields":[{"key":"metadata.name","operator":"In","values":["node-a"]}]',
    );
    expect(text).toContain(`{"name":"source","hostPath":{"path":"${VOLUME}","type":"Directory"}}`);
    expect(text).toContain('{"name":"source","mountPath":"/source","readOnly":true}');
    expect(text).toContain('"add":["DAC_READ_SEARCH"]');
    expect(text).toContain('"backoffLimit":0');
    expect(text).toContain('"activeDeadlineSeconds":3600');
    expect(text).toContain(`{"name":"BACKUP_SOURCE_IMAGE","value":"${IMAGE}"}`);
    expect(text).toContain('{"name":"BACKUP_KIND","value":"workload-volume"}');
    expect(text).toContain('"claimName":"claim"');
    // No Secret: not the workload's, and a PVC destination has no credentials.
    expect(text).not.toContain('secretKeyRef');
    expect(text).not.toContain('secretRef');
    expect(cluster.backup()?.volume?.stage).toBe('Copying');

    expect(cluster.tick(30)).toEqual([expect.objectContaining({ type: 'destination-status' })]);
    cluster.finishJob('Succeeded', OK);
    const done = cluster.tick();
    expect(cluster.types(done).slice(0, 2)).toEqual(['scale-workload', 'backup-status']);
    expect(done[0]).toEqual({ type: 'scale-workload', name: 'identity', replicas: 2 });
    expect(cluster.replicas()).toBe(2);
    const backup = cluster.backup();
    expect(backup).toMatchObject({
      phase: 'Succeeded',
      objectKey: OK.objectKey,
      digest: OK.digest,
      volume: {
        stage: 'Done',
        fileCount: 1767,
        encfsKcv: OK.encfsKcv,
        imageDigest: OK.imageDigest,
        scaleDownSeconds: 39,
      },
    });
    // The duration shows on the destination status and in the console.
    cluster.tick();
    const row = cluster.destination()?.status.sources?.[0];
    expect(row).toMatchObject({
      workloadName: 'identity',
      lastReason: 'Completed',
      lastScaleDownSeconds: 39,
      lastBackupName: backup?.name,
    });
    const html = render(cluster.world);
    expect(html).toContain('last scale-to-0 39s');
    expect(html).toContain('scale-to-0 39s');
  });

  test('gives the replicas back when the copy fails', () => {
    const cluster = requested();
    cluster.tick();
    cluster.instances('identity', 0);
    cluster.tick();
    cluster.finishJob('Failed', { ok: false, error: 'SourceChanged' });
    const done = cluster.tick();
    expect(done[0]).toEqual({ type: 'scale-workload', name: 'identity', replicas: 2 });
    expect(cluster.backup()).toMatchObject({ phase: 'Failed', reason: 'SourceChanged' });
    expect(cluster.replicas()).toBe(2);

    const silent = requested();
    silent.tick();
    silent.instances('identity', 0);
    silent.tick();
    silent.finishJob('Failed');
    silent.tick();
    expect(silent.backup()).toMatchObject({ phase: 'Failed', reason: 'CopyFailed' });
    expect(silent.replicas()).toBe(2);

    const odd = requested();
    odd.tick();
    odd.instances('identity', 0);
    odd.tick();
    odd.world = {
      ...odd.world,
      jobs: odd.world.jobs.map((item) => ({ ...item, phase: 'Succeeded', message: 'not json' })),
    };
    odd.tick();
    expect(odd.backup()).toMatchObject({ phase: 'Failed', reason: 'CopyFailed' });
    expect(odd.replicas()).toBe(2);
  });

  test('gives the replicas back when instances do not stop in time', () => {
    const cluster = requested({
      destination: pvcDestination({
        sources: [
          { kind: 'workload-volume', workloadName: 'identity', scaleDownTimeoutSeconds: 60 },
        ],
      }),
    });
    cluster.tick();
    expect(cluster.tick(59)).not.toContainEqual(
      expect.objectContaining({ type: 'scale-workload' }),
    );
    const timedOut = cluster.tick(5);
    expect(timedOut[0]).toEqual({ type: 'scale-workload', name: 'identity', replicas: 2 });
    expect(cluster.backup()).toMatchObject({
      phase: 'Failed',
      reason: 'ScaleDownTimeout',
      message: '2 instance(s) still running after 60s',
    });
    expect(cluster.world.jobs).toEqual([]);
    expect(cluster.replicas()).toBe(2);
  });

  test('gives the replicas back when the copy times out, hangs, or its Job disappears', () => {
    const deadline = requested();
    deadline.tick();
    deadline.instances('identity', 0);
    deadline.tick();
    deadline.finishJob('Failed', undefined, 'DeadlineExceeded');
    deadline.tick();
    expect(deadline.backup()).toMatchObject({ phase: 'Failed', reason: 'CopyTimeout' });
    expect(deadline.replicas()).toBe(2);

    const hung = requested({
      destination: pvcDestination({
        sources: [{ kind: 'workload-volume', workloadName: 'identity', copyTimeoutSeconds: 600 }],
      }),
    });
    hung.tick();
    hung.instances('identity', 0);
    hung.tick();
    expect(hung.tick(600)).not.toContainEqual(expect.objectContaining({ type: 'scale-workload' }));
    const stuck = hung.tick(200);
    expect(hung.types(stuck).slice(0, 3)).toEqual([
      'delete-job',
      'scale-workload',
      'backup-status',
    ]);
    expect(hung.backup()).toMatchObject({ phase: 'Failed', reason: 'CopyTimeout' });
    expect(hung.replicas()).toBe(2);

    const vanished = requested();
    vanished.tick();
    vanished.instances('identity', 0);
    vanished.tick();
    vanished.world = { ...vanished.world, jobs: [] };
    expect(vanished.tick(60)).not.toContainEqual(
      expect.objectContaining({ type: 'scale-workload' }),
    );
    vanished.tick(90);
    expect(vanished.backup()).toMatchObject({ phase: 'Failed', reason: 'JobMissing' });
    expect(vanished.replicas()).toBe(2);
  });

  test('stops and restores every workload that shares the volume, and skips one that is gone', () => {
    const member = workload({
      name: 'identity-worker',
      uid: 'uid-worker',
      replicas: 1,
      instances: 1,
      labels: { 'di-framework.dev/workload': 'identity' },
    });
    const unrelated = workload({ name: 'web', uid: 'uid-web', annotations: {} });
    const cluster = requested({ workloads: [workload(), member, unrelated] });
    const start = cluster.tick();
    expect(start.filter((action) => action.type === 'scale-workload')).toEqual([
      { type: 'scale-workload', name: 'identity', replicas: 0 },
      { type: 'scale-workload', name: 'identity-worker', replicas: 0 },
    ]);
    cluster.instances('identity', 0);
    expect(cluster.tick().some((action) => action.type === 'create-job')).toBe(false);
    cluster.instances('identity-worker', 0);
    cluster.tick();
    cluster.world = {
      ...cluster.world,
      workloads: cluster.world.workloads?.filter((item) => item.name !== 'identity-worker'),
    };
    cluster.finishJob('Succeeded', OK);
    const done = cluster.tick();
    expect(done.filter((action) => action.type === 'scale-workload')).toEqual([
      { type: 'scale-workload', name: 'identity', replicas: 2 },
    ]);
    expect(cluster.replicas('web')).toBe(2);
  });

  test('fails when someone raises the replicas mid-way, and still restores the recorded ones', () => {
    const early = requested();
    early.tick();
    early.apply([{ type: 'scale-workload', name: 'identity', replicas: 3 }]);
    early.tick();
    expect(early.backup()).toMatchObject({ phase: 'Failed', reason: 'ScaleDownInterrupted' });
    expect(early.replicas()).toBe(2);

    const late = requested();
    late.tick();
    late.instances('identity', 0);
    late.tick();
    late.apply([{ type: 'scale-workload', name: 'identity', replicas: 1 }]);
    late.finishJob('Succeeded', OK);
    late.tick();
    expect(late.backup()).toMatchObject({
      phase: 'Failed',
      reason: 'ScaledDuringCopy',
      objectKey: OK.objectKey,
    });
    expect(late.replicas()).toBe(2);
  });

  test('does not scale anything it cannot copy', () => {
    const cases: [Parameters<typeof volumeWorld>[0], string][] = [
      [{ workloads: [] }, 'WorkloadNotFound'],
      [{ workloads: [workload({ deleting: true })] }, 'WorkloadDeleting'],
      [{ workloads: [workload({ annotations: {} })] }, 'NoStorage'],
      [{ tenantUid: undefined }, 'TenantUnknown'],
      [{ storageRoot: '/var/lib/k0s' }, 'VolumeNotMounted'],
      [
        { hosts: [{ name: 'h', node: 'node-a', ready: false, hostPaths: [VOLUME] }] },
        'VolumeNotMounted',
      ],
    ];
    for (const [overrides, reason] of cases) {
      const cluster = requested(overrides);
      const actions = cluster.tick();
      expect(actions.some((action) => action.type === 'scale-workload')).toBe(false);
      expect(cluster.backup()).toMatchObject({ phase: 'Failed', reason });
    }
  });

  test('a destination that becomes unusable or disappears still gives the replicas back', () => {
    const suspended = requested();
    suspended.tick();
    const dest = must(suspended.destination());
    const off = { ...dest, spec: { ...dest.spec, suspend: true } };
    suspended.world = { ...suspended.world, destination: off, destinations: [off] };
    suspended.tick();
    expect(suspended.backup()).toMatchObject({ phase: 'Failed', reason: 'TenantSuspended' });
    expect(suspended.replicas()).toBe(2);

    const gone = requested();
    gone.tick();
    gone.world = { ...gone.world, destination: undefined, destinations: [] };
    gone.tick();
    expect(gone.backup()).toMatchObject({ phase: 'Failed', reason: 'DestinationGone' });
    expect(gone.replicas()).toBe(2);

    // A copy already running when its destination goes finishes first.
    const copying = requested();
    copying.tick();
    copying.instances('identity', 0);
    copying.tick();
    copying.world = { ...copying.world, destination: undefined, destinations: [] };
    expect(copying.tick()).toEqual([]);
    copying.finishJob('Succeeded', OK);
    copying.tick();
    expect(copying.backup()?.phase).toBe('Succeeded');
    expect(copying.replicas()).toBe(2);
  });

  test('works with an S3 destination', () => {
    const s3 = {
      name: 'default',
      generation: 1,
      annotations: {},
      spec: {
        type: 's3' as const,
        bucket: 'tenant-alpha-backups',
        credentialsSecretRef: { name: 'di-backup-s3' },
        prefix: 'backups/alpha',
        sources: [{ kind: 'workload-volume' as const, workloadName: 'identity' }],
      },
      status: { lastAttemptTime: NOW },
    };
    const cluster = requested({ destination: s3, destinations: [s3] });
    cluster.tick();
    cluster.instances('identity', 0);
    const text = JSON.stringify(job(cluster.tick()));
    expect(text).toContain('{"name":"BACKUP_DESTINATION_TYPE","value":"s3"}');
    expect(text).toContain('{"name":"BACKUP_BUCKET","value":"tenant-alpha-backups"}');
    expect(text).toContain('"secretRef":{"name":"di-backup-destination","optional":false}');
    expect(text).toContain('backups/alpha/workload-volumes/identity/uid-identity/20261013T033003Z');
    expect(text).not.toContain('backup-pvc');
  });

  test('one operation at a time across dumps and copies', () => {
    const service = {
      name: 'orders',
      uid: 'uid-orders',
      type: 'postgres' as const,
      className: 'postgres-dedicated',
      storage: '1Gi',
      ready: true,
      suspended: false,
      deleting: false,
    };
    const busy = requested({
      jobs: [{ name: 'dump', backupKind: 'dump', serviceName: 'orders', phase: 'Running' }],
    });
    expect(busy.tick().some((action) => action.type === 'scale-workload')).toBe(false);
    expect(busy.backup()?.phase).toBeUndefined();

    // While a copy holds a workload at 0, no dump starts.
    const copying = requested();
    copying.tick();
    const dest = must(copying.destination());
    const due = {
      ...dest,
      annotations: { 'platform.di-framework.dev/backup-now': copying.world.now },
    };
    copying.world = {
      ...copying.world,
      services: [service],
      destination: due,
      destinations: [due],
    };
    expect(copying.tick().some((action) => action.type === 'create-job')).toBe(false);
  });
});

describe('schedule and retention', () => {
  test('no schedule means no scheduled runs, only on-demand ones', () => {
    const cluster = new Cluster(volumeWorld());
    for (let day = 0; day < 3; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) cluster.tick(3600);
    }
    expect(cluster.world.backups).toEqual([]);
    expect(cluster.log.some((action) => action.type === 'scale-workload')).toBe(false);
    // On demand still works.
    const posted = handle('POST', '/backups', 'destination=pvc&workload=identity', cluster.world);
    expect(posted.status).toBe(200);
    cluster.apply(posted.actions);
    cluster.tick();
    expect(cluster.replicas()).toBe(0);
  });

  test('a schedule starts counting when it is first seen, then fires once per due time', () => {
    const cluster = new Cluster(
      volumeWorld({
        destination: pvcDestination({
          sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule: '0 4 * * *' }],
        }),
      }),
    );
    cluster.world = {
      ...cluster.world,
      destinations: [must(cluster.world.destination)],
    };
    cluster.tick();
    // 03:30 today has no earlier fire to catch up on.
    expect(cluster.destination()?.status.sources?.[0]?.lastScheduledTime).toBeDefined();
    expect(cluster.world.backups).toEqual([]);
    cluster.tick(30 * 60);
    expect(cluster.world.backups).toHaveLength(1);
    expect(cluster.backup()?.source).toEqual({ kind: 'workload-volume', workloadName: 'identity' });
    cluster.tick(60);
    expect(cluster.world.backups).toHaveLength(1);

    const suspended = new Cluster(
      volumeWorld({
        destination: pvcDestination({
          sources: [
            {
              kind: 'workload-volume',
              workloadName: 'identity',
              schedule: '* * * * *',
              suspend: true,
            },
          ],
        }),
      }),
    );
    suspended.tick();
    suspended.tick(120);
    expect(suspended.world.backups).toEqual([]);
  });

  const day = (n: number, hour = 2) => new Date(Date.UTC(2026, 9, n, hour)).toISOString();
  const backup = (name: string, createdAt: string, phase: BackupView['phase'] = 'Succeeded') =>
    ({
      name,
      serviceName: 'identity',
      destinationName: 'pvc',
      uid: 'uid-identity',
      type: 'workload-volume',
      className: '',
      storage: '1Gi',
      createdAt,
      phase,
      ...(phase === 'Succeeded' ? { objectKey: `p/${name}/data.tar` } : {}),
      source: { kind: 'workload-volume' as const, workloadName: 'identity' },
    }) satisfies BackupView;

  test('retention keeps what any rule keeps and deletes nothing without a rule', () => {
    // Two a day for 40 days, newest first by date.
    const all: BackupView[] = [];
    for (let n = 1; n <= 40; n += 1) {
      const date = n <= 31 ? day(n) : new Date(Date.UTC(2026, 10, n - 31, 2)).toISOString();
      all.push(backup(`b${n}-a`, date), backup(`b${n}-b`, date.replace('T02', 'T14')));
    }
    expect(expiredVolumeBackups(all, undefined)).toEqual([]);
    expect(expiredVolumeBackups(all, {})).toEqual([]);
    const kept = (retention: Parameters<typeof expiredVolumeBackups>[1]) => {
      const doomed = new Set(expiredVolumeBackups(all, retention).map((item) => item.name));
      return all.filter((item) => !doomed.has(item.name)).map((item) => item.name);
    };
    expect(kept({ keepLast: 3 })).toEqual(['b39-b', 'b40-a', 'b40-b']);
    expect(kept({ daily: 2 })).toEqual(['b39-b', 'b40-b']);
    expect(kept({ weekly: 2 }).length).toBe(2);
    expect(kept({ monthly: 2 })).toEqual(['b31-b', 'b40-b']);
    expect(kept({ keepLast: 1, monthly: 2 })).toEqual(['b31-b', 'b40-b']);
    expect(kept({ keepLast: 2, daily: 3, monthly: 2 })).toEqual([
      'b31-b',
      'b38-b',
      'b39-b',
      'b40-a',
      'b40-b',
    ]);
    const failures = [
      backup('f1', day(1), 'Failed'),
      backup('f2', day(2), 'Failed'),
      backup('f3', day(3), 'Failed'),
    ];
    expect(expiredVolumeBackups(failures, { failed: 1 }).map((item) => item.name)).toEqual([
      'f2',
      'f1',
    ]);
    expect(expiredVolumeBackups([...failures, ...all], { keepLast: 1 })).toHaveLength(79);
    expect(expiredVolumeBackups([backup('running', day(1), 'Running')], { keepLast: 1 })).toEqual(
      [],
    );
  });

  test('the operator deletes expired volume backups with all three objects, and only those', () => {
    const backups = [
      backup('old', day(1)),
      backup('mid', day(2)),
      backup('new', day(3)),
      // A BackingService dump: its own retention (successful: 14) applies, not the source's.
      { ...backup('dump', day(1)), source: undefined, serviceName: 'orders', type: 'postgres' },
    ];
    const keepTwo = pvcDestination({
      sources: [{ kind: 'workload-volume', workloadName: 'identity', retention: { keepLast: 2 } }],
    });
    const actions = reconcile(volumeWorld({ destination: keepTwo, backups }));
    const gc = job(actions);
    expect(JSON.stringify(gc)).toContain(
      '"value":"p/old/data.tar\\np/old/SHA256SUMS\\np/old/manifest.json"',
    );
    expect((gc.metadata as { annotations: Record<string, string> }).annotations).toEqual({
      'platform.di-framework.dev/gc-backups': 'old',
    });
    // No rule: nothing is deleted, however many there are.
    expect(reconcile(volumeWorld({ backups })).some((action) => action.type === 'create-job')).toBe(
      false,
    );
    // A backup a restore still reads from is not deleted under it.
    const reading = reconcile(
      volumeWorld({
        destination: keepTwo,
        backups,
        restores: [
          {
            name: 'r',
            sourceBackupName: 'old',
            targetServiceName: '',
            targetWorkloadName: 'identity',
            phase: 'Failed',
          },
          {
            name: 'r2',
            sourceBackupName: 'old',
            targetServiceName: '',
            targetWorkloadName: 'other',
          },
        ],
      }),
    );
    expect(reading.some((action) => action.type === 'create-job')).toBe(false);
    expect(backupKeys({ ...backup('x', day(1)), objectKey: undefined })).toEqual([]);
  });
});

describe('restore into a workload volume', () => {
  const source = {
    ...{
      name: 'di-volume-identity-1',
      serviceName: 'identity',
      destinationName: 'pvc',
      uid: 'uid-identity',
      type: 'workload-volume',
      className: '',
      storage: '1Gi',
      createdAt: NOW,
    },
    phase: 'Succeeded' as const,
    objectKey:
      'di-framework/alpha/workload-volumes/identity/uid-identity/20261013T020000Z/data.tar',
    source: { kind: 'workload-volume' as const, workloadName: 'identity' },
  };

  test('scales the target to 0, restores on its node, and gives the replicas back', () => {
    const cluster = new Cluster(volumeWorld({ backups: [source] }));
    const posted = handle(
      'POST',
      '/restores',
      `source=${source.name}&workload=identity&force=on&kcv=00112233445566778899AABBCCDDEEFF`,
      cluster.world,
    );
    expect(posted.status).toBe(200);
    cluster.apply(posted.actions);
    const restore = () => cluster.world.restores[0];
    expect(restore()).toMatchObject({
      targetWorkloadName: 'identity',
      force: true,
      expectedKcv: '00112233445566778899aabbccddeeff',
    });
    const start = cluster.tick();
    expect(cluster.types(start).slice(0, 2)).toEqual(['restore-status', 'scale-workload']);
    expect(cluster.replicas()).toBe(0);
    cluster.instances('identity', 0);
    const text = JSON.stringify(job(cluster.tick()));
    expect(text).toContain('"platform.di-framework.dev/backup-kind":"volume-restore"');
    expect(text).toContain(
      `{"name":"workloads","hostPath":{"path":"/var/lib/kubesolo/di-tenants/${TENANT_UID}/workloads","type":"Directory"}}`,
    );
    expect(text).toContain('{"name":"workloads","mountPath":"/workloads"}');
    expect(text).toContain('{"name":"BACKUP_FORCE","value":"true"}');
    expect(text).toContain(
      '{"name":"BACKUP_EXPECTED_KCV","value":"00112233445566778899aabbccddeeff"}',
    );
    expect(text).toContain(
      '{"name":"BACKUP_OBJECT_PREFIX","value":"di-framework/alpha/workload-volumes/identity/uid-identity/20261013T020000Z"}',
    );
    expect(text).toContain('"add":["CHOWN","DAC_OVERRIDE","FOWNER"]');
    cluster.finishJob('Succeeded', {
      ok: true,
      fileCount: 3,
      replacedPath: 'identity.replaced-20261013T033003Z',
    });
    const done = cluster.tick();
    expect(done[0]).toEqual({ type: 'scale-workload', name: 'identity', replicas: 2 });
    expect(restore()).toMatchObject({
      phase: 'Succeeded',
      volume: { stage: 'Done', replacedPath: 'identity.replaced-20261013T033003Z', fileCount: 3 },
    });
    expect(cluster.replicas()).toBe(2);
  });

  test('a refused non-empty target fails the restore and the replicas come back', () => {
    const cluster = new Cluster(volumeWorld({ backups: [source] }));
    cluster.apply(
      handle('POST', '/restores', `source=${source.name}&workload=identity`, cluster.world).actions,
    );
    cluster.tick();
    cluster.instances('identity', 0);
    const text = JSON.stringify(job(cluster.tick()));
    expect(text).toContain('{"name":"BACKUP_FORCE","value":"false"}');
    expect(text).not.toContain('BACKUP_EXPECTED_KCV');
    cluster.finishJob('Failed', { ok: false, error: 'TargetNotEmpty' });
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Failed', reason: 'TargetNotEmpty' });
    expect(cluster.replicas()).toBe(2);
    cluster.finishJob('Failed');
  });

  test('refuses sources it cannot restore from', () => {
    const world = volumeWorld({
      backups: [source, { ...source, name: 'dump', source: undefined }],
    });
    const refuse = (name: string) =>
      startRestore(world, {
        name: 'r',
        sourceBackupName: name,
        targetServiceName: '',
        targetWorkloadName: 'identity',
      });
    expect(JSON.stringify(refuse('missing'))).toContain('BackupNotFound');
    expect(JSON.stringify(refuse('dump'))).toContain('TargetMismatch');
    expect(
      JSON.stringify(
        startRestore(
          { ...world, workloads: [] },
          {
            name: 'r',
            sourceBackupName: source.name,
            targetServiceName: '',
            targetWorkloadName: 'identity',
          },
        ),
      ),
    ).toContain('WorkloadNotFound');
    const failedRestore = new Cluster(volumeWorld({ backups: [source] }));
    failedRestore.apply([
      {
        type: 'create-restore',
        body: {
          metadata: { name: 'r' },
          spec: { sourceBackupName: source.name, targetWorkloadName: 'identity' },
        },
      },
    ]);
    failedRestore.tick();
    failedRestore.instances('identity', 0);
    failedRestore.tick();
    failedRestore.finishJob('Failed');
    failedRestore.tick();
    expect(failedRestore.world.restores[0]).toMatchObject({
      phase: 'Failed',
      reason: 'RestoreFailed',
    });
    // A restore whose source backup vanished mid-way still gives the replicas back.
    const orphan = new Cluster(volumeWorld({ backups: [source] }));
    orphan.apply([
      {
        type: 'create-restore',
        body: {
          metadata: { name: 'r' },
          spec: { sourceBackupName: source.name, targetWorkloadName: 'identity' },
        },
      },
    ]);
    orphan.tick();
    orphan.world = { ...orphan.world, backups: [] };
    orphan.tick();
    expect(orphan.world.restores[0]).toMatchObject({ phase: 'Failed', reason: 'DestinationGone' });
    expect(orphan.replicas()).toBe(2);
  });
});

describe('console and derivation', () => {
  test('lists sources with schedule, retention, and downtime, and validates posts', () => {
    const dest = pvcDestination({
      sources: [
        {
          kind: 'workload-volume',
          workloadName: 'identity',
          schedule: '30 3 * * *',
          retention: { keepLast: 7, daily: 7 },
        },
        { kind: 'workload-volume', workloadName: 'other', schedule: '0 1 * * *', suspend: true },
        { kind: 'workload-volume', workloadName: 'manual' },
      ],
    });
    const world = volumeWorld({ destination: dest, destinations: [dest] });
    const html = render(world);
    expect(html).toContain('identity: schedule 30 3 * * * (UTC); retention keepLast 7, daily 7');
    expect(html).toContain('other: schedule 0 1 * * * (UTC), suspended');
    expect(html).toContain(
      'manual: no schedule (on demand only); retention none (every backup is kept)',
    );
    expect(html).toContain('last scale-to-0 never');
    expect(handle('POST', '/backups', 'destination=pvc&workload=nope', world).status).toBe(400);
    expect(
      handle('POST', '/backups', 'workload=identity', {
        ...world,
        destinations: [],
        destination: undefined,
      }).status,
    ).toBe(400);
    const bad = [
      'source=missing&workload=identity',
      'source=b&workload=Bad_Name',
      `source=b&workload=${'a'.repeat(64)}`,
      'source=b&workload=identity&kcv=xyz',
    ];
    const withBackup = {
      ...world,
      backups: [
        {
          name: 'b',
          serviceName: 'identity',
          destinationName: 'pvc',
          uid: 'u',
          type: 'workload-volume',
          className: '',
          storage: '1Gi',
          createdAt: NOW,
          phase: 'Succeeded' as const,
          objectKey: 'k/data.tar',
          source: { kind: 'workload-volume' as const, workloadName: 'identity' },
        },
      ],
    };
    for (const body of bad) expect(handle('POST', '/restores', body, withBackup).status).toBe(400);
    expect(render(withBackup)).toContain('<option value="b">b</option>');
    expect(
      handle('POST', '/restores', 'source=b&workload=identity', withBackup).actions[0],
    ).toMatchObject({
      type: 'create-restore',
      body: { spec: { sourceBackupName: 'b', targetWorkloadName: 'identity' } },
    });
  });

  test('derives the storage key and path exactly as the platform does', () => {
    const cases: Pick<WorkloadView, 'name' | 'labels' | 'annotations'>[] = [
      {
        name: 'identity',
        labels: {},
        annotations: { 'di-framework.dev/persistent-storage': 'true' },
      },
      { name: 'identity', labels: {}, annotations: {} },
      {
        name: 'w',
        labels: { 'di-framework.dev/workload': 'shared', 'di-framework.dev/application': 'app' },
        annotations: { 'di-framework.dev/persistent-storage': 'true' },
      },
      {
        name: 'w',
        labels: { 'di-framework.dev/application': 'app' },
        annotations: { 'di-framework.dev/persistent-storage': 'true' },
      },
      {
        name: 'Bad_Name',
        labels: {},
        annotations: { 'di-framework.dev/persistent-storage': 'true' },
      },
      {
        name: 'a'.repeat(51),
        labels: {},
        annotations: { 'di-framework.dev/persistent-storage': 'true' },
      },
      {
        name: 'w',
        labels: {},
        annotations: {
          'di-framework.dev/persistent-storage': 'true',
          'di-framework.dev/storage-mount': '/etc',
        },
      },
      {
        name: 'w',
        labels: {},
        annotations: {
          'di-framework.dev/persistent-storage': 'true',
          'di-framework.dev/storage-mount': '/data/actors',
        },
      },
    ];
    for (const item of cases) {
      const platform = {
        metadata: { name: item.name, labels: item.labels, annotations: item.annotations },
      };
      const wants = item.annotations['di-framework.dev/persistent-storage'] === 'true';
      const mount = item.annotations['di-framework.dev/storage-mount'] ?? '/data';
      const expected =
        wants && ['/data', '/data/actors'].includes(mount) ? platformKey(platform) : undefined;
      expect(storageKeyOf(item)).toBe(expected);
    }
    const tenant = { metadata: { name: 'alpha', uid: TENANT_UID } } as Parameters<
      typeof platformPath
    >[0];
    const cfg = { storageRoot: '/var/lib/kubesolo' } as Parameters<typeof platformPath>[1];
    expect(volumePath('/var/lib/kubesolo', TENANT_UID, 'identity')).toBe(
      platformPath(tenant, cfg, 'identity'),
    );
    expect(resolveVolume(volumeWorld({ storageRoot: undefined }), 'identity')).toMatchObject({
      hostPath: VOLUME,
    });
  });

  test('reconcileAll with no destination and nothing to finish does nothing', () => {
    expect(reconcileAll(volumeWorld({ destination: undefined, destinations: [] }))).toEqual([]);
  });
});

describe('kubernetes client for workload volumes', () => {
  const RUNTIME = '/apis/runtime.wasmcloud.dev/v1alpha1/namespaces/di-tenant-alpha';
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
                      localResources: {
                        volumeMounts: [{ name: 'di-storage', mountPath: '/data' }],
                      },
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
          {
            metadata: { name: 'bare', uid: 'uid-bare' },
            spec: {},
            status: { currentReplicas: 'x' },
          },
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
            status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
          },
          { metadata: { name: 'host-new', labels: { 'wasmcloud.com/hostgroup': 'tenant-alpha' } } },
          { metadata: { name: 'other', labels: { 'wasmcloud.com/hostgroup': 'tenant-beta' } } },
        ],
      },
    ],
    [
      '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-alpha/backups',
      {
        items: [
          {
            metadata: { name: 'v1', creationTimestamp: NOW },
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
      '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-alpha/backuprestores',
      {
        items: [
          {
            metadata: { name: 'r1' },
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
            status: {
              conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }],
            },
          },
          {
            metadata: {
              name: 'put-back',
              labels: { 'platform.di-framework.dev/backup-kind': 'volume-restore' },
            },
            status: { conditions: 'bad' },
          },
        ],
      },
    ],
  ]);

  test('loads workloads, instances, hosts, the tenant uid, and volume progress', async () => {
    const client = {
      async get(path: string) {
        if (routes.has(path)) return routes.get(path);
        if (path.endsWith('/secrets/di-backup-destination')) throw new Error('missing');
        return { items: [] };
      },
      async post() {
        return {};
      },
      async patch() {
        return {};
      },
      async remove() {},
    };
    const { loadWorld } = await import('../src/kube.ts');
    const loaded = await loadWorld(
      client,
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
    expect(loaded.hosts).toEqual([
      { name: 'host-0', node: 'node-a', ready: true, hostPaths: [VOLUME] },
      { name: 'host-old', node: undefined, ready: false, hostPaths: [] },
      { name: 'host-new', node: undefined, ready: false, hostPaths: [] },
    ]);
    expect(loaded.tenantUid).toBe(TENANT_UID);
    expect(loaded.storageRoot).toBe('/var/lib/kubesolo');
    expect(loaded.backups[0]).toMatchObject({
      source: { kind: 'workload-volume', workloadName: 'identity' },
      volume: { stage: 'ScalingDown' },
      message: 'scaling',
    });
    expect(loaded.backups[1]?.source).toBeUndefined();
    expect(loaded.backups[1]?.volume).toBeUndefined();
    expect(loaded.restores[0]).toMatchObject({
      targetServiceName: '',
      targetWorkloadName: 'identity',
      force: true,
      expectedKcv: 'ab'.repeat(16),
      volume: { stage: 'Copying' },
    });
    expect(loaded.jobs).toEqual([
      expect.objectContaining({
        name: 'copy',
        backupKind: 'volume-copy',
        phase: 'Failed',
        failedReason: 'DeadlineExceeded',
      }),
      expect.objectContaining({
        name: 'put-back',
        backupKind: 'volume-restore',
        phase: 'Running',
        failedReason: undefined,
      }),
    ]);

    // An older chart without the workload RBAC still loads.
    const denied = await loadWorld(
      {
        ...client,
        async get(path: string) {
          if (path.includes('runtime.wasmcloud.dev') || path.includes('/deployments/')) {
            throw new Error('forbidden');
          }
          return client.get(path);
        },
      },
      'di-tenant-alpha',
      'image:dev',
      NOW,
    );
    expect(denied.workloads).toEqual([]);
    expect(denied.tenantUid).toBeUndefined();
  });

  test('scales through the scale subresource and deletes a Job in the background', async () => {
    const calls: [string, string, unknown?][] = [];
    const { applyActions } = await import('../src/kube.ts');
    await applyActions(
      {
        async get() {
          return {};
        },
        async post() {
          return {};
        },
        async patch(path, body) {
          calls.push(['PATCH', path, body]);
          return {};
        },
        async remove(path) {
          calls.push(['DELETE', path]);
        },
      },
      volumeWorld(),
      [
        { type: 'scale-workload', name: 'identity', replicas: 0 },
        { type: 'delete-job', name: 'di-volume-identity-1' },
      ],
    );
    expect(calls).toEqual([
      ['PATCH', `${RUNTIME}/workloaddeployments/identity/scale`, { spec: { replicas: 0 } }],
      [
        'DELETE',
        '/apis/batch/v1/namespaces/di-runtime-alpha/jobs/di-volume-identity-1?propagationPolicy=Background',
      ],
    ]);
  });
});
