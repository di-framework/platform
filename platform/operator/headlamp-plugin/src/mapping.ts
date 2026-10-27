/**
 * The create/edit form's mapping to a PlatformInstance object. Pure: no Headlamp or React imports,
 * so the unit tests can prove that the form produces exactly the object a YAML manifest holds
 * (epic #275, gate 2).
 *
 * The rule: a field the user left empty is left out of the object, so the API server applies the
 * CRD defaults exactly as it does for a manifest that leaves the field out.
 */

import {
  API_VERSION,
  type DeletionPolicy,
  KIND,
  MAX_MEMBERSHIPS,
  MAX_NAME_LENGTH,
  MAX_TENANTS,
  MAX_USERS,
  type MembershipRole,
  type NetworkPolicyEngine,
  PLURAL,
  type PlatformInstanceObject,
  type PlatformInstanceSpec,
  type PlatformSettings,
  type PullPolicy,
  type TargetType,
  type TenantAuthSettings,
} from './types';

/** A tenants[] row: the name the form edits, and the entry's other fields, kept as they are. */
export interface TenantRow {
  name: string;
  rest: Record<string, unknown>;
}

export interface MembershipRow {
  tenant: string;
  role: MembershipRole;
}

/** A users[] row: name and memberships, and the entry's other fields (suspended) kept as they are. */
export interface UserRow {
  name: string;
  memberships: MembershipRow[];
  rest: Record<string, unknown>;
}

/** Every text field is the text the user typed; an empty string means "not set". */
export interface PlatformInstanceForm {
  name: string;
  namespace: string;
  version: string;
  targetType: TargetType;
  networkPolicyEngine: NetworkPolicyEngine | '';
  storageRoot: string;
  httpNodePort: string;
  httpEndpoint: string;
  deletionPolicy: DeletionPolicy | '';
  tenants: TenantRow[];
  users: UserRow[];
  tenantAuthIssuer: string;
  tenantAuthClientId: string;
  /** clientSecretRef: the Secret (in the instance's namespace) and its key, never the value. */
  tenantAuthSecretName: string;
  tenantAuthSecretKey: string;
  tenantAuthImage: string;
  tenantAuthIssuerIp: string;
  tenantAuthIssuerUpstream: string;
  tenantAuthIssuerUpstreamPodPort: string;
  tenantAuthConsolePublicUrl: string;
  tenantAuthControllerPublicUrl: string;
  tenantAuthRegistryComponent: string;
  tenantAuthRegistryPublicUrl: string;
  tenantAuthRegistryMaxBodyBytes: string;
  tenantAuthRegistryMaxConcurrent: string;
  tenantAuthRegistryUploadIdleTimeoutMs: string;
  tenantAuthRegistryUpstreamTimeoutMs: string;
  tenantHostImage: string;
  tenantHostImagePullPolicy: PullPolicy | '';
}

export type FormField = keyof PlatformInstanceForm;
/** The fields holding one value (every field but the tenants and users lists). */
export type TextFormField = {
  [K in FormField]: PlatformInstanceForm[K] extends string ? K : never;
}[FormField];
/** The tenantAuth fields, all plain text. */
export type TenantAuthField = Extract<TextFormField, `tenantAuth${string}`>;
export type FormMode = 'create' | 'edit';
/**
 * Errors by field, and for the lists by row: `tenants` (the list), `tenants.<i>.name`, `users`,
 * `users.<i>.name`, `users.<i>.memberships` and `users.<i>.memberships.<j>.tenant`.
 */
export type FormErrors = Partial<Record<string, string>>;

/**
 * The tenantAuth fields: the form field, its path under spec.platform.tenantAuth, and whether it
 * is a number. In the order of the form and of the patch.
 */
