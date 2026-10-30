import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { controllerClusterRoleRules } from '../src/tenancy/install';
import {
  INSTALLATION,
  NAMESPACE_ROLE,
  OWNER,
  type Resource,
  TENANT,
  type Tenant,
  VERSION,
} from '../src/tenancy/resources';
import { PLATFORM_SECRETS } from '../src/tenancy/scheduler-pki';
import {
  operatorNamespace,
  RUNTIME_OPERATOR_DIGESTS,
  RUNTIME_OPERATOR_REPOSITORY,
  runtimeOperatorImage,
  TENANT_OPERATOR_CLUSTER_ROLES,
  tenantOperatorClusterRoleRules,
  tenantOperatorClusterRoles,
  tenantOperatorResources,
  WASMCLOUD_OPERATOR_VERSION,
} from '../src/tenancy/tenant-operator';

// #541 m3: the per-tenant runtime-operator manifests (design-541 §4.6, §8.1).

const tenant: Tenant = {
  apiVersion: VERSION,
  kind: 'Tenant',
  metadata: { name: 'alpha', uid: 'alpha-uid', generation: 1 },
  spec: {},
};
const cfg = {
  installation: 'test',
  namespace: 'wasmcloud',
  apiServer: { addresses: ['10.0.0.1', 'fd00::1'], port: 6443 },
};
const objects = tenantOperatorResources(tenant, cfg);
const find = (kind: string, name: string, namespace?: string) => {
  const found = objects.filter(
    (o) => o.kind === kind && o.metadata.name === name && o.metadata.namespace === namespace,
  );
  expect(found).toHaveLength(1);
  return found[0] as Resource;
};
type Container = {
  image: string;
  imagePullPolicy: string;
  args: string[];
  env: { name: string; value: string }[];
  volumeMounts: unknown[];
  resources: unknown;
};
type PodSpec = {
  automountServiceAccountToken: boolean;
  serviceAccountName: string;
  volumes: unknown[];
  containers: Container[];
};
const deployment = find('Deployment', 'runtime-operator', 'di-operator-alpha');
const spec = deployment.spec as {
  replicas: number;
  selector: { matchLabels: Record<string, string> };
  template: { metadata: { labels: Record<string, string> }; spec: PodSpec };
};
const pod = spec.template.spec;
const container = pod.containers[0] as Container;

describe('runtime-operator version and image pin', () => {
  it('pins exactly the chart version, by digest', () => {
    expect(Object.keys(RUNTIME_OPERATOR_DIGESTS)).toEqual([WASMCLOUD_OPERATOR_VERSION]);
    const digest = RUNTIME_OPERATOR_DIGESTS[WASMCLOUD_OPERATOR_VERSION];
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(runtimeOperatorImage()).toBe(
      `${RUNTIME_OPERATOR_REPOSITORY}:${WASMCLOUD_OPERATOR_VERSION}@${digest}`,
    );
    expect(container.image).toBe(runtimeOperatorImage());
  });

  it('refuses a version whose digest is not pinned', () => {
    expect(() => runtimeOperatorImage('2.9.0')).toThrow(
      'runtime-operator 2.9.0 has no pinned image digest',
    );
  });

  it('installs the chart at the same constant', () => {
    const index = readFileSync(path.join(import.meta.dir, '../src/index.ts'), 'utf8');
    expect(index).toContain(
      "import { WASMCLOUD_OPERATOR_VERSION } from './tenancy/tenant-operator'",
    );
    expect(index).toContain('version: args.chartVersion ?? WASMCLOUD_OPERATOR_VERSION');
    expect(index).not.toMatch(/const WASMCLOUD_OPERATOR_VERSION/);
  });
});

