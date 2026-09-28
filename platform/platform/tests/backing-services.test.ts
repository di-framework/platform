import { describe, expect, it } from 'bun:test';
import {
  assertUniqueDefaults,
  backingServiceCrds,
  bindingMatchesService,
  CREDENTIAL_STATUS_KEYS,
  classVisibleToTenant,
  compatibleProvider,
  crds,
  DEFAULT_CLASS_NAMES,
  defaultClassName,
  defaultClassSeed,
  resolveClassName,
  statusContainsCredentials,
  VERSION,
  validateBindingSpec,
  validateClassSpec,
  validateServiceSpec,
} from '../src/tenancy/resources';

type Schema = {
  openAPIV3Schema: {
    properties: {
      spec: Record<string, unknown>;
      status: { properties: Record<string, unknown> };
    };
    'x-kubernetes-validations'?: { rule: string; message: string }[];
  };
};

function schemaFor(kind: string): Schema {
  const crd = crds.find((c) => (c.spec as { names: { kind: string } }).names.kind === kind);
  expect(crd).toBeDefined();
  if (!crd) throw new Error(`missing CRD ${kind}`);
  const version = (crd.spec as { versions: { schema: Schema }[] }).versions[0];
  expect(version).toBeDefined();
  if (!version) throw new Error(`missing schema for ${kind}`);
  return version.schema;
}

function rulesOf(spec: Record<string, unknown>): string[] {
  const validations = spec['x-kubernetes-validations'] as { rule: string }[] | undefined;
  return (validations ?? []).map((v) => v.rule);
}

describe('backing service CRDs', () => {
  it('registers three platform.di-framework.dev/v1alpha1 resources with correct scopes', () => {
    const kinds = backingServiceCrds.map(
      (c) => (c.spec as { names: { kind: string }; scope: string }).names.kind,
    );
    const scopes = Object.fromEntries(
      backingServiceCrds.map((c) => {
        const spec = c.spec as { names: { kind: string }; scope: string };
        return [spec.names.kind, spec.scope];
      }),
    );
    expect(kinds).toEqual(['BackingServiceClass', 'BackingService', 'ServiceBinding']);
    expect(scopes).toEqual({
      BackingServiceClass: 'Cluster',
      BackingService: 'Namespaced',
      ServiceBinding: 'Namespaced',
    });
    expect(crds.map((c) => (c.spec as { names: { kind: string } }).names.kind)).toEqual([
      'Tenant',
      'User',
      'BackingServiceClass',
      'BackingService',
      'ServiceBinding',
    ]);
    expect(VERSION).toBe('platform.di-framework.dev/v1alpha1');
  });

  it('constrains class type/provider enums, visibility, sizing schema, and immutability CEL', () => {
    const spec = schemaFor('BackingServiceClass').openAPIV3Schema.properties.spec;
    const properties = spec.properties as Record<
      string,
      { enum?: string[]; additionalProperties?: boolean }
    >;
    expect(spec.required).toEqual(['type', 'provider', 'visibility']);
    expect(properties.type?.enum).toEqual(['keyvalue', 'messaging', 'postgres']);
    expect(properties.provider?.enum).toEqual(['redis', 'nats', 'postgres']);
    expect(properties.visibility?.enum).toEqual(['AllTenants', 'SelectedTenants']);
    expect(properties.defaults?.additionalProperties).toBeUndefined();
    expect(properties.parametersSchema?.additionalProperties).toBeUndefined();
    const rules = rulesOf(spec);
    expect(rules.some((r) => r.includes('self.type == oldSelf.type'))).toBe(true);
    expect(rules.some((r) => r.includes('self.provider == oldSelf.provider'))).toBe(true);
    expect(
      rules.some((r) => r.includes("self.type == 'keyvalue' && self.provider == 'redis'")),
    ).toBe(true);
    expect(rules.some((r) => r.includes('SelectedTenants'))).toBe(true);
  });

  it('constrains BackingService parameters, retention default, and immutable type/className', () => {
    const spec = schemaFor('BackingService').openAPIV3Schema.properties.spec;
    const properties = spec.properties as Record<string, Record<string, unknown>>;
    expect(spec.required).toEqual(['type']);
    expect(properties.parameters?.additionalProperties).toBeUndefined();
    expect(properties.deletionPolicy).toEqual({
      type: 'string',
      enum: ['Retain', 'Delete'],
      default: 'Retain',
    });
    const rules = rulesOf(spec);
    expect(rules.some((r) => r.includes('self.type == oldSelf.type'))).toBe(true);
    expect(rules.some((r) => r.includes('className'))).toBe(true);
  });

  it('requires binding serviceName/bindingName/capability and documents same-namespace refs', () => {
    const root = schemaFor('ServiceBinding').openAPIV3Schema;
    const spec = root.properties.spec;
    expect(spec.required).toEqual(['serviceName', 'bindingName', 'capability']);
    const capability = (spec.properties as Record<string, { enum?: string[] }>).capability;
    expect(capability?.enum).toEqual(['keyvalue', 'messaging', 'postgres']);
    expect(root['x-kubernetes-validations']?.some((v) => v.rule.includes('serviceName'))).toBe(
      true,
    );
  });

  it('exposes status shape with observedGeneration and no credential fields', () => {
    for (const kind of ['BackingServiceClass', 'BackingService', 'ServiceBinding']) {
      const status = schemaFor(kind).openAPIV3Schema.properties.status.properties;
      expect(status.conditions).toBeDefined();
      expect(status.observedGeneration).toEqual({ type: 'integer', format: 'int64' });
      for (const key of CREDENTIAL_STATUS_KEYS) expect(status).not.toHaveProperty(key);
    }
    const serviceStatus = schemaFor('BackingService').openAPIV3Schema.properties.status.properties;
    expect(serviceStatus.endpoint).toBeDefined();
    expect(serviceStatus.classRef).toBeDefined();
    expect(serviceStatus.runtimeNamespace).toEqual({ type: 'string' });
    const endpointProps = (
      serviceStatus.endpoint as {
        properties: Record<string, unknown>;
        additionalProperties: boolean;
      }
    ).properties;
    expect(Object.keys(endpointProps).sort()).toEqual(['capability', 'host', 'port']);
    expect(
      (serviceStatus.endpoint as { additionalProperties: boolean }).additionalProperties,
    ).toBeUndefined();
  });
});

