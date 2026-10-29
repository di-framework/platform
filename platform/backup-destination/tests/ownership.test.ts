import { describe, expect, test } from 'bun:test';
import {
  type ControllerConfig,
  INSTALLATION,
  VERSION as TENANCY_VERSION,
  type Tenant,
  tenantResources,
} from '../../platform/src/tenancy/resources.ts';
import {
  type Action,
  type BackupView,
  type HeldEntry,
  MAX_HELD_REPLICAS,
  opJobName,
  type RestoreView,
} from '../src/model.ts';
import { heldEntryProblem, releaseOrphans, reservedWorkload } from '../src/workload.ts';
import { Cluster, NOW, pvcDestination, volumeWorld, workload } from './support/cluster.ts';

/**
 * Review 6153298607 on #247: W6 (the held-replicas ledger was tenant-writable) and W7 (a
 * re-created request reused the Jobs of the one it replaced). These began as the reviewer's
 * reproductions; each now asserts the fixed behavior.
 */

const scaled = (actions: Action[]) => actions.filter((action) => action.type === 'scale-workload');
const created = (actions: Action[]) =>
  actions.flatMap((action) =>
    action.type === 'create-job' ? [action.body as Record<string, unknown>] : [],
  );
const nameOf = (body: Record<string, unknown>) => (body.metadata as { name: string }).name;
const envOf = (body: Record<string, unknown>) =>
  JSON.stringify((body.spec as { template: unknown }).template);

function source(): BackupView {
  return {
    name: 'di-volume-identity-1',
    serviceName: 'identity',
    destinationName: 'pvc',
    uid: 'uid-identity',
    objectUid: 'uid-backup-source',
    type: 'workload-volume',
    className: '',
    storage: '1Gi',
    createdAt: NOW,
    phase: 'Succeeded',
    objectKey:
      'di-framework/alpha/workload-volumes/identity/uid-identity/20261013T020000Z/data.tar',
    source: { kind: 'workload-volume', workloadName: 'identity' },
    volume: { encfsKcv: '00112233445566778899aabbccddeeff', encfsMode: 'XTS' },
  };
}

/** A BackupRestore as `kubectl apply` makes it: every object gets its own metadata.uid. */
function kubectlRestore(name: string, objectUid: string, extra: Partial<RestoreView> = {}) {
  return {
    name,
    objectUid,
    sourceBackupName: 'di-volume-identity-1',
    targetServiceName: '',
    targetWorkloadName: 'identity',
    resourceVersion: '100',
    ...extra,
  } satisfies RestoreView;
}

/** Placing (probe) -> ScalingDown -> Copying (restore Job created). */
function runToCopy(cluster: Cluster, first = 3): Action[] {
  const actions = [...cluster.tick(first), ...cluster.tick()];
  cluster.instances('identity', 0);
  return [...actions, ...cluster.tick()];
}

const entry = (overrides: Partial<HeldEntry> = {}): HeldEntry => ({
  replicas: 2,
  heldBy: 'Backup/gone',
  since: NOW,
  destination: 'pvc',
  ...overrides,
});