export const TENANT_AUTH_FIELDS: readonly {
  field: TenantAuthField;
  path: readonly string[];
  number?: true;
}[] = [
  { field: 'tenantAuthIssuer', path: ['issuer'] },
  { field: 'tenantAuthClientId', path: ['clientId'] },
  { field: 'tenantAuthSecretName', path: ['clientSecretRef', 'name'] },
  { field: 'tenantAuthSecretKey', path: ['clientSecretRef', 'key'] },
  { field: 'tenantAuthImage', path: ['image'] },
  { field: 'tenantAuthIssuerIp', path: ['issuerIp'] },
  { field: 'tenantAuthIssuerUpstream', path: ['issuerUpstream'] },
  { field: 'tenantAuthIssuerUpstreamPodPort', path: ['issuerUpstreamPodPort'], number: true },
  { field: 'tenantAuthConsolePublicUrl', path: ['consolePublicUrl'] },
  { field: 'tenantAuthControllerPublicUrl', path: ['controllerPublicUrl'] },
  { field: 'tenantAuthRegistryComponent', path: ['registry', 'component'] },
  { field: 'tenantAuthRegistryPublicUrl', path: ['registry', 'publicUrl'] },
  {
    field: 'tenantAuthRegistryMaxBodyBytes',
    path: ['registry', 'limits', 'maxBodyBytes'],
    number: true,
  },
  {
    field: 'tenantAuthRegistryMaxConcurrent',
    path: ['registry', 'limits', 'maxConcurrent'],
    number: true,
  },
  {
    field: 'tenantAuthRegistryUploadIdleTimeoutMs',
    path: ['registry', 'limits', 'uploadIdleTimeoutMs'],
    number: true,
  },
  {
    field: 'tenantAuthRegistryUpstreamTimeoutMs',
    path: ['registry', 'limits', 'upstreamTimeoutMs'],
    number: true,
  },
];

/**
 * Fields that can't change after creation: the object's identity, and the two the CRD's CEL rules
 * make immutable (`target is immutable`, `platform.storageRoot is immutable`).
 */
export const IMMUTABLE_ON_EDIT: readonly FormField[] = [
  'name',
  'namespace',
  'targetType',
  'storageRoot',
];

export function isDisabled(field: FormField, mode: FormMode): boolean {
  return mode === 'edit' && IMMUTABLE_ON_EDIT.includes(field);
}

export function emptyForm(namespace = ''): PlatformInstanceForm {
  const form: PlatformInstanceForm = {
    name: '',
    namespace,
    version: '',
    targetType: 'vcluster',
    networkPolicyEngine: '',
    storageRoot: '',
    httpNodePort: '',
    httpEndpoint: '',
    deletionPolicy: '',
    tenants: [],
    users: [],
    tenantAuthIssuer: '',
    tenantAuthClientId: '',
    tenantAuthSecretName: '',
    tenantAuthSecretKey: '',
    tenantAuthImage: '',
    tenantAuthIssuerIp: '',
    tenantAuthIssuerUpstream: '',
    tenantAuthIssuerUpstreamPodPort: '',
    tenantAuthConsolePublicUrl: '',
    tenantAuthControllerPublicUrl: '',
    tenantAuthRegistryComponent: '',
    tenantAuthRegistryPublicUrl: '',
    tenantAuthRegistryMaxBodyBytes: '',
    tenantAuthRegistryMaxConcurrent: '',
    tenantAuthRegistryUploadIdleTimeoutMs: '',
    tenantAuthRegistryUpstreamTimeoutMs: '',
    tenantHostImage: '',
    tenantHostImagePullPolicy: '',
  };
  return form;
}

/** The form for editing an existing object: every field shows what the object holds. */
export function formFromObject(obj: PlatformInstanceObject): PlatformInstanceForm {
  const platform = obj.spec?.platform ?? {};
  const gateway = platform.gateway ?? {};
  const form: PlatformInstanceForm = {
    ...emptyForm(),
    name: obj.metadata.name,
    namespace: obj.metadata.namespace ?? '',
    version: obj.spec?.version ?? '',
    targetType: obj.spec?.target?.type ?? 'vcluster',
    networkPolicyEngine: platform.networkPolicyEngine ?? '',
    storageRoot: platform.storageRoot ?? '',
    httpNodePort: gateway.httpNodePort === undefined ? '' : String(gateway.httpNodePort),
    httpEndpoint: gateway.httpEndpoint ?? '',
    deletionPolicy: obj.spec?.deletionPolicy ?? '',
    tenants: (platform.tenants ?? []).map(({ name, ...rest }) => ({ name, rest })),
    users: (platform.users ?? []).map(({ name, memberships, ...rest }) => ({
      name,
      memberships: memberships.map(({ tenant, role }) => ({ tenant, role })),
      rest,
    })),
    tenantHostImage: platform.tenantHostImage ?? '',
    tenantHostImagePullPolicy: platform.tenantHostImagePullPolicy ?? '',
  };
  for (const { field, path } of TENANT_AUTH_FIELDS) {
    const value = at(platform.tenantAuth, path);
    form[field] = value === undefined ? '' : String(value);
  }
  return form;
}

