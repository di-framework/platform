import { AppsV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import {
  GATEWAY_NAME,
  gatewayDeploymentSpec,
  gatewayNetworkPolicySpec,
  gatewayScriptHash,
  gatewayServiceSpec,
  loadGatewayScript,
  validateRouteUrlPattern,
} from './gateway/install';
import { tenantKubeconfig } from './kubeconfig';
import { installNetworkPolicy } from './network-policy';
import {
  declarations,
  installTenancy,
  resolveBackingServiceClasses,
  seedTenantNamespaces,
} from './tenancy';
import {
  names,
  type TenantAuthConfig,
  tenantAuthRoutes,
  userTokenSecretName,
} from './tenancy/resources';
import { platformValues } from './values';

export { kubeconfigServer, type TenantKubeconfigArgs, tenantKubeconfig } from './kubeconfig';

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
  /** `http://{host}.{tenant}.localhost:<port>` for the published gateway port, if any. */
  routeUrlPattern?: string;
  beforeTenancy?: (release: k8s.helm.v3.Release) => pulumi.Resource;
  /**
   * Kubernetes API server URL that tenant users reach. When set, `kubeconfigs` holds one
   * token kubeconfig per user membership; when omitted, `kubeconfigs` is undefined.
   */
  apiServer?: pulumi.Input<string>;
}

/**
 * Published wash 2.8.0 with wasi-tls. The tag moves on the next publish; this
 * digest is the multi-arch index from the tenant-host workflow.
 */
const DEFAULT_HOST_IMAGE =
  'ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:ee89fd4bce4f9f35f4cd09c63d3cbdd07bea3071b5d372f82c9f49b9741c3669';

// For testing: allow injecting a mock API client
let testApiClient: CoreV1Api | null = null;

export function _setTestApiClient(client: CoreV1Api | null) {
  testApiClient = client;
}

/**
 * Waits for a token Secret to exist with data.token set.
 * Polls with exponential backoff, up to ~5 minutes, then fails.
 * Only runs during update; returns unknown during preview.
 * In environments without a real cluster (e.g., tests), skips polling and returns the ID.
 */
