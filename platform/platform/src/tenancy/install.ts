import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { validEgressPolicyEntry } from './egress';
import {
  type BackingCapability,
  type BackingServiceClassSpec,
  CORE_INSTANCES,
  DEFAULT_CLASS_NAMES,
  DELETION_POLICIES,
  defaultClassSeed,
  INSTALLATION,
  type Resource,
  type TenantSpec,
  VERSION,
  validName,
} from './resources';
import { TENANT_OPERATOR_CLUSTER_ROLES } from './tenant-operator';

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
  const policy = tenant.deletionPolicy;
  if (policy !== undefined && !(DELETION_POLICIES as readonly string[]).includes(policy))
    throw new Error(
      `Tenant ${tenant.name} deletionPolicy must be 'Retain' or 'Delete', not '${policy}'`,
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
 * `api-keys`, `admission`, `egress`, `backing-services`, `backing-service-reconcile`, `service-binding-reconcile`,
 * `registry-nats`, and `log-projection` must ship beside `resources` / `controller` (which require them at runtime). */
export const CONTROLLER_SCRIPT_MODULES = [
  'api-keys',
  'admission',
  'egress',
  'backing-services',
  'node-image',
  'storage-mode',
  'storage-records',
  'workload-storage',
  'tls',
  'ca-rotation',
  'registry-nats',
  'resources',
  'backing-service-reconcile',
  'service-binding-reconcile',
  'postgres',
  'log-projection',
  'tenant-operator-names',
  'removal-sequence',
  'scheduler-pki',
  'scheduler-pki-rotation',
  'scheduler-identities',
  'scheduler-nats',
  'scheduler-accounts',
  'controller',
] as const;

export interface BackingServiceClassDeclaration extends BackingServiceClassSpec {
  name: string;
}

export type ControllerClusterRoleRule = {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
};

/**
 * The fixed-name Roles the controller binds (#115): the tenant roles members are bound to and the
 * tenant controller's Secret roles. It binds no Role to itself (#321). The per-tenant
 * `di-tenant-controller-<tenant>` Role and ClusterRole are not listed (`resourceNames` has no
 * wildcard); the controller holds every rule in them, which is all a binding needs without `bind`.
 */
export const CONTROLLER_BOUND_ROLES = [
  'di-developer',
  'di-viewer',
  'di-runtime-developer',
  'di-runtime-viewer',
  'tenant-controller-keys',
  'tenant-controller-secret-reader',
] as const;

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
    // The `di-developer` Role grants these (#115). Without `escalate` the controller may only
    // write a Role whose rules it holds itself.
    {
      apiGroups: ['platform.di-framework.dev'],
      resources: ['backingservices', 'servicebindings'],
      verbs: ['create', 'delete'],
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
    // Held so it can write the tenant viewer and developer Roles without `escalate` (#115).
    { apiGroups: [''], resources: ['events'], verbs: ['get', 'list', 'watch'] },
    // Also how it reads hostgroup logs for the console logs projection (#10).
    { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
    { apiGroups: [''], resources: ['pods/portforward'], verbs: ['create'] },
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
      // Read for the logs projection; patch sets the platform storage volume (#11) and approved
      // egress (#13). create and delete serve the tenant registry workload (#83): its
      // server-side apply is authorized as create while it does not exist, and unsetting
      // tenantAuth.registry deletes it. The controller itself writes only with server-side apply
      // PATCH; update is held because the `di-developer` Role grants it (#115).
      apiGroups: ['runtime.wasmcloud.dev'],
      resources: ['workloaddeployments'],
      verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
    },
    // Read access the tenant viewer and developer Roles grant (#115).
    {
      apiGroups: ['runtime.wasmcloud.dev'],
      resources: ['workloads', 'workloadreplicasets', 'artifacts'],
      verbs: ['get', 'list', 'watch'],
    },
    {
      // Merge-patches the placement-retry annotation onto unplaced Workloads (#418), and removes
      // the operator's finalizers from Workloads and Artifacts in removal step R3 (design-541 §4.5).
      apiGroups: ['runtime.wasmcloud.dev'],
      resources: ['workloads', 'artifacts'],
      verbs: ['patch'],
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
    // The one-shot Job that moves each tenant registry's object store into its NATS account
    // (#159): applied with server-side apply, read for its result.
    { apiGroups: ['batch'], resources: ['jobs'], verbs: ['get', 'create', 'patch'] },
    // No `escalate` (#115): the controller holds every rule of every Role it writes, which the
    // API server checks on each create and update. `bind` only on the fixed-name Roles it binds.
    {
      apiGroups: ['rbac.authorization.k8s.io'],
      resources: ['roles', 'rolebindings'],
      verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
    },
    {
      apiGroups: ['rbac.authorization.k8s.io'],
      resources: ['roles'],
      verbs: ['bind'],
      resourceNames: [...CONTROLLER_BOUND_ROLES],
    },
    // Each tenant operator's RoleBindings to the three fixed tenant-operator ClusterRoles
    // (#541, design-541 §4.6). The controller holds none of their rules, so it may bind exactly
    // these names; still no `escalate`. RBAC alone does not scope where: the admission policies in
    // `tenantOperatorBindingPolicies` confine these binds to the tenant namespaces and to the
    // tenant's own operator ServiceAccount, and deny ClusterRoleBindings to them.
    {
      apiGroups: ['rbac.authorization.k8s.io'],
      resources: ['clusterroles'],
      verbs: ['bind'],
      resourceNames: Object.values(TENANT_OPERATOR_CLUSTER_ROLES),
    },
    // Each tenant controller's `di-tenant-controller-<t>` ClusterRole and its binding (#58). The
    // controller already holds every permission they grant, so it needs no bind or escalate.
    // The names are per tenant, so `resourceNames` cannot scope these verbs; the admission
    // policies in `controllerClusterRbacPolicies` limit the writes to those objects (#586).
    {
      apiGroups: ['rbac.authorization.k8s.io'],
      resources: ['clusterroles', 'clusterrolebindings'],
      verbs: ['get', 'list', 'create', 'patch', 'delete'],
    },
  ];
}

/**
 * Rules the controller holds only in its own namespace (#115): TokenRequest for the members'
 * `di-user-<name>` ServiceAccounts, which each tenant's `di-tenant-controller-<tenant>` Role grants
 * there. Holding it here, not cluster-wide, lets it write that Role without `escalate`.
 */
export function controllerNamespaceRoleRules(): ControllerClusterRoleRule[] {
  return [{ apiGroups: [''], resources: ['serviceaccounts/token'], verbs: ['create'] }];
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

/** The name prefix of the only ClusterRoles and ClusterRoleBindings the controller writes (#586). */
export const CONTROLLER_CLUSTER_RBAC_PREFIX = 'di-tenant-controller-';
/** The label prefix that aggregates a ClusterRole's rules into another (#586). */
export const AGGREGATE_LABEL_PREFIX = 'rbac.authorization.k8s.io/aggregate-to-';
export const CONTROLLER_CLUSTER_RBAC_MESSAGE =
  'The platform controller may only create, change or delete the di-tenant-controller-<tenant> ' +
  'ClusterRoles and ClusterRoleBindings of its own installation, without aggregation';

/**
 * Admission for the controller's ClusterRole and ClusterRoleBinding writes (#586). Its RBAC grant
 * cannot name the per-tenant `di-tenant-controller-<tenant>` objects (`resourceNames` has no
 * wildcard), so these policies, one per kind, refuse the controller every create, change or
 * delete of any other ClusterRole or ClusterRoleBinding: the name must carry
 * {@link CONTROLLER_CLUSTER_RBAC_PREFIX}, the object (old and new) must carry this installation's
 * label, a binding must refer to the ClusterRole of its own name, and a ClusterRole may carry no
 * aggregation label or rule.
 */
export function controllerClusterRbacPolicies(installation: string, namespace: string): Resource[] {
  const labelled = (o: string) =>
    `has(${o}.metadata.labels) && '${INSTALLATION}' in ${o}.metadata.labels &&
      ${o}.metadata.labels['${INSTALLATION}'] == '${installation}'`;
  const common = `request.name.startsWith('${CONTROLLER_CLUSTER_RBAC_PREFIX}') &&
    (request.operation == 'DELETE' || (${labelled('object')})) &&
    (request.operation == 'CREATE' || (${labelled('oldObject')}))`;
  const policies = [
    {
      // An aggregation label or rule would merge rules into, or out of, other ClusterRoles.
      resource: 'clusterroles',
      expression: `${common} && (request.operation == 'DELETE' ||
        (!has(object.aggregationRule) && (!has(object.metadata.labels) ||
          !object.metadata.labels.exists(k, k.startsWith('${AGGREGATE_LABEL_PREFIX}')))))`,
    },
    {
      resource: 'clusterrolebindings',
      expression: `${common} && (request.operation == 'DELETE' ||
        (object.roleRef.apiGroup == 'rbac.authorization.k8s.io' &&
          object.roleRef.kind == 'ClusterRole' && object.roleRef.name == request.name))`,
    },
  ];
  const labels = { [INSTALLATION]: installation };
  return policies.flatMap(({ resource, expression }) => {
    const name = `${installation}-controller-${resource}`;
    return [
      {
        apiVersion: 'admissionregistration.k8s.io/v1',
        kind: 'ValidatingAdmissionPolicy',
        metadata: { name, labels },
        spec: {
          failurePolicy: 'Fail',
          matchConstraints: {
            resourceRules: [
              {
                apiGroups: ['rbac.authorization.k8s.io'],
                apiVersions: ['v1'],
                operations: ['CREATE', 'UPDATE', 'DELETE'],
                resources: [resource],
              },
            ],
          },
          matchConditions: [
            {
              name: 'platform-controller',
              expression: `request.userInfo.username == 'system:serviceaccount:${namespace}:di-platform-controller'`,
            },
          ],
          validations: [{ expression, message: CONTROLLER_CLUSTER_RBAC_MESSAGE }],
        },
      },
      {
        apiVersion: 'admissionregistration.k8s.io/v1',
        kind: 'ValidatingAdmissionPolicyBinding',
        metadata: { name, labels },
        spec: { policyName: name, validationActions: ['Deny'] },
      },
    ] as Resource[];
  });
}