describe('W6: the held-replicas ledger is out of tenant reach and checked anyway', () => {
  test('tenant roles cannot write ConfigMaps in the runtime namespace, where the ledger is', () => {
    type Rule = { apiGroups: string[]; resources: string[]; verbs: string[] };
    const cfg: ControllerConfig = {
      installation: 'test',
      namespace: 'wasmcloud',
      hostImage: 'wash:test',
      schedulerNatsUrl: 'nats://nats:4222',
    };
    const tenant: Tenant = {
      apiVersion: TENANCY_VERSION,
      kind: 'Tenant',
      metadata: {
        name: 'alpha',
        uid: 'alpha-uid',
        generation: 1,
        labels: { [INSTALLATION]: 'test' },
      },
      spec: {},
    };
    const roles = tenantResources(tenant, cfg, { data: { 'tls.key': 'x' } }).filter(
      (item) => item.kind === 'Role',
    );
    const configMapVerbs = (namespace: string) =>
      roles
        .filter((role) => role.metadata.namespace === namespace)
        .flatMap((role) => (role as unknown as { rules: Rule[] }).rules)
        .filter((rule) => rule.apiGroups.includes('') && rule.resources.includes('configmaps'))
        .flatMap((rule) => rule.verbs);
    // Why the ledger moved: di-developer edits ConfigMaps in the tenant namespace.
    expect(configMapVerbs('di-tenant-alpha')).toEqual(expect.arrayContaining(['patch', 'create']));
    // In the runtime namespace no tenant role touches ConfigMaps at all.
    expect(roles.some((role) => role.metadata.namespace === 'di-runtime-alpha')).toBe(true);
    expect(configMapVerbs('di-runtime-alpha')).toEqual([]);
  });

  test('a forged entry for the reserved registry is dropped and never scaled', () => {
    const cluster = new Cluster(
      volumeWorld({
        workloads: [
          workload(),
          workload({
            name: 'di-tenant-registry',
            uid: 'uid-reg',
            replicas: 0,
            instances: 0,
            annotations: {},
          }),
        ],
        ledger: {
          resourceVersion: '5',
          entries: { 'di-tenant-registry': entry({ replicas: 7, heldBy: 'Backup/ghost' }) },
        },
      }),
    );
    const actions = cluster.tick();
    expect(scaled(actions)).toEqual([]);
    expect(cluster.replicas('di-tenant-registry')).toBe(0);
    expect(cluster.held()).toEqual({});
  });

  test('entries the operator could not have written are refused, even in the ledger', () => {
    const world = volumeWorld({
      workloads: [
        workload({ replicas: 0, instances: 0 }),
        workload({ name: 'stranger', uid: 'uid-s', replicas: 0, instances: 0, annotations: {} }),
        workload({
          name: 'auth',
          uid: 'uid-a',
          replicas: 0,
          instances: 0,
          labels: { 'platform.di-framework.dev/component': 'tenant-auth' },
        }),
      ],
    });
    const refused: [string, HeldEntry, string][] = [
      ['stranger', entry(), 'not-a-source'],
      ['auth', entry(), 'reserved'],
      ['di-tenant-registry', entry(), 'reserved'],
      ['identity', entry({ destination: undefined }), 'destination'],
      ['identity', entry({ destination: 'Not/A.Name' }), 'destination'],
      // Gone, and the workload is not one the operator could have stopped (#254).
      ['stranger', entry({ destination: 'elsewhere' }), 'destination'],
      ['ghost', entry({ destination: 'elsewhere' }), 'destination'],
      ['auth', entry({ destination: 'elsewhere' }), 'reserved'],
      ['identity', entry({ replicas: MAX_HELD_REPLICAS + 1 }), 'replicas'],
      ['identity', entry({ replicas: -1 }), 'replicas'],
      ['identity', entry({ replicas: 1.5 }), 'replicas'],
      ['identity', entry({ heldBy: 'Deployment/x' }), 'heldBy'],
      ['identity', entry({ heldBy: 'Backup/' }), 'heldBy'],
      ['identity', entry({ since: 'yesterday' }), 'since'],
      ['Identity', entry(), 'name'],
    ];
    for (const [name, held, reason] of refused) {
      expect(heldEntryProblem(world, name, held)).toBe(reason);
      const actions = releaseOrphans({
        ...world,
        ledger: { resourceVersion: '5', entries: { [name]: held } },
      });
      // Dropped from the ledger, never scaled, and said so after the drop lands (#254).
      expect(scaled(actions)).toEqual([]);
      expect(actions.map((action) => action.type)).toEqual(['ledger', 'log', 'event']);
      expect(actions[0]).toEqual({ type: 'ledger', set: { [name]: null }, resourceVersion: '5' });
      expect(actions[2]).toMatchObject({ eventType: 'Warning', reason: 'HeldReplicasDropped' });
    }
    // The one the operator would write: a source of an existing destination, within bounds.
    expect(heldEntryProblem(world, 'identity', entry())).toBeUndefined();
    expect(heldEntryProblem(world, 'identity', entry({ replicas: 0 }))).toBeUndefined();
    expect(
      scaled(releaseOrphans({ ...world, ledger: { entries: { identity: entry() } } })),
    ).toEqual([{ type: 'scale-workload', name: 'identity', replicas: 2 }]);
  });

  test('a member sharing a source volume is eligible; a reserved one never is', () => {
    const shared = { 'di-framework.dev/workload': 'identity' };
    const world = volumeWorld({
      workloads: [
        workload(),
        workload({ name: 'identity-worker', uid: 'uid-w', labels: shared }),
        workload({
          name: 'di-tenant-registry',
          uid: 'uid-reg',
          labels: shared,
          annotations: { 'di-framework.dev/persistent-storage': 'true' },
        }),
      ],
    });
    expect(heldEntryProblem(world, 'identity-worker', entry())).toBeUndefined();
    expect(heldEntryProblem(world, 'di-tenant-registry', entry())).toBe('reserved');
    expect(reservedWorkload('di-tenant-registry')).toBe(true);
    expect(reservedWorkload('identity', workload())).toBe(false);
  });

  test('an owner swap during a restore does not start the workload beside the restore Job', () => {
    const cluster = new Cluster(volumeWorld({ backups: [source()] }));
    cluster.world = {
      ...cluster.world,
      restores: [kubectlRestore('r', 'uid-r-1', { force: true })],
    };
    runToCopy(cluster);
    expect(cluster.world.restores[0]?.volume?.stage).toBe('Copying');
    expect(cluster.replicas()).toBe(0);
    // The ledger rewritten to name a holder that is not running (whoever could write it).
    const ledger = cluster.world.ledger ?? { entries: {} };
    cluster.world = {
      ...cluster.world,
      ledger: {
        resourceVersion: `${ledger.resourceVersion}-x`,
        entries: { identity: entry({ heldBy: 'Backup/ghost' }) },
      },
    };
    const actions = cluster.tick();
    expect(scaled(actions)).toEqual([]);
    expect(cluster.replicas()).toBe(0);
    expect(
      cluster.world.jobs.some(
        (job) => job.backupKind === 'volume-restore' && job.phase === 'Running',
      ),
    ).toBe(true);
    // The restore still ends normally and gives back the replicas from its own status.
    cluster.finishJob('Succeeded', { ok: true, fileCount: 3 });
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Succeeded' });
    expect(cluster.replicas()).toBe(2);
    // The swapped entry is dropped once nothing holds the workload; the raised count stays.
    const after = cluster.tick();
    expect(scaled(after)).toEqual([]);
    expect(cluster.held()).toEqual({});
    expect(cluster.replicas()).toBe(2);
  });

  test('a restore of a reserved or non-source workload is refused before anything stops', () => {
    for (const [target, reason] of [
      ['di-tenant-registry', 'WorkloadReserved'],
      ['stranger', 'NotASource'],
    ] as const) {
      const cluster = new Cluster(
        volumeWorld({
          backups: [source()],
          workloads: [
            workload(),
            workload({ name: target, uid: `uid-${target}`, replicas: 3, instances: 3 }),
          ],
          restores: [kubectlRestore('r', 'uid-r', { targetWorkloadName: target })],
        }),
      );
      const actions = cluster.tick();
      expect(cluster.world.restores[0]).toMatchObject({ phase: 'Failed', reason });
      expect(scaled(actions)).toEqual([]);
      expect(created(actions)).toEqual([]);
      expect(cluster.replicas(target)).toBe(3);
    }
  });

  test('a tenant workload claiming the registry volume cannot get the registry stopped', () => {
    const shared = { 'di-framework.dev/workload': 'di-tenant-registry' };
    const destination = pvcDestination({
      sources: [{ kind: 'workload-volume', workloadName: 'decoy' }],
    });
    const cluster = new Cluster(
      volumeWorld({
        destination,
        destinations: [destination],
        workloads: [
          workload({ name: 'decoy', uid: 'uid-d', labels: shared }),
          workload({ name: 'di-tenant-registry', uid: 'uid-reg', replicas: 1, instances: 1 }),
        ],
        backups: [
          {
            ...source(),
            name: 'decoy-backup',
            phase: undefined,
            objectKey: undefined,
            source: { kind: 'workload-volume', workloadName: 'decoy' },
          },
        ],
      }),
    );
    const actions = cluster.tick();
    expect(cluster.backup('decoy-backup')).toMatchObject({
      phase: 'Failed',
      reason: 'WorkloadReserved',
    });
    expect(scaled(actions)).toEqual([]);
    expect(cluster.replicas('di-tenant-registry')).toBe(1);
  });
});

