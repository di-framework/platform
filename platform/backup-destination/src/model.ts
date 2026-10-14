import { createHash } from 'node:crypto';

export const GROUP = 'platform.di-framework.dev';
export const VERSION = `${GROUP}/v1alpha1`;
export const DUMP_CAP_BYTES = 4 * 1024 ** 3;
export const BACKUP_NOW = `${GROUP}/backup-now`;
/**
 * The chart's explicit opt-out from scheduled backups (#250). There is no default schedule: a
 * destination without one, or with this keyword, takes only on-demand backups.
 */
export const NO_SCHEDULE = 'none';
/** Claim the chart creates from `volumeClaimTemplate`, in the runtime namespace. */
export const PVC_CLAIM = 'di-backup-pvc';
/** Where agent Jobs mount a PVC destination. */
export const PVC_MOUNT = '/backup-pvc';
/** Runtime-namespace Secret the S3 credentials are copied into. There is one per tenant. */
export const RUNTIME_SECRET = 'di-backup-destination';

export interface Egress {
  cidr: string;
  port: number;
  protocol: 'TCP' | 'UDP';
}

/**
 * Retention for one workload-volume source (#232). Nothing is deleted unless a rule is set.
 * A successful backup is kept when any rule keeps it: one of the newest `keepLast`, or the newest
 * backup of one of the newest `daily` UTC days, `weekly` ISO weeks, or `monthly` months that
 * have a backup. When at least one of those four is set, every other successful backup is
 * deleted. `failed` keeps that many of the newest failed attempts and deletes older ones.
 */
export interface Retention {
  keepLast?: number;
  daily?: number;
  weekly?: number;
  monthly?: number;
  failed?: number;
}

/** A tenant WorkloadDeployment whose platform storage volume is copied cold (#232). */
export interface WorkloadVolumeSource {
  kind: 'workload-volume';
  workloadName: string;
  /** UTC cron. Without one the source is backed up only on demand. */
  schedule?: string;
  retention?: Retention;
  scaleDownTimeoutSeconds?: number;
  copyTimeoutSeconds?: number;
  /**
   * How long the placement probe, and then the copy Job, may take to start running. Past it the
   * operation gives up: before the scale-down for the probe, or with the replicas given back at
   * once for the copy.
   */
  startTimeoutSeconds?: number;
  /** Requests and limits of the copy (and restore) Job. The default always fits: 100m/128Mi. */
  resources?: JobResources;
  suspend?: boolean;
}

