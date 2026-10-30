/**
 * The per-tenant runtime-operator (design-541 §4.6): one unmodified upstream `runtime-operator`
 * per tenant, in its own `di-operator-<tenant>` namespace. It is configured only through the
 * upstream process flags and environment, exactly as runtime-operator chart 2.8.0 renders its own
 * operator with `watchNamespaces` set (`templates/operator/deployment.yaml`).
 *
 * #541 m3 renders these objects; the controller does not apply them yet (m6).
 */
import {
  INSTALLATION,
  labels,
  NAMESPACE_ROLE,
  names,
  type Resource,
  resource,
  type Tenant,
} from './resources';
import { PLATFORM_SECRETS } from './scheduler-pki';

/** The runtime-operator Helm chart version the platform installs, and the operator image tag. */
export const WASMCLOUD_OPERATOR_VERSION = '2.8.0';
export const RUNTIME_OPERATOR_REPOSITORY = 'ghcr.io/wasmcloud/runtime-operator';
/**
 * The image index digest of `ghcr.io/wasmcloud/runtime-operator:<version>`, read anonymously from
 * `https://ghcr.io/v2/wasmcloud/runtime-operator/manifests/2.8.0` (`docker-content-digest`,
 * `application/vnd.oci.image.index.v1+json`). Bumping {@link WASMCLOUD_OPERATOR_VERSION} without
 * pinning its digest here fails {@link runtimeOperatorImage} and its test.
 */
export const RUNTIME_OPERATOR_DIGESTS: Readonly<Record<string, string>> = {
  '2.8.0': 'sha256:74ff7183198616f487619fd9e6edb5229c95e7ac2f2d8abdb167e34dd205422c',
};
/** `<repository>:<version>@<digest>` for a pinned operator version. */
export function runtimeOperatorImage(version: string = WASMCLOUD_OPERATOR_VERSION): string {
  const digest = RUNTIME_OPERATOR_DIGESTS[version];
  if (!digest) throw new Error(`runtime-operator ${version} has no pinned image digest`);
  return `${RUNTIME_OPERATOR_REPOSITORY}:${version}@${digest}`;
}

/** The three fixed ClusterRoles every tenant operator is bound to, one per kind of namespace. */
export const TENANT_OPERATOR_CLUSTER_ROLES = {
  /** Bound in `di-operator-<t>`. */
  self: 'di-tenant-operator-self',
  /** Bound in `di-tenant-<t>`. */
  workloads: 'di-tenant-operator-workloads',
  /** Bound in `di-runtime-<t>`. */
  hosts: 'di-tenant-operator-hosts',
} as const;
export type TenantOperatorScope = keyof typeof TENANT_OPERATOR_CLUSTER_ROLES;

export const TENANT_OPERATOR_NAME = 'runtime-operator';
/** The pod label the chart's operator carries, which the platform NATS ingress rule selects. */
export const TENANT_OPERATOR_POD_LABELS = { 'wasmcloud.com/name': TENANT_OPERATOR_NAME };
export const TENANT_OPERATOR_HEALTH_PORT = 8082;
const CERT_DIR = '/operator-cert';

export const operatorNamespace = (tenant: string): string => `di-operator-${tenant}`;

type Rule = { apiGroups: string[]; resources: string[]; verbs: string[] };
const WASMCLOUD = 'runtime.wasmcloud.dev';
const WORKLOAD_KINDS = ['artifacts', 'workloads', 'workloadreplicasets', 'workloaddeployments'];
const edit = ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'];
const read = ['get', 'list', 'watch'];
/**
 * The operator records events through controller-runtime's events/v1 recorder, which the chart
 * does not grant (design-541 §4.6).
 */
const eventsV1: Rule = {
  apiGroups: ['events.k8s.io'],
  resources: ['events'],
  verbs: ['create', 'patch'],
};

/**
 * The rules of each fixed ClusterRole, copied from the chart 2.8.0 operator Roles:
 * - `self`: `templates/operator/role.yaml`;
 * - `workloads`: `workload-crd-role.yaml`, `workload-namespace-role.yaml`, `endpointslice-role.yaml`;
 * - `hosts`: `host-pod-role.yaml`.
 */
