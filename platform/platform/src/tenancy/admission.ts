import {
  CAPABILITIES,
  DEFAULT_CLASS_NAMES,
  GROUP,
  INSTALLATION,
  OWNER,
  type Resource,
  ROUTES_CONFIG_NAME,
  TENANT,
} from './resources';

/** Controller-managed ConfigMap prefix for BackingService backend config (#450). */
export const BS_CONFIG_PREFIX = 'di-bs-';
/** Controller-managed Secret/ConfigMap prefix for ServiceBinding projection (#451). */
export const BINDING_CONFIG_PREFIX = 'di-binding-';
/** Console projection label (logs); only the controller may write objects carrying it. */
export const PROJECTION_LABEL = 'di-framework.dev/projection';
/** Transitional warehouse keyvalue ConfigMap; still admitted alongside di-bs-*. */
export const STOCK_CONFIG_NAME = 'di-tenant-stock';

const APPROVED_CLASS_NAMES = new Set<string>(Object.values(DEFAULT_CLASS_NAMES));

export function isManagedConfigName(name: string): boolean {
  return (
    name === STOCK_CONFIG_NAME ||
    name.startsWith(BS_CONFIG_PREFIX) ||
    name.startsWith(BINDING_CONFIG_PREFIX)
  );
}

export function isManagedSecretName(name: string): boolean {
  return name.startsWith(BINDING_CONFIG_PREFIX) || name.startsWith(BS_CONFIG_PREFIX);
}

export function tenantNameFromNamespace(namespace: string): string | undefined {
  const match = /^di-tenant-(.+)$/.exec(namespace);
  return match?.[1];
}

/** Fail-closed: platform ownership labels must match the trusted namespace, or be absent. */
export function ownershipLabelsAllowed(
  labels: Record<string, string> | undefined,
  namespace: string,
  installation?: string,
): boolean {
  if (!labels) return true;
  const tenant = tenantNameFromNamespace(namespace);
  if (!tenant) return false;
  if (labels[TENANT] !== undefined && labels[TENANT] !== tenant) return false;
  if (labels[OWNER] !== undefined) return false;
  if (installation !== undefined && labels[INSTALLATION] !== undefined) {
    if (labels[INSTALLATION] !== installation) return false;
  }
  return true;
}

export function approvedClassName(className: string | undefined, type: string): boolean {
  if (className === undefined || className === '') {
    return (
      type === 'keyvalue' || type === 'messaging' || type === 'blobstore' || type === 'postgres'
    );
  }
  return APPROVED_CLASS_NAMES.has(className);
}

export function serviceNameSameNamespace(serviceName: string): boolean {
  return (
    typeof serviceName === 'string' &&
    serviceName.length > 0 &&
    serviceName.length <= 40 &&
    !serviceName.includes('/') &&
    !serviceName.includes('.') &&
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(serviceName)
  );
}

export interface HostInterfaceLike {
  name?: string;
  namespace?: string;
  package?: string;
  interfaces?: string[];
  configFrom?: { name: string }[];
  secretFrom?: { name: string }[];
  config?: Record<string, unknown>;
}

/**
 * Mirrors the workload ValidatingAdmissionPolicy CEL (fail-closed).
 * Unnamed backend selection is denied except the transitional stock keyvalue path.
 */
