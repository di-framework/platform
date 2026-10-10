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
  if (className === undefined || className === '')
    return (CAPABILITIES as readonly string[]).includes(type);
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

interface LocalResourcesLike {
  allowedHosts?: string[];
  allowedIpNameLookups?: string[];
  [key: string]: unknown;
}

/**
 * Mirrors the workload egress rule in the CEL policy (#13). Only the controller grants
 * `allowedHosts` / `allowedIpNameLookups`, from an approved egress ServiceBinding. A tenant
 * update may carry a list forward unchanged from any guest of the previous object.
 */
export function workloadEgressAllowed(input: {
  username: string;
  controllerNamespace: string;
  operation: 'CREATE' | 'UPDATE';
  locals: LocalResourcesLike[];
  oldLocals?: LocalResourcesLike[];
}): boolean {
  if (
    input.username === `system:serviceaccount:${input.controllerNamespace}:di-platform-controller`
  )
    return true;
  const old = input.operation === 'UPDATE' ? (input.oldLocals ?? []) : [];
  const kept = (field: 'allowedHosts' | 'allowedIpNameLookups', value: string[] | undefined) =>
    !value?.length ||
    old.some(
      (previous) =>
        previous[field] !== undefined && JSON.stringify(previous[field]) === JSON.stringify(value),
    );
  return input.locals.every(
    (local) =>
      kept('allowedHosts', local.allowedHosts) &&
      kept('allowedIpNameLookups', local.allowedIpNameLookups),
  );
}

/** WorkloadDeployment label naming the tenant-auth environment it was deployed to (#55). */
export const ENV_LABEL = 'platform.di-framework.dev/env';
/** Environments a WorkloadDeployment may reference tenant vars and secrets for (#88). */
export const DEPLOY_ENVS = ['prod', 'staging'] as const;
const TENANT_SECRET_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

