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
    expect(properties.type?.enum).toEqual([
      'keyvalue',
      'messaging',
      'blobstore',
      'postgres',
      'egress',
    ]);
    expect(properties.provider?.enum).toEqual(['redis', 'nats', 'postgres', 'platform']);
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
    expect(
      rules.some((r) => r.includes("(self.type == 'egress' && self.provider == 'platform')")),
    ).toBe(true);
    expect(rules.some((r) => r.includes('!has(self.egress)'))).toBe(true);
  });

  it('describes egress class policy, service destinations, approved status, and binding target', () => {
    const classProps = schemaFor('BackingServiceClass').openAPIV3Schema.properties.spec
      .properties as Record<string, { properties: Record<string, Record<string, unknown>> }>;
    const allowed = classProps.egress?.properties.allowedDestinations as {
      maxItems: number;
      items: { pattern: string; maxLength: number };
    };
    expect(allowed.maxItems).toBe(256);
    const policy = new RegExp(allowed.items.pattern);
    expect(policy.test('mqtt.meshtastic.org:1883')).toBe(true);
    expect(policy.test('*.example.com:443')).toBe(true);
    expect(policy.test('mqtt.meshtastic.org')).toBe(false);
    expect(policy.test('host:70000')).toBe(false);

    const service = schemaFor('BackingService').openAPIV3Schema.properties;
    const destinations = (service.spec.properties as Record<string, Record<string, unknown>>)
      .destinations as { maxItems: number; items: { pattern: string } };
    expect(destinations.maxItems).toBe(32);
    const destination = new RegExp(destinations.items.pattern);
    for (const ok of ['mqtt.meshtastic.org', '*.example.com', 'a.b:1883', '*.example.com:8443'])
      expect(destination.test(ok)).toBe(true);
    for (const bad of ['https://a.b', 'a.b/x', '*', '*foo.com', 'a.b:0', 'A.b'])
      expect(destination.test(bad)).toBe(false);
    expect(rulesOf(service.spec).some((r) => r.includes('has(self.destinations)'))).toBe(true);
    expect(service.status.properties.approved).toEqual({
      type: 'array',
      items: { type: 'string' },
    });

    const binding = schemaFor('ServiceBinding').openAPIV3Schema.properties.spec;
    expect(rulesOf(binding)).toEqual(["self.capability != 'egress' || has(self.workloadName)"]);
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
    expect(capability?.enum).toEqual(['keyvalue', 'messaging', 'blobstore', 'postgres', 'egress']);
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
      blobstore: 'blobstore-nats',
      postgres: 'postgres-dedicated',
      egress: 'egress-public',
    });
    expect(defaultClassName('keyvalue')).toBe('keyvalue-redis');
    expect(resolveClassName({ type: 'messaging' })).toBe('messaging-nats');
    expect(resolveClassName({ type: 'keyvalue', className: 'custom-kv' })).toBe('custom-kv');
    expect(compatibleProvider('keyvalue', 'redis')).toBe(true);
    expect(compatibleProvider('keyvalue', 'nats')).toBe(false);
    expect(compatibleProvider('messaging', 'nats')).toBe(true);
    expect(compatibleProvider('blobstore', 'nats')).toBe(true);
    expect(compatibleProvider('blobstore', 'redis')).toBe(false);
    expect(resolveClassName({ type: 'blobstore' })).toBe('blobstore-nats');
    expect(compatibleProvider('egress', 'platform')).toBe(true);
    expect(compatibleProvider('egress', 'nats')).toBe(false);
    expect(resolveClassName({ type: 'egress' })).toBe('egress-public');
  });

  it('validates egress classes, services, and bindings', () => {
    const egressClass = {
      type: 'egress' as const,
      provider: 'platform' as const,
      visibility: 'AllTenants' as const,
    };
    expect(validateClassSpec(egressClass)).toBeUndefined();
    expect(
      validateClassSpec({
        ...egressClass,
        egress: { allowedDestinations: ['mqtt.meshtastic.org:1883', '*.example.com:443'] },
      }),
    ).toBeUndefined();
    expect(
      validateClassSpec({ ...egressClass, egress: { allowedDestinations: ['example.com'] } }),
    ).toBe('egress.allowedDestinations entries must be host:port or *.suffix:port');
    expect(
      validateClassSpec({ ...egressClass, egress: { allowedDestinations: 'x' as never } }),
    ).toBe('egress.allowedDestinations entries must be host:port or *.suffix:port');
    expect(validateClassSpec({ ...egressClass, defaults: { memory: '1Gi' } })).toBe(
      'egress classes take no sizing or storage class',
    );
    expect(validateClassSpec({ ...egressClass, provider: 'nats' })).toBe(
      'provider must match type (keyvalue+redis, messaging+nats, blobstore+nats, postgres+postgres or egress+platform)',
    );
    expect(
      validateClassSpec({
        type: 'keyvalue',
        provider: 'redis',
        visibility: 'AllTenants',
        egress: { allowedDestinations: [] },
      }),
    ).toBe('egress is only valid for type egress');
    expect(validateClassSpec({ ...egressClass, provider: 'cloud' as never })).toBe(
      'provider must be redis, nats, postgres or platform',
    );
    expect(validateClassSpec({ ...egressClass, type: 'objects' as never })).toBe(
      'type must be keyvalue, messaging, blobstore, postgres or egress',
    );

    expect(
      validateServiceSpec({ type: 'egress', destinations: ['mqtt.meshtastic.org'] }),
    ).toBeUndefined();
    expect(validateServiceSpec({ type: 'egress' })).toBe(
      'egress services need at least one destination',
    );
    expect(validateServiceSpec({ type: 'egress', destinations: [] })).toBe(
      'egress services need at least one destination',
    );
    expect(validateServiceSpec({ type: 'egress', destinations: ['https://a.b'] })).toBe(
      'destinations must be host, *.suffix, host:port or *.suffix:port',
    );
    expect(
      validateServiceSpec({ type: 'egress', destinations: ['a.b'], parameters: { cpu: '1' } }),
    ).toBe('egress services take no sizing parameters');
    expect(validateServiceSpec({ type: 'keyvalue', destinations: ['a.b'] })).toBe(
      'destinations are only valid for type egress',
    );
    expect(validateServiceSpec({ type: 'objects' as never })).toBe(
      'type must be keyvalue, messaging, blobstore, postgres or egress',
    );

    const egressBinding = { serviceName: 'mesh-egress', bindingName: 'egress' };
    expect(
      validateBindingSpec({
        ...egressBinding,
        capability: 'egress',
        workloadName: 'mesh-collector',
      }),
    ).toBeUndefined();
    expect(validateBindingSpec({ ...egressBinding, capability: 'egress' })).toBe(
      'egress bindings need workloadName',
    );
    expect(validateBindingSpec({ ...egressBinding, capability: 'objects' as never })).toBe(
      'capability must be keyvalue, messaging, blobstore, postgres or egress',
    );
    expect(defaultClassSeed('egress', ['a.b:443'])).toEqual({
      type: 'egress',
      provider: 'platform',
      visibility: 'AllTenants',
      default: true,
      egress: { allowedDestinations: ['a.b:443'] },
    });
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
    ).toBe(
      'provider must match type (keyvalue+redis, messaging+nats, blobstore+nats, postgres+postgres or egress+platform)',
    );
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
