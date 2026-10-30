import { describe, expect, test } from 'bun:test';
import {
  storageKey as platformKey,
  nodeStoragePath as platformPath,
} from '../../platform/src/tenancy/workload-storage.ts';
import { handle, render } from '../src/console.ts';
import {
  type Action,
  type BackupView,
  FINALIZER,
  opJobName,
  type RestoreView,
  storageKeyOf,
  volumePath,
  type WorkloadView,
  type World,
} from '../src/model.ts';
import { reconcile, reconcileAll } from '../src/reconcile.ts';
import type { StorageRecord, StorageRecords } from '../src/storage-records.ts';
import {
  backupKeys,
  expiredVolumeBackups,
  jobResources,
  releaseOrphans,
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
  encfsMode: 'XTS',
  imageDigest: `sha256:${'ab'.repeat(32)}`,
};

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

/** A cluster with one requested on-demand backup of `identity`. */
function requested(overrides: Parameters<typeof volumeWorld>[0] = {}): Cluster {
  const cluster = new Cluster(volumeWorld(overrides));
  const world = cluster.world;
  cluster.apply([requestBackup(world, must(world.destination), 'identity')]);
  return cluster;
}

/** Placed (the probe succeeds at once) and scaled to 0. */
function stopped(cluster: Cluster): Action[] {
  cluster.tick();
  return cluster.tick();
}

/** Stopped, instances gone, and the copy Job created. */
function copying(cluster: Cluster, names = ['identity']): Action[] {
  stopped(cluster);
  for (const name of names) cluster.instances(name, 0);
  return cluster.tick();
}

function job(actions: Action[], kind = 'volume-copy'): Record<string, unknown> {
  const created = actions.find(
    (action) =>
      action.type === 'create-job' &&
      JSON.stringify(action.body).includes(`"platform.di-framework.dev/backup-kind":"${kind}"`),
  );
  if (created?.type !== 'create-job') throw new Error(`no ${kind} Job created`);
  return created.body;
}

const scaled = (actions: Action[]) => actions.filter((action) => action.type === 'scale-workload');

