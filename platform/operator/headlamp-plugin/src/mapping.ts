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
  MAX_NAME_LENGTH,
  type NetworkPolicyEngine,
  PLURAL,
  type PlatformInstanceObject,
  type PlatformInstanceSpec,
  type PlatformSettings,
  type TargetType,
} from './types';

/** Every form field is the text the user typed; an empty string means "not set". */
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
}

export type FormField = keyof PlatformInstanceForm;
export type FormMode = 'create' | 'edit';
export type FormErrors = Partial<Record<FormField, string>>;

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
  return {
    name: '',
    namespace,
    version: '',
    targetType: 'vcluster',
    networkPolicyEngine: '',
    storageRoot: '',
    httpNodePort: '',
    httpEndpoint: '',
    deletionPolicy: '',
  };
}

/** The form for editing an existing object: every field shows what the object holds. */
export function formFromObject(obj: PlatformInstanceObject): PlatformInstanceForm {
  const platform = obj.spec?.platform ?? {};
  const gateway = platform.gateway ?? {};
  return {
    name: obj.metadata.name,
    namespace: obj.metadata.namespace ?? '',
    version: obj.spec?.version ?? '',
    targetType: obj.spec?.target?.type ?? 'vcluster',
    networkPolicyEngine: platform.networkPolicyEngine ?? '',
    storageRoot: platform.storageRoot ?? '',
    httpNodePort: gateway.httpNodePort === undefined ? '' : String(gateway.httpNodePort),
    httpEndpoint: gateway.httpEndpoint ?? '',
    deletionPolicy: obj.spec?.deletionPolicy ?? '',
  };
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
 *   `platform`/`gateway` when missing) or `remove`, dropping a `platform`/`gateway` the removal
 *   left empty. Spec fields the form doesn't know, labels, annotations and the rest of the
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
    if (oldValue === newValue) {
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
