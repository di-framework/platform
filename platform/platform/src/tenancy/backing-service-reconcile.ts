import {
  type BackingCapability,
  type BackingProvider,
  type BackingService,
  type BackingServiceClass,
  type ControllerConfig,
  classVisibleToTenant,
  compatibleProvider,
  GROUP,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  resolveClassName,
  type SizingParameters,
  TENANT,
  type Tenant,
} from './resources';

/** Label identifying the owning BackingService name on provisioned infra. */
const SERVICE = `${GROUP}/service`;
/** Label identifying capability (keyvalue|messaging|blobstore|postgres) on provisioned infra. */
const CAPABILITY = `${GROUP}/capability`;

/**
 * Runtime-internal data-plane NATS used by hostgroup `--data-nats-url`.
 * This is NOT an application BackingService and must never be created by
 * `reconcileBackingService`. Application messaging uses `di-bs-<name>` only.
 */
const RUNTIME_DATA_NATS = 'di-nats';

/** Transitional warehouse Redis still owned by Tenant reconcile (#456 migrates). */
const TRANSITIONAL_REDIS = 'di-redis';

/** Providers that run a backend pod. `platform` (egress) runs nothing. */
type RuntimeProvider = Exclude<BackingProvider, 'platform'>;

/** Fixed provider images — never tenant-supplied. */
const PROVIDER_RUNTIME: Record<RuntimeProvider, { image: string; port: number; args: string[] }> = {
  postgres: { image: 'postgres:18.3-bookworm', port: 5432, args: [] },
  redis: {
    image: 'redis:7.4.5-alpine',
    port: 6379,
    args: ['redis-server', '--appendonly', 'yes', '--dir', '/data'],
  },
  nats: {
    image: 'nats:2.12.8-alpine',
    port: 4222,
    args: ['-js', '-sd', '/data'],
  },
};

/** Reserved deployment/service names in the runtime namespace (not adoptable as BS). */
const RESERVED_RUNTIME_NAMES = new Set([
  RUNTIME_DATA_NATS,
  TRANSITIONAL_REDIS,
  'di-http',
  'di-scheduler-tls',
  'di-runtime',
]);

/** Throws before any write when a desired resource would claim a reserved runtime name. */
function refuseReservedNames(resources: readonly Resource[]): void {
  for (const resource of resources)
    if (RESERVED_RUNTIME_NAMES.has(resource.metadata.name))
      throw new Error(`Refusing to provision reserved name ${resource.metadata.name}`);
}

function backingServiceResourceName(serviceName: string): string {
  return `di-bs-${serviceName}`;
}

/** Node directory holding tenant data when `cfg.storageRoot` is unset. */
const DEFAULT_STORAGE_ROOT = '/var/lib/k0s';

/** `<storageRoot>/di-tenants/<tenant uid>/bs-<name>`: where a new BackingService keeps its data. */
function backingServiceHostPath(
  cfg: Pick<ControllerConfig, 'storageRoot'>,
  tenantUid: string,
  serviceName: string,
): string {
  return `${cfg.storageRoot ?? DEFAULT_STORAGE_ROOT}/di-tenants/${tenantUid}/bs-${serviceName}`;
}

/**
 * The hostPath the live `di-bs-<name>` Deployment already mounts as its `data` volume, when that
 * Deployment belongs to `service`. Keeping it means a BackingService created under an earlier
 * storage root still reaches its data; a Deployment owned by another UID never donates a path.
 */
function liveBackingServiceHostPath(
  live: Resource | undefined,
  service: BackingService,
): string | undefined {
  if (!live || live.metadata.labels?.[OWNER] !== service.metadata.uid) return undefined;
  const spec = live.spec as
    | { template?: { spec?: { volumes?: { name?: string; hostPath?: { path?: string } }[] } } }
    | undefined;
  const data = spec?.template?.spec?.volumes?.find((v) => v.name === 'data');
  return data?.hostPath?.path || undefined;
}

/** Parse Kubernetes CPU quantities to millicores. */
function parseCpu(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)(m)?$/.exec(value);
  if (!match) throw new Error(`Invalid cpu quantity: ${value}`);
  const amount = Number(match[1]);
  return match[2] === 'm' ? amount : amount * 1000;
}

