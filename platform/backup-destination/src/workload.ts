import {
  type Action,
  type BackupView,
  COPY_TIMEOUT_SECONDS,
  type DestinationView,
  FINALIZER,
  GROUP,
  JOB_GRACE_SECONDS,
  type JobResources,
  type JobView,
  jobName,
  opJobName,
  type RestoreView,
  type Retention,
  SCALE_DOWN_TIMEOUT_SECONDS,
  type SourceStatus,
  START_TIMEOUT_SECONDS,
  storageKeyOf,
  VERSION,
  VOLUME_JOB_TTL_SECONDS,
  type VolumeOutcome,
  type VolumeProgress,
  volumePath,
  WORKLOAD_VOLUME,
  type WorkloadView,
  type WorkloadVolumeSource,
  type World,
} from './model.ts';
import { destinationParts } from './reconcile.ts';
import { isDue, previousFire, validCron } from './schedule.ts';

/**
 * Cold copies of tenant workload volumes (#232).
 *
 * An operation runs in stages, each persisted in the Backup's (or BackupRestore's)
 * `status.volume` before the next action, so an operator restart picks up where it stopped:
 * 1. Placing: a probe Job checks, on the node that holds the volume, that the hostPath exists and
 *    the destination mounts there. Nothing is stopped yet; a failure costs no downtime.
 * 2. ScalingDown: record every WorkloadDeployment that shares the volume with its replicas, in
 *    status and in the held-replicas ledger, then scale them to 0 and wait (bounded) until none
 *    has an instance left.
 * 3. Copying: run the copy (or restore) Job on that node, bounded in start and run time.
 * 4. ScalingUp: give every recorded WorkloadDeployment its replicas back, then write the outcome.
 *
 * Fail closed: on unknown state (a list that failed) no step runs; a running operation carries a
 * finalizer until its replicas are back; and the ledger outlives the operation, so a deleted one
 * still gets its replicas back and a later one never records 0 for a held workload.
 * The operator never reads Secret data for this, and the agent never decrypts anything.
 */

interface Resolved {
  key: string;
  hostPath: string;
  node: string;
  members: WorkloadView[];
  image?: string;
  uid: string;
}

type Problem = { reason: string; message: string };

/** The volume path's tail under any storageRoot. */
function volumeTail(tenantUid: string, key: string): string {
  return volumePath('', tenantUid, key);
}

/**
 * Where the platform keeps this workload's volume and the one node that holds it. Every tenant
 * host pod mounts every storage directory of the tenant, so the hosts that mount this path (ready,
 * starting, or terminating) are the only places its instances can have written. More than one
 * node among them is ambiguous: refuse rather than copy or restore the wrong node's directory.
 */
export function resolveVolume(world: World, workloadName: string): Resolved | Problem {
  const workloads = world.workloads ?? [];
  const workload = workloads.find((item) => item.name === workloadName);
  if (!workload) {
    return { reason: 'WorkloadNotFound', message: `WorkloadDeployment ${workloadName} not found` };
  }
  if (workload.deleting) {
    return {
      reason: 'WorkloadDeleting',
      message: `WorkloadDeployment ${workloadName} is deleting`,
    };
  }
  const key = storageKeyOf(workload);
  if (!key) {
    return {
      reason: 'NoStorage',
      message: `WorkloadDeployment ${workloadName} has no platform storage volume`,
    };
  }
  if (!world.tenantUid) {
    return { reason: 'TenantUnknown', message: 'the tenant host Deployment carries no owner uid' };
  }
  const tail = volumeTail(world.tenantUid, key);
  const configured = world.storageRoot
    ? volumePath(world.storageRoot.replace(/\/+$/, ''), world.tenantUid, key)
    : undefined;
  const mounting = (world.hosts ?? []).filter((host) =>
    host.hostPaths.some((path) =>
      configured ? path === configured : path.endsWith(tail) && path.startsWith('/'),
    ),
  );
  const paths = new Set(
    mounting.flatMap((host) =>
      host.hostPaths.filter((path) => (configured ? path === configured : path.endsWith(tail))),
    ),
  );
  const nodes = new Set(mounting.flatMap((host) => (host.node ? [host.node] : [])));
  if (nodes.size > 1 || paths.size > 1) {
    return {
      reason: 'VolumeAmbiguous',
      message: `tenant hosts on ${nodes.size} nodes mount the volume; which one holds the data is unknown`,
    };
  }
  const ready = mounting.find((host) => host.ready && !host.terminating && host.node);
  const hostPath = [...paths][0];
  if (!ready?.node || !hostPath || hostPath.split('/').includes('..')) {
    return {
      reason: 'VolumeNotMounted',
      message: `no ready tenant host mounts ${configured ?? `…${tail}`}; check the chart's storageRoot`,
    };
  }
  return {
    key,
    hostPath,
    node: ready.node,
    // Members of one workload share the directory, so all of them stop.
    members: workloads.filter((item) => storageKeyOf(item) === key),
    image: workload.image,
    uid: workload.uid,
  };
}

/** Volume steps run only on state that was read in full this tick. */
export function volumeStateKnown(world: World): boolean {
  return world.workloads !== undefined && world.ledger !== undefined;
}

function seconds(from: string | undefined, to: string): number {
  if (!from) return 0;
  return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
}