export function hostInterfaceAllowed(hostInterface: HostInterfaceLike): boolean {
  const { namespace, package: packageName, name } = hostInterface;
  const configFrom = hostInterface.configFrom ?? [];
  const secretFrom = hostInterface.secretFrom ?? [];
  const config = hostInterface.config ?? {};
  const hasName = typeof name === 'string' && name.length > 0;
  const hasReferences = configFrom.length > 0 || secretFrom.length > 0;
  const configKeys = Object.keys(config);

  if (namespace === 'wasi' && (packageName === 'http' || packageName === 'config')) {
    if (hasName || hasReferences) return false;
    return packageName === 'config' || configKeys.every((key) => key === 'host' || key === 'path');
  }
  // Guest console output goes through the host TracingLogger, which attributes each line.
  if (namespace === 'wasi' && packageName === 'logging') {
    if (hasName || hasReferences || configKeys.length > 0) return false;
    return hostInterface.interfaces?.length === 1 && hostInterface.interfaces[0] === 'logging';
  }

  if (namespace !== 'wasmcloud') return false;
  if (packageName === 'postgres') {
    if (configKeys.length > 0 || configFrom.length > 0) return false;
    if (!hasName)
      return (
        secretFrom.length === 0 &&
        hostInterface.interfaces?.length === 1 &&
        hostInterface.interfaces[0] === 'types'
      );
    const iface = hostInterface.interfaces?.length === 1 ? hostInterface.interfaces[0] : undefined;
    if (iface !== 'query' && iface !== 'prepared') return false;
    const suffix = `-${iface}`;
    if (!hostInterface.name?.endsWith(suffix)) return false;
    const name = hostInterface.name.slice(0, -suffix.length);
    return !!name && secretFrom.length === 1 && secretFrom[0]?.name === `di-binding-${name}-creds`;
  }
  // Blobstore stays unnamed. Without references it uses the host data store; a created
  // service is selected only through a controller-managed di-binding-/di-bs- ConfigMap.
  if (packageName === 'blobstore') {
    if (hasName || secretFrom.length > 0 || configKeys.length > 0) return false;
    if (
      !configFrom.every(
        (reference) =>
          reference.name.startsWith(BINDING_CONFIG_PREFIX) ||
          reference.name.startsWith(BS_CONFIG_PREFIX),
      )
    )
      return false;
    const interfaces = hostInterface.interfaces ?? [];
    return interfaces.every(
      (iface) => iface === 'blobstore' || iface === 'container' || iface === 'types',
    );
  }
  if (packageName !== 'keyvalue' && packageName !== 'messaging') return false;
  if (!configFrom.every((reference) => isManagedConfigName(reference.name))) return false;
  if (!secretFrom.every((reference) => isManagedSecretName(reference.name))) return false;

  if (packageName === 'keyvalue') {
    if (configKeys.length > 0) return false;
    if (hasName) return hasReferences;

    // Transitional unnamed keyvalue may reference only the stock ConfigMap.
    return (
      secretFrom.length === 0 &&
      configFrom.length > 0 &&
      configFrom.every((reference) => reference.name === STOCK_CONFIG_NAME)
    );
  }

  // The transitional stock ConfigMap is reserved for keyvalue.
  if (configFrom.some((reference) => reference.name === STOCK_CONFIG_NAME)) return false;

  // Messaging accepts subscription options, never inline backend URLs.
  const subscriptionOptions = [
    'subscriptions',
    'consumer_group',
    'max_in_flight',
    'admission_wait',
  ];
  if (!configKeys.every((key) => subscriptionOptions.includes(key))) return false;

  // Transitional unnamed messaging uses default NATS without backend references.
  if (!hasName) return !hasReferences;
  return hasReferences || configKeys.length > 0;
}

interface VolumeLike {
  name: string;
  [key: string]: unknown;
}

/**
 * Mirrors the workload volume rules in the CEL policy (#11). The controller authors host
 * volumes and preopens; a tenant update may keep the controller's volumes unchanged.
 */
export function workloadVolumesAllowed(input: {
  username: string;
  controllerNamespace: string;
  operation: 'CREATE' | 'UPDATE';
  volumes?: VolumeLike[];
  oldVolumes?: VolumeLike[];
  volumeMounts: { name: string }[][];
}): boolean {
  if (
    input.username === `system:serviceaccount:${input.controllerNamespace}:di-platform-controller`
  )
    return true;
  const volumes = input.volumes ?? [];
  const kept =
    input.operation === 'UPDATE' &&
    input.oldVolumes !== undefined &&
    input.volumes !== undefined &&
    JSON.stringify(volumes) === JSON.stringify(input.oldVolumes);
  if (volumes.length > 0 && !kept) return false;
  return input.volumeMounts.every(
    (mounts) =>
      mounts.length === 0 ||
      (kept && mounts.every((mount) => volumes.some((volume) => volume.name === mount.name))),
  );
}

export function validateBackingServiceAdmission(input: {
  namespace: string;
  type: string;
  className?: string;
  labels?: Record<string, string>;
  installation?: string;
}): string | undefined {
  if (!ownershipLabelsAllowed(input.labels, input.namespace, input.installation))
    return 'BackingService ownership labels must derive from the tenant namespace';
  if (!(CAPABILITIES as readonly string[]).includes(input.type))
    return 'BackingService type must be keyvalue, messaging, blobstore or postgres';
  if (!approvedClassName(input.className, input.type))
    return 'BackingService className must be an approved platform default (fail-closed)';
  return undefined;
}

export function validateServiceBindingAdmission(input: {
  namespace: string;
  serviceName: string;
  capability: string;
  labels?: Record<string, string>;
  installation?: string;
}): string | undefined {
  if (!ownershipLabelsAllowed(input.labels, input.namespace, input.installation))
    return 'ServiceBinding ownership labels must derive from the tenant namespace';
  if (!serviceNameSameNamespace(input.serviceName))
    return 'ServiceBinding serviceName must reference a BackingService in the same namespace';
  if (!(CAPABILITIES as readonly string[]).includes(input.capability))
    return 'ServiceBinding capability must be keyvalue, messaging, blobstore or postgres';
  return undefined;
}