/** Parse Kubernetes memory/storage quantities to bytes. */
function parseMemory(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti)?$/.exec(value);
  if (!match) throw new Error(`Invalid memory quantity: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === 'Ki') return amount * 1024;
  if (unit === 'Mi') return amount * 1024 ** 2;
  if (unit === 'Gi') return amount * 1024 ** 3;
  if (unit === 'Ti') return amount * 1024 ** 4;
  return amount;
}

function parseQuantity(value: string, field: 'cpu' | 'memory' | 'storage'): number {
  return field === 'cpu' ? parseCpu(value) : parseMemory(value);
}

function quantityWithin(
  value: string,
  bound: { min?: string; max?: string } | undefined,
  field: 'storage' | 'memory' | 'cpu',
): string | undefined {
  if (!bound) return undefined;
  const parsed = parseQuantity(value, field);
  if (bound.min !== undefined && parsed < parseQuantity(bound.min, field))
    return `parameters.${field} must be at least ${bound.min}`;
  if (bound.max !== undefined && parsed > parseQuantity(bound.max, field))
    return `parameters.${field} must be at most ${bound.max}`;
  return undefined;
}

function mergeSizing(
  defaults: SizingParameters | undefined,
  parameters: SizingParameters | undefined,
): SizingParameters {
  return {
    storage: parameters?.storage ?? defaults?.storage ?? '1Gi',
    memory: parameters?.memory ?? defaults?.memory ?? '128Mi',
    cpu: parameters?.cpu ?? defaults?.cpu ?? '250m',
  };
}

function validateSizingAgainstClass(
  sizing: SizingParameters,
  cls: BackingServiceClass,
): string | undefined {
  const schema = cls.spec.parametersSchema;
  for (const field of ['storage', 'memory', 'cpu'] as const) {
    const value = sizing[field];
    if (!value) continue;
    const err = quantityWithin(value, schema?.[field], field);
    if (err) return err;
  }
  return undefined;
}

function validateSizingAgainstTenantBudget(
  sizing: SizingParameters,
  tenant: Tenant,
): string | undefined {
  const budget = tenant.spec.resources ?? {};
  if (sizing.memory && budget.memory) {
    if (parseMemory(sizing.memory) > parseMemory(budget.memory))
      return `parameters.memory exceeds tenant budget ${budget.memory}`;
  }
  if (sizing.cpu && budget.cpu) {
    if (parseCpu(sizing.cpu) > parseCpu(budget.cpu))
      return `parameters.cpu exceeds tenant budget ${budget.cpu}`;
  }
  return undefined;
}

function resolveClass(
  service: BackingService,
  classes: BackingServiceClass[],
  tenantName: string,
): { cls: BackingServiceClass } | { error: string } {
  const className = resolveClassName(service.spec);
  const cls = classes.find((c) => c.metadata.name === className);
  if (!cls) return { error: `BackingServiceClass ${className} not found` };
  if (cls.spec.type !== service.spec.type)
    return { error: `class ${className} type ${cls.spec.type} does not match service type` };
  if (!compatibleProvider(cls.spec.type, cls.spec.provider))
    return { error: `class ${className} has incompatible provider` };
  if (!classVisibleToTenant(cls.spec, tenantName))
    return { error: `class ${className} is not visible to tenant ${tenantName}` };
  return { cls };
}

function resolveBackingSizing(
  service: BackingService,
  cls: BackingServiceClass,
  tenant: Tenant,
): { sizing: SizingParameters } | { error: string } {
  const sizing = mergeSizing(cls.spec.defaults, service.spec.parameters);
  const classErr = validateSizingAgainstClass(sizing, cls);
  if (classErr) return { error: classErr };
  const budgetErr = validateSizingAgainstTenantBudget(sizing, tenant);
  if (budgetErr) return { error: budgetErr };
  return { sizing };
}

function backingLabels(
  service: BackingService,
  tenant: Tenant,
  installation: string,
): Record<string, string> {
  return {
    [INSTALLATION]: installation,
    [OWNER]: service.metadata.uid ?? '',
    [TENANT]: tenant.metadata.name,
    [SERVICE]: service.metadata.name,
    [CAPABILITY]: service.spec.type,
  };
}

function makeBackingResource(
  service: BackingService,
  tenant: Tenant,
  installation: string,
  apiVersion: string,
  kind: string,
  name: string,
  namespace: string,
  body: Record<string, unknown>,
): Resource {
  return {
    apiVersion,
    kind,
    metadata: {
      name,
      namespace,
      labels: backingLabels(service, tenant, installation),
    },
    ...body,
  };
}

/**
 * Shared Deployment+Service for a Redis/NATS backend with hostPath storage.
 * Used by both Tenant transitional stock path and BackingService reconcile.
 */
function backendDeploymentResources(opts: {
  labels: Record<string, string>;
  runtimeNamespace: string;
  name: string;
  provider: RuntimeProvider;
  hostPath: string;
  replicas: number;
  sizing?: SizingParameters;
}): Resource[] {
  const runtime = PROVIDER_RUNTIME[opts.provider];
  const cpu = opts.sizing?.cpu ?? '250m';
  const memory = opts.sizing?.memory ?? '128Mi';
  const app = opts.name;
  return [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: app, namespace: opts.runtimeNamespace, labels: opts.labels },
      spec: {
        replicas: opts.replicas,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app } },
        template: {
          metadata: { labels: { ...opts.labels, app, [`${GROUP}/component`]: 'backing-service' } },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name: app,
                image: runtime.image,
                args: runtime.args,
                ports: [{ containerPort: runtime.port }],
                resources: {
                  requests: { cpu: '10m', memory: '32Mi' },
                  limits: { cpu, memory },
                },
                readinessProbe: { tcpSocket: { port: runtime.port } },
                volumeMounts: [{ name: 'data', mountPath: '/data' }],
              },
            ],
            volumes: [
              {
                name: 'data',
                hostPath: { path: opts.hostPath, type: 'DirectoryOrCreate' },
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: app, namespace: opts.runtimeNamespace, labels: opts.labels },
      spec: {
        selector: { app },
        ports: [{ port: runtime.port, targetPort: runtime.port }],
      },
    },
  ];
}

/**
 * Desired runtime infra for one BackingService instance.
 * Names are always `di-bs-<service-name>` so they never collide with reserved
 * `di-nats` (runtime data plane) or transitional `di-redis`. `live` is the current
 * `di-bs-<service-name>` Deployment, if any: its data hostPath is kept so existing data
 * stays reachable; otherwise the path derives from `cfg.storageRoot`.
 */
function backingServiceResources(
  service: BackingService,
  tenant: Tenant,
  cls: BackingServiceClass,
  cfg: ControllerConfig,
  sizing: SizingParameters,
  live?: Resource,
): Resource[] {
  if (cls.spec.provider === 'postgres')
    throw new Error('PostgreSQL requires the dedicated credentials and PVC reconciliation helpers');
  if (cls.spec.provider === 'platform') throw new Error('Egress services provision no backend');
  const resourceName = backingServiceResourceName(service.metadata.name);
  const n = names(tenant.metadata.name);
  const suspended = !!tenant.spec.suspended || !!tenant.metadata.deletionTimestamp;
  const replicas = suspended || service.metadata.deletionTimestamp ? 0 : 1;
  const labels = backingLabels(service, tenant, cfg.installation);
  const provider = cls.spec.provider;
  const resources = backendDeploymentResources({
    labels,
    runtimeNamespace: n.runtimeNamespace,
    name: resourceName,
    provider,
    hostPath:
      liveBackingServiceHostPath(live, service) ??
      backingServiceHostPath(cfg, tenant.metadata.uid ?? 'unknown', service.metadata.name),
    replicas,
    sizing,
  });
  // Connection material for ServiceBinding projection (#451). Status never mirrors secrets.
  resources.push(
    makeBackingResource(
      service,
      tenant,
      cfg.installation,
      'v1',
      'Secret',
      `${resourceName}-conn`,
      n.runtimeNamespace,
      {
        type: 'Opaque',
        stringData: {
          backend: provider,
          host: `${resourceName}.${n.runtimeNamespace}.svc.cluster.local`,
          port: String(PROVIDER_RUNTIME[provider].port),
          url:
            provider === 'redis'
              ? `redis://${resourceName}.${n.runtimeNamespace}.svc.cluster.local:6379`
              : `nats://${resourceName}.${n.runtimeNamespace}.svc.cluster.local:4222`,
        },
      },
    ),
  );
  return resources;
}

