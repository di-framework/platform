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
  editPatch,
  emptyForm,
  formFromObject,
  IMMUTABLE_ON_EDIT,
  isDisabled,
  type JsonPatchOp,
  objectPath,
  type PlatformInstanceForm,
  validateForm,
} from './mapping';
import { applyPatch, PatchError } from './testdata/applyPatch';
import {
  celErrors,
  crdCelRules,
  EMULATED_CEL_RULES,
  loadCrd,
  schemaErrors,
} from './testdata/crdSchema';
import { endpointOnly, full, minimal, tenancy } from './testdata/fixtures';
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
    expect(editPatch(manifest, formFromObject(manifest))).toStrictEqual([]);
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

  /** What the server does with the patch: apply it, then check the result like any update. */
  function serverApply(current: PlatformInstanceObject, patch: JsonPatchOp[]) {
    const updated = applyPatch(current, patch);
    const body: Partial<PlatformInstanceObject> = {
      ...updated,
      metadata: { name: updated.metadata.name },
    };
    delete body.status;
    expect(schemaErrors(body)).toEqual([]);
    expect(celErrors(updated, current)).toEqual([]);
    return updated;
  }

  it('patches only the changed fields, guarded by their old values', () => {
    const form = { ...formFromObject(live), version: '6.0.19', deletionPolicy: 'Delete' as const };
    expect(editPatch(live, form)).toStrictEqual([
      { op: 'test', path: '/spec/version', value: '6.0.18-rc.1' },
      { op: 'test', path: '/spec/deletionPolicy', value: 'Retain' },
      { op: 'replace', path: '/spec/version', value: '6.0.19' },
      { op: 'replace', path: '/spec/deletionPolicy', value: 'Delete' },
    ]);
    const updated = serverApply(live, editPatch(live, form));
    expect(updated.spec).toStrictEqual({
      ...full.spec,
      version: '6.0.19',
      deletionPolicy: 'Delete',
    });
    expect(updated.status).toStrictEqual(live.status);
  });

  it('keeps spec fields the form does not know, at every level (W1)', () => {
    const extended = {
      ...live,
      spec: {
        ...live.spec,
        futureTopLevel: { a: 1 },
        platform: {
          ...live.spec.platform,
          futurePlatform: true,
          gateway: { ...live.spec.platform?.gateway, futureGateway: 'x' },
        },
      },
    } as PlatformInstanceObject;
    const form = {
      ...formFromObject(extended),
      version: '6.0.19',
      httpNodePort: '',
      httpEndpoint: '',
    };
    const updated = applyPatch(extended, editPatch(extended, form));
    expect(updated.spec).toStrictEqual({
      ...extended.spec,
      version: '6.0.19',
      platform: { ...extended.spec.platform, gateway: { futureGateway: 'x' } },
    });
  });

  it('keeps labels, annotations and the rest of the metadata (W3)', () => {
    const decorated: PlatformInstanceObject = {
      ...live,
      metadata: {
        ...live.metadata,
        labels: { team: 'a' },
        annotations: { 'example.com/note': 'keep me' },
        finalizers: ['platform.di-framework.dev/finalizer'],
        ownerReferences: [{ apiVersion: 'v1', kind: 'ConfigMap', name: 'owner', uid: 'o-1' }],
        managedFields: [{ manager: 'kubectl', operation: 'Apply' }],
      },
    };
    const patch = editPatch(decorated, { ...formFromObject(decorated), version: '6.0.19' });
    expect(patch.filter((op) => op.path.startsWith('/metadata'))).toStrictEqual([]);
    expect(applyPatch(decorated, patch).metadata).toStrictEqual(decorated.metadata);
    // With a container to create, the only /metadata op is the resourceVersion test.
    const added = editPatch(
      { ...decorated, spec: { ...decorated.spec, platform: undefined } },
      { ...formFromObject(decorated), storageRoot: '' },
    );
    expect(added.filter((op) => op.path.startsWith('/metadata'))).toStrictEqual([
      { op: 'test', path: '/metadata/resourceVersion', value: '42' },
    ]);
  });

  it('fails as a whole when a field it changes was changed after the dialog opened', () => {
    const patch = editPatch(live, { ...formFromObject(live), version: '6.0.19' });
    const changed = { ...live, spec: { ...live.spec, version: '6.0.20' } };
    expect(() => applyPatch(changed, patch)).toThrow(PatchError);
    expect(() => applyPatch(changed, patch)).toThrow(
      expect.objectContaining({ detail: 'testing value /spec/version failed: test failed' }),
    );
    // A removed field fails the same way, so does one a concurrent change deleted.
    const removal = editPatch(live, { ...formFromObject(live), httpEndpoint: '' });
    const moved = structuredClone(live);
    moved.spec.platform = { ...moved.spec.platform, gateway: { httpEndpoint: 'http://other' } };
    expect(() => applyPatch(moved, removal)).toThrow(PatchError);
  });

  it('succeeds after an operator status write when it changes only existing fields (S6)', () => {
    // The operator's status updates bump resourceVersion and leave the spec alone.
    const statusWrite: PlatformInstanceObject = {
      ...live,
      metadata: { ...live.metadata, resourceVersion: '43' },
      status: { ...live.status, phase: 'Provisioning', observedGeneration: 3 },
    };
    const form = {
      ...formFromObject(live),
      version: '6.0.19',
      networkPolicyEngine: '' as const,
      httpNodePort: '30081',
      httpEndpoint: '',
    };
    const patch = editPatch(live, form);
    expect(patch.some((op) => op.path === '/metadata/resourceVersion')).toBe(false);
    const updated = serverApply(statusWrite, patch);
    expect(updated.spec.version).toBe('6.0.19');
    expect(updated.spec.platform).toStrictEqual({
      storageRoot: live.spec.platform?.storageRoot,
      gateway: { httpNodePort: 30081 },
    });
    expect(updated.status).toStrictEqual(statusWrite.status);
  });

  it('guards on resourceVersion when it creates a container or adds a missing field (S6)', () => {
    const old = { ...minimal, metadata: { ...minimal.metadata, resourceVersion: '7' } };
    const bumped = { ...old, metadata: { ...old.metadata, resourceVersion: '8' } };
    // JSON Patch can't test that a member is absent: someone may have created it meanwhile.
    for (const form of [
      { ...formFromObject(old), httpNodePort: '30080' },
      { ...formFromObject(old), deletionPolicy: 'Retain' as const },
    ]) {
      const patch = editPatch(old, form);
      expect(patch[0]).toStrictEqual({
        op: 'test',
        path: '/metadata/resourceVersion',
        value: '7',
      });
      expect(() => applyPatch(bumped, patch)).toThrow(
        expect.objectContaining({
          detail: 'testing value /metadata/resourceVersion failed: test failed',
        }),
      );
      expect(() => serverApply(old, patch)).not.toThrow();
    }
  });

  it('keeps an instance without storageRoot without one, as the CEL rule requires', () => {
    const old = { ...minimal, metadata: { ...minimal.metadata, resourceVersion: '7' } };
    const patch = editPatch(old, { ...formFromObject(old), version: '6.0.18' });
    expect(patch.some((op) => op.path.includes('storageRoot'))).toBe(false);
    expect(serverApply(old, patch).spec.platform).toBeUndefined();
  });

  it('creates platform and gateway when the first gateway field is set', () => {
    const old = { ...minimal, metadata: { ...minimal.metadata, resourceVersion: '7' } };
    const patch = editPatch(old, { ...formFromObject(old), httpNodePort: '30080' });
    expect(patch).toStrictEqual([
      { op: 'test', path: '/metadata/resourceVersion', value: '7' },
      { op: 'add', path: '/spec/platform', value: {} },
      { op: 'add', path: '/spec/platform/gateway', value: {} },
      { op: 'add', path: '/spec/platform/gateway/httpNodePort', value: 30080 },
    ]);
    expect(serverApply(old, patch).spec.platform).toStrictEqual({
      gateway: { httpNodePort: 30080 },
    });
  });

  it('removing an optional field removes it, and the containers it leaves empty', () => {
    const one = editPatch(live, { ...formFromObject(live), httpNodePort: '' });
    expect(serverApply(live, one).spec.platform?.gateway).toStrictEqual({
      httpEndpoint: 'http://apps.example:30080',
    });
    const gatewayOnly: PlatformInstanceObject = {
      ...live,
      spec: { ...live.spec, platform: { gateway: { httpNodePort: 30080 } } },
    };
    const both = editPatch(gatewayOnly, { ...formFromObject(gatewayOnly), httpNodePort: '' });
    expect(both).toStrictEqual([
      { op: 'test', path: '/spec/platform/gateway/httpNodePort', value: 30080 },
      { op: 'remove', path: '/spec/platform/gateway/httpNodePort' },
      { op: 'test', path: '/spec/platform/gateway', value: {} },
      { op: 'remove', path: '/spec/platform/gateway' },
      { op: 'test', path: '/spec/platform', value: {} },
      { op: 'remove', path: '/spec/platform' },
    ]);
    expect(applyPatch(gatewayOnly, both).spec.platform).toBeUndefined();
    // Something added to an emptied container meanwhile fails the patch instead of being removed.
    for (const platform of [
      { gateway: { httpNodePort: 30080, httpEndpoint: 'http://new' } },
      { gateway: { httpNodePort: 30080 }, networkPolicyEngine: 'kube-router' as const },
    ]) {
      const concurrent = { ...gatewayOnly, spec: { ...gatewayOnly.spec, platform } };
      expect(() => applyPatch(concurrent, both)).toThrow(PatchError);
    }
  });

  it('omits the resourceVersion guard when the object has none', () => {
    expect(
      editPatch(minimal, { ...formFromObject(minimal), httpNodePort: '30080' })[0],
    ).toStrictEqual({ op: 'add', path: '/spec/platform', value: {} });
  });

  it('creates the spec when the object has none', () => {
    const bare = { ...minimal, spec: undefined } as unknown as PlatformInstanceObject;
    const patch = editPatch(bare, { ...emptyForm('team-a'), name: 'one', version: '6.0.17' });
    expect(patch).toStrictEqual([
      { op: 'add', path: '/spec', value: {} },
      { op: 'add', path: '/spec/version', value: '6.0.17' },
      { op: 'add', path: '/spec/target', value: {} },
      { op: 'add', path: '/spec/target/type', value: 'vcluster' },
    ]);
    expect(applyPatch(bare, patch).spec).toStrictEqual(minimal.spec);
  });

  it('does not validate the fixed name and namespace again', () => {
    const form = { ...formFromObject(live), name: 'x'.repeat(80) };
    expect(validateForm(form, 'edit').name).toBeUndefined();
  });
});