function compact(stamp: string): string {
  return stamp.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function objectRoot(world: World, dest: DestinationView): string {
  return dest.spec.prefix || `di-framework/${world.tenantNamespace.slice('di-tenant-'.length)}`;
}

/** Started copies and restores that have not given their replicas back yet. */
export function activeVolumeOps(world: Pick<World, 'backups' | 'restores'>): number {
  return (
    world.backups.filter((item) => item.source && item.phase === 'Running').length +
    world.restores.filter((item) => item.targetWorkloadName && item.phase === 'Running').length
  );
}

/** A requested or running backup of this workload already exists. */
export function backupInFlight(world: Pick<World, 'backups'>, workloadName: string): boolean {
  return world.backups.some(
    (item) =>
      item.source?.workloadName === workloadName &&
      item.phase !== 'Succeeded' &&
      item.phase !== 'Failed' &&
      !item.deleting,
  );
}

interface Operation {
  /** `Backup/<name>` or `BackupRestore/<name>`: the ledger's `heldBy`. */
  ref: string;
  name: string;
  workloadName: string;
  resource: 'backups' | 'backuprestores';
  kind: 'volume-copy' | 'volume-restore';
  volume: VolumeProgress;
  deleting: boolean;
  finalizers: string[];
  resourceVersion?: string;
  status(value: Record<string, unknown>): Action;
  /** Outcome of a finished Job. */
  result(job: JobView): VolumeOutcome;
  job(): Record<string, unknown>;
  probe(): Record<string, unknown>;
  scaleDownTimeout: number;
  copyTimeout: number;
  startTimeout: number;
}

interface JobResult {
  ok?: boolean;
  error?: string;
  digest?: string;
  bytes?: number;
  objectKey?: string;
  fileCount?: number;
  encfsKcv?: string;
  imageDigest?: string;
  replacedPath?: string;
  restoringPath?: string;
}

function parsed(job: JobView): JobResult {
  try {
    const value = JSON.parse(job.message ?? '') as JobResult;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function failure(job: JobView, fallback: string): string {
  const result = parsed(job);
  if (result.error) return result.error;
  return job.failedReason === 'DeadlineExceeded' ? 'CopyTimeout' : fallback;
}

function failed(reason: string, message: string): VolumeOutcome {
  return { phase: 'Failed', reason, message };
}

function withFinalizer(op: Operation): Action[] {
  if (op.finalizers.includes(FINALIZER)) return [];
  return [
    {
      type: 'finalizers',
      resource: op.resource,
      name: op.name,
      finalizers: [...op.finalizers, FINALIZER],
      resourceVersion: op.resourceVersion,
    },
  ];
}

function withoutFinalizer(op: Pick<Operation, 'resource' | 'name' | 'finalizers'>): Action[] {
  if (!op.finalizers.includes(FINALIZER)) return [];
  return [
    {
      type: 'finalizers',
      resource: op.resource,
      name: op.name,
      finalizers: op.finalizers.filter((item) => item !== FINALIZER),
    },
  ];
}

/**
 * Give every member its replicas back, drop the operation's ledger entries, then write the
 * outcome and drop the finalizer, in that order: a failure part-way leaves the stage at
 * ScalingUp and the next tick does the rest. A member somebody already raised is left alone.
 * A member missing from the list is still scaled; only a 404 on that write skips it.
 */
function scaleUp(world: World, op: Operation, jobs: JobView[]): Action[] {
  const volume = op.volume;
  const aborted = volume.abortedJob
    ? jobs.find((item) => item.name === volume.abortedJob)
    : undefined;
  if (
    aborted &&
    (aborted.activePods ?? 0) > 0 &&
    seconds(volume.abortedAt, world.now) <= JOB_GRACE_SECONDS
  ) {
    // A stopped restore may still be moving files: the workload must not start beside it.
    return [{ type: 'delete-job', name: aborted.name }];
  }
  const workloads = world.workloads ?? [];
  const entries = world.ledger?.entries ?? {};
  const members = volume.members ?? [];
  const actions: Action[] = members.flatMap((member): Action[] => {
    const current = workloads.find((item) => item.name === member.name);
    return !current || current.replicas === 0
      ? [{ type: 'scale-workload', name: member.name, replicas: member.replicas }]
      : [];
  });
  const release = Object.fromEntries(
    members.flatMap((member) =>
      entries[member.name]?.heldBy === op.ref ? [[member.name, null] as const] : [],
    ),
  );
  if (Object.keys(release).length > 0) {
    actions.push({ type: 'ledger', set: release, resourceVersion: world.ledger?.resourceVersion });
  }
  const outcome = volume.outcome ?? failed('Interrupted', 'the operation lost its stage');
  const { outcome: _done, abortedJob: _job, abortedAt: _at, ...kept } = volume;
  actions.push(
    op.status({
      phase: outcome.phase,
      reason: outcome.reason,
      message: outcome.message,
      ...(outcome.digest ? { digest: outcome.digest } : {}),
      ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
      ...(outcome.objectKey ? { objectKey: outcome.objectKey } : {}),
      volume: {
        ...kept,
        // A merge patch keeps fields it does not name: clear the in-flight ones.
        outcome: null,
        abortedJob: null,
        abortedAt: null,
        stage: 'Done',
        restoredAt: world.now,
        ...(volume.scaleDownStartedAt
          ? { scaleDownSeconds: seconds(volume.scaleDownStartedAt, world.now) }
          : {}),
        ...(outcome.fileCount !== undefined ? { fileCount: outcome.fileCount } : {}),
        ...(outcome.encfsKcv ? { encfsKcv: outcome.encfsKcv } : {}),
        ...(outcome.imageDigest ? { imageDigest: outcome.imageDigest } : {}),
        ...(outcome.replacedPath ? { replacedPath: outcome.replacedPath } : {}),
        ...(outcome.restoringPath ? { restoringPath: outcome.restoringPath } : {}),
      },
    }),
    ...withoutFinalizer(op),
  );
  return actions;
}

/** Record the outcome (and any Job to stop), then start giving the replicas back. */
function toScalingUp(
  world: World,
  op: Operation,
  jobs: JobView[],
  outcome: VolumeOutcome,
  stop?: JobView,
): Action[] {
  const volume: VolumeProgress = {
    ...op.volume,
    stage: 'ScalingUp',
    outcome,
    ...(stop ? { abortedJob: stop.name, abortedAt: world.now } : {}),
  };
  const recorded = op.status({
    phase: 'Running',
    reason: 'ScalingUp',
    message: `giving the replicas back: ${outcome.reason}`,
    volume,
  });
  if (stop) return [recorded, { type: 'delete-job', name: stop.name }];
  return [recorded, ...scaleUp(world, { ...op, volume }, jobs)];
}

function placing(world: World, op: Operation, jobs: JobView[], blocked?: string): Action[] {
  const volume = op.volume;
  const probe = jobs.find((item) => item.name === volume.probeJob);
  // Nothing is held yet: stopping here costs no downtime.
  const stop = (outcome: VolumeOutcome): Action[] => [
    ...(probe?.phase === 'Running' ? [{ type: 'delete-job', name: probe.name } as Action] : []),
    ...scaleUp(world, { ...op, volume: { ...volume, outcome } }, jobs),
  ];
  if (op.deleting) return stop(failed('Cancelled', 'the request was deleted'));
  if (blocked) return stop(failed(blocked, `stopped before the scale-down: ${blocked}`));
  const late = seconds(volume.placingStartedAt, world.now) > op.startTimeout;
  if (!probe || probe.phase === 'Running') {
    if (late) {
      return stop(
        failed(
          'PlacementTimeout',
          `the placement probe did not finish within ${op.startTimeout}s; nothing was stopped`,
        ),
      );
    }
    const create: Action[] = probe ? [] : [{ type: 'create-job', body: op.probe() }];
    return [...withFinalizer(op), ...create];
  }
  const result = parsed(probe);
  if (probe.phase !== 'Succeeded' || result.ok !== true) {
    const reason = result.error ?? 'PlacementFailed';
    return stop(failed(reason, `the placement probe failed (${reason}); nothing was stopped`));
  }
  const resolved = resolveVolume(world, op.workloadName);
  if ('reason' in resolved) return stop(failed(resolved.reason, resolved.message));
  if (resolved.node !== volume.node || resolved.hostPath !== volume.hostPath) {
    return stop(failed('VolumeMoved', 'the volume moved while the probe ran; nothing was stopped'));
  }
  const entries = world.ledger?.entries ?? {};
  // A held member belongs to a finished or deleted operation; the sweeper gives it back first.
  if (resolved.members.some((member) => entries[member.name])) return withFinalizer(op);
  const members = resolved.members.map((member) => ({
    name: member.name,
    replicas: member.replicas,
  }));
  const next: VolumeProgress = {
    ...volume,
    stage: 'ScalingDown',
    scaleDownStartedAt: world.now,
    members,
  };
  return [
    // The replicas are on record, in status and in the ledger, before anything is scaled.
    op.status({ phase: 'Running', reason: 'ScalingDown', message: 'scaling to 0', volume: next }),
    ...withFinalizer(op),
    hold(world, op, members),
    ...members.map(
      (member): Action => ({ type: 'scale-workload', name: member.name, replicas: 0 }),
    ),
  ];
}

function hold(world: World, op: Operation, members: { name: string; replicas: number }[]): Action {
  return {
    type: 'ledger',
    set: Object.fromEntries(
      members.map((member) => [
        member.name,
        { replicas: member.replicas, heldBy: op.ref, since: world.now },
      ]),
    ),
    resourceVersion: world.ledger?.resourceVersion,
  };
}

function scalingDown(world: World, op: Operation, jobs: JobView[], blocked?: string): Action[] {
  const volume = op.volume;
  if (op.deleting)
    return toScalingUp(world, op, jobs, failed('Cancelled', 'the request was deleted'));
  if (blocked) {
    return toScalingUp(world, op, jobs, failed(blocked, `stopped before copying: ${blocked}`));
  }
  const workloads = world.workloads ?? [];
  const entries = world.ledger?.entries ?? {};
  const members = volume.members ?? [];
  const unheld = members.filter((member) => entries[member.name]?.heldBy !== op.ref);
  const redo: Action[] = [];
  let running = 0;
  const missing: string[] = [];
  for (const member of members) {
    const current = workloads.find((item) => item.name === member.name);
    if (!current) {
      missing.push(member.name);
      continue;
    }
    running += current.instances;
    if (current.replicas === 0) continue;
    // Our scale-down did not land (a write failed after the status): do it again.
    if (current.replicas === member.replicas) {
      redo.push({ type: 'scale-workload', name: member.name, replicas: 0 });
      continue;
    }
    return toScalingUp(
      world,
      op,
      jobs,
      failed('ScaleDownInterrupted', 'replicas were raised again while scaling down'),
    );
  }
  if (unheld.length > 0 || redo.length > 0) {
    return [...withFinalizer(op), ...(unheld.length ? [hold(world, op, unheld)] : []), ...redo];
  }
  if (running === 0 && missing.length === 0) {
    const resolved = resolveVolume(world, op.workloadName);
    if ('reason' in resolved) {
      return toScalingUp(world, op, jobs, failed(resolved.reason, resolved.message));
    }
    if (resolved.node !== volume.node || resolved.hostPath !== volume.hostPath) {
      return toScalingUp(
        world,
        op,
        jobs,
        failed('VolumeMoved', 'the volume moved to another node while scaling down'),
      );
    }
    const next = { ...volume, stage: 'Copying' as const, stoppedAt: world.now };
    return [
      op.status({ phase: 'Running', reason: 'Copying', message: 'workload stopped', volume: next }),
      ...withFinalizer(op),
      { type: 'create-job', body: op.job() },
    ];
  }
  if (seconds(volume.scaleDownStartedAt, world.now) > op.scaleDownTimeout) {
    const gone = missing.length ? `; not listed: ${missing.join(', ')}` : '';
    return toScalingUp(
      world,
      op,
      jobs,
      failed(
        'ScaleDownTimeout',
        `${running} instance(s) still running after ${op.scaleDownTimeout}s${gone}`,
      ),
    );
  }
  return withFinalizer(op);
}

function copying(world: World, op: Operation, jobs: JobView[]): Action[] {
  const volume = op.volume;
  const job = jobs.find((item) => item.name === volume.copyJob);
  if (op.deleting) {
    return toScalingUp(world, op, jobs, failed('Cancelled', 'the request was deleted'), job);
  }
  if (job && job.phase !== 'Running') {
    const outcome = op.result(job);
    const workloads = world.workloads ?? [];
    const raised = (volume.members ?? []).some(
      (member) => (workloads.find((item) => item.name === member.name)?.replicas ?? 0) !== 0,
    );
    if (outcome.phase === 'Succeeded' && raised) {
      const restore = op.kind === 'volume-restore';
      // A backup keeps its key so retention can delete the objects; it is never restored.
      return toScalingUp(world, op, jobs, {
        ...outcome,
        phase: 'Failed',
        reason: restore ? 'ScaledDuringRestore' : 'ScaledDuringCopy',
        message: restore
          ? 'replicas were raised while the restore ran; the restored data is in place'
          : 'replicas were raised while the copy ran',
      });
    }
    return toScalingUp(world, op, jobs, outcome);
  }
  const waited = seconds(volume.stoppedAt, world.now);
  if (job) {
    if (!job.started && waited > op.startTimeout) {
      return toScalingUp(
        world,
        op,
        jobs,
        failed('CopyNotStarted', `the Job did not start within ${op.startTimeout}s`),
        job,
      );
    }
    if (waited > op.copyTimeout + JOB_GRACE_SECONDS) {
      return toScalingUp(
        world,
        op,
        jobs,
        failed('CopyTimeout', `the Job ran longer than ${op.copyTimeout}s`),
        job,
      );
    }
    return withFinalizer(op);
  }
  // Not there yet: the create may have failed after the status write. The name is fixed, so a
  // second create of a Job that does exist is a harmless 409.
  if (waited <= JOB_GRACE_SECONDS) {
    return [...withFinalizer(op), { type: 'create-job', body: op.job() }];
  }
  return toScalingUp(
    world,
    op,
    jobs,
    failed('JobMissing', 'the copy Job disappeared before it finished'),
  );
}

/**
 * One step of a started operation. `blocked` names a reason it must not stop the workload (the
 * destination is suspended, misconfigured, or gone); a running copy still finishes, and the
 * replicas always come back.
 */
export function advance(world: World, op: Operation, jobs: JobView[], blocked?: string): Action[] {
  if (!volumeStateKnown(world)) return [];
  switch (op.volume.stage) {
    case 'Placing':
      return placing(world, op, jobs, blocked);
    case 'ScalingDown':
      return scalingDown(world, op, jobs, blocked);
    case 'Copying':
      return copying(world, op, jobs);
    case 'ScalingUp':
      return scaleUp(world, op, jobs);
    default:
      return toScalingUp(world, op, jobs, failed('Interrupted', 'the operation lost its stage'));
  }
}

function timeouts(source: WorkloadVolumeSource | undefined) {
  return {
    scaleDownTimeout: source?.scaleDownTimeoutSeconds ?? SCALE_DOWN_TIMEOUT_SECONDS,
    copyTimeout: source?.copyTimeoutSeconds ?? COPY_TIMEOUT_SECONDS,
    startTimeout: source?.startTimeoutSeconds ?? START_TIMEOUT_SECONDS,
  };
}

function sourceFor(dest: DestinationView | undefined, workloadName: string | undefined) {
  return dest?.spec.sources?.find((item) => item.workloadName === workloadName);
}

const DEFAULT_RESOURCES = {
  requests: { cpu: '50m', memory: '64Mi' },
  limits: { cpu: '100m', memory: '128Mi' },
};

/** The default, overridden field by field. The default always fits the tenant's quota. */
export function jobResources(resources: JobResources | undefined) {
  return {
    requests: { ...DEFAULT_RESOURCES.requests, ...resources?.requests },
    limits: { ...DEFAULT_RESOURCES.limits, ...resources?.limits },
  };
}

/** The pinned Job that probes, copies, or restores one volume. */
export function volumeJobBody(input: {
  world: World;
  name: string;
  kind: 'volume-copy' | 'volume-restore' | 'volume-probe';
  /** For a probe: the operation it places. */
  probing?: 'volume-copy' | 'volume-restore';
  ownerName: string;
  workloadName: string;
  volume: VolumeProgress;
  deadline: number;
  env: { name: string; value: string }[];
  resources?: JobResources;
}): Record<string, unknown> {
  const { world, volume } = input;
  const parts = destinationParts(world);
  const probe = input.kind === 'volume-probe';
  const restore = (probe ? input.probing : input.kind) === 'volume-restore';
  const hostPath = volume.hostPath ?? '';
  const labels: Record<string, string> = {
    [`${GROUP}/component`]: 'backup-agent',
    [`${GROUP}/backup-kind`]: input.kind,
    [`${GROUP}/workload`]: input.workloadName,
    [`${GROUP}/backup-name`]: input.ownerName,
    ...(world.destination ? { [`${GROUP}/destination`]: world.destination.name } : {}),
  };
  const mount = restore ? '/workloads' : '/source';
  const agentKind = probe
    ? 'probe-placement'
    : restore
      ? 'restore-workload-volume'
      : 'workload-volume';
  // Least privilege per kind. The probe only stats mount points: no root, no capability.
  const securityContext = probe
    ? {
        runAsUser: 65532,
        runAsGroup: 65532,
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      }
    : {
        // Root only to read (or, restoring, to write and chown) files the host uid owns.
        runAsUser: 0,
        runAsGroup: 0,
        runAsNonRoot: false,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: {
          drop: ['ALL'],
          add: restore ? ['CHOWN', 'DAC_OVERRIDE'] : ['DAC_READ_SEARCH'],
        },
      };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: input.name, namespace: world.runtimeNamespace, labels },
    spec: {
      // A retry would hold the workload at 0 for longer; the operator reports the failure.
      backoffLimit: 0,
      ttlSecondsAfterFinished: VOLUME_JOB_TTL_SECONDS,
      activeDeadlineSeconds: input.deadline,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 10,
          securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  {
                    matchFields: [
                      { key: 'metadata.name', operator: 'In', values: [volume.node ?? ''] },
                    ],
                  },
                ],
              },
            },
          },
          containers: [
            {
              name: 'backup-agent',
              image: world.agentImage,
              env: [
                { name: 'BACKUP_KIND', value: agentKind },
                { name: 'BACKUP_OBJECT_PREFIX', value: volume.objectPrefix ?? '' },
                { name: 'BACKUP_WORKDIR', value: '/tmp' },
                { name: 'HOME', value: '/tmp' },
                { name: 'TMPDIR', value: '/tmp' },
                { name: 'RCLONE_CONFIG', value: '/tmp/rclone.conf' },
                { name: 'BACKUP_WORKLOAD_NAME', value: input.workloadName },
                { name: 'BACKUP_STORAGE_KEY', value: volume.storageKey ?? '' },
                { name: 'BACKUP_STAMP', value: volume.scaleDownStartedAt ?? world.now },
                ...input.env,
                ...parts.env,
              ],
              // The probe never touches the destination's contents, so it gets no credentials.
              ...(probe ? {} : parts.envFrom),
              securityContext,
              resources: probe
                ? {
                    requests: { cpu: '10m', memory: '32Mi' },
                    limits: { cpu: '100m', memory: '64Mi' },
                  }
                : jobResources(input.resources),
              terminationMessagePath: '/dev/termination-log',
              terminationMessagePolicy: 'File',
              volumeMounts: [
                { name: 'scratch', mountPath: '/tmp' },
                restore
                  ? { name: 'workloads', mountPath: mount, ...(probe ? { readOnly: true } : {}) }
                  : { name: 'source', mountPath: mount, readOnly: true },
                ...parts.mounts.map((item) => (probe ? { ...item, readOnly: true } : item)),
              ],
            },
          ],
          volumes: [
            { name: 'scratch', emptyDir: { sizeLimit: '256Mi' } },
            restore
              ? {
                  name: 'workloads',
                  hostPath: {
                    path: hostPath.slice(0, hostPath.lastIndexOf('/')),
                    type: 'Directory',
                  },
                }
              : { name: 'source', hostPath: { path: hostPath, type: 'Directory' } },
            ...parts.volumes,
          ],
        },
      },
    },
  };
}

