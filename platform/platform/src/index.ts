import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import {
  GATEWAY_NAME,
  gatewayDeploymentSpec,
  gatewayNetworkPolicySpec,
  gatewayScriptHash,
  gatewayServiceSpec,
  loadGatewayScript,
  validateRouteAliases,
  validateRouteUrlPattern,
} from './gateway/install';
import {
  assertHostImageSupportsAllowlist,
  PLATFORM_REGISTRY_PORT,
  PLATFORM_REGISTRY_SERVICE,
  tenantInsecureRegistries,
} from './insecure-registries';
import { tenantKubeconfig } from './kubeconfig';
import { installNetworkPolicy } from './network-policy';
import { extraHostGroupsWarning, platformIngressPolicies } from './platform-ingress';
import { installSchedulerNats } from './scheduler-nats-install';
import { installSchedulerPki, loadSchedulerPkiScripts } from './scheduler-pki-bootstrap';
import {
  declarations,
  installTenancy,
  resolveBackingServiceClasses,
  seedTenantNamespaces,
} from './tenancy';
import { hostImageSupportsNatsCredentials } from './tenancy/registry-nats';
import { tenantListerFromKubeconfig, warnRemovedTenants } from './tenancy/removal';
import {
  assertRuntimeNatsConfig,
  assertTenantAuthConfig,
  names,
  type RuntimeNatsConfig,
  type TenantAuthConfig,
  tenantAuthRoutes,
  unsetPublicUrls,
  userTokenSecretName,
  withDerivedPublicUrls,
} from './tenancy/resources';
import { schedulerPkiNamespace } from './tenancy/scheduler-pki';
import { WASMCLOUD_OPERATOR_VERSION } from './tenancy/tenant-operator';
import { tenantAuthReadsApiKeyNamespace } from './tenant-auth-images';
import { secretReaderFromKubeconfig } from './token-secret-reader';
import { waitForTokenSecret } from './token-wait';
import { platformHelmValues } from './values';
import { sharedTenantList, type TenantSnapshot } from './watched-namespaces';

export { platformRegistryPullHost, tenantInsecureRegistries } from './insecure-registries';
export { kubeconfigServer, type TenantKubeconfigArgs, tenantKubeconfig } from './kubeconfig';

export interface PlatformArgs {
  provider: k8s.Provider;
  networkPolicyEngine?: 'existing' | 'kube-router';
  installation: string;
  config?: pulumi.Config;
  namespace?: string;
  release?: string;
  timeoutSeconds?: number;
  httpNodePort?: number;
  registry?: boolean;
  registryNodePort?: number;
  storageRoot?: string;
  /**
   * JetStream storage caps of each tenant's runtime data-plane NATS (`di-nats`, #160): binary
   * quantities `maxFileStore` (default `10Gi`) and `maxMemoryStore` (default `32Mi`, at most
   * `64Mi`, half the 128Mi container limit). Validated before deploy. Defaults to config
   * `runtimeNats`.
   */
  runtimeNats?: RuntimeNatsConfig;
  /**
   * Plain-HTTP registries. The platform host group runs `--allow-insecure-registries`; tenant
   * hosts get `--insecure-registry` for the platform registry (with `registry`) and for each of
   * `insecureRegistries` only, so every other pull stays TLS.
   */
  insecureRegistry?: boolean;
  /**
   * Further `host[:port]` registries tenant hosts may pull from over plain HTTP, spelled exactly as
   * workload references spell them. Requires `insecureRegistry`. Defaults to config
   * `insecureRegistries`.
   */
  insecureRegistries?: string[];
  /**
   * Admin gateway route aliases (#217): public `<route-host>.<tenant>` to target
   * `<route-host>.<tenant>`, for plain HTTP tenant routes only. Validated and normalized before
   * deploy; an invalid map fails `createPlatform`. Defaults to top-level config `routeAliases`.
   */
  routeAliases?: Record<string, string>;
  values?: Record<string, unknown>;
  /** `http://{host}.{tenant}.localhost:<port>` for the published gateway port, if any. */
  routeUrlPattern?: string;
  beforeTenancy?: (release: k8s.helm.v3.Release) => pulumi.Resource;
  /**
   * Kubernetes API server URL that tenant users reach. When set, `kubeconfigs` holds one
   * token kubeconfig per user membership; when omitted, `kubeconfigs` is undefined.
   */
  apiServer?: pulumi.Input<string>;
  /**
   * Admin kubeconfig YAML, the same one `provider` uses. Required with `apiServer`: after each User
   * is Ready, the program polls the Kubernetes API with this kubeconfig (and `kubeContext`) until
   * the user's token Secret has `data.token`. The ambient `$KUBECONFIG` is never read. If the
   * kubeconfig uses an `exec` credential plugin, that plugin runs for these reads as it does for
   * `provider`. Once per update or preview it also lists the installation's Tenants, so a Retain
   * removal is announced (#228). The scheduler NATS Service `nats` is applied through a provider
   * built from it, which adopts the chart's Service of an earlier release in place (#541 m6e);
   * without it, an upgrade from such a release fails on that Service.
   */
  kubeconfig?: pulumi.Input<string>;
  /** Context of `kubeconfig` that `provider` uses; defaults to the kubeconfig's current context. */
  kubeContext?: pulumi.Input<string | undefined>;
}

