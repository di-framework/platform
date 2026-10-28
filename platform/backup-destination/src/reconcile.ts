import {
  type Action,
  BACKUP_NOW,
  type BackupView,
  backupKindFor,
  type DestinationStatus,
  type DestinationView,
  DUMP_CAP_BYTES,
  destinationType,
  type Egress,
  endpointAllowed,
  GROUP,
  type JobView,
  jobName,
  NO_SCHEDULE,
  PVC_CLAIM,
  PVC_MOUNT,
  parseBytes,
  pickS3Owner,
  postgresConnectionSecret,
  type RestoreView,
  RUNTIME_SECRET,
  type ServiceStatus,
  type ServiceView,
  servicePort,
  VERSION,
  type World,
} from './model.ts';
import { isDue, validCron } from './schedule.ts';
import {
  activeVolumeOps,
  advanceVolumes,
  backupKeys,
  expiredSources,
  releaseOrphans,
  scheduleSources,
  sourceRows,
  startNext,
} from './workload.ts';

interface Result {
  ok?: boolean;
  digest?: string;
  bytes?: number;
  objectKey?: string;
  tool?: string;
  format?: string;
  error?: string;
  /** The failing tool's last line (backup agent restores, #398). */
  detail?: string;
}

/** `TargetUnreachable` (the probe never got through) or `RestoreFailed`, with the tool's line. */
function restoreMessage(parsed: Result | undefined): string {
  const error = parsed?.error ?? 'restore failed';
  return parsed?.detail ? `${error}: ${parsed.detail}` : error;
}

