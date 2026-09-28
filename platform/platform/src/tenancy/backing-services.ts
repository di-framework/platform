export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
export type BackingCapability = 'keyvalue' | 'messaging' | 'postgres';
export type BackingProvider = 'redis' | 'nats' | 'postgres';
export type ClassVisibility = 'AllTenants' | 'SelectedTenants';
export type DeletionPolicy = 'Retain' | 'Delete';
export interface Metadata {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  finalizers?: string[];
  deletionTimestamp?: string;
}
export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string;
  message: string;
  observedGeneration: number;
  lastTransitionTime: string;
}
export interface SizingParameters {
  storage?: string;
  memory?: string;
  cpu?: string;
}
export interface BackingServiceClassSpec {
  type: BackingCapability;
  provider: BackingProvider;
  parametersSchema?: {
    storage?: { min?: string; max?: string };
    memory?: { min?: string; max?: string };
    cpu?: { min?: string; max?: string };
  };
  defaults?: SizingParameters;
  storageClassName?: string;
  visibility: ClassVisibility;
  allowedTenants?: string[];
  default?: boolean;
}
export interface BackingServiceSpec {
  type: BackingCapability;
  className?: string;
  parameters?: SizingParameters;
  deletionPolicy?: DeletionPolicy;
}
export interface ServiceBindingSpec {
  serviceName: string;
  bindingName: string;
  capability: BackingCapability;
  workloadName?: string;
}
export interface EndpointSummary {
  host: string;
  port: number;
  capability: BackingCapability;
}
export interface BackingServiceClassStatus {
  conditions?: Condition[];
  observedGeneration?: number;
}
export interface BackingServiceStatus {
  conditions?: Condition[];
  observedGeneration?: number;
  classRef?: { name: string; uid?: string; generation?: number };
  endpoint?: EndpointSummary;
  runtimeNamespace?: string;
}
export interface ServiceBindingStatus {
  conditions?: Condition[];
  observedGeneration?: number;
  serviceRef?: { name: string; uid?: string; generation?: number };
}
export interface BackingServiceClass {
  apiVersion: string;
  kind: 'BackingServiceClass';
  metadata: Metadata;
  spec: BackingServiceClassSpec;
  status?: BackingServiceClassStatus;
}
export interface BackingService {
  apiVersion: string;
  kind: 'BackingService';
  metadata: Metadata;
  spec: BackingServiceSpec;
  status?: BackingServiceStatus;
}
export interface ServiceBinding {
  apiVersion: string;
  kind: 'ServiceBinding';
  metadata: Metadata;
  spec: ServiceBindingSpec;
  status?: ServiceBindingStatus;
}

const GROUP = 'platform.di-framework.dev';
const VERSION = `${GROUP}/v1alpha1`;
const CLASS = `${GROUP}/class`;
const SERVICE = `${GROUP}/service`;
const BINDING = `${GROUP}/binding`;
const CAPABILITIES = ['keyvalue', 'messaging', 'postgres'] as const;
const PROVIDERS = ['redis', 'nats', 'postgres'] as const;
const DEFAULT_CLASS_NAMES = {
  keyvalue: 'keyvalue-redis',
  messaging: 'messaging-nats',
  postgres: 'postgres-dedicated',
} as const;
const COMPATIBLE: Record<BackingCapability, BackingProvider> = {
  keyvalue: 'redis',
  messaging: 'nats',
  postgres: 'postgres',
};
const CREDENTIAL_STATUS_KEYS = [
  'password',
  'secret',
  'token',
  'credential',
  'credentials',
  'url',
  'connectionString',
  'redisPassword',
  'natsCreds',
  'username',
  'auth',
] as const;
const nameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 40,
  pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
};
const bindingNameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
};
const quantity = { type: 'string', minLength: 1, pattern: '^[0-9]+(\\.[0-9]+)?(m|Ki|Mi|Gi|Ti)?$' };
const sizingProperties = {
  storage: quantity,
  memory: quantity,
  cpu: quantity,
};
const sizingObject = {
  type: 'object',

  properties: sizingProperties,
};
const parameterBound = {
  type: 'object',

  properties: { min: quantity, max: quantity },
};
const conditions = {
  type: 'array',
  'x-kubernetes-list-type': 'map',
  'x-kubernetes-list-map-keys': ['type'],
  items: {
    type: 'object',
    required: ['type', 'status', 'reason', 'message', 'lastTransitionTime', 'observedGeneration'],
    properties: {
      type: { type: 'string' },
      status: { type: 'string', enum: ['True', 'False', 'Unknown'] },
      reason: { type: 'string' },
      message: { type: 'string' },
      lastTransitionTime: { type: 'string', format: 'date-time' },
      observedGeneration: { type: 'integer', format: 'int64' },
    },
  },
};