describe('cold copy of a workload volume', () => {
  test('places, records replicas, scales to 0, waits, copies on the volume node, and gives the replicas back', () => {
    const cluster = requested();
    const place = cluster.tick();
    // Nothing is stopped before the probe has run on the node.
    expect(cluster.types(place)).toEqual([
      'backup-status',
      'finalizers',
      'create-job',
      'destination-status',
      // The first reconcile logs the destination's NoSchedule state once (#250).
      'log',
    ]);
    expect(place[0]).toMatchObject({
      status: {
        phase: 'Running',
        reason: 'Placing',
        volume: { stage: 'Placing', node: 'node-a', hostPath: VOLUME, storageKey: 'identity' },
      },
    });
    expect(place[1]).toMatchObject({ finalizers: [FINALIZER] });
    const probe = JSON.stringify(job(place, 'volume-probe'));
    expect(probe).toContain('{"name":"BACKUP_KIND","value":"probe-placement"}');
    expect(probe).toContain('{"name":"BACKUP_PROBE_PATHS","value":"/source:/backup-pvc"}');
    expect(probe).toContain('"runAsNonRoot":true');
    expect(probe).toContain('"capabilities":{"drop":["ALL"]}');
    expect(probe).toContain('{"name":"backup-pvc","mountPath":"/backup-pvc","readOnly":true}');
    expect(probe).toContain(
      '"matchFields":[{"key":"metadata.name","operator":"In","values":["node-a"]}]',
    );
    expect(probe).not.toContain('secretRef');
    expect(cluster.replicas()).toBe(2);

    const start = cluster.tick();
    // The replicas are on record, in status and in the ledger, before the workload is scaled.
    expect(cluster.types(start).slice(0, 3)).toEqual(['backup-status', 'ledger', 'scale-workload']);
    expect(start[0]).toMatchObject({
      status: {
        phase: 'Running',
        reason: 'ScalingDown',
        volume: { stage: 'ScalingDown', members: [{ name: 'identity', replicas: 2 }] },
      },
    });
    expect(cluster.held()).toEqual({
      identity: {
        replicas: 2,
        heldBy: `Backup/${cluster.backup()?.name}`,
        since: cluster.world.now,
        destination: 'pvc',
        // Bound to the workload and its volume (#263).
        storageKey: 'identity',
        workloadUid: 'uid-identity',
      },
    });
    expect(start[2]).toEqual({ type: 'scale-workload', name: 'identity', replicas: 0 });
    expect(cluster.replicas()).toBe(0);

    // Instances still running: nothing new happens.
    expect(cluster.tick().some((action) => action.type === 'create-job')).toBe(false);
    cluster.instances('identity', 0);
    const copy = cluster.tick();
    const body = job(copy);
    const text = JSON.stringify(body);
    // Named per object (W7): the Backup's metadata.uid is part of the name and a label.
    const owner = cluster.backup();
    expect((body.metadata as { name: string }).name).toBe(
      opJobName('di-vcopy', owner?.name ?? '', owner?.objectUid),
    );
    expect((body.metadata as { name: string }).name).toMatch(
      /^di-vcopy-di-volume-identity-\d+-[0-9a-f]{8}$/,
    );
    expect((body.metadata as { labels: Record<string, string> }).labels).toMatchObject({
      'platform.di-framework.dev/backup-uid': owner?.objectUid,
    });
    expect(text).toContain(
      '"matchFields":[{"key":"metadata.name","operator":"In","values":["node-a"]}]',
    );
    expect(text).toContain(`{"name":"source","hostPath":{"path":"${VOLUME}","type":"Directory"}}`);
    expect(text).toContain('{"name":"source","mountPath":"/source","readOnly":true}');
    expect(text).toContain('"add":["DAC_READ_SEARCH"]');
    expect(text).toContain('"readOnlyRootFilesystem":true');
    expect(text).toContain('"seccompProfile":{"type":"RuntimeDefault"}');
    expect(text).toContain('{"name":"RCLONE_CONFIG","value":"/scratch/rclone.conf"}');
    expect(text).toContain('{"name":"scratch","mountPath":"/scratch"}');
    expect(text).toContain('{"name":"BACKUP_WORKDIR","value":"/scratch"}');
    expect(text).toContain('"backoffLimit":0');
    expect(text).toContain('"ttlSecondsAfterFinished":604800');
    expect(text).toContain('"activeDeadlineSeconds":3600');
    expect(text).toContain(`{"name":"BACKUP_SOURCE_IMAGE","value":"${IMAGE}"}`);
    expect(text).toContain('{"name":"BACKUP_KIND","value":"workload-volume"}');
    expect(text).toContain('"claimName":"claim"');
    expect(text).toContain('"limits":{"cpu":"100m","memory":"128Mi"}');
    // No Secret: not the workload's, and a PVC destination has no credentials.
    expect(text).not.toContain('secretKeyRef');
    expect(text).not.toContain('secretRef');
    expect(cluster.backup()?.volume?.stage).toBe('Copying');

    expect(cluster.tick(30)).toEqual([expect.objectContaining({ type: 'destination-status' })]);
    cluster.finishJob('Succeeded', OK);
    const done = cluster.tick();
    expect(cluster.types(done).slice(0, 5)).toEqual([
      'backup-status',
      'scale-workload',
      'ledger',
      'backup-status',
      'finalizers',
    ]);
    expect(done[1]).toEqual({ type: 'scale-workload', name: 'identity', replicas: 2 });
    expect(cluster.replicas()).toBe(2);
    expect(cluster.held()).toEqual({});
    const backup = cluster.backup();
    expect(backup).toMatchObject({
      phase: 'Succeeded',
      objectKey: OK.objectKey,
      digest: OK.digest,
      finalizers: [],
      volume: {
        stage: 'Done',
        fileCount: 1767,
        encfsKcv: OK.encfsKcv,
        encfsMode: 'XTS',
        imageDigest: OK.imageDigest,
        scaleDownSeconds: 39,
      },
    });
    expect(backup?.volume?.outcome).toBeUndefined();
    // The duration shows on the destination status and in the console.
    cluster.tick();
    const row = cluster.destination()?.status.sources?.[0];
    expect(row).toMatchObject({
      workloadName: 'identity',
      lastReason: 'Completed',
      lastScaleDownSeconds: 39,
      lastBackupName: backup?.name,
      scheduleStatus: 'OnDemand',
    });
    const html = render(cluster.world);
    expect(html).toContain('last scale-to-0 39s');
    expect(html).toContain('scale-to-0 39s');
  });

  test('gives the replicas back when the copy fails', () => {
    const cluster = requested();
    copying(cluster);
    cluster.finishJob('Failed', { ok: false, error: 'SourceChanged' });
    const done = cluster.tick();
    expect(scaled(done)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 2 }]);
    expect(cluster.backup()).toMatchObject({ phase: 'Failed', reason: 'SourceChanged' });
    expect(cluster.replicas()).toBe(2);

    const silent = requested();
    copying(silent);
    silent.finishJob('Failed');
    silent.tick();
    expect(silent.backup()).toMatchObject({ phase: 'Failed', reason: 'CopyFailed' });
    expect(silent.replicas()).toBe(2);

    const odd = requested();
    copying(odd);
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
    stopped(cluster);
    expect(scaled(cluster.tick(59))).toEqual([]);
    const timedOut = cluster.tick(5);
    expect(scaled(timedOut)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 2 }]);
    expect(cluster.backup()).toMatchObject({
      phase: 'Failed',
      reason: 'ScaleDownTimeout',
      message: '2 instance(s) still running after 60s',
    });
    expect(cluster.world.jobs.filter((item) => item.backupKind === 'volume-copy')).toEqual([]);
    expect(cluster.replicas()).toBe(2);
  });

  test('gives the replicas back when the copy times out, hangs, or its Job disappears', () => {
    const deadline = requested();
    copying(deadline);
    deadline.finishJob('Failed', undefined, 'DeadlineExceeded');
    deadline.tick();
    expect(deadline.backup()).toMatchObject({ phase: 'Failed', reason: 'CopyTimeout' });
    expect(deadline.replicas()).toBe(2);

    const hung = requested({
      destination: pvcDestination({
        sources: [{ kind: 'workload-volume', workloadName: 'identity', copyTimeoutSeconds: 600 }],
      }),
    });
    copying(hung);
    expect(scaled(hung.tick(600))).toEqual([]);
    const stuck = hung.tick(200);
    // The Job is stopped first; its pod is still running, so the replicas wait for it.
    expect(hung.types(stuck).slice(0, 2)).toEqual(['backup-status', 'delete-job']);
    expect(hung.backup()?.volume?.stage).toBe('ScalingUp');
    expect(hung.replicas()).toBe(0);
    const back = hung.tick();
    expect(scaled(back)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 2 }]);
    expect(hung.backup()).toMatchObject({ phase: 'Failed', reason: 'CopyTimeout' });
    expect(hung.replicas()).toBe(2);

    const vanished = requested();
    copying(vanished);
    vanished.world = { ...vanished.world, jobs: [] };
    // Within the grace the Job is created again (same name): the create may have failed.
    expect(job(vanished.tick(60))).toBeDefined();
    vanished.world = { ...vanished.world, jobs: [] };
    vanished.tick(90);
    expect(vanished.backup()).toMatchObject({ phase: 'Failed', reason: 'JobMissing' });
    expect(vanished.replicas()).toBe(2);
  });

  test('stops and restores every workload that shares the volume, even one missing from the list', () => {
    const member = workload({
      name: 'identity-worker',
      uid: 'uid-worker',
      replicas: 1,
      instances: 1,
      labels: { 'di-framework.dev/workload': 'identity' },
    });
    const unrelated = workload({ name: 'web', uid: 'uid-web', annotations: {} });
    const cluster = requested({ workloads: [workload(), member, unrelated] });
    expect(scaled(stopped(cluster))).toEqual([
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
    // A member that is not in the list is still scaled: only a 404 on the write may skip it.
    expect(scaled(cluster.tick())).toEqual([
      { type: 'scale-workload', name: 'identity', replicas: 2 },
      { type: 'scale-workload', name: 'identity-worker', replicas: 1 },
    ]);
    expect(cluster.replicas('web')).toBe(2);
    expect(cluster.held()).toEqual({});
  });

  test('a member missing from a successful list never lets the copy start', () => {
    const member = workload({
      name: 'identity-worker',
      uid: 'uid-worker',
      replicas: 1,
      instances: 0,
      labels: { 'di-framework.dev/workload': 'identity' },
    });
    const cluster = requested({
      workloads: [workload(), member],
      destination: pvcDestination({
        sources: [
          { kind: 'workload-volume', workloadName: 'identity', scaleDownTimeoutSeconds: 30 },
        ],
      }),
    });
    stopped(cluster);
    cluster.instances('identity', 0);
    cluster.world = {
      ...cluster.world,
      workloads: cluster.world.workloads?.filter((item) => item.name !== 'identity-worker'),
    };
    expect(cluster.tick().some((action) => action.type === 'create-job')).toBe(false);
    cluster.tick(40);
    expect(cluster.backup()).toMatchObject({
      phase: 'Failed',
      reason: 'ScaleDownTimeout',
      message: '0 instance(s) still running after 30s; not listed: identity-worker',
    });
    expect(cluster.replicas()).toBe(2);
  });

  test('fails when someone raises the replicas mid-way and leaves the raised count alone', () => {
    const early = requested();
    stopped(early);
    early.apply([{ type: 'scale-workload', name: 'identity', replicas: 3 }]);
    early.tick();
    expect(early.backup()).toMatchObject({ phase: 'Failed', reason: 'ScaleDownInterrupted' });
    expect(early.replicas()).toBe(3);
    expect(early.held()).toEqual({});

    const late = requested();
    copying(late);
    late.apply([{ type: 'scale-workload', name: 'identity', replicas: 1 }]);
    late.finishJob('Succeeded', OK);
    late.tick();
    expect(late.backup()).toMatchObject({
      phase: 'Failed',
      reason: 'ScaledDuringCopy',
      objectKey: OK.objectKey,
    });
    expect(late.replicas()).toBe(1);
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
      expect(cluster.backup()?.finalizers).toBeUndefined();
    }
  });

  test('a destination that becomes unusable or disappears still gives the replicas back', () => {
    const suspended = requested();
    stopped(suspended);
    const dest = must(suspended.destination());
    const off = { ...dest, spec: { ...dest.spec, suspend: true } };
    suspended.world = { ...suspended.world, destination: off, destinations: [off] };
    suspended.tick();
    expect(suspended.backup()).toMatchObject({ phase: 'Failed', reason: 'TenantSuspended' });
    expect(suspended.replicas()).toBe(2);

    const gone = requested();
    stopped(gone);
    gone.world = { ...gone.world, destination: undefined, destinations: [] };
    gone.tick();
    expect(gone.backup()).toMatchObject({ phase: 'Failed', reason: 'DestinationGone' });
    expect(gone.replicas()).toBe(2);

    // A destination gone while placing: nothing was stopped.
    const placing = requested({ destination: pvcDestination() });
    placing.autoProbe = false;
    placing.tick();
    placing.world = { ...placing.world, destination: undefined, destinations: [] };
    placing.tick();
    expect(placing.backup()).toMatchObject({ phase: 'Failed', reason: 'DestinationGone' });
    expect(placing.log.some((action) => action.type === 'scale-workload')).toBe(false);

    // A copy already running when its destination goes finishes first.
    const running = requested();
    copying(running);
    running.world = { ...running.world, destination: undefined, destinations: [] };
    expect(running.tick()).toEqual([]);
    running.finishJob('Succeeded', OK);
    running.tick();
    expect(running.backup()?.phase).toBe('Succeeded');
    expect(running.replicas()).toBe(2);
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
    const probe = JSON.stringify(job(cluster.tick(), 'volume-probe'));
    expect(probe).toContain('{"name":"BACKUP_PROBE_PATHS","value":"/source"}');
    expect(probe).not.toContain('secretRef');
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
    expect(busy.tick().some((action) => action.type === 'backup-status')).toBe(false);
    expect(busy.backup()?.phase).toBeUndefined();

    // While a copy holds a workload at 0, no dump starts.
    const holding = requested();
    stopped(holding);
    const dest = must(holding.destination());
    const due = {
      ...dest,
      annotations: { 'platform.di-framework.dev/backup-now': holding.world.now },
    };
    holding.world = {
      ...holding.world,
      services: [service],
      destination: due,
      destinations: [due],
    };
    expect(holding.tick().some((action) => action.type === 'create-job')).toBe(false);
  });

  test('the copy Job takes per-source resources and the default fits everywhere', () => {
    expect(jobResources(undefined)).toEqual({
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '100m', memory: '128Mi' },
    });
    const cluster = requested({
      destination: pvcDestination({
        sources: [
          {
            kind: 'workload-volume',
            workloadName: 'identity',
            resources: { limits: { cpu: '1', memory: '512Mi' }, requests: { cpu: '500m' } },
          },
        ],
      }),
    });
    const text = JSON.stringify(job(copying(cluster)));
    expect(text).toContain(
      '"resources":{"requests":{"cpu":"500m","memory":"64Mi"},"limits":{"cpu":"1","memory":"512Mi"}}',
    );
  });
});

