import * as k8s from '@pulumi/kubernetes';
import type * as pulumi from '@pulumi/pulumi';
import { admissionResources } from './tenancy/admission';
import {
  assertTenantDeclaration,
  type BackingServiceClassDeclaration,
  controllerClusterRoleRules,
  controllerNamespaceRoleRules,
  controllerScriptHash,
  defaultBackingServiceClasses,
  loadControllerScripts,
  type TenantDeclaration,
  tenantObject,
} from './tenancy/install';
import {
  assertRuntimeNatsConfig,
  assertTenantAuthConfig,
  crds,
  INSTALLATION,
  names,
  type Resource,
  type RuntimeNatsConfig,
  registryHttpHost,
  TENANT,
  type TenantAuthConfig,
  type UserSpec,
  VERSION,
  validName,
} from './tenancy/resources';
import { tenantOperatorClusterRoles } from './tenancy/tenant-operator';

export {
  type BackingClassConfig,
  type BackingServiceClassDeclaration,
  CONTROLLER_BOUND_ROLES,
  CONTROLLER_SCRIPT_MODULES,
  type ControllerClusterRoleRule,
  controllerClusterRoleRules,
  controllerNamespaceRoleRules,
  controllerScriptHash,
  defaultBackingServiceClasses,
  loadControllerScripts,
  resolveBackingServiceClasses,
  type TenantDeclaration,
  tenantObject,
} from './tenancy/install';

import { NODE_IMAGE } from './tenancy/node-image';
import { tenantAuthReadsApiKeyNamespace } from './tenant-auth-images';