function crd(
  kind: string,
  plural: string,
  scope: 'Cluster' | 'Namespaced',
  spec: Json,
  status: Record<string, Json>,
  validations?: { rule: string; message: string }[],
) {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: `${plural}.${GROUP}` },
    spec: {
      group: GROUP,
      scope,
      names: { kind, plural, singular: kind.toLowerCase() },
      versions: [
        {
          name: 'v1alpha1',
          served: true,
          storage: true,
          subresources: { status: {} },
          additionalPrinterColumns: [
            {
              name: 'Ready',
              type: 'string',
              jsonPath: '.status.conditions[?(@.type=="Ready")].status',
            },
            { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
          ],
          schema: {
            openAPIV3Schema: {
              type: 'object',
              required: ['spec'],
              properties: {
                apiVersion: { type: 'string' },
                kind: { type: 'string' },
                metadata: { type: 'object', properties: { name: nameSchema } },
                spec,
                status: {
                  type: 'object',
                  properties: {
                    conditions,
                    observedGeneration: { type: 'integer', format: 'int64' },
                    ...status,
                  },
                },
              },
              ...(validations && validations.length > 0
                ? { 'x-kubernetes-validations': validations }
                : {}),
            },
          },
        },
      ],
    },
  };
}

const classSpec = {
  type: 'object',
  required: ['type', 'provider', 'visibility'],
  'x-kubernetes-validations': [
    {
      rule: 'self.type == oldSelf.type',
      message: 'spec.type is immutable',
    },
    {
      rule: 'self.provider == oldSelf.provider',
      message: 'spec.provider is immutable',
    },
    {
      rule: `(self.type == 'keyvalue' && self.provider == 'redis') || (self.type == 'messaging' && self.provider == 'nats') || (self.type == 'postgres' && self.provider == 'postgres')`,
      message: 'provider must match type (keyvalue+redis, messaging+nats or postgres+postgres)',
    },
    {
      rule: `self.visibility != 'SelectedTenants' || (has(self.allowedTenants) && size(self.allowedTenants) > 0)`,
      message: 'allowedTenants is required when visibility is SelectedTenants',
    },
  ],
  properties: {
    type: { type: 'string', enum: [...CAPABILITIES] },
    provider: { type: 'string', enum: [...PROVIDERS] },
    parametersSchema: {
      type: 'object',

      properties: {
        storage: parameterBound,
        memory: parameterBound,
        cpu: parameterBound,
      },
    },
    defaults: sizingObject,
    storageClassName: { type: 'string', maxLength: 253 },
    visibility: { type: 'string', enum: ['AllTenants', 'SelectedTenants'] },
    allowedTenants: {
      type: 'array',
      items: nameSchema,
      'x-kubernetes-list-type': 'set',
    },
    default: { type: 'boolean', default: false },
  },
};

const serviceSpec = {
  type: 'object',
  required: ['type'],
  'x-kubernetes-validations': [
    {
      rule: 'self.type == oldSelf.type',
      message: 'spec.type is immutable',
    },
    {
      rule: `!has(oldSelf.className) || oldSelf.className == '' || self.className == oldSelf.className`,
      message: 'spec.className is immutable once set',
    },
  ],
  properties: {
    type: { type: 'string', enum: [...CAPABILITIES] },
    className: { ...nameSchema },
    parameters: sizingObject,
    deletionPolicy: { type: 'string', enum: ['Retain', 'Delete'], default: 'Retain' },
  },
};