function probePaths(world: World, restore: boolean): string {
  const parts = destinationParts(world);
  return [
    restore ? '/workloads' : '/source',
    ...parts.mounts.map((item) => String(item.mountPath)),
  ].join(':');
}

function backupOperation(world: World, backup: BackupView): Operation {
  const source = sourceFor(world.destination, backup.source?.workloadName);
  const limits = timeouts(source);
  const workloadName = backup.source?.workloadName ?? backup.serviceName;
  const volume = backup.volume ?? {};
  return {
    ref: `Backup/${backup.name}`,
    name: backup.name,
    workloadName,
    resource: 'backups',
    kind: 'volume-copy',
    volume,
    deleting: !!backup.deleting,
    finalizers: backup.finalizers ?? [],
    resourceVersion: backup.resourceVersion,
    ...limits,
    status: (value) => ({
      type: 'backup-status',
      name: backup.name,
      status: value,
      resourceVersion: backup.resourceVersion,
    }),
    result(job) {
      const result = parsed(job);
      if (job.phase !== 'Succeeded' || result.ok !== true) {
        const reason = failure(job, 'CopyFailed');
        return failed(reason, reason);
      }
      return {
        phase: 'Succeeded',
        reason: 'Completed',
        message: `copied ${result.fileCount ?? 0} files`,
        digest: result.digest,
        bytes: result.bytes,
        objectKey: result.objectKey,
        fileCount: result.fileCount,
        encfsKcv: result.encfsKcv,
        imageDigest: result.imageDigest,
      };
    },
    job: () =>
      volumeJobBody({
        world,
        name: volume.copyJob ?? opJobName('di-vcopy', backup.name),
        kind: 'volume-copy',
        ownerName: backup.name,
        workloadName,
        volume,
        deadline: limits.copyTimeout,
        resources: source?.resources,
        env: [
          { name: 'BACKUP_SOURCE_DIR', value: '/source' },
          { name: 'BACKUP_SOURCE_IMAGE', value: volume.image ?? '' },
        ],
      }),
    probe: () =>
      volumeJobBody({
        world,
        name: volume.probeJob ?? opJobName('di-vprobe', backup.name),
        kind: 'volume-probe',
        probing: 'volume-copy',
        ownerName: backup.name,
        workloadName,
        volume,
        deadline: limits.startTimeout,
        env: [{ name: 'BACKUP_PROBE_PATHS', value: probePaths(world, false) }],
      }),
  };
}

