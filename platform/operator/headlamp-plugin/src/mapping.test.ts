// @vitest-environment node
/**
 * Gate 2 of epic #275: an instance created from the UI is identical to one created from YAML.
 * Each fixture is a manifest a user could `kubectl apply`; it is checked against the CRD's
 * schema and CEL rules, and the form filled in with the same values must produce it exactly.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPlatformInstance,
  collectionPath,
  emptyForm,
  formFromObject,
  IMMUTABLE_ON_EDIT,
  isDisabled,
  objectPath,
  type PlatformInstanceForm,
  validateForm,
} from './mapping';
import { celErrors, loadCrd, schemaErrors } from './testdata/crdSchema';
import { endpointOnly, full, minimal } from './testdata/fixtures';
import { API_VERSION, KIND, PLURAL, type PlatformInstanceObject } from './types';

const fixtures = { minimal, full, endpointOnly };

/** What a user types into the create form for each fixture. */
const typed: Record<keyof typeof fixtures, PlatformInstanceForm> = {
  minimal: { ...emptyForm('team-a'), name: 'one', version: '6.0.17' },
  full: {
    name: 'full-instance',
    namespace: 'team-b',
    version: '6.0.18-rc.1',
    targetType: 'vcluster',
    networkPolicyEngine: 'kube-router',
    storageRoot: '/var/lib/di-framework/team-b/full-instance',
    httpNodePort: '30080',
    httpEndpoint: 'http://apps.example:30080',
    deletionPolicy: 'Retain',
  },
  endpointOnly: {
    ...emptyForm('default'),
    name: 'endpoint-only',
    version: '6.0.17',
    httpEndpoint: 'https://apps.example',
    deletionPolicy: 'Delete',
  },
};

describe('the plugin types match the CRD', () => {
  it('group, version, kind and plural', () => {
    const crd = loadCrd();
    expect(API_VERSION).toBe(`${crd.group}/${crd.version}`);
    expect(KIND).toBe(crd.kind);
    expect(PLURAL).toBe(crd.plural);
  });
});

describe.each(Object.keys(fixtures) as (keyof typeof fixtures)[])('fixture %s', (name) => {
  const manifest = fixtures[name];

  it('is valid against the CRD schema, with nothing the apiserver would prune', () => {
    expect(schemaErrors(manifest)).toEqual([]);
  });

  it('passes the CRD CEL rules', () => {
    expect(celErrors(manifest)).toEqual([]);
  });

  it('is exactly what the create form produces', () => {
    const form = typed[name];
    expect(validateForm(form, 'create')).toEqual({});
    expect(buildPlatformInstance(form)).toStrictEqual(manifest);
  });

  it('round-trips through the edit form unchanged', () => {
    expect(buildPlatformInstance(formFromObject(manifest))).toStrictEqual(manifest);
  });
});

describe('the schema check itself', () => {
  it('rejects fields the CRD does not define, an empty version and a bad enum', () => {
    expect(schemaErrors({ ...minimal, spec: { ...minimal.spec, extra: 1 } })).not.toEqual([]);
    expect(
      schemaErrors({ ...minimal, spec: { ...minimal.spec, target: { type: 'kubeconfig' } } }),
    ).not.toEqual([]);
    expect(schemaErrors({ ...minimal, spec: { target: minimal.spec.target } })).not.toEqual([]);
  });
});

describe('create', () => {
  it('leaves out every field the user left empty, so the API applies the defaults', () => {
    const obj = buildPlatformInstance({ ...emptyForm('ns'), name: 'a', version: '1.2.3' });
    expect(obj.spec).toStrictEqual({ version: '1.2.3', target: { type: 'vcluster' } });
    expect(obj).not.toHaveProperty('status');
  });

  it('keeps a NodePort of 0 the user typed, as the number 0', () => {
    const obj = buildPlatformInstance({ ...typed.minimal, httpNodePort: '0' });
    expect(obj.spec.platform).toStrictEqual({ gateway: { httpNodePort: 0 } });
    expect(schemaErrors(obj)).toEqual([]);
  });

  it('trims what the user typed', () => {
    const obj = buildPlatformInstance({
      ...typed.minimal,
      name: ' one ',
      namespace: ' team-a ',
      version: ' 6.0.17 ',
      storageRoot: '   ',
    });
    expect(obj).toStrictEqual(minimal);
  });

  it('posts to the namespace collection', () => {
    expect(collectionPath('team-a')).toBe(
      '/apis/platform.di-framework.dev/v1alpha1/namespaces/team-a/platforminstances',
    );
    expect(objectPath('team-a', 'one')).toBe(
      '/apis/platform.di-framework.dev/v1alpha1/namespaces/team-a/platforminstances/one',
    );
  });
});

