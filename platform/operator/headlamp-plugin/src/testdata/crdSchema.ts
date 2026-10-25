/**
 * Test helper: validates objects against the PlatformInstance CRD's openAPIV3Schema, read from
 * platform/operator/config/crd (the file controller-gen writes from the Go types). The schema is
 * tightened with `additionalProperties: false` on every object that lists its properties, so a
 * field the apiserver would silently prune fails the test instead.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv, { type ErrorObject } from 'ajv';
import { load } from 'js-yaml';
import { MAX_NAME_LENGTH } from '../types';

// Read from disk, so use it only in the Node test environment: the CRD is outside the plugin's
// Vite root. This is platform/operator/config/crd in the same checkout.
const CRD_PATH = fileURLToPath(
  new URL('../../../config/crd/platform.di-framework.dev_platforminstances.yaml', import.meta.url),
);

type Schema = Record<string, unknown>;

function closeObjects(schema: Schema): Schema {
  const out: Schema = { ...schema };
  if (out.properties && typeof out.properties === 'object') {
    const props: Record<string, Schema> = {};
    for (const [k, v] of Object.entries(out.properties as Record<string, Schema>)) {
      props[k] = closeObjects(v);
    }
    out.properties = props;
    if (out.additionalProperties === undefined) {
      out.additionalProperties = false;
    }
  }
  if (out.items && typeof out.items === 'object') {
    out.items = closeObjects(out.items as Schema);
  }
  return out;
}

export function loadCrd(): {
  group: string;
  kind: string;
  plural: string;
  version: string;
  schema: Schema;
} {
  const crd = load(readFileSync(CRD_PATH, 'utf8')) as {
    spec: {
      group: string;
      names: { kind: string; plural: string };
      versions: { name: string; schema: { openAPIV3Schema: Schema } }[];
    };
  };
  const version = crd.spec.versions[0];
  if (!version) {
    throw new Error('CRD has no versions');
  }
  return {
    group: crd.spec.group,
    kind: crd.spec.names.kind,
    plural: crd.spec.names.plural,
    version: version.name,
    schema: version.schema.openAPIV3Schema,
  };
}

const ajv = new Ajv({ allErrors: true, strict: true });
// Kubernetes structural-schema extensions; CEL rules are checked by checkCel below.
for (const keyword of [
  'x-kubernetes-validations',
  'x-kubernetes-list-type',
  'x-kubernetes-list-map-keys',
]) {
  ajv.addKeyword(keyword);
}
ajv.addFormat('int32', {
  type: 'number',
  validate: (n: number) => Number.isInteger(n) && n >= -(2 ** 31) && n < 2 ** 31,
});
ajv.addFormat('int64', { type: 'number', validate: (n: number) => Number.isInteger(n) });
ajv.addFormat('date-time', (s: string) => !Number.isNaN(Date.parse(s)));

const validate = ajv.compile(closeObjects(loadCrd().schema));

/** Schema errors for `obj`, empty when it is valid (and nothing in it would be pruned). */
export function schemaErrors(obj: unknown): ErrorObject[] {
  return validate(obj) ? [] : [...(validate.errors ?? [])];
}

interface CelSubject {
  metadata: { name: string };
  spec: { target: unknown; platform?: { storageRoot?: string } };
}

/**
 * The CRD's CEL rules, written out: the name length on every write, and on update the immutable
 * target and storageRoot (the storageRoot rule exactly as the CRD states it, including "can't be
 * added later").
 */
export function celErrors(obj: CelSubject, old?: CelSubject): string[] {
  const errors: string[] = [];
  if (obj.metadata.name.length > MAX_NAME_LENGTH) {
    errors.push('name must be at most 63 characters');
  }
  if (old) {
    if (JSON.stringify(obj.spec.target) !== JSON.stringify(old.spec.target)) {
      errors.push('target is immutable');
    }
    const has = (o: CelSubject) => o.spec.platform?.storageRoot !== undefined;
    const ok = has(obj)
      ? has(old) && old.spec.platform?.storageRoot === obj.spec.platform?.storageRoot
      : !has(old);
    if (!ok) {
      errors.push('platform.storageRoot is immutable');
    }
  }
  return errors;
}
