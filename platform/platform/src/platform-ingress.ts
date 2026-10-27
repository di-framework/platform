import { INSTALLATION, TENANT } from './tenancy/resources';

type Peer = {
  namespaceSelector: {
    matchLabels: Record<string, string>;
    matchExpressions?: { key: string; operator: string }[];
  };
  podSelector?: {
    matchLabels?: Record<string, string>;
    matchExpressions?: { key: string; operator: string; values: string[] }[];
  };
};

/** Every pod in the platform namespace. */
export function platformNamespacePeer(namespace: string): Peer {
  return { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } } };
}

/** This installation's tenant namespaces (`di-tenant-*`, `di-runtime-*`), by the labels the
 * platform puts on them. Peers are always named by namespace labels, never by a bare rule or
 * `namespaceSelector: {}`: on a host shared by vCluster instances, vCluster's policy sync rewrites
 * a namespace selector into the instance's own `vcluster.loft.sh/ns-label-vcluster-x-<hash>` pod
 * labels (as the synced `di-tenant-network-x-…` policies show), so it only ever matches pods of
 * this instance, whereas a rule without `from` admits every instance's pods (#462). */
export function tenantNamespacesSelector(installation: string): Peer['namespaceSelector'] {
  return {
    matchLabels: { [INSTALLATION]: installation },
    matchExpressions: [{ key: TENANT, operator: 'Exists' }],
  };
}

/** The runtime-operator Service port the chart opens next to 8082 (`operator.service.port`). */
export const RUNTIME_OPERATOR_SERVICE_PORT = 8443;

/** Ingress policies for the wasmCloud chart's pods in the platform namespace. They replace the
 * chart's own (`networkPolicy.enabled: false` in the Helm values), which admit their ports from
 * any source (#462).
 * - `nats` 4222: the host group and runtime-operator pods of the platform namespace and this
 *   installation's tenant host groups, which schedule over it (`schedulerNatsUrl`).
 * - `hostgroup-default` 9191 (also `wasmcloud-http` 80, which targets it): the platform
 *   namespace, i.e. the gateway.
 * - `runtime-operator` 8082 and 8443: the platform namespace. Kubelet probes are not subject to
 *   NetworkPolicy. */
export function platformIngressPolicies(namespace: string, installation: string) {
  const platform = platformNamespacePeer(namespace);
  const tcp = (...ports: number[]) => ports.map((port) => ({ protocol: 'TCP', port }));
  const policy = (name: string, pods: Record<string, string>, from: Peer[], ports: number[]) => ({
    name: `di-platform-${name}`,
    spec: {
      podSelector: { matchLabels: pods },
      policyTypes: ['Ingress'],
      ingress: [{ from, ports: tcp(...ports) }],
    },
  });
  return [
    policy(
      'nats',
      { 'wasmcloud.com/name': 'nats' },
      [
        {
          ...platform,
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
          namespaceSelector: tenantNamespacesSelector(installation),
          podSelector: { matchLabels: { 'wasmcloud.com/name': 'hostgroup' } },
        },
      ],
      [4222],
    ),
    policy(
      'hostgroup-default',
      { 'wasmcloud.com/name': 'hostgroup', 'wasmcloud.com/hostgroup': 'default' },
      [platform],
      [9191],
    ),
    policy(
      'runtime-operator',
      { 'wasmcloud.com/name': 'runtime-operator' },
      [platform],
      [8082, RUNTIME_OPERATOR_SERVICE_PORT],
    ),
  ];
}

/** The platform renders an ingress policy for the `default` host group only; one a values
 * override adds gets none (#462). */
export function extraHostGroupsWarning(values: Record<string, unknown> | undefined) {
  const runtime = values?.runtime as { hostGroups?: unknown } | undefined;
  const groups = Array.isArray(runtime?.hostGroups) ? runtime.hostGroups : [];
  const extra = groups
    .map((g) => (g as { name?: unknown } | null)?.name)
    .filter((name) => name !== 'default');
  return extra.length
    ? `values.runtime.hostGroups adds host groups (${extra.join(', ')}) that get no ingress ` +
        'NetworkPolicy from the platform: the chart policies are off, so their pods admit any source'
    : undefined;
}