describe('tenant operator manifests', () => {
  it('renders its own namespace with the installation, tenant and operator role labels', () => {
    expect(operatorNamespace('alpha')).toBe('di-operator-alpha');
    expect(find('Namespace', 'di-operator-alpha').metadata.labels).toEqual({
      [INSTALLATION]: 'test',
      [OWNER]: 'alpha-uid',
      [TENANT]: 'alpha',
      [NAMESPACE_ROLE]: 'operator',
    });
  });

  it('renders exactly these objects', () => {
    expect(
      objects.map((o) => `${o.kind} ${o.metadata.namespace ?? ''}/${o.metadata.name}`),
    ).toEqual([
      'Namespace /di-operator-alpha',
      'ServiceAccount di-operator-alpha/runtime-operator',
      'RoleBinding di-operator-alpha/di-tenant-operator-self',
      'RoleBinding di-tenant-alpha/di-tenant-operator-workloads',
      'RoleBinding di-runtime-alpha/di-tenant-operator-hosts',
      'Deployment di-operator-alpha/runtime-operator',
      'NetworkPolicy di-operator-alpha/di-operator-egress',
      'NetworkPolicy di-operator-alpha/di-operator-ingress',
    ]);
    for (const o of objects)
      expect(o.metadata.labels).toMatchObject({
        [INSTALLATION]: 'test',
        [OWNER]: 'alpha-uid',
        [TENANT]: 'alpha',
      });
  });

  it('runs the upstream operator with the fixed per-tenant flags and OPERATOR_NAMESPACE', () => {
    expect(spec.replicas).toBe(1);
    expect(spec.selector.matchLabels).toEqual({ 'wasmcloud.com/name': 'runtime-operator' });
    expect(spec.template.metadata.labels).toMatchObject({
      'wasmcloud.com/name': 'runtime-operator',
      [TENANT]: 'alpha',
    });
    expect(container.args).toEqual([
      '-nats-url=nats://nats.wasmcloud.svc.cluster.local:4222',
      '-nats-ca=/operator-cert/ca.crt',
      '-nats-client-cert=/operator-cert/tls.crt',
      '-nats-client-key=/operator-cert/tls.key',
      '-watch-namespaces=di-tenant-alpha',
      '-host-namespaces=di-runtime-alpha',
      '-allow-shared-hosts=false',
      '-leader-elect',
      '-metrics-bind-address=0',
    ]);
    expect(container.env).toEqual([{ name: 'OPERATOR_NAMESPACE', value: 'di-operator-alpha' }]);
    expect(pod.automountServiceAccountToken).toBe(true);
    expect(pod.serviceAccountName).toBe('runtime-operator');
    expect(pod.volumes).toEqual([
      { name: 'operator-cert', secret: { secretName: PLATFORM_SECRETS.operator } },
    ]);
    expect(PLATFORM_SECRETS.operator).toBe('di-scheduler-operator-tls');
    expect(container.volumeMounts).toEqual([
      { name: 'operator-cert', mountPath: '/operator-cert', readOnly: true },
    ]);
    expect(container.resources).toEqual({
      requests: { cpu: '100m', memory: '64Mi' },
      limits: { memory: '192Mi' },
    });
  });

  it('gets its access only from RoleBindings to the three fixed ClusterRoles', () => {
    const bindings = objects.filter((o) => o.kind.includes('Binding'));
    expect(bindings.every((b) => b.kind === 'RoleBinding')).toBe(true);
    expect(objects.some((o) => o.kind === 'Role' || o.kind === 'ClusterRole')).toBe(false);
    const where = {
      self: 'di-operator-alpha',
      workloads: 'di-tenant-alpha',
      hosts: 'di-runtime-alpha',
    };
    for (const [scope, name] of Object.entries(TENANT_OPERATOR_CLUSTER_ROLES)) {
      const binding = find('RoleBinding', name, where[scope as keyof typeof where]);
      expect(binding.roleRef).toEqual({
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name,
      });
      expect(binding.subjects).toEqual([
        { kind: 'ServiceAccount', name: 'runtime-operator', namespace: 'di-operator-alpha' },
      ]);
    }
  });

  it('allows egress only to the API server, cluster DNS and nats 4222', () => {
    const policy = find('NetworkPolicy', 'di-operator-egress', 'di-operator-alpha');
    expect(policy.spec).toEqual({
      podSelector: {},
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ ipBlock: { cidr: '10.0.0.1/32' } }, { ipBlock: { cidr: 'fd00::1/128' } }],
          ports: [{ protocol: 'TCP', port: 6443 }],
        },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
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
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'wasmcloud' } },
              podSelector: { matchLabels: { 'wasmcloud.com/name': 'nats' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 4222 }],
        },
      ],
    });
  });

  it('omits the API server rule while its endpoints are unknown', () => {
    const rendered = tenantOperatorResources(tenant, {
      ...cfg,
      apiServer: { addresses: [], port: 6443 },
    });
    const policy = rendered.find((o) => o.metadata.name === 'di-operator-egress') as Resource;
    const egress = (policy.spec as { egress: { ports: { port: number }[] }[] }).egress;
    expect(egress.map((rule) => rule.ports.map((p) => p.port))).toEqual([[53, 53], [4222]]);
  });

  it('admits no ingress', () => {
    expect(find('NetworkPolicy', 'di-operator-ingress', 'di-operator-alpha').spec).toEqual({
      podSelector: {},
      policyTypes: ['Ingress'],
      ingress: [],
    });
  });
});