describe('the CEL emulation matches the CRD (S1)', () => {
  it('implements exactly the rules the CRD declares', () => {
    expect([...crdCelRules()].sort()).toStrictEqual([...EMULATED_CEL_RULES].sort());
  });

  // The tenancy settings (#442) have no form fields yet; the manifest must still validate.
  type Subject = Parameters<typeof celErrors>[0];
  const tenancySubject = () => structuredClone(tenancy) as unknown as Subject;

  it('accepts the tenancy fixture against the schema and the CEL rules', () => {
    expect(schemaErrors(tenancy)).toEqual([]);
    expect(celErrors(tenancySubject())).toEqual([]);
    expect(celErrors(tenancySubject(), tenancySubject())).toEqual([]);
  });

  it('rejects a membership of no tenant, and a partial tenantAuth', () => {
    const orphan = tenancySubject();
    orphan.spec.platform = { ...orphan.spec.platform, tenants: undefined };
    expect(celErrors(orphan)).toEqual([
      'every users[].memberships[].tenant must name an entry of tenants',
    ]);
    const partial = tenancySubject();
    delete partial.spec.platform?.tenantAuth?.clientSecretRef;
    expect(celErrors(partial)).toEqual([
      'tenantAuth needs issuer, clientId and clientSecretRef together',
    ]);
  });

  it('lets tenantHostImage change after creation', () => {
    expect(EMULATED_CEL_RULES.some((rule) => rule.includes('tenantHostImage'))).toBe(false);
    const changed = structuredClone(tenancy);
    // The form has no tenancy fields, so PlatformSettings doesn't declare tenantHostImage.
    Object.assign(changed.spec.platform ?? {}, { tenantHostImage: 'localhost/wash:dev' });
    expect(schemaErrors(changed)).toEqual([]);
    expect(celErrors(changed as unknown as Subject, tenancySubject())).toEqual([]);
  });

  it('leaves tenants, users and tenantAuth untouched when the form edits an instance', () => {
    const live = structuredClone(tenancy);
    const form = { ...formFromObject(live), version: '6.0.21' };
    const patch = editPatch(live, form);
    expect(patch.map((op) => op.path)).toStrictEqual(['/spec/version', '/spec/version']);
    const updated = applyPatch(live, patch);
    expect(updated.spec).toStrictEqual({ ...tenancy.spec, version: '6.0.21' });
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