describe('C1: a failed list is unknown, never empty', () => {
  test('reviewer reproduction: a failed list while copying writes nothing; the next tick gives the replicas back', () => {
    const cluster = requested();
    copying(cluster);
    cluster.finishJob('Succeeded', OK);
    // loadWorld leaves workloads and the ledger undefined when a list fails.
    expect(cluster.tick(3, { unknown: true })).toEqual([
      expect.objectContaining({ type: 'destination-status' }),
    ]);
    expect(cluster.backup()?.phase).toBe('Running');
    expect(cluster.replicas()).toBe(0);
    const done = cluster.tick();
    expect(scaled(done)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 2 }]);
    expect(cluster.backup()).toMatchObject({ phase: 'Succeeded', volume: { stage: 'Done' } });
    expect(cluster.replicas()).toBe(2);
  });

  test('a failed list while scaling down never starts the copy, however long it lasts', () => {
    const cluster = requested();
    stopped(cluster);
    // Instances still run; an unknown tick must not read that as 0.
    for (let i = 0; i < 5; i += 1) {
      const actions = cluster.tick(3, { unknown: true });
      expect(actions.some((action) => action.type === 'create-job')).toBe(false);
      expect(actions.some((action) => action.type === 'backup-status')).toBe(false);
    }
    expect(cluster.backup()?.volume?.stage).toBe('ScalingDown');
    cluster.instances('identity', 0);
    expect(cluster.tick(3, { unknown: true }).some((a) => a.type === 'create-job')).toBe(false);
    expect(job(cluster.tick())).toBeDefined();
  });

  test('a failed list while placing, while giving replicas back, or before starting does nothing', () => {
    const pending = requested();
    expect(pending.tick(3, { unknown: true }).some((a) => a.type === 'backup-status')).toBe(false);
    expect(pending.backup()?.phase).toBeUndefined();

    const placing = requested();
    placing.tick();
    expect(placing.tick(3, { unknown: true }).some((a) => a.type === 'scale-workload')).toBe(false);
    expect(placing.backup()?.volume?.stage).toBe('Placing');

    const back = requested();
    copying(back);
    back.finishJob('Succeeded', OK);
    back.fail((action) => action.type === 'scale-workload');
    back.tick();
    expect(back.backup()?.volume?.stage).toBe('ScalingUp');
    expect(back.tick(3, { unknown: true }).some((a) => a.type === 'scale-workload')).toBe(false);
    expect(back.backup()?.phase).toBe('Running');
    back.tick();
    expect(back.backup()?.phase).toBe('Succeeded');
    expect(back.replicas()).toBe(2);

    // The sweeper never acts on unknown state either.
    expect(releaseOrphans({ ...volumeWorld(), workloads: undefined, ledger: undefined })).toEqual(
      [],
    );
  });

  test('the scale-up applied but the status write failed: no false ScaledDuringCopy', () => {
    const cluster = requested();
    copying(cluster);
    cluster.finishJob('Succeeded', OK);
    // Fail the terminal status write, after the scale-up landed.
    let writes = 0;
    cluster.fail((action) => action.type === 'backup-status' && ++writes === 2);
    cluster.tick();
    expect(cluster.replicas()).toBe(2);
    expect(cluster.backup()).toMatchObject({ phase: 'Running', volume: { stage: 'ScalingUp' } });
    const next = cluster.tick();
    expect(scaled(next)).toEqual([]);
    expect(cluster.backup()).toMatchObject({ phase: 'Succeeded', reason: 'Completed' });
    expect(cluster.held()).toEqual({});
  });

  test('the status write applied but the scale failed: the next tick scales and finishes', () => {
    const cluster = requested();
    copying(cluster);
    cluster.finishJob('Succeeded', OK);
    cluster.fail((action) => action.type === 'scale-workload');
    cluster.tick();
    expect(cluster.replicas()).toBe(0);
    expect(cluster.backup()?.phase).toBe('Running');
    expect(cluster.held().identity).toBeDefined();
    cluster.tick();
    expect(cluster.replicas()).toBe(2);
    expect(cluster.backup()).toMatchObject({ phase: 'Succeeded' });
  });

  test('a scale-down that half landed is driven again, never mistaken for an interruption', () => {
    const ledgerFails = requested();
    ledgerFails.tick();
    ledgerFails.fail((action) => action.type === 'ledger');
    ledgerFails.tick();
    expect(ledgerFails.backup()?.volume?.stage).toBe('ScalingDown');
    expect(ledgerFails.replicas()).toBe(2);
    const again = ledgerFails.tick();
    expect(ledgerFails.types(again).slice(0, 2)).toEqual(['ledger', 'scale-workload']);
    expect(ledgerFails.replicas()).toBe(0);

    const scaleFails = requested();
    scaleFails.tick();
    scaleFails.fail((action) => action.type === 'scale-workload');
    scaleFails.tick();
    expect(scaleFails.held().identity?.replicas).toBe(2);
    expect(scaleFails.replicas()).toBe(2);
    expect(scaled(scaleFails.tick())).toEqual([
      { type: 'scale-workload', name: 'identity', replicas: 0 },
    ]);
    expect(scaleFails.backup()?.phase).toBe('Running');
    scaleFails.instances('identity', 0);
    scaleFails.tick();
    scaleFails.finishJob('Succeeded', OK);
    scaleFails.tick();
    expect(scaleFails.backup()?.phase).toBe('Succeeded');
    expect(scaleFails.replicas()).toBe(2);
  });
});

describe('W1: deleting a running operation, and the double-scale-down trap', () => {
  test('a deleted Backup keeps its finalizer until the replicas are back, in every stage', () => {
    const placing = requested();
    placing.autoProbe = false;
    placing.tick();
    const name = must(placing.backup()).name;
    placing.remove('backups', name);
    expect(placing.backup()?.deleting).toBe(true);
    placing.tick();
    expect(placing.backup(name)).toBeUndefined();
    expect(placing.log.some((action) => action.type === 'scale-workload')).toBe(false);

    const scaling = requested();
    stopped(scaling);
    scaling.remove('backups', must(scaling.backup()).name);
    scaling.tick();
    expect(scaling.backup()).toBeUndefined();
    expect(scaling.replicas()).toBe(2);
    expect(scaling.held()).toEqual({});

    const running = requested();
    const copy = job(copying(running));
    running.remove('backups', must(running.backup()).name);
    const stop = running.tick();
    expect(running.types(stop).slice(0, 2)).toEqual(['backup-status', 'delete-job']);
    expect(running.replicas()).toBe(0);
    // The Job is deleted but its pod is still terminating: the workload waits for it.
    running.world = {
      ...running.world,
      jobs: [
        {
          name: (copy.metadata as { name: string }).name,
          backupKind: 'volume-copy',
          serviceName: '',
          phase: 'Running',
          activePods: 1,
        },
      ],
    };
    expect(scaled(running.tick())).toEqual([]);
    running.job((copy.metadata as { name: string }).name, { activePods: 0 });
    running.tick();
    expect(running.replicas()).toBe(2);
    expect(running.backup()).toBeUndefined();
  });

  test('a stopped Job whose pod never goes away holds the replicas only for the grace', () => {
    const cluster = requested();
    const copy = job(copying(cluster));
    const name = (copy.metadata as { name: string }).name;
    cluster.remove('backups', must(cluster.backup()).name);
    cluster.tick();
    cluster.world = {
      ...cluster.world,
      jobs: [{ name, backupKind: 'volume-copy', serviceName: '', phase: 'Running', activePods: 1 }],
    };
    expect(scaled(cluster.tick(60))).toEqual([]);
    expect(scaled(cluster.tick(70))).toEqual([
      { type: 'scale-workload', name: 'identity', replicas: 2 },
    ]);
  });

  test('a BackupRestore deleted while restoring gives the replicas back too', () => {
    const source = succeededSource();
    const cluster = new Cluster(volumeWorld({ backups: [source] }));
    cluster.apply(
      handle('POST', '/restores', `source=${source.name}&workload=identity`, cluster.world).actions,
    );
    copying(cluster);
    const restore = must(cluster.world.restores[0]);
    expect(restore.finalizers).toEqual([FINALIZER]);
    cluster.remove('backuprestores', restore.name);
    cluster.tick();
    cluster.finishJob('Failed');
    cluster.tick();
    expect(cluster.world.restores).toEqual([]);
    expect(cluster.replicas()).toBe(2);
  });

  test('the double-scale-down trap: a Backup removed past its finalizer, then another backup', () => {
    const cluster = requested();
    stopped(cluster);
    const first = must(cluster.backup()).name;
    expect(cluster.replicas()).toBe(0);
    expect(cluster.held().identity).toMatchObject({ replicas: 2, heldBy: `Backup/${first}` });
    // Force-deleted (finalizer stripped): its status, the only other record, is gone.
    cluster.world = { ...cluster.world, backups: [] };
    // A second backup is requested in the same instant.
    cluster.apply([
      requestBackup(
        cluster.world,
        must(cluster.world.destination),
        'identity',
        '2026-10-13T04:00:00Z',
      ),
    ]);
    const sweep = cluster.tick();
    // The sweeper gives the replicas back from the ledger; the new backup does not start yet.
    expect(scaled(sweep)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 2 }]);
    expect(sweep.some((action) => action.type === 'backup-status')).toBe(false);
    expect(cluster.replicas()).toBe(2);
    expect(cluster.held()).toEqual({});
    // Now it records 2, not 0.
    stopped(cluster);
    expect(cluster.backup()?.volume?.members).toEqual([{ name: 'identity', replicas: 2 }]);
    cluster.instances('identity', 0);
    cluster.tick();
    cluster.finishJob('Succeeded', OK);
    cluster.tick();
    expect(cluster.replicas()).toBe(2);
  });

  test('a new operation never records 0 for a held workload, even before the sweeper runs', () => {
    const world = volumeWorld({
      workloads: [workload({ replicas: 0, instances: 0 })],
      ledger: {
        resourceVersion: '7',
        entries: {
          identity: { replicas: 2, heldBy: 'Backup/gone', since: NOW, destination: 'pvc' },
        },
      },
    });
    const backup: BackupView = {
      name: 'next',
      serviceName: 'identity',
      destinationName: 'pvc',
      uid: 'uid-identity',
      type: 'workload-volume',
      className: '',
      storage: '1Gi',
      createdAt: NOW,
      source: { kind: 'workload-volume', workloadName: 'identity' },
    };
    // Without the sweeper (reconcile is per destination), the start waits.
    expect(
      reconcile({ ...world, backups: [backup] }).some((action) => action.type === 'backup-status'),
    ).toBe(false);
  });

  test('the sweeper drops entries of finished operations and leaves raised replicas alone', () => {
    const finished: BackupView = {
      name: 'done',
      serviceName: 'identity',
      destinationName: 'pvc',
      uid: 'uid-identity',
      type: 'workload-volume',
      className: '',
      storage: '1Gi',
      createdAt: NOW,
      phase: 'Succeeded',
      source: { kind: 'workload-volume', workloadName: 'identity' },
    };
    const destination = pvcDestination({
      sources: [
        { kind: 'workload-volume', workloadName: 'identity' },
        { kind: 'workload-volume', workloadName: 'vanished' },
      ],
    });
    const cluster = new Cluster(
      volumeWorld({
        destination,
        destinations: [destination],
        backups: [finished],
        workloads: [workload({ replicas: 5 })],
        ledger: {
          resourceVersion: '3',
          entries: {
            identity: { replicas: 2, heldBy: 'Backup/done', since: NOW, destination: 'pvc' },
            vanished: { replicas: 1, heldBy: 'BackupRestore/old', since: NOW, destination: 'pvc' },
          },
        },
      }),
    );
    const actions = cluster.tick();
    // A 404 on `vanished` is the only way it is skipped; it is written regardless.
    expect(scaled(actions)).toEqual([{ type: 'scale-workload', name: 'vanished', replicas: 1 }]);
    expect(cluster.replicas()).toBe(5);
    expect(cluster.held()).toEqual({});
  });

  test('a finished operation whose finalizer removal failed drops it on the next tick', () => {
    const cluster = requested();
    copying(cluster);
    cluster.finishJob('Succeeded', OK);
    cluster.fail((action) => action.type === 'finalizers');
    cluster.tick();
    expect(cluster.backup()).toMatchObject({ phase: 'Succeeded', finalizers: [FINALIZER] });
    const next = cluster.tick();
    expect(next).toContainEqual(expect.objectContaining({ type: 'finalizers', finalizers: [] }));
    expect(cluster.backup()?.finalizers).toEqual([]);
  });
});