describe('edit', () => {
  const live: PlatformInstanceObject = {
    ...full,
    metadata: {
      ...full.metadata,
      uid: 'u-1',
      resourceVersion: '42',
      generation: 3,
      creationTimestamp: '2026-10-25T10:00:00Z',
    },
    status: { phase: 'Ready', installedVersion: '6.0.18-rc.1' },
  };

  it('disables exactly the fields that are immutable after creation', () => {
    expect([...IMMUTABLE_ON_EDIT].sort()).toEqual(
      ['name', 'namespace', 'storageRoot', 'targetType'].sort(),
    );
    for (const field of Object.keys(emptyForm()) as (keyof PlatformInstanceForm)[]) {
      expect(isDisabled(field, 'create')).toBe(false);
      expect(isDisabled(field, 'edit')).toBe(IMMUTABLE_ON_EDIT.includes(field));
    }
  });

  it('replaces the spec, keeps metadata (resourceVersion) and drops status', () => {
    const form = { ...formFromObject(live), version: '6.0.19', deletionPolicy: 'Delete' as const };
    const updated = buildPlatformInstance(form, live);
    expect(updated.metadata).toStrictEqual(live.metadata);
    expect(updated).not.toHaveProperty('status');
    expect(updated.spec).toStrictEqual({
      ...full.spec,
      version: '6.0.19',
      deletionPolicy: 'Delete',
    });
    expect(schemaErrors(updated)).toEqual([]);
    expect(celErrors(updated, live)).toEqual([]);
  });

  it('keeps an instance without storageRoot without one, as the CEL rule requires', () => {
    const old = { ...minimal, metadata: { ...minimal.metadata, resourceVersion: '7' } };
    const updated = buildPlatformInstance({ ...formFromObject(old), version: '6.0.18' }, old);
    expect(updated.spec.platform).toBeUndefined();
    expect(celErrors(updated, old)).toEqual([]);
  });

  it('removing an optional field leaves it out of the PUT body', () => {
    const updated = buildPlatformInstance({ ...formFromObject(live), httpNodePort: '' }, live);
    expect(updated.spec.platform?.gateway).toStrictEqual({
      httpEndpoint: 'http://apps.example:30080',
    });
  });

  it('does not validate the fixed name and namespace again', () => {
    const form = { ...formFromObject(live), name: 'x'.repeat(80) };
    expect(validateForm(form, 'edit').name).toBeUndefined();
  });
});

describe('validation', () => {
  const ok = typed.full;

  it('accepts a 63-character name and rejects a 64-character one (the CRD CEL rule)', () => {
    expect(validateForm({ ...ok, name: 'a'.repeat(63) }, 'create').name).toBeUndefined();
    expect(validateForm({ ...ok, name: 'a'.repeat(64) }, 'create').name).toMatch(/at most 63/);
    const obj = buildPlatformInstance({ ...ok, name: 'a'.repeat(64) });
    expect(celErrors(obj)).toEqual(['name must be at most 63 characters']);
  });

  it('requires a name, namespace and version', () => {
    const errors = validateForm({ ...emptyForm(''), targetType: 'vcluster' }, 'create');
    expect(Object.keys(errors).sort()).toEqual(['name', 'namespace', 'version']);
  });

  it('rejects names the apiserver would reject', () => {
    for (const bad of ['Upper', '-lead', 'trail-', 'under_score', 'sp ace']) {
      expect(validateForm({ ...ok, name: bad }, 'create').name).toBeDefined();
    }
    expect(validateForm({ ...ok, name: 'a.b-c' }, 'create').name).toBeUndefined();
  });

  it('follows the CRD version pattern', () => {
    expect(validateForm({ ...ok, version: '6.0' }, 'create').version).toBeDefined();
    expect(validateForm({ ...ok, version: 'latest' }, 'create').version).toBeDefined();
    expect(validateForm({ ...ok, version: '6.0.17-rc.1' }, 'create').version).toBeUndefined();
  });

  it('checks the NodePort range 0 to 32767 and whole numbers', () => {
    for (const bad of ['-1', '32768', '1.5', 'abc', '1e3']) {
      expect(validateForm({ ...ok, httpNodePort: bad }, 'create').httpNodePort).toBeDefined();
    }
    for (const good of ['0', '30080', '32767']) {
      expect(validateForm({ ...ok, httpNodePort: good }, 'create').httpNodePort).toBeUndefined();
    }
  });

  it('requires an http(s) endpoint', () => {
    expect(validateForm({ ...ok, httpEndpoint: 'ftp://x' }, 'create').httpEndpoint).toBeDefined();
    expect(
      validateForm({ ...ok, httpEndpoint: 'apps:30080' }, 'create').httpEndpoint,
    ).toBeDefined();
  });

  it('agrees with the CRD schema: whatever validates also passes the schema', () => {
    const forms: PlatformInstanceForm[] = [
      { ...ok, httpNodePort: '32767' },
      { ...ok, httpNodePort: '0', httpEndpoint: '' },
      { ...ok, networkPolicyEngine: 'existing', deletionPolicy: '' },
    ];
    for (const form of forms) {
      expect(validateForm(form, 'create')).toEqual({});
      expect(schemaErrors(buildPlatformInstance(form))).toEqual([]);
    }
  });
});
