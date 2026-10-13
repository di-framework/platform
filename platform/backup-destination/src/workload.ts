import {
  type Action,
  type BackupView,
  COPY_TIMEOUT_SECONDS,
  type DestinationView,
  GROUP,
  JOB_GRACE_SECONDS,
  type JobView,
  jobName,
  type RestoreView,
  type Retention,
  SCALE_DOWN_TIMEOUT_SECONDS,
  type SourceStatus,
  STORAGE_ROOT,
  storageKeyOf,
  VERSION,
  type VolumeProgress,
  volumePath,
  WORKLOAD_VOLUME,
  type WorkloadView,
  type WorkloadVolumeSource,
  type World,
} from './model.ts';
import { destinationParts } from './reconcile.ts';
import { isDue } from './schedule.ts';

/**
 * Cold copies of tenant workload volumes (#232).
 *
 * A copy runs in steps, each persisted in the Backup's (or BackupRestore's) `status.volume`
 * before the next action, so an operator restart picks up where it stopped:
 * 1. record every WorkloadDeployment that shares the volume with its replicas, then scale them to 0;
 * 2. wait, bounded, until none of them has a Workload instance left;
 * 3. run the copy (or restore) Job on the node that holds the hostPath;
 * 4. give every recorded WorkloadDeployment its replicas back, on success, failure, and timeout.
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

/** Where the platform keeps this workload's volume, and which node has it mounted. */
export function resolveVolume(
  world: World,
  workloadName: string,
): Resolved | { reason: string; message: string } {
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
  const hostPath = volumePath(world.storageRoot ?? STORAGE_ROOT, world.tenantUid, key);
  const host = (world.hosts ?? []).find(
    (item) => item.ready && item.node && item.hostPaths.includes(hostPath),
  );
  if (!host?.node) {
    return {
      reason: 'VolumeNotMounted',
      message: `no ready tenant host mounts ${hostPath}; check the chart's storageRoot`,
    };
  }
  return {
    key,
    hostPath,
    node: host.node,
    // Members of one workload share the directory, so all of them stop.
    members: workloads.filter((item) => storageKeyOf(item) === key),
    image: workload.image,
    uid: workload.uid,
  };
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

interface Operation {
  /** Backup or BackupRestore name; it labels the Job. */
  name: string;
  kind: 'volume-copy' | 'volume-restore';
  volume: VolumeProgress;
  status(value: Record<string, unknown>): Action;
  /** Status fields for a finished Job. */
  result(job: JobView): { ok: boolean; fields: Record<string, unknown> };
  job(): Record<string, unknown>;
  scaleDownTimeout: number;
  copyTimeout: number;
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

/**
 * One step of a started operation. `blocked` names a reason it must not start copying (the
 * destination is suspended, misconfigured, or gone); the replicas still come back.
 */
export function advance(world: World, op: Operation, jobs: JobView[], blocked?: string): Action[] {
  const volume = op.volume;
  const members = volume.members ?? [];
  const workloads = world.workloads ?? [];
  const current = (name: string) => workloads.find((item) => item.name === name);
  const finish = (fields: Record<string, unknown>): Action[] => [
    // Replicas first: the terminal status is only written once they are back.
    ...members.flatMap((member): Action[] =>
      current(member.name)
        ? [{ type: 'scale-workload', name: member.name, replicas: member.replicas }]
        : [],
    ),
    op.status({
      ...fields,
      volume: {
        ...volume,
        ...((fields.volume as VolumeProgress | undefined) ?? {}),
        stage: 'Done',
        restoredAt: world.now,
        scaleDownSeconds: seconds(volume.scaleDownStartedAt, world.now),
      },
    }),
  ];
  const failed = (reason: string, message: string) => finish({ phase: 'Failed', reason, message });
  const scaledUp = members.some((member) => (current(member.name)?.replicas ?? 0) !== 0);
  const job = jobs.find((item) => item.backupKind === op.kind && item.backupName === op.name);
  if (volume.stage === 'ScalingDown') {
    if (blocked) return failed(blocked, `stopped before copying: ${blocked}`);
    if (scaledUp) {
      return failed('ScaleDownInterrupted', 'replicas were raised again while scaling down');
    }
    const running = members.reduce(
      (total, member) => total + (current(member.name)?.instances ?? 0),
      0,
    );
    if (running === 0) {
      const next = { ...volume, stage: 'Copying' as const, stoppedAt: world.now };
      return [
        op.status({
          phase: 'Running',
          reason: 'Copying',
          message: 'workload stopped',
          volume: next,
        }),
        { type: 'create-job', body: op.job() },
      ];
    }
    if (seconds(volume.scaleDownStartedAt, world.now) > op.scaleDownTimeout) {
      return failed(
        'ScaleDownTimeout',
        `${running} instance(s) still running after ${op.scaleDownTimeout}s`,
      );
    }
    return [];
  }
  if (job && job.phase !== 'Running') {
    const outcome = op.result(job);
    if (outcome.ok && scaledUp) {
      // Keep the key so retention can delete the objects; a failed backup is never restored.
      return finish({
        phase: 'Failed',
        reason: 'ScaledDuringCopy',
        message: 'replicas were raised while the copy ran',
        objectKey: outcome.fields.objectKey,
      });
    }
    return finish(outcome.fields);
  }
  const waited = seconds(volume.stoppedAt, world.now);
  if (job) {
    if (waited <= op.copyTimeout + JOB_GRACE_SECONDS) return [];
    return [
      { type: 'delete-job', name: job.name },
      ...failed('CopyTimeout', `the Job ran longer than ${op.copyTimeout}s`),
    ];
  }
  if (waited <= JOB_GRACE_SECONDS) return [];
  return failed('JobMissing', 'the copy Job disappeared before it finished');
}

function timeouts(source: WorkloadVolumeSource | undefined) {
  return {
    scaleDownTimeout: source?.scaleDownTimeoutSeconds ?? SCALE_DOWN_TIMEOUT_SECONDS,
    copyTimeout: source?.copyTimeoutSeconds ?? COPY_TIMEOUT_SECONDS,
  };
}

function sourceFor(dest: DestinationView | undefined, workloadName: string | undefined) {
  return dest?.spec.sources?.find((item) => item.workloadName === workloadName);
}

/** The pinned Job that copies or restores one volume. */
export function volumeJobBody(input: {
  world: World;
  name: string;
  kind: 'volume-copy' | 'volume-restore';
  ownerName: string;
  workloadName: string;
  volume: VolumeProgress;
  deadline: number;
  env: { name: string; value: string }[];
}): Record<string, unknown> {
  const { world, volume } = input;
  const parts = destinationParts(world);
  const restore = input.kind === 'volume-restore';
  const hostPath = volume.hostPath ?? '';
  const labels: Record<string, string> = {
    [`${GROUP}/component`]: 'backup-agent',
    [`${GROUP}/backup-kind`]: input.kind,
    [`${GROUP}/workload`]: input.workloadName,
    [`${GROUP}/backup-name`]: input.ownerName,
    ...(world.destination ? { [`${GROUP}/destination`]: world.destination.name } : {}),
  };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: input.name, namespace: world.runtimeNamespace, labels },
    spec: {
      // A retry would hold the workload at 0 for longer; the operator reports the failure.
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      activeDeadlineSeconds: input.deadline,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
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
                {
                  name: 'BACKUP_KIND',
                  value: restore ? 'restore-workload-volume' : 'workload-volume',
                },
                { name: 'BACKUP_OBJECT_PREFIX', value: volume.objectPrefix ?? '' },
                { name: 'BACKUP_WORKDIR', value: '/tmp' },
                { name: 'BACKUP_WORKLOAD_NAME', value: input.workloadName },
                { name: 'BACKUP_STORAGE_KEY', value: volume.storageKey ?? '' },
                { name: 'BACKUP_STAMP', value: volume.scaleDownStartedAt ?? world.now },
                ...input.env,
                ...parts.env,
              ],
              ...parts.envFrom,
              // Root only to read (or, restoring, to write and chown) files the host uid owns.
              securityContext: {
                runAsUser: 0,
                runAsGroup: 0,
                runAsNonRoot: false,
                allowPrivilegeEscalation: false,
                capabilities: {
                  drop: ['ALL'],
                  add: restore ? ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] : ['DAC_READ_SEARCH'],
                },
              },
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '100m', memory: '128Mi' },
              },
              terminationMessagePath: '/dev/termination-log',
              terminationMessagePolicy: 'File',
              volumeMounts: [
                { name: 'scratch', mountPath: '/tmp' },
                restore
                  ? { name: 'workloads', mountPath: '/workloads' }
                  : { name: 'source', mountPath: '/source', readOnly: true },
                ...parts.mounts,
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

function backupOperation(world: World, backup: BackupView): Operation {
  const source = sourceFor(world.destination, backup.source?.workloadName);
  const limits = timeouts(source);
  const volume = backup.volume ?? {};
  const unix = Math.floor(new Date(world.now).getTime() / 1000);
  const workloadName = backup.source?.workloadName ?? backup.serviceName;
  return {
    name: backup.name,
    kind: 'volume-copy',
    volume,
    ...limits,
    status: (value) => ({ type: 'backup-status', name: backup.name, status: value }),
    result(job) {
      const result = parsed(job);
      if (job.phase !== 'Succeeded' || result.ok !== true) {
        const reason = failure(job, 'CopyFailed');
        return { ok: false, fields: { phase: 'Failed', reason, message: reason } };
      }
      return {
        ok: true,
        fields: {
          phase: 'Succeeded',
          reason: 'Completed',
          message: `copied ${result.fileCount ?? 0} files`,
          digest: result.digest,
          bytes: result.bytes,
          objectKey: result.objectKey,
          volume: {
            fileCount: result.fileCount,
            encfsKcv: result.encfsKcv,
            imageDigest: result.imageDigest,
          },
        },
      };
    },
    job: () =>
      volumeJobBody({
        world,
        name: jobName('di-volume', workloadName, unix),
        kind: 'volume-copy',
        ownerName: backup.name,
        workloadName,
        volume,
        deadline: limits.copyTimeout,
        env: [
          { name: 'BACKUP_SOURCE_DIR', value: '/source' },
          { name: 'BACKUP_SOURCE_IMAGE', value: volume.image ?? '' },
        ],
      }),
  };
}

function restoreOperation(world: World, restore: RestoreView): Operation {
  const backup = world.backups.find((item) => item.name === restore.sourceBackupName);
  const limits = timeouts(sourceFor(world.destination, backup?.source?.workloadName));
  const volume = restore.volume ?? {};
  const unix = Math.floor(new Date(world.now).getTime() / 1000);
  const workloadName = restore.targetWorkloadName ?? '';
  return {
    name: restore.name,
    kind: 'volume-restore',
    volume,
    ...limits,
    status: (value) => ({ type: 'restore-status', name: restore.name, status: value }),
    result(job) {
      const result = parsed(job);
      if (job.phase !== 'Succeeded' || result.ok !== true) {
        const reason = failure(job, 'RestoreFailed');
        return { ok: false, fields: { phase: 'Failed', reason, message: reason } };
      }
      return {
        ok: true,
        fields: {
          phase: 'Succeeded',
          reason: 'Completed',
          message: `restored ${result.fileCount ?? 0} files`,
          volume: {
            fileCount: result.fileCount,
            encfsKcv: result.encfsKcv,
            replacedPath: result.replacedPath,
          },
        },
      };
    },
    job: () =>
      volumeJobBody({
        world,
        name: jobName('di-volume-restore', workloadName, unix),
        kind: 'volume-restore',
        ownerName: restore.name,
        workloadName,
        volume,
        deadline: limits.copyTimeout,
        env: [
          { name: 'BACKUP_TARGET_ROOT', value: '/workloads' },
          { name: 'BACKUP_FORCE', value: restore.force ? 'true' : 'false' },
          ...(restore.expectedKcv
            ? [{ name: 'BACKUP_EXPECTED_KCV', value: restore.expectedKcv }]
            : []),
        ],
      }),
  };
}

/** Advance every started workload operation in this (destination-scoped) world. */
export function advanceVolumes(world: World, blocked?: string): Action[] {
  const actions: Action[] = [];
  for (const backup of world.backups) {
    if (!backup.source || backup.phase !== 'Running') continue;
    actions.push(...advance(world, backupOperation(world, backup), world.jobs, blocked));
  }
  for (const restore of world.restores) {
    if (!restore.targetWorkloadName || restore.phase !== 'Running') continue;
    actions.push(...advance(world, restoreOperation(world, restore), world.jobs, blocked));
  }
  return actions;
}

function begin(
  world: World,
  workloadName: string,
  status: (value: Record<string, unknown>) => Action,
  extra: (resolved: Resolved) => Partial<VolumeProgress>,
): Action[] {
  const resolved = resolveVolume(world, workloadName);
  if ('reason' in resolved) {
    return [status({ phase: 'Failed', reason: resolved.reason, message: resolved.message })];
  }
  const volume: VolumeProgress = {
    stage: 'ScalingDown',
    members: resolved.members.map((member) => ({ name: member.name, replicas: member.replicas })),
    scaleDownStartedAt: world.now,
    node: resolved.node,
    hostPath: resolved.hostPath,
    storageKey: resolved.key,
    image: resolved.image,
    ...extra(resolved),
  };
  return [
    // The replicas are on record before anything is scaled.
    status({ phase: 'Running', reason: 'ScalingDown', message: 'scaling to 0', volume }),
    ...resolved.members.map(
      (member): Action => ({
        type: 'scale-workload',
        name: member.name,
        replicas: 0,
      }),
    ),
  ];
}

/** Start one requested backup (a Backup with a source and no phase yet). */
export function startBackup(world: World, backup: BackupView): Action[] {
  const dest = world.destination as DestinationView;
  const workloadName = backup.source?.workloadName ?? '';
  return begin(
    world,
    workloadName,
    (value) => ({ type: 'backup-status', name: backup.name, status: value }),
    (resolved) => ({
      objectPrefix: `${objectRoot(world, dest)}/workload-volumes/${workloadName}/${resolved.uid}/${compact(world.now)}`,
    }),
  );
}

/** Start one requested workload restore. */
export function startRestore(world: World, restore: RestoreView): Action[] {
  const fail = (reason: string, message: string): Action[] => [
    { type: 'restore-status', name: restore.name, status: { phase: 'Failed', reason, message } },
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
    restore.targetWorkloadName ?? '',
    (value) => ({ type: 'restore-status', name: restore.name, status: value }),
    () => ({ objectPrefix: prefix }),
  );
}

/** The next requested workload operation to start: restores first, then the oldest backup. */
export function startNext(world: World): Action[] {
  const restore = world.restores.find((item) => item.targetWorkloadName && !item.phase);
  if (restore) return startRestore(world, restore);
  const pending = world.backups
    .filter((item) => item.source && !item.phase)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return pending ? startBackup(world, pending) : [];
}

/** A requested (not yet started) workload-volume Backup. */
export function requestBackup(world: World, dest: DestinationView, workloadName: string): Action {
  const unix = Math.floor(new Date(world.now).getTime() / 1000);
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

/**
 * Sources whose schedule fired since it last did. A schedule seen for the first time only starts
 * counting: it never fires for a time before it was configured. No schedule, no runs.
 */
export function scheduleSources(
  world: World,
  dest: DestinationView,
  rows: SourceStatus[],
): { actions: Action[]; rows: SourceStatus[] } {
  const actions: Action[] = [];
  const now = new Date(world.now);
  const next = rows.map((row) => {
    const source = sourceFor(dest, row.workloadName);
    if (!source?.schedule || source.suspend) return row;
    if (!row.lastScheduledTime) return { ...row, lastScheduledTime: world.now };
    if (!isDue(source.schedule, row.lastScheduledTime, now)) return row;
    actions.push(requestBackup(world, dest, source.workloadName));
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
      ...(done
        ? {
            lastScaleDownSeconds: done.volume?.scaleDownSeconds,
            lastScaleDownTime: done.volume?.scaleDownStartedAt,
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
  const { keepLast, daily, weekly, monthly, failed } = retention;
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
  if (failed)
    doomed.push(...newest(backups.filter((item) => item.phase === 'Failed')).slice(failed));
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

/** Object keys of one backup; a workload volume has three objects beside each other. */
export function backupKeys(item: BackupView): string[] {
  if (!item.objectKey) return [];
  const dir = item.objectKey.replace(/\/[^/]+$/, '');
  return item.source
    ? [item.objectKey, `${dir}/SHA256SUMS`, `${dir}/manifest.json`]
    : [item.objectKey, `${dir}/manifest.json`];
}
