import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTROLLER_SCRIPT_MODULES,
  controllerClusterRoleRules,
  controllerScriptHash,
  defaultBackingServiceClasses,
  loadControllerScripts,
  resolveBackingServiceClasses,
} from '../src/tenancy/install';
import { crds, DEFAULT_CLASS_NAMES } from '../src/tenancy/resources';

const root = join(import.meta.dir, '..');
const distTenancy = join(root, 'dist', 'tenancy');

describe('backing-service install', () => {
  it('includes backing-service CRDs with status subresources in the platform crds list', () => {
    const kinds = crds.map((c) => (c as { spec: { names: { kind: string } } }).spec.names.kind);
    expect(kinds).toContain('BackingServiceClass');
    expect(kinds).toContain('BackingService');
    expect(kinds).toContain('ServiceBinding');
    for (const kind of ['BackingServiceClass', 'BackingService', 'ServiceBinding']) {
      const crd = crds.find(
        (c) => (c as { spec: { names: { kind: string } } }).spec.names.kind === kind,
      ) as {
        kind: string;
        spec: { versions: { subresources?: { status?: object }; schema: unknown }[] };
      };
      expect(crd.kind).toBe('CustomResourceDefinition');
      expect(crd.spec.versions[0]?.subresources?.status).toEqual({});
    }
  });

  it('seeds platform-owned Redis keyvalue and NATS messaging default classes', () => {
    const seeds = defaultBackingServiceClasses();
    expect(seeds.map((c) => c.name).sort()).toEqual(
      [
        DEFAULT_CLASS_NAMES.keyvalue,
        DEFAULT_CLASS_NAMES.messaging,
        DEFAULT_CLASS_NAMES.postgres,
      ].sort(),
    );
    for (const seed of seeds) {
      expect(seed.visibility).toBe('AllTenants');
      expect(seed.default).toBe(true);
      expect(seed.provider).toBe(
        seed.type === 'postgres' ? 'postgres' : seed.type === 'keyvalue' ? 'redis' : 'nats',
      );
    }
  });

  it('resolves configurable class seeds from Pulumi-like config', () => {
    expect(
      resolveBackingServiceClasses({ getBoolean: () => undefined, getObject: () => undefined }),
    ).toHaveLength(3);
    expect(
      resolveBackingServiceClasses({
        getBoolean: () => false,
        getObject: () => undefined,
      }),
    ).toEqual([]);
    const custom = resolveBackingServiceClasses({
      getBoolean: () => true,
      getObject: () => [
        {
          name: 'keyvalue-redis',
          type: 'keyvalue' as const,
          provider: 'redis' as const,
          visibility: 'AllTenants' as const,
          default: true,
          defaults: { memory: '256Mi' },
        },
      ],
    });
    expect(custom.find((c) => c.name === 'keyvalue-redis')?.defaults).toEqual({ memory: '256Mi' });
    expect(custom.map((c) => c.name).sort()).toEqual(
      ['keyvalue-redis', 'messaging-nats', 'postgres-dedicated'].sort(),
    );
  });

  it('extends controller ClusterRole rules for backing-service resources', () => {
    const platform = controllerClusterRoleRules().find((r) =>
      r.apiGroups.includes('platform.di-framework.dev'),
    );
    expect(platform?.resources).toEqual(
      expect.arrayContaining([
        'backingserviceclasses',
        'backingservices',
        'servicebindings',
        'backingserviceclasses/status',
        'backingservices/status',
        'servicebindings/status',
        'backingserviceclasses/finalizers',
        'backingservices/finalizers',
        'servicebindings/finalizers',
      ]),
    );
  });

  it('loads compiled backing-services into the controller ConfigMap script map', () => {
    expect([...CONTROLLER_SCRIPT_MODULES]).toEqual([
      'backing-services',
      'resources',
      'backing-service-reconcile',
      'service-binding-reconcile',
      'postgres',
      'controller',
    ]);
    for (const name of CONTROLLER_SCRIPT_MODULES) {
      expect(existsSync(join(distTenancy, `${name}.js`))).toBe(true);
    }
    const scripts = loadControllerScripts(distTenancy);
    expect(Object.keys(scripts).sort()).toEqual([
      'backing-service-reconcile.js',
      'backing-services.js',
      'controller.js',
      'postgres.js',
      'resources.js',
      'service-binding-reconcile.js',
    ]);
    expect(scripts['backing-services.js']).toContain('BackingServiceClass');
    expect(scripts['backing-services.js']).toContain('keyvalue-redis');
    expect(scripts['backing-services.js']).toContain('messaging-nats');
    expect(scripts['backing-service-reconcile.js']).toContain('di-bs-');
    expect(scripts['service-binding-reconcile.js']).toContain('di-binding-');
    expect(scripts['resources.js']).toMatch(/require\(["'].\/backing-services["']\)/);
    expect(scripts['controller.js']).toMatch(/require\(["'].\/resources["']\)/);
    expect(scripts['controller.js']).toMatch(/require\(["'].\/backing-service-reconcile["']\)/);
    expect(scripts['controller.js']).toMatch(/require\(["'].\/service-binding-reconcile["']\)/);
    expect(controllerScriptHash(scripts)).toMatch(/^[a-f0-9]{64}$/);
    expect(controllerScriptHash(scripts)).toBe(controllerScriptHash(scripts));
    expect(controllerScriptHash({ a: '1' })).not.toBe(controllerScriptHash({ a: '2' }));
  });

  it('rejects non-array backingServiceClasses config', () => {
    expect(() =>
      resolveBackingServiceClasses({
        getBoolean: () => false,
        getObject: () => ({ not: 'an-array' }),
      }),
    ).toThrow(/must be an array/);
  });

  it('rejects invalid backingServiceClasses config', () => {
    expect(() =>
      resolveBackingServiceClasses({
        getBoolean: () => false,
        getObject: () => [
          { name: 'Bad_Name', type: 'keyvalue', provider: 'redis', visibility: 'AllTenants' },
        ],
      }),
    ).toThrow(/valid names/);
    expect(() =>
      resolveBackingServiceClasses({
        getBoolean: () => false,
        getObject: () => [
          {
            name: 'keyvalue-redis',
            type: 'keyvalue',
            provider: 'redis',
            visibility: 'AllTenants',
          },
          {
            name: 'keyvalue-redis',
            type: 'keyvalue',
            provider: 'redis',
            visibility: 'AllTenants',
          },
        ],
      }),
    ).toThrow(/Duplicate/);
  });

  it('documents install ownership and ships install helpers from the package source', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('seeds the approved default classes');
    expect(readme).toContain('retainOnDelete');
    expect(readme).toContain('dist/tenancy');
    expect(readme).toContain('seedDefaultBackingClasses');
    const install = readFileSync(join(root, 'src/tenancy/install.ts'), 'utf8');
    expect(install).toContain('CONTROLLER_SCRIPT_MODULES');
    expect(install).toContain('backing-services');
    expect(install).toContain('backingserviceclasses');
    expect(install).toContain('loadControllerScripts');
    const tenancy = readFileSync(join(root, 'src/tenancy.ts'), 'utf8');
    expect(tenancy).toContain('retainOnDelete');
    expect(tenancy).toContain('BackingServiceClass');
    expect(tenancy).toContain('defaultBackingServiceClasses');
    const index = readFileSync(join(root, 'src/index.ts'), 'utf8');
    expect(index).toContain('resolveBackingServiceClasses');
  });
});