/** spec.platform.tenantAuth as the form describes it, or undefined when every field is empty. */
function tenantAuthFromForm(form: PlatformInstanceForm): TenantAuthSettings | undefined {
  const auth: Tree = {};
  for (const { field, path, number } of TENANT_AUTH_FIELDS) {
    const value = form[field].trim();
    if (value) {
      let node = auth;
      for (const key of path.slice(0, -1)) {
        node[key] ??= {};
        node = node[key] as Tree;
      }
      node[path.at(-1) as string] = number ? Number(value) : value;
    }
  }
  return Object.keys(auth).length > 0 ? (auth as TenantAuthSettings) : undefined;
}

/** The spec the form describes, holding only the fields the user filled in. */
export function specFromForm(form: PlatformInstanceForm): PlatformInstanceSpec {
  const spec: PlatformInstanceSpec = {
    version: form.version.trim(),
    target: { type: form.targetType },
  };

  const platform: PlatformSettings = {};
  if (form.networkPolicyEngine) {
    platform.networkPolicyEngine = form.networkPolicyEngine;
  }
  const storageRoot = form.storageRoot.trim();
  if (storageRoot) {
    platform.storageRoot = storageRoot;
  }
  const nodePort = form.httpNodePort.trim();
  const endpoint = form.httpEndpoint.trim();
  if (nodePort || endpoint) {
    platform.gateway = {};
    if (nodePort) {
      platform.gateway.httpNodePort = Number(nodePort);
    }
    if (endpoint) {
      platform.gateway.httpEndpoint = endpoint;
    }
  }
  if (form.tenants.length > 0) {
    platform.tenants = form.tenants.map((t) => ({ ...t.rest, name: t.name.trim() }));
  }
  if (form.users.length > 0) {
    platform.users = form.users.map((u) => ({
      ...u.rest,
      name: u.name.trim(),
      memberships: u.memberships.map((m) => ({ tenant: m.tenant, role: m.role })),
    }));
  }
  const tenantAuth = tenantAuthFromForm(form);
  if (tenantAuth) {
    platform.tenantAuth = tenantAuth;
  }
  const hostImage = form.tenantHostImage.trim();
  if (hostImage) {
    platform.tenantHostImage = hostImage;
  }
  if (form.tenantHostImagePullPolicy) {
    platform.tenantHostImagePullPolicy = form.tenantHostImagePullPolicy;
  }
  if (Object.keys(platform).length > 0) {
    spec.platform = platform;
  }

  if (form.deletionPolicy) {
    spec.deletionPolicy = form.deletionPolicy;
  }
  return spec;
}

/** The manifest the create form describes: exactly what a user would `kubectl apply`. */
export function buildPlatformInstance(form: PlatformInstanceForm): PlatformInstanceObject {
  return {
    apiVersion: API_VERSION,
    kind: KIND,
    metadata: { name: form.name.trim(), namespace: form.namespace.trim() },
    spec: specFromForm(form),
  };
}

/** One RFC 6902 JSON Patch operation, as the plugin sends them. */
export type JsonPatchOp =
  | { op: 'test' | 'add' | 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

/** The spec paths the form owns. Every other spec field, and all metadata, is left alone. */
const FORM_PATHS: readonly (readonly string[])[] = [
  ['version'],
  ['target', 'type'],
  ['platform', 'networkPolicyEngine'],
  ['platform', 'storageRoot'],
  ['platform', 'gateway', 'httpNodePort'],
  ['platform', 'gateway', 'httpEndpoint'],
  // The lists are patched whole: a row's index is no stable identity (rows are added and
  // removed), and the `test` of the old list fails the patch if someone changed it meanwhile.
  ['platform', 'tenants'],
  ['platform', 'users'],
  ...TENANT_AUTH_FIELDS.map(({ path }) => ['platform', 'tenantAuth', ...path]),
  ['platform', 'tenantHostImage'],
  ['platform', 'tenantHostImagePullPolicy'],
  ['deletionPolicy'],
];

type Tree = Record<string, unknown>;

function at(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') {
      return undefined;
    }
    node = (node as Tree)[key];
  }
  return node;
}

/** Deep equality of JSON values, ignoring the order of object keys. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortedKeys((value as Tree)[k])]),
    );
  }
  return value;
}

function pointer(path: readonly string[]): string {
  return `/spec/${path.map((k) => k.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

/** The container at `path` in `root`; every container on the way exists. */
const container = (root: Tree, path: readonly string[]) => at(root, path) as Tree;