/**
 * Published wash 2.8.0 with wasi-tls, patch 0002 (`--insecure-registry`, #149) and patch 0003 (NATS
 * blobstore credentials, #330), which tenant registries need for their own NATS account (#159). The
 * tag moves on the next publish; this digest is the multi-arch index from the tenant-host workflow
 * and is listed in `NATS_CREDENTIALS_HOST_IMAGE_DIGESTS`. The canonical variant's pin PR
 * (scripts/pin-artifact.ts, #346) moves it together with the published-images table.
 */
export const DEFAULT_HOST_IMAGE =
  'ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:8f0ee9c5a19ae0433e83a553431f1728ddf0a4787059c10e511209263d294537';

/**
 * Route aliases from `args`, or else from config `routeAliases`, a top-level object. A `gateway`
 * config key (nested `gateway.routeAliases`, or the literal dotted key) is refused rather than
 * silently ignored, whichever way the aliases arrive.
 */
function routeAliasesInput(args: PlatformConfigArgs, config: pulumi.Config): unknown {
  if (config.get('gateway') !== undefined || config.get('gateway.routeAliases') !== undefined)
    throw new Error('Set route aliases with the top-level config key routeAliases, not gateway');
  return args.routeAliases ?? config.getObject<unknown>('routeAliases');
}

/**
 * The `createPlatform` arguments that `validatePlatformConfig` checks. No provider is needed, so an
 * entrypoint can validate before it creates the cluster the provider points at.
 */
export type PlatformConfigArgs = Omit<PlatformArgs, 'provider' | 'beforeTenancy'>;

/** Validated, normalized configuration that `createPlatform` installs. */
export interface ValidatedPlatformConfig {
  config: pulumi.Config;
  declared: ReturnType<typeof declarations>;
  namespace: string;
  routeUrlPattern: string | undefined;
  insecureRegistries: string[];
  tenantHostImage: string;
  tenantAuth: ReturnType<typeof withDerivedPublicUrls>;
  tenantAuthRouteHosts: ReturnType<typeof tenantAuthRoutes>['routes'];
  runtimeNats: RuntimeNatsConfig | undefined;
  backingServiceClasses: ReturnType<typeof resolveBackingServiceClasses>;
  routeAliases: ReturnType<typeof validateRouteAliases>;
  /** The runtime-operator chart values, with the platform's settings enforced (design-541 §4.1). */
  helmValues: Record<string, unknown>;
  /** Warnings about accepted input; `createPlatform` logs them. */
  warnings: string[];
}

/**
 * Validates platform input without registering any resource or logging, and throws on invalid
 * input. `createPlatform` runs it first; entrypoints that create a cluster run it before the first
 * cluster resource, so invalid input fails before anything is created (#294).
 */
