import { REGISTRY_NATS_PASSWORD_FILE, REGISTRY_NATS_USER_FILE } from './registry-nats';
import {
  CAPABILITIES,
  DEFAULT_CLASS_NAMES,
  GROUP,
  INSTALLATION,
  OWNER,
  REGISTRY_WORKLOAD,
  type Resource,
  ROUTES_CONFIG_NAME,
  TENANT,
} from './resources';
import { HOST_MOUNT_ROOT } from './workload-storage';

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
 * Blobstore entry keys wash patch 0003 reads as files and sends to NATS as the user and password
 * (#159). Whoever names them chooses which host file is sent, so only the controller may set them,
 * only on the registry's entry, and only to the registry credentials mount.
 */
export const NATS_CREDENTIAL_KEYS = ['user_file', 'password_file'] as const;

function registryBlobstoreAllowed(
  hostInterface: HostInterfaceLike,
  requester?: { username: string; controllerNamespace: string; workloadNamespace?: string },
): boolean {
  const tenant = requester?.workloadNamespace
    ? tenantNameFromNamespace(requester.workloadNamespace)
    : undefined;
  const config = hostInterface.config ?? {};
  const keys = Object.keys(config);
  // Both credential files or neither, each exactly the registry credentials mount (#159).
  const credentials =
    keys.length === 2 ||
    (keys.length === 4 &&
      config.user_file === REGISTRY_NATS_USER_FILE &&
      config.password_file === REGISTRY_NATS_PASSWORD_FILE);
  return (
    requester?.username ===
      `system:serviceaccount:${requester?.controllerNamespace}:di-platform-controller` &&
    tenant !== undefined &&
    (hostInterface.configFrom ?? []).length === 0 &&
    keys.every(
      (key) =>
        key === 'backend' ||
        key === 'url' ||
        (NATS_CREDENTIAL_KEYS as readonly string[]).includes(key),
    ) &&
    credentials &&
    config.backend === 'nats' &&
    config.url === `nats://di-nats.di-runtime-${tenant}.svc.cluster.local:4222`
  );
}

/**
 * Mirrors the workload ValidatingAdmissionPolicy CEL (fail-closed).
 * Unnamed backend selection is denied except the transitional stock keyvalue path.
 */
export function hostInterfaceAllowed(
  hostInterface: HostInterfaceLike,
  requester?: { username: string; controllerNamespace: string; workloadNamespace?: string },
): boolean {
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
  // Bind-time config for the tenant registry (#83): only the platform controller may set it.
  if (packageName === 'secrets')
    return (
      requester?.username ===
        `system:serviceaccount:${requester?.controllerNamespace}:di-platform-controller` &&
      !hasName &&
      !hasReferences
    );
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
  // Tenant blobstore stays unnamed with no inline config. Without references it is wash's
  // in-memory default (#154); a created service is selected only through a controller-managed
  // di-binding-/di-bs- ConfigMap. Only the controller may set the registry's nats backend config
  // (#150), and only against the NATS in the workload's own runtime namespace.
  if (packageName === 'blobstore') {
    if (hasName || secretFrom.length > 0) return false;
    const interfaces = hostInterface.interfaces ?? [];
    if (
      !interfaces.every(
        (iface) => iface === 'blobstore' || iface === 'container' || iface === 'types',
      )
    )
      return false;
    if (configKeys.length > 0) return registryBlobstoreAllowed(hostInterface, requester);
    if (
      !configFrom.every(
        (reference) =>
          reference.name.startsWith(BINDING_CONFIG_PREFIX) ||
          reference.name.startsWith(BS_CONFIG_PREFIX),
      )
    )
      return false;
    return true;
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

/** Platform workload storage directories (#11), the only host paths a workload volume may name. */
const WORKLOAD_HOST_PATH = `^${HOST_MOUNT_ROOT}/[a-z0-9]([-a-z0-9]*[a-z0-9])?$`;
export const WORKLOAD_HOST_PATH_MESSAGE =
  'Workload host volumes may only name a platform workload storage directory';

/**
 * Mirrors the workload host path rule in the CEL policy (#159), which binds the controller too: a
 * `hostPath` volume may only name a platform storage directory under `HOST_MOUNT_ROOT`. Guests run
 * in the tenant host pod, so a volume naming any other host pod path (the registry's NATS
 * credentials mount, or a parent of it) would hand that path to a guest as a preopen.
 */
export function workloadHostPathsAllowed(volumes: VolumeLike[] | undefined): boolean {
  const pattern = new RegExp(WORKLOAD_HOST_PATH);
  return (volumes ?? []).every((volume) => {
    const hostPath = volume.hostPath as { path?: unknown } | undefined;
    return (
      hostPath === undefined || (typeof hostPath.path === 'string' && pattern.test(hostPath.path))
    );
  });
}

interface LocalResourcesLike {
  allowedHosts?: string[];
  allowedIpNameLookups?: string[];
  config?: Record<string, unknown>;
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

/**
 * `localResources.config` entry that makes a component exclusive on the patched tenant host
 * (#136): at most one store of it is ever alive, and calls queue for it instead of being served
 * from stores of their own. It rides in the existing `config` map, which the runtime operator
 * copies to the host verbatim, so the WorkloadDeployment CRD does not change. Keep in sync with
 * `EXCLUSIVE_INSTANCE_KEY` in `tenant-host/0001-exclusive-instance.patch`.
 */
export const EXCLUSIVE_INSTANCE_KEY = 'di-framework.dev/exclusive-instance';
/** The only values the exclusive entry may take. The host treats anything else as `true`. */
export const EXCLUSIVE_INSTANCE_VALUES = ['true', 'false'] as const;
export const EXCLUSIVE_INSTANCE_MESSAGE = `localResources.config['${EXCLUSIVE_INSTANCE_KEY}'] must be "true" or "false"`;
export const EXCLUSIVE_SERVICE_MESSAGE = `localResources.config['${EXCLUSIVE_INSTANCE_KEY}'] applies to components only, not to the service`;

/**
 * Mirrors the exclusive-instance rule in the CEL policy (#136). A tenant may opt its own
 * components in (it only narrows what its own workload does on its own host), but a value the
 * host would have to guess at is refused: the host fails closed to exclusive, so a typo such as
 * `"ture"` would otherwise queue every call silently.
 */
export function workloadExclusiveInstanceAllowed(
  locals: LocalResourcesLike[],
  service?: LocalResourcesLike,
): boolean {
  // The host reads the opt-in from components only; a service would silently ignore it.
  if (service?.config !== undefined && Object.hasOwn(service.config, EXCLUSIVE_INSTANCE_KEY))
    return false;
  return locals.every((local) => {
    const config = local.config;
    if (config === undefined || !Object.hasOwn(config, EXCLUSIVE_INSTANCE_KEY)) return true;
    return (EXCLUSIVE_INSTANCE_VALUES as readonly unknown[]).includes(
      config[EXCLUSIVE_INSTANCE_KEY],
    );
  });
}

/** WorkloadDeployment label naming the tenant-auth environment it was deployed to (#55). */
export const ENV_LABEL = 'platform.di-framework.dev/env';
/** Environments a WorkloadDeployment may reference tenant vars and secrets for (#88). */
export const DEPLOY_ENVS = ['prod', 'staging'] as const;
const TENANT_SECRET_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
/**
 * Suffixes of the Secrets a WorkloadDeployment may reference by its own name (#203):
 * `<workload>-control` is CLI-owned, `<workload>-secrets` is app-owned. No platform Secret in a
 * tenant namespace may end in one of these (`di-binding-`/`di-bs-` are exempt by prefix).
 * tests/environment-references.test.ts scans tenantResources/tenantAuthResources output plus
 * names from the real helpers of the other producers: postgresNames, backup-destination
 * RUNTIME_SECRET, tenant-auth di-apikey-<id> and `<name>.<env>`. A new Secret producer must be
 * added to that scan.
 *
 * Invariant: the rule that admits these names is only safe while no platform-owned Secret in a
 * tenant namespace ends in one of these suffixes (`di-binding-*` and `di-bs-*` Secrets are exempt
 * because the rule denies them by prefix). Otherwise a workload named after the Secret's stem
 * could reference it. The tests render every tenant Secret and check this.
 */
export const WORKLOAD_SECRET_SUFFIXES = ['-control', '-secrets'] as const;

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
 * env label it may reference neither. Regardless of the env label, a workload may also reference
 * exactly two Secrets named after itself: `<workload>-control`, which cli-plugin-platform renders
 * and rotates on every deploy, and `<workload>-secrets`, which the app's own tooling writes and the
 * CLI never touches (#203). No other `<workload>-*` name is allowed. Secret labels are checked by
 * the deploy lane (#87), not here.
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
  const ownSecrets = new Set(
    WORKLOAD_SECRET_SUFFIXES.map((suffix) => `${input.workloadName}${suffix}`),
  );
  const secretAllowed = (name: string) => {
    if (isManagedSecretName(name)) return false;
    if (ownSecrets.has(name)) return true;
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

  // Controller-only (#150): the registry's nats backend against its own runtime namespace's NATS,
  // anonymous or with both credential files pinned to the registry credentials mount (#159).
  const registryNats = `(variables.controller && ${noConfigReferences} &&
    object.metadata.namespace.startsWith('di-tenant-') &&
    has(h.config.backend) && has(h.config.url) &&
    h.config.backend == 'nats' &&
    h.config.url == 'nats://di-nats.di-runtime-' + object.metadata.namespace.substring(10) +
      '.svc.cluster.local:4222' &&
    (size(h.config) == 2 ||
      (size(h.config) == 4 && has(h.config.user_file) && has(h.config.password_file) &&
        h.config.user_file == '${REGISTRY_NATS_USER_FILE}' &&
        h.config.password_file == '${REGISTRY_NATS_PASSWORD_FILE}')))`;
  const blobstore = `(h['namespace'] == 'wasmcloud' && h['package'] == 'blobstore' &&
    ${unnamed} && ${noSecretReferences} &&
    (!has(h.configFrom) || size(h.configFrom) == 0 || h.configFrom.all(c, ${managedConfigName})) &&
    (!has(h.interfaces) || h.interfaces.all(i, i in ['blobstore', 'container', 'types'])) &&
    (!has(h.config) || size(h.config) == 0 || ${registryNats}))`;

  const postgres = `(h['namespace'] == 'wasmcloud' && h['package'] == 'postgres' &&
    !${hasInlineConfig} && ${noConfigReferences} && has(h.interfaces) &&
    ((${unnamed} && h.interfaces == ['types'] && ${noSecretReferences}) ||
      (${named} && ${hasSecretReferences} && size(h.secretFrom) == 1 &&
        ((h.interfaces == ['query'] && h.name.endsWith('-query') && size(h.name) > 6 &&
          h.secretFrom[0].name == '${BINDING_CONFIG_PREFIX}' + h.name.substring(0, size(h.name) - 6) + '-creds') ||
         (h.interfaces == ['prepared'] && h.name.endsWith('-prepared') && size(h.name) > 9 &&
          h.secretFrom[0].name == '${BINDING_CONFIG_PREFIX}' + h.name.substring(0, size(h.name) - 9) + '-creds')))))`;

  // Bind-time config for the tenant registry (#83): only the platform controller may set it, so a
  // tenant can neither repoint the registry's whoami URL nor read other config through it.
  const secrets = `(variables.controller && h['namespace'] == 'wasmcloud' &&
    h['package'] == 'secrets' && ${unnamed} && ${noSecretReferences} && ${noConfigReferences})`;

  return `!has(variables.w.hostInterfaces) || variables.w.hostInterfaces.all(h,
    (${wasi} || ${wasiLogging} || ${keyvalue} || ${messaging} || ${blobstore} || ${postgres} ||
      ${secrets}))`;
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
        // Everyone, the controller included (#159): only platform storage directories.
        expression: `!has(variables.w.volumes) || variables.w.volumes.all(v, !has(v.hostPath) ||
          (has(v.hostPath.path) && v.hostPath.path.matches('${WORKLOAD_HOST_PATH}')))`,
        message: WORKLOAD_HOST_PATH_MESSAGE,
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
        expression: `variables.locals.all(l, !has(l.config) ||
          !('${EXCLUSIVE_INSTANCE_KEY}' in l.config) ||
          l.config['${EXCLUSIVE_INSTANCE_KEY}'] in ${JSON.stringify(EXCLUSIVE_INSTANCE_VALUES).replaceAll('"', "'")})`,
        message: EXCLUSIVE_INSTANCE_MESSAGE,
      },
      {
        expression: `!has(variables.w.service) || !has(variables.w.service.localResources) ||
          !has(variables.w.service.localResources.config) ||
          !('${EXCLUSIVE_INSTANCE_KEY}' in variables.w.service.localResources.config)`,
        message: EXCLUSIVE_SERVICE_MESSAGE,
      },
      {
        expression: `variables.controller || variables.locals.all(l, !has(l.environment) || (
          (!has(l.environment.configFrom) || l.environment.configFrom.all(c,
            variables.env != '' && c.name == 'di-vars-' + variables.env)) &&
          (!has(l.environment.secretFrom) || l.environment.secretFrom.all(s,
            !s.name.startsWith('${BINDING_CONFIG_PREFIX}') && !s.name.startsWith('${BS_CONFIG_PREFIX}') &&
            (${WORKLOAD_SECRET_SUFFIXES.map((suffix) => `s.name == object.metadata.name + '${suffix}'`).join(' || ')} ||
              (variables.env != '' && s.name.endsWith('.' + variables.env) &&
                s.name.matches('^[a-z]([-a-z0-9]{0,61}[a-z0-9])?[.](${DEPLOY_ENVS.join('|')})$')))))))`,
        message:
          'Tenant guests may reference only di-vars-<env> and <name>.<env> Secrets matching their platform.di-framework.dev/env label (never di-binding-*/di-bs-*); a workload may also reference its own <workload>-control and <workload>-secrets Secrets',
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

/** The tenant registry WorkloadDeployment the platform controller owns in each tenant namespace (#83). */
export const REGISTRY_WORKLOAD_NAME = REGISTRY_WORKLOAD;
/** Label value marking platform-owned tenant-auth objects, including the registry workload. */
export const TENANT_AUTH_COMPONENT = 'tenant-auth';
const COMPONENT_LABEL = `${GROUP}/component`;
/** Denial for a tenant user's change to the platform-owned registry workload (#83). */
export const REGISTRY_RESERVED_MESSAGE =
  'di-tenant-registry and WorkloadDeployments labelled platform.di-framework.dev/component=tenant-auth are managed by the platform controller';
/** Denial for a tenant user's workload claiming the registry's wasi:http host (#83). */
export const REGISTRY_HOST_MESSAGE =
  "Tenant workloads cannot claim the tenant registry's wasi:http host";

/**
 * Whether a `wasi:http` `config.host` claims the registry host: compared in lower case, also with
 * a trailing dot or a port, since a Host header match ignores case and either may be normalized.
 */
export function claimsRegistryHost(host: string, registryHost: string): boolean {
  const value = host.toLowerCase();
  const label = registryHost.toLowerCase();
  return value === label || value === `${label}.` || value.startsWith(`${label}:`);
}

interface ReservedWorkloadLike {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { template?: { spec?: { hostInterfaces?: HostInterfaceLike[] } } };
}

/**
 * Mirrors the `reserved-workloads` CEL rules (#83): the denial message, or undefined if allowed.
 * The registry front sends every registry user's credentials to whatever serves the registry host
 * on the tenant's `di-http`, so a tenant user may neither change the registry workload (by name or
 * by the tenant-auth label, on the new or the old object) nor serve that host from another one.
 */
export function reservedWorkloadDenial(input: {
  username: string;
  controllerNamespace: string;
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
  registryHost: string;
  object?: ReservedWorkloadLike;
  oldObject?: ReservedWorkloadLike;
}): string | undefined {
  if (!input.username.startsWith(`system:serviceaccount:${input.controllerNamespace}:di-user-`))
    return undefined;
  const current = input.operation === 'DELETE' ? undefined : input.object;
  const old = input.operation === 'CREATE' ? undefined : input.oldObject;
  const name = (input.operation === 'DELETE' ? old : current)?.metadata?.name;
  const labelled = (value: ReservedWorkloadLike | undefined) =>
    value?.metadata?.labels?.[COMPONENT_LABEL] === TENANT_AUTH_COMPONENT;
  if (name === REGISTRY_WORKLOAD_NAME || labelled(current) || labelled(old))
    return REGISTRY_RESERVED_MESSAGE;
  const claims = (current?.spec?.template?.spec?.hostInterfaces ?? []).some(
    (h) =>
      h.namespace === 'wasi' &&
      h.package === 'http' &&
      typeof h.config?.host === 'string' &&
      claimsRegistryHost(h.config.host, input.registryHost),
  );
  return claims ? REGISTRY_HOST_MESSAGE : undefined;
}

/**
 * Reserve the tenant registry against tenant users (#83), on CREATE, UPDATE and DELETE. Only
 * `di-user-*` requests are checked, so the controller, the wasmCloud operator and every other
 * delete keep working; a tenant user's other deletes pass because only the name and the label of
 * the old object are inspected.
 */
function reservedWorkloadPolicy(namespace: string, registryHost: string): AdmissionPolicy {
  const developer = `request.userInfo.username.startsWith('system:serviceaccount:${namespace}:di-user-')`;
  const label = registryHost.toLowerCase();
  const labelled = (value: string) =>
    `(has(${value}.metadata.labels) && '${COMPONENT_LABEL}' in ${value}.metadata.labels &&
      ${value}.metadata.labels['${COMPONENT_LABEL}'] == '${TENANT_AUTH_COMPONENT}')`;
  return {
    name: 'reserved-workloads',
    apiGroups: ['runtime.wasmcloud.dev'],
    resources: ['workloaddeployments'],
    operations: ['CREATE', 'UPDATE', 'DELETE'],
    validations: [
      {
        expression: `!${developer} || !(
          (request.operation == 'DELETE' ? oldObject.metadata.name : object.metadata.name) == '${REGISTRY_WORKLOAD_NAME}' ||
          (request.operation != 'DELETE' && ${labelled('object')}) ||
          (request.operation != 'CREATE' && ${labelled('oldObject')}))`,
        message: REGISTRY_RESERVED_MESSAGE,
      },
      {
        expression: `!${developer} || request.operation == 'DELETE' ||
          !has(object.spec.template.spec.hostInterfaces) ||
          !object.spec.template.spec.hostInterfaces.exists(h,
            h['namespace'] == 'wasi' && h['package'] == 'http' &&
            has(h.config) && 'host' in h.config && (
              h.config['host'].lowerAscii() == '${label}' ||
              h.config['host'].lowerAscii() == '${label}.' ||
              h.config['host'].lowerAscii().startsWith('${label}:')))`,
        message: REGISTRY_HOST_MESSAGE,
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

/** Denial for NATS credential file keys in a controller-managed ConfigMap or Secret (#159). */
export const MANAGED_CONFIG_KEYS_MESSAGE =
  'di-bs-* and di-binding-* ConfigMaps and Secrets cannot carry user_file or password_file';

/**
 * Mirrors the `managed-config-keys` CEL rule (#159). Blobstore entries of tenant workloads read
 * their backend config from `di-bs-` / `di-binding-` ConfigMaps, so such an object must never
 * carry the NATS credential file keys, whoever writes it: only the registry's own entry, inline
 * and controller-written, may name them.
 */
export function managedConfigKeysAllowed(input: {
  name: string;
  data?: Record<string, unknown>;
  binaryData?: Record<string, unknown>;
}): boolean {
  if (!input.name.startsWith(BS_CONFIG_PREFIX) && !input.name.startsWith(BINDING_CONFIG_PREFIX))
    return true;
  const keys = [...Object.keys(input.data ?? {}), ...Object.keys(input.binaryData ?? {})];
  return !keys.some((key) => (NATS_CREDENTIAL_KEYS as readonly string[]).includes(key));
}

function managedConfigKeysPolicy(): AdmissionPolicy {
  const keys = JSON.stringify(NATS_CREDENTIAL_KEYS).replaceAll('"', "'");
  return {
    name: 'managed-config-keys',
    apiGroups: [''],
    apiVersions: ['v1'],
    resources: ['configmaps', 'secrets'],
    validations: [
      {
        expression: `!(object.metadata.name.startsWith('${BS_CONFIG_PREFIX}') ||
            object.metadata.name.startsWith('${BINDING_CONFIG_PREFIX}')) || (
          (!has(object.data) || !object.data.exists(k, k in ${keys})) &&
          (!has(object.binaryData) || !object.binaryData.exists(k, k in ${keys})))`,
        message: MANAGED_CONFIG_KEYS_MESSAGE,
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
 *
 * CRITICAL: This policy has NO `request.dryRun` exemption. The CLI (cli-extensions#70) probes it
 * with dry-run UPDATEs to prove three things without reading Secrets: that every extra key in
 * `<workload>-control` is declared, that CLI keys are present, and that the policy applies to the
 * caller. If a dryRun exemption is added, probes pass silently and undeclared keys are "kept"
 * without guard (#204). tenant-secret-update.test.ts pins this.
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

/** Denial for a tenant controller's write to a Secret that is not one of its API keys (#321). */
export const TENANT_CONTROLLER_SECRET_MESSAGE =
  'the tenant controller may only create and delete its API-key Secrets (di-apikey-<id>, labelled with its tenant)';
const TENANT_CONTROLLER_USER = /^system:serviceaccount:[^:]+:tenant-controller$/;
const API_KEY_SECRET = /^di-apikey-[0-9a-f]{16}$/;

/**
 * The tenant controller's RBAC covers every Secret in its runtime namespace, because API-key
 * Secrets have generated names that `resourceNames` cannot list (#115 S2). This limits its
 * writes there to what `tenant-auth/src/keys.ts` does: create and delete `di-apikey-<16 hex>`
 * Secrets labelled as API keys of the namespace's tenant. It can no longer replace or delete the
 * OAuth client, TLS or registry pull Secrets beside them.
 */
function tenantControllerSecretsPolicy(): AdmissionPolicy {
  // `object` on CREATE, `oldObject` on DELETE (the other one is null).
  const apiKey = (secret: string) => `(
    ${secret}.metadata.name.matches('${API_KEY_SECRET.source}') &&
    has(${secret}.metadata.labels) &&
    '${GROUP}/api-key' in ${secret}.metadata.labels &&
    ${secret}.metadata.labels['${GROUP}/api-key'] == 'true' &&
    '${TENANT}' in ${secret}.metadata.labels &&
    request.namespace == 'di-runtime-' + ${secret}.metadata.labels['${TENANT}'])`;
  return {
    name: 'tenant-controller-secrets',
    apiGroups: [''],
    apiVersions: ['v1'],
    operations: ['CREATE', 'UPDATE', 'DELETE'],
    resources: ['secrets'],
    validations: [
      {
        expression: `!request.userInfo.username.matches('${TENANT_CONTROLLER_USER.source}') ||
          (request.operation == 'CREATE' && ${apiKey('object')}) ||
          (request.operation == 'DELETE' && ${apiKey('oldObject')})`,
        message: TENANT_CONTROLLER_SECRET_MESSAGE,
      },
    ],
  };
}

/** Mirrors the `tenant-controller-secrets` CEL rule (#321). */
export function tenantControllerSecretAllowed(input: {
  username: string;
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
  namespace: string;
  name: string;
  labels?: Record<string, string>;
}): boolean {
  if (!TENANT_CONTROLLER_USER.test(input.username)) return true;
  const labels = input.labels ?? {};
  return (
    input.operation !== 'UPDATE' &&
    API_KEY_SECRET.test(input.name) &&
    labels[`${GROUP}/api-key`] === 'true' &&
    labels[TENANT] !== undefined &&
    input.namespace === `di-runtime-${labels[TENANT]}`
  );
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
export function admissionResources(
  installation: string,
  namespace: string,
  /** The registry workload's `wasi:http` host (`registryHttpHost`), reserved against tenant users. */
  registryHost = 'registry',
): Resource[] {
  const ownershipLabels = ownershipLabelsExpression(installation);
  const policies: AdmissionPolicy[] = [
    workloadPolicy(namespace),
    reservedWorkloadPolicy(namespace, registryHost),
    backendConfigPolicy(namespace),
    managedConfigKeysPolicy(),
    tenantSecretDeletePolicy(namespace),
    tenantSecretUpdatePolicy(namespace),
    tenantControllerSecretsPolicy(),
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
