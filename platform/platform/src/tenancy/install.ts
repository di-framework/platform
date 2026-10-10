import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { validEgressPolicyEntry } from './egress';
import {
  type BackingCapability,
  type BackingServiceClassSpec,
  CORE_INSTANCES,
  DEFAULT_CLASS_NAMES,
  defaultClassSeed,
  INSTALLATION,
  type Resource,
  type TenantSpec,
  VERSION,
  validName,
} from './resources';

/** One `tenants` Pulumi config entry, for example `{ name: identity, runtime: { coreInstances: 300 } }`. */
export interface TenantDeclaration extends TenantSpec {
  name: string;
}
/** Rejects settings the Tenant CRD schema would reject, before `pulumi up` reaches the cluster. */
export function assertTenantDeclaration(tenant: TenantDeclaration): void {
  const core = tenant.runtime?.coreInstances;
  if (
    core !== undefined &&
    (!Number.isInteger(core) || core < CORE_INSTANCES.minimum || core > CORE_INSTANCES.maximum)
  )
    throw new Error(
      `Tenant ${tenant.name} runtime.coreInstances must be an integer from ${CORE_INSTANCES.minimum} to ${CORE_INSTANCES.maximum}`,
    );
}
/** The Tenant CR for one `tenants` config entry: everything but `name` is the spec. */
export function tenantObject({ name, ...spec }: TenantDeclaration, installation: string): Resource {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name,
      labels: { [INSTALLATION]: installation },
      annotations: { 'pulumi.com/waitFor': 'condition=Ready' },
    },
    spec,
  } as Resource;
}

/** Controller ConfigMap modules. TypeScript emit does not bundle imports, so
 * `egress`, `backing-services`, `backing-service-reconcile`, `service-binding-reconcile`, and
 * `log-projection` must ship beside `resources` / `controller` (which require them at runtime). */
export const CONTROLLER_SCRIPT_MODULES = [
  'egress',
  'backing-services',
  'workload-storage',
  'tls',
  'resources',
  'backing-service-reconcile',
  'service-binding-reconcile',
  'postgres',
  'log-projection',
  'controller',
] as const;

export interface BackingServiceClassDeclaration extends BackingServiceClassSpec {
  name: string;
}

export type ControllerClusterRoleRule = {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
};

/**
 * Platform-owned default classes (`keyvalue-redis`, `messaging-nats`, `blobstore-nats`,
 * `postgres-dedicated`, `egress-public`). `egress-public` approves only
 * `egressAllowedDestinations`; the default `[]` approves nothing.
 */
export function defaultBackingServiceClasses(
  egressAllowedDestinations: string[] = [],
): BackingServiceClassDeclaration[] {
  return (Object.keys(DEFAULT_CLASS_NAMES) as BackingCapability[]).map((type) => ({
    name: DEFAULT_CLASS_NAMES[type],
    ...defaultClassSeed(type, egressAllowedDestinations),
  }));
}

export interface BackingClassConfig {
  getBoolean(key: string): boolean | undefined;
  getObject(key: string): unknown;
}

/** Resolve class seeds: `seedDefaultBackingClasses` (default true), optional
 * `backingServiceClasses` overrides/replacements, and `egressAllowedDestinations` for the
 * default `egress-public` class. */
export function resolveBackingServiceClasses(
  config: BackingClassConfig,
): BackingServiceClassDeclaration[] {
  const seedDefaults = config.getBoolean('seedDefaultBackingClasses') ?? true;
  const egressAllowedDestinations = config.getObject('egressAllowedDestinations') ?? [];
  if (
    !Array.isArray(egressAllowedDestinations) ||
    !egressAllowedDestinations.every(validEgressPolicyEntry)
  )
    throw new Error(
      'egressAllowedDestinations must be a list of host:port or *.suffix:port entries (lowercase, port required)',
    );
  const configured =
    (config.getObject('backingServiceClasses') as BackingServiceClassDeclaration[] | undefined) ??
    [];
  if (!Array.isArray(configured))
    throw new Error('backingServiceClasses must be an array of named class specs');
  for (const cls of configured) {
    if (!cls || !validName(cls.name))
      throw new Error(
        'backingServiceClasses entries need valid names (1–40 lowercase letters, digits, hyphens; starting with a letter)',
      );
  }
  if (new Set(configured.map((c) => c.name)).size !== configured.length)
    throw new Error('Duplicate backingServiceClasses names');
  if (!seedDefaults) return configured;
  const byName = new Map(
    defaultBackingServiceClasses(egressAllowedDestinations as string[]).map((c) => [c.name, c]),
  );
  for (const cls of configured) byName.set(cls.name, cls);
  return [...byName.values()];
}

/** ClusterRole rules for the platform controller, including backing-service CRDs. */
export function controllerClusterRoleRules(): ControllerClusterRoleRule[] {
  return [
    {
      apiGroups: ['platform.di-framework.dev'],
      resources: [
        'tenants',
        'users',
        'tenants/status',
        'users/status',
        'tenants/finalizers',
        'users/finalizers',
        'backingserviceclasses',
        'backingservices',
        'servicebindings',
        'backingserviceclasses/status',
        'backingservices/status',
        'servicebindings/status',
        'backingserviceclasses/finalizers',
        'backingservices/finalizers',
        'servicebindings/finalizers',
      ],
      verbs: ['get', 'list', 'watch', 'patch', 'update'],
    },
    {
      apiGroups: [''],
      resources: [
        'namespaces',
        'serviceaccounts',
        'configmaps',
        'services',
        'resourcequotas',
        'secrets',
        'persistentvolumeclaims',
      ],
      verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
    },
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
    // The API server endpoints each tenant controller's egress policy allows (#58).
    { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['get', 'list'] },
    {
      apiGroups: ['storage.k8s.io'],
      resources: ['storageclasses'],
      verbs: ['get', 'list', 'watch'],
    },
    {
      apiGroups: ['runtime.wasmcloud.dev'],
      resources: ['hosts'],
      verbs: ['get', 'list', 'watch'],
    },
    {
      // Read for the logs projection; patch only sets the platform storage volume (#11)
      // and approved egress (#13).
      apiGroups: ['runtime.wasmcloud.dev'],
      resources: ['workloaddeployments'],
      verbs: ['get', 'list', 'watch', 'patch'],
    },
    {
      apiGroups: ['apps'],
      resources: ['deployments'],
      verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
    },
    {
      apiGroups: ['networking.k8s.io'],
      resources: ['networkpolicies'],
      verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
    },
    {
      apiGroups: ['rbac.authorization.k8s.io'],
      resources: ['roles', 'rolebindings'],
      verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete', 'bind', 'escalate'],
    },
    // Each tenant controller's `di-tenant-controller-<t>` ClusterRole and its binding (#58). The
    // controller already holds every permission they grant, so it needs no bind or escalate.
    {
      apiGroups: ['rbac.authorization.k8s.io'],
      resources: ['clusterroles', 'clusterrolebindings'],
      verbs: ['get', 'list', 'create', 'patch', 'delete'],
    },
  ];
}

/** Load compiled controller scripts from the package dist (`tsc` emit under `tenancy/`). */
export function loadControllerScripts(tenancyDir: string = __dirname): Record<string, string> {
  return Object.fromEntries(
    CONTROLLER_SCRIPT_MODULES.map((name) => [
      `${name}.js`,
      readFileSync(path.join(tenancyDir, `${name}.js`), 'utf8'),
    ]),
  );
}

export function controllerScriptHash(scripts: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(scripts)).digest('hex');
}