describe('W2: concurrent reconcilers', () => {
  test('a stale reconciler cannot overwrite Succeeded or start a second copy', () => {
    const cluster = requested();
    copying(cluster);
    cluster.finishJob('Succeeded', OK);
    // Both read the world now.
    const stale = cluster.world;
    cluster.tick();
    expect(cluster.backup()?.phase).toBe('Succeeded');
    const late = cluster.tickFrom(stale);
    expect(late.some((action) => action.type === 'backup-status')).toBe(true);
    expect(cluster.errors.at(-1)?.status).toBe(409);
    expect(cluster.backup()).toMatchObject({ phase: 'Succeeded', reason: 'Completed' });
    expect(cluster.replicas()).toBe(2);

    // The same race one step earlier: two reconcilers see the workload stopped.
    const race = requested();
    stopped(race);
    race.instances('identity', 0);
    const before = race.world;
    race.tick();
    race.tickFrom({ ...before, now: race.world.now });
    const copies = race.world.jobs.filter((item) => item.backupKind === 'volume-copy');
    expect(copies).toHaveLength(1);
    // Even a Job create that got through dedupes on its fixed name.
    race.apply([{ type: 'create-job', body: job([...race.log].reverse()) }]);
    expect(race.world.jobs.filter((item) => item.backupKind === 'volume-copy')).toHaveLength(1);
  });

  test('a scheduled fire seen by two reconcilers creates one Backup', () => {
    const dest = pvcDestination({
      sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule: '0 4 * * *' }],
    });
    const cluster = new Cluster(volumeWorld({ destination: dest, destinations: [dest] }));
    cluster.tick();
    // A second reconciler read the world before the fire.
    const stale = cluster.world;
    cluster.tick(30 * 60);
    expect(cluster.world.backups).toHaveLength(1);
    const name = must(cluster.backup()).name;
    // Named by the fire time, not by when a reconciler saw it.
    expect(name).toBe(`di-volume-identity-${Date.parse('2026-10-13T04:00:00Z') / 1000}`);
    const replay = cluster.tickFrom(stale);
    expect(replay.some((action) => action.type === 'create-backup')).toBe(true);
    expect(cluster.world.backups.map((item) => item.name)).toEqual([name]);
  });
});

describe('W3: a copy Job that does not start', () => {
  test('gives the replicas back after the start deadline, not the copy timeout', () => {
    const cluster = requested({
      destination: pvcDestination({
        sources: [{ kind: 'workload-volume', workloadName: 'identity', startTimeoutSeconds: 90 }],
      }),
    });
    cluster.jobsStart = false;
    copying(cluster);
    expect(cluster.tick(60).some((action) => action.type === 'delete-job')).toBe(false);
    const stop = cluster.tick(40);
    expect(cluster.types(stop).slice(0, 2)).toEqual(['backup-status', 'delete-job']);
    // A Pending pod never ran, so nothing waits for it.
    cluster.world = { ...cluster.world, jobs: [] };
    cluster.tick();
    expect(cluster.backup()).toMatchObject({
      phase: 'Failed',
      reason: 'CopyNotStarted',
      message: 'the Job did not start within 90s',
    });
    expect(cluster.replicas()).toBe(2);
    expect(must(cluster.backup()?.volume?.scaleDownSeconds)).toBeLessThan(120);
  });

  test('a probe that does not finish or fails stops the operation before any downtime', () => {
    const late = requested();
    late.autoProbe = false;
    late.tick();
    late.tick(60);
    const timedOut = late.tick(70);
    expect(late.types(timedOut)).toContain('delete-job');
    expect(late.backup()).toMatchObject({ phase: 'Failed', reason: 'PlacementTimeout' });
    expect(late.backup()?.volume?.scaleDownSeconds).toBeUndefined();
    expect(late.log.some((action) => action.type === 'scale-workload')).toBe(false);
    expect(late.backup()?.finalizers).toEqual([]);

    const broken = requested();
    broken.autoProbe = false;
    broken.tick();
    broken.finishJob('Failed', { ok: false, error: 'PlacementInvalid' });
    broken.tick();
    expect(broken.backup()).toMatchObject({ phase: 'Failed', reason: 'PlacementInvalid' });
    expect(broken.log.some((action) => action.type === 'scale-workload')).toBe(false);

    const silent = requested();
    silent.autoProbe = false;
    silent.tick();
    silent.finishJob('Failed');
    silent.tick();
    expect(silent.backup()).toMatchObject({ phase: 'Failed', reason: 'PlacementFailed' });

    // A probe Job that is missing is created again under its fixed name.
    const missing = requested();
    missing.autoProbe = false;
    missing.tick();
    missing.world = { ...missing.world, jobs: [] };
    expect(job(missing.tick(), 'volume-probe')).toBeDefined();
  });
});