export function tenantOperatorClusterRoleRules(): Record<TenantOperatorScope, Rule[]> {
  return {
    self: [
      { apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: edit },
      { apiGroups: [''], resources: ['events'], verbs: ['create', 'patch'] },
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'patch', 'watch'] },
      { apiGroups: [WASMCLOUD], resources: ['hosts', 'hosts/finalizers'], verbs: edit },
      { apiGroups: [WASMCLOUD], resources: ['hosts/status'], verbs: ['get', 'update', 'patch'] },
      eventsV1,
    ],
    workloads: [
      { apiGroups: [WASMCLOUD], resources: WORKLOAD_KINDS, verbs: edit },
      {
        apiGroups: [WASMCLOUD],
        resources: WORKLOAD_KINDS.map((k) => `${k}/status`),
        verbs: ['get', 'update', 'patch'],
      },
      {
        apiGroups: [WASMCLOUD],
        resources: WORKLOAD_KINDS.map((k) => `${k}/finalizers`),
        verbs: ['update'],
      },
      { apiGroups: [''], resources: ['configmaps', 'secrets'], verbs: read },
      {
        apiGroups: [''],
        resources: ['events'],
        verbs: ['create', 'get', 'list', 'patch', 'update', 'watch'],
      },
      { apiGroups: [''], resources: ['services'], verbs: read },
      { apiGroups: [''], resources: ['services/finalizers'], verbs: ['update'] },
      { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: edit },
      {
        apiGroups: ['discovery.k8s.io'],
        resources: ['endpointslices/restricted'],
        verbs: ['create'],
      },
      { apiGroups: [''], resources: ['endpoints/restricted'], verbs: ['create'] },
      eventsV1,
    ],
    hosts: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'patch', 'watch'] }],
  };
}

/** The three ClusterRoles, which Pulumi installs once. They are bound only per tenant. */
export function tenantOperatorClusterRoles(installation: string): Resource[] {
  const rules = tenantOperatorClusterRoleRules();
  return (Object.keys(TENANT_OPERATOR_CLUSTER_ROLES) as TenantOperatorScope[]).map((scope) => ({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: {
      name: TENANT_OPERATOR_CLUSTER_ROLES[scope],
      labels: { [INSTALLATION]: installation },
    },
    rules: rules[scope],
  }));
}

/** What {@link tenantOperatorResources} needs beyond the tenant. */
export interface TenantOperatorConfig {
  installation: string;
  /** The platform namespace, which runs the scheduler NATS `nats`. */
  namespace: string;
  /** API server endpoint addresses and port (the `kubernetes` EndpointSlice). */
  apiServer: { addresses: string[]; port: number };
}

/**
 * The tenant's operator: its namespace, ServiceAccount, Deployment, the RoleBindings to the three
 * fixed ClusterRoles in the tenant's three namespaces, and the namespace's network policies.
 */
