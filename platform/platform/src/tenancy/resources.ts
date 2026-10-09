import { createHash } from 'node:crypto';
import { backingServiceCrds } from './backing-services';
import { PRIVATE_IPV4_RANGES } from './egress';
import { hostStorage } from './workload-storage';
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
  /** `http://{host}.{tenant}.localhost:<port>` when the platform gateway is published. */
  routeUrlPattern?: string;
  /** The per-tenant controller and console (#58); absent, the reconcile deploys neither. */
  tenantAuth?: TenantAuthConfig;
}
/**
 * Platform-level settings for each tenant's controller and console. The runtime env contract is
 * the one frozen in `platform/tenant-auth/README.md`.
 */
export interface TenantAuthConfig {
  /** `ghcr.io/di-framework/tenant-auth@sha256:<digest>`; always pinned by digest. */
  image: string;
  /** identity-server issuer URL, as both pods and browsers name it. */
  issuer: string;
  /**
   * Until per-tenant clients (#59), every console shares one confidential OAuth client. Its
   * secret lives in a Secret in the platform namespace that the reconcile copies into each
   * tenant's runtime namespace; the controller never reads the identity directory.
   */
  oauthClient: { id: string; secretName: string; secretKey?: string };
  /**
   * For a loopback issuer (`localhost`, `*.localhost`, `127.0.0.1`): the in-cluster
   * `<service>.<namespace>[.svc...]:<port>` a sidecar forwards the issuer port to.
   */
  issuerUpstream?: string;
  /** The pod port behind `issuerUpstream` (NetworkPolicy matches it after DNAT). */
  issuerUpstreamPodPort?: number;
  /** The issuer's IPv4 when pods cannot resolve its hostname. */
  issuerIp?: string;
  /** Browser-visible console URL; `{tenant}` is replaced. Default `http://127.0.0.1:8787`. */
  consolePublicUrl?: string;
  /** Controller URL shown to users and CLIs; `{tenant}` is replaced. Default `https://127.0.0.1:8788`. */
  controllerPublicUrl?: string;
}
/** Facts the controller gathers from the cluster for {@link tenantAuthResources}. */
export interface TenantAuthInputs {
  /** Names of the tenant's active members; each may mint tokens for `di-user-<name>`. */
  members: string[];
  /** API server endpoint addresses and port (the `kubernetes` EndpointSlice). */
  apiServer: { addresses: string[]; port: number };
  /** The controller's serving certificate and key (PEM). */
  tls: { cert: string; key: string };
  /** The shared OAuth client secret, base64 as read from the platform Secret; absent until it exists. */
  clientSecret?: string;
}
const TENANT_AUTH_IMAGE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
/** Reject a tenant-auth config that would deploy an unpinned image or miss required fields. */
export function assertTenantAuthConfig(value: TenantAuthConfig | undefined): void {
  if (value === undefined) return;
  if (!TENANT_AUTH_IMAGE.test(value.image ?? ''))
    throw new Error('tenantAuth.image must be pinned by digest (<repository>@sha256:<digest>)');
  if (!URL.canParse(value.issuer ?? '')) throw new Error('tenantAuth.issuer must be a URL');
  if (!value.oauthClient?.id || !value.oauthClient.secretName)
    throw new Error('tenantAuth.oauthClient needs id and secretName');
}
/** Container limits of one tenant-auth pair, counted on top of the tenant's own quota. */
export const TENANT_AUTH_LIMITS = { cpu: '500m', memory: '448Mi' };
/** Each suffix in thousandths of the base unit, so sums stay integers. */
const units: Record<string, number> = {
  m: 1,
  '': 1000,
  Ki: 1024 * 1000,
  Mi: 1024 ** 2 * 1000,
  Gi: 1024 ** 3 * 1000,
  Ti: 1024 ** 4 * 1000,
};
/** `a + b` for quantities in the CRD's pattern; CPU comes back in millicores, memory in Mi. */
export function addQuantity(a: string, b: string, unit: 'm' | 'Mi'): string {
  const value = (q: string) => {
    const [, n, suffix] = /^([0-9.]+)(m|Ki|Mi|Gi|Ti)?$/.exec(q)!;
    return Math.round(Number(n) * (units[suffix ?? ''] as number));
  };
  return `${Math.ceil((value(a) + value(b)) / (units[unit] as number))}${unit}`;
}
/** Platform HTTP gateway (di-framework/kube#2); its pods alone reach tenant hosts on 9191. */
const GATEWAY_NAME = 'di-platform-gateway';
const GATEWAY_POD_LABELS = { app: GATEWAY_NAME };
/** Per-tenant ConfigMap with the gateway URL template; absent means no gateway is known. */
const ROUTES_CONFIG_NAME = 'di-platform-routes';
const GROUP = 'platform.di-framework.dev';
const VERSION = `${GROUP}/v1alpha1`;
const INSTALLATION = `${GROUP}/installation`;
const OWNER = `${GROUP}/owner-uid`;
const TENANT = `${GROUP}/tenant`;
const USER = `${GROUP}/user`;
const FINALIZER = `${GROUP}/cleanup`;
const COMPONENT = `${GROUP}/component`;
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
  storageKeys: string[] = [],
): Resource[] {
  const n = names(tenant.metadata.name);
  const storage = hostStorage(tenant, cfg, storageKeys);
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
          // The tenant's controller and console run here too; their limits are added on top
          // so the tenant keeps its whole budget for the host and backing services (#58).
          'limits.cpu': cfg.tenantAuth
            ? addQuantity(resources.cpu ?? '2', TENANT_AUTH_LIMITS.cpu, 'm')
            : (resources.cpu ?? '2'),
          'limits.memory': cfg.tenantAuth
            ? addQuantity(resources.memory ?? '4Gi', TENANT_AUTH_LIMITS.memory, 'Mi')
            : (resources.memory ?? '4Gi'),
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
    // The controller reads hostgroup logs to publish the console logs projection (#10).
    // Scoped to this tenant's runtime namespace; the host itself keeps no API token.
    make('rbac.authorization.k8s.io/v1', 'Role', 'di-platform-log-reader', n.runtimeNamespace, {
      rules: [{ apiGroups: [''], resources: ['pods/log'], verbs: ['get'] }],
    }),
    make(
      'rbac.authorization.k8s.io/v1',
      'RoleBinding',
      'di-platform-log-reader',
      n.runtimeNamespace,
      {
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'di-platform-log-reader',
        },
        subjects: [
          { kind: 'ServiceAccount', name: 'di-platform-controller', namespace: cfg.namespace },
        ],
      },
    ),
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
                values: ['backing-service', 'backup-agent', 'backup-operator'],
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
                  ipBlock: { cidr: '0.0.0.0/0', except: [...PRIVATE_IPV4_RANGES] },
                },
              ],
              ports: [{ protocol: 'TCP', port: 443 }],
            },
          ],
        },
      }),
    );
  // di-tenant-network admits only same-tenant traffic; the platform gateway is the one
  // outside client allowed to reach the tenant hosts' HTTP port.
  result.push(
    make('networking.k8s.io/v1', 'NetworkPolicy', 'di-tenant-gateway', n.runtimeNamespace, {
      spec: {
        podSelector: {
          matchLabels: {
            'wasmcloud.com/hostgroup': n.hostgroup,
            'wasmcloud.com/name': 'hostgroup',
          },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': cfg.namespace },
                },
                podSelector: { matchLabels: GATEWAY_POD_LABELS },
              },
            ],
            ports: [{ protocol: 'TCP', port: 9191 }],
          },
        ],
      },
    }),
  );
  if (cfg.routeUrlPattern)
    result.push(
      make('v1', 'ConfigMap', ROUTES_CONFIG_NAME, n.namespace, {
        data: { urlTemplate: cfg.routeUrlPattern.replaceAll('{tenant}', tenant.metadata.name) },
      }),
    );
  // Backend pods accept ingress from the tenant hostgroup and from backup-agent Jobs in
  // the same runtime namespace. Developers retain pods/portforward on runtime Roles.
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
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': n.runtimeNamespace },
                },
                podSelector: { matchLabels: { [`${GROUP}/component`]: 'backup-agent' } },
              },
            ],
            ports: [
              { protocol: 'TCP', port: 5432 },
              { protocol: 'TCP', port: 6379 },
              { protocol: 'TCP', port: 4222 },
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
          // The old host leaves before its replacement starts, never a surge pod. A storage
          // host owns node-local workload directories a second host must not share, and the
          // runtime quota (limits.cpu) leaves no room for a surge host, so a template change
          // would otherwise stall with the old host running. This stays RollingUpdate:
          // switching type to Recreate under server-side apply is rejected while the
          // defaulted rollingUpdate block remains.
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: { maxSurge: 0, maxUnavailable: 1 },
          },
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
              // Persistent workload directories (#11) are created by DirectoryOrCreate as root;
              // this step hands each one to the host uid before the host starts.
              ...(storage.initContainers.length ? { initContainers: storage.initContainers } : {}),
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
                    ...storage.volumeMounts,
                  ],
                },
              ],
              volumes: [
                { name: 'scheduler', secret: { secretName: 'di-scheduler-tls' } },
                { name: 'tmp', emptyDir: {} },
                { name: 'cache', emptyDir: {} },
                ...storage.volumes,
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
    // A long-lived token for the user's tenant kubeconfig. Kubernetes fills `token` and
    // `ca.crt`, and deletes the Secret itself if the ServiceAccount goes away.
    const token = make(
      'v1',
      'Secret',
      userTokenSecretName(user.metadata.name, membership.tenant),
      cfg.namespace,
      { type: 'kubernetes.io/service-account-token' },
    );
    token.metadata = {
      ...token.metadata,
      labels: { ...token.metadata.labels, [TENANT]: membership.tenant },
      annotations: { 'kubernetes.io/service-account.name': account },
    };
    result.push(token);
  }
  return result;
}
/** ServiceAccount token Secret backing a user's kubeconfig for one tenant membership. */
function userTokenSecretName(user: string, tenant: string): string {
  return `di-user-${user}-${tenant}-token`;
}
/** Bun sends these names to loopback whatever DNS says, so pods reach them through a sidecar. */
function loopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
}
/** The controller URL users and CLIs see; `{tenant}` is replaced. */
function tenantControllerPublicUrl(tenant: string, auth: TenantAuthConfig | undefined): string {
  return (auth?.controllerPublicUrl ?? 'https://127.0.0.1:8788').replaceAll('{tenant}', tenant);
}
/**
 * Names the controller's serving certificate covers: in-cluster, through a port-forward and the
 * host of `controllerPublicUrl`, so CLIs verify the hostname they were given.
 */