const bindingSpec = {
  type: 'object',
  required: ['serviceName', 'bindingName', 'capability'],
  properties: {
    serviceName: nameSchema,
    bindingName: bindingNameSchema,
    capability: { type: 'string', enum: [...CAPABILITIES] },
    workloadName: { ...bindingNameSchema },
  },
};

const backingServiceCrds = [
  crd('BackingServiceClass', 'backingserviceclasses', 'Cluster', classSpec, {}, [
    {
      rule: 'self.metadata.name.size() <= 40',
      message: 'name must be at most 40 characters',
    },
  ]),
  crd('BackingService', 'backingservices', 'Namespaced', serviceSpec, {
    classRef: {
      type: 'object',

      properties: {
        name: { type: 'string' },
        uid: { type: 'string' },
        generation: { type: 'integer', format: 'int64' },
      },
    },
    endpoint: {
      type: 'object',

      required: ['host', 'port', 'capability'],
      properties: {
        host: { type: 'string', minLength: 1 },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        capability: { type: 'string', enum: [...CAPABILITIES] },
      },
    },
    runtimeNamespace: { type: 'string' },
  }),
  crd(
    'ServiceBinding',
    'servicebindings',
    'Namespaced',
    bindingSpec,
    {
      serviceRef: {
        type: 'object',

        properties: {
          name: { type: 'string' },
          uid: { type: 'string' },
          generation: { type: 'integer', format: 'int64' },
        },
      },
    },
    [
      {
        rule: 'self.spec.serviceName != ""',
        message: 'serviceName must reference a BackingService in the same namespace',
      },
    ],
  ),
];

function defaultClassName(type: BackingCapability): string {
  return DEFAULT_CLASS_NAMES[type];
}

function compatibleProvider(type: BackingCapability, provider: BackingProvider): boolean {
  return COMPATIBLE[type] === provider;
}

function validDnsLabel(name: unknown, max = 40): boolean {
  return (
    typeof name === 'string' &&
    name.length >= 1 &&
    name.length <= max &&
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)
  );
}

function validateSizing(parameters: SizingParameters | undefined): string | undefined {
  if (!parameters) return undefined;
  for (const [key, value] of Object.entries(parameters)) {
    if (!['storage', 'memory', 'cpu'].includes(key))
      return `parameters.${key} is not an allowed sizing field`;
    if (typeof value !== 'string' || !/^[0-9]+(\.[0-9]+)?(m|Ki|Mi|Gi|Ti)?$/.test(value))
      return `parameters.${key} must be a Kubernetes quantity`;
  }
  return undefined;
}

function validateClassSpec(spec: BackingServiceClassSpec): string | undefined {
  if (!CAPABILITIES.includes(spec.type)) return 'type must be keyvalue, messaging or postgres';
  if (!PROVIDERS.includes(spec.provider)) return 'provider must be redis, nats or postgres';
  if (!compatibleProvider(spec.type, spec.provider))
    return 'provider must match type (keyvalue+redis, messaging+nats or postgres+postgres)';
  if (spec.visibility !== 'AllTenants' && spec.visibility !== 'SelectedTenants')
    return 'visibility must be AllTenants or SelectedTenants';
  if (spec.visibility === 'SelectedTenants') {
    if (!spec.allowedTenants?.length) return 'allowedTenants is required when SelectedTenants';
    if (spec.allowedTenants.some((name) => !validDnsLabel(name)))
      return 'allowedTenants must be valid tenant names';
  }
  const sizing = validateSizing(spec.defaults);
  if (sizing) return sizing;
  if (spec.parametersSchema) {
    for (const key of Object.keys(spec.parametersSchema)) {
      if (!['storage', 'memory', 'cpu'].includes(key))
        return `parametersSchema.${key} is not an allowed sizing field`;
    }
  }
  return undefined;
}