describe('W4: the node that holds the volume', () => {
  const host = (name: string, node: string, extra: object = {}) => ({
    name,
    node,
    ready: true,
    hostPaths: [VOLUME],
    ...extra,
  });

  test('hosts on two nodes, ready or terminating, are ambiguous: nothing is stopped', () => {
    for (const hosts of [
      [host('h0', 'node-a'), host('h1', 'node-b')],
      [host('h0', 'node-a'), host('h1', 'node-b', { ready: false, terminating: true })],
      [host('h0', 'node-a'), host('h1', 'node-b', { ready: false })],
    ]) {
      const cluster = requested({ hosts });
      cluster.tick();
      expect(cluster.backup()).toMatchObject({ phase: 'Failed', reason: 'VolumeAmbiguous' });
      expect(cluster.log.some((action) => action.type === 'scale-workload')).toBe(false);
    }
    // Two hosts on the same node are fine.
    const same = requested({ hosts: [host('h0', 'node-a'), host('h1', 'node-a')] });
    same.tick();
    expect(same.backup()?.volume?.node).toBe('node-a');
  });

  test('a volume that moves after the probe, or while scaling down, is refused', () => {
    const afterProbe = requested();
    afterProbe.tick();
    afterProbe.world = { ...afterProbe.world, hosts: [host('h9', 'node-b')] };
    afterProbe.tick();
    expect(afterProbe.backup()).toMatchObject({ phase: 'Failed', reason: 'VolumeMoved' });
    expect(afterProbe.log.some((action) => action.type === 'scale-workload')).toBe(false);

    const scaling = requested();
    stopped(scaling);
    scaling.instances('identity', 0);
    scaling.world = { ...scaling.world, hosts: [host('h9', 'node-b')] };
    scaling.tick();
    expect(scaling.backup()).toMatchObject({ phase: 'Failed', reason: 'VolumeMoved' });
    expect(scaling.replicas()).toBe(2);

    const lost = requested();
    stopped(lost);
    lost.instances('identity', 0);
    lost.world = { ...lost.world, tenantUid: undefined };
    lost.tick();
    expect(lost.backup()).toMatchObject({ phase: 'Failed', reason: 'TenantUnknown' });
    expect(lost.replicas()).toBe(2);

    const reprobe = requested();
    reprobe.tick();
    reprobe.world = { ...reprobe.world, tenantUid: undefined };
    reprobe.tick();
    expect(reprobe.backup()).toMatchObject({ phase: 'Failed', reason: 'TenantUnknown' });
  });

  test('without a configured storageRoot the path comes from the host pods', () => {
    const k0s = `/var/lib/k0s/di-tenants/${TENANT_UID}/workloads/identity`;
    const discovered = resolveVolume(
      volumeWorld({ storageRoot: undefined, hosts: [host('h0', 'node-a', { hostPaths: [k0s] })] }),
      'identity',
    );
    expect(discovered).toMatchObject({ hostPath: k0s, node: 'node-a' });
    expect(
      resolveVolume(
        volumeWorld({
          storageRoot: undefined,
          hosts: [host('h0', 'node-a', { hostPaths: [k0s, VOLUME] })],
        }),
        'identity',
      ),
    ).toMatchObject({ reason: 'VolumeAmbiguous' });
    expect(
      resolveVolume(
        volumeWorld({ storageRoot: '/var/lib/kubesolo/', hosts: [host('h0', 'node-a')] }),
        'identity',
      ),
    ).toMatchObject({ hostPath: VOLUME });
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
    // A second click while it is queued is refused: it would stop the workload twice.
    expect(
      handle('POST', '/backups', 'destination=pvc&workload=identity', cluster.world).status,
    ).toBe(409);
    stopped(cluster);
    expect(cluster.replicas()).toBe(0);
  });

  test('a schedule is armed when first seen, then fires once per due time', () => {
    const cluster = new Cluster(
      volumeWorld({
        destination: pvcDestination({
          sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule: '0 4 * * *' }],
        }),
      }),
    );
    cluster.tick();
    // 03:30 today has no earlier fire to catch up on.
    expect(cluster.destination()?.status.sources?.[0]).toMatchObject({
      scheduleStatus: 'Armed',
      schedule: '0 4 * * *',
    });
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
    expect(suspended.destination()?.status.sources?.[0]?.scheduleStatus).toBe('Suspended');
  });

  test('editing or unsuspending a schedule re-arms it instead of firing at once', () => {
    const at = (schedule: string, suspend?: boolean) =>
      pvcDestination({
        sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule, suspend }],
      });
    const cluster = new Cluster(volumeWorld({ destination: at('30 3 * * *') }));
    cluster.tick();
    // 13:00: the new schedule last fired at 12:00, after the 03:30 run. It must not fire now.
    cluster.world = { ...cluster.world, now: '2026-10-13T13:00:00.000Z' };
    const edited = { ...at('0 12 * * *'), status: must(cluster.destination()).status };
    cluster.world = { ...cluster.world, destination: edited, destinations: [edited] };
    cluster.tick();
    expect(cluster.world.backups).toEqual([]);
    expect(cluster.destination()?.status.sources?.[0]).toMatchObject({
      schedule: '0 12 * * *',
      scheduleStatus: 'Armed',
    });
    // Suspended across a fire, then resumed: no catch-up run.
    const paused = { ...at('0 12 * * *', true), status: must(cluster.destination()).status };
    cluster.world = { ...cluster.world, destination: paused, destinations: [paused] };
    cluster.tick(24 * 3600);
    const resumed = { ...at('0 12 * * *'), status: must(cluster.destination()).status };
    cluster.world = { ...cluster.world, destination: resumed, destinations: [resumed] };
    cluster.tick();
    expect(cluster.world.backups).toEqual([]);
    cluster.tick(24 * 3600);
    expect(cluster.world.backups).toHaveLength(1);
  });

  test('an invalid schedule never runs, says so, and costs no full-year scan', () => {
    for (const schedule of ['a b c d e', '99 * * * *', '0 0 31 2 *']) {
      const cluster = new Cluster(
        volumeWorld({
          destination: pvcDestination({
            sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule }],
          }),
        }),
      );
      const started = performance.now();
      for (let i = 0; i < 20; i += 1) cluster.tick(3600);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(cluster.world.backups).toEqual([]);
      if (schedule !== '0 0 31 2 *') {
        expect(cluster.destination()?.status.sources?.[0]?.scheduleStatus).toBe('InvalidSchedule');
        expect(render(cluster.world)).toContain('invalid: it never runs');
      }
    }
  });

  test('a source with schedule "none" is on demand only and never fires (#250)', () => {
    for (const schedule of ['none', ' none ', undefined]) {
      const cluster = new Cluster(
        volumeWorld({
          destination: pvcDestination({
            sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule }],
          }),
        }),
      );
      for (let i = 0; i < 30; i += 1) cluster.tick(3600);
      expect(cluster.world.backups).toEqual([]);
      const row = cluster.destination()?.status.sources?.[0];
      expect(row?.scheduleStatus).toBe('OnDemand');
      expect(row?.schedule).toBeUndefined();
      expect(render(cluster.world)).toContain('no schedule (on demand only)');
    }
  });

  test('a fire while a backup of the source is still queued is skipped', () => {
    const dest = pvcDestination({
      sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule: '*/5 * * * *' }],
    });
    const cluster = new Cluster(volumeWorld({ destination: dest, destinations: [dest] }));
    cluster.tick();
    // A busy tenant: a dump runs, so the requested copy cannot start.
    cluster.world = {
      ...cluster.world,
      jobs: [{ name: 'dump', backupKind: 'dump', serviceName: 'orders', phase: 'Running' }],
    };
    for (let i = 0; i < 4; i += 1) cluster.tick(300);
    expect(cluster.world.backups).toHaveLength(1);
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
    const gc = job(actions, 'gc');
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

  test('a failed copy that recorded no key is pruned by its prefix', () => {
    const lost = {
      ...backup('lost', day(1), 'Failed'),
      volume: { objectPrefix: 'p/lost' },
    };
    expect(backupKeys(lost)).toEqual([
      'p/lost/data.tar',
      'p/lost/SHA256SUMS',
      'p/lost/manifest.json',
    ]);
    expect(backupKeys({ ...lost, volume: undefined })).toEqual([]);
  });
});

function succeededSource(): BackupView {
  return {
    name: 'di-volume-identity-1',
    serviceName: 'identity',
    destinationName: 'pvc',
    uid: 'uid-identity',
    type: 'workload-volume',
    className: '',
    storage: '1Gi',
    createdAt: NOW,
    phase: 'Succeeded' as const,
    objectKey:
      'di-framework/alpha/workload-volumes/identity/uid-identity/20261013T020000Z/data.tar',
    source: { kind: 'workload-volume' as const, workloadName: 'identity' },
    volume: { encfsKcv: '00112233445566778899aabbccddeeff', encfsMode: 'XTS' },
  };
}