interface AdmissionValidation {
  expression: string;
  message: string;
}

interface AdmissionVariable {
  name: string;
  expression: string;
}

interface AdmissionPolicy {
  name: string;
  apiGroups: string[];
  resources: string[];
  apiVersions?: string[];
  operations?: string[];
  validations: AdmissionValidation[];
  variables?: AdmissionVariable[];
}

/** Every policy denies invalid requests in this installation's tenant namespaces. */
function policyResources(installation: string, policy: AdmissionPolicy): Resource[] {
  const fullName = `${installation}-${policy.name}`;
  const { apiGroups, resources, apiVersions = ['*'], operations = ['CREATE', 'UPDATE'] } = policy;
  return [
    {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicy',
      metadata: { name: fullName },
      spec: {
        failurePolicy: 'Fail',
        matchConstraints: {
          resourceRules: [{ apiGroups, apiVersions, operations, resources }],
        },
        ...(policy.variables ? { variables: policy.variables } : {}),
        validations: policy.validations,
      },
    },
    {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicyBinding',
      metadata: { name: fullName },
      spec: {
        policyName: fullName,
        validationActions: ['Deny'],
        matchResources: {
          namespaceSelector: {
            matchLabels: { [INSTALLATION]: installation },
            matchExpressions: [{ key: TENANT, operator: 'Exists' }],
          },
        },
      },
    },
  ];
}

/**
 * CEL fragments are expanded inside hostInterfaces.all(h, ...), where h is in scope.
 * Keep missing-field guards next to the fields they protect.
 */
function hostInterfaceAdmissionExpression(): string {
  const unnamed = "(!has(h.name) || h.name == '')";
  const named = "has(h.name) && h.name != ''";
  const noConfigReferences = '(!has(h.configFrom) || size(h.configFrom) == 0)';
  const noSecretReferences = '(!has(h.secretFrom) || size(h.secretFrom) == 0)';
  const hasConfigReferences = '(has(h.configFrom) && size(h.configFrom) > 0)';
  const hasSecretReferences = '(has(h.secretFrom) && size(h.secretFrom) > 0)';
  const hasInlineConfig = '(has(h.config) && size(h.config) > 0)';
  const managedSecretReferences = `(
    !has(h.secretFrom) || size(h.secretFrom) == 0 ||
    h.secretFrom.all(s,
      s.name.startsWith('${BINDING_CONFIG_PREFIX}') || s.name.startsWith('${BS_CONFIG_PREFIX}'))
  )`;
  const managedConfigName = `c.name.startsWith('${BS_CONFIG_PREFIX}') || c.name.startsWith('${BINDING_CONFIG_PREFIX}')`;

  const wasi = `(h['namespace'] == 'wasi' && h['package'] in ['http', 'config'] &&
    ${unnamed} && ${noSecretReferences} && ${noConfigReferences} &&
    (!has(h.config) ||
      (h['package'] == 'http' && h.config.all(k, k in ['host', 'path'])) ||
      h['package'] == 'config'))`;
  const wasiLogging = `(h['namespace'] == 'wasi' && h['package'] == 'logging' &&
    ${unnamed} && ${noSecretReferences} && ${noConfigReferences} &&
    (!has(h.config) || size(h.config) == 0) &&
    has(h.interfaces) && size(h.interfaces) == 1 && h.interfaces[0] == 'logging')`;

  // Unnamed keyvalue is restricted to the transitional stock ConfigMap.
  const stockKeyvalue = `(${unnamed} &&
    has(h.configFrom) && size(h.configFrom) > 0 &&
    h.configFrom.all(c, c.name == '${STOCK_CONFIG_NAME}') && ${noSecretReferences})`;
  const namedKeyvalue = `(${named} && (${hasConfigReferences} || ${hasSecretReferences}))`;
  const keyvalue = `(h['namespace'] == 'wasmcloud' && h['package'] == 'keyvalue' &&
    (!has(h.config) || size(h.config) == 0) &&
    ${managedSecretReferences} &&
    (!has(h.configFrom) || size(h.configFrom) == 0 ||
      h.configFrom.all(c, c.name == '${STOCK_CONFIG_NAME}' || ${managedConfigName})) &&
    (${stockKeyvalue} || ${namedKeyvalue}))`;

  // Unnamed messaging uses default NATS; named messaging may supply subscription options.
  const defaultMessaging = `(${unnamed} && ${noConfigReferences} && ${noSecretReferences})`;
  const namedMessaging = `(${named} &&
    (${hasConfigReferences} || ${hasSecretReferences} || ${hasInlineConfig}))`;
  const messaging = `(h['namespace'] == 'wasmcloud' && h['package'] == 'messaging' &&
    ${managedSecretReferences} &&
    (!has(h.configFrom) || size(h.configFrom) == 0 || h.configFrom.all(c, ${managedConfigName})) &&
    (!has(h.config) ||
      h.config.all(k, k in ['subscriptions', 'consumer_group', 'max_in_flight', 'admission_wait'])) &&
    (${defaultMessaging} || ${namedMessaging}))`;

  const blobstore = `(h['namespace'] == 'wasmcloud' && h['package'] == 'blobstore' &&
    ${unnamed} && ${noSecretReferences} &&
    (!has(h.configFrom) || size(h.configFrom) == 0 || h.configFrom.all(c, ${managedConfigName})) &&
    (!has(h.config) || size(h.config) == 0) &&
    (!has(h.interfaces) || h.interfaces.all(i, i in ['blobstore', 'container', 'types'])))`;

  const postgres = `(h['namespace'] == 'wasmcloud' && h['package'] == 'postgres' &&
    !${hasInlineConfig} && ${noConfigReferences} && has(h.interfaces) &&
    ((${unnamed} && h.interfaces == ['types'] && ${noSecretReferences}) ||
      (${named} && ${hasSecretReferences} && size(h.secretFrom) == 1 &&
        ((h.interfaces == ['query'] && h.name.endsWith('-query') && size(h.name) > 6 &&
          h.secretFrom[0].name == '${BINDING_CONFIG_PREFIX}' + h.name.substring(0, size(h.name) - 6) + '-creds') ||
         (h.interfaces == ['prepared'] && h.name.endsWith('-prepared') && size(h.name) > 9 &&
          h.secretFrom[0].name == '${BINDING_CONFIG_PREFIX}' + h.name.substring(0, size(h.name) - 9) + '-creds')))))`;

  return `!has(variables.w.hostInterfaces) || variables.w.hostInterfaces.all(h,
    (${wasi} || ${wasiLogging} || ${keyvalue} || ${messaging} || ${blobstore} || ${postgres}))`;
}

