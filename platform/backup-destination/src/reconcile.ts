import {
  type Action,
  BACKUP_NOW,
  type BackupView,
  backupKindFor,
  type DestinationStatus,
  type DestinationView,
  DUMP_CAP_BYTES,
  endpointAllowed,
  GROUP,
  type JobView,
  jobName,
  parseBytes,
  postgresConnectionSecret,
  type RestoreView,
  SCHEDULE,
  type ServiceStatus,
  type ServiceView,
  servicePort,
  VERSION,
  type World,
} from './model.ts';
import { isDue } from './schedule.ts';

interface Result {
  ok?: boolean;
  digest?: string;
  bytes?: number;
  objectKey?: string;
  tool?: string;
  format?: string;
  error?: string;
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
  status: DestinationStatus,
  reason: string,
  message: string,
  ready: boolean,
): Action {
  return {
    type: 'destination-status',
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
  const env: { name: string; value?: string; valueFrom?: unknown }[] = [
    { name: 'BACKUP_KIND', value: kind },
    { name: 'BACKUP_BUCKET', value: input.world.destination?.spec.bucket ?? '' },
    { name: 'BACKUP_OBJECT_PREFIX', value: input.objectPrefix },
    { name: 'BACKUP_REGION', value: input.world.destination?.spec.region || 'us-east-1' },
    { name: 'BACKUP_WORKDIR', value: '/tmp' },
  ];
  if (input.world.destination?.spec.endpoint) {
    env.push({ name: 'BACKUP_ENDPOINT', value: input.world.destination.spec.endpoint });
  }
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
              envFrom: [
                {
                  secretRef: { name: 'di-backup-destination', optional: false },
                },
              ],
              resources: {
                requests: { cpu: '50m', memory: '64Mi', 'ephemeral-storage': storage },
                limits: { cpu: '100m', memory: '128Mi' },
              },
              terminationMessagePath: '/dev/termination-log',
              terminationMessagePolicy: 'File',
              volumeMounts: [{ name: 'scratch', mountPath: '/tmp' }],
            },
          ],
          volumes: [{ name: 'scratch', emptyDir: { sizeLimit: scratch(storage, kind) } }],
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
                message: parsed?.error ?? 'restore failed',
              }
            : { phase: 'Succeeded', reason: 'Completed', message: 'restore completed' },
        });
      }
    }
  }
}

function activeRestore(world: World): RestoreView | undefined {
  return world.restores.find((item) => item.phase !== 'Succeeded' && item.phase !== 'Failed');
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

function excess(world: World, keep: number): BackupView[] {
  const doomed: BackupView[] = [];
  const names = [...new Set(world.backups.map((item) => item.serviceName))];
  for (const name of names) {
    const rows = world.backups
      .filter((item) => item.serviceName === name)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const successes = rows.filter((item) => item.phase === 'Succeeded' && item.objectKey);
    const failures = rows.filter((item) => item.phase === 'Failed');
    if (successes.length > 1) doomed.push(...successes.slice(keep));
    doomed.push(...failures.slice(5));
  }
  return doomed;
}

export function reconcile(world: World): Action[] {
  const dest = world.destination;
  if (!dest) return [];
  const actions: Action[] = [];
  let status: DestinationStatus = {
    ...dest.status,
    observedGeneration: dest.generation,
    services: [...(dest.status.services ?? [])],
  };
  if (dest.spec.suspend) {
    actions.push(condition(status, 'TenantSuspended', 'Tenant backups are suspended', false));
    return actions;
  }
  if (!endpointAllowed(dest.spec.endpoint)) {
    actions.push(
      condition(status, 'EndpointRejected', 'Endpoint must be HTTPS or cluster-local HTTP', false),
    );
    return actions;
  }
  const secretName = dest.spec.credentialsSecretRef?.name ?? '';
  const keys = new Set(world.credentialKeys);
  if (!secretName || !keys.has('AWS_ACCESS_KEY_ID') || !keys.has('AWS_SECRET_ACCESS_KEY')) {
    actions.push(condition(status, 'CredentialsInvalid', 'S3 credentials are missing', false));
    return actions;
  }
  if (!world.runtimeSecretPresent) actions.push({ type: 'copy-credentials', secretName });
  const wanted = dest.spec.extraEgress ?? [];
  if (JSON.stringify(world.networkEgress) !== JSON.stringify(wanted)) {
    actions.push({ type: 'sync-egress', extraEgress: wanted });
  }
  observe(world, actions);
  if (world.jobs.some((job) => job.phase === 'Running')) {
    actions.push(condition(status, 'BackupInProgress', 'A backup job is running', true));
    return actions;
  }
  const restore = activeRestore(world);
  if (restore && !actions.some((action) => action.type === 'restore-status')) {
    restoreActions(world, restore, actions);
    actions.push(condition(status, 'RestoreInProgress', `Restoring ${restore.name}`, true));
    return actions;
  }
  const keep = dest.spec.retention?.successful ?? 14;
  const covered = new Set(
    world.jobs
      .filter((job) => job.backupKind === 'gc' && job.phase !== 'Failed')
      .flatMap((job) => job.gcBackups ?? []),
  );
  const stale = excess(world, keep).filter((item) => !covered.has(item.name));
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
        gcKeys: stale
          .flatMap((item) =>
            item.objectKey
              ? [item.objectKey, item.objectKey.replace(/\/[^/]+$/, '/manifest.json')]
              : [],
          )
          .join('\n'),
        gcBackups: stale.map((item) => item.name),
        storage: '256Mi',
      }),
    });
    actions.push(condition(status, 'RetentionInProgress', 'Deleting expired backups', true));
    return actions;
  }
  const schedule = dest.spec.schedule || SCHEDULE;
  const forced = dest.annotations[BACKUP_NOW];
  const due =
    isDue(schedule, status.lastAttemptTime, new Date(world.now)) ||
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
  const completed = (status.services ?? []).filter(
    (row) => row.lastReason === 'Completed' && row.lastSuccessTime,
  );
  if (run && pending.length === 0 && completed.length > 0 && !status.lastSuccessTime) {
    status = { ...status, lastSuccessTime: world.now };
  }
  const reason = pending.length > 0 ? 'BackupInProgress' : 'DestinationReady';
  actions.push(
    condition(
      status,
      reason,
      reason === 'DestinationReady'
        ? 'Credentials copied'
        : `Backing up ${next?.name ?? 'services'}`,
      true,
    ),
  );
  return actions;
}