export interface UserDeclaration extends UserSpec {
  name: string;
}
export function declarations(config: pulumi.Config): {
  tenants: TenantDeclaration[];
  users: UserDeclaration[];
} {
  const tenants = config.getObject<TenantDeclaration[]>('tenants') ?? [];
  const users = config.getObject<UserDeclaration[]>('users') ?? [];
  for (const [kind, values] of [
    ['tenants', tenants],
    ['users', users],
  ] as const) {
    if (!Array.isArray(values) || values.some((value) => !value || !validName(value.name)))
      throw new Error(
        `${kind} must be an array with valid names (1–40 lowercase letters, digits, hyphens; starting with a letter)`,
      );
    if (new Set(values.map((v) => v.name)).size !== values.length)
      throw new Error(`Duplicate ${kind} names`);
  }
  for (const tenant of tenants) assertTenantDeclaration(tenant);
  for (const user of users) {
    if (
      !Array.isArray(user.memberships) ||
      new Set(user.memberships.map((m) => m.tenant)).size !== user.memberships.length ||
      user.memberships.some(
        (m) =>
          !tenants.some((t) => t.name === m.tenant) || !['developer', 'viewer'].includes(m.role),
      )
    ) {
      throw new Error(
        `User ${user.name} must have unique memberships referring to configured tenants with developer or viewer roles`,
      );
    }
  }
  return { tenants, users };
}
export function seedTenantNamespaces(
  tenants: TenantDeclaration[],
  installation: string,
  provider: k8s.Provider,
): k8s.core.v1.Namespace[] {
  return tenants.flatMap((tenant) => {
    const n = names(tenant.name);
    return [n.namespace, n.runtimeNamespace].map(
      (name) =>
        new k8s.core.v1.Namespace(
          name,
          {
            metadata: { name, labels: { [INSTALLATION]: installation, [TENANT]: tenant.name } },
          },
          { provider, retainOnDelete: true },
        ),
    );
  });
}
export function installTenancy(args: {
  installation: string;
  namespace: string;
  provider: k8s.Provider;
  dependsOn: pulumi.Resource[];
  tenants: TenantDeclaration[];
  users: UserDeclaration[];
  hostImage: string;
  hostImagePullPolicy: string;
  /** Tenant hosts' `--insecure-registry` entries (#149). */
  insecureRegistries?: string[];
  storageRoot?: string;
  /** Gateway URL pattern; the controller publishes it per tenant as `di-platform-routes`. */
  routeUrlPattern?: string;
  /** Each tenant's controller and console (#58); omitted, the controller deploys neither. */
  tenantAuth?: TenantAuthConfig;
  /** JetStream storage caps of each tenant's `di-nats` (#160); omitted, the defaults apply. */
  runtimeNats?: RuntimeNatsConfig;
  /** When omitted, seeds platform defaults (`keyvalue-redis`, `messaging-nats`, `blobstore-nats`, `postgres-dedicated`, `egress-public` approving nothing). */
  backingServiceClasses?: BackingServiceClassDeclaration[];
}): {
  tenants: k8s.apiextensions.CustomResource[];
  users: k8s.apiextensions.CustomResource[];
  backingServiceClasses: k8s.apiextensions.CustomResource[];
} {
  const { installation, namespace, provider } = args;
  assertTenantAuthConfig(args.tenantAuth);
  assertRuntimeNatsConfig(args.runtimeNats);
  function createCustom(
    value: Resource,
    dependsOn: pulumi.Resource[] = args.dependsOn,
    opts: { retainOnDelete?: boolean } = {},
  ): k8s.apiextensions.CustomResource {
    return new k8s.apiextensions.CustomResource(
      `${value.kind.toLowerCase()}-${value.metadata.name}`,
      value,
      { provider, dependsOn, retainOnDelete: opts.retainOnDelete },
    );
  }
  // CRDs use retainOnDelete so Pulumi destroy/upgrade does not cascade-delete tenant
  // BackingService / ServiceBinding instances if the cluster outlives the stack.
  // Full volume/data retention for BackingService is owned by #453.
  const definitions = crds.map((value) =>
    createCustom(value, args.dependsOn, { retainOnDelete: true }),
  );
  const policies = admissionResources(
    installation,
    namespace,
    registryHttpHost(args.tenantAuth),
  ).map((value) => createCustom(value));
  const script = loadControllerScripts();
  const scriptHash = controllerScriptHash(script);
  const serviceAccount = new k8s.core.v1.ServiceAccount(
    'serviceaccount-di-platform-controller',
    { metadata: { name: 'di-platform-controller', namespace } },
    { provider, dependsOn: args.dependsOn },
  );
  // TokenRequest in this namespace only (#115), for the per-tenant TokenRequest Roles it writes.
  const namespaceRole = createCustom({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: `${installation}-controller`, namespace },
    rules: controllerNamespaceRoleRules(),
  });
  const namespaceBinding = createCustom(
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: `${installation}-controller`, namespace },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: `${installation}-controller`,
      },
      subjects: [{ kind: 'ServiceAccount', name: 'di-platform-controller', namespace }],
    },
    [namespaceRole, serviceAccount],
  );
  // The ClusterRole drops `escalate` (#115), so it waits for the namespaced TokenRequest grant:
  // the running controller keeps writing the per-tenant TokenRequest Roles across `pulumi up`.
  const role = createCustom(
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: `${installation}-controller` },
      rules: controllerClusterRoleRules(),
    },
    [namespaceBinding],
  );
  // The three fixed tenant-operator ClusterRoles (#541, design-541 §4.6). Nothing binds them
  // cluster-wide; the controller binds them per tenant with RoleBindings only.
  for (const value of tenantOperatorClusterRoles(installation)) createCustom(value);
  const binding = createCustom(
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: `${installation}-controller` },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: `${installation}-controller`,
      },
      subjects: [{ kind: 'ServiceAccount', name: 'di-platform-controller', namespace }],
    },
    [role, serviceAccount],
  );
  const scripts = new k8s.core.v1.ConfigMap(
    'configmap-di-platform-controller',
    { metadata: { name: 'di-platform-controller', namespace }, data: script },
    { provider, dependsOn: args.dependsOn },
  );
  const network = createCustom({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'di-tenant-scheduler', namespace },
    spec: {
      podSelector: { matchLabels: { 'wasmcloud.com/name': 'nats' } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
              podSelector: {
                matchExpressions: [
                  {
                    key: 'wasmcloud.com/name',
                    operator: 'In',
                    values: ['hostgroup', 'runtime-operator'],
                  },
                ],
              },
            },
            {
              namespaceSelector: {
                matchLabels: { [INSTALLATION]: installation },
                matchExpressions: [{ key: TENANT, operator: 'Exists' }],
              },
              podSelector: { matchLabels: { 'wasmcloud.com/name': 'hostgroup' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 4222 }],
        },
      ],
    },
  });
  const classSeeds = args.backingServiceClasses ?? defaultBackingServiceClasses();
  const backingServiceClasses = classSeeds.map(({ name, ...spec }) =>
    createCustom(
      {
        apiVersion: VERSION,
        kind: 'BackingServiceClass',
        metadata: {
          name,
          labels: { [INSTALLATION]: installation },
        },
        spec,
      } as Resource,
      definitions,
    ),
  );
  const controller = createCustom(
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'di-platform-controller', namespace },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app: 'di-platform-controller' } },
        template: {
          metadata: {
            labels: { app: 'di-platform-controller' },
            annotations: { 'di-framework.dev/script-hash': scriptHash },
          },
          spec: {
            serviceAccountName: 'di-platform-controller',
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'controller',
                image: NODE_IMAGE,
                command: ['node', '/controller/controller.js'],
                env: [
                  {
                    name: 'PLATFORM_CONFIG',
                    value: JSON.stringify({
                      installation,
                      namespace,
                      hostImage: args.hostImage,
                      hostImagePullPolicy: args.hostImagePullPolicy,
                      schedulerNatsUrl: `nats://nats.${namespace}.svc.cluster.local:4222`,
                      // Sorted, so reordering the config does not restart the controller (#544).
                      tenants: args.tenants
                        .map((tenant) => tenant.name)
                        .sort((a, b) => a.localeCompare(b)),
                      insecureRegistries: args.insecureRegistries ?? [],
                      storageRoot: args.storageRoot,
                      routeUrlPattern: args.routeUrlPattern,
                      tenantAuth: args.tenantAuth,
                      // API keys move out of the runtime namespace only under such an image (#379).
                      tenantAuthReadsApiKeyNamespace:
                        !!args.tenantAuth && tenantAuthReadsApiKeyNamespace(args.tenantAuth.image),
                      runtimeNats: args.runtimeNats,
                    }),
                  },
                ],
                resources: {
                  requests: { cpu: '20m', memory: '64Mi' },
                  limits: { cpu: '250m', memory: '128Mi' },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [{ name: 'scripts', mountPath: '/controller', readOnly: true }],
              },
            ],
            volumes: [{ name: 'scripts', configMap: { name: 'di-platform-controller' } }],
          },
        },
      },
    },
    [
      ...definitions,
      ...policies,
      ...backingServiceClasses,
      binding,
      namespaceBinding,
      scripts,
      network,
    ],
  );
  const tenants = args.tenants.map((tenant) =>
    createCustom(tenantObject(tenant, installation), [controller, ...args.dependsOn]),
  );
  const users = args.users.map(({ name, ...spec }) =>
    createCustom(
      {
        apiVersion: VERSION,
        kind: 'User',
        metadata: {
          name,
          labels: { [INSTALLATION]: installation },
          annotations: { 'pulumi.com/waitFor': 'condition=Ready' },
        },
        spec,
      } as Resource,
      [controller, ...tenants],
    ),
  );
  return { tenants, users, backingServiceClasses };
}