export function tenantOperatorResources(tenant: Tenant, cfg: TenantOperatorConfig): Resource[] {
  const t = tenant.metadata.name;
  const n = names(t);
  const ns = operatorNamespace(t);
  const make = (
    apiVersion: string,
    kind: string,
    name: string,
    namespace: string | undefined,
    body: Record<string, unknown>,
  ) => resource(tenant, cfg.installation, apiVersion, kind, name, namespace, body);

  const namespace = make('v1', 'Namespace', ns, undefined, {});
  namespace.metadata.labels![NAMESPACE_ROLE] = 'operator';

  const bindingNamespaces: Record<TenantOperatorScope, string> = {
    self: ns,
    workloads: n.namespace,
    hosts: n.runtimeNamespace,
  };
  const bindings = (Object.keys(TENANT_OPERATOR_CLUSTER_ROLES) as TenantOperatorScope[]).map(
    (scope) =>
      make(
        'rbac.authorization.k8s.io/v1',
        'RoleBinding',
        TENANT_OPERATOR_CLUSTER_ROLES[scope],
        bindingNamespaces[scope],
        {
          roleRef: {
            apiGroup: 'rbac.authorization.k8s.io',
            kind: 'ClusterRole',
            name: TENANT_OPERATOR_CLUSTER_ROLES[scope],
          },
          subjects: [{ kind: 'ServiceAccount', name: TENANT_OPERATOR_NAME, namespace: ns }],
        },
      ),
  );

  const podLabels = { ...labels(tenant, cfg.installation), ...TENANT_OPERATOR_POD_LABELS };
  const deployment = make('apps/v1', 'Deployment', TENANT_OPERATOR_NAME, ns, {
    spec: {
      replicas: 1,
      selector: { matchLabels: TENANT_OPERATOR_POD_LABELS },
      template: {
        metadata: { labels: podLabels },
        spec: {
          // The operator calls the API; the token mount also gives leader election its namespace.
          automountServiceAccountToken: true,
          serviceAccountName: TENANT_OPERATOR_NAME,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            fsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          volumes: [{ name: 'operator-cert', secret: { secretName: PLATFORM_SECRETS.operator } }],
          containers: [
            {
              name: TENANT_OPERATOR_NAME,
              image: runtimeOperatorImage(),
              imagePullPolicy: 'IfNotPresent',
              args: [
                `-nats-url=nats://nats.${cfg.namespace}.svc.cluster.local:4222`,
                `-nats-ca=${CERT_DIR}/ca.crt`,
                `-nats-client-cert=${CERT_DIR}/tls.crt`,
                `-nats-client-key=${CERT_DIR}/tls.key`,
                `-watch-namespaces=${n.namespace}`,
                `-host-namespaces=${n.runtimeNamespace}`,
                '-allow-shared-hosts=false',
                '-leader-elect',
                // Disables metrics (`runtime-operator/cmd/main.go:86-87`): no metrics ClusterRole.
                '-metrics-bind-address=0',
              ],
              env: [{ name: 'OPERATOR_NAMESPACE', value: ns }],
              volumeMounts: [{ name: 'operator-cert', mountPath: CERT_DIR, readOnly: true }],
              resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { memory: '192Mi' } },
              ports: [
                { name: 'health', containerPort: TENANT_OPERATOR_HEALTH_PORT, protocol: 'TCP' },
              ],
              livenessProbe: {
                httpGet: { path: '/healthz', port: 'health' },
                initialDelaySeconds: 15,
                periodSeconds: 20,
                failureThreshold: 3,
              },
              readinessProbe: {
                httpGet: { path: '/readyz', port: 'health' },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                capabilities: { drop: ['ALL'] },
              },
            },
          ],
          dnsPolicy: 'ClusterFirst',
          restartPolicy: 'Always',
          terminationGracePeriodSeconds: 0,
        },
      },
    },
  });

  const egress: unknown[] = [];
  if (cfg.apiServer.addresses.length)
    egress.push({
      to: cfg.apiServer.addresses.map((ip) => ({
        ipBlock: { cidr: `${ip}/${ip.includes(':') ? 128 : 32}` },
      })),
      ports: [{ protocol: 'TCP', port: cfg.apiServer.port }],
    });
  egress.push(
    {
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: {
            matchExpressions: [{ key: 'k8s-app', operator: 'In', values: ['kube-dns', 'coredns'] }],
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
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': cfg.namespace } },
          podSelector: { matchLabels: { 'wasmcloud.com/name': 'nats' } },
        },
      ],
      ports: [{ protocol: 'TCP', port: 4222 }],
    },
  );
  const policies = [
    make('networking.k8s.io/v1', 'NetworkPolicy', 'di-operator-egress', ns, {
      spec: { podSelector: {}, policyTypes: ['Egress'], egress },
    }),
    // No ingress rule: no pod may connect. The kubelet's probes come from the node, not a pod
    // (design-541 §4.6).
    make('networking.k8s.io/v1', 'NetworkPolicy', 'di-operator-ingress', ns, {
      spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [] },
    }),
  ];

  return [
    namespace,
    make('v1', 'ServiceAccount', TENANT_OPERATOR_NAME, ns, {}),
    ...bindings,
    deployment,
    ...policies,
  ];
}

/** The namespace prefix each tenant-operator ClusterRole may be bound in: `<prefix><tenant>`. */
export const TENANT_OPERATOR_BINDING_PREFIXES: Readonly<Record<TenantOperatorScope, string>> = {
  self: 'di-operator-',
  workloads: 'di-tenant-',
  hosts: 'di-runtime-',
};
export const TENANT_OPERATOR_BINDING_MESSAGE =
  'The tenant-operator ClusterRoles may only be bound by a RoleBinding in the tenant namespace of ' +
  'their kind, to the ServiceAccount runtime-operator in di-operator-<tenant> of the same tenant';
export const TENANT_OPERATOR_CLUSTER_ROLE_MESSAGE =
  'The platform controller may not create, change or delete the tenant-operator ClusterRoles';