/**
 * Host volumes and preopens are platform-owned (#11). Only the controller may set them; a
 * tenant update may carry the controller's volumes forward unchanged and mount nothing else.
 */
function workloadPolicy(namespace: string): AdmissionPolicy {
  return {
    name: 'workloads',
    apiGroups: ['runtime.wasmcloud.dev'],
    resources: ['workloaddeployments'],
    variables: [
      { name: 'w', expression: 'object.spec.template.spec' },
      {
        name: 'controller',
        expression: `request.userInfo.username == 'system:serviceaccount:${namespace}:di-platform-controller'`,
      },
      {
        name: 'keptVolumes',
        expression: `request.operation == 'UPDATE' &&
          has(oldObject.spec.template.spec.volumes) && has(variables.w.volumes) &&
          variables.w.volumes == oldObject.spec.template.spec.volumes`,
      },
      {
        name: 'locals',
        expression: `
          (has(variables.w.components)
            ? variables.w.components.filter(c, has(c.localResources)).map(c, c.localResources)
            : []) +
          (has(variables.w.service) && has(variables.w.service.localResources)
            ? [variables.w.service.localResources]
            : [])`,
      },
    ],
    validations: [
      {
        expression: `has(variables.w.environment) &&
          variables.w.environment == object.metadata.namespace &&
          !has(variables.w.hostId)`,
        message: 'Tenant workloads must target their own environment and cannot select a host ID',
      },
      {
        expression: `variables.controller || variables.keptVolumes ||
          !has(variables.w.volumes) || size(variables.w.volumes) == 0`,
        message: 'Tenant workloads cannot mount host volumes',
      },
      {
        expression: `variables.locals.all(l,
          (!has(l.allowedHosts) || size(l.allowedHosts) == 0) &&
          (!has(l.allowedHostLoopbackPorts) || size(l.allowedHostLoopbackPorts) == 0) &&
          (!has(l.volumeMounts) || size(l.volumeMounts) == 0 || variables.controller ||
            (variables.keptVolumes &&
              l.volumeMounts.all(m, variables.w.volumes.exists(v, v.name == m.name)))))`,
        message: 'Tenant guests cannot request network or host filesystem capabilities',
      },
      {
        expression: hostInterfaceAdmissionExpression(),
        message:
          'Only wasi http/config or logging, or wasmcloud keyvalue/messaging/blobstore/postgres with controller-managed di-bs-/di-binding- (or transitional di-tenant-stock / default NATS / host blobstore) references are allowed',
      },
    ],
  };
}

