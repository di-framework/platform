import {
  type Action,
  type BackupView,
  COPY_TIMEOUT_SECONDS,
  type DestinationView,
  FINALIZER,
  GROUP,
  type HeldEntry,
  JOB_GRACE_SECONDS,
  type JobResources,
  type JobView,
  jobName,
  MAX_HELD_REPLICAS,
  NO_SCHEDULE,
  OWNER_OBJECT_LABEL,
  opJobName,
  REGISTRY_WORKLOAD,
  type RestoreView,
  type Retention,
  SCALE_DOWN_TIMEOUT_SECONDS,
  type SourceStatus,
  START_TIMEOUT_SECONDS,
  storageKeyOf,
  TENANT_AUTH_COMPONENT,
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

/**
 * A WorkloadDeployment the platform owns (#83): the tenant registry, or anything labelled as a
 * tenant-auth component. The operator never stops or scales one, whatever a request or the
 * ledger says. Mirrors the `reserved-workloads` admission rule.
 */
export function reservedWorkload(name: string, workload?: Pick<WorkloadView, 'labels'>): boolean {
  return (
    name === REGISTRY_WORKLOAD || workload?.labels[`${GROUP}/component`] === TENANT_AUTH_COMPONENT
  );
}

/**
 * Whether `name` is a source of `dest`, or shares the volume of one (a member stopped with it).
 * The destination's spec is platform-managed; nothing else decides what the operator may scale.
 */
export function sourceOf(world: World, dest: DestinationView | undefined, name: string): boolean {
  const sources = dest?.spec.sources ?? [];
  const workloads = world.workloads ?? [];
  const current = workloads.find((item) => item.name === name);
  if (reservedWorkload(name, current)) return false;
  if (sources.some((source) => source.workloadName === name)) return true;
  const key = current && storageKeyOf(current);
  if (!key) return false;
  return sources.some((source) => {
    const named = workloads.find((item) => item.name === source.workloadName);
    return !!named && !reservedWorkload(named.name, named) && storageKeyOf(named) === key;
  });
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const HELD_BY = /^(Backup|BackupRestore)\/[a-z0-9]([-.a-z0-9]{0,251}[a-z0-9])?$/;

const DNS_SUBDOMAIN = /^[a-z0-9]([-.a-z0-9]{0,251}[a-z0-9])?$/;

/** The BackupDestination an entry names, when it still exists. */
function entryDestination(world: World, entry: HeldEntry): DestinationView | undefined {
  const destinations = world.destinations ?? (world.destination ? [world.destination] : []);
  return destinations.find((item) => item.name === entry.destination);
}

/**
 * Why the sweeper refuses a ledger entry, or undefined when it is one the operator could have
 * written: a workload name, whole replicas within bounds, a `Backup/` or `BackupRestore/` holder,
 * a timestamp, a workload that is not platform-reserved, and a destination that has the workload
 * as a source. A refused entry is dropped and never scaled.
 *
 * An entry whose destination is gone (#254) is still one the operator wrote: it names the
 * destination it was written for, and it is kept when the workload is listed with a platform
 * storage volume, as every workload the operator ever stops is. There is no spec left to say the
 * workload is not a source, and leaving it at 0 would be a silent outage. With no spec to check
 * against, the entry must also be bound to that workload (#263): it records the storage key the
 * workload had when it was held, which must still be its key, and the workload's uid, when
 * recorded, must still be its uid (a re-created workload is not the one that was stopped). A
 * destination that exists and no longer names the workload is a decision: that entry is refused.
 */
export function heldEntryProblem(world: World, name: string, entry: HeldEntry): string | undefined {
  if (!DNS_LABEL.test(name)) return 'name';
  if (!Number.isInteger(entry.replicas) || entry.replicas < 0) return 'replicas';
  if (entry.replicas > MAX_HELD_REPLICAS) return 'replicas';
  if (!HELD_BY.test(entry.heldBy)) return 'heldBy';
  if (Number.isNaN(Date.parse(entry.since))) return 'since';
  const current = (world.workloads ?? []).find((item) => item.name === name);
  if (reservedWorkload(name, current)) return 'reserved';
  if (!entry.destination || !DNS_SUBDOMAIN.test(entry.destination)) return 'destination';
  const dest = entryDestination(world, entry);
  if (dest) return sourceOf(world, dest, name) ? undefined : 'not-a-source';
  const key = current && storageKeyOf(current);
  if (!current || !key) return 'destination';
  if (entry.storageKey !== key) return 'storage-key';
  if (entry.workloadUid !== undefined && entry.workloadUid !== current.uid) return 'recreated';
  return undefined;
}

/** Why an entry was refused, in words, for its Event and log line. */
function refusal(problem: string, entry: HeldEntry): string {
  switch (problem) {
    case 'name':
      return 'the name is not a WorkloadDeployment name';
    case 'replicas':
      return `replicas is not a whole number from 0 to ${MAX_HELD_REPLICAS}`;
    case 'heldBy':
      return 'the holder is not Backup/<name> or BackupRestore/<name>';
    case 'since':
      return 'the timestamp does not parse';
    case 'reserved':
      return 'the workload is managed by the platform';
    case 'not-a-source':
      return `the workload is not a source of BackupDestination ${entry.destination}`;
    case 'storage-key':
      return entry.storageKey
        ? `BackupDestination ${entry.destination} is gone and the storage key the entry recorded (${entry.storageKey}) is not the workload's`
        : `BackupDestination ${entry.destination} is gone and the entry records no storage key to match the workload against`;
    case 'recreated':
      return `BackupDestination ${entry.destination} is gone and the WorkloadDeployment was re-created after it was held (its uid differs)`;
    default:
      return entry.destination
        ? `BackupDestination ${entry.destination} is gone and the workload is not listed with a platform storage volume`
        : 'the entry names no BackupDestination';
  }
}

/** Event messages are bounded; a forged entry may carry anything. */
function bounded(text: string): string {
  return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
}

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
  const reserved = workloads.find(
    (item) =>
      reservedWorkload(item.name, item) &&
      (item.name === workloadName ||
        (storageKeyOf(item) !== undefined && storageKeyOf(item) === storageKeyOf(workload))),
  );
  if (reserved) {
    return {
      reason: 'WorkloadReserved',
      message: `WorkloadDeployment ${reserved.name} is managed by the platform`,
    };
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
  /** metadata.uid of the Backup or BackupRestore; its volume Jobs carry it. */
  objectUid?: string;
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

/**
 * The Job named in status, when it is this object's. A volume Job carries its owner's uid; one
 * that carries another uid was made for an earlier object of the same name and is never adopted.
 * Jobs from before the uid label carry none and count as the operation's own.
 */
function ownJob(
  jobs: JobView[],
  name: string | undefined,
  op: Pick<Operation, 'objectUid'>,
): { job?: JobView; foreign?: JobView } {
  const job = jobs.find((item) => item.name === name);
  if (job?.ownerUid && op.objectUid && job.ownerUid !== op.objectUid) return { foreign: job };
  return { job };
}

function conflict(job: JobView): VolumeOutcome {
  return failed(
    'JobConflict',
    `Job ${job.name} belongs to another object of this name; delete it and re-create the request`,
  );
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
  const { job: probe, foreign } = ownJob(jobs, volume.probeJob, op);
  // Nothing is held yet: stopping here costs no downtime.
  const stop = (outcome: VolumeOutcome): Action[] => [
    ...(probe?.phase === 'Running' ? [{ type: 'delete-job', name: probe.name } as Action] : []),
    ...scaleUp(world, { ...op, volume: { ...volume, outcome } }, jobs),
  ];
  if (op.deleting) return stop(failed('Cancelled', 'the request was deleted'));
  if (blocked) return stop(failed(blocked, `stopped before the scale-down: ${blocked}`));
  if (foreign) return stop(conflict(foreign));
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

/**
 * Record members in the ledger. Each entry also names the storage key and the workload uid it
 * was held with (#263), so that once its destination is gone it is given back only to the same
 * workload on the same volume.
 */
function hold(world: World, op: Operation, members: { name: string; replicas: number }[]): Action {
  const workloads = world.workloads ?? [];
  return {
    type: 'ledger',
    set: Object.fromEntries(
      members.map((member) => {
        const current = workloads.find((item) => item.name === member.name);
        const storageKey = (current && storageKeyOf(current)) ?? op.volume.storageKey;
        const entry: HeldEntry = {
          replicas: member.replicas,
          heldBy: op.ref,
          since: world.now,
          ...(world.destination ? { destination: world.destination.name } : {}),
          ...(storageKey ? { storageKey } : {}),
          ...(current?.uid ? { workloadUid: current.uid } : {}),
        };
        return [member.name, entry];
      }),
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
  const { job, foreign } = ownJob(jobs, volume.copyJob, op);
  // Another object's Job is never stopped or read; the replicas come back at once.
  if (foreign) return toScalingUp(world, op, jobs, conflict(foreign));
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

/** The volume Jobs' emptyDir: their only writable path besides the volume and the claim. */
const SCRATCH = '/scratch';

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
  /** metadata.uid of the owning Backup or BackupRestore. */
  ownerUid?: string;
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
    ...(input.ownerUid ? { [OWNER_OBJECT_LABEL]: input.ownerUid } : {}),
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
                // The root filesystem is read-only: everything writable is the pod's own scratch.
                { name: 'BACKUP_WORKDIR', value: SCRATCH },
                { name: 'HOME', value: SCRATCH },
                { name: 'TMPDIR', value: SCRATCH },
                { name: 'RCLONE_CONFIG', value: `${SCRATCH}/rclone.conf` },
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
                { name: 'scratch', mountPath: SCRATCH },
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
    objectUid: backup.objectUid,
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
        name: volume.copyJob ?? opJobName('di-vcopy', backup.name, backup.objectUid),
        kind: 'volume-copy',
        ownerName: backup.name,
        ownerUid: backup.objectUid,
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
        name: volume.probeJob ?? opJobName('di-vprobe', backup.name, backup.objectUid),
        kind: 'volume-probe',
        probing: 'volume-copy',
        ownerName: backup.name,
        ownerUid: backup.objectUid,
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
    objectUid: restore.objectUid,
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
        name: volume.copyJob ?? opJobName('di-vrestore', restore.name, restore.objectUid),
        kind: 'volume-restore',
        ownerName: restore.name,
        ownerUid: restore.objectUid,
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
        name: volume.probeJob ?? opJobName('di-vprobe', restore.name, restore.objectUid),
        kind: 'volume-probe',
        probing: 'volume-restore',
        ownerName: restore.name,
        ownerUid: restore.objectUid,
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
 *
 * Defense in depth (W6): the ledger is out of tenant reach, but an entry is still only acted on
 * when it is one the operator could have written ({@link heldEntryProblem}): a source of an
 * existing destination, never a platform-reserved workload, with bounded replicas. Anything else
 * is dropped unscaled, and says so (#254): a Warning Event `HeldReplicasDropped` on the ledger
 * in the runtime namespace, and a log line, written after the ledger write lands, because the
 * workload may be left at 0. An entry whose destination is gone is given back, with a Normal
 * Event `HeldReplicasReleased` once its removal lands, whether this tick scaled the workload or
 * an earlier one did before its ledger write failed (#263). A workload a running operation holds
 * by its own status (members, which tenants cannot write) is left to that operation, whatever
 * its entry claims.
 */
/** The `HeldReplicasReleased` message, true to what the workload has now (#263). */
function released(name: string, entry: HeldEntry, replicas: number, raised: boolean): string {
  const gone = `its BackupDestination ${entry.destination} is gone`;
  if (entry.replicas === 0) {
    return `WorkloadDeployment ${name} was held by ${entry.heldBy} with 0 replicas recorded, so it was not scaled and has ${replicas}; ${gone}.`;
  }
  if (raised) {
    return `WorkloadDeployment ${name} got its ${entry.replicas} replicas back from ${entry.heldBy}; ${gone}.`;
  }
  if (replicas === entry.replicas) {
    return `WorkloadDeployment ${name} already has the ${entry.replicas} replicas ${entry.heldBy} recorded, so its entry was removed without scaling; ${gone}.`;
  }
  return `WorkloadDeployment ${name} already runs ${replicas} replicas (${entry.replicas} were recorded by ${entry.heldBy}), so it was left as is and its entry was removed; ${gone}.`;
}

export function releaseOrphans(world: World): Action[] {
  if (!volumeStateKnown(world)) return [];
  const runningOps = [
    ...world.backups
      .filter((item) => item.source && item.phase === 'Running')
      .map((item) => ({ ref: `Backup/${item.name}`, volume: item.volume })),
    ...world.restores
      .filter((item) => item.targetWorkloadName && item.phase === 'Running')
      .map((item) => ({ ref: `BackupRestore/${item.name}`, volume: item.volume })),
  ];
  const running = new Set(runningOps.map((item) => item.ref));
  const holding = new Set(
    runningOps.flatMap((item) => (item.volume?.members ?? []).map((member) => member.name)),
  );
  const actions: Action[] = [];
  const release: Record<string, null> = {};
  // Signals go after the ledger write: an entry is reported once it is really gone.
  const signals: Action[] = [];
  const signal = (eventType: 'Normal' | 'Warning', reason: string, text: string) => {
    const message = bounded(text);
    signals.push({ type: 'log', message }, { type: 'event', eventType, reason, message });
  };
  for (const [name, entry] of Object.entries(world.ledger?.entries ?? {})) {
    if (running.has(entry.heldBy) || holding.has(name)) continue;
    release[name] = null;
    const current = (world.workloads ?? []).find((item) => item.name === name);
    const problem = heldEntryProblem(world, name, entry);
    if (problem) {
      const after = current
        ? `It keeps its current replicas (${current.replicas}); scale it by hand if it should run.`
        : 'No WorkloadDeployment of that name is listed, so there is nothing to scale.';
      signal(
        'Warning',
        'HeldReplicasDropped',
        `held-replicas entry for WorkloadDeployment ${name} (${entry.replicas} replicas, held by ${entry.heldBy}) dropped without scaling: ${refusal(problem, entry)}. ${after}`,
      );
      continue;
    }
    const raise = !current || current.replicas === 0;
    // Scaling to 0 changes nothing; an entry that recorded 0 is only removed.
    if (raise && entry.replicas > 0) {
      actions.push({ type: 'scale-workload', name, replicas: entry.replicas });
    }
    // Whatever the replicas are now, the entry goes in this tick's write and is reported after
    // it lands: a scale that landed in a tick whose ledger write failed is still reported here.
    if (current && !entryDestination(world, entry)) {
      signal('Normal', 'HeldReplicasReleased', released(name, entry, current.replicas, raise));
    }
  }
  if (Object.keys(release).length > 0) {
    actions.push({ type: 'ledger', set: release, resourceVersion: world.ledger?.resourceVersion });
  }
  return [...actions, ...signals];
}

function begin(
  world: World,
  view: { name: string; objectUid?: string; finalizers?: string[]; resourceVersion?: string },
  build: (volume: VolumeProgress) => Operation,
  extra: (resolved: Resolved) => Partial<VolumeProgress>,
  check?: () => Problem | undefined,
): Action[] {
  const shell = build({});
  const name = shell.workloadName;
  const target = (world.workloads ?? []).find((item) => item.name === name);
  // Only what the destination's spec names is ever stopped: never a platform workload.
  const scope: Problem | undefined = reservedWorkload(name, target)
    ? {
        reason: 'WorkloadReserved',
        message: `WorkloadDeployment ${name} is managed by the platform`,
      }
    : sourceOf(world, world.destination, name)
      ? undefined
      : {
          reason: 'NotASource',
          message: `WorkloadDeployment ${name} is not a source of BackupDestination ${world.destination?.name ?? ''}`,
        };
  const resolved = resolveVolume(world, name);
  const problem = scope ?? ('reason' in resolved ? resolved : check?.());
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
    // Per object, not per name: a re-created request never meets the old one's Jobs.
    probeJob: opJobName('di-vprobe', view.name, view.objectUid),
    copyJob: opJobName(prefix, view.name, view.objectUid),
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
 * so an edit or an unsuspend never stops a workload at once. No schedule (or "none"), no runs. A fire while
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
    // No schedule, or "none" (#250): on demand only. There is no fallback cron.
    if (!source?.schedule || source.schedule.trim() === NO_SCHEDULE) {
      const { schedule: _schedule, ...rest } = row;
      return { ...rest, scheduleStatus: 'OnDemand' };
    }
    if (!validCron(source.schedule)) return { ...row, scheduleStatus: 'InvalidSchedule' };
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