function validateServiceSpec(spec: BackingServiceSpec): string | undefined {
  if (!CAPABILITIES.includes(spec.type)) return 'type must be keyvalue, messaging or postgres';
  if (spec.className !== undefined && spec.className !== '' && !validDnsLabel(spec.className))
    return 'className must be a valid DNS label';
  if (
    spec.deletionPolicy !== undefined &&
    spec.deletionPolicy !== 'Retain' &&
    spec.deletionPolicy !== 'Delete'
  )
    return 'deletionPolicy must be Retain or Delete';
  return validateSizing(spec.parameters);
}

function validateBindingSpec(spec: ServiceBindingSpec): string | undefined {
  if (!validDnsLabel(spec.serviceName)) return 'serviceName must be a valid DNS label';
  if (!validDnsLabel(spec.bindingName, 63)) return 'bindingName must be a valid DNS label';
  if (!CAPABILITIES.includes(spec.capability))
    return 'capability must be keyvalue, messaging or postgres';
  if (spec.workloadName !== undefined && !validDnsLabel(spec.workloadName, 63))
    return 'workloadName must be a valid DNS label';
  return undefined;
}

function bindingMatchesService(
  binding: Pick<ServiceBindingSpec, 'capability' | 'serviceName'>,
  service: Pick<BackingServiceSpec, 'type'> & { metadata?: { name?: string } },
): boolean {
  return (
    binding.capability === service.type &&
    (service.metadata?.name === undefined || service.metadata.name === binding.serviceName)
  );
}

function classVisibleToTenant(cls: BackingServiceClassSpec, tenant: string): boolean {
  if (cls.visibility === 'AllTenants') return true;
  return !!cls.allowedTenants?.includes(tenant);
}

function assertUniqueDefaults(classes: BackingServiceClassSpec[]): string | undefined {
  for (const type of CAPABILITIES) {
    if (classes.filter((c) => c.type === type && c.default).length > 1)
      return `at most one default BackingServiceClass is allowed per type (${type})`;
  }
  return undefined;
}

function resolveClassName(spec: BackingServiceSpec): string {
  return spec.className && spec.className.length > 0 ? spec.className : defaultClassName(spec.type);
}

function statusContainsCredentials(status: Record<string, unknown> | undefined): boolean {
  if (!status) return false;
  const walk = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(walk);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((CREDENTIAL_STATUS_KEYS as readonly string[]).includes(key)) return true;
      if (walk(child)) return true;
    }
    return false;
  };
  return walk(status);
}

function defaultClassSeed(type: BackingCapability): BackingServiceClassSpec {
  return {
    type,
    provider: COMPATIBLE[type],
    visibility: 'AllTenants',
    default: true,
    defaults:
      type === 'postgres'
        ? { storage: '1Gi', memory: '512Mi', cpu: '250m' }
        : type === 'keyvalue'
          ? { storage: '1Gi', memory: '128Mi', cpu: '250m' }
          : { storage: '1Gi', memory: '128Mi', cpu: '250m' },
    parametersSchema: {
      storage: { min: '256Mi', max: '20Gi' },
      memory: { min: '64Mi', max: '2Gi' },
      cpu: { min: '50m', max: '2' },
    },
  };
}

export {
  assertUniqueDefaults,
  BINDING,
  backingServiceCrds,
  bindingMatchesService,
  CAPABILITIES,
  CLASS,
  COMPATIBLE,
  CREDENTIAL_STATUS_KEYS,
  classVisibleToTenant,
  compatibleProvider,
  DEFAULT_CLASS_NAMES,
  defaultClassName,
  defaultClassSeed,
  GROUP,
  PROVIDERS,
  resolveClassName,
  SERVICE,
  statusContainsCredentials,
  VERSION,
  validateBindingSpec,
  validateClassSpec,
  validateServiceSpec,
};