/** Reserve controller-managed configuration and credentials against tenant-user mutation. */
function backendConfigPolicy(namespace: string): AdmissionPolicy {
  const objectName =
    "(request.operation == 'DELETE' ? oldObject.metadata.name : object.metadata.name)";
  return {
    name: 'backend-config',
    apiGroups: [''],
    apiVersions: ['v1'],
    operations: ['CREATE', 'UPDATE', 'DELETE'],
    resources: ['configmaps', 'secrets'],
    validations: [
      {
        expression: `
          !request.userInfo.username.startsWith('system:serviceaccount:${namespace}:di-user-') ||
          !(${objectName} == '${STOCK_CONFIG_NAME}' ||
            ${objectName} == '${ROUTES_CONFIG_NAME}' ||
            ${objectName}.startsWith('${BS_CONFIG_PREFIX}') ||
            ${objectName}.startsWith('${BINDING_CONFIG_PREFIX}'))`,
        message:
          'di-tenant-stock, di-platform-routes, di-bs-*, and di-binding-* ConfigMaps/Secrets are managed by the platform controller',
      },
      {
        // The console trusts di-framework.dev/projection ConfigMaps (logs, signals); a tenant
        // must not forge or erase them, under any name.
        expression: `
          !request.userInfo.username.startsWith('system:serviceaccount:${namespace}:di-user-') ||
          !((request.operation != 'DELETE' && has(object.metadata.labels) &&
              '${PROJECTION_LABEL}' in object.metadata.labels) ||
            (request.operation != 'CREATE' && has(oldObject.metadata.labels) &&
              '${PROJECTION_LABEL}' in oldObject.metadata.labels))`,
        message: 'di-framework.dev/projection ConfigMaps are published by the platform controller',
      },
    ],
  };
}

function ownershipLabelsExpression(installation: string): string {
  return `!has(object.metadata.labels) || (
    (!('${OWNER}' in object.metadata.labels)) &&
    (!('${TENANT}' in object.metadata.labels) ||
      object.metadata.namespace == 'di-tenant-' + object.metadata.labels['${TENANT}']) &&
    (!('${INSTALLATION}' in object.metadata.labels) ||
      object.metadata.labels['${INSTALLATION}'] == '${installation}')
  )`;
}

/** The controller's runtime credentials must never become guest capabilities. */
export function admissionResources(installation: string, namespace: string): Resource[] {
  const ownershipLabels = ownershipLabelsExpression(installation);
  const policies: AdmissionPolicy[] = [
    workloadPolicy(namespace),
    backendConfigPolicy(namespace),
    {
      name: 'services',
      apiGroups: [''],
      resources: ['services'],
      validations: [
        {
          expression: `(!has(object.spec.type) || object.spec.type == 'ClusterIP') &&
            (!has(object.spec.externalIPs) || size(object.spec.externalIPs) == 0)`,
          message: 'Tenant services must be ClusterIP services without external IPs',
        },
      ],
    },
    {
      name: 'backingservices',
      apiGroups: [GROUP],
      resources: ['backingservices'],
      validations: [
        {
          expression: ownershipLabels,
          message: 'BackingService ownership labels must derive from the tenant namespace',
        },
        {
          expression: `object.spec.type in ['keyvalue', 'messaging', 'blobstore', 'postgres'] &&
            (!has(object.spec.className) || object.spec.className == '' ||
              object.spec.className in ['${DEFAULT_CLASS_NAMES.keyvalue}', '${DEFAULT_CLASS_NAMES.messaging}', '${DEFAULT_CLASS_NAMES.blobstore}', '${DEFAULT_CLASS_NAMES.postgres}'])`,
          message:
            'BackingService className must be an approved platform default (fail-closed for unknown classes)',
        },
      ],
    },
    {
      name: 'servicebindings',
      apiGroups: [GROUP],
      resources: ['servicebindings'],
      validations: [
        {
          expression: ownershipLabels,
          message: 'ServiceBinding ownership labels must derive from the tenant namespace',
        },
        {
          expression: `object.spec.capability in ['keyvalue', 'messaging', 'blobstore', 'postgres'] &&
            object.spec.serviceName != '' &&
            !object.spec.serviceName.contains('/') && !object.spec.serviceName.contains('.')`,
          message:
            'ServiceBinding must reference a same-namespace BackingService with capability keyvalue, messaging, blobstore or postgres',
        },
      ],
    },
  ];
  return policies.flatMap((policy) => policyResources(installation, policy));
}
