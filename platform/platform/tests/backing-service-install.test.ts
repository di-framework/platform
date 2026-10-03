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
/** Pulumi-like config that answers `backingServiceClasses` and `egressAllowedDestinations`. */
function config(seed: boolean | undefined, classes?: unknown, egress?: unknown) {
  return {
    getBoolean: () => seed,
    getObject: (key: string) =>
      key === 'backingServiceClasses'
        ? classes
        : key === 'egressAllowedDestinations'
          ? egress
          : undefined,
  };
}
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

  it('seeds platform-owned keyvalue, messaging, blobstore, postgres and egress default classes', () => {
    const seeds = defaultBackingServiceClasses();
    expect(seeds.map((c) => c.name).sort()).toEqual(
      [
        DEFAULT_CLASS_NAMES.keyvalue,
        DEFAULT_CLASS_NAMES.messaging,
        DEFAULT_CLASS_NAMES.blobstore,
        DEFAULT_CLASS_NAMES.postgres,
        DEFAULT_CLASS_NAMES.egress,
      ].sort(),
    );
    const providers = {
      postgres: 'postgres',
      keyvalue: 'redis',
      messaging: 'nats',
      blobstore: 'nats',
      egress: 'platform',
    };
    for (const seed of seeds) {
      expect(seed.visibility).toBe('AllTenants');
      expect(seed.default).toBe(true);
      expect(seed.provider).toBe(providers[seed.type] as typeof seed.provider);
    }
  });

  it('seeds egress-public from egressAllowedDestinations, approving nothing by default', () => {
    const egress = <T extends { name: string }>(classes: T[]) =>
      classes.find((c) => c.name === 'egress-public');
    expect(egress(defaultBackingServiceClasses())).toEqual({
      name: 'egress-public',
      type: 'egress',
      provider: 'platform',
      visibility: 'AllTenants',
      default: true,
      egress: { allowedDestinations: [] },
    });
    expect(egress(resolveBackingServiceClasses(config(undefined)))).toMatchObject({
      egress: { allowedDestinations: [] },
    });
    expect(
      egress(
        resolveBackingServiceClasses(
          config(undefined, undefined, ['mqtt.meshtastic.org:1883', '*.example.com:443']),
        ),
      ),
    ).toMatchObject({
      egress: { allowedDestinations: ['mqtt.meshtastic.org:1883', '*.example.com:443'] },
    });
    for (const bad of [
      'mqtt.meshtastic.org',
      ['mqtt.meshtastic.org'],
      ['Mqtt.example.com:1883'],
      ['host:0'],
      ['host:65536'],
      ['https://host:443'],
      [1883],
    ])
      expect(() => resolveBackingServiceClasses(config(undefined, undefined, bad))).toThrow(
        /egressAllowedDestinations/,
      );
  });

  it('resolves configurable class seeds from Pulumi-like config', () => {
    expect(resolveBackingServiceClasses(config(undefined))).toHaveLength(5);
    expect(resolveBackingServiceClasses(config(false))).toEqual([]);
    const custom = resolveBackingServiceClasses(
      config(true, [
        {
          name: 'keyvalue-redis',
          type: 'keyvalue' as const,
          provider: 'redis' as const,
          visibility: 'AllTenants' as const,
          default: true,
          defaults: { memory: '256Mi' },
        },
      ]),
    );
    expect(custom.find((c) => c.name === 'keyvalue-redis')?.defaults).toEqual({ memory: '256Mi' });
    expect(custom.map((c) => c.name).sort()).toEqual(
      [
        'keyvalue-redis',
        'messaging-nats',
        'blobstore-nats',
        'postgres-dedicated',
        'egress-public',
      ].sort(),
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
      'egress',
      'backing-services',
      'workload-storage',
      'resources',
      'backing-service-reconcile',
      'service-binding-reconcile',
      'postgres',
      'log-projection',
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
      'egress.js',
      'log-projection.js',
      'postgres.js',
      'resources.js',
      'service-binding-reconcile.js',
      'workload-storage.js',
    ]);
    expect(scripts['backing-services.js']).toContain('BackingServiceClass');
    expect(scripts['backing-services.js']).toContain('keyvalue-redis');
    expect(scripts['backing-services.js']).toContain('messaging-nats');
    expect(scripts['backing-service-reconcile.js']).toContain('di-bs-');
    expect(scripts['service-binding-reconcile.js']).toContain('di-binding-');
    expect(scripts['resources.js']).toMatch(/require\(["'].\/backing-services["']\)/);
    expect(scripts['controller.js']).toMatch(/require\(["'].\/resources["']\)/);
    expect(scripts['controller.js']).toMatch(/require\(["'].\/log-projection["']\)/);
    expect(scripts['controller.js']).toMatch(/require\(["'].\/backing-service-reconcile["']\)/);
    expect(scripts['controller.js']).toMatch(/require\(["'].\/service-binding-reconcile["']\)/);
    expect(scripts['controller.js']).toMatch(/require\(["'].\/egress["']\)/);
    expect(scripts['backing-services.js']).toMatch(/require\(["'].\/egress["']\)/);
    expect(controllerScriptHash(scripts)).toMatch(/^[a-f0-9]{64}$/);
    expect(controllerScriptHash(scripts)).toBe(controllerScriptHash(scripts));
    expect(controllerScriptHash({ a: '1' })).not.toBe(controllerScriptHash({ a: '2' }));
  });

  it('rejects non-array backingServiceClasses config', () => {
    expect(() => resolveBackingServiceClasses(config(false, { not: 'an-array' }))).toThrow(
      /must be an array/,
    );
  });

  it('rejects invalid backingServiceClasses config', () => {
    expect(() =>
      resolveBackingServiceClasses(
        config(false, [
          { name: 'Bad_Name', type: 'keyvalue', provider: 'redis', visibility: 'AllTenants' },
        ]),
      ),
    ).toThrow(/valid names/);
    expect(() =>
      resolveBackingServiceClasses(
        config(false, [
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
        ]),
      ),
    ).toThrow(/Duplicate/);
  });

  it('documents install ownership and ships install helpers from the package source', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('seeds the approved default classes');
    expect(readme).toContain('retainOnDelete');
    expect(readme).toContain('dist/tenancy');
    expect(readme).toContain('seedDefaultBackingClasses');
    expect(readme).toContain('egressAllowedDestinations');
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
