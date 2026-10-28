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
  networkPolicyEngineChoices,
  objectPath,
  type PlatformInstanceForm,
  TENANT_AUTH_FIELDS,
  validateForm,
} from './mapping';
import { applyPatch, PatchError } from './testdata/applyPatch';
import {
  celErrors,
  crdCelRules,
  EMULATED_CEL_RULES,
  KUBE_ROUTER_MESSAGE,
  loadCrd,
  schemaErrors,
} from './testdata/crdSchema';
import {
  endpointOnly,
  full,
  minimal,
  tenancy,
  tenancyFull,
  tenancyMinimal,
} from './testdata/fixtures';
import { API_VERSION, KIND, PLURAL, type PlatformInstanceObject } from './types';

const TENANT_AUTH_IMAGE =
  'ghcr.io/di-framework/tenant-auth@sha256:455af084f57e60a54b16b6f5c4f39fcafb0593612fb036e1b099b88423147a30';
const REGISTRY_COMPONENT =
  'ghcr.io/di-framework/oci-registry@sha256:6fea016378c3c6313427f2d6df0fed5ca369ab8f5676eb49d99844625312bb80';

const fixtures = { minimal, full, endpointOnly, tenancy, tenancyMinimal, tenancyFull };

/** What a user types into the create form for each fixture. */
const typed: Record<keyof typeof fixtures, PlatformInstanceForm> = {
  minimal: { ...emptyForm('team-a'), name: 'one', version: '6.0.17' },
  full: {
    ...emptyForm(),
    name: 'full-instance',
    namespace: 'team-b',
    version: '6.0.18-rc.1',
    targetType: 'vcluster',
    networkPolicyEngine: 'existing',
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
  tenancy: {
    ...emptyForm('team-c'),
    name: 'tenancy-instance',
    version: '6.0.18',
    tenants: [
      { name: 'acme', rest: { deletionPolicy: 'Delete', runtime: { coreInstances: 300 } } },
    ],
    users: [{ name: 'dev', memberships: [{ tenant: 'acme', role: 'developer' }], rest: {} }],
    tenantAuthIssuer: 'http://stub-oidc.pg-stub-oidc.svc.cluster.local',
    tenantAuthClientId: 'pgprove-console',
    tenantAuthSecretName: 'tenant-auth-oauth',
    tenantAuthSecretKey: 'clientSecret',
    tenantAuthImage: TENANT_AUTH_IMAGE,
    tenantAuthIssuerUpstream: 'stub-oidc.pg-stub-oidc.svc.cluster.local:80',
    tenantAuthIssuerUpstreamPodPort: '8080',
    tenantHostImage:
      'ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@sha256:6fea016378c3c6313427f2d6df0fed5ca369ab8f5676eb49d99844625312bb80',
    tenantHostImagePullPolicy: 'IfNotPresent',
  },
  tenancyMinimal: {
    ...emptyForm('team-d'),
    name: 'tenancy-minimal',
    version: '6.0.20',
    tenants: [{ name: 'acme', rest: {} }],
    users: [{ name: 'dev', memberships: [{ tenant: 'acme', role: 'viewer' }], rest: {} }],
  },
  tenancyFull: {
    ...emptyForm('team-e'),
    name: 'tenancy-full',
    version: '6.0.20',
    tenants: [
      {
        name: 'acme',
        rest: {
          deletionPolicy: 'Retain',
          resources: { workloads: 10, cpu: '500m', memory: '1Gi' },
          runtime: { replicas: 2, coreInstances: 200 },
        },
      },
      { name: 'globex', rest: { suspended: true } },
    ],
    users: [
      {
        name: 'dev',
        memberships: [
          { tenant: 'acme', role: 'developer' },
          { tenant: 'globex', role: 'viewer' },
        ],
        rest: {},
      },
      {
        name: 'auditor',
        memberships: [{ tenant: 'globex', role: 'viewer' }],
        rest: { suspended: true },
      },
    ],
    tenantAuthIssuer: 'https://login.example',
    tenantAuthClientId: 'platform-console',
    tenantAuthSecretName: 'tenant-auth-oauth',
    tenantAuthSecretKey: 'clientSecret',
    tenantAuthImage: TENANT_AUTH_IMAGE,
    tenantAuthIssuerIp: '10.0.0.53',
    tenantAuthIssuerUpstream: 'login.idp.svc.cluster.local:443',
    tenantAuthIssuerUpstreamPodPort: '8443',
    tenantAuthConsolePublicUrl: 'https://{tenant}.console.example',
    tenantAuthControllerPublicUrl: 'https://{tenant}.api.example',
    tenantAuthRegistryComponent: REGISTRY_COMPONENT,
    tenantAuthRegistryPublicUrl: 'https://{tenant}.registry.example',
    tenantAuthRegistryMaxBodyBytes: '1073741824',
    tenantAuthRegistryMaxConcurrent: '8',
    tenantAuthRegistryUploadIdleTimeoutMs: '30000',
    tenantAuthRegistryUpstreamTimeoutMs: '60000',
    tenantHostImage: 'localhost/wash:dev',
    tenantHostImagePullPolicy: 'Never',
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

describe('tenancy edits (#273, #442)', () => {
  const live = (fixture: PlatformInstanceObject): PlatformInstanceObject => ({
    ...structuredClone(fixture),
    metadata: { ...fixture.metadata, resourceVersion: '42', generation: 2 },
    status: { phase: 'Ready', applied: { generation: 2, tenants: 1, users: 1 } },
  });

  /** The server's side: apply the patch, then check the result like any update. */
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

  it('adds a tenant and a membership by replacing both lists, guarded by their old values', () => {
    const old = live(tenancyMinimal);
    const form = formFromObject(old);
    form.tenants = [...form.tenants, { name: 'globex', rest: {} }];
    form.users = [
      {
        ...(form.users[0] as (typeof form.users)[number]),
        memberships: [
          { tenant: 'acme', role: 'viewer' },
          { tenant: 'globex', role: 'developer' },
        ],
      },
    ];
    expect(validateForm(form, 'edit')).toEqual({});
    const patch = editPatch(old, form);
    expect(patch).toStrictEqual([
      { op: 'test', path: '/spec/platform/tenants', value: [{ name: 'acme' }] },
      {
        op: 'test',
        path: '/spec/platform/users',
        value: [{ name: 'dev', memberships: [{ tenant: 'acme', role: 'viewer' }] }],
      },
      {
        op: 'replace',
        path: '/spec/platform/tenants',
        value: [{ name: 'acme' }, { name: 'globex' }],
      },
      {
        op: 'replace',
        path: '/spec/platform/users',
        value: [
          {
            name: 'dev',
            memberships: [
              { tenant: 'acme', role: 'viewer' },
              { tenant: 'globex', role: 'developer' },
            ],
          },
        ],
      },
    ]);
    const updated = serverApply(old, patch);
    expect(updated.spec.platform?.tenants?.map((t) => t.name)).toStrictEqual(['acme', 'globex']);
    expect(updated.status).toStrictEqual(old.status);
    // Someone else changed the tenants meanwhile: the whole patch fails.
    const moved = structuredClone(old);
    moved.spec.platform = { ...moved.spec.platform, tenants: [{ name: 'other' }] };
    expect(() => applyPatch(moved, patch)).toThrow(PatchError);
  });

  it('keeps the tenant and user fields the form does not show, through a rename', () => {
    const old = live(tenancyFull);
    const form = formFromObject(old);
    form.tenants = form.tenants.map((t) => (t.name === 'acme' ? { ...t, name: 'acme-two' } : t));
    form.users = form.users.map((u) => ({
      ...u,
      memberships: u.memberships.map((m) =>
        m.tenant === 'acme' ? { ...m, tenant: 'acme-two' } : m,
      ),
    }));
    const updated = serverApply(old, editPatch(old, form));
    expect(updated.spec.platform?.tenants?.[0]).toStrictEqual({
      ...tenancyFull.spec.platform?.tenants?.[0],
      name: 'acme-two',
    });
    expect(updated.spec.platform?.users?.[1]?.suspended).toBe(true);
  });

  it('rejects a membership of a removed tenant before sending, as the CEL rule would', () => {
    const old = live(tenancyFull);
    const form = formFromObject(old);
    form.tenants = form.tenants.filter((t) => t.name !== 'globex');
    expect(validateForm(form, 'edit')).toStrictEqual({
      'users.0.memberships.1.tenant':
        '"globex" is not in Tenants: every users[].memberships[].tenant must name an entry of tenants.',
      'users.1.memberships.0.tenant':
        '"globex" is not in Tenants: every users[].memberships[].tenant must name an entry of tenants.',
    });
    // Sent anyway, the apiserver's CEL rule would reject the update.
    const updated = applyPatch(old, editPatch(old, form));
    expect(celErrors(updated, old)).toEqual([
      'every users[].memberships[].tenant must name an entry of tenants',
    ]);
    // Removing every tenant leaves no tenants at all, and still rejects the memberships.
    form.tenants = [];
    expect(Object.keys(validateForm(form, 'edit'))).toHaveLength(3);
    expect(buildPlatformInstance(form).spec.platform).not.toHaveProperty('tenants');
  });

  it('changes and clears the tenant host image (mutable since #460)', () => {
    const old = live(tenancyFull);
    const change = editPatch(old, { ...formFromObject(old), tenantHostImage: 'localhost/wash:v2' });
    expect(change).toStrictEqual([
      { op: 'test', path: '/spec/platform/tenantHostImage', value: 'localhost/wash:dev' },
      { op: 'replace', path: '/spec/platform/tenantHostImage', value: 'localhost/wash:v2' },
    ]);
    expect(serverApply(old, change).spec.platform?.tenantHostImage).toBe('localhost/wash:v2');
    const clear = editPatch(old, {
      ...formFromObject(old),
      tenantHostImage: '',
      tenantHostImagePullPolicy: '',
    });
    expect(clear).toStrictEqual([
      { op: 'test', path: '/spec/platform/tenantHostImage', value: 'localhost/wash:dev' },
      { op: 'test', path: '/spec/platform/tenantHostImagePullPolicy', value: 'Never' },
      { op: 'remove', path: '/spec/platform/tenantHostImage' },
      { op: 'remove', path: '/spec/platform/tenantHostImagePullPolicy' },
    ]);
    expect(serverApply(old, clear).spec.platform).not.toHaveProperty('tenantHostImage');
  });

  it('changes one tenantAuth field with a test and replace of that field only', () => {
    const old = live(tenancyFull);
    const patch = editPatch(old, { ...formFromObject(old), tenantAuthSecretKey: 'secret' });
    expect(patch).toStrictEqual([
      { op: 'test', path: '/spec/platform/tenantAuth/clientSecretRef/key', value: 'clientSecret' },
      { op: 'replace', path: '/spec/platform/tenantAuth/clientSecretRef/key', value: 'secret' },
    ]);
    expect(serverApply(old, patch).spec.platform?.tenantAuth?.clientSecretRef).toStrictEqual({
      name: 'tenant-auth-oauth',
      key: 'secret',
    });
  });

  it('removes tenantAuth field by field, then the containers it empties', () => {
    const old = live(tenancyFull);
    const form = formFromObject(old);
    for (const { field } of TENANT_AUTH_FIELDS) {
      form[field] = '';
    }
    expect(validateForm(form, 'edit')).toEqual({});
    const patch = editPatch(old, form);
    const tail = patch.slice(-4);
    expect(tail).toStrictEqual([
      { op: 'test', path: '/spec/platform/tenantAuth/registry', value: {} },
      { op: 'remove', path: '/spec/platform/tenantAuth/registry' },
      { op: 'test', path: '/spec/platform/tenantAuth', value: {} },
      { op: 'remove', path: '/spec/platform/tenantAuth' },
    ]);
    expect(patch.some((op) => op.path === '/metadata/resourceVersion')).toBe(false);
    const updated = serverApply(old, patch);
    expect(updated.spec.platform).not.toHaveProperty('tenantAuth');
    expect(updated.spec.platform?.tenants).toStrictEqual(tenancyFull.spec.platform?.tenants);
  });

  it('adds tenantAuth to an instance without one, guarded by resourceVersion', () => {
    const old = live(tenancyMinimal);
    const form = {
      ...formFromObject(old),
      tenantAuthIssuer: 'https://login.example',
      tenantAuthClientId: 'console',
      tenantAuthSecretName: 'oauth',
      tenantAuthSecretKey: 'clientSecret',
      tenantAuthImage: TENANT_AUTH_IMAGE,
    };
    const patch = editPatch(old, form);
    expect(patch).toStrictEqual([
      { op: 'test', path: '/metadata/resourceVersion', value: '42' },
      { op: 'add', path: '/spec/platform/tenantAuth', value: {} },
      { op: 'add', path: '/spec/platform/tenantAuth/issuer', value: 'https://login.example' },
      { op: 'add', path: '/spec/platform/tenantAuth/clientId', value: 'console' },
      { op: 'add', path: '/spec/platform/tenantAuth/clientSecretRef', value: {} },
      { op: 'add', path: '/spec/platform/tenantAuth/clientSecretRef/name', value: 'oauth' },
      { op: 'add', path: '/spec/platform/tenantAuth/clientSecretRef/key', value: 'clientSecret' },
      { op: 'add', path: '/spec/platform/tenantAuth/image', value: TENANT_AUTH_IMAGE },
    ]);
    expect(serverApply(old, patch).spec.platform?.tenantAuth).toStrictEqual({
      issuer: 'https://login.example',
      clientId: 'console',
      clientSecretRef: { name: 'oauth', key: 'clientSecret' },
      image: TENANT_AUTH_IMAGE,
    });
  });

  it('saves an object with empty tenants and users lists unchanged as an empty patch (W1)', () => {
    for (const platform of [{ tenants: [] }, { users: [] }, { tenants: [], users: [] }]) {
      const old = { ...live(minimal), spec: { ...minimal.spec, platform } };
      expect(editPatch(old, formFromObject(old))).toStrictEqual([]);
    }
    // Adding to an empty list replaces it, guarded by a test of the empty list.
    const old = { ...live(minimal), spec: { ...minimal.spec, platform: { tenants: [] } } };
    const form = { ...formFromObject(old), tenants: [{ name: 'acme', rest: {} }] };
    expect(editPatch(old, form)).toStrictEqual([
      { op: 'test', path: '/spec/platform/tenants', value: [] },
      { op: 'replace', path: '/spec/platform/tenants', value: [{ name: 'acme' }] },
    ]);
  });

  it('keeps the settings of a tenant removed and added back under the same name (S7)', () => {
    const old = live(tenancyFull);
    const form = formFromObject(old);
    form.tenants = [...form.tenants.filter((t) => t.name !== 'acme'), { name: ' acme ', rest: {} }];
    const updated = serverApply(old, editPatch(old, form));
    expect(updated.spec.platform?.tenants).toStrictEqual([
      tenancyFull.spec.platform?.tenants?.[1],
      tenancyFull.spec.platform?.tenants?.[0],
    ]);
    // A new name gets no settings.
    form.tenants = [...form.tenants, { name: 'initech', rest: {} }];
    expect(applyPatch(old, editPatch(old, form)).spec.platform?.tenants?.[2]).toStrictEqual({
      name: 'initech',
    });
  });

  it('keeps tenantAuth fields the form does not know', () => {
    const old = live(tenancyFull);
    Object.assign(old.spec.platform?.tenantAuth ?? {}, { futureField: 'x' });
    const form = formFromObject(old);
    for (const { field } of TENANT_AUTH_FIELDS) {
      form[field] = '';
    }
    const updated = applyPatch(old, editPatch(old, form));
    expect(updated.spec.platform?.tenantAuth).toStrictEqual({ futureField: 'x' });
  });
});

describe('tenancy validation', () => {
  const ok = typed.tenancyFull;
  const v = (patch: Partial<PlatformInstanceForm>) => validateForm({ ...ok, ...patch }, 'create');

  it('checks tenant and user names: required, pattern, length and unique', () => {
    expect(v({ tenants: [{ name: '', rest: {} }], users: [] })).toStrictEqual({
      'tenants.0.name': 'Tenant name is required.',
    });
    for (const bad of ['Acme', '1acme', 'acme-', 'a_b']) {
      expect(v({ tenants: [{ name: bad, rest: {} }], users: [] })['tenants.0.name']).toMatch(
        /lowercase letters/,
      );
    }
    expect(v({ tenants: [{ name: 'a'.repeat(41), rest: {} }], users: [] })).toStrictEqual({
      'tenants.0.name': 'Tenant name must be at most 40 characters.',
    });
    expect(v({ tenants: [{ name: 'a'.repeat(40), rest: {} }], users: [] })).toStrictEqual({});
    expect(
      v({
        tenants: [
          { name: 'acme', rest: {} },
          { name: 'acme', rest: {} },
        ],
        users: [],
      }),
    ).toStrictEqual({ 'tenants.1.name': 'Tenant "acme" is listed twice.' });
    const user = ok.users[0] as PlatformInstanceForm['users'][number];
    expect(v({ users: [{ ...user, name: '' }] })).toStrictEqual({
      'users.0.name': 'User name is required.',
    });
    expect(v({ users: [user, user] })).toStrictEqual({
      'users.1.name': 'User "dev" is listed twice.',
    });
  });

  it('checks memberships: a tenant chosen, listed, once per user', () => {
    const user = (memberships: PlatformInstanceForm['users'][number]['memberships']) => [
      { name: 'dev', memberships, rest: {} },
    ];
    expect(v({ users: user([{ tenant: '', role: 'viewer' }]) })).toStrictEqual({
      'users.0.memberships.0.tenant': 'Choose a tenant.',
    });
    expect(
      v({
        users: user([
          { tenant: 'acme', role: 'viewer' },
          { tenant: 'acme', role: 'developer' },
        ]),
      }),
    ).toStrictEqual({
      'users.0.memberships.1.tenant': '"acme" is listed twice: one membership per tenant.',
    });
  });

  it('enforces the CRD limits: 32 tenants, 128 users, 16 memberships per user', () => {
    const tenants = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `t${i}`, rest: {} }));
    const users = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `u${i}`, memberships: [], rest: {} }));
    expect(v({ tenants: tenants(32), users: users(128) })).toStrictEqual({});
    expect(v({ tenants: tenants(33), users: [] })).toStrictEqual({
      tenants: 'At most 32 tenants.',
    });
    expect(v({ users: users(129) })).toStrictEqual({ users: 'At most 128 users.' });
    const many = tenants(17);
    const memberships = many.map((t) => ({ tenant: t.name, role: 'viewer' as const }));
    expect(v({ tenants: many, users: [{ name: 'dev', memberships, rest: {} }] })).toStrictEqual({
      'users.0.memberships': 'At most 16 memberships per user.',
    });
    // At the limits, the object passes the schema.
    const atLimit = buildPlatformInstance({
      ...ok,
      tenants: tenants(32),
      users: [{ name: 'dev', memberships: memberships.slice(0, 16), rest: {} }, ...users(127)],
    });
    expect(schemaErrors(atLimit)).toEqual([]);
    expect(celErrors(atLimit)).toEqual([]);
  });

  it('requires issuer, client ID, client secret and image together (CEL rule, required image)', () => {
    const together = 'tenantAuth needs issuer, clientId and clientSecretRef together.';
    const emptyAuth = Object.fromEntries(TENANT_AUTH_FIELDS.map(({ field }) => [field, '']));
    expect(v({ ...emptyAuth, tenantAuthIssuer: 'https://login.example' })).toStrictEqual({
      tenantAuthClientId: together,
      tenantAuthSecretName: together,
      tenantAuthSecretKey: together,
      tenantAuthImage: 'Tenant auth needs the tenant-auth image.',
    });
    expect(v({ ...emptyAuth, tenantAuthImage: TENANT_AUTH_IMAGE })).toStrictEqual({
      tenantAuthIssuer: together,
      tenantAuthClientId: together,
      tenantAuthSecretName: together,
      tenantAuthSecretKey: together,
    });
    // The CEL emulation agrees that a partial tenantAuth is rejected.
    const partial = buildPlatformInstance({
      ...ok,
      ...emptyAuth,
      tenantAuthImage: TENANT_AUTH_IMAGE,
    });
    expect(celErrors(partial)).toEqual([
      'tenantAuth needs issuer, clientId and clientSecretRef together',
    ]);
  });

  it('follows the CRD patterns and lengths of the tenantAuth fields', () => {
    const url = 'Must start with http:// or https:// and be at most 2048 characters.';
    expect(v({ tenantAuthIssuer: 'login.example' }).tenantAuthIssuer).toBe(url);
    expect(v({ tenantAuthConsolePublicUrl: `https://${'a'.repeat(2048)}` })).toStrictEqual({
      tenantAuthConsolePublicUrl: url,
    });
    expect(v({ tenantAuthClientId: 'a'.repeat(254) }).tenantAuthClientId).toMatch(/at most 253/);
    const digest = 'Must be pinned by digest: <repository>@sha256:<64 hex digits>.';
    expect(v({ tenantAuthImage: 'ghcr.io/x:1.0' }).tenantAuthImage).toBe(digest);
    expect(
      v({ tenantAuthImage: `${'a'.repeat(450)}@sha256:${'0'.repeat(64)}` }).tenantAuthImage,
    ).toBe(digest);
    expect(v({ tenantAuthRegistryComponent: 'x' }).tenantAuthRegistryComponent).toBe(digest);
    expect(v({ tenantAuthIssuerIp: '1000.1000.1000.1' }).tenantAuthIssuerIp).toMatch(/IPv4/);
    expect(v({ tenantAuthIssuerUpstream: 'a'.repeat(513) }).tenantAuthIssuerUpstream).toMatch(
      /at most 512/,
    );
    for (const bad of ['0', '65536', '1.5', 'x']) {
      expect(v({ tenantAuthIssuerUpstreamPodPort: bad }).tenantAuthIssuerUpstreamPodPort).toBe(
        'The pod port must be a whole number from 1 to 65535.',
      );
    }
    for (const bad of ['0', '-1', 'abc', '9007199254740993']) {
      expect(v({ tenantAuthRegistryMaxConcurrent: bad }).tenantAuthRegistryMaxConcurrent).toBe(
        'The limit must be a whole number of at least 1.',
      );
    }
  });

  it('needs the registry component for any registry field', () => {
    expect(v({ tenantAuthRegistryComponent: '' })).toStrictEqual({
      tenantAuthRegistryComponent: 'The registry needs its component.',
    });
    const noRegistry = Object.fromEntries(
      TENANT_AUTH_FIELDS.filter(({ path }) => path[0] === 'registry').map(({ field }) => [
        field,
        '',
      ]),
    );
    expect(v(noRegistry)).toStrictEqual({});
  });

  it('follows the CRD pattern for the tenant host image', () => {
    const error =
      'Must be an image reference without spaces, optionally pinned as @sha256:<64 hex digits>.';
    for (const bad of ['has space', 'x@sha256:abc', `${'a'.repeat(513)}`]) {
      expect(v({ tenantHostImage: bad }).tenantHostImage).toBe(error);
    }
    for (const good of ['localhost/wash:dev', `ghcr.io/w:1@sha256:${'0'.repeat(64)}`]) {
      expect(v({ tenantHostImage: good })).toStrictEqual({});
    }
  });

  it('agrees with the CRD schema: whatever validates also passes the schema and CEL', () => {
    const forms: PlatformInstanceForm[] = [
      typed.tenancyFull,
      typed.tenancyMinimal,
      { ...typed.tenancyMinimal, users: [{ name: 'idle', memberships: [], rest: {} }] },
      { ...typed.tenancyFull, tenantHostImagePullPolicy: 'Always', tenantAuthIssuerIp: '' },
    ];
    for (const form of forms) {
      expect(validateForm(form, 'create')).toEqual({});
      expect(schemaErrors(buildPlatformInstance(form))).toEqual([]);
      expect(celErrors(buildPlatformInstance(form))).toEqual([]);
    }
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

describe('networkPolicyEngine on the vcluster target (#456)', () => {
  type Subject = Parameters<typeof celErrors>[0];
  const withEngine = (engine?: 'existing' | 'kube-router', version = '6.0.17') => {
    const obj = structuredClone(minimal);
    obj.spec.version = version;
    if (engine) {
      obj.spec.platform = { ...obj.spec.platform, networkPolicyEngine: engine };
    }
    return obj as unknown as Subject;
  };

  it('offers only existing, plus kube-router for an instance that already has it', () => {
    expect(networkPolicyEngineChoices()).toStrictEqual(['existing']);
    expect(networkPolicyEngineChoices('existing')).toStrictEqual(['existing']);
    expect(networkPolicyEngineChoices('kube-router')).toStrictEqual(['existing', 'kube-router']);
  });

  it('refuses kube-router on create and on an instance that did not have it', () => {
    const form: PlatformInstanceForm = {
      ...emptyForm('team-a'),
      name: 'one',
      version: '6.0.17',
      networkPolicyEngine: 'kube-router',
    };
    expect(validateForm(form, 'create').networkPolicyEngine).toMatch(/Use existing/);
    expect(validateForm(form, 'edit', 'existing').networkPolicyEngine).toMatch(/Use existing/);
    expect(validateForm(form, 'edit').networkPolicyEngine).toMatch(/Use existing/);
    expect(validateForm(form, 'edit', 'kube-router')).toEqual({});
    // A create can't borrow a stored value.
    expect(validateForm(form, 'create', 'kube-router').networkPolicyEngine).toBeDefined();
    // What the form refuses, the CRD refuses.
    expect(schemaErrors(buildPlatformInstance(form))).toEqual([]);
    expect(celErrors(buildPlatformInstance(form) as unknown as Subject)).toEqual([
      KUBE_ROUTER_MESSAGE,
    ]);
  });

  it('emulates the CRD rule: new kube-router refused, stored kube-router kept', () => {
    expect(celErrors(withEngine('existing'))).toEqual([]);
    expect(celErrors(withEngine())).toEqual([]);
    expect(celErrors(withEngine('kube-router'))).toEqual([KUBE_ROUTER_MESSAGE]);
    expect(celErrors(withEngine('kube-router'), withEngine('existing'))).toEqual([
      KUBE_ROUTER_MESSAGE,
    ]);
    expect(celErrors(withEngine('kube-router'), withEngine())).toEqual([KUBE_ROUTER_MESSAGE]);
    expect(celErrors(withEngine('kube-router', '6.0.18'), withEngine('kube-router'))).toEqual([]);
    expect(celErrors(withEngine('existing'), withEngine('kube-router'))).toEqual([]);
  });
});