describe('restore into a workload volume', () => {
  const source = succeededSource();

  test('places, scales the target to 0, restores on its node, and gives the replicas back', () => {
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
    const probe = JSON.stringify(job(cluster.tick(), 'volume-probe'));
    expect(probe).toContain(
      `{"name":"workloads","hostPath":{"path":"/var/lib/kubesolo/di-tenants/${TENANT_UID}/workloads","type":"Directory"}}`,
    );
    expect(probe).toContain('{"name":"workloads","mountPath":"/workloads","readOnly":true}');
    expect(probe).toContain('{"name":"BACKUP_PROBE_PATHS","value":"/workloads:/backup-pvc"}');
    const start = cluster.tick();
    expect(cluster.types(start).slice(0, 3)).toEqual([
      'restore-status',
      'ledger',
      'scale-workload',
    ]);
    expect(cluster.replicas()).toBe(0);
    cluster.instances('identity', 0);
    const text = JSON.stringify(job(cluster.tick(), 'volume-restore'));
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
    // FOWNER is not needed: DAC_OVERRIDE covers the moves, CHOWN the ownership.
    expect(text).toContain('"add":["CHOWN","DAC_OVERRIDE"]');
    cluster.finishJob('Succeeded', {
      ok: true,
      fileCount: 3,
      encfsMode: 'AEAD',
      replacedPath: 'identity.replaced-20261013T033003Z',
    });
    const done = cluster.tick();
    expect(scaled(done)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 2 }]);
    expect(restore()).toMatchObject({
      phase: 'Succeeded',
      volume: {
        stage: 'Done',
        replacedPath: 'identity.replaced-20261013T033003Z',
        fileCount: 3,
        encfsMode: 'AEAD',
      },
    });
    expect(cluster.replicas()).toBe(2);
  });

  test('a refused non-empty target fails the restore and the replicas come back', () => {
    const cluster = new Cluster(volumeWorld({ backups: [source] }));
    cluster.apply(
      handle('POST', '/restores', `source=${source.name}&workload=identity`, cluster.world).actions,
    );
    stopped(cluster);
    cluster.instances('identity', 0);
    const text = JSON.stringify(job(cluster.tick(), 'volume-restore'));
    expect(text).toContain('{"name":"BACKUP_FORCE","value":"false"}');
    expect(text).not.toContain('BACKUP_EXPECTED_KCV');
    cluster.finishJob('Failed', { ok: false, error: 'TargetNotEmpty' });
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Failed', reason: 'TargetNotEmpty' });
    expect(cluster.replicas()).toBe(2);
  });

  test('a cross-mode restore fails with both modes in the status message (#553)', () => {
    const cluster = new Cluster(volumeWorld({ backups: [source] }));
    cluster.apply(
      handle('POST', '/restores', `source=${source.name}&workload=identity`, cluster.world).actions,
    );
    stopped(cluster);
    cluster.instances('identity', 0);
    cluster.tick();
    cluster.finishJob('Failed', {
      ok: false,
      error: 'ModeMismatch',
      detail: 'backup is XTS, target is AEAD; a restore keeps the mode',
    });
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({
      phase: 'Failed',
      reason: 'ModeMismatch',
      message: 'ModeMismatch: backup is XTS, target is AEAD; a restore keeps the mode',
    });
    expect(cluster.replicas()).toBe(2);
  });

  test('a restore that stops part-way reports where the old data and the staging went', () => {
    const cluster = new Cluster(volumeWorld({ backups: [source] }));
    cluster.apply(
      handle('POST', '/restores', `source=${source.name}&workload=identity&force=on`, cluster.world)
        .actions,
    );
    stopped(cluster);
    cluster.instances('identity', 0);
    cluster.tick();
    cluster.finishJob('Failed', {
      ok: false,
      error: 'RestoreFailed',
      replacedPath: 'identity.replaced-x',
      restoringPath: 'identity.restoring-x',
    });
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({
      phase: 'Failed',
      reason: 'RestoreFailed',
      volume: { replacedPath: 'identity.replaced-x', restoringPath: 'identity.restoring-x' },
    });
  });

  test('replicas raised during a restore: a restore-specific reason, and the replaced path is kept', () => {
    const cluster = new Cluster(volumeWorld({ backups: [source] }));
    cluster.apply(
      handle('POST', '/restores', `source=${source.name}&workload=identity&force=on`, cluster.world)
        .actions,
    );
    stopped(cluster);
    cluster.instances('identity', 0);
    cluster.tick();
    cluster.apply([{ type: 'scale-workload', name: 'identity', replicas: 1 }]);
    cluster.finishJob('Succeeded', { ok: true, fileCount: 3, replacedPath: 'identity.replaced-y' });
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({
      phase: 'Failed',
      reason: 'ScaledDuringRestore',
      message: 'replicas were raised while the restore ran; the restored data is in place',
      volume: { replacedPath: 'identity.replaced-y' },
    });
  });

  test('a KCV that cannot match is refused before any downtime', () => {
    const cluster = new Cluster(volumeWorld({ backups: [source] }));
    cluster.apply(
      handle(
        'POST',
        '/restores',
        `source=${source.name}&workload=identity&kcv=${'ff'.repeat(16)}`,
        cluster.world,
      ).actions,
    );
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Failed', reason: 'KcvMismatch' });
    expect(cluster.log.some((action) => action.type === 'scale-workload')).toBe(false);
    expect(cluster.world.jobs).toEqual([]);
  });

  describe('checked against di-storage-records before anything stops (#553)', () => {
    const modeSource = (encfsMode?: string) => ({
      ...source,
      volume: { encfsKcv: source.volume?.encfsKcv, ...(encfsMode ? { encfsMode } : {}) },
    });
    const present = (keys: Record<string, StorageRecord>): StorageRecords => ({
      state: 'present',
      keys,
    });
    const requestRestore = (cluster: Cluster, backup: BackupView) =>
      cluster.apply(
        handle('POST', '/restores', `source=${backup.name}&workload=identity`, cluster.world)
          .actions,
      );
    const restoreEnv = (backup: BackupView, storageRecords?: StorageRecords) => {
      const cluster = new Cluster(
        volumeWorld({ backups: [backup], ...(storageRecords ? { storageRecords } : {}) }),
      );
      requestRestore(cluster, backup);
      stopped(cluster);
      cluster.instances('identity', 0);
      const text = JSON.stringify(job(cluster.tick(), 'volume-restore'));
      return text.match(/\{"name":"BACKUP_TARGET_MODES","value":"([^"]*)"\}/)?.[1];
    };
    const refused = (backup: BackupView, storageRecords: StorageRecords) => {
      const cluster = new Cluster(volumeWorld({ backups: [backup], storageRecords }));
      requestRestore(cluster, backup);
      cluster.tick();
      expect(cluster.log.some((action) => action.type === 'scale-workload')).toBe(false);
      expect(cluster.world.jobs).toEqual([]);
      return cluster.world.restores[0];
    };

    test('a running restore that recorded no target modes leaves the mode check to the disk', () => {
      const backup = modeSource('XTS');
      const cluster = new Cluster(volumeWorld({ backups: [backup], storageRecords: present({}) }));
      requestRestore(cluster, backup);
      cluster.world.storageRecords = present({ identity: { kind: 'Other', mode: 'XTS' } });
      cluster.tick();
      const running = must(cluster.world.restores[0]);
      expect(running.volume?.targetModes).toEqual(['XTS']);
      // Its recorded status names no accepted modes.
      delete running.volume?.targetModes;
      stopped(cluster);
      cluster.instances('identity', 0);
      const body = job(cluster.tick(), 'volume-restore');
      const text = JSON.stringify(body);
      expect(text).toContain('"BACKUP_TARGET_ROOT"');
      expect(text).not.toContain('BACKUP_TARGET_MODES');
    });

    test("absent: no record check, the backup's own mode goes to the agent", () => {
      expect(restoreEnv(modeSource('XTS'), { state: 'absent' })).toBe('XTS');
      expect(restoreEnv(modeSource('AEAD'))).toBe('AEAD');
    });

    test('a backup without encfsMode is refused before anything stops', () => {
      for (const records of [{ state: 'absent' } as const, present({})]) {
        expect(refused(modeSource(), records)).toMatchObject({
          phase: 'Failed',
          reason: 'ManifestInvalid',
          message: expect.stringContaining('records no encfsMode'),
        });
      }
    });

    test('a restore waiting for its record does not hold back a queued backup', () => {
      const backup = modeSource('XTS');
      const cluster = new Cluster(volumeWorld({ backups: [backup], storageRecords: present({}) }));
      requestRestore(cluster, backup);
      cluster.tick();
      expect(cluster.world.restores[0]).toMatchObject({ reason: 'TargetNotRecorded' });
      cluster.apply([requestBackup(cluster.world, must(cluster.world.destination), 'identity')]);
      cluster.tick();
      expect(cluster.world.restores[0]?.phase).toBeUndefined();
      expect(cluster.world.backups.find((item) => item.name !== backup.name)).toMatchObject({
        phase: 'Running',
      });
    });

    test('untrusted or malformed records refuse the restore, naming the object', () => {
      for (const state of ['untrusted', 'invalid'] as const) {
        expect(
          refused(modeSource('XTS'), { state, message: 'ConfigMap di-storage-records is bad' }),
        ).toMatchObject({
          phase: 'Failed',
          reason: 'StorageRecordsUntrusted',
          message: 'ConfigMap di-storage-records is bad',
        });
      }
    });

    test('every row of the restore table', () => {
      const accepts = (backupMode: string, record: StorageRecord) =>
        restoreEnv(modeSource(backupMode), present({ identity: record }));
      expect(accepts('XTS', { kind: 'Other', mode: 'XTS' })).toBe('XTS');
      expect(accepts('AEAD', { kind: 'PgliteEncfs', requested: 'AEAD' })).toBe('AEAD');
      expect(accepts('XTS', { kind: 'PgliteEncfs', requested: 'Off' })).toBe('XTS,AEAD');
      expect(accepts('AEAD', { kind: 'PgliteEncfs', requested: 'Off' })).toBe('XTS,AEAD');
      expect(accepts('NotEncfs', { kind: 'Other' })).toBe('XTS,NotEncfs');
      expect(accepts('XTS', { kind: 'Other' })).toBe('XTS,NotEncfs');
      const mismatch = (backupMode: string, record: StorageRecord) =>
        refused(modeSource(backupMode), present({ identity: record }));
      expect(
        mismatch('XTS', { kind: 'PgliteEncfs', requested: 'AEAD', mode: 'AEAD' }),
      ).toMatchObject({
        phase: 'Failed',
        reason: 'ModeMismatch',
        message: expect.stringMatching(
          /^backup is XTS, storage key identity accepts AEAD; .*design-200-two-slot-aead\.md section 10/,
        ),
      });
      expect(mismatch('XTS', { kind: 'PgliteEncfs', requested: 'AEAD' })).toMatchObject({
        reason: 'ModeMismatch',
      });
      expect(mismatch('NotEncfs', { kind: 'PgliteEncfs', requested: 'Off' })).toMatchObject({
        reason: 'ModeMismatch',
        message: expect.stringContaining(
          'backup is NotEncfs, storage key identity accepts XTS or AEAD',
        ),
      });
      expect(mismatch('AEAD', { kind: 'Other' })).toMatchObject({ reason: 'ModeMismatch' });
    });

    test('a key not in the copy yet waits, then starts once it is recorded', () => {
      const backup = modeSource('XTS');
      const cluster = new Cluster(volumeWorld({ backups: [backup], storageRecords: present({}) }));
      requestRestore(cluster, backup);
      cluster.tick();
      expect(cluster.world.restores[0]).toMatchObject({
        reason: 'TargetNotRecorded',
        message: expect.stringContaining('storage key identity is not in di-storage-records'),
      });
      expect(cluster.world.restores[0]?.phase).toBeUndefined();
      // Reported once, not rewritten every tick.
      expect(cluster.tick()).not.toContainEqual(
        expect.objectContaining({ type: 'restore-status' }),
      );
      expect(cluster.world.jobs).toEqual([]);
      expect(cluster.log.some((action) => action.type === 'scale-workload')).toBe(false);
      cluster.world.storageRecords = present({ identity: { kind: 'Other', mode: 'XTS' } });
      cluster.tick();
      expect(cluster.world.restores[0]).toMatchObject({
        phase: 'Running',
        volume: { targetModes: ['XTS'] },
      });
    });
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
    const request: Action = {
      type: 'create-restore',
      body: {
        metadata: { name: 'r' },
        spec: { sourceBackupName: source.name, targetWorkloadName: 'identity' },
      },
    };
    const failedRestore = new Cluster(volumeWorld({ backups: [source] }));
    failedRestore.apply([request]);
    copying(failedRestore);
    failedRestore.finishJob('Failed');
    failedRestore.tick();
    expect(failedRestore.world.restores[0]).toMatchObject({
      phase: 'Failed',
      reason: 'RestoreFailed',
    });
    // A restore whose source backup vanished mid-way still gives the replicas back.
    const orphan = new Cluster(volumeWorld({ backups: [source] }));
    orphan.apply([request]);
    stopped(orphan);
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

  test('an operation with no stage gives back what it recorded', () => {
    const stranded: RestoreView = {
      name: 'r',
      sourceBackupName: 'x',
      targetServiceName: '',
      targetWorkloadName: 'identity',
      phase: 'Running',
      volume: { members: [{ name: 'identity', replicas: 2 }] },
    };
    const cluster = new Cluster(
      volumeWorld({ restores: [stranded], workloads: [workload({ replicas: 0 })] }),
    );
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Failed', reason: 'Interrupted' });
    expect(cluster.replicas()).toBe(2);
  });

  test('a world without volume state never starts or advances a volume operation', () => {
    const unknown: World = { ...volumeWorld(), workloads: undefined, ledger: undefined };
    const cluster = requested();
    cluster.world = { ...cluster.world, ...unknown, backups: cluster.world.backups };
    expect(reconcileAll(cluster.world).some((a) => a.type === 'backup-status')).toBe(false);
  });
});