/**
 * Removes the field at `path` from `work` and returns the ops that do the same on the server:
 * the `remove`, then a `test` that each container the removal emptied is `{}` and its `remove`,
 * innermost first. The `test` fails if someone added to the container meanwhile.
 */
function removeOps(work: Tree, path: readonly string[]): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [{ op: 'remove', path: pointer(path) }];
  delete container(work, path.slice(0, -1))[path.at(-1) as string];
  for (let depth = path.length - 1; depth > 0; depth--) {
    const parent = path.slice(0, depth);
    if (Object.keys(container(work, parent)).length > 0) {
      break;
    }
    ops.push(
      { op: 'test', path: pointer(parent), value: {} },
      { op: 'remove', path: pointer(parent) },
    );
    delete container(work, parent.slice(0, -1))[parent[depth - 1] as string];
  }
  return ops;
}

/**
 * Sets the field at `path` in `work` to `value` and returns the ops that do the same on the
 * server: an `add` of each missing container, then a `replace` of an existing field or an `add`
 * of a missing one.
 */
function setOps(work: Tree, path: readonly string[], value: unknown): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  for (let depth = 1; depth < path.length; depth++) {
    const parent = path.slice(0, depth);
    if (at(work, parent) === undefined) {
      ops.push({ op: 'add', path: pointer(parent), value: {} });
      container(work, parent.slice(0, -1))[parent[depth - 1] as string] = {};
    }
  }
  const leaf = path.at(-1) as string;
  const parent = container(work, path.slice(0, -1));
  ops.push({ op: leaf in parent ? 'replace' : 'add', path: pointer(path), value });
  parent[leaf] = value;
  return ops;
}

/**
 * The edit as a JSON Patch against `original`, the object as it was when the dialog opened.
 *
 * - It touches only the form-owned spec paths that changed: `replace` (or `add`, creating
 *   `platform`/`gateway`/`tenantAuth`/... when missing) or `remove`, dropping a container the
 *   removal left empty. Spec fields the form doesn't know, labels, annotations and the rest of the
 *   metadata are never in the patch, so the server keeps them.
 * - Every changed field that existed is guarded by a `test` of its old value, and every emptied
 *   container by a `test` that it is still `{}` before its `remove`, so a concurrent change to
 *   them fails the whole patch instead of being overwritten.
 * - JSON Patch can't test that a member is absent, so an `add` of a missing key (a container or a
 *   field) is guarded by a `test` of `metadata.resourceVersion` instead. Only such a patch fails on
 *   an unrelated write, such as the operator's status updates.
 */
export function editPatch(
  original: PlatformInstanceObject,
  form: PlatformInstanceForm,
): JsonPatchOp[] {
  const before: Tree = (original.spec ?? {}) as unknown as Tree;
  const after = specFromForm(form);
  const work = structuredClone(before);
  const tests: JsonPatchOp[] = [];
  const changes: JsonPatchOp[] = [];
  if (original.spec === undefined) {
    changes.push({ op: 'add', path: '/spec', value: {} });
  }

  for (const path of FORM_PATHS) {
    const oldValue = at(before, path);
    const newValue = at(after, path);
    if (same(oldValue, newValue)) {
      continue;
    }
    if (oldValue !== undefined) {
      tests.push({ op: 'test', path: pointer(path), value: oldValue });
    }
    changes.push(
      ...(newValue === undefined ? removeOps(work, path) : setOps(work, path, newValue)),
    );
  }

  const adds = changes.some((op) => op.op === 'add');
  const resourceVersion = original.metadata.resourceVersion;
  const guard: JsonPatchOp[] =
    adds && resourceVersion !== undefined
      ? [{ op: 'test', path: '/metadata/resourceVersion', value: resourceVersion }]
      : [];
  return [...guard, ...tests, ...changes];
}

// The apiserver's DNS-1123 subdomain (object names) and label (namespaces) rules.
const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
// The CRD's patterns for spec.version and spec.platform.gateway.httpEndpoint.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ENDPOINT_PATTERN = /^https?:\/\//;
const MAX_NODE_PORT = 32767;
// The CRD's patterns and lengths for the tenancy settings (#442).
const TENANCY_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_TENANCY_NAME = 40;
const DIGEST_IMAGE_PATTERN = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const HOST_IMAGE_PATTERN = /^[^\s@]+(@sha256:[0-9a-f]{64})?$/;
const MAX_URL = 2048;
const MAX_IMAGE = 512;
const MAX_ID = 253;
const MAX_IPV4 = 15;
const MAX_PORT = 65535;