function resultOf(message: string | undefined): Result | undefined {
  if (!message) return undefined;
  try {
    const parsed = JSON.parse(message) as Result;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function condition(
  name: string,
  status: DestinationStatus,
  reason: string,
  message: string,
  ready: boolean,
): Action {
  return {
    type: 'destination-status',
    name,
    status: {
      ...status,
      conditions: [
        {
          type: 'Ready',
          status: ready ? 'True' : 'False',
          reason,
          message,
        },
      ],
    },
  };
}

function serviceRow(status: DestinationStatus, name: string): ServiceStatus {
  return (
    status.services?.find((row) => row.name === name) ?? {
      name,
      type: '',
    }
  );
}

function writeService(status: DestinationStatus, row: ServiceStatus): DestinationStatus {
  const services = [...(status.services ?? []).filter((item) => item.name !== row.name), row];
  return { ...status, services };
}

function attempted(row: ServiceStatus, run: string | undefined): boolean {
  return !!run && !!row.lastAttemptTime && row.lastAttemptTime >= run;
}

function order(type: ServiceView['type']): number {
  if (type === 'postgres') return 0;
  if (type === 'keyvalue') return 1;
  return 2;
}

function enrolled(world: World): ServiceView[] {
  return [...world.services].sort(
    (a, b) => order(a.type) - order(b.type) || a.name.localeCompare(b.name),
  );
}

function twoCopy(kind: string): boolean {
  return kind === 'nats' || kind === 'restore-nats' || kind === 'restore-redis';
}

function scratch(storage: string, kind: string): string {
  const bytes = parseBytes(storage) ?? 1024 ** 3;
  const overhead = 256 * 1024 ** 2;
  const limit = (twoCopy(kind) ? bytes * 2 : bytes) + overhead;
  return `${Math.ceil(limit / 1024 ** 2)}Mi`;
}

function deadline(storage: string): number {
  const gib = Math.ceil((parseBytes(storage) ?? 1024 ** 3) / 1024 ** 3);
  return Math.min(7200, 900 + 900 * gib);
}

/** Env, mounts and volumes every agent Job needs to reach the world's destination. */
export function destinationParts(world: World): {
  env: { name: string; value: string }[];
  envFrom: Record<string, unknown>;
  mounts: Record<string, unknown>[];
  volumes: Record<string, unknown>[];
} {
  const dest = world.destination;
  const destType = destinationType(dest?.spec);
  const env = [
    { name: 'BACKUP_BUCKET', value: dest?.spec.bucket ?? '' },
    { name: 'BACKUP_REGION', value: dest?.spec.region || 'us-east-1' },
    { name: 'BACKUP_DESTINATION_TYPE', value: destType },
    ...(destType === 'pvc' ? [{ name: 'BACKUP_PVC_MOUNT_PATH', value: PVC_MOUNT }] : []),
    ...(dest?.spec.endpoint ? [{ name: 'BACKUP_ENDPOINT', value: dest.spec.endpoint }] : []),
  ];
  return {
    env,
    // Only S3 has credentials. A PVC destination never creates the runtime Secret.
    envFrom:
      destType === 's3'
        ? { envFrom: [{ secretRef: { name: RUNTIME_SECRET, optional: false } }] }
        : {},
    mounts: destType === 'pvc' ? [{ name: 'backup-pvc', mountPath: PVC_MOUNT }] : [],
    volumes:
      destType === 'pvc'
        ? [
            {
              name: 'backup-pvc',
              persistentVolumeClaim: { claimName: dest?.spec.existingClaimName || PVC_CLAIM },
            },
          ]
        : [],
  };
}

export function jobBody(input: {
  world: World;
  name: string;
  backupKind: JobView['backupKind'];
  agentKind: string;
  service?: ServiceView;
  objectPrefix: string;
  backupName?: string;
  gcKeys?: string;
  gcBackups?: string[];
  storage?: string;
}): Record<string, unknown> {
  const service = input.service;
  const kind = input.agentKind;
  const storage = input.storage ?? service?.storage ?? '1Gi';
  const dest = input.world.destination;
  const parts = destinationParts(input.world);
  const env: { name: string; value?: string; valueFrom?: unknown }[] = [
    { name: 'BACKUP_KIND', value: kind },
    { name: 'BACKUP_OBJECT_PREFIX', value: input.objectPrefix },
    { name: 'BACKUP_WORKDIR', value: '/tmp' },
    ...parts.env,
  ];
  if (service) {
    env.push(
      {
        name: 'BACKUP_HOST',
        value: `di-bs-${service.name}.${input.world.runtimeNamespace}.svc.cluster.local`,
      },
      { name: 'BACKUP_PORT', value: servicePort(service.type) },
    );
  }
  if (
    kind === 'postgres' ||
    kind === 'restore-postgres' ||
    (kind === 'probe-empty' && service?.type === 'postgres')
  ) {
    const secret = service ? postgresConnectionSecret(service.name, service.uid) : '';
    env.push(
      { name: 'PGUSER', valueFrom: { secretKeyRef: { name: secret, key: 'username' } } },
      { name: 'PGPASSWORD', valueFrom: { secretKeyRef: { name: secret, key: 'password' } } },
      { name: 'PGDATABASE', value: 'app' },
    );
  }
  if (kind === 'gc') env.push({ name: 'BACKUP_GC_KEYS', value: input.gcKeys ?? '' });
  const labels: Record<string, string> = {
    [`${GROUP}/component`]: 'backup-agent',
    [`${GROUP}/backup-kind`]: input.backupKind,
    ...(service ? { [`${GROUP}/service`]: service.name } : {}),
    ...(input.backupName ? { [`${GROUP}/backup-name`]: input.backupName } : {}),
    ...(dest ? { [`${GROUP}/destination`]: dest.name } : {}),
  };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: input.name,
      namespace: input.world.runtimeNamespace,
      labels,
      annotations: input.gcBackups ? { [`${GROUP}/gc-backups`]: input.gcBackups.join(',') } : {},
    },
    spec: {
      backoffLimit: 2,
      ttlSecondsAfterFinished: 600,
      activeDeadlineSeconds: deadline(storage),
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          containers: [
            {
              name: 'backup-agent',
              image: input.world.agentImage,
              env,
              ...parts.envFrom,
              resources: {
                requests: { cpu: '50m', memory: '64Mi', 'ephemeral-storage': storage },
                limits: { cpu: '100m', memory: '128Mi' },
              },
              terminationMessagePath: '/dev/termination-log',
              terminationMessagePolicy: 'File',
              volumeMounts: [{ name: 'scratch', mountPath: '/tmp' }, ...parts.mounts],
            },
          ],
          volumes: [
            { name: 'scratch', emptyDir: { sizeLimit: scratch(storage, kind) } },
            ...parts.volumes,
          ],
        },
      },
    },
  };
}