function restoreOperation(world: World, restore: RestoreView): Operation {
  const backup = world.backups.find((item) => item.name === restore.sourceBackupName);
  const source = sourceFor(world.destination, backup?.source?.workloadName);
  const limits = timeouts(source);
  const workloadName = restore.targetWorkloadName ?? '';
  const volume = restore.volume ?? {};
  return {
    ref: `BackupRestore/${restore.name}`,
    name: restore.name,
    workloadName,
    resource: 'backuprestores',
    kind: 'volume-restore',
    volume,
    deleting: !!restore.deleting,
    finalizers: restore.finalizers ?? [],
    resourceVersion: restore.resourceVersion,
    ...limits,
    status: (value) => ({
      type: 'restore-status',
      name: restore.name,
      status: value,
      resourceVersion: restore.resourceVersion,
    }),
    result(job) {
      const result = parsed(job);
      if (job.phase !== 'Succeeded' || result.ok !== true) {
        const reason = failure(job, 'RestoreFailed');
        return {
          ...failed(reason, reason),
          // Where the old data went, or the staging directory, if the move stopped part-way.
          ...(result.replacedPath ? { replacedPath: result.replacedPath } : {}),
          ...(result.restoringPath ? { restoringPath: result.restoringPath } : {}),
        };
      }
      return {
        phase: 'Succeeded',
        reason: 'Completed',
        message: `restored ${result.fileCount ?? 0} files`,
        fileCount: result.fileCount,
        encfsKcv: result.encfsKcv,
        ...(result.replacedPath ? { replacedPath: result.replacedPath } : {}),
      };
    },
    job: () =>
      volumeJobBody({
        world,
        name: volume.copyJob ?? opJobName('di-vrestore', restore.name),
        kind: 'volume-restore',
        ownerName: restore.name,
        workloadName,
        volume,
        deadline: limits.copyTimeout,
        resources: source?.resources,
        env: [
          { name: 'BACKUP_TARGET_ROOT', value: '/workloads' },
          { name: 'BACKUP_FORCE', value: restore.force ? 'true' : 'false' },
          ...(restore.expectedKcv
            ? [{ name: 'BACKUP_EXPECTED_KCV', value: restore.expectedKcv }]
            : []),
        ],
      }),
    probe: () =>
      volumeJobBody({
        world,
        name: volume.probeJob ?? opJobName('di-vprobe', restore.name),
        kind: 'volume-probe',
        probing: 'volume-restore',
        ownerName: restore.name,
        workloadName,
        volume,
        deadline: limits.startTimeout,
        env: [{ name: 'BACKUP_PROBE_PATHS', value: probePaths(world, true) }],
      }),
  };
}

