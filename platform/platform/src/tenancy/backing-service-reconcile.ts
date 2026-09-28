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
/** Label identifying capability (keyvalue|messaging) on provisioned infra. */
const CAPABILITY = `${GROUP}/capability`;

/**
 * Runtime-internal data-plane NATS used by hostgroup `--data-nats-url`.
 * This is NOT an application BackingService and must never be created by
 * `reconcileBackingService`. Application messaging uses `di-bs-<name>` only.
 */
const RUNTIME_DATA_NATS = 'di-nats';

/** Transitional warehouse Redis still owned by Tenant reconcile (#456 migrates). */
const TRANSITIONAL_REDIS = 'di-redis';

/** Fixed provider images — never tenant-supplied. */
const PROVIDER_RUNTIME: Record<BackingProvider, { image: string; port: number; args: string[] }> = {
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

function backingServiceResourceName(serviceName: string): string {
  return `di-bs-${serviceName}`;
}

function backingServiceHostPath(tenantUid: string, serviceName: string): string {
  return `/var/lib/k0s/di-tenants/${tenantUid}/bs-${serviceName}`;
}

function runtimeDataNatsHostPath(tenantUid: string): string {
  return `/var/lib/k0s/di-tenants/${tenantUid}/${RUNTIME_DATA_NATS}`;
}

function transitionalRedisHostPath(tenantUid: string): string {
  return `/var/lib/k0s/di-tenants/${tenantUid}/${TRANSITIONAL_REDIS}`;
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
  provider: BackingProvider;
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
 * `di-nats` (runtime data plane) or transitional `di-redis`.
 */
function backingServiceResources(
  service: BackingService,
  tenant: Tenant,
  cls: BackingServiceClass,
  cfg: ControllerConfig,
  sizing: SizingParameters,
): Resource[] {
  if (cls.spec.provider === 'postgres')
    throw new Error('PostgreSQL requires the dedicated credentials and PVC reconciliation helpers');
  const resourceName = backingServiceResourceName(service.metadata.name);
  if (RESERVED_RUNTIME_NAMES.has(resourceName))
    throw new Error(`Refusing to provision reserved name ${resourceName}`);
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
    hostPath: backingServiceHostPath(tenant.metadata.uid ?? 'unknown', service.metadata.name),
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
  provider: BackingProvider,
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

export {
  backendDeploymentResources,
  backingLabels,
  backingServiceHostPath,
  backingServiceResourceName,
  backingServiceResources,
  CAPABILITY,
  endpointFor,
  mergeSizing,
  PROVIDER_RUNTIME,
  parseCpu,
  parseMemory,
  parseQuantity,
  RESERVED_RUNTIME_NAMES,
  RUNTIME_DATA_NATS,
  resolveBackingSizing,
  resolveClass,
  runtimeDataNatsHostPath,
  SERVICE,
  TRANSITIONAL_REDIS,
  tenantNameFromNamespace,
  transitionalRedisHostPath,
  validateSizingAgainstClass,
  validateSizingAgainstTenantBudget,
};