export interface JobResources {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

export interface DestinationSpec {
  type: 's3' | 'pvc';
  bucket?: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  credentialsSecretRef?: { name?: string };
  existingClaimName?: string;
  volumeClaimTemplate?: {
    storageClassName?: string;
    size?: string;
  };
  schedule?: string;
  retention?: { successful?: number };
  extraEgress?: Egress[];
  suspend?: boolean;
  sources?: WorkloadVolumeSource[];
}

export interface SourceStatus {
  kind: 'workload-volume';
  workloadName: string;
  /** Last time the schedule fired (or was armed). Scheduling counts from here. */
  lastScheduledTime?: string;
  /** The schedule `lastScheduledTime` counts for. A different schedule re-arms the source. */
  schedule?: string;
  /**
   * `Armed` counts toward the next fire. `Suspended`, `OnDemand` (no schedule, or `none`) and
   * `InvalidSchedule` never fire, and leaving any of them re-arms the schedule from that moment.
   */
  scheduleStatus?: 'Armed' | 'Suspended' | 'OnDemand' | 'InvalidSchedule';
  lastBackupName?: string;
  lastReason?: string;
  lastSuccessTime?: string;
  /** Seconds the workload's replicas were held at 0 for the newest finished backup. */
  lastScaleDownSeconds?: number;
  lastScaleDownTime?: string;
}

/** The terminal status an operation reached, kept while its replicas are given back. */
export interface VolumeOutcome {
  phase: 'Succeeded' | 'Failed';
  reason: string;
  message: string;
  digest?: string;
  bytes?: number;
  objectKey?: string;
  fileCount?: number;
  encfsKcv?: string;
  imageDigest?: string;
  replacedPath?: string;
  restoringPath?: string;
}

/**
 * Progress of a cold copy or restore, kept in status so an operator restart resumes it.
 * Placing -> ScalingDown -> Copying -> ScalingUp -> Done. Placing holds nothing; from
 * ScalingDown on the replicas are on record here and in the held-replicas ledger.
 */
export interface VolumeProgress {
  stage?: 'Placing' | 'ScalingDown' | 'Copying' | 'ScalingUp' | 'Done';
  /** Every WorkloadDeployment sharing the volume, with the replicas to give back. */
  members?: { name: string; replicas: number }[];
  placingStartedAt?: string;
  /** Deterministic names, so two reconcilers cannot start two Jobs for one operation. */
  probeJob?: string;
  copyJob?: string;
  /** A Job that was stopped: the replicas wait until its pods are gone (bounded). */
  abortedJob?: string;
  abortedAt?: string;
  outcome?: VolumeOutcome;
  scaleDownStartedAt?: string;
  stoppedAt?: string;
  restoredAt?: string;
  scaleDownSeconds?: number;
  node?: string;
  hostPath?: string;
  storageKey?: string;
  image?: string;
  objectPrefix?: string;
  fileCount?: number;
  encfsKcv?: string;
  imageDigest?: string;
  replacedPath?: string;
  restoringPath?: string;
}

export interface WorkloadView {
  name: string;
  uid: string;
  /** spec.replicas (the CRD default is 1). */
  replicas: number;
  /** Workload objects that still exist for it, or status.currentReplicas if higher. */
  instances: number;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  /** Image of the component that mounts the storage volume. */
  image?: string;
  deleting: boolean;
}

/** A tenant host pod in the runtime namespace. */
export interface HostView {
  name: string;
  node?: string;
  ready: boolean;
  /** Being deleted. It may still run instances, so it still counts for placement. */
  terminating?: boolean;
  hostPaths: string[];
}

/**
 * A signal's message for when this tick's `scale-workload` of `workload` found it gone (a 404),
 * so the signal says what really happened (#263).
 */
export interface GoneMessage {
  workload: string;
  message: string;
}

/** One WorkloadDeployment an operation holds at 0, and the replicas to give back. */
export interface HeldEntry {
  replicas: number;
  /** `Backup/<name>` or `BackupRestore/<name>`. */
  heldBy: string;
  since: string;
  /** The BackupDestination whose source the workload is; the sweeper checks it against its spec. */
  destination?: string;
  /**
   * The platform storage key of the volume the workload was stopped for (#263). Once the
   * destination is gone, the entry is given back only to a workload that still has this key.
   */
  storageKey?: string;
  /** metadata.uid of the WorkloadDeployment when it was held: a re-created one is never raised. */
  workloadUid?: string;
}

/**
 * The held-replicas ledger, a ConfigMap in the tenant's runtime namespace, where tenant users
 * cannot write ConfigMaps. It outlives the Backup or BackupRestore that wrote it: a sweeper gives
 * the replicas back for any valid entry whose operation is gone or finished, and a new operation
 * never records 0 for a held workload.
 */
export interface Ledger {
  /** Absent while the ConfigMap does not exist. */
  resourceVersion?: string;
  entries: Record<string, HeldEntry>;
}

export interface ServiceStatus {
  name: string;
  type: string;
  lastAttemptTime?: string;
  lastSuccessTime?: string;
  lastBackupName?: string;
  lastReason?: string;
}

export interface DestinationStatus {
  conditions?: { type: string; status: string; reason: string; message: string }[];
  observedGeneration?: number;
  lastAttemptTime?: string;
  lastSuccessTime?: string;
  enrolledServices?: number;
  skipped?: number;
  services?: ServiceStatus[];
  sources?: SourceStatus[];
}

export interface DestinationView {
  name: string;
  generation: number;
  spec: DestinationSpec;
  status: DestinationStatus;
  annotations: Record<string, string>;
  /** metadata.creationTimestamp; decides which S3 destination owns the runtime credentials. */
  createdAt?: string;
}

export interface ServiceView {
  name: string;
  uid: string;
  type: 'postgres' | 'keyvalue' | 'messaging';
  className: string;
  storage: string;
  memory?: string;
  cpu?: string;
  ready: boolean;
  suspended: boolean;
  deleting: boolean;
}

export interface BackupView {
  name: string;
  serviceName: string;
  /** The BackupDestination that holds this backup's objects. */
  destinationName: string;
  phase?: 'Running' | 'Succeeded' | 'Failed';
  objectKey?: string;
  digest?: string;
  bytes?: number;
  reason?: string;
  uid: string;
  type: string;
  className: string;
  storage: string;
  createdAt: string;
  /** metadata.uid (spec `uid` is the source's). It names the volume Jobs of this object. */
  objectUid?: string;
  resourceVersion?: string;
  finalizers?: string[];
  deleting?: boolean;
  /** Set for a workload-volume backup; serviceName then holds the workload name. */
  source?: { kind: 'workload-volume'; workloadName: string };
  volume?: VolumeProgress;
  message?: string;
}

export interface RestoreView {
  name: string;
  sourceBackupName: string;
  /** Empty for a workload-volume restore. */
  targetServiceName: string;
  targetWorkloadName?: string;
  force?: boolean;
  expectedKcv?: string;
  phase?: 'Running' | 'Succeeded' | 'Failed';
  reason?: string;
  volume?: VolumeProgress;
  /** metadata.uid. It names the volume Jobs of this object. */
  objectUid?: string;
  resourceVersion?: string;
  finalizers?: string[];
  deleting?: boolean;
}

export interface JobView {
  name: string;
  backupKind:
    | 'dump'
    | 'restore'
    | 'probe'
    | 'gc'
    | 'volume-copy'
    | 'volume-restore'
    | 'volume-probe';
  serviceName: string;
  phase: 'Running' | 'Succeeded' | 'Failed';
  message?: string;
  backupName?: string;
  gcBackups?: string[];
  /** The BackupDestination the Job reads or writes; absent on Jobs from before #233. */
  destinationName?: string;
  /** Reason of the Job's Failed condition, such as DeadlineExceeded. */
  failedReason?: string;
  /** A pod of the Job got as far as running its container. */
  started?: boolean;
  /** Pods of the Job that have not finished, terminating ones included. */
  activePods?: number;
  /** The metadata.uid of the Backup or BackupRestore that created a volume Job. */
  ownerUid?: string;
}

export interface World {
  now: string;
  tenantNamespace: string;
  runtimeNamespace: string;
  agentImage: string;
  /** The destination {@link reconcile} works on. `loadWorld` sets it to the first one listed. */
  destination?: DestinationView;
  /** Every BackupDestination in the tenant namespace, in API (name) order. */
  destinations?: DestinationView[];
  /** Another destination's Job is running or was started this tick: start nothing new. */
  busy?: boolean;
  /** Union of every destination's extraEgress; the agent NetworkPolicy is shared. */
  wantedEgress?: Egress[];
  /** Name of the S3 destination whose credentials the runtime Secret holds, if any. */
  s3Owner?: string;
  /** Claims that do not exist in the runtime namespace. Absent when the lookup was not possible. */
  missingClaims?: string[];
  /**
   * Tenant WorkloadDeployments (#232). Undefined means unknown: a list (or the ledger, or the
   * tenant host Deployment) could not be read. No volume step runs on unknown state.
   */
  workloads?: WorkloadView[];
  /** The held-replicas ledger; undefined exactly when `workloads` is. */
  ledger?: Ledger;
  /** Tenant host pods and the hostPath directories they mount. */
  hosts?: HostView[];
  /** The Tenant's uid, which names its node directories. */
  tenantUid?: string;
  /**
   * The platform's storageRoot. When unset, it is taken from the path the tenant host pods
   * mount for the workload.
   */
  storageRoot?: string;
  services: ServiceView[];
  backups: BackupView[];
  restores: RestoreView[];
  jobs: JobView[];
  runtimeSecretPresent: boolean;
  credentialKeys: string[];
  networkEgress: Egress[];
}

export type Action =
  | { type: 'destination-status'; name?: string; status: DestinationStatus }
  | { type: 'clear-annotation'; name: string; key: string }
  | { type: 'annotate'; name: string; key: string; value: string }
  | { type: 'copy-credentials'; secretName: string }
  | { type: 'sync-egress'; extraEgress: Egress[] }
  | { type: 'create-backup'; body: Record<string, unknown> }
  | {
      type: 'backup-status';
      name: string;
      status: Record<string, unknown>;
      /** Precondition: the write fails with 409 when the object changed since it was read. */
      resourceVersion?: string;
    }
  | { type: 'delete-backup'; name: string }
  | { type: 'create-job'; body: Record<string, unknown> }
  | {
      type: 'restore-status';
      name: string;
      status: Record<string, unknown>;
      resourceVersion?: string;
    }
  | {
      type: 'finalizers';
      resource: 'backups' | 'backuprestores';
      name: string;
      finalizers: string[];
      resourceVersion?: string;
    }
  | {
      type: 'ledger';
      /** null removes the entry. */
      set: Record<string, HeldEntry | null>;
      /** Absent: the ConfigMap does not exist yet and is created. */
      resourceVersion?: string;
    }
  | { type: 'create-restore'; body: Record<string, unknown> }
  | { type: 'scale-workload'; name: string; replicas: number }
  | { type: 'delete-job'; name: string }
  | { type: 'log'; message: string; ifGone?: GoneMessage }
  /**
   * A Kubernetes Event in the runtime namespace, on the held-replicas ledger ConfigMap (#254).
   * A signal, not a step: a failed write is logged and never stops the tick.
   */
  | {
      type: 'event';
      eventType: 'Normal' | 'Warning';
      reason: string;
      message: string;
      ifGone?: GoneMessage;
    };

/** Destinations created before #233 carry no `type`; they are S3. */
export function destinationType(spec: Pick<DestinationSpec, 'type'> | undefined): 's3' | 'pvc' {
  return spec?.type === 'pvc' ? 'pvc' : 's3';
}

export const WORKLOAD_VOLUME = 'workload-volume';
export const SCALE_DOWN_TIMEOUT_SECONDS = 300;
export const COPY_TIMEOUT_SECONDS = 3600;
export const START_TIMEOUT_SECONDS = 120;
/** How long a copy Job may be absent or overdue, or a stopped Job's pods linger, before giving up. */
export const JOB_GRACE_SECONDS = 120;
/** Finished volume Jobs keep their result this long, so an operator outage does not lose it. */
export const VOLUME_JOB_TTL_SECONDS = 7 * 24 * 3600;
/** On a running Backup or BackupRestore: removed only once its replicas are back. */
export const FINALIZER = `${GROUP}/restore-replicas`;
/**
 * The held-replicas ledger ConfigMap in the runtime namespace (`di-runtime-<tenant>`). Tenant
 * roles only read pods, services and events there, so a tenant user cannot forge an entry. A
 * ledger left in the tenant namespace by an earlier build is never read.
 */
export const LEDGER = 'di-backup-held-replicas';
/** The most replicas a ledger entry may give back; anything above is refused as forged. */
export const MAX_HELD_REPLICAS = 100;
/** The platform-owned tenant registry WorkloadDeployment (platform tenancy `REGISTRY_WORKLOAD`). */
export const REGISTRY_WORKLOAD = 'di-tenant-registry';
/** Label value of platform-owned tenant-auth WorkloadDeployments (platform `TENANT_AUTH_COMPONENT`). */
export const TENANT_AUTH_COMPONENT = 'tenant-auth';
/** Label carrying the metadata.uid of the Backup or BackupRestore that owns a volume Job. */
export const OWNER_OBJECT_LABEL = `${GROUP}/backup-uid`;
/** The Lease the operator replicas elect a leader with. */
export const LEASE = 'di-backup-operator';

// Mirrors platform/platform/src/tenancy/workload-storage.ts; tests/workload.test.ts checks parity.
const STORAGE_ANNOTATION = 'di-framework.dev/persistent-storage';
const STORAGE_MOUNT_ANNOTATION = 'di-framework.dev/storage-mount';
const GUEST_MOUNT_PATHS = ['/data', '/data/actors'];
const STORAGE_KEY = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
export const STORAGE_VOLUME = 'di-storage';
export const OWNER_UID_LABEL = `${GROUP}/owner-uid`;

/** The directory key the platform gives a workload's storage, or undefined when it has none. */
export function storageKeyOf(workload: Pick<WorkloadView, 'name' | 'labels' | 'annotations'>) {
  if (workload.annotations[STORAGE_ANNOTATION] !== 'true') return undefined;
  const mount = workload.annotations[STORAGE_MOUNT_ANNOTATION] ?? '/data';
  if (!GUEST_MOUNT_PATHS.includes(mount)) return undefined;
  const key =
    workload.labels['di-framework.dev/workload'] ??
    workload.labels['di-framework.dev/application'] ??
    workload.name;
  return key.length <= 50 && STORAGE_KEY.test(key) ? key : undefined;
}

/** `<storageRoot>/di-tenants/<tenant uid>/workloads/<key>`, as the platform mounts it. */
export function volumePath(storageRoot: string, tenantUid: string, key: string): string {
  return `${storageRoot}/di-tenants/${tenantUid}/workloads/${key}`;
}

export function runtimeNamespaceFor(tenantNamespace: string): string {
  if (!tenantNamespace.startsWith('di-tenant-') || tenantNamespace.length < 'di-tenant-x'.length) {
    throw new Error(
      `namespace ${tenantNamespace} is not a wasmCloud tenant namespace (di-tenant-<name>)`,
    );
  }
  return `di-runtime-${tenantNamespace.slice('di-tenant-'.length)}`;
}

export function parseBytes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti)?$/.exec(value);
  if (!match?.[1]) return undefined;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === 'Ki') return amount * 1024;
  if (unit === 'Mi') return amount * 1024 ** 2;
  if (unit === 'Gi') return amount * 1024 ** 3;
  if (unit === 'Ti') return amount * 1024 ** 4;
  return amount;
}

