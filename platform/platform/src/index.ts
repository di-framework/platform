import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { installNetworkPolicy } from './network-policy';
import {
  declarations,
  installTenancy,
  resolveBackingServiceClasses,
  seedTenantNamespaces,
} from './tenancy';
import { names } from './tenancy/resources';
import { platformValues } from './values';

export interface PlatformArgs {
  provider: k8s.Provider;
  networkPolicyEngine?: 'existing' | 'kube-router';
  installation: string;
  config?: pulumi.Config;
  namespace?: string;
  release?: string;
  chart?: string;
  chartVersion?: string;
  timeoutSeconds?: number;
  httpNodePort?: number;
  registry?: boolean;
  registryNodePort?: number;
  storageRoot?: string;
  insecureRegistry?: boolean;
  values?: Record<string, unknown>;
  beforeTenancy?: (release: k8s.helm.v3.Release) => pulumi.Resource;
}

/** Shared platform resources; the caller owns cluster creation and Pulumi state. */
export function createPlatform(args: PlatformArgs) {
  const provider = args.provider;
  const scope = args.installation;
  const config = args.config ?? new pulumi.Config();
  const declared = declarations(config);
  const networkPolicy =
    args.networkPolicyEngine === 'kube-router' ? installNetworkPolicy(provider) : undefined;
  const namespaceName = args.namespace ?? 'wasmcloud';
  const REGISTRY_IMAGE = 'docker.io/library/registry:3.1.1';
  const WASMCLOUD_OPERATOR_VERSION = '2.8.0';
  const REGISTRY_NODE_PORT = args.registryNodePort ?? 30500;
  const HTTP_NODE_PORT = args.httpNodePort ?? 30180;
  const namespaceResource = new k8s.core.v1.Namespace(
    'wasmcloud',
    {
      metadata: {
        name: namespaceName,
        // Every namespaced resource has already been deleted when the isolated
        // cluster is torn down; do not block k0s cleanup on namespace GC.
        annotations: { 'pulumi.com/skipAwait': 'true' },
      },
    },
    { provider },
  );

  const registryService = args.registry
    ? (() => {
        const registryLabels = { 'app.kubernetes.io/name': 'di-framework-registry' };
        const registryDeployment = new k8s.apps.v1.Deployment(
          'oci-registry',
          {
            metadata: { name: 'di-framework-registry', namespace: namespaceName },
            spec: {
              replicas: 1,
              selector: { matchLabels: registryLabels },
              template: {
                metadata: { labels: registryLabels },
                spec: {
                  containers: [
                    {
                      name: 'registry',
                      image: REGISTRY_IMAGE,
                      ports: [{ name: 'registry', containerPort: 5000 }],
                      readinessProbe: { httpGet: { path: '/v2/', port: 'registry' } },
                      volumeMounts: [{ name: 'data', mountPath: '/var/lib/registry' }],
                    },
                  ],
                  volumes: [
                    {
                      name: 'data',
                      hostPath: {
                        path: `${args.storageRoot ?? '/var/lib/k0s'}/di-framework/${scope}/registry`,
                        type: 'DirectoryOrCreate',
                      },
                    },
                  ],
                },
              },
            },
          },
          { provider, dependsOn: [namespaceResource] },
        );

        return new k8s.core.v1.Service(
          'oci-registry',
          {
            metadata: { name: 'di-framework-registry', namespace: namespaceName },
            spec: {
              type: 'NodePort',
              selector: registryLabels,
              ports: [
                {
                  name: 'registry',
                  port: 5000,
                  targetPort: 'registry',
                  nodePort: REGISTRY_NODE_PORT,
                },
              ],
            },
          },
          { provider, dependsOn: [registryDeployment] },
        );
      })()
    : undefined;

  const tenantNamespaces = seedTenantNamespaces(declared.tenants, scope, provider);

  const wasmcloud = new k8s.helm.v3.Release(
    'wasmcloud',
    {
      name: args.release ?? 'wasmcloud',
      namespace: namespaceName,
      createNamespace: false,
      chart: args.chart ?? 'oci://ghcr.io/wasmcloud/charts/runtime-operator',
      version: args.chartVersion ?? WASMCLOUD_OPERATOR_VERSION,
      atomic: true,
      cleanupOnFail: true,
      timeout: args.timeoutSeconds ?? 600,
      values: platformValues(args.values ?? {}, {
        gateway: { enabled: false },
        operator: {
          allowSharedHosts: false,
          hostNamespaces: [
            namespaceName,
            ...declared.tenants.map((t) => names(t.name).runtimeNamespace),
          ],
        },
        runtime: {
          extraArgs: args.insecureRegistry ? ['--allow-insecure-registries'] : [],
          resources: {
            requests: { cpu: '250m', memory: '256Mi' },
            limits: { memory: '2Gi' },
            defaultHeapMemory: '512MiB',
            coreInstances: '100',
          },
          hostGroups: [
            {
              name: 'default',
              replicas: 1,
              service: { type: 'ClusterIP' },
              webgpu: { enabled: false },
              http: { enabled: true, port: 9191 },
            },
          ],
        },
      }),
    },
    {
      provider,
      dependsOn: [
        namespaceResource,
        ...(registryService ? [registryService] : []),
        ...tenantNamespaces,
      ],
    },
  );

  const runtimeShutdown = args.beforeTenancy?.(wasmcloud) ?? wasmcloud;

  new k8s.core.v1.Service(
    'http-entrypoint',
    {
      metadata: { name: 'wasmcloud-http', namespace: namespaceName },
      spec: {
        type: HTTP_NODE_PORT ? 'NodePort' : 'ClusterIP',
        selector: {
          'wasmcloud.com/hostgroup': 'default',
          'wasmcloud.com/name': 'hostgroup',
        },
        ports: [
          {
            name: 'http',
            port: 80,
            targetPort: 9191,
            ...(HTTP_NODE_PORT ? { nodePort: HTTP_NODE_PORT } : {}),
            protocol: 'TCP',
          },
        ],
      },
    },
    { provider, dependsOn: [runtimeShutdown] },
  );

  const tenancy = installTenancy({
    installation: scope,
    namespace: namespaceName,
    provider,
    dependsOn: [runtimeShutdown, ...(networkPolicy ? [networkPolicy] : [])],
    ...declared,
    insecureRegistry: args.insecureRegistry,
    storageRoot: args.storageRoot,
    hostImage: config.get('tenantHostImage') ?? 'ghcr.io/wasmcloud/wash:2.8.0',
    hostImagePullPolicy: config.get('tenantHostImagePullPolicy') ?? 'IfNotPresent',
    backingServiceClasses: resolveBackingServiceClasses(config),
  });
  const tenants = tenancy.tenants.map((t) =>
    t.metadata.name.apply((name) => ({ name, ...names(name) })),
  );
  const users = tenancy.users.map((u) =>
    u.metadata.name.apply((name) => ({
      name,
      serviceAccount: `di-user-${name}`,
      namespace: namespaceName,
    })),
  );

  return { namespace: namespaceResource.metadata.name, tenants, users, release: wasmcloud };
}
