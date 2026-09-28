import * as k8s from '@pulumi/kubernetes';

/** Policy-only mode preserves the caller's CNI and service proxy.
 * https://www.kube-router.io/docs/user-guide/
 */
export function installNetworkPolicy(provider: k8s.Provider) {
  const name = 'di-platform-network-policy';
  const namespace = 'kube-system';
  const account = new k8s.core.v1.ServiceAccount(
    name,
    { metadata: { name, namespace } },
    { provider },
  );
  const role = new k8s.rbac.v1.ClusterRole(
    name,
    {
      metadata: { name },
      rules: [
        {
          apiGroups: [''],
          resources: ['namespaces', 'pods', 'services', 'nodes', 'endpoints'],
          verbs: ['get', 'list', 'watch'],
        },
        {
          apiGroups: ['networking.k8s.io'],
          resources: ['networkpolicies'],
          verbs: ['get', 'list', 'watch'],
        },
        {
          apiGroups: ['discovery.k8s.io'],
          resources: ['endpointslices'],
          verbs: ['get', 'list', 'watch'],
        },
      ],
    },
    { provider },
  );
  const binding = new k8s.rbac.v1.ClusterRoleBinding(
    name,
    {
      metadata: { name },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name },
      subjects: [{ kind: 'ServiceAccount', name, namespace }],
    },
    { provider, dependsOn: [account, role] },
  );
  return new k8s.apps.v1.DaemonSet(
    name,
    {
      metadata: { name, namespace },
      spec: {
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            serviceAccountName: name,
            hostNetwork: true,
            priorityClassName: 'system-node-critical',
            tolerations: [{ operator: 'Exists' }],
            containers: [
              {
                name: 'policy',
                image: 'docker.io/cloudnativelabs/kube-router:v2.10.0',
                args: ['--run-router=false', '--run-service-proxy=false', '--run-firewall=true'],
                env: [
                  { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
                ],
                securityContext: { privileged: true },
                readinessProbe: {
                  httpGet: { path: '/healthz', port: 20244 },
                  initialDelaySeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: '/healthz', port: 20244 },
                  initialDelaySeconds: 30,
                },
                resources: {
                  requests: { cpu: '50m', memory: '64Mi' },
                  limits: { memory: '256Mi' },
                },
                volumeMounts: [
                  { name: 'modules', mountPath: '/lib/modules', readOnly: true },
                  { name: 'lock', mountPath: '/run/xtables.lock' },
                ],
              },
            ],
            volumes: [
              { name: 'modules', hostPath: { path: '/lib/modules', type: 'DirectoryOrCreate' } },
              { name: 'lock', hostPath: { path: '/run/xtables.lock', type: 'FileOrCreate' } },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [binding] },
  );
}