/** A tenant or user name's error, or undefined when the CRD accepts it. */
function tenancyNameError(what: string, name: string): string | undefined {
  if (!name) {
    return `${what} name is required.`;
  }
  if (name.length > MAX_TENANCY_NAME) {
    return `${what} name must be at most ${MAX_TENANCY_NAME} characters.`;
  }
  if (!TENANCY_NAME_PATTERN.test(name)) {
    return `${what} name must be lowercase letters, digits and "-", start with a letter and not end with "-".`;
  }
  return undefined;
}

function wholeNumberError(label: string, value: string, min: number, max?: number) {
  const n = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(n) ||
    n < min ||
    (max !== undefined && n > max)
  ) {
    return max === undefined
      ? `${label} must be a whole number of at least ${min}.`
      : `${label} must be a whole number from ${min} to ${max}.`;
  }
  return undefined;
}

/** The tenants and users checks: the CRD's patterns and limits, and its memberships CEL rule. */
function validateTenantsAndUsers(form: PlatformInstanceForm, errors: FormErrors) {
  if (form.tenants.length > MAX_TENANTS) {
    errors.tenants = `At most ${MAX_TENANTS} tenants.`;
  }
  const tenantNames = new Set<string>();
  form.tenants.forEach((t, i) => {
    const name = t.name.trim();
    const error =
      tenancyNameError('Tenant', name) ??
      (tenantNames.has(name) ? `Tenant "${name}" is listed twice.` : undefined);
    if (error) {
      errors[`tenants.${i}.name`] = error;
    }
    tenantNames.add(name);
  });

  if (form.users.length > MAX_USERS) {
    errors.users = `At most ${MAX_USERS} users.`;
  }
  const userNames = new Set<string>();
  form.users.forEach((u, i) => {
    const name = u.name.trim();
    const error =
      tenancyNameError('User', name) ??
      (userNames.has(name) ? `User "${name}" is listed twice.` : undefined);
    if (error) {
      errors[`users.${i}.name`] = error;
    }
    userNames.add(name);
    if (u.memberships.length > MAX_MEMBERSHIPS) {
      errors[`users.${i}.memberships`] = `At most ${MAX_MEMBERSHIPS} memberships per user.`;
    }
    const seen = new Set<string>();
    u.memberships.forEach((m, j) => {
      const key = `users.${i}.memberships.${j}.tenant`;
      if (!m.tenant) {
        errors[key] = 'Choose a tenant.';
      } else if (!tenantNames.has(m.tenant)) {
        // The CRD's CEL rule: every users[].memberships[].tenant must name an entry of tenants.
        errors[key] = `"${m.tenant}" is not in Tenants: every membership must name a tenant.`;
      } else if (seen.has(m.tenant)) {
        errors[key] = `"${m.tenant}" is listed twice: one membership per tenant.`;
      }
      seen.add(m.tenant);
    });
  });
}