export function endpointAllowed(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname.endsWith('.svc.cluster.local');
}

export function postgresConnectionSecret(name: string, uid: string): string {
  const id = createHash('sha256').update(uid).digest('hex').slice(0, 16);
  return `di-pg-${name.slice(0, 30)}-${id}-conn`;
}

export function jobName(prefix: string, service: string, unix: number): string {
  const base = `${prefix}-${service}-${unix}`;
  if (base.length <= 63) return base;
  const hash = createHash('sha256').update(`${service}${unix}`).digest('hex').slice(0, 8);
  const stamp = String(unix);
  const room = 63 - prefix.length - stamp.length - hash.length - 3;
  return `${prefix}-${service.slice(0, Math.max(1, room))}-${stamp}-${hash}`;
}

/** A Job name derived from the operation's name only, at most 63 characters. */
export function opJobName(prefix: string, name: string, uid?: string): string {
  // The owner's uid makes the name per object: a request re-created under the same name never
  // finds the Jobs (kept for VOLUME_JOB_TTL_SECONDS) of the one it replaced.
  const owner = uid ? `-${createHash('sha256').update(uid).digest('hex').slice(0, 8)}` : '';
  const base = `${prefix}-${name}${owner}`;
  if (base.length <= 63) return base;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `${prefix}-${name.slice(0, 63 - prefix.length - hash.length - owner.length - 2)}-${hash}${owner}`;
}

/** The HTTP status of a failed API call, when the client reports one. */
export function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function backupKindFor(type: ServiceView['type']): 'postgres' | 'redis' | 'nats' {
  if (type === 'postgres') return 'postgres';
  if (type === 'keyvalue') return 'redis';
  return 'nats';
}

export function servicePort(type: ServiceView['type']): string {
  if (type === 'postgres') return '5432';
  if (type === 'keyvalue') return '6379';
  return '4222';
}

/**
 * The S3 destination that owns the runtime credentials: the oldest by creationTimestamp, name as
 * the tie-break. Never name order, so adding `archive` beside a working `default` cannot take over.
 */
export function pickS3Owner(destinations: DestinationView[]): DestinationView | undefined {
  return destinations
    .filter((item) => destinationType(item.spec) === 's3')
    .sort(
      (a, b) =>
        (a.createdAt || '9999').localeCompare(b.createdAt || '9999') ||
        a.name.localeCompare(b.name),
    )[0];
}
