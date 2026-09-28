import * as k8s from '@pulumi/kubernetes';
import type * as pulumi from '@pulumi/pulumi';
import { admissionResources } from './tenancy/admission';
import {
  type BackingServiceClassDeclaration,
  controllerClusterRoleRules,
  controllerScriptHash,
  defaultBackingServiceClasses,
  loadControllerScripts,
} from './tenancy/install';
import {
  crds,
  INSTALLATION,
  names,
  type Resource,
  TENANT,
  type TenantSpec,
  type UserSpec,
  VERSION,
  validName,
} from './tenancy/resources';

export {
  type BackingClassConfig,
  type BackingServiceClassDeclaration,
  CONTROLLER_SCRIPT_MODULES,
  type ControllerClusterRoleRule,
  controllerClusterRoleRules,
  controllerScriptHash,
  defaultBackingServiceClasses,
  loadControllerScripts,
  resolveBackingServiceClasses,
} from './tenancy/install';

export interface TenantDeclaration extends TenantSpec {
  name: string;
}
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
  insecureRegistry?: boolean;
  storageRoot?: string;
  /** When omitted, seeds platform defaults (`keyvalue-redis`, `messaging-nats`). */
  backingServiceClasses?: BackingServiceClassDeclaration[];
}): {
  tenants: k8s.apiextensions.CustomResource[];
  users: k8s.apiextensions.CustomResource[];
  backingServiceClasses: k8s.apiextensions.CustomResource[];
} {
  const { installation, namespace, provider } = args;
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
  function create(
    value: Resource,
    dependsOn: pulumi.Resource[] = args.dependsOn,
    opts: { retainOnDelete?: boolean } = {},
  ): pulumi.CustomResource {
    const name = `${value.kind.toLowerCase()}-${value.metadata.name}`;
    if (value.apiVersion === 'v1') {
      if (value.kind === 'ServiceAccount')
        return new k8s.core.v1.ServiceAccount(
          name,
          { metadata: value.metadata },
          { provider, dependsOn },
        );
      if (value.kind === 'ConfigMap')
        return new k8s.core.v1.ConfigMap(
          name,
          { metadata: value.metadata, data: value.data as Record<string, string> },
          { provider, dependsOn },
        );
      throw new Error(`Unsupported core resource ${value.kind}`);
    }
    return createCustom(value, dependsOn, opts);
  }
  // CRDs use retainOnDelete so Pulumi destroy/upgrade does not cascade-delete tenant
  // BackingService / ServiceBinding instances if the cluster outlives the stack.
  // Full volume/data retention for BackingService is owned by #453.
  const definitions = crds.map((value) => create(value, args.dependsOn, { retainOnDelete: true }));
  const policies = admissionResources(installation, namespace).map((value) => create(value));
  const script = loadControllerScripts();
  const scriptHash = controllerScriptHash(script);
  const serviceAccount = create({
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'di-platform-controller', namespace },
  });
  const role = create({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name: `${installation}-controller` },
    rules: controllerClusterRoleRules(),
  });
  const binding = create(
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
  const scripts = create({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'di-platform-controller', namespace },
    data: script,
  });
  const network = create({
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
  const controller = create(
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
                image: 'node:22.18.0-alpine3.22',
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
                      insecureRegistry: args.insecureRegistry ?? false,
                      storageRoot: args.storageRoot,
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
    [...definitions, ...policies, ...backingServiceClasses, binding, scripts, network],
  );
  const tenants = args.tenants.map(({ name, ...spec }) =>
    createCustom(
      {
        apiVersion: VERSION,
        kind: 'Tenant',
        metadata: {
          name,
          labels: { [INSTALLATION]: installation },
          annotations: { 'pulumi.com/waitFor': 'condition=Ready' },
        },
        spec,
      } as Resource,
      [controller, ...args.dependsOn],
    ),
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