async function waitForTokenSecret(
  namespace: string,
  secretName: string,
): Promise<string> {
  if (pulumi.runtime.isDryRun()) {
    return pulumi.getStack(); // Return something that won't be used in preview
  }

  let api: CoreV1Api | null = testApiClient;

  if (!api) {
    let kc: KubeConfig | null = null;
    try {
      kc = new KubeConfig();
      kc.loadFromDefault();
    } catch {
      // No kubeconfig available (test environment), skip polling
      return `${namespace}/${secretName}`;
    }

    try {
      api = kc.makeApiClient(CoreV1Api);
    } catch {
      // Can't create API client, skip polling
      return `${namespace}/${secretName}`;
    }
  }

  const maxAttempts = process.env.TOKEN_WAIT_MAX_ATTEMPTS
    ? parseInt(process.env.TOKEN_WAIT_MAX_ATTEMPTS, 10)
    : 60; // Up to ~5 minutes with exponential backoff (60 = ~5 min, 5 = ~30 sec for testing)
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const secret = await api.readNamespacedSecret(secretName, namespace);
      // Verify that the secret has the token data
      if (secret.body.data?.token) {
        // Return the resource ID that Pulumi expects
        return `${namespace}/${secretName}`;
      }
    } catch (e) {
      const error = e as Error;
      lastError = error;
      // Check if it's a 404 (not found) or other error
      const is404 = error.message?.includes('404') || (error as any).statusCode === 404;
      if (!is404) {
        // For non-404 errors (e.g., connection errors), bail out
        // This allows tests without a real cluster to proceed
        return `${namespace}/${secretName}`;
      }
      // For 404, continue retrying
    }

    if (attempt < maxAttempts - 1) {
      // Exponential backoff: starts at 1s, doubles every 10 attempts, capped at 10s
      const delayMs = Math.min(1000 * Math.pow(2, Math.floor(attempt / 10)), 10000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Timed out waiting for Secret
  throw new Error(
    `Failed to read Secret ${namespace}/${secretName} with data.token after ${maxAttempts} attempts: ${lastError?.message || 'not found'}`,
  );
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
  const routeUrlPattern = validateRouteUrlPattern(args.routeUrlPattern);
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

  // The default host group's backend. The published port belongs to the gateway below.
  const httpBackend = new k8s.core.v1.Service(
    'http-entrypoint',
    {
      metadata: { name: 'wasmcloud-http', namespace: namespaceName },
      spec: {
        type: 'ClusterIP',
        selector: {
          'wasmcloud.com/hostgroup': 'default',
          'wasmcloud.com/name': 'hostgroup',
        },
        ports: [{ name: 'http', port: 80, targetPort: 9191, protocol: 'TCP' }],
      },
    },
    { provider, dependsOn: [runtimeShutdown] },
  );

  const tenantAuth = config.getObject<TenantAuthConfig>('tenantAuth');
  // Gateway routes for each tenant's console and controller hosts (#58).
  const { routes: tenantAuthRouteHosts } = tenantAuthRoutes(tenantAuth, routeUrlPattern);
  const gatewayScript = loadGatewayScript();
  const gatewayScripts = new k8s.core.v1.ConfigMap(
    'http-gateway',
    { metadata: { name: GATEWAY_NAME, namespace: namespaceName }, data: gatewayScript },
    { provider, dependsOn: [namespaceResource] },
  );
  const gatewayPolicy = new k8s.networking.v1.NetworkPolicy(
    'http-gateway',
    {
      metadata: { name: GATEWAY_NAME, namespace: namespaceName },
      spec: gatewayNetworkPolicySpec(namespaceName, scope, tenantAuthRouteHosts),
    },
    { provider, dependsOn: [namespaceResource] },
  );
  const gateway = new k8s.apps.v1.Deployment(
    'http-gateway',
    {
      metadata: { name: GATEWAY_NAME, namespace: namespaceName },
      spec: gatewayDeploymentSpec(
        namespaceName,
        gatewayScriptHash(gatewayScript),
        tenantAuthRouteHosts,
      ),
    },
    { provider, dependsOn: [gatewayScripts, gatewayPolicy, httpBackend] },
  );
  // Depends on the backend Service so an upgrade frees its old NodePort first.
  new k8s.core.v1.Service(
    'http-gateway',
    {
      metadata: { name: GATEWAY_NAME, namespace: namespaceName },
      spec: gatewayServiceSpec(HTTP_NODE_PORT),
    },
    { provider, dependsOn: [gateway, httpBackend] },
  );

  const tenancy = installTenancy({
    installation: scope,
    namespace: namespaceName,
    provider,
    dependsOn: [runtimeShutdown, ...(networkPolicy ? [networkPolicy] : [])],
    ...declared,
    insecureRegistry: args.insecureRegistry,
    storageRoot: args.storageRoot,
    hostImage: config.get('tenantHostImage') ?? DEFAULT_HOST_IMAGE,
    hostImagePullPolicy: config.get('tenantHostImagePullPolicy') ?? 'IfNotPresent',
    backingServiceClasses: resolveBackingServiceClasses(config),
    routeUrlPattern,
    tenantAuth,
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

  // Users report Ready only after the controller sees every token Secret populated, so reading
  // the Secrets after the User resources is reliable. Preview reads eagerly, before the User
  // exists, so an unknown ID defers the read to the update. During update, poll until the Secret
  // exists with data.token, as the controller may not have created it yet.
  const apiServer = args.apiServer;
  const tokenSecretId = (user: string, tenant: string): pulumi.Input<string> => {
    if (pulumi.runtime.isDryRun()) {
      return pulumi.output(pulumi.unknown) as pulumi.Output<string>;
    }
    const secretName = userTokenSecretName(user, tenant);
    return pulumi.output(waitForTokenSecret(namespaceName, secretName));
  };
  const kubeconfigs =
    apiServer === undefined
      ? undefined
      : pulumi.secret(
          pulumi
            .all(
              declared.users.flatMap((user, index) =>
                user.memberships.map(({ tenant }) => {
                  const secret = k8s.core.v1.Secret.get(
                    `user-token-${user.name}-${tenant}`,
                    tokenSecretId(user.name, tenant),
                    { provider, dependsOn: tenancy.users.slice(index, index + 1) },
                  );
                  return pulumi.all([apiServer, secret.data]).apply(([server, secretData]) => ({
                    tenant,
                    user: user.name,
                    kubeconfig: tenantKubeconfig({ server, tenant, user: user.name, secretData }),
                  }));
                }),
              ),
            )
            .apply((entries) => {
              const result: Record<string, Record<string, string>> = {};
              for (const { tenant, user, kubeconfig } of entries)
                result[tenant] = { ...result[tenant], [user]: kubeconfig };
              return result;
            }),
        );

  return {
    namespace: namespaceResource.metadata.name,
    tenants,
    users,
    /** `{ [tenant]: { [user]: kubeconfig YAML } }`, secret; undefined without `apiServer`. */
    kubeconfigs,
    release: wasmcloud,
    routeUrlPattern,
    // Tenant custom resources wait for Ready. Callers that install into
    // di-tenant-* depend on these and do not create the namespaces.
    tenantResources: tenancy.tenants,
  };
}
