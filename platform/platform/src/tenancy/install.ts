import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  type BackingCapability,
  type BackingServiceClassSpec,
  DEFAULT_CLASS_NAMES,
  defaultClassSeed,
  validName,
} from './resources';

/** Controller ConfigMap modules. TypeScript emit does not bundle imports, so
 * `backing-services`, `backing-service-reconcile`, and `service-binding-reconcile`
 * must ship beside `resources` / `controller` (which require them at runtime). */
export const CONTROLLER_SCRIPT_MODULES = [
  'backing-services',
  'resources',
  'backing-service-reconcile',
  'service-binding-reconcile',
  'postgres',
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

/** Platform-owned default classes (`keyvalue-redis`, `messaging-nats`). */
export function defaultBackingServiceClasses(): BackingServiceClassDeclaration[] {
  return (Object.keys(DEFAULT_CLASS_NAMES) as BackingCapability[]).map((type) => ({
    name: DEFAULT_CLASS_NAMES[type],
    ...defaultClassSeed(type),
  }));
}

export interface BackingClassConfig {
  getBoolean(key: string): boolean | undefined;
  getObject(key: string): unknown;
}

/** Resolve class seeds: `seedDefaultBackingClasses` (default true) and optional
 * `backingServiceClasses` overrides/replacements. */
export function resolveBackingServiceClasses(
  config: BackingClassConfig,
): BackingServiceClassDeclaration[] {
  const seedDefaults = config.getBoolean('seedDefaultBackingClasses') ?? true;
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
  const byName = new Map(defaultBackingServiceClasses().map((c) => [c.name, c]));
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