export function validatePlatformConfig(args: PlatformConfigArgs): ValidatedPlatformConfig {
  const config = args.config ?? new pulumi.Config();
  const declared = declarations(config);
  const namespace = args.namespace ?? 'wasmcloud';
  // Throws when `<namespace>-scheduler-pki` is not a valid namespace name (#541).
  schedulerPkiNamespace(namespace);
  const warnings: string[] = [];
  const routeUrlPattern = validateRouteUrlPattern(args.routeUrlPattern);
  const insecureRegistries = tenantInsecureRegistries({
    insecureRegistry: args.insecureRegistry,
    registry: args.registry,
    namespace,
    extra: args.insecureRegistries ?? config.getObject<string[]>('insecureRegistries'),
  });
  const tenantHostImage = config.get('tenantHostImage') ?? DEFAULT_HOST_IMAGE;
  assertHostImageSupportsAllowlist(tenantHostImage, insecureRegistries);
  const configuredTenantAuth = config.getObject<TenantAuthConfig>('tenantAuth');
  assertTenantAuthConfig(configuredTenantAuth);
  // The registry keeps working on such a host, in the shared TENANT account (#159).
  if (configuredTenantAuth?.registry && !hostImageSupportsNatsCredentials(tenantHostImage))
    warnings.push(
      `tenantHostImage ${tenantHostImage} is not a known build with wash patch 0003 (NATS blobstore credentials): ` +
        'tenant registries stay in the shared TENANT NATS account, reachable by tenant workloads, until it is one',
    );
  // Keys made before #379 stay in di-runtime-<tenant>, readable by the tenant controller, until
  // tenant-auth runs a build that reads the API-key namespace.
  if (configuredTenantAuth && !tenantAuthReadsApiKeyNamespace(configuredTenantAuth.image))
    warnings.push(
      `tenantAuth.image ${configuredTenantAuth.image} is not a known tenant-auth build that reads di-apikeys-<tenant> (#379): ` +
        'API keys made before #379 are not moved out of di-runtime-<tenant>, and the tenant controller keeps reading ' +
        "that namespace's Secrets, until tenantAuth.image is the tenant-auth digest this package documents",
    );
  // Unset tenant-auth public URLs default to gateway routes (#128); explicit URLs are kept.
  const tenantAuth = withDerivedPublicUrls(configuredTenantAuth, routeUrlPattern);
  const notDerived = unsetPublicUrls(tenantAuth);
  if (routeUrlPattern !== undefined && notDerived.length)
    warnings.push(
      `tenantAuth.${notDerived.join(', tenantAuth.')} not derived from routeUrlPattern ${routeUrlPattern} ` +
        '(only http://{host}.{tenant}.localhost[:<port>] is routed to tenant-auth); the port-forward defaults apply',
    );
  const extraHostGroups = extraHostGroupsWarning(args.values);
  if (extraHostGroups) warnings.push(extraHostGroups);
  const runtimeNats = args.runtimeNats ?? config.getObject<RuntimeNatsConfig>('runtimeNats');
  assertRuntimeNatsConfig(runtimeNats);
  const backingServiceClasses = resolveBackingServiceClasses(config);
  if (args.apiServer !== undefined && args.kubeconfig === undefined)
    throw new Error('createPlatform: apiServer requires kubeconfig (the one provider uses)');
  // Gateway routes for each tenant's console and controller hosts (#58).
  const { routes: tenantAuthRouteHosts } = tenantAuthRoutes(tenantAuth, routeUrlPattern);
  // Throws on a host group override the platform cannot secure (#541 m6e).
  const helmValues = platformHelmValues(namespace, args.values, args.insecureRegistry);
  // Gateway route aliases (#217): validated and normalized once, before any resource.
  const routeAliases = validateRouteAliases(routeAliasesInput(args, config), {
    tenantAuthRoutes: tenantAuthRouteHosts,
    tenants: declared.tenants.map((tenant) => tenant.name),
  });
  return {
    config,
    declared,
    namespace,
    routeUrlPattern,
    insecureRegistries,
    tenantHostImage,
    tenantAuth,
    tenantAuthRouteHosts,
    runtimeNats,
    backingServiceClasses,
    routeAliases,
    helmValues,
    warnings,
  };
}

