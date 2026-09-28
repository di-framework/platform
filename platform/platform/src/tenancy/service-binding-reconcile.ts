import {
  type BackingCapability,
  type BackingProvider,
  type BackingService,
  BINDING,
  bindingMatchesService,
  COMPATIBLE,
  type ControllerConfig,
  type EndpointSummary,
  GROUP,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  SERVICE,
  type ServiceBinding,
  statusContainsCredentials,
  TENANT,
  type Tenant,
} from './resources';

/**
 * Controller-managed ConfigMap/Secret prefix for ServiceBinding projection.
 * Must stay aligned with admission `BINDING_CONFIG_PREFIX` (#452).
 */
const BINDING_CONFIG_PREFIX = 'di-binding-';

/** Label identifying capability on projected binding config. */
const CAPABILITY = `${GROUP}/capability`;

/**
 * Controller-owned ConfigMap/Secret name for a declared application binding.
 * Workloads select this via named hostInterfaces `configFrom` (deploy wiring #455).
 */
function bindingProjectionName(bindingName: string): string {
  return `${BINDING_CONFIG_PREFIX}${bindingName}`;
}

/** Optional Secret name when credential material must ride `secretFrom`. */
function bindingSecretName(bindingName: string): string {
  return `${BINDING_CONFIG_PREFIX}${bindingName}-creds`;
}

function providerForCapability(capability: BackingCapability): BackingProvider {
  return COMPATIBLE[capability];
}

function connectionUrl(endpoint: EndpointSummary, provider: BackingProvider): string {
  if (provider === 'postgres')
    throw new Error('PostgreSQL URLs must come from runtime credentials');
  if (provider === 'redis') return `redis://${endpoint.host}:${endpoint.port}`;
  return `nats://${endpoint.host}:${endpoint.port}`;
}

/**
 * Non-secret host plugin keys for a named wasmCloud hostInterface.
 * Keyvalue: backend=redis, url, optional prefix (layout only).
 * Messaging: backend=nats, url (subscriptions stay workload-owned).
 */
function bindingConfigData(
  binding: ServiceBinding,
  endpoint: EndpointSummary,
): Record<string, string> {
  if (binding.spec.capability === 'postgres') return {};
  const provider = providerForCapability(binding.spec.capability);
  const data: Record<string, string> = {
    backend: provider,
    url: connectionUrl(endpoint, provider),
  };
  if (binding.spec.capability === 'keyvalue') {
    data.prefix = `${binding.spec.bindingName}:`;
  }
  return data;
}

/**
 * Credential keys only — never mirrored into ServiceBinding status.
 * Empty when the provisioned backend has no auth material (stock Redis/NATS v1).
 */
function bindingCredentialData(
  _binding: ServiceBinding,
  serviceConn: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!serviceConn) return undefined;
  if (_binding.spec.capability === 'postgres')
    return serviceConn.url ? { url: serviceConn.url } : undefined;
  const creds: Record<string, string> = {};
  for (const key of ['password', 'username', 'token', 'creds', 'auth']) {
    const value = serviceConn[key];
    if (typeof value === 'string' && value.length > 0) creds[key] = value;
  }
  return Object.keys(creds).length > 0 ? creds : undefined;
}

function bindingLabels(
  binding: ServiceBinding,
  tenant: Tenant,
  installation: string,
  ownerUid: string,
): Record<string, string> {
  return {
    [INSTALLATION]: installation,
    [OWNER]: ownerUid,
    [TENANT]: tenant.metadata.name,
    [SERVICE]: binding.spec.serviceName,
    [BINDING]: binding.spec.bindingName,
    [CAPABILITY]: binding.spec.capability,
  };
}

/**
 * Desired tenant-namespace projection for one bindingName.
 * Ownership UID is the elected primary ServiceBinding (lexicographically first
 * non-deleting peer sharing bindingName) so shared warehouse bindings stay stable.
 */
function serviceBindingResources(
  binding: ServiceBinding,
  tenant: Tenant,
  cfg: ControllerConfig,
  endpoint: EndpointSummary,
  ownerUid: string,
  serviceConn?: Record<string, string>,
): Resource[] {
  const n = names(tenant.metadata.name);
  const labels = bindingLabels(binding, tenant, cfg.installation, ownerUid);
  const configName = bindingProjectionName(binding.spec.bindingName);
  const resources: Resource[] = [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: configName,
        namespace: n.namespace,
        labels,
      },
      data: bindingConfigData(binding, endpoint),
    },
  ];
  const creds = bindingCredentialData(binding, serviceConn);
  if (creds) {
    resources.push({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: bindingSecretName(binding.spec.bindingName),
        namespace: n.namespace,
        labels,
      },
      type: 'Opaque',
      stringData: creds,
    });
  }
  return resources;
}