/** Advance every started workload operation in this (destination-scoped) world. */
export function advanceVolumes(world: World, blocked?: string): Action[] {
  const actions: Action[] = [];
  for (const backup of world.backups) {
    if (!backup.source) continue;
    if (backup.phase === 'Running') {
      actions.push(...advance(world, backupOperation(world, backup), world.jobs, blocked));
    } else if (backup.phase) {
      // Finished, but the finalizer removal did not land.
      actions.push(
        ...withoutFinalizer({
          resource: 'backups',
          name: backup.name,
          finalizers: backup.finalizers ?? [],
        }),
      );
    }
  }
  for (const restore of world.restores) {
    if (!restore.targetWorkloadName) continue;
    if (restore.phase === 'Running') {
      actions.push(...advance(world, restoreOperation(world, restore), world.jobs, blocked));
    } else if (restore.phase) {
      actions.push(
        ...withoutFinalizer({
          resource: 'backuprestores',
          name: restore.name,
          finalizers: restore.finalizers ?? [],
        }),
      );
    }
  }
  return actions;
}

/**
 * Give the replicas back for every ledger entry whose operation is not running any more: it was
 * deleted past its finalizer, or it finished without clearing the entry. A workload somebody
 * already raised keeps its replicas; one missing from the list is scaled anyway, and only a 404
 * on that write skips it.
 */