function prefixFor(
  dest: DestinationView,
  tenantNamespace: string,
  service: ServiceView,
  stamp: string,
): string {
  const tenant = tenantNamespace.slice('di-tenant-'.length);
  const root = dest.spec.prefix || `di-framework/${tenant}`;
  return `${root}/${service.name}/${service.uid}/${stamp}`;
}

function stamp(now: string): string {
  return now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function observe(world: World, actions: Action[]): void {
  for (const job of world.jobs) {
    if (job.phase === 'Running') continue;
    const parsed = resultOf(job.message);
    const failed = job.phase === 'Failed' || parsed?.ok === false;
    if (job.backupKind === 'dump' && job.backupName) {
      const backup = world.backups.find((item) => item.name === job.backupName);
      if (!backup || backup.phase === 'Succeeded' || backup.phase === 'Failed') continue;
      actions.push({
        type: 'backup-status',
        name: backup.name,
        status: failed
          ? {
              phase: 'Failed',
              reason: parsed?.error ?? 'DumpFailed',
              message: parsed?.error ?? 'dump failed',
            }
          : {
              phase: 'Succeeded',
              reason: 'Completed',
              message: parsed?.format ?? 'completed',
              digest: parsed?.digest,
              bytes: parsed?.bytes,
              objectKey: parsed?.objectKey,
            },
      });
    }
    if (job.backupKind === 'gc' && job.phase === 'Succeeded' && parsed?.ok !== false) {
      for (const name of job.gcBackups ?? []) actions.push({ type: 'delete-backup', name });
    }
    if ((job.backupKind === 'probe' || job.backupKind === 'restore') && job.backupName) {
      const restore = world.restores.find((item) => item.name === job.backupName);
      if (!restore || restore.phase === 'Succeeded' || restore.phase === 'Failed') continue;
      if (job.backupKind === 'probe' && failed) {
        actions.push({
          type: 'restore-status',
          name: restore.name,
          status: {
            phase: 'Failed',
            reason: parsed?.error ?? 'ProbeFailed',
            message: parsed?.error ?? 'probe failed',
          },
        });
      }
      if (job.backupKind === 'restore') {
        actions.push({
          type: 'restore-status',
          name: restore.name,
          status: failed
            ? {
                phase: 'Failed',
                reason: parsed?.error ?? 'RestoreFailed',
                message: restoreMessage(parsed),
              }
            : { phase: 'Succeeded', reason: 'Completed', message: 'restore completed' },
        });
      }
    }
  }
}

/** The BackingService restore in progress; workload restores run in workload.ts. */
function activeRestore(world: World): RestoreView | undefined {
  return world.restores.find(
    (item) => !item.targetWorkloadName && item.phase !== 'Succeeded' && item.phase !== 'Failed',
  );
}

function restoreActions(world: World, restore: RestoreView, actions: Action[]): void {
  const backup = world.backups.find((item) => item.name === restore.sourceBackupName);
  const target = world.services.find((item) => item.name === restore.targetServiceName);
  if (backup?.phase !== 'Succeeded' || !target) {
    actions.push({
      type: 'restore-status',
      name: restore.name,
      status: {
        phase: 'Failed',
        reason: 'BackupNotFound',
        message: 'source backup is not succeeded',
      },
    });
    return;
  }
  if (target.type !== backup.type || target.className !== backup.className) {
    actions.push({
      type: 'restore-status',
      name: restore.name,
      status: {
        phase: 'Failed',
        reason: 'TargetMismatch',
        message: 'target type or class does not match the backup',
      },
    });
    return;
  }
  const kind = backupKindFor(target.type);
  const probe = world.jobs.find(
    (job) =>
      job.backupKind === 'probe' && job.backupName === restore.name && job.phase === 'Succeeded',
  );
  const unix = Math.floor(new Date(world.now).getTime() / 1000);
  if (!probe) {
    actions.push({
      type: 'create-job',
      body: jobBody({
        world,
        name: jobName('di-probe', target.name, unix),
        backupKind: 'probe',
        agentKind: 'probe-empty',
        service: target,
        objectPrefix: '',
        backupName: restore.name,
        storage: backup.storage,
      }),
    });
    return;
  }
  const agentKind =
    kind === 'postgres' ? 'restore-postgres' : kind === 'redis' ? 'restore-redis' : 'restore-nats';
  actions.push({
    type: 'create-job',
    body: jobBody({
      world,
      name: jobName('di-restore', target.name, unix),
      backupKind: 'restore',
      agentKind,
      service: target,
      objectPrefix: backup.objectKey?.replace(/\/[^/]+$/, '') ?? '',
      backupName: restore.name,
      storage: backup.storage,
    }),
  });
}

/** BackingService dumps past `retention.successful`. Workload volumes have their own rules. */
function excess(world: World, keep: number): BackupView[] {
  const doomed: BackupView[] = [];
  const dumps = world.backups.filter((item) => !item.source);
  const names = [...new Set(dumps.map((item) => item.serviceName))];
  for (const name of names) {
    const rows = dumps
      .filter((item) => item.serviceName === name)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const successes = rows.filter((item) => item.phase === 'Succeeded' && item.objectKey);
    const failures = rows.filter((item) => item.phase === 'Failed');
    if (successes.length > 1) doomed.push(...successes.slice(keep));
    doomed.push(...failures.slice(5));
  }
  return doomed;
}

type Condition = NonNullable<DestinationStatus['conditions']>[number];

/** The destination's schedule, or undefined when it takes only on-demand backups (#250). */
function scheduleOf(dest: DestinationView): string | undefined {
  const schedule = dest.spec.schedule?.trim();
  return schedule && schedule !== NO_SCHEDULE ? schedule : undefined;
}

function scheduledCondition(dest: DestinationView): Condition {
  const schedule = scheduleOf(dest);
  if (schedule && !validCron(schedule)) {
    return {
      type: 'Scheduled',
      status: 'False',
      reason: 'InvalidSchedule',
      message: `Schedule "${schedule}" is not a valid five-field UTC cron: no scheduled backups run`,
    };
  }
  return schedule
    ? {
        type: 'Scheduled',
        status: 'True',
        reason: 'Scheduled',
        message: `Scheduled backups run on "${schedule}" (UTC)`,
      }
    : {
        type: 'Scheduled',
        status: 'False',
        reason: 'NoSchedule',
        message: 'No schedule is set: only on-demand backups run',
      };
}

/**
 * Reconcile one destination. Every status write carries a `Scheduled` condition next to
 * `Ready`, and a change of it is logged once (the persisted condition is the memory).
 */
export function reconcile(world: World): Action[] {
  const dest = world.destination;
  if (!dest) return [];
  const scheduled = scheduledCondition(dest);
  const actions = reconcileDestination(world, dest).map((action): Action => {
    if (action.type !== 'destination-status') return action;
    const conditions = (action.status.conditions ?? []).filter((item) => item.type !== 'Scheduled');
    return { ...action, status: { ...action.status, conditions: [...conditions, scheduled] } };
  });
  const previous = dest.status.conditions?.find((item) => item.type === 'Scheduled');
  if (
    previous?.status !== scheduled.status ||
    previous.reason !== scheduled.reason ||
    previous.message !== scheduled.message
  ) {
    actions.push({ type: 'log', message: `BackupDestination ${dest.name}: ${scheduled.message}` });
  }
  return actions;
}

function reconcileDestination(world: World, dest: DestinationView): Action[] {
  const actions: Action[] = [];
  let status: DestinationStatus = {
    ...dest.status,
    observedGeneration: dest.generation,
    services: [...(dest.status.services ?? [])],
  };
  const problem = destinationProblem(world, dest);
  // A started workload copy always runs to the step that gives the replicas back.
  const advanced = advanceVolumes(world, problem?.reason);
  actions.push(...advanced);
  if (dest.spec.sources?.length || dest.status.sources?.length) {
    status = { ...status, sources: sourceRows(world, dest) };
  }
  if (problem) {
    actions.push(condition(dest.name, status, problem.reason, problem.message, false));
    return actions;
  }
  if (destinationType(dest.spec) === 's3' && !world.runtimeSecretPresent) {
    actions.push({
      type: 'copy-credentials',
      secretName: dest.spec.credentialsSecretRef?.name ?? '',
    });
  }
  const wanted = world.wantedEgress ?? dest.spec.extraEgress ?? [];
  if (JSON.stringify(world.networkEgress) !== JSON.stringify(wanted)) {
    actions.push({ type: 'sync-egress', extraEgress: wanted });
  }
  observe(world, actions);
  if (status.sources) {
    const scheduled = scheduleSources(world, dest, status.sources);
    actions.push(...scheduled.actions);
    status = { ...status, sources: scheduled.rows };
  }
  if (
    world.busy ||
    world.jobs.some((job) => job.phase === 'Running') ||
    activeVolumeOps(world) > 0 ||
    advanced.some((action) => action.type === 'create-job')
  ) {
    actions.push(condition(dest.name, status, 'BackupInProgress', 'A backup job is running', true));
    return actions;
  }
  const restore = activeRestore(world);
  if (restore && !actions.some((action) => action.type === 'restore-status')) {
    restoreActions(world, restore, actions);
    actions.push(
      condition(dest.name, status, 'RestoreInProgress', `Restoring ${restore.name}`, true),
    );
    return actions;
  }
  const keep = dest.spec.retention?.successful ?? 14;
  const covered = new Set(
    world.jobs
      .filter((job) => job.backupKind === 'gc' && job.phase !== 'Failed')
      .flatMap((job) => job.gcBackups ?? []),
  );
  // A backup an unfinished restore reads from is never expired under it.
  for (const item of world.restores) {
    if (item.phase !== 'Succeeded' && item.phase !== 'Failed') covered.add(item.sourceBackupName);
  }
  const stale = [...excess(world, keep), ...expiredSources(world, dest)].filter(
    (item) => !covered.has(item.name),
  );
  if (stale.length > 0) {
    const unix = Math.floor(new Date(world.now).getTime() / 1000);
    actions.push({
      type: 'create-job',
      body: jobBody({
        world,
        name: jobName('di-gc', world.tenantNamespace.slice('di-tenant-'.length), unix),
        backupKind: 'gc',
        agentKind: 'gc',
        objectPrefix: '',
        gcKeys: stale.flatMap(backupKeys).join('\n'),
        gcBackups: stale.map((item) => item.name),
        storage: '256Mi',
      }),
    });
    actions.push(
      condition(dest.name, status, 'RetentionInProgress', 'Deleting expired backups', true),
    );
    return actions;
  }
  // No default schedule (#250): without one, only on-demand backups run.
  const schedule = scheduleOf(dest);
  const forced = dest.annotations[BACKUP_NOW];
  const due =
    (!!schedule && isDue(schedule, status.lastAttemptTime, new Date(world.now))) ||
    (!!forced && (!status.lastAttemptTime || forced > status.lastAttemptTime));
  const services = enrolled(world);
  if (due) status = { ...status, lastAttemptTime: world.now, skipped: 0 };
  const run = status.lastAttemptTime;
  if (forced && due) actions.push({ type: 'clear-annotation', name: dest.name, key: BACKUP_NOW });
  let skipped = status.skipped ?? 0;
  const pending: ServiceView[] = [];
  for (const service of services) {
    let row = { ...serviceRow(status, service.name), type: service.type };
    const backup = world.backups.find((item) => item.name === row.lastBackupName);
    if (backup?.phase === 'Succeeded' && row.lastReason !== 'Completed') {
      row = {
        ...row,
        lastReason: 'Completed',
        lastSuccessTime: world.now,
        lastAttemptTime: row.lastAttemptTime ?? run,
      };
      status = writeService(status, row);
    } else if (backup?.phase === 'Failed' && row.lastReason !== 'Failed') {
      row = {
        ...row,
        lastReason: backup.reason ?? 'DumpFailed',
        lastAttemptTime: row.lastAttemptTime ?? run,
      };
      status = writeService(status, row);
    }
    if (service.deleting) continue;
    if (!service.ready || service.suspended) {
      if (!attempted(row, run) && run) {
        status = writeService(status, { ...row, lastAttemptTime: run, lastReason: 'NotReady' });
        skipped += 1;
      }
      continue;
    }
    const size = parseBytes(service.storage);
    if (size !== undefined && size > DUMP_CAP_BYTES) {
      if (!attempted(row, run) && run) {
        status = writeService(status, { ...row, lastAttemptTime: run, lastReason: 'DumpTooLarge' });
        skipped += 1;
      }
      continue;
    }
    if (run && !attempted(row, run)) pending.push(service);
  }
  status = { ...status, skipped, enrolledServices: services.length };
  const next = pending[0];
  if (run && next) {
    const unix = Math.floor(new Date(world.now).getTime() / 1000);
    const name = jobName('di-backup', next.name, unix);
    const when = stamp(world.now);
    const objectPrefix = prefixFor(dest, world.tenantNamespace, next, when);
    const kind = backupKindFor(next.type);
    actions.push({
      type: 'create-backup',
      body: {
        apiVersion: VERSION,
        kind: 'Backup',
        metadata: { name, namespace: world.tenantNamespace },
        spec: {
          serviceName: next.name,
          destinationName: dest.name,
          uid: next.uid,
          type: next.type,
          className: next.className,
          parameters: { storage: next.storage, memory: next.memory, cpu: next.cpu },
          tool: kind === 'postgres' ? 'pg_dump' : kind === 'redis' ? 'redis-cli' : 'nats',
          format: kind === 'postgres' ? 'custom' : kind === 'redis' ? 'rdb' : 'account-backup',
        },
      },
    });
    actions.push({
      type: 'create-job',
      body: jobBody({
        world,
        name,
        backupKind: 'dump',
        agentKind: kind,
        service: next,
        objectPrefix,
        backupName: name,
        storage: next.storage,
      }),
    });
    status = writeService(status, {
      name: next.name,
      type: next.type,
      lastAttemptTime: run,
      lastBackupName: name,
      lastReason: 'Running',
    });
  }
  // One thing at a time: a requested workload copy waits while a dump starts this tick.
  const volume = run && next ? [] : startNext(world);
  actions.push(...volume);
  const completed = (status.services ?? []).filter(
    (row) => row.lastReason === 'Completed' && row.lastSuccessTime,
  );
  if (run && pending.length === 0 && completed.length > 0 && !status.lastSuccessTime) {
    status = { ...status, lastSuccessTime: world.now };
  }
  const copying = volume.some((action) => action.type === 'create-job');
  const reason = pending.length > 0 || copying ? 'BackupInProgress' : 'DestinationReady';
  actions.push(
    condition(
      dest.name,
      status,
      reason,
      reason === 'DestinationReady'
        ? destinationType(dest.spec) === 's3'
          ? 'Credentials copied'
          : 'Claim configured'
        : copying
          ? 'Placing a workload volume copy'
          : `Backing up ${next?.name ?? 'services'}`,
      true,
    ),
  );
  return actions;
}

/** Owner of Backups, restores, and Jobs whose BackupDestination no longer exists. */
const ORPHAN = '\u0000orphan';

function unionEgress(destinations: DestinationView[]): Egress[] {
  const seen = new Set<string>();
  const union: Egress[] = [];
  for (const rule of destinations.flatMap((item) => item.spec.extraEgress ?? [])) {
    const key = `${rule.cidr}|${rule.port}|${rule.protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    union.push(rule);
  }
  return union;
}

/** Jobs from before #233 carry no destination label: attribute them through their backup. */
function jobOwner(job: JobView, world: World, owner: (backup: string) => string | undefined) {
  if (job.destinationName) return job.destinationName;
  if (job.backupKind === 'gc') return job.gcBackups?.map(owner).find(Boolean);
  if (job.backupKind === 'dump') return job.backupName ? owner(job.backupName) : undefined;
  const restore = world.restores.find((item) => item.name === job.backupName);
  return restore ? owner(restore.sourceBackupName) : undefined;
}

/**
 * Reconcile every BackupDestination in the tenant (#233: S3, PVC, or both). Each one keeps its
 * own schedule, retention, and status. Agent Jobs stay one at a time across all of them, the
 * agent NetworkPolicy gets the union of their extraEgress, and only one S3 destination may
 * exist because the runtime credentials Secret is a single object.
 */
export function reconcileAll(world: World): Action[] {
  const destinations = world.destinations ?? (world.destination ? [world.destination] : []);
  const first = destinations[0]?.name;
  const known = new Set(destinations.map((item) => item.name));
  const owner = (name: string): string | undefined => {
    const backup = world.backups.find((item) => item.name === name);
    if (!backup) return undefined;
    if (known.has(backup.destinationName)) return backup.destinationName;
    // A workload copy belongs to the destination it names. Without it, it is an orphan.
    return backup.source ? ORPHAN : first;
  };
  const restoreOwner = (item: RestoreView): string | undefined => {
    const found = owner(item.sourceBackupName);
    if (found) return found;
    return item.targetWorkloadName && item.phase === 'Running' ? ORPHAN : first;
  };
  const jobDestination = (job: JobView): string | undefined => {
    const named = jobOwner(job, world, owner);
    if (named === undefined) return first;
    return known.has(named) || named === ORPHAN ? named : ORPHAN;
  };
  const scoped = (name: string | undefined) => ({
    backups: world.backups.filter((item) => owner(item.name) === name),
    restores: world.restores.filter((item) => restoreOwner(item) === name),
    jobs: world.jobs.filter((job) => jobDestination(job) === name),
  });
  const s3Owner = pickS3Owner(destinations)?.name;
  const wantedEgress = unionEgress(destinations);
  // Replicas held by an operation that is gone or finished come back first.
  const actions: Action[] = releaseOrphans(world);
  // Copies whose destination was deleted mid-way still give their replicas back.
  const orphans = scoped(ORPHAN);
  actions.push(
    ...advanceVolumes({ ...world, destination: undefined, ...orphans }, 'DestinationGone'),
  );
  let started = false;
  for (const dest of destinations) {
    const mine = scoped(dest.name);
    const elsewhere =
      world.jobs.some((job) => job.phase === 'Running' && !mine.jobs.includes(job)) ||
      activeVolumeOps(world) > activeVolumeOps(mine);
    const next = reconcile({
      ...world,
      destination: dest,
      ...mine,
      busy: started || elsewhere,
      wantedEgress,
      s3Owner,
    });
    for (const action of next) {
      if (action.type === 'sync-egress' && actions.some((item) => item.type === 'sync-egress'))
        continue;
      if (action.type === 'create-job' || action.type === 'scale-workload') started = true;
      actions.push(action);
    }
  }
  return actions;
}

/** Why this destination cannot take new work, or undefined when it can. */
function destinationProblem(
  world: World,
  dest: DestinationView,
): { reason: string; message: string } | undefined {
  if (dest.spec.suspend)
    return { reason: 'TenantSuspended', message: 'Tenant backups are suspended' };
  if (!endpointAllowed(dest.spec.endpoint)) {
    return { reason: 'EndpointRejected', message: 'Endpoint must be HTTPS or cluster-local HTTP' };
  }
  if (destinationType(dest.spec) === 'pvc') {
    const claim = dest.spec.existingClaimName || PVC_CLAIM;
    if (world.missingClaims?.includes(claim)) {
      // Without this the Job sits Pending until its deadline, and Jobs run one at a time, so
      // S3 backups would wait behind it.
      return {
        reason: 'ClaimMissing',
        message: `PersistentVolumeClaim ${claim} does not exist in ${world.runtimeNamespace}`,
      };
    }
    if (!dest.spec.existingClaimName && !dest.spec.volumeClaimTemplate?.size) {
      return {
        reason: 'ConfigInvalid',
        message: 'PVC destination must have existingClaimName or volumeClaimTemplate.size',
      };
    }
    return undefined;
  }
  if (world.s3Owner && world.s3Owner !== dest.name) {
    return {
      reason: 'ConfigInvalid',
      message: `Only one S3 destination per tenant: ${world.s3Owner} holds the runtime credentials`,
    };
  }
  if (!dest.spec.bucket) return { reason: 'ConfigInvalid', message: 'S3 bucket is missing' };
  const keys = new Set(world.credentialKeys);
  if (
    !dest.spec.credentialsSecretRef?.name ||
    !keys.has('AWS_ACCESS_KEY_ID') ||
    !keys.has('AWS_SECRET_ACCESS_KEY')
  ) {
    return { reason: 'CredentialsInvalid', message: 'S3 credentials are missing' };
  }
  return undefined;
}