function endpointFor(
  service: BackingService,
  tenant: Tenant,
  provider: RuntimeProvider,
): { host: string; port: number; capability: BackingCapability } {
  const resourceName = backingServiceResourceName(service.metadata.name);
  const n = names(tenant.metadata.name);
  return {
    host: `${resourceName}.${n.runtimeNamespace}.svc.cluster.local`,
    port: PROVIDER_RUNTIME[provider].port,
    capability: service.spec.type,
  };
}

function tenantNameFromNamespace(namespace: string | undefined): string | undefined {
  if (!namespace?.startsWith('di-tenant-')) return undefined;
  return namespace.slice('di-tenant-'.length);
}

/** Why a backing-service Deployment cannot become ready, read from its status conditions. */
interface DeploymentFailure {
  reason: string;
  message: string;
}

/** Longest runtime message copied into a tenant-visible condition (webhook denials are free text). */
const MAX_FAILURE_MESSAGE = 1024;

function boundedMessage(message: string): string {
  if (message.length <= MAX_FAILURE_MESSAGE) return message;
  let end = MAX_FAILURE_MESSAGE - 1;
  // Never cut between the halves of a surrogate pair: Kubernetes would store U+FFFD for the
  // orphaned high surrogate and the stored status would never equal the computed one.
  const last = message.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${message.slice(0, end)}…`;
}

/**
 * Report a Deployment failure that will not resolve by waiting, e.g. a ResourceQuota
 * or admission rejection (`ReplicaFailure`/`FailedCreate`) or an exceeded progress
 * deadline. Returns `undefined` while the rollout is merely in progress.
 * The conditions are level-triggered: Kubernetes clears `ReplicaFailure` on the next
 * successful sync, so a brief flip back to Provisioning is expected and harmless.
 */
function deploymentFailure(deployment: Resource): DeploymentFailure | undefined {
  const status = deployment.status as
    | {
        observedGeneration?: number;
        conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
      }
    | undefined;
  const generation = deployment.metadata.generation;
  if (
    generation !== undefined &&
    status?.observedGeneration !== undefined &&
    status.observedGeneration !== generation
  )
    return undefined;
  const conditions = status?.conditions ?? [];
  const name = deployment.metadata.name;
  const replicaFailure = conditions.find((c) => c.type === 'ReplicaFailure' && c.status === 'True');
  if (replicaFailure)
    return {
      reason: replicaFailure.reason || 'ReplicaFailure',
      message: boundedMessage(
        `Backing service deployment ${name} cannot create pods: ${
          replicaFailure.message || 'replica creation failed'
        }`,
      ),
    };
  const progressing = conditions.find(
    (c) =>
      c.type === 'Progressing' && c.status === 'False' && c.reason === 'ProgressDeadlineExceeded',
  );
  if (progressing)
    return {
      reason: 'ProgressDeadlineExceeded',
      message: boundedMessage(
        `Backing service deployment ${name} did not become ready: ${
          progressing.message || 'progress deadline exceeded'
        }`,
      ),
    };
  return undefined;
}

export {
  backendDeploymentResources,
  backingLabels,
  backingServiceHostPath,
  backingServiceResourceName,
  backingServiceResources,
  CAPABILITY,
  DEFAULT_STORAGE_ROOT,
  type DeploymentFailure,
  deploymentFailure,
  endpointFor,
  liveBackingServiceHostPath,
  MAX_FAILURE_MESSAGE,
  mergeSizing,
  PROVIDER_RUNTIME,
  parseCpu,
  parseMemory,
  parseQuantity,
  RESERVED_RUNTIME_NAMES,
  RUNTIME_DATA_NATS,
  type RuntimeProvider,
  refuseReservedNames,
  resolveBackingSizing,
  resolveClass,
  SERVICE,
  TRANSITIONAL_REDIS,
  tenantNameFromNamespace,
  validateSizingAgainstClass,
  validateSizingAgainstTenantBudget,
};