describe('#254: a dropped ledger entry is never silent', () => {
  const signals = (actions: Action[]) =>
    actions.filter((action) => action.type === 'log' || action.type === 'event');

  /** A backup holding `identity` at 0, then force-deleted past its finalizer. */
  function stranded(): { cluster: Cluster; holder: string } {
    const cluster = requested();
    stopped(cluster);
    const holder = `Backup/${must(cluster.backup()).name}`;
    expect(cluster.replicas()).toBe(0);
    expect(cluster.held().identity).toMatchObject({ heldBy: holder, destination: 'pvc' });
    cluster.world = { ...cluster.world, backups: [] };
    return { cluster, holder };
  }

  /** The workload removed from the destination's sources; its status stays as it was. */
  function unlisted(cluster: Cluster): void {
    const current = must(cluster.world.destination);
    const dest = { ...current, spec: { ...current.spec, sources: [] } };
    cluster.world = { ...cluster.world, destination: dest, destinations: [dest] };
  }

  test('a held workload whose destination is deleted gets its replicas back, with a Normal Event', () => {
    const { cluster, holder } = stranded();
    cluster.world = { ...cluster.world, destination: undefined, destinations: [] };
    const sweep = cluster.tick();
    expect(scaled(sweep)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 2 }]);
    expect(cluster.replicas()).toBe(2);
    expect(cluster.held()).toEqual({});
    const message = `WorkloadDeployment identity got its 2 replicas back from ${holder}; its BackupDestination pvc is gone.`;
    // After the scale and the ledger write, so it reports what really happened.
    expect(cluster.types(sweep)).toEqual(['scale-workload', 'ledger', 'log', 'event']);
    // If the scale meets a 404 instead, the signal says the workload was deleted (#263).
    const ifGone = {
      workload: 'identity',
      message: `WorkloadDeployment identity was deleted before its 2 replicas from ${holder} could be given back, so its entry was removed; its BackupDestination pvc is gone.`,
    };
    expect(signals(sweep)).toEqual([
      { type: 'log', message, ifGone },
      { type: 'event', eventType: 'Normal', reason: 'HeldReplicasReleased', message, ifGone },
    ]);
  });

  test('a held workload removed from sources stays at 0, with a Warning Event and a log line', () => {
    const { cluster, holder } = stranded();
    unlisted(cluster);
    const sweep = cluster.tick();
    expect(scaled(sweep)).toEqual([]);
    expect(cluster.replicas()).toBe(0);
    expect(cluster.held()).toEqual({});
    const message = `held-replicas entry for WorkloadDeployment identity (2 replicas, held by ${holder}) dropped without scaling: the workload is not a source of BackupDestination pvc. It keeps its current replicas (0); scale it by hand if it should run.`;
    expect(signals(sweep)).toEqual([
      { type: 'log', message },
      { type: 'event', eventType: 'Warning', reason: 'HeldReplicasDropped', message },
    ]);
    // Reported once: the entry is gone, so the next tick says nothing more.
    expect(signals(cluster.tick())).toEqual([]);
  });

  test('a ledger write that fails reports nothing, and the next tick reports it once', () => {
    const { cluster } = stranded();
    unlisted(cluster);
    cluster.fail((action) => action.type === 'ledger', 409);
    cluster.tick();
    expect(cluster.log.filter((action) => action.type === 'event')).toEqual([]);
    expect(cluster.held().identity).toBeDefined();
    const retry = cluster.tick();
    expect(retry.filter((action) => action.type === 'event')).toHaveLength(1);
  });

  test('an entry the sweeper drops for a workload somebody raised still says why', () => {
    const world = volumeWorld({
      workloads: [workload({ name: 'stranger', uid: 'uid-s', annotations: {} })],
      ledger: {
        resourceVersion: '3',
        entries: {
          stranger: { replicas: 4, heldBy: 'Backup/gone', since: NOW, destination: 'pvc' },
        },
      },
    });
    const actions = releaseOrphans(world);
    expect(scaled(actions)).toEqual([]);
    expect(signals(actions)[0]).toEqual({
      type: 'log',
      message:
        'held-replicas entry for WorkloadDeployment stranger (4 replicas, held by Backup/gone) dropped without scaling: the workload is not a source of BackupDestination pvc. It keeps its current replicas (2); scale it by hand if it should run.',
    });
  });

  test('a destination-gone entry for a raised workload is removed unscaled, and says so', () => {
    const world = volumeWorld({
      destination: undefined,
      destinations: [],
      ledger: {
        resourceVersion: '3',
        entries: {
          identity: {
            replicas: 4,
            heldBy: 'Backup/gone',
            since: NOW,
            destination: 'old',
            storageKey: 'identity',
          },
        },
      },
    });
    const message =
      'WorkloadDeployment identity already runs 2 replicas (4 were recorded by Backup/gone), so it was left as is and its entry was removed; its BackupDestination old is gone.';
    expect(releaseOrphans(world)).toEqual([
      { type: 'ledger', set: { identity: null }, resourceVersion: '3' },
      { type: 'log', message },
      { type: 'event', eventType: 'Normal', reason: 'HeldReplicasReleased', message },
    ]);
  });

  test('every refusal reads as a sentence, and a forged entry cannot flood the message', () => {
    const base = { replicas: 2, heldBy: 'Backup/gone', since: NOW, destination: 'pvc' };
    const world = volumeWorld({
      workloads: [
        workload({ replicas: 0, instances: 0 }),
        workload({ name: 'di-tenant-registry', uid: 'uid-r', replicas: 0, annotations: {} }),
      ],
    });
    const reasons: [string, typeof base, string][] = [
      ['Bad_Name', base, 'the name is not a WorkloadDeployment name'],
      ['identity', { ...base, replicas: 101 }, 'replicas is not a whole number from 0 to 100'],
      [
        'identity',
        { ...base, heldBy: 'Pod/x' },
        'the holder is not Backup/<name> or BackupRestore/<name>',
      ],
      ['identity', { ...base, since: 'soon' }, 'the timestamp does not parse'],
      ['di-tenant-registry', base, 'the workload is managed by the platform'],
      ['identity', { ...base, destination: '' }, 'the entry names no BackupDestination'],
      [
        'missing',
        { ...base, destination: 'old' },
        'BackupDestination old is gone and the workload is not listed with a platform storage volume',
      ],
    ];
    for (const [name, entry, reason] of reasons) {
      const actions = releaseOrphans({ ...world, ledger: { entries: { [name]: entry } } });
      const event = actions.find((action) => action.type === 'event');
      expect(event).toMatchObject({ eventType: 'Warning', reason: 'HeldReplicasDropped' });
      expect(event?.type === 'event' && event.message).toContain(
        `dropped without scaling: ${reason}.`,
      );
    }
    const missing = releaseOrphans({
      ...world,
      ledger: { entries: { missing: { ...base, destination: 'old' } } },
    });
    // #263 S4: nothing is listed, so there is nothing to scale by hand.
    const missingLog = missing.find((action) => action.type === 'log');
    expect(missingLog).toMatchObject({
      message: expect.stringContaining(
        'No WorkloadDeployment of that name is listed, so there is nothing to scale.',
      ),
    });
    expect(JSON.stringify(missingLog)).not.toContain('scale it by hand');
    const flood = releaseOrphans({
      ...world,
      ledger: { entries: { ['x'.repeat(5000)]: base } },
    });
    for (const action of signals(flood)) {
      const text = action.type === 'log' || action.type === 'event' ? action.message : '';
      expect(text.length).toBe(1024);
      expect(text.endsWith('...')).toBe(true);
    }
  });
});