describe('W7: volume Jobs belong to one object, not to a name', () => {
  test('a forced retry after TargetNotEmpty, under the same name, runs a new restore', () => {
    const cluster = new Cluster(volumeWorld({ backups: [source()] }));
    cluster.world = { ...cluster.world, restores: [kubectlRestore('restore-identity', 'uid-1')] };
    runToCopy(cluster);
    cluster.finishJob('Failed', { ok: false, error: 'TargetNotEmpty' });
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Failed', reason: 'TargetNotEmpty' });
    expect(cluster.replicas()).toBe(2);
    const oldJobs = cluster.world.jobs.map((job) => job.name);
    expect(oldJobs).toHaveLength(2);

    // Deleted and re-applied with force: same name, new uid. The old Jobs stay (7 d TTL).
    cluster.remove('backuprestores', 'restore-identity');
    expect(cluster.world.restores).toEqual([]);
    cluster.world = {
      ...cluster.world,
      restores: [
        kubectlRestore('restore-identity', 'uid-2', { force: true, resourceVersion: '200' }),
      ],
    };
    const actions = runToCopy(cluster, 60);
    const jobs = created(actions);
    expect(jobs.map(nameOf)).toEqual([
      opJobName('di-vprobe', 'restore-identity', 'uid-2'),
      opJobName('di-vrestore', 'restore-identity', 'uid-2'),
    ]);
    for (const name of jobs.map(nameOf)) expect(oldJobs).not.toContain(name);
    expect(envOf(jobs[1] ?? {})).toContain('{"name":"BACKUP_FORCE","value":"true"}');
    // The new Job runs; the old outcome is not taken over.
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Running' });
    expect(cluster.world.restores[0]?.volume?.stage).toBe('Copying');
    cluster.finishJob('Succeeded', { ok: true, fileCount: 4, replacedPath: '/x.replaced-1' });
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Succeeded' });
    expect(cluster.world.restores[0]?.volume).toMatchObject({ fileCount: 4 });
    expect(cluster.replicas()).toBe(2);
  });

  test('a succeeded restore re-applied 3 days later restores again', () => {
    const cluster = new Cluster(volumeWorld({ backups: [source()] }));
    cluster.world = { ...cluster.world, restores: [kubectlRestore('r', 'uid-a')] };
    runToCopy(cluster);
    cluster.finishJob('Succeeded', { ok: true, fileCount: 3 });
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Succeeded' });
    expect(cluster.world.restores[0]?.volume?.fileCount).toBe(3);
    cluster.remove('backuprestores', 'r');

    // Within the 7-day TTL, the old Jobs still exist.
    cluster.world = {
      ...cluster.world,
      restores: [kubectlRestore('r', 'uid-b', { force: true, resourceVersion: '300' })],
    };
    const actions = runToCopy(cluster, 3 * 24 * 3600);
    expect(created(actions).map(nameOf)).toEqual([
      opJobName('di-vprobe', 'r', 'uid-b'),
      opJobName('di-vrestore', 'r', 'uid-b'),
    ]);
    // Not Succeeded from the old run: it waits for its own Job.
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Running' });
    expect(cluster.replicas()).toBe(0);
    cluster.finishJob('Succeeded', { ok: true, fileCount: 9 });
    cluster.tick();
    expect(cluster.world.restores[0]).toMatchObject({ phase: 'Succeeded' });
    expect(cluster.world.restores[0]?.volume?.fileCount).toBe(9);
    expect(cluster.replicas()).toBe(2);
  });

  test("another object's Job under the recorded name is never adopted or stopped", () => {
    // Placing: the probe name is taken by a Job of another object. Nothing is stopped.
    const placing = new Cluster(volumeWorld({ backups: [source()] }));
    placing.world = {
      ...placing.world,
      restores: [kubectlRestore('r', 'uid-new')],
      jobs: [
        {
          name: opJobName('di-vprobe', 'r', 'uid-new'),
          backupKind: 'volume-probe',
          serviceName: '',
          phase: 'Succeeded',
          message: JSON.stringify({ ok: true }),
          ownerUid: 'uid-other',
        },
      ],
    };
    placing.tick();
    const next = placing.tick();
    expect(placing.world.restores[0]).toMatchObject({ phase: 'Failed', reason: 'JobConflict' });
    expect(scaled(next)).toEqual([]);
    expect(next.some((action) => action.type === 'delete-job')).toBe(false);
    expect(placing.replicas()).toBe(2);

    // Copying: the restore Job name is taken. The replicas come back; that Job is left alone.
    const copying = new Cluster(volumeWorld({ backups: [source()] }));
    copying.world = { ...copying.world, restores: [kubectlRestore('r', 'uid-new')] };
    const name = opJobName('di-vrestore', 'r', 'uid-new');
    copying.world = {
      ...copying.world,
      jobs: [
        {
          name,
          backupKind: 'volume-restore',
          serviceName: '',
          phase: 'Succeeded',
          message: JSON.stringify({ ok: true, fileCount: 1 }),
          ownerUid: 'uid-other',
        },
      ],
    };
    runToCopy(copying);
    copying.tick();
    expect(copying.world.restores[0]).toMatchObject({ phase: 'Failed', reason: 'JobConflict' });
    expect(copying.world.jobs.find((job) => job.name === name)?.ownerUid).toBe('uid-other');
    expect(copying.log.some((action) => action.type === 'delete-job')).toBe(false);
    expect(copying.replicas()).toBe(2);
  });
});