function tenantControllerCertNames(
  tenant: string,
  auth?: TenantAuthConfig,
): { dns: string[]; ips: string[] } {
  const ns = names(tenant).runtimeNamespace;
  const dns = [
    'tenant-controller',
    `tenant-controller.${ns}.svc`,
    `tenant-controller.${ns}.svc.cluster.local`,
    'localhost',
  ];
  const ips = ['127.0.0.1'];
  const host = URL.canParse(tenantControllerPublicUrl(tenant, auth))
    ? new URL(tenantControllerPublicUrl(tenant, auth)).hostname
    : '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) ips.push(host);
  else if (host && !host.startsWith('[')) dns.push(host);
  return { dns: [...new Set(dns)], ips: [...new Set(ips)] };
}
/** Digest of the serving certificate; in both pod templates so a renewal rolls the pair. */
function tlsCertDigest(cert: string): string {
  return createHash('sha256').update(cert).digest('hex');
}
/** The issuer-proxy sidecar, pinned by digest (`alpine/socat:1.8.0.0`). */
export const ISSUER_PROXY_IMAGE =
  'alpine/socat@sha256:a6be4c0262b339c53ddad723cdd178a1a13271e1137c65e27f90a08c16de02b8';
/** The ServiceAccount token, CA and namespace, projected into the controller container only. */
const serviceAccountVolume = () => ({
  name: 'service-account',
  projected: {
    sources: [
      { serviceAccountToken: { path: 'token', expirationSeconds: 3607 } },
      { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
      {
        downwardAPI: {
          items: [{ path: 'namespace', fieldRef: { fieldPath: 'metadata.namespace' } }],
        },
      },
    ],
  },
});
/**
 * The tenant's controller and console (#58), ported from `tenant-auth/scripts/deploy-local.ts`.
 * They run in the tenant's runtime namespace, next to the `di-http` Service the controller
 * proxies to; the runtime quota grows by {@link TENANT_AUTH_LIMITS} to hold them.
 */
function tenantAuthResources(
  tenant: Tenant,
  cfg: ControllerConfig,
  inputs: TenantAuthInputs,
): Resource[] {
  const auth = cfg.tenantAuth;
  if (!auth) return [];
  const name = tenant.metadata.name;
  const n = names(name);
  const namespace = n.runtimeNamespace;
  const suspended = tenant.spec.suspended || !!tenant.metadata.deletionTimestamp;
  const make = (
    apiVersion: string,
    kind: string,
    resourceName: string,
    ns: string | undefined,
    body: Record<string, unknown>,
  ) => {
    const value = resource(tenant, cfg.installation, apiVersion, kind, resourceName, ns, body);
    value.metadata.labels![COMPONENT] = 'tenant-auth';
    return value;
  };
  const rbac = 'rbac.authorization.k8s.io/v1';
  const subjects = [{ kind: 'ServiceAccount', name: 'tenant-controller', namespace }];
  const issuer = new URL(auth.issuer);
  const issuerPort = Number(issuer.port || (issuer.protocol === 'https:' ? 443 : 80));
  const issuerIp =
    auth.issuerIp ?? (/^\d+\.\d+\.\d+\.\d+$/.test(issuer.hostname) ? issuer.hostname : undefined);
  const loopback = loopbackHost(issuer.hostname);
  const sidecarTarget = auth.issuerUpstream ?? (auth.issuerIp && `${auth.issuerIp}:${issuerPort}`);
  const securityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  };
  const deployment = (
    app: 'tenant-controller' | 'tenant-console',
    port: number,
    env: Record<string, string>,
    extraEnv: unknown[],
    volume: Record<string, unknown>,
    mountPath: string,
  ) =>
    make('apps/v1', 'Deployment', app, namespace, {
      spec: {
        // One replica: the controller keeps proxy sessions in memory. Recreate, because a
        // surge pod would not fit the runtime quota.
        replicas: suspended ? 0 : 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app } },
        template: {
          metadata: {
            labels: { app, [COMPONENT]: 'tenant-auth', [TENANT]: name },
            // The image reference rolls the pods; the digest is repeated here for operators. Both
            // binaries read the certificate (or CA) once at start, so its digest rolls the pair.
            annotations: {
              [`${GROUP}/image-digest`]: auth.image.split('@')[1],
              [`${GROUP}/tls-cert-sha256`]: tlsCertDigest(inputs.tls.cert),
            },
          },
          spec: {
            serviceAccountName: app,
            // Never automounted: the controller's token is projected into its own container
            // only, so the issuer-proxy sidecar holds no credential.
            automountServiceAccountToken: false,
            ...(!loopback && auth.issuerIp
              ? { hostAliases: [{ ip: auth.issuerIp, hostnames: [issuer.hostname] }] }
              : {}),
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: app,
                image: auth.image,
                command: [
                  'bun',
                  `/app/${app === 'tenant-controller' ? 'controller' : 'console'}.js`,
                ],
                env: [
                  { name: 'TMPDIR', value: '/tmp' },
                  ...Object.entries(env).map(([k, v]) => ({ name: k, value: v })),
                  ...extraEnv,
                ],
                ports: [{ containerPort: port, name: 'http' }],
                readinessProbe: {
                  httpGet:
                    app === 'tenant-controller'
                      ? { path: '/-/healthz', port, scheme: 'HTTPS' }
                      : { path: '/healthz', port, scheme: 'HTTP' },
                  periodSeconds: 5,
                },
                resources: {
                  requests: { cpu: '50m', memory: '96Mi' },
                  limits: { cpu: '200m', memory: '192Mi' },
                },
                securityContext,
                volumeMounts: [
                  { name: 'tmp', mountPath: '/tmp' },
                  { name: 'mounted', mountPath, readOnly: true },
                  ...(app === 'tenant-controller'
                    ? [
                        {
                          name: 'service-account',
                          mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
                          readOnly: true,
                        },
                      ]
                    : []),
                ],
              },
              ...(loopback && sidecarTarget
                ? [
                    {
                      name: 'issuer-proxy',
                      image: ISSUER_PROXY_IMAGE,
                      args: [
                        `TCP-LISTEN:${issuerPort},fork,reuseaddr,bind=127.0.0.1`,
                        `TCP:${sidecarTarget}`,
                      ],
                      resources: {
                        requests: { cpu: '10m', memory: '16Mi' },
                        limits: { cpu: '50m', memory: '32Mi' },
                      },
                      securityContext,
                    },
                  ]
                : []),
            ],
            volumes: [
              { name: 'tmp', emptyDir: {} },
              { name: 'mounted', ...volume },
              ...(app === 'tenant-controller' ? [serviceAccountVolume()] : []),
            ],
          },
        },
      },
    });
  const service = (app: string, port: number) =>
    make('v1', 'Service', app, namespace, {
      spec: { selector: { app }, ports: [{ port, targetPort: port, name: 'http' }] },
    });
  const publicUrl = (pattern: string | undefined, fallback: string) =>
    (pattern ?? fallback).replaceAll('{tenant}', name);
  const [upstreamHost = '', upstreamPort = '80'] = (auth.issuerUpstream ?? '').split(':');
  const egress: unknown[] = [];
  if (inputs.apiServer.addresses.length)
    egress.push({
      to: inputs.apiServer.addresses.map((ip) => ({
        ipBlock: { cidr: `${ip}/${ip.includes(':') ? 128 : 32}` },
      })),
      ports: [{ protocol: 'TCP', port: inputs.apiServer.port }],
    });
  if (auth.issuerUpstream)
    egress.push({
      to: [
        {
          namespaceSelector: {
            matchLabels: {
              'kubernetes.io/metadata.name': upstreamHost.split('.')[1] ?? cfg.namespace,
            },
          },
        },
      ],
      ports: [
        ...new Set([Number(upstreamPort), auth.issuerUpstreamPodPort ?? Number(upstreamPort)]),
      ].map((port) => ({ protocol: 'TCP', port })),
    });
  else if (issuerIp)
    egress.push({
      to: [{ ipBlock: { cidr: `${issuerIp}/32` } }],
      ports: [{ protocol: 'TCP', port: issuerPort }],
    });
  egress.push(
    // The service proxy (#56) reaches the tenant hosts through `di-http`; NetworkPolicy sees
    // the pod port after the Service's DNAT, 9191.
    {
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
          podSelector: {
            matchLabels: {
              'wasmcloud.com/hostgroup': n.hostgroup,
              'wasmcloud.com/name': 'hostgroup',
            },
          },
        },
      ],
      ports: [{ protocol: 'TCP', port: 9191 }],
    },
    {
      to: [
        { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } },
      ],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
  );
  const base64 = (text: string) => Buffer.from(text).toString('base64');
  const result: Resource[] = [
    make('v1', 'ServiceAccount', 'tenant-controller', namespace, {
      automountServiceAccountToken: false,
    }),
    make('v1', 'ServiceAccount', 'tenant-console', namespace, {
      automountServiceAccountToken: false,
    }),
    // The tenancy CRs it checks on every request.
    make(rbac, 'ClusterRole', `di-tenant-controller-${name}`, undefined, {
      rules: [
        { apiGroups: [GROUP], resources: ['tenants'], verbs: ['get'], resourceNames: [name] },
        { apiGroups: [GROUP], resources: ['users'], verbs: ['get', 'list'] },
      ],
    }),
    // TokenRequest only for the tenant's members, recomputed from the User CRs on every
    // reconcile. With no members there is no rule: empty resourceNames would mean every name.
    make(rbac, 'Role', `di-tenant-controller-${name}`, cfg.namespace, {
      rules: inputs.members.length
        ? [
            {
              apiGroups: [''],
              resources: ['serviceaccounts/token'],
              verbs: ['create'],
              resourceNames: inputs.members.map((m) => `di-user-${m}`),
            },
          ]
        : [],
    }),
    // API-key Secrets in its own namespace.
    make(rbac, 'Role', 'tenant-controller-keys', namespace, {
      rules: [
        { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list', 'create', 'delete'] },
      ],
    }),
    // Tenant developers can only write Secrets (#112), so `/v1` reads them as the controller;
    // writes still go through as the calling user.
    make(rbac, 'Role', 'tenant-controller-secrets', n.namespace, {
      rules: [{ apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list'] }],
    }),
  ];
  // A suspended tenant keeps the roles but loses the bindings (revoked with the members').
  if (!suspended)
    result.push(
      make(rbac, 'ClusterRoleBinding', `di-tenant-controller-${name}`, undefined, {
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: `di-tenant-controller-${name}`,
        },
        subjects,
      }),
      make(rbac, 'RoleBinding', `di-tenant-controller-${name}`, cfg.namespace, {
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: `di-tenant-controller-${name}`,
        },
        subjects,
      }),
      make(rbac, 'RoleBinding', 'tenant-controller-keys', namespace, {
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'tenant-controller-keys',
        },
        subjects,
      }),
      make(rbac, 'RoleBinding', 'tenant-controller-secrets', n.namespace, {
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'tenant-controller-secrets',
        },
        subjects,
      }),
    );
  result.push(
    make('networking.k8s.io/v1', 'NetworkPolicy', 'tenant-auth-egress', namespace, {
      spec: {
        podSelector: { matchLabels: { [COMPONENT]: 'tenant-auth' } },
        policyTypes: ['Egress'],
        egress,
      },
    }),
    make('v1', 'ConfigMap', 'tenant-controller-ca', namespace, {
      data: { 'ca.crt': inputs.tls.cert },
    }),
    make('v1', 'Secret', 'tenant-controller-tls', namespace, {
      type: 'kubernetes.io/tls',
      data: { 'tls.crt': base64(inputs.tls.cert), 'tls.key': base64(inputs.tls.key) },
    }),
  );
  if (inputs.clientSecret)
    result.push(
      make('v1', 'Secret', 'tenant-console-oauth', namespace, {
        type: 'Opaque',
        data: { clientSecret: inputs.clientSecret },
      }),
    );
  result.push(
    deployment(
      'tenant-controller',
      8788,
      {
        TENANT_CONTROLLER_TENANT: name,
        TENANT_CONTROLLER_PLATFORM_NAMESPACE: cfg.namespace,
        TENANT_CONTROLLER_ISSUER: auth.issuer,
        TENANT_CONTROLLER_HOST: '0.0.0.0',
        TENANT_CONTROLLER_PORT: '8788',
        TENANT_CONTROLLER_TLS_CERT: '/tls/tls.crt',
        TENANT_CONTROLLER_TLS_KEY: '/tls/tls.key',
      },
      [],
      { secret: { secretName: 'tenant-controller-tls' } },
      '/tls',
    ),
    deployment(
      'tenant-console',
      8787,
      {
        TENANT_CONSOLE_TENANT: name,
        TENANT_CONSOLE_ISSUER: auth.issuer,
        TENANT_CONSOLE_CLIENT_ID: auth.oauthClient.id,
        TENANT_CONSOLE_HOST: '0.0.0.0',
        TENANT_CONSOLE_PORT: '8787',
        TENANT_CONSOLE_PUBLIC_URL: publicUrl(auth.consolePublicUrl, 'http://127.0.0.1:8787'),
        TENANT_CONSOLE_CONTROLLER_URL: 'https://tenant-controller:8788',
        TENANT_CONSOLE_CONTROLLER_PUBLIC_URL: tenantControllerPublicUrl(name, auth),
        TENANT_CONSOLE_CONTROLLER_CA: '/ca/ca.crt',
      },
      [
        {
          name: 'TENANT_CONSOLE_CLIENT_SECRET',
          valueFrom: { secretKeyRef: { name: 'tenant-console-oauth', key: 'clientSecret' } },
        },
      ],
      { configMap: { name: 'tenant-controller-ca' } },
      '/ca',
    ),
    service('tenant-controller', 8788),
    service('tenant-console', 8787),
  );
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
  COMPONENT,
  crds,
  FINALIZER,
  GATEWAY_NAME,
  GATEWAY_POD_LABELS,
  GROUP,
  INSTALLATION,
  names,
  OWNER,
  ROUTES_CONFIG_NAME,
  resource,
  TENANT,
  tenantAuthResources,
  tenantControllerCertNames,
  tenantResources,
  tlsCertDigest,
  USER,
  userResources,
  userTokenSecretName,
  VERSION,
  validName,
};