/** The tenantAuth and host image checks: the CRD's patterns, lengths, required and CEL rule. */
function validateTenantAuth(form: PlatformInstanceForm, errors: FormErrors) {
  const value = (field: TextFormField) => form[field].trim();
  if (TENANT_AUTH_FIELDS.some(({ field }) => value(field))) {
    // The CRD's CEL rule (issuer, clientId and clientSecretRef together) and its required image.
    const together = 'Tenant auth needs issuer, client ID and client secret together.';
    for (const field of [
      'tenantAuthIssuer',
      'tenantAuthClientId',
      'tenantAuthSecretName',
      'tenantAuthSecretKey',
    ] as const) {
      if (!value(field)) {
        errors[field] = together;
      }
    }
    if (!value('tenantAuthImage')) {
      errors.tenantAuthImage = 'Tenant auth needs the tenant-auth image.';
    }
  }
  for (const field of [
    'tenantAuthIssuer',
    'tenantAuthConsolePublicUrl',
    'tenantAuthControllerPublicUrl',
    'tenantAuthRegistryPublicUrl',
  ] as const) {
    const url = value(field);
    if (url && (!ENDPOINT_PATTERN.test(url) || url.length > MAX_URL)) {
      errors[field] = `Must start with http:// or https:// and be at most ${MAX_URL} characters.`;
    }
  }
  for (const field of [
    'tenantAuthClientId',
    'tenantAuthSecretName',
    'tenantAuthSecretKey',
  ] as const) {
    if (value(field).length > MAX_ID) {
      errors[field] = `Must be at most ${MAX_ID} characters.`;
    }
  }
  for (const field of ['tenantAuthImage', 'tenantAuthRegistryComponent'] as const) {
    const image = value(field);
    if (image && (!DIGEST_IMAGE_PATTERN.test(image) || image.length > MAX_IMAGE)) {
      errors[field] = 'Must be pinned by digest: <repository>@sha256:<64 hex digits>.';
    }
  }
  if (value('tenantAuthIssuerIp').length > MAX_IPV4) {
    errors.tenantAuthIssuerIp = `Must be an IPv4 address (at most ${MAX_IPV4} characters).`;
  }
  if (value('tenantAuthIssuerUpstream').length > MAX_IMAGE) {
    errors.tenantAuthIssuerUpstream = `Must be at most ${MAX_IMAGE} characters.`;
  }
  const registry = TENANT_AUTH_FIELDS.filter(({ path }) => path[0] === 'registry');
  if (registry.some(({ field }) => value(field)) && !value('tenantAuthRegistryComponent')) {
    errors.tenantAuthRegistryComponent = 'The registry needs its component.';
  }
  for (const { field, path, number } of TENANT_AUTH_FIELDS) {
    const n = value(field);
    const error =
      number && n
        ? path[0] === 'registry'
          ? wholeNumberError('The limit', n, 1)
          : wholeNumberError('The pod port', n, 1, MAX_PORT)
        : undefined;
    if (error) {
      errors[field] = error;
    }
  }

  const hostImage = form.tenantHostImage.trim();
  if (hostImage && (!HOST_IMAGE_PATTERN.test(hostImage) || hostImage.length > MAX_IMAGE)) {
    errors.tenantHostImage =
      'Must be an image reference without spaces, optionally pinned as @sha256:<64 hex digits>.';
  }
}

/** Client-side checks mirroring the CRD, so most mistakes show before the request. */
export function validateForm(form: PlatformInstanceForm, mode: FormMode): FormErrors {
  const errors: FormErrors = {};

  if (mode === 'create') {
    const name = form.name.trim();
    if (!name) {
      errors.name = 'Name is required.';
    } else if (name.length > MAX_NAME_LENGTH) {
      errors.name = `Name must be at most ${MAX_NAME_LENGTH} characters (it has ${name.length}).`;
    } else if (!DNS1123_SUBDOMAIN.test(name)) {
      errors.name =
        'Name must be lowercase letters, digits, "-" and ".", and start and end with a letter or digit.';
    }

    const namespace = form.namespace.trim();
    if (!namespace) {
      errors.namespace = 'Namespace is required.';
    } else if (namespace.length > MAX_NAME_LENGTH || !DNS1123_LABEL.test(namespace)) {
      errors.namespace = 'Namespace must be a valid DNS-1123 label.';
    }
  }

  const version = form.version.trim();
  if (!version) {
    errors.version = 'Version is required.';
  } else if (!VERSION_PATTERN.test(version)) {
    errors.version = 'Version must be an exact version, for example 6.0.17.';
  }

  const nodePort = form.httpNodePort.trim();
  if (nodePort) {
    const n = Number(nodePort);
    if (!/^\d+$/.test(nodePort) || !Number.isInteger(n) || n < 0 || n > MAX_NODE_PORT) {
      errors.httpNodePort = `HTTP NodePort must be a whole number from 0 to ${MAX_NODE_PORT}.`;
    }
  }

  const endpoint = form.httpEndpoint.trim();
  if (endpoint && !ENDPOINT_PATTERN.test(endpoint)) {
    errors.httpEndpoint = 'HTTP endpoint must start with http:// or https://.';
  }

  validateTenantsAndUsers(form, errors);
  validateTenantAuth(form, errors);
  return errors;
}

/** The API path of the namespace's PlatformInstance collection (POST target on create). */
export function collectionPath(namespace: string): string {
  return `/apis/${API_VERSION}/namespaces/${encodeURIComponent(namespace)}/${PLURAL}`;
}

/** The API path of one PlatformInstance (PATCH target on edit). */
export function objectPath(namespace: string, name: string): string {
  return `${collectionPath(namespace)}/${encodeURIComponent(name)}`;
}