const RBAC_GROUP = 'rbac.authorization.k8s.io';
const ROLE_NAMES = `[${Object.values(TENANT_OPERATOR_CLUSTER_ROLES)
  .map((name) => `'${name}'`)
  .join(', ')}]`;
const OPERATOR_ROLE_REF = `object.roleRef.apiGroup == '${RBAC_GROUP}' &&
  object.roleRef.kind == 'ClusterRole' && object.roleRef.name in ${ROLE_NAMES}`;

interface BindingPolicy {
  name: string;
  operations: string[];
  matchConditions?: { name: string; expression: string }[];
  variables?: { name: string; expression: string }[];
  expression: string;
  message: string;
}

/**
 * Admission for the controller's `bind` on the three tenant-operator ClusterRoles (#541 m3 W1).
 * RBAC cannot limit `bind` to a namespace, a subject or RoleBindings, so these policies, one per
 * resource kind so that each type-checks against its own schema, refuse, for every user:
 * - every ClusterRoleBinding to the three;
 * - a RoleBinding to one of them outside `<prefix><t>` for its kind
 *   ({@link TENANT_OPERATOR_BINDING_PREFIXES}), or to any subject but exactly
 *   `di-operator-<t>/runtime-operator` of the same tenant;
 * - and, for the platform controller, any create, change or delete of the three ClusterRoles, so
 *   it can neither relabel them into an aggregated role nor replace their rules.
 */
export function tenantOperatorBindingPolicies(installation: string, namespace: string): Resource[] {
  const prefixes = (Object.keys(TENANT_OPERATOR_CLUSTER_ROLES) as TenantOperatorScope[])
    .map(
      (scope) =>
        `'${TENANT_OPERATOR_CLUSTER_ROLES[scope]}': '${TENANT_OPERATOR_BINDING_PREFIXES[scope]}'`,
    )
    .join(', ');
  const policies: BindingPolicy[] = [
    {
      name: 'clusterrolebindings',
      operations: ['CREATE', 'UPDATE'],
      expression: `!(${OPERATOR_ROLE_REF})`,
      message: TENANT_OPERATOR_BINDING_MESSAGE,
    },
    {
      name: 'rolebindings',
      operations: ['CREATE', 'UPDATE'],
      matchConditions: [{ name: 'tenant-operator-role', expression: OPERATOR_ROLE_REF }],
      variables: [
        { name: 'prefix', expression: `{${prefixes}}[object.roleRef.name]` },
        {
          name: 'tenant',
          expression: `request.namespace.startsWith(variables.prefix) ?
            request.namespace.substring(size(variables.prefix)) : ''`,
        },
      ],
      expression: `variables.tenant != '' &&
        has(object.subjects) && size(object.subjects) == 1 &&
        object.subjects.all(s, s.kind == 'ServiceAccount' &&
          s.name == '${TENANT_OPERATOR_NAME}' && has(s.namespace) &&
          s.namespace == '${operatorNamespace('')}' + variables.tenant)`,
      message: TENANT_OPERATOR_BINDING_MESSAGE,
    },
    {
      name: 'clusterroles',
      operations: ['CREATE', 'UPDATE', 'DELETE'],
      matchConditions: [
        { name: 'tenant-operator-role', expression: `request.name in ${ROLE_NAMES}` },
      ],
      expression: `request.userInfo.username != 'system:serviceaccount:${namespace}:di-platform-controller'`,
      message: TENANT_OPERATOR_CLUSTER_ROLE_MESSAGE,
    },
  ];
  const labels = { [INSTALLATION]: installation };
  return policies.flatMap((policy) => {
    const name = `${installation}-tenant-operator-${policy.name}`;
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
                apiGroups: [RBAC_GROUP],
                apiVersions: ['v1'],
                operations: policy.operations,
                resources: [policy.name],
              },
            ],
          },
          ...(policy.matchConditions ? { matchConditions: policy.matchConditions } : {}),
          ...(policy.variables ? { variables: policy.variables } : {}),
          validations: [{ expression: policy.expression, message: policy.message }],
        },
      },
      {
        apiVersion: 'admissionregistration.k8s.io/v1',
        kind: 'ValidatingAdmissionPolicyBinding',
        metadata: { name, labels },
        spec: { policyName: name, validationActions: ['Deny'] },
      },
    ];
  });
}
