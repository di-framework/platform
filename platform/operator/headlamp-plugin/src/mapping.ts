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

/**
 * The object to send. On create it is exactly the manifest a user would `kubectl apply`. On edit
 * it is the existing object with its spec replaced (metadata, including resourceVersion, kept so
 * the update is a normal optimistic-concurrency PUT; status left out, the main resource ignores it).
 */
export function buildPlatformInstance(
  form: PlatformInstanceForm,
  existing?: PlatformInstanceObject,
): PlatformInstanceObject {
  const spec = specFromForm(form);
  if (existing) {
    const updated: PlatformInstanceObject = {
      ...existing,
      apiVersion: API_VERSION,
      kind: KIND,
      spec,
    };
    delete updated.status;
    return updated;
  }
  return {
    apiVersion: API_VERSION,
    kind: KIND,
    metadata: { name: form.name.trim(), namespace: form.namespace.trim() },
    spec,
  };
}

// The apiserver's DNS-1123 subdomain (object names) and label (namespaces) rules.
const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
// The CRD's patterns for spec.version and spec.platform.gateway.httpEndpoint.
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
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
    if (!/^[0-9]+$/.test(nodePort) || !Number.isInteger(n) || n < 0 || n > MAX_NODE_PORT) {
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

/** The API path of one PlatformInstance (PUT target on edit). */
export function objectPath(namespace: string, name: string): string {
  return `${collectionPath(namespace)}/${encodeURIComponent(name)}`;
}