describe('backing service helpers', () => {
  it('resolves default class names and type/provider compatibility', () => {
    expect(DEFAULT_CLASS_NAMES).toEqual({
      keyvalue: 'keyvalue-redis',
      messaging: 'messaging-nats',
      postgres: 'postgres-dedicated',
    });
    expect(defaultClassName('keyvalue')).toBe('keyvalue-redis');
    expect(resolveClassName({ type: 'messaging' })).toBe('messaging-nats');
    expect(resolveClassName({ type: 'keyvalue', className: 'custom-kv' })).toBe('custom-kv');
    expect(compatibleProvider('keyvalue', 'redis')).toBe(true);
    expect(compatibleProvider('keyvalue', 'nats')).toBe(false);
    expect(compatibleProvider('messaging', 'nats')).toBe(true);
  });

  it('validates class visibility, defaults uniqueness, and sizing fields', () => {
    expect(
      validateClassSpec({
        type: 'keyvalue',
        provider: 'redis',
        visibility: 'AllTenants',
        defaults: { memory: '128Mi' },
      }),
    ).toBeUndefined();
    expect(
      validateClassSpec({ type: 'keyvalue', provider: 'nats', visibility: 'AllTenants' }),
    ).toBe('provider must match type (keyvalue+redis, messaging+nats or postgres+postgres)');
    expect(
      validateClassSpec({ type: 'messaging', provider: 'nats', visibility: 'SelectedTenants' }),
    ).toBe('allowedTenants is required when SelectedTenants');
    expect(
      validateClassSpec({
        type: 'messaging',
        provider: 'nats',
        visibility: 'SelectedTenants',
        allowedTenants: ['warehouse'],
      }),
    ).toBeUndefined();
    expect(
      classVisibleToTenant({ type: 'keyvalue', provider: 'redis', visibility: 'AllTenants' }, 'a'),
    ).toBe(true);
    expect(
      classVisibleToTenant(
        {
          type: 'keyvalue',
          provider: 'redis',
          visibility: 'SelectedTenants',
          allowedTenants: ['warehouse'],
        },
        'other',
      ),
    ).toBe(false);
    expect(
      assertUniqueDefaults([defaultClassSeed('keyvalue'), defaultClassSeed('messaging')]),
    ).toBeUndefined();
    expect(
      assertUniqueDefaults([
        defaultClassSeed('keyvalue'),
        { ...defaultClassSeed('keyvalue'), default: true },
      ]),
    ).toBe('at most one default BackingServiceClass is allowed per type (keyvalue)');
    expect(
      validateClassSpec({
        type: 'keyvalue',
        provider: 'redis',
        visibility: 'AllTenants',
        defaults: { image: 'redis:latest' } as never,
      }),
    ).toContain('not an allowed sizing field');
    expect(
      validateClassSpec({
        type: 'keyvalue',
        provider: 'redis',
        visibility: 'AllTenants',
        parametersSchema: { image: { min: '1' } } as never,
      }),
    ).toBe('parametersSchema.image is not an allowed sizing field');
    expect(
      validateClassSpec({
        type: 'keyvalue',
        provider: 'redis',
        visibility: 'AllTenants',
        parametersSchema: { storage: { min: '256Mi', max: '10Gi' }, memory: { min: '64Mi' } },
      }),
    ).toBeUndefined();
    expect(
      validateClassSpec({
        type: 'messaging',
        provider: 'nats',
        visibility: 'SelectedTenants',
        allowedTenants: ['Bad_Name'],
      }),
    ).toBe('allowedTenants must be valid tenant names');
  });

  it('validates services, bindings, sharing, and credential-free status', () => {
    expect(validateServiceSpec({ type: 'keyvalue', deletionPolicy: 'Retain' })).toBeUndefined();
    expect(
      validateServiceSpec({ type: 'keyvalue', parameters: { cpu: 'not-a-quantity' } }),
    ).toContain('quantity');
    expect(
      validateBindingSpec({ serviceName: 'stock', bindingName: 'stock', capability: 'keyvalue' }),
    ).toBeUndefined();
    expect(
      validateBindingSpec({ serviceName: 'STOCK', bindingName: 'stock', capability: 'keyvalue' }),
    ).toContain('serviceName');
    expect(
      bindingMatchesService(
        { serviceName: 'stock', capability: 'keyvalue' },
        { type: 'keyvalue', metadata: { name: 'stock' } },
      ),
    ).toBe(true);
    expect(
      bindingMatchesService(
        { serviceName: 'stock', capability: 'messaging' },
        { type: 'keyvalue', metadata: { name: 'stock' } },
      ),
    ).toBe(false);
    expect(
      statusContainsCredentials({
        observedGeneration: 1,
        endpoint: { host: 'di-redis.di-runtime-warehouse.svc', port: 6379, capability: 'keyvalue' },
      }),
    ).toBe(false);
    expect(statusContainsCredentials({ password: 'secret' })).toBe(true);
    expect(statusContainsCredentials({ endpoint: { url: 'redis://:pass@host' } })).toBe(true);
  });
});
