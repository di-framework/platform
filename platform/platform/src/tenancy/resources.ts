import { backingServiceCrds } from './backing-services';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
export interface Metadata {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  finalizers?: string[];
  deletionTimestamp?: string;
}
export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string;
  message: string;
  observedGeneration: number;
  lastTransitionTime: string;
}
export interface TenantSpec {
  suspended?: boolean;
  deletionPolicy?: 'Retain' | 'Delete';
  runtime?: { replicas?: number };
  resources?: {
    cpu?: string;
    memory?: string;
    workloads?: number;
    /** Max concurrent BackingService objects in the tenant namespace (default 10). */
    backingServices?: number;
    /** Max concurrent ServiceBinding objects in the tenant namespace (default 40). */
    serviceBindings?: number;
  };
}
export interface UserSpec {
  suspended?: boolean;
  memberships: { tenant: string; role: 'developer' | 'viewer' }[];
}
export interface CustomResource<S> {
  apiVersion: string;
  kind: 'Tenant' | 'User';
  metadata: Metadata;
  spec: S;
  status?: { conditions?: Condition[]; observedGeneration?: number; [key: string]: unknown };
}
export type Tenant = CustomResource<TenantSpec>;
export type User = CustomResource<UserSpec>;
export interface Resource {
  apiVersion: string;
  kind: string;
  metadata: Metadata;
  [key: string]: unknown;
}
export interface ControllerConfig {
  installation: string;
  namespace: string;
  hostImage: string;
  hostImagePullPolicy?: string;
  schedulerNatsUrl: string;
  insecureRegistry: boolean;
  storageRoot?: string;
}
const GROUP = 'platform.di-framework.dev';
const VERSION = `${GROUP}/v1alpha1`;
const INSTALLATION = `${GROUP}/installation`;
const OWNER = `${GROUP}/owner-uid`;
const TENANT = `${GROUP}/tenant`;
const USER = `${GROUP}/user`;
const FINALIZER = `${GROUP}/cleanup`;
const nameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 40,
  pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
};
const quantity = { type: 'string', minLength: 1, pattern: '^[0-9]+(\\.[0-9]+)?(m|Ki|Mi|Gi|Ti)?$' };
const conditions = {
  type: 'array',
  'x-kubernetes-list-type': 'map',
  'x-kubernetes-list-map-keys': ['type'],
  items: {
    type: 'object',
    required: ['type', 'status', 'reason', 'message', 'lastTransitionTime', 'observedGeneration'],
    properties: {
      type: { type: 'string' },
      status: { type: 'string', enum: ['True', 'False', 'Unknown'] },
      reason: { type: 'string' },
      message: { type: 'string' },
      lastTransitionTime: { type: 'string', format: 'date-time' },
      observedGeneration: { type: 'integer', format: 'int64' },
    },
  },
};
function crd(kind: string, plural: string, spec: Json, status: Record<string, Json>) {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: `${plural}.${GROUP}` },
    spec: {
      group: GROUP,
      scope: 'Cluster',
      names: { kind, plural, singular: kind.toLowerCase() },
      versions: [
        {
          name: 'v1alpha1',
          served: true,
          storage: true,
          subresources: { status: {} },
          additionalPrinterColumns: [
            {
              name: 'Ready',
              type: 'string',
              jsonPath: '.status.conditions[?(@.type=="Ready")].status',
            },
            { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
          ],
          schema: {
            openAPIV3Schema: {
              type: 'object',
              required: ['spec'],
              properties: {
                apiVersion: { type: 'string' },
                kind: { type: 'string' },
                metadata: { type: 'object', properties: { name: nameSchema } },
                spec,
                status: {
                  type: 'object',
                  properties: {
                    conditions,
                    observedGeneration: { type: 'integer', format: 'int64' },
                    ...status,
                  },
                },
              },
            },
          },
        },
      ],
    },
  };
}
const crds = [
  crd(
    'Tenant',
    'tenants',
    {
      type: 'object',
      properties: {
        suspended: { type: 'boolean', default: false },
        deletionPolicy: { type: 'string', enum: ['Retain', 'Delete'], default: 'Retain' },
        runtime: {
          type: 'object',
          default: {},
          properties: { replicas: { type: 'integer', minimum: 1, maximum: 10, default: 1 } },
        },
        resources: {
          type: 'object',
          default: {},
          properties: {
            cpu: { ...quantity, default: '2' },
            memory: { ...quantity, default: '4Gi' },
            workloads: { type: 'integer', minimum: 1, maximum: 1000, default: 20 },
            backingServices: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            serviceBindings: { type: 'integer', minimum: 1, maximum: 400, default: 40 },
          },
        },
      },
    },
    {
      namespace: { type: 'string' },
      runtimeNamespace: { type: 'string' },
      hostgroup: { type: 'string' },
      httpService: { type: 'string' },
    },
  ),
  crd(
    'User',
    'users',
    {
      type: 'object',
      required: ['memberships'],
      properties: {
        suspended: { type: 'boolean', default: false },
        memberships: {
          type: 'array',
          maxItems: 100,
          'x-kubernetes-list-type': 'map',
          'x-kubernetes-list-map-keys': ['tenant'],
          items: {
            type: 'object',
            required: ['tenant', 'role'],
            properties: {
              tenant: nameSchema,
              role: { type: 'string', enum: ['developer', 'viewer'] },
            },
          },
        },
      },
    },
    {
      serviceAccount: {
        type: 'object',
        properties: { name: { type: 'string' }, namespace: { type: 'string' } },
      },
    },
  ),
  ...backingServiceCrds,
];
function names(name: string) {
  return {
    namespace: `di-tenant-${name}`,
    runtimeNamespace: `di-runtime-${name}`,
    hostgroup: `tenant-${name}`,
  };
}
function validName(name: unknown) {
  return (
    typeof name === 'string' && name.length <= 40 && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)
  );
}
function labels(owner: Tenant | User, installation: string): Record<string, string> {
  return {
    [INSTALLATION]: installation,
    [OWNER]: owner.metadata.uid ?? '',
    [owner.kind === 'Tenant' ? TENANT : USER]: owner.metadata.name,
  };
}
function resource(
  owner: Tenant | User,
  installation: string,
  apiVersion: string,
  kind: string,
  name: string,
  namespace: string | undefined,
  body: Record<string, unknown>,
): Resource {
  return {
    apiVersion,
    kind,
    metadata: { name, ...(namespace ? { namespace } : {}), labels: labels(owner, installation) },
    ...body,
  };
}
const readVerbs = ['get', 'list', 'watch'];
const editVerbs = [...readVerbs, 'create', 'update', 'patch', 'delete'];
function tenantResources(
  tenant: Tenant,
  cfg: ControllerConfig,
  schedulerSecret?: { data: Record<string, string> },
): Resource[] {
  const n = names(tenant.metadata.name);
  const make = (
    apiVersion: string,
    kind: string,
    name: string,
    namespace: string,
    body: Record<string, unknown>,
  ) => resource(tenant, cfg.installation, apiVersion, kind, name, namespace, body);
  const suspended = tenant.spec.suspended || !!tenant.metadata.deletionTimestamp;
  const replicas = suspended ? 0 : (tenant.spec.runtime?.replicas ?? 1);
  const resources = tenant.spec.resources ?? {};
  const workloadRead = {
    apiGroups: ['runtime.wasmcloud.dev'],
    resources: ['workloaddeployments', 'workloads', 'workloadreplicasets', 'artifacts'],
    verbs: readVerbs,
  };
  const result = [
    make('v1', 'ResourceQuota', 'di-tenant-quota', n.namespace, {
      spec: {
        hard: {
          'count/workloaddeployments.runtime.wasmcloud.dev': String(resources.workloads ?? 20),
          [`count/backingservices.${GROUP}`]: String(resources.backingServices ?? 10),
          [`count/servicebindings.${GROUP}`]: String(resources.serviceBindings ?? 40),
          'count/secrets': '100',
          'count/configmaps': '100',
          'count/services': '100',
        },
      },
    }),
    make('v1', 'ResourceQuota', 'di-runtime-quota', n.runtimeNamespace, {
      spec: {
        hard: {
          'limits.cpu': resources.cpu ?? '2',
          'limits.memory': resources.memory ?? '4Gi',
          pods: '20',
          // Aggregate compute/storage budget for runtime + controller-managed di-bs-* backends.
          // Per-service sizing still comes from BackingServiceClass parametersSchema (#450).
          'requests.storage': '50Gi',
        },
      },
    }),
    make('rbac.authorization.k8s.io/v1', 'Role', 'di-developer', n.namespace, {
      rules: [
        workloadRead,
        {
          apiGroups: ['runtime.wasmcloud.dev'],
          resources: ['workloaddeployments'],
          verbs: editVerbs,
        },
        {
          apiGroups: [GROUP],
          resources: ['backingservices', 'servicebindings'],
          verbs: editVerbs,
        },
        { apiGroups: [''], resources: ['services', 'secrets', 'configmaps'], verbs: editVerbs },
        { apiGroups: [''], resources: ['events'], verbs: readVerbs },
      ],
    }),
    make('rbac.authorization.k8s.io/v1', 'Role', 'di-viewer', n.namespace, {
      rules: [
        workloadRead,
        {
          apiGroups: [GROUP],
          resources: ['backingservices', 'servicebindings'],
          verbs: readVerbs,
        },
        { apiGroups: [''], resources: ['services', 'configmaps', 'events'], verbs: readVerbs },
      ],
    }),
    make('rbac.authorization.k8s.io/v1', 'Role', 'di-runtime-viewer', n.runtimeNamespace, {
      rules: [
        { apiGroups: [''], resources: ['pods', 'services', 'events'], verbs: readVerbs },
        { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
      ],
    }),
    make('rbac.authorization.k8s.io/v1', 'Role', 'di-runtime-developer', n.runtimeNamespace, {
      rules: [
        { apiGroups: [''], resources: ['pods', 'services', 'events'], verbs: readVerbs },
        { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
        { apiGroups: [''], resources: ['pods/portforward'], verbs: ['create'] },
      ],
    }),
    make('v1', 'ServiceAccount', 'di-runtime', n.runtimeNamespace, {
      automountServiceAccountToken: false,
    }),
    make('v1', 'ConfigMap', 'di-tenant-stock', n.namespace, {
      data: {
        backend: 'redis',
        url: `redis://di-redis.${n.runtimeNamespace}.svc.cluster.local:6379`,
        prefix: 'stock:',
      },
    }),
  ];
  for (const namespace of [n.namespace, n.runtimeNamespace])
    result.push(
      make('networking.k8s.io/v1', 'NetworkPolicy', 'di-tenant-network', namespace, {
        spec: {
          // Broad tenant↔runtime allow for non-backend pods. Backends use di-bs-backend-network.
          podSelector: {
            matchExpressions: [
              {
                key: `${GROUP}/component`,
                operator: 'NotIn',
                values: ['backing-service'],
              },
            ],
          },
          policyTypes: ['Ingress', 'Egress'],
          ingress: [
            {
              from: [n.namespace, n.runtimeNamespace].map((name) => ({
                namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } },
              })),
            },
          ],
          egress: [
            {
              to: [n.namespace, n.runtimeNamespace].map((name) => ({
                namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } },
              })),
            },
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
                  },
                  podSelector: {
                    matchExpressions: [
                      { key: 'k8s-app', operator: 'In', values: ['kube-dns', 'coredns'] },
                    ],
                  },
                },
              ],
              ports: [
                { protocol: 'UDP', port: 53 },
                { protocol: 'TCP', port: 53 },
              ],
            },
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': cfg.namespace },
                  },
                },
              ],
              ports: [
                { protocol: 'TCP', port: 4222 },
                { protocol: 'TCP', port: 5000 },
              ],
            },
            {
              to: [
                {
                  ipBlock: {
                    cidr: '0.0.0.0/0',
                    except: [
                      '10.0.0.0/8',
                      '172.16.0.0/12',
                      '192.168.0.0/16',
                      '169.254.0.0/16',
                      '127.0.0.0/8',
                    ],
                  },
                },
              ],
              ports: [{ protocol: 'TCP', port: 443 }],
            },
          ],
        },
      }),
    );
  // Backend pods (stock Redis/NATS and future di-bs-* from #450) accept ingress only from
  // the tenant hostgroup. Developers retain pods/portforward on runtime Roles — that is a
  // deliberate within-tenant caveat, not network-policy isolation from the tenant developer.
  result.push(
    make('networking.k8s.io/v1', 'NetworkPolicy', 'di-bs-backend-network', n.runtimeNamespace, {
      spec: {
        podSelector: {
          matchLabels: { [`${GROUP}/component`]: 'backing-service' },
        },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': n.runtimeNamespace },
                },
                podSelector: { matchLabels: { 'wasmcloud.com/name': 'hostgroup' } },
              },
            ],
          },
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
                },
                podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
              },
            ],
            ports: [
              { protocol: 'UDP', port: 53 },
              { protocol: 'TCP', port: 53 },
            ],
          },
        ],
      },
    }),
  );
  for (const [name, image, port, args] of [
    // Runtime-internal data-plane NATS for hostgroup `--data-nats-url`.
    // Lifecycle is Tenant-owned; never created as an application BackingService.
    // Application messaging NATS instances are `di-bs-<name>` via reconcileBackingService.
    ['di-nats', 'nats:2.12.8-alpine', 4222, ['-js', '-sd', '/data']],
    // Transitional warehouse Redis + di-tenant-stock (#456 migrates to BackingService).
    // Independent Redis instances are provisioned separately as `di-bs-<name>`.
    [
      'di-redis',
      'redis:7.4.5-alpine',
      6379,
      ['redis-server', '--appendonly', 'yes', '--dir', '/data'],
    ],
  ] as const) {
    result.push(
      make('apps/v1', 'Deployment', name, n.runtimeNamespace, {
        spec: {
          replicas: suspended ? 0 : 1,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: { app: name } },
          template: {
            metadata: {
              labels: { app: name, [`${GROUP}/component`]: 'backing-service' },
            },
            spec: {
              automountServiceAccountToken: false,
              containers: [
                {
                  name,
                  image,
                  args,
                  ports: [{ containerPort: port }],
                  resources: {
                    requests: { cpu: '10m', memory: '32Mi' },
                    limits: { cpu: '250m', memory: '128Mi' },
                  },
                  readinessProbe: { tcpSocket: { port } },
                  volumeMounts: [{ name: 'data', mountPath: '/data' }],
                },
              ],
              volumes: [
                {
                  name: 'data',
                  hostPath: {
                    path: `${cfg.storageRoot ?? '/var/lib/k0s'}/di-tenants/${tenant.metadata.uid}/${name}`,
                    type: 'DirectoryOrCreate',
                  },
                },
              ],
            },
          },
        },
      }),
    );
    result.push(
      make('v1', 'Service', name, n.runtimeNamespace, {
        spec: { selector: { app: name }, ports: [{ port, targetPort: port }] },
      }),
    );
  }
  if (schedulerSecret) {
    result.push(
      make('v1', 'Secret', 'di-scheduler-tls', n.runtimeNamespace, {
        type: 'Opaque',
        data: schedulerSecret.data,
      }),
    );
    result.push(
      make('apps/v1', 'Deployment', `hostgroup-${n.hostgroup}`, n.runtimeNamespace, {
        spec: {
          replicas,
          selector: {
            matchLabels: {
              'wasmcloud.com/hostgroup': n.hostgroup,
              'wasmcloud.com/name': 'hostgroup',
            },
          },
          template: {
            metadata: {
              labels: { 'wasmcloud.com/hostgroup': n.hostgroup, 'wasmcloud.com/name': 'hostgroup' },
            },
            spec: {
              serviceAccountName: 'di-runtime',
              automountServiceAccountToken: false,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 65532,
                runAsGroup: 65532,
                fsGroup: 65532,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [
                {
                  name: 'host',
                  image: cfg.hostImage,
                  imagePullPolicy: cfg.hostImagePullPolicy ?? 'IfNotPresent',
                  args: [
                    'host',
                    '--host-name=$(WASMCLOUD_HOST_IP)',
                    `--host-group=${n.hostgroup}`,
                    `--environment=${n.namespace}`,
                    `--scheduler-nats-url=${cfg.schedulerNatsUrl}`,
                    '--scheduler-nats-tls-ca=/scheduler/ca.crt',
                    '--scheduler-nats-tls-cert=/scheduler/tls.crt',
                    '--scheduler-nats-tls-key=/scheduler/tls.key',
                    `--data-nats-url=nats://di-nats.${n.runtimeNamespace}.svc.cluster.local:4222`,
                    '--oci-cache-dir=/oci-cache',
                    '--http-addr=0.0.0.0:9191',
                    '--socket-egress=enforce',
                    ...(cfg.insecureRegistry ? ['--allow-insecure-registries'] : []),
                  ],
                  env: [
                    { name: 'HOME', value: '/tmp' },
                    {
                      name: 'WASMCLOUD_HOST_IP',
                      valueFrom: { fieldRef: { fieldPath: 'status.podIP' } },
                    },
                    { name: 'WASH_HOST_MAX_GUEST_MEMORY', value: '2Gi' },
                    { name: 'WASH_DEFAULT_HEAP_MEMORY', value: '512MiB' },
                    { name: 'WASH_CORE_INSTANCES', value: '100' },
                  ],
                  ports: [{ name: 'http', containerPort: 9191 }],
                  readinessProbe: { tcpSocket: { port: 'http' }, initialDelaySeconds: 5 },
                  resources: {
                    requests: { cpu: '250m', memory: '256Mi' },
                    limits: { cpu: '1', memory: '2Gi' },
                  },
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                  },
                  volumeMounts: [
                    { name: 'scheduler', mountPath: '/scheduler', readOnly: true },
                    { name: 'tmp', mountPath: '/tmp' },
                    { name: 'cache', mountPath: '/oci-cache' },
                  ],
                },
              ],
              volumes: [
                { name: 'scheduler', secret: { secretName: 'di-scheduler-tls' } },
                { name: 'tmp', emptyDir: {} },
                { name: 'cache', emptyDir: {} },
              ],
            },
          },
        },
      }),
    );
    result.push(
      make('v1', 'Service', 'di-http', n.runtimeNamespace, {
        spec: {
          selector: { 'wasmcloud.com/hostgroup': n.hostgroup },
          ports: [{ name: 'http', port: 80, targetPort: 9191 }],
        },
      }),
    );
  }
  return result;
}
function userResources(user: User, tenants: Tenant[], cfg: ControllerConfig): Resource[] {
  if (user.spec.suspended || user.metadata.deletionTimestamp) return [];
  const make = (
    apiVersion: string,
    kind: string,
    name: string,
    namespace: string,
    body: Record<string, unknown>,
  ) => resource(user, cfg.installation, apiVersion, kind, name, namespace, body);
  const account = `di-user-${user.metadata.name}`;
  const result = [
    make('v1', 'ServiceAccount', account, cfg.namespace, { automountServiceAccountToken: false }),
  ];
  for (const membership of user.spec.memberships) {
    const tenant = tenants.find((t) => t.metadata.name === membership.tenant);
    if (
      !tenant ||
      tenant.spec.suspended ||
      tenant.metadata.deletionTimestamp ||
      !tenant.status?.conditions?.some(
        (c) =>
          c.type === 'Ready' &&
          c.status === 'True' &&
          c.observedGeneration === tenant.metadata.generation,
      )
    )
      continue;
    const n = names(membership.tenant);
    for (const [namespace, role] of [
      [n.namespace, `di-${membership.role}`],
      [n.runtimeNamespace, `di-runtime-${membership.role}`],
    ] as const) {
      const binding = make('rbac.authorization.k8s.io/v1', 'RoleBinding', account, namespace, {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: role },
        subjects: [{ kind: 'ServiceAccount', name: account, namespace: cfg.namespace }],
      });
      binding.metadata.labels![TENANT] = membership.tenant;
      result.push(binding);
    }
  }
  return result;
}

export type {
  BackingCapability,
  BackingProvider,
  BackingService,
  BackingServiceClass,
  BackingServiceClassSpec,
  BackingServiceClassStatus,
  BackingServiceSpec,
  BackingServiceStatus,
  ClassVisibility,
  DeletionPolicy,
  EndpointSummary,
  ServiceBinding,
  ServiceBindingSpec,
  ServiceBindingStatus,
  SizingParameters,
} from './backing-services';
export {
  assertUniqueDefaults,
  BINDING,
  backingServiceCrds,
  bindingMatchesService,
  CAPABILITIES,
  CLASS,
  COMPATIBLE,
  CREDENTIAL_STATUS_KEYS,
  classVisibleToTenant,
  compatibleProvider,
  DEFAULT_CLASS_NAMES,
  defaultClassName,
  defaultClassSeed,
  PROVIDERS,
  resolveClassName,
  SERVICE,
  statusContainsCredentials,
  validateBindingSpec,
  validateClassSpec,
  validateServiceSpec,
} from './backing-services';
export {
  crds,
  FINALIZER,
  GROUP,
  INSTALLATION,
  names,
  OWNER,
  resource,
  TENANT,
  tenantResources,
  USER,
  userResources,
  VERSION,
  validName,
};
