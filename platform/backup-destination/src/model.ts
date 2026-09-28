import { createHash } from 'node:crypto';

export const GROUP = 'platform.di-framework.dev';
export const VERSION = `${GROUP}/v1alpha1`;
export const DUMP_CAP_BYTES = 4 * 1024 ** 3;
export const BACKUP_NOW = `${GROUP}/backup-now`;
export const SCHEDULE = '0 2 * * *';

export interface Egress {
  cidr: string;
  port: number;
  protocol: 'TCP' | 'UDP';
}

export interface DestinationSpec {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  credentialsSecretRef?: { name?: string };
  schedule?: string;
  retention?: { successful?: number };
  extraEgress?: Egress[];
  suspend?: boolean;
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
}

export interface DestinationView {
  name: string;
  generation: number;
  spec: DestinationSpec;
  status: DestinationStatus;
  annotations: Record<string, string>;
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
}

export interface RestoreView {
  name: string;
  sourceBackupName: string;
  targetServiceName: string;
  phase?: 'Running' | 'Succeeded' | 'Failed';
  reason?: string;
}

export interface JobView {
  name: string;
  backupKind: 'dump' | 'restore' | 'probe' | 'gc';
  serviceName: string;
  phase: 'Running' | 'Succeeded' | 'Failed';
  message?: string;
  backupName?: string;
  gcBackups?: string[];
}

export interface World {
  now: string;
  tenantNamespace: string;
  runtimeNamespace: string;
  agentImage: string;
  destination?: DestinationView;
  services: ServiceView[];
  backups: BackupView[];
  restores: RestoreView[];
  jobs: JobView[];
  runtimeSecretPresent: boolean;
  credentialKeys: string[];
  networkEgress: Egress[];
}

export type Action =
  | { type: 'destination-status'; status: DestinationStatus }
  | { type: 'clear-annotation'; name: string; key: string }
  | { type: 'annotate'; name: string; key: string; value: string }
  | { type: 'copy-credentials'; secretName: string }
  | { type: 'sync-egress'; extraEgress: Egress[] }
  | { type: 'create-backup'; body: Record<string, unknown> }
  | { type: 'backup-status'; name: string; status: Record<string, unknown> }
  | { type: 'delete-backup'; name: string }
  | { type: 'create-job'; body: Record<string, unknown> }
  | { type: 'restore-status'; name: string; status: Record<string, unknown> }
  | { type: 'create-restore'; body: Record<string, unknown> };

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