describe('#263: an orphaned held-replicas entry is bound to its workload, and reported truly', () => {
  const signals = (actions: Action[]) =>
    actions.filter((action) => action.type === 'log' || action.type === 'event');

  /** A backup holding `identity` at 0, force-deleted past its finalizer, then its destination. */
  function orphaned(): { cluster: Cluster; holder: string } {
    const cluster = requested();
    stopped(cluster);
    const holder = `Backup/${must(cluster.backup()).name}`;
    expect(cluster.held().identity).toEqual({
      replicas: 2,
      heldBy: holder,
      since: expect.any(String),
      destination: 'pvc',
      storageKey: 'identity',
      workloadUid: 'uid-identity',
    });
    cluster.world = { ...cluster.world, backups: [], destination: undefined, destinations: [] };
    return { cluster, holder };
  }

  const gone = (entry: Record<string, unknown>, workloads = [workload({ replicas: 0 })]) =>
    volumeWorld({
      destination: undefined,
      destinations: [],
      workloads,
      ledger: {
        resourceVersion: '7',
        entries: {
          identity: {
            replicas: 3,
            heldBy: 'Backup/gone',
            since: NOW,
            destination: 'old',
            ...entry,
          },
        },
      },
    });

  test('S1: an orphaned entry is given back only with the storage key and uid it was held with', () => {
    const released = releaseOrphans(gone({ storageKey: 'identity', workloadUid: 'uid-identity' }));
    expect(scaled(released)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 3 }]);
    // The uid is optional: an entry of a member that was not listed when held carries none.
    const keyOnly = releaseOrphans(gone({ storageKey: 'identity' }));
    expect(scaled(keyOnly)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 3 }]);

    const refused: [Record<string, unknown>, string][] = [
      [
        { storageKey: 'reports' },
        'the storage key the entry recorded (reports) is not the workload',
      ],
      [
        { storageKey: 'identity', workloadUid: 'uid-before' },
        'the WorkloadDeployment was re-created after it was held (its uid differs)',
      ],
    ];
    for (const [entry, reason] of refused) {
      const actions = releaseOrphans(gone(entry));
      // Never scaled: the entry is removed and the workload keeps its replicas.
      expect(scaled(actions)).toEqual([]);
      expect(actions[0]).toEqual({ type: 'ledger', set: { identity: null }, resourceVersion: '7' });
      const event = actions.find((action) => action.type === 'event');
      expect(event).toMatchObject({ eventType: 'Warning', reason: 'HeldReplicasDropped' });
      expect(event?.type === 'event' && event.message).toContain(
        `dropped without scaling: BackupDestination old is gone and ${reason}`,
      );
      expect(event?.type === 'event' && event.message).toContain(
        'It keeps its current replicas (0); scale it by hand if it should run.',
      );
    }
  });

  test('W1: an entry from before the binding (no key, no uid) is given back once, and says so', () => {
    const { cluster, holder } = orphaned();
    // The entry an earlier operator wrote: no storage key and no uid.
    const { storageKey: _key, workloadUid: _uid, ...legacy } = must(cluster.held().identity);
    cluster.world = {
      ...cluster.world,
      ledger: { ...cluster.world.ledger, entries: { identity: legacy } },
    };
    const sweep = cluster.tick();
    expect(scaled(sweep)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 2 }]);
    expect(cluster.replicas()).toBe(2);
    expect(cluster.held()).toEqual({});
    const message = `WorkloadDeployment identity got its 2 replicas back from ${holder}; its BackupDestination pvc is gone (the entry was written before held entries recorded a storage key).`;
    expect(signals(sweep)).toEqual([
      { type: 'log', message, ifGone: expect.any(Object) },
      {
        type: 'event',
        eventType: 'Normal',
        reason: 'HeldReplicasReleased',
        message,
        ifGone: expect.any(Object),
      },
    ]);
    // Released once: nothing is held, so the next tick neither scales nor reports.
    const next = cluster.tick();
    expect(scaled(next)).toEqual([]);
    expect(signals(next)).toEqual([]);
    // A legacy entry with a recorded uid still has to match it.
    const recreated = releaseOrphans(gone({ workloadUid: 'uid-before' }));
    expect(scaled(recreated)).toEqual([]);
  });

  test('S3: a release whose scale finds the workload deleted says so', () => {
    const actions = releaseOrphans(gone({ storageKey: 'identity' }));
    const ifGone = {
      workload: 'identity',
      message:
        'WorkloadDeployment identity was deleted before its 3 replicas from Backup/gone could be given back, so its entry was removed; its BackupDestination old is gone.',
    };
    expect(signals(actions)).toEqual([
      { type: 'log', message: expect.stringContaining('got its 3 replicas back'), ifGone },
      {
        type: 'event',
        eventType: 'Normal',
        reason: 'HeldReplicasReleased',
        message: expect.stringContaining('got its 3 replicas back'),
        ifGone,
      },
    ]);
    // Without a scale there is no 404 to meet: no alternative message.
    const raised = releaseOrphans(gone({ storageKey: 'identity' }, [workload()]));
    expect(signals(raised).some((action) => 'ifGone' in action)).toBe(false);
  });

  test('S1: an entry naming a volume the workload no longer has never scales it', () => {
    // Relabelled onto another key, so the entry's key no longer names this workload's volume.
    const moved = workload({ replicas: 0, labels: { 'di-framework.dev/workload': 'other' } });
    const actions = releaseOrphans(gone({ storageKey: 'identity' }, [moved]));
    expect(scaled(actions)).toEqual([]);
    expect(signals(actions)[1]).toMatchObject({ eventType: 'Warning' });
  });

  test('S1: an entry whose destination exists is still checked against its spec only', () => {
    // An entry written before #263 (no key) for a listed source is still given back.
    const world = volumeWorld({
      workloads: [workload({ replicas: 0 })],
      ledger: {
        entries: {
          identity: { replicas: 2, heldBy: 'Backup/gone', since: NOW, destination: 'pvc' },
        },
      },
    });
    expect(scaled(releaseOrphans(world))).toEqual([
      { type: 'scale-workload', name: 'identity', replicas: 2 },
    ]);
  });

  test('S2: a scale that landed before a failed ledger write is still reported, once', () => {
    const { cluster, holder } = orphaned();
    cluster.fail((action) => action.type === 'ledger', 409);
    const first = cluster.tick();
    // The scale landed; the ledger write did not, so nothing was reported yet.
    expect(scaled(first)).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 2 }]);
    expect(cluster.replicas()).toBe(2);
    expect(cluster.held().identity).toBeDefined();
    expect(cluster.log.filter((action) => action.type === 'event')).toEqual([]);

    const retry = cluster.tick();
    expect(scaled(retry)).toEqual([]);
    expect(cluster.held()).toEqual({});
    const message = `WorkloadDeployment identity already has the 2 replicas ${holder} recorded, so its entry was removed without scaling; its BackupDestination pvc is gone.`;
    expect(cluster.types(retry)).toEqual(['ledger', 'log', 'event']);
    expect(signals(retry)).toEqual([
      { type: 'log', message },
      { type: 'event', eventType: 'Normal', reason: 'HeldReplicasReleased', message },
    ]);
    expect(signals(cluster.tick())).toEqual([]);
  });

  test('S2: an entry that recorded 0 replicas is removed without a scale and says 0 truly', () => {
    const actions = releaseOrphans(gone({ replicas: 0, storageKey: 'identity' }));
    const message =
      'WorkloadDeployment identity was held by Backup/gone with 0 replicas recorded, so it was not scaled and has 0; its BackupDestination old is gone.';
    expect(actions).toEqual([
      { type: 'ledger', set: { identity: null }, resourceVersion: '7' },
      { type: 'log', message },
      { type: 'event', eventType: 'Normal', reason: 'HeldReplicasReleased', message },
    ]);
    const raised = releaseOrphans(gone({ replicas: 0, storageKey: 'identity' }, [workload()]));
    expect(signals(raised)[0]).toEqual({
      type: 'log',
      message:
        'WorkloadDeployment identity was held by Backup/gone with 0 replicas recorded, so it was not scaled and has 2; its BackupDestination old is gone.',
    });
  });

  test('S2: an entry recorded at 0 whose destination exists is removed without a scale', () => {
    const world = volumeWorld({
      workloads: [workload({ replicas: 0 })],
      ledger: {
        entries: {
          identity: { replicas: 0, heldBy: 'Backup/gone', since: NOW, destination: 'pvc' },
        },
      },
    });
    expect(releaseOrphans(world)).toEqual([
      { type: 'ledger', set: { identity: null }, resourceVersion: undefined },
    ]);
  });

  test('S4: a refused entry of an unlisted workload does not ask for a scale by hand', () => {
    const actions = releaseOrphans(gone({ storageKey: 'identity' }, []));
    expect(scaled(actions)).toEqual([]);
    const event = actions.find((action) => action.type === 'event');
    expect(event?.type === 'event' && event.message).toBe(
      'held-replicas entry for WorkloadDeployment identity (3 replicas, held by Backup/gone) dropped without scaling: BackupDestination old is gone and the workload is not listed with a platform storage volume. No WorkloadDeployment of that name is listed, so there is nothing to scale.',
    );
  });
});