export function releaseOrphans(world: World): Action[] {
  if (!volumeStateKnown(world)) return [];
  const running = new Set([
    ...world.backups
      .filter((item) => item.source && item.phase === 'Running')
      .map((item) => `Backup/${item.name}`),
    ...world.restores
      .filter((item) => item.targetWorkloadName && item.phase === 'Running')
      .map((item) => `BackupRestore/${item.name}`),
  ]);
  const actions: Action[] = [];
  const release: Record<string, null> = {};
  for (const [name, entry] of Object.entries(world.ledger?.entries ?? {})) {
    if (running.has(entry.heldBy)) continue;
    const current = (world.workloads ?? []).find((item) => item.name === name);
    if (!current || current.replicas === 0) {
      actions.push({ type: 'scale-workload', name, replicas: entry.replicas });
    }
    release[name] = null;
  }
  if (Object.keys(release).length > 0) {
    actions.push({ type: 'ledger', set: release, resourceVersion: world.ledger?.resourceVersion });
  }
  return actions;
}

function begin(
  world: World,
  view: { name: string; finalizers?: string[]; resourceVersion?: string },
  build: (volume: VolumeProgress) => Operation,
  extra: (resolved: Resolved) => Partial<VolumeProgress>,
  check?: () => Problem | undefined,
): Action[] {
  const shell = build({});
  const resolved = resolveVolume(world, shell.workloadName);
  const problem = 'reason' in resolved ? resolved : check?.();
  if (problem) {
    return [shell.status({ phase: 'Failed', reason: problem.reason, message: problem.message })];
  }
  const found = resolved as Resolved;
  const entries = world.ledger?.entries ?? {};
  // A held member's replicas are not yet back: wait for the sweeper instead of recording 0.
  if (found.members.some((member) => entries[member.name])) return [];
  const prefix = shell.resource === 'backups' ? 'di-vcopy' : 'di-vrestore';
  const volume: VolumeProgress = {
    stage: 'Placing',
    placingStartedAt: world.now,
    node: found.node,
    hostPath: found.hostPath,
    storageKey: found.key,
    image: found.image,
    probeJob: opJobName('di-vprobe', view.name),
    copyJob: opJobName(prefix, view.name),
    ...extra(found),
  };
  const op = build(volume);
  return [
    op.status({
      phase: 'Running',
      reason: 'Placing',
      message: 'checking the node before stopping anything',
      volume,
    }),
    // Set before anything is held; removed only once the replicas are back.
    ...withFinalizer(op),
    { type: 'create-job', body: op.probe() },
  ];
}