interface EnvironmentReferencesLike {
  environment?: {
    configFrom?: { name: string }[];
    secretFrom?: { name: string }[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Mirrors the environment reference rule in the CEL policy (#88; tenant-auth README "Secrets and
 * vars storage contract"). A tenant WorkloadDeployment labelled with env `<env>` may reference
 * only `di-vars-<env>` and `<name>.<env>` Secrets whose `<name>` is not managed; without a valid
 * env label it may reference neither. The `<workload>-control` Secret cli-plugin-platform renders
 * for HTTP workloads stays allowed. Secret labels are checked by the deploy lane (#87), not here.
 */
export function workloadEnvironmentReferencesAllowed(input: {
  username: string;
  controllerNamespace: string;
  workloadName: string;
  labels?: Record<string, string>;
  locals: EnvironmentReferencesLike[];
  /** Names from `components[].imagePullSecret.name` and `service.imagePullSecret.name`. */
  imagePullSecrets?: string[];
}): boolean {
  if (
    input.username === `system:serviceaccount:${input.controllerNamespace}:di-platform-controller`
  )
    return true;
  if ((input.imagePullSecrets ?? []).some(isManagedSecretName)) return false;
  const label = input.labels?.[ENV_LABEL];
  const env = (DEPLOY_ENVS as readonly string[]).includes(label ?? '') ? label : undefined;
  const controlSecret = `${input.workloadName}-control`;
  const secretAllowed = (name: string) => {
    if (isManagedSecretName(name)) return false;
    if (name === controlSecret) return true;
    if (env === undefined || !name.endsWith(`.${env}`)) return false;
    return TENANT_SECRET_NAME.test(name.slice(0, -(env.length + 1)));
  };
  return input.locals.every(
    ({ environment }) =>
      (environment?.configFrom ?? []).every(
        (reference) => env !== undefined && reference.name === `di-vars-${env}`,
      ) && (environment?.secretFrom ?? []).every((reference) => secretAllowed(reference.name)),
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
    return 'BackingService type must be keyvalue, messaging, blobstore, postgres or egress';
  if (!approvedClassName(input.className, input.type))
    return 'BackingService className must be an approved platform default (fail-closed)';
  return undefined;
}

export function validateServiceBindingAdmission(input: {
  namespace: string;
  serviceName: string;
  capability: string;
  workloadName?: string;
  labels?: Record<string, string>;
  installation?: string;
}): string | undefined {
  if (!ownershipLabelsAllowed(input.labels, input.namespace, input.installation))
    return 'ServiceBinding ownership labels must derive from the tenant namespace';
  if (!serviceNameSameNamespace(input.serviceName))
    return 'ServiceBinding serviceName must reference a BackingService in the same namespace';
  if (!(CAPABILITIES as readonly string[]).includes(input.capability))
    return 'ServiceBinding capability must be keyvalue, messaging, blobstore, postgres or egress';
  if (input.capability === 'egress' && !input.workloadName)
    return 'An egress ServiceBinding must name its WorkloadDeployment in workloadName';
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

function localsOf(spec: string): string {
  return `
    (has(${spec}.components)
      ? ${spec}.components.filter(c, has(c.localResources)).map(c, c.localResources)
      : []) +
    (has(${spec}.service) && has(${spec}.service.localResources)
      ? [${spec}.service.localResources]
      : [])`;
}

/**
 * Host volumes and preopens are platform-owned (#11). Only the controller may set them; a
 * tenant update may carry the controller's volumes forward unchanged and mount nothing else.
 * Egress (`allowedHosts`, `allowedIpNameLookups`) follows the same rule (#13).
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
        name: 'env',
        expression: `has(object.metadata.labels) && '${ENV_LABEL}' in object.metadata.labels &&
          object.metadata.labels['${ENV_LABEL}'] in ${JSON.stringify(DEPLOY_ENVS).replaceAll('"', "'")}
          ? object.metadata.labels['${ENV_LABEL}'] : ''`,
      },
      { name: 'locals', expression: localsOf('variables.w') },
      {
        name: 'pullSecrets',
        expression: `
          (has(variables.w.components)
            ? variables.w.components.filter(c, has(c.imagePullSecret)).map(c, c.imagePullSecret.name)
            : []) +
          (has(variables.w.service) && has(variables.w.service.imagePullSecret)
            ? [variables.w.service.imagePullSecret.name]
            : [])`,
      },
      {
        name: 'oldLocals',
        expression: `request.operation != 'UPDATE' ? [] : ${localsOf('oldObject.spec.template.spec')}`,
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
          (!has(l.allowedHostLoopbackPorts) || size(l.allowedHostLoopbackPorts) == 0) &&
          (!has(l.volumeMounts) || size(l.volumeMounts) == 0 || variables.controller ||
            (variables.keptVolumes &&
              l.volumeMounts.all(m, variables.w.volumes.exists(v, v.name == m.name)))))`,
        message: 'Tenant guests cannot request network or host filesystem capabilities',
      },
      {
        expression: `variables.controller || variables.locals.all(l,
          (!has(l.allowedHosts) || size(l.allowedHosts) == 0 ||
            variables.oldLocals.exists(o, has(o.allowedHosts) && o.allowedHosts == l.allowedHosts)) &&
          (!has(l.allowedIpNameLookups) || size(l.allowedIpNameLookups) == 0 ||
            variables.oldLocals.exists(o,
              has(o.allowedIpNameLookups) && o.allowedIpNameLookups == l.allowedIpNameLookups)))`,
        message:
          'Tenant guests cannot set allowedHosts or allowedIpNameLookups; request egress with an egress BackingService and ServiceBinding',
      },
      {
        expression: `variables.controller || variables.locals.all(l, !has(l.environment) || (
          (!has(l.environment.configFrom) || l.environment.configFrom.all(c,
            variables.env != '' && c.name == 'di-vars-' + variables.env)) &&
          (!has(l.environment.secretFrom) || l.environment.secretFrom.all(s,
            !s.name.startsWith('${BINDING_CONFIG_PREFIX}') && !s.name.startsWith('${BS_CONFIG_PREFIX}') &&
            (s.name == object.metadata.name + '-control' ||
              (variables.env != '' && s.name.endsWith('.' + variables.env) &&
                s.name.matches('^[a-z]([-a-z0-9]{0,61}[a-z0-9])?[.](${DEPLOY_ENVS.join('|')})$')))))))`,
        message:
          'Tenant guests may reference only di-vars-<env> and <name>.<env> Secrets matching their platform.di-framework.dev/env label (never di-binding-*/di-bs-*)',
      },
      {
        expression: `variables.controller || variables.pullSecrets.all(n,
          !n.startsWith('${BINDING_CONFIG_PREFIX}') && !n.startsWith('${BS_CONFIG_PREFIX}'))`,
        message: 'Tenant guests cannot use di-binding-*/di-bs-* Secrets as an imagePullSecret',
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

/**
 * Developers may delete tenant Secrets but never read them (#112). A DELETE response carries the
 * object, data included, so refuse every DELETE that can answer without removing the Secret:
 * a dry run, an `Orphan`/`Foreground` propagation policy (each adds a finalizer, so the object
 * is only marked), and a Secret that already has finalizers or a deletionTimestamp. What is left
 * is a plain delete that removes the Secret; the controller proxy also redacts its response.
 */
function tenantSecretDeletePolicy(namespace: string): AdmissionPolicy {
  return {
    name: 'tenant-secret-delete',
    apiGroups: [''],
    apiVersions: ['v1'],
    operations: ['DELETE'],
    resources: ['secrets'],
    validations: [
      {
        expression: `
          !request.userInfo.username.startsWith('system:serviceaccount:${namespace}:di-user-') ||
          !((has(request.dryRun) && request.dryRun == true) ||
            (has(request.options) && has(request.options.propagationPolicy) &&
              request.options.propagationPolicy in ['Orphan', 'Foreground']) ||
            (has(request.options) && has(request.options.orphanDependents) &&
              request.options.orphanDependents == true) ||
            (has(oldObject.metadata.finalizers) && size(oldObject.metadata.finalizers) > 0) ||
            has(oldObject.metadata.deletionTimestamp))`,
        message:
          'tenant users may delete Secrets only with a plain, non-dry-run delete of a Secret without finalizers',
      },
    ],
  };
}

/** Mirrors the `tenant-secret-delete` CEL rule (#112). */
export function tenantSecretDeleteAllowed(input: {
  username: string;
  controllerNamespace: string;
  dryRun?: boolean;
  options?: { propagationPolicy?: string; orphanDependents?: boolean };
  finalizers?: string[];
  deletionTimestamp?: string;
}): boolean {
  if (!input.username.startsWith(`system:serviceaccount:${input.controllerNamespace}:di-user-`))
    return true;
  return !(
    input.dryRun === true ||
    ['Orphan', 'Foreground'].includes(input.options?.propagationPolicy ?? '') ||
    input.options?.orphanDependents === true ||
    (input.finalizers ?? []).length > 0 ||
    input.deletionTimestamp !== undefined
  );
}

/** Denial for a tenant user's UPDATE of a platform-managed Secret (#112; the CLI maps it to 403). */
export const SECRET_UPDATE_MANAGED_MESSAGE =
  'tenant users cannot update platform-managed di-binding-*/di-bs-* Secrets';
/** Denial for a tenant user's UPDATE that drops an existing Secret key (#112; the CLI maps it to 409). */
export const SECRET_UPDATE_KEYS_MESSAGE =
  'tenant users may update a Secret only if it keeps every existing data key';

/**
 * Developers replace tenant Secrets they cannot read (#112), so the console's Secret reassignment
 * must not clobber a platform-managed Secret or silently drop keys it cannot see. Each UPDATE by a
 * `di-user-*` service account must target an unmanaged name and keep every key of the old object
 * (stringData is already folded into data at admission). Same-key replaces (the `/v1` set and
 * update, the CLI control Secret) stay allowed.
 */
function tenantSecretUpdatePolicy(namespace: string): AdmissionPolicy {
  const developer = `request.userInfo.username.startsWith('system:serviceaccount:${namespace}:di-user-')`;
  return {
    name: 'tenant-secret-update',
    apiGroups: [''],
    apiVersions: ['v1'],
    operations: ['UPDATE'],
    resources: ['secrets'],
    validations: [
      {
        expression: `!${developer} ||
          !(object.metadata.name.startsWith('${BS_CONFIG_PREFIX}') ||
            object.metadata.name.startsWith('${BINDING_CONFIG_PREFIX}'))`,
        message: SECRET_UPDATE_MANAGED_MESSAGE,
      },
      {
        expression: `!${developer} || !has(oldObject.data) ||
          oldObject.data.all(k, has(object.data) && k in object.data)`,
        message: SECRET_UPDATE_KEYS_MESSAGE,
      },
    ],
  };
}

/** Mirrors the `tenant-secret-update` CEL rules (#112): the denial message, or undefined if allowed. */
export function tenantSecretUpdateDenial(input: {
  username: string;
  controllerNamespace: string;
  name: string;
  oldKeys?: string[];
  newKeys?: string[];
}): string | undefined {
  if (!input.username.startsWith(`system:serviceaccount:${input.controllerNamespace}:di-user-`))
    return undefined;
  if (isManagedSecretName(input.name)) return SECRET_UPDATE_MANAGED_MESSAGE;
  const kept = new Set(input.newKeys ?? []);
  if ((input.oldKeys ?? []).some((key) => !kept.has(key))) return SECRET_UPDATE_KEYS_MESSAGE;
  return undefined;
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
    tenantSecretDeletePolicy(namespace),
    tenantSecretUpdatePolicy(namespace),
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
          expression: `object.spec.type in ['keyvalue', 'messaging', 'blobstore', 'postgres', 'egress'] &&
            (!has(object.spec.className) || object.spec.className == '' ||
              object.spec.className in ['${DEFAULT_CLASS_NAMES.keyvalue}', '${DEFAULT_CLASS_NAMES.messaging}', '${DEFAULT_CLASS_NAMES.blobstore}', '${DEFAULT_CLASS_NAMES.postgres}', '${DEFAULT_CLASS_NAMES.egress}'])`,
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
          expression: `object.spec.capability in ['keyvalue', 'messaging', 'blobstore', 'postgres', 'egress'] &&
            object.spec.serviceName != '' &&
            !object.spec.serviceName.contains('/') && !object.spec.serviceName.contains('.')`,
          message:
            'ServiceBinding must reference a same-namespace BackingService with capability keyvalue, messaging, blobstore, postgres or egress',
        },
        {
          expression: `object.spec.capability != 'egress' ||
            (has(object.spec.workloadName) && object.spec.workloadName != '')`,
          message: 'An egress ServiceBinding must name its WorkloadDeployment in workloadName',
        },
      ],
    },
  ];
  return policies.flatMap((policy) => policyResources(installation, policy));
}