/**
 * Hint for WorkloadDeployment hostInterfaces (#455 will wire this into deploy).
 * Named entries are required for independent Redis/NATS backend selection.
 */
function bindingHostInterfaceProjection(binding: {
  bindingName: string;
  capability: 'keyvalue' | 'messaging';
}): {
  name: string;
  namespace: 'wasmcloud';
  package: BackingCapability;
  configFrom: { name: string }[];
  secretFrom?: { name: string }[];
} {
  const pkg = binding.capability;
  return {
    name: binding.bindingName,
    namespace: 'wasmcloud',
    package: pkg,
    configFrom: [{ name: bindingProjectionName(binding.bindingName) }],
  };
}

/** PostgreSQL has one labeled host interface per callable interface. Types stay in WIT. */
function bindingHostInterfaceProjections(
  binding: Pick<ServiceBinding['spec'], 'bindingName' | 'capability'>,
) {
  if (binding.capability !== 'postgres')
    return [bindingHostInterfaceProjection({ ...binding, capability: binding.capability })];
  return ['query', 'prepared'].map((iface) => ({
    name: `${binding.bindingName}-${iface}`,
    namespace: 'wasmcloud' as const,
    package: 'postgres' as const,
    version: '0.2.0',
    interfaces: [iface],
    secretFrom: [{ name: bindingSecretName(binding.bindingName) }],
  }));
}

function serviceIsReady(service: BackingService | undefined): boolean {
  return !!service?.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
}

function resolveBindingService(
  binding: ServiceBinding,
  service: BackingService | undefined,
): { error: string } | { service: BackingService; endpoint: EndpointSummary } {
  if (!service) {
    return {
      error: `BackingService ${binding.spec.serviceName} not found in namespace ${binding.metadata.namespace}`,
    };
  }
  if (!bindingMatchesService(binding.spec, { ...service.spec, metadata: service.metadata })) {
    return {
      error: `capability ${binding.spec.capability} does not match BackingService ${service.metadata.name} type ${service.spec.type}`,
    };
  }
  if (service.metadata.deletionTimestamp) {
    // Existing projections remain usable while deletion is blocked; new references fail closed.
    if (
      binding.status?.serviceRef?.uid !== service.metadata.uid ||
      !binding.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
    )
      return {
        error: `BackingService ${service.metadata.name} is deleting; new associations are refused`,
      };
  }
  const endpoint = service.status?.endpoint;
  if (!endpoint?.host || !endpoint.port) {
    return { error: `BackingService ${service.metadata.name} has no endpoint yet` };
  }
  if (endpoint.capability !== binding.spec.capability) {
    return {
      error: `BackingService endpoint capability ${endpoint.capability} does not match binding`,
    };
  }
  if (!serviceIsReady(service) && !service.metadata.deletionTimestamp) {
    return { error: `BackingService ${service.metadata.name} is not Ready` };
  }
  return { service, endpoint };
}

/**
 * Among peers sharing bindingName, elect the lexicographically first non-deleting
 * ServiceBinding as ConfigMap/Secret owner. Callers pass all same-namespace bindings.
 */
function electBindingOwner(
  bindingName: string,
  peers: ServiceBinding[],
): ServiceBinding | undefined {
  const live = peers
    .filter((b) => b.spec.bindingName === bindingName && !b.metadata.deletionTimestamp)
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  return live[0];
}

/**
 * Shared bindingName must resolve to one serviceName + capability; otherwise Failed.
 */
function sharedBindingConflict(
  binding: ServiceBinding,
  peers: ServiceBinding[],
): string | undefined {
  const siblings = peers.filter(
    (b) =>
      b.spec.bindingName === binding.spec.bindingName &&
      !b.metadata.deletionTimestamp &&
      b.metadata.name !== binding.metadata.name,
  );
  for (const peer of siblings) {
    if (peer.spec.serviceName !== binding.spec.serviceName) {
      return `bindingName ${binding.spec.bindingName} already bound to service ${peer.spec.serviceName}`;
    }
    if (peer.spec.capability !== binding.spec.capability) {
      return `bindingName ${binding.spec.bindingName} capability conflict with ${peer.metadata.name}`;
    }
  }
  return undefined;
}

function assertSafeBindingStatus(status: Record<string, unknown>): void {
  if (statusContainsCredentials(status)) {
    throw new Error('Refusing to publish ServiceBinding status that contains credential fields');
  }
}

export {
  assertSafeBindingStatus,
  BINDING_CONFIG_PREFIX,
  bindingConfigData,
  bindingCredentialData,
  bindingHostInterfaceProjection,
  bindingHostInterfaceProjections,
  bindingLabels,
  bindingProjectionName,
  bindingSecretName,
  CAPABILITY,
  connectionUrl,
  electBindingOwner,
  providerForCapability,
  resolveBindingService,
  serviceBindingResources,
  serviceIsReady,
  sharedBindingConflict,
};