/** Shared platform resources; the caller owns cluster creation and Pulumi state. */
export function createPlatform(args: PlatformArgs) {
  // Every validation runs before the first resource, so invalid input leaves nothing applied.
  const {
    config,
    declared,
    namespace: namespaceName,
    routeUrlPattern,
    insecureRegistries,
    tenantHostImage,
    tenantAuth,
    tenantAuthRouteHosts,
    runtimeNats,
    backingServiceClasses,
    routeAliases,
    helmValues,
    warnings,
  } = validatePlatformConfig(args);
  for (const warning of warnings) pulumi.log.warn(warning);
  const provider = args.provider;
  const scope = args.installation;
  const REGISTRY_IMAGE = 'docker.io/library/registry:3.1.1';
  const REGISTRY_NODE_PORT = args.registryNodePort ?? 30500;
  const HTTP_NODE_PORT = args.httpNodePort ?? 30180;
  const networkPolicy =
    args.networkPolicyEngine === 'kube-router' ? installNetworkPolicy(provider) : undefined;
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
            metadata: { name: PLATFORM_REGISTRY_SERVICE, namespace: namespaceName },
            spec: {
              type: 'NodePort',
              selector: registryLabels,
              ports: [
                {
                  name: 'registry',
                  port: PLATFORM_REGISTRY_PORT,
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

  // Kept in state as before; the release no longer waits for them, since the chart's operator
  // serves only the platform namespace (#541 m6e).
  seedTenantNamespaces(declared.tenants, scope, provider);

  // The scheduler NATS CAs, identity record and platform identities (#541), created by a one-shot
  // Job, so no key enters Pulumi state. Awaited: everything below mounts its Secrets.
  const schedulerPki = installSchedulerPki({
    namespace: namespaceName,
    installation: scope,
    provider,
    dependsOn: [namespaceResource],
    scripts: loadSchedulerPkiScripts(),
  });
  // The platform-owned scheduler NATS, Ready before the release stops rendering the chart's, then
  // the Service `nats` it takes over (#541 m6e).
  const schedulerNats = installSchedulerNats({
    namespace: namespaceName,
    release: args.release,
    provider,
    kubeconfig: args.kubeconfig,
    kubeContext: args.kubeContext,
    dependsOn: [namespaceResource, schedulerPki],
  });

  // The installation's Tenants, listed once per run with the admin kubeconfig for the Retain
  // removal check (#228), in preview too, retrying transient failures (#245). Without
  // `kubeconfig` nothing is listed.
  const adminKubeconfig = args.kubeconfig;
  const tenantSnapshot: pulumi.Output<TenantSnapshot> | undefined =
    adminKubeconfig === undefined
      ? undefined
      : pulumi.all([adminKubeconfig, args.kubeContext]).apply(([kubeconfig, context]) =>
          sharedTenantList(
            // async, so an unusable kubeconfig rejects into each caller's error handling.
            async (installation) => tenantListerFromKubeconfig(kubeconfig, context)(installation),
            scope,
          ),
        );

  const wasmcloud = new k8s.helm.v3.Release(
    'wasmcloud',
    {
      name: args.release ?? 'wasmcloud',
      namespace: namespaceName,
      createNamespace: false,
      // Always the pinned version, whose operator image the tenant operators run (#541 m6a).
      chart: 'oci://ghcr.io/wasmcloud/charts/runtime-operator',
      version: WASMCLOUD_OPERATOR_VERSION,
      // Not atomic: Helm's rollback cannot restore a release whose Service `nats` the platform
      // keeps (#613 W2). A failed upgrade stays failed and forward; the next `pulumi up` upgrades
      // it again (Pulumi retries a resource with init errors, Helm upgrades a failed release).
      // Still awaited, within `timeout`.
      skipAwait: false,
      cleanupOnFail: true,
      timeout: args.timeoutSeconds ?? 600,
      // Static: the chart's operator serves only the platform namespace (design-541 §4.1), so a
      // tenant change never restarts it. No post-renderer: the chart renders no NATS.
      values: helmValues,
    },
    {
      provider,
      // The server and Service `nats` first: the chart's operator and host group exit or wait
      // until their first connect to it succeeds, within the release's wait.
      dependsOn: [
        namespaceResource,
        ...(registryService ? [registryService] : []),
        schedulerPki,
        ...schedulerNats.resources,
      ],
    },
  );

  const runtimeShutdown = args.beforeTenancy?.(wasmcloud) ?? wasmcloud;

  // After the release, whose upgrade removes the chart's open policies (#462).
  for (const { name, spec } of platformIngressPolicies(namespaceName, scope))
    new k8s.networking.v1.NetworkPolicy(
      name,
      { metadata: { name, namespace: namespaceName }, spec },
      { provider, dependsOn: [wasmcloud] },
    );

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
      spec: gatewayNetworkPolicySpec(
        namespaceName,
        scope,
        tenantAuthRouteHosts,
        HTTP_NODE_PORT !== 0,
      ),
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
        routeAliases,
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
    insecureRegistries,
    storageRoot: args.storageRoot,
    hostImage: tenantHostImage,
    hostImagePullPolicy: config.get('tenantHostImagePullPolicy') ?? 'IfNotPresent',
    backingServiceClasses,
    routeUrlPattern,
    tenantAuth,
    runtimeNats,
  });
  // Warn before Pulumi deletes a Tenant that has no entry and whose live policy is Retain (#228).
  // Skipped without `kubeconfig`: the program has no way to read the cluster then. Reads the
  // same Tenant list as the watched namespaces (#245).
  const removalNotice = tenantSnapshot?.apply((list) =>
    warnRemovedTenants({
      declared: declared.tenants.map((t) => t.name),
      list,
      warn: (message) => pulumi.log.warn(message),
      debug: (message) => pulumi.log.debug(message),
    }),
  );
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
  // In preview the ID is unknown, so nothing is read. On update the wait runs inside an apply on
  // the User, which resolves only after the User is applied and Ready, so the budget starts then.
  const tokenSecretId = (
    user: string,
    tenant: string,
    userResource: pulumi.CustomResource,
  ): pulumi.Input<string> => {
    if (pulumi.runtime.isDryRun()) return pulumi.output(pulumi.unknown) as pulumi.Output<string>;
    const secretName = userTokenSecretName(user, tenant);
    return pulumi
      .all([userResource.id, adminKubeconfig, args.kubeContext])
      .apply(async ([, kubeconfig, context]) => {
        await waitForTokenSecret({
          namespace: namespaceName,
          name: secretName,
          readSecret: secretReaderFromKubeconfig(kubeconfig as string, context),
        });
        return `${namespaceName}/${secretName}`;
      });
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
                    tokenSecretId(user.name, tenant, tenancy.users[index] as pulumi.CustomResource),
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
    /** Resolves to the removal warnings printed for Retain tenants; undefined without `kubeconfig`. */
    removalNotice,
  };
}