describe('tenant-operator ClusterRoles', () => {
  const RBAC = 'rbac.authorization.k8s.io';

  it('copies the chart 2.8.0 operator Roles, plus events/v1 create and patch', () => {
    const edit = ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'];
    const kinds = ['artifacts', 'workloads', 'workloadreplicasets', 'workloaddeployments'];
    const eventsV1 = {
      apiGroups: ['events.k8s.io'],
      resources: ['events'],
      verbs: ['create', 'patch'],
    };
    expect(tenantOperatorClusterRoleRules()).toEqual({
      // chart: templates/operator/role.yaml
      self: [
        { apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: edit },
        { apiGroups: [''], resources: ['events'], verbs: ['create', 'patch'] },
        { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'patch', 'watch'] },
        {
          apiGroups: ['runtime.wasmcloud.dev'],
          resources: ['hosts', 'hosts/finalizers'],
          verbs: edit,
        },
        {
          apiGroups: ['runtime.wasmcloud.dev'],
          resources: ['hosts/status'],
          verbs: ['get', 'update', 'patch'],
        },
        eventsV1,
      ],
      // chart: workload-crd-role.yaml, workload-namespace-role.yaml, endpointslice-role.yaml
      workloads: [
        { apiGroups: ['runtime.wasmcloud.dev'], resources: kinds, verbs: edit },
        {
          apiGroups: ['runtime.wasmcloud.dev'],
          resources: kinds.map((k) => `${k}/status`),
          verbs: ['get', 'update', 'patch'],
        },
        {
          apiGroups: ['runtime.wasmcloud.dev'],
          resources: kinds.map((k) => `${k}/finalizers`),
          verbs: ['update'],
        },
        { apiGroups: [''], resources: ['configmaps', 'secrets'], verbs: ['get', 'list', 'watch'] },
        {
          apiGroups: [''],
          resources: ['events'],
          verbs: ['create', 'get', 'list', 'patch', 'update', 'watch'],
        },
        { apiGroups: [''], resources: ['services'], verbs: ['get', 'list', 'watch'] },
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
      // chart: host-pod-role.yaml
      hosts: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'patch', 'watch'] }],
    });
  });

  it('grants nothing cluster-wide in kind: no wildcards, no RBAC, no Secret writes', () => {
    for (const rules of Object.values(tenantOperatorClusterRoleRules()))
      for (const rule of rules) {
        expect([...rule.apiGroups, ...rule.resources, ...rule.verbs]).not.toContain('*');
        expect(rule.apiGroups).not.toContain(RBAC);
        if (rule.resources.includes('secrets'))
          expect(rule.verbs).toEqual(['get', 'list', 'watch']);
      }
  });

  it('renders the three named ClusterRoles with the installation label', () => {
    expect(tenantOperatorClusterRoles('test')).toEqual(
      (['self', 'workloads', 'hosts'] as const).map((scope) => ({
        apiVersion: `${RBAC}/v1`,
        kind: 'ClusterRole',
        metadata: { name: `di-tenant-operator-${scope}`, labels: { [INSTALLATION]: 'test' } },
        rules: tenantOperatorClusterRoleRules()[scope],
      })),
    );
  });

  it('lets the controller bind exactly these three by name, with no escalate', () => {
    const rules = controllerClusterRoleRules();
    expect(rules.flatMap((r) => r.verbs)).not.toContain('escalate');
    expect(
      rules.filter((r) => r.resources.includes('clusterroles') && r.verbs.includes('bind')),
    ).toEqual([
      {
        apiGroups: [RBAC],
        resources: ['clusterroles'],
        verbs: ['bind'],
        resourceNames: [
          'di-tenant-operator-self',
          'di-tenant-operator-workloads',
          'di-tenant-operator-hosts',
        ],
      },
    ]);
  });
});