/** Start one requested backup (a Backup with a source and no phase yet). */
export function startBackup(world: World, backup: BackupView): Action[] {
  const dest = world.destination as DestinationView;
  const workloadName = backup.source?.workloadName ?? '';
  return begin(
    world,
    backup,
    (volume) => backupOperation(world, { ...backup, volume }),
    (resolved) => ({
      objectPrefix: `${objectRoot(world, dest)}/workload-volumes/${workloadName}/${resolved.uid}/${compact(world.now)}`,
    }),
  );
}

/** Start one requested workload restore. */
export function startRestore(world: World, restore: RestoreView): Action[] {
  const status = (value: Record<string, unknown>): Action => ({
    type: 'restore-status',
    name: restore.name,
    status: value,
    resourceVersion: restore.resourceVersion,
  });
  const fail = (reason: string, message: string): Action[] => [
    status({ phase: 'Failed', reason, message }),
  ];
  const backup = world.backups.find((item) => item.name === restore.sourceBackupName);
  if (backup?.phase !== 'Succeeded' || !backup.objectKey) {
    return fail('BackupNotFound', 'source backup is not succeeded');
  }
  if (!backup.source) {
    return fail('TargetMismatch', 'source backup is not a workload-volume backup');
  }
  const prefix = backup.objectKey.replace(/\/[^/]+$/, '');
  return begin(
    world,
    restore,
    (volume) => restoreOperation(world, { ...restore, volume }),
    () => ({ objectPrefix: prefix }),
    // Known before any downtime: the agent would only refuse it after the scale-down.
    () =>
      restore.expectedKcv &&
      backup.volume?.encfsKcv &&
      restore.expectedKcv !== backup.volume.encfsKcv
        ? { reason: 'KcvMismatch', message: 'expectedKcv is not the KCV the backup recorded' }
        : undefined,
  );
}

/** The next requested workload operation to start: restores first, then the oldest backup. */
export function startNext(world: World): Action[] {
  if (!volumeStateKnown(world)) return [];
  const restore = world.restores.find(
    (item) => item.targetWorkloadName && !item.phase && !item.deleting,
  );
  if (restore) return startRestore(world, restore);
  const pending = world.backups
    .filter((item) => item.source && !item.phase && !item.deleting)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))[0];
  return pending ? startBackup(world, pending) : [];
}

/**
 * A requested (not yet started) workload-volume Backup. `at` names it: a scheduled run uses its
 * fire time, so two reconcilers that both see the fire create one Backup (the second gets 409).
 */
export function requestBackup(
  world: World,
  dest: DestinationView,
  workloadName: string,
  at: string = world.now,
): Action {
  const unix = Math.floor(new Date(at).getTime() / 1000);
  const workload = (world.workloads ?? []).find((item) => item.name === workloadName);
  return {
    type: 'create-backup',
    body: {
      apiVersion: VERSION,
      kind: 'Backup',
      metadata: {
        name: jobName('di-volume', workloadName, unix),
        namespace: world.tenantNamespace,
      },
      spec: {
        serviceName: workloadName,
        destinationName: dest.name,
        uid: workload?.uid ?? '',
        type: WORKLOAD_VOLUME,
        className: '',
        source: { kind: WORKLOAD_VOLUME, workloadName },
        tool: 'tar',
        format: WORKLOAD_VOLUME,
      },
    },
  };
}

function armed(row: SourceStatus, source: WorkloadVolumeSource, now: string): SourceStatus {
  return { ...row, schedule: source.schedule, scheduleStatus: 'Armed', lastScheduledTime: now };
}

/**
 * Sources whose schedule fired since it last did. A schedule is armed when first seen, when it
 * changes, and when it leaves suspension or invalidity: it never fires for a time before that,
 * so an edit or an unsuspend never stops a workload at once. No schedule, no runs. A fire while
 * a backup of the source is still queued or running is skipped.
 */
export function scheduleSources(
  world: World,
  dest: DestinationView,
  rows: SourceStatus[],
): { actions: Action[]; rows: SourceStatus[] } {
  const actions: Action[] = [];
  const now = new Date(world.now);
  const next = rows.map((row): SourceStatus => {
    const source = sourceFor(dest, row.workloadName);
    if (!source?.schedule) {
      const { schedule: _schedule, ...rest } = row;
      return { ...rest, scheduleStatus: 'OnDemand' };
    }
    if (!validCron(source.schedule)) return { ...row, scheduleStatus: 'ScheduleInvalid' };
    if (source.suspend) return { ...row, scheduleStatus: 'Suspended' };
    if (
      !row.lastScheduledTime ||
      row.scheduleStatus !== 'Armed' ||
      row.schedule !== source.schedule
    ) {
      return armed(row, source, world.now);
    }
    if (!isDue(source.schedule, row.lastScheduledTime, now)) return row;
    if (!backupInFlight(world, source.workloadName)) {
      const fire = previousFire(source.schedule, now) as Date;
      actions.push(requestBackup(world, dest, source.workloadName, fire.toISOString()));
    }
    return { ...row, lastScheduledTime: world.now };
  });
  return { actions, rows: next };
}

/** One status row per configured source, derived from its Backups. */
export function sourceRows(world: World, dest: DestinationView): SourceStatus[] {
  const previous = dest.status.sources ?? [];
  return (dest.spec.sources ?? []).map((source) => {
    const backups = world.backups
      .filter((item) => item.source?.workloadName === source.workloadName)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = backups[0];
    const done = backups.find((item) => item.volume?.stage === 'Done' && item.volume.restoredAt);
    const success = backups.find((item) => item.phase === 'Succeeded');
    const kept = previous.find((row) => row.workloadName === source.workloadName);
    return {
      kind: WORKLOAD_VOLUME,
      workloadName: source.workloadName,
      ...(kept?.lastScheduledTime ? { lastScheduledTime: kept.lastScheduledTime } : {}),
      ...(kept?.schedule ? { schedule: kept.schedule } : {}),
      ...(kept?.scheduleStatus ? { scheduleStatus: kept.scheduleStatus } : {}),
      ...(latest
        ? {
            lastBackupName: latest.name,
            lastReason:
              latest.phase === 'Succeeded'
                ? 'Completed'
                : (latest.reason ?? (latest.phase ? latest.phase : 'Requested')),
          }
        : {}),
      ...(success ? { lastSuccessTime: success.volume?.restoredAt ?? success.createdAt } : {}),
      ...(done?.volume?.scaleDownSeconds !== undefined
        ? {
            lastScaleDownSeconds: done.volume.scaleDownSeconds,
            lastScaleDownTime: done.volume.scaleDownStartedAt,
          }
        : {}),
    };
  });
}

function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${week}`;
}

const PERIODS: [keyof Retention, (date: Date) => string][] = [
  ['daily', (date) => date.toISOString().slice(0, 10)],
  ['weekly', isoWeek],
  ['monthly', (date) => date.toISOString().slice(0, 7)],
];

/** Backups of one source the retention rules no longer keep. Nothing without a rule. */
export function expiredVolumeBackups(
  backups: BackupView[],
  retention: Retention | undefined,
): BackupView[] {
  if (!retention) return [];
  const newest = (items: BackupView[]) =>
    [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const succeeded = newest(backups.filter((item) => item.phase === 'Succeeded' && item.objectKey));
  const doomed: BackupView[] = [];
  const { keepLast, daily, weekly, monthly, failed: failures } = retention;
  if (keepLast || daily || weekly || monthly) {
    const keep = new Set(succeeded.slice(0, keepLast ?? 0).map((item) => item.name));
    for (const [rule, bucket] of PERIODS) {
      const count = retention[rule] ?? 0;
      const seen = new Set<string>();
      for (const item of succeeded) {
        const key = bucket(new Date(item.createdAt));
        if (seen.has(key)) continue;
        if (seen.size >= count) break;
        seen.add(key);
        keep.add(item.name);
      }
    }
    doomed.push(...succeeded.filter((item) => !keep.has(item.name)));
  }
  if (failures)
    doomed.push(...newest(backups.filter((item) => item.phase === 'Failed')).slice(failures));
  return doomed;
}

/** Expired workload-volume backups for every source of this destination. */
export function expiredSources(world: World, dest: DestinationView): BackupView[] {
  return (dest.spec.sources ?? []).flatMap((source) =>
    expiredVolumeBackups(
      world.backups.filter((item) => item.source?.workloadName === source.workloadName),
      source.retention,
    ),
  );
}

/**
 * Object keys of one backup; a workload volume has three objects beside each other. A failed
 * copy that recorded no key is pruned by its prefix, so objects it may have left are not orphaned.
 */
export function backupKeys(item: BackupView): string[] {
  const prefix = item.volume?.objectPrefix;
  if (!item.objectKey && item.source && item.phase === 'Failed' && prefix) {
    return [`${prefix}/data.tar`, `${prefix}/SHA256SUMS`, `${prefix}/manifest.json`];
  }
  if (!item.objectKey) return [];
  const dir = item.objectKey.replace(/\/[^/]+$/, '');
  return item.source
    ? [item.objectKey, `${dir}/SHA256SUMS`, `${dir}/manifest.json`]
    : [item.objectKey, `${dir}/manifest.json`];
}
