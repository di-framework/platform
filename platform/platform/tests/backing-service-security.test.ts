import { describe, expect, it } from 'bun:test';
import {
  admissionResources,
  approvedClassName,
  BINDING_CONFIG_PREFIX,
  BS_CONFIG_PREFIX,
  hostInterfaceAllowed,
  isManagedConfigName,
  isManagedSecretName,
  ownershipLabelsAllowed,
  STOCK_CONFIG_NAME,
  serviceNameSameNamespace,
  validateBackingServiceAdmission,
  validateServiceBindingAdmission,
} from '../src/tenancy/admission';
import {
  type ControllerConfig,
  GROUP,
  INSTALLATION,
  OWNER,
  TENANT,
  type Tenant,
  tenantResources,
  VERSION,
} from '../src/tenancy/resources';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  insecureRegistry: true,
};

function tenant(): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec: {},
  };
}

describe('backing-service managed name prefixes', () => {
  it('recognizes di-bs- and di-binding- controller prefixes plus transitional stock', () => {
    expect(isManagedConfigName(STOCK_CONFIG_NAME)).toBe(true);
    expect(isManagedConfigName(`${BS_CONFIG_PREFIX}stock`)).toBe(true);
    expect(isManagedConfigName(`${BINDING_CONFIG_PREFIX}sync`)).toBe(true);
    expect(isManagedConfigName('user-redis')).toBe(false);
    expect(isManagedSecretName(`${BINDING_CONFIG_PREFIX}sync`)).toBe(true);
    expect(isManagedSecretName(`${BS_CONFIG_PREFIX}creds`)).toBe(true);
    expect(isManagedSecretName('my-secret')).toBe(false);
  });
});

describe('hostInterfaceAllowed (fail-closed)', () => {
  it('allows wasi http/config without secrets or backend selection', () => {
    expect(
      hostInterfaceAllowed({ namespace: 'wasi', package: 'http', config: { host: '*' } }),
    ).toBe(true);
    expect(hostInterfaceAllowed({ namespace: 'wasi', package: 'config' })).toBe(true);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasi',
        package: 'http',
        name: 'named',
        config: { host: '*' },
      }),
    ).toBe(false);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasi',
        package: 'http',
        secretFrom: [{ name: 'x' }],
      }),
    ).toBe(false);
  });

  it('allows transitional stock and named di-bs-/di-binding- keyvalue refs', () => {
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'keyvalue',
        configFrom: [{ name: STOCK_CONFIG_NAME }],
      }),
    ).toBe(true);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'keyvalue',
        name: 'stock',
        configFrom: [{ name: STOCK_CONFIG_NAME }],
      }),
    ).toBe(true);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'keyvalue',
        name: 'stock',
        configFrom: [{ name: `${BS_CONFIG_PREFIX}stock` }],
      }),
    ).toBe(true);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'keyvalue',
        name: 'stock',
        secretFrom: [{ name: `${BINDING_CONFIG_PREFIX}stock` }],
      }),
    ).toBe(true);
  });

  it('denies arbitrary endpoint injection and forged config/secret refs', () => {
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'keyvalue',
        name: 'stock',
        config: { url: 'redis://evil:6379' },
        configFrom: [{ name: `${BS_CONFIG_PREFIX}stock` }],
      }),
    ).toBe(false);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'keyvalue',
        name: 'stock',
        configFrom: [{ name: 'user-owned-redis' }],
      }),
    ).toBe(false);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'keyvalue',
        name: 'stock',
        secretFrom: [{ name: 'forged-creds' }],
      }),
    ).toBe(false);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'keyvalue',
      }),
    ).toBe(false);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'messaging',
        configFrom: [{ name: 'evil-nats' }],
      }),
    ).toBe(false);
  });

  it('allows transitional unnamed messaging subscriptions without backend selection', () => {
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'messaging',
        config: { subscriptions: 'warehouse.stock' },
      }),
    ).toBe(true);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'messaging',
        name: 'sync',
        configFrom: [{ name: `${BS_CONFIG_PREFIX}events` }],
        config: { subscriptions: 'warehouse.stock' },
      }),
    ).toBe(true);
  });
});

describe('BackingService and ServiceBinding admission helpers', () => {
  it('rejects spoofed ownership labels and unknown classes (fail-closed)', () => {
    expect(ownershipLabelsAllowed({ [TENANT]: 'other' }, 'di-tenant-alpha', 'test')).toBe(false);
    expect(ownershipLabelsAllowed({ [OWNER]: 'uid' }, 'di-tenant-alpha', 'test')).toBe(false);
    expect(ownershipLabelsAllowed({ [TENANT]: 'alpha' }, 'di-tenant-alpha', 'test')).toBe(true);
    expect(
      ownershipLabelsAllowed({ [INSTALLATION]: 'other-install' }, 'di-tenant-alpha', 'test'),
    ).toBe(false);
    expect(ownershipLabelsAllowed(undefined, 'di-tenant-alpha')).toBe(true);
    expect(ownershipLabelsAllowed({}, 'not-a-tenant-ns')).toBe(false);
    expect(ownershipLabelsAllowed({ [INSTALLATION]: 'test' }, 'di-tenant-alpha', 'test')).toBe(
      true,
    );
    expect(approvedClassName(undefined, 'keyvalue')).toBe(true);
    expect(approvedClassName('', 'blobstore')).toBe(false);
    expect(approvedClassName('keyvalue-redis', 'keyvalue')).toBe(true);
    expect(approvedClassName('evil-class', 'keyvalue')).toBe(false);
    expect(
      validateBackingServiceAdmission({
        namespace: 'di-tenant-alpha',
        type: 'keyvalue',
        className: 'not-approved',
      }),
    ).toMatch(/approved platform default/);
    expect(
      validateBackingServiceAdmission({
        namespace: 'di-tenant-alpha',
        type: 'keyvalue',
        labels: { [TENANT]: 'beta' },
      }),
    ).toMatch(/ownership labels/);
    expect(
      validateBackingServiceAdmission({
        namespace: 'di-tenant-alpha',
        type: 'unknown',
      }),
    ).toMatch(/type must be/);
    expect(
      validateBackingServiceAdmission({
        namespace: 'di-tenant-alpha',
        type: 'messaging',
        className: 'messaging-nats',
      }),
    ).toBeUndefined();
  });

  it('rejects cross-namespace serviceName tricks on bindings', () => {
    expect(serviceNameSameNamespace('stock')).toBe(true);
    expect(serviceNameSameNamespace('other/stock')).toBe(false);
    expect(serviceNameSameNamespace('stock.other.svc')).toBe(false);
    expect(
      validateServiceBindingAdmission({
        namespace: 'di-tenant-alpha',
        serviceName: 'other/ns',
        capability: 'keyvalue',
      }),
    ).toMatch(/same namespace/);
    expect(
      validateServiceBindingAdmission({
        namespace: 'di-tenant-alpha',
        serviceName: 'stock',
        capability: 'blobstore',
      }),
    ).toMatch(/capability/);
    expect(
      validateServiceBindingAdmission({
        namespace: 'di-tenant-alpha',
        serviceName: 'stock',
        capability: 'keyvalue',
        labels: { [OWNER]: 'spoof' },
      }),
    ).toMatch(/ownership labels/);
    expect(
      validateServiceBindingAdmission({
        namespace: 'di-tenant-alpha',
        serviceName: 'stock',
        capability: 'messaging',
      }),
    ).toBeUndefined();
  });
});

describe('hostInterfaceAllowed edge denials', () => {
  it('denies unknown packages and empty named messaging without refs', () => {
    expect(hostInterfaceAllowed({ namespace: 'wasmcloud', package: 'secrets' })).toBe(false);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'messaging',
        name: 'empty',
      }),
    ).toBe(false);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'messaging',
        config: { url: 'nats://evil:4222' },
      }),
    ).toBe(false);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'messaging',
        name: 'sync',
        configFrom: [{ name: STOCK_CONFIG_NAME }],
      }),
    ).toBe(false);
    expect(
      hostInterfaceAllowed({
        namespace: 'wasmcloud',
        package: 'keyvalue',
        name: 'stock',
        configFrom: [{ name: STOCK_CONFIG_NAME }],
        secretFrom: [{ name: 'forged' }],
      }),
    ).toBe(false);
  });
});

describe('tenant RBAC, quotas, admission policies, and network isolation', () => {
  it('grants developers edit and viewers read for BackingService and ServiceBinding', () => {
    const resources = tenantResources(tenant(), cfg, { data: { 'tls.key': 'private' } });
    const developer = resources.find(
      (r) => r.kind === 'Role' && r.metadata.name === 'di-developer',
    ) as unknown as { rules: { apiGroups: string[]; resources: string[]; verbs: string[] }[] };
    const viewer = resources.find(
      (r) => r.kind === 'Role' && r.metadata.name === 'di-viewer',
    ) as unknown as {
      rules: { apiGroups: string[]; resources: string[]; verbs: string[] }[];
    };
    const devRule = developer.rules.find(
      (r) => r.apiGroups.includes(GROUP) && r.resources.includes('backingservices'),
    );
    const viewRule = viewer.rules.find(
      (r) => r.apiGroups.includes(GROUP) && r.resources.includes('servicebindings'),
    );
    expect(devRule?.resources).toEqual(['backingservices', 'servicebindings']);
    expect(devRule?.verbs).toEqual(
      expect.arrayContaining(['create', 'update', 'patch', 'delete', 'get', 'list', 'watch']),
    );
    expect(viewRule?.verbs).toEqual(['get', 'list', 'watch']);
    expect(JSON.stringify(developer.rules)).not.toContain('backingserviceclasses');
    expect(JSON.stringify(viewer.rules)).not.toContain('backingserviceclasses');
  });

  it('quotas concurrent BackingService and ServiceBinding counts plus runtime storage budget', () => {
    const resources = tenantResources(
      {
        ...tenant(),
        spec: { resources: { backingServices: 3, serviceBindings: 12, workloads: 5 } },
      },
      cfg,
    );
    const tenantQuota = resources.find(
      (r) => r.kind === 'ResourceQuota' && r.metadata.name === 'di-tenant-quota',
    ) as unknown as { spec: { hard: Record<string, string> } };
    const runtimeQuota = resources.find(
      (r) => r.kind === 'ResourceQuota' && r.metadata.name === 'di-runtime-quota',
    ) as unknown as { spec: { hard: Record<string, string> } };
    expect(tenantQuota.spec.hard[`count/backingservices.${GROUP}`]).toBe('3');
    expect(tenantQuota.spec.hard[`count/servicebindings.${GROUP}`]).toBe('12');
    expect(runtimeQuota.spec.hard['requests.storage']).toBe('50Gi');
  });

  it('publishes ValidatingAdmissionPolicies for workloads, reserved config, services, and CRs', () => {
    const policies = admissionResources('test', 'wasmcloud').filter(
      (r) => r.kind === 'ValidatingAdmissionPolicy',
    );
    const names = policies.map((p) => p.metadata.name).sort();
    expect(names).toEqual([
      'test-backend-config',
      'test-backingservices',
      'test-servicebindings',
      'test-services',
      'test-workloads',
    ]);
    const workloads = policies.find((p) => p.metadata.name === 'test-workloads');
    expect(workloads?.spec).toBeDefined();
    const expr = JSON.stringify(workloads?.spec);
    expect(expr).toContain(BS_CONFIG_PREFIX);
    expect(expr).toContain(BINDING_CONFIG_PREFIX);
    expect(expr).toContain(STOCK_CONFIG_NAME);
    const reserved = policies.find((p) => p.metadata.name === 'test-backend-config');
    expect(JSON.stringify(reserved?.spec)).toContain('secrets');
    expect(JSON.stringify(reserved?.spec)).toContain(BS_CONFIG_PREFIX);
    const bindings = policies.find((p) => p.metadata.name === 'test-servicebindings');
    expect(JSON.stringify(bindings?.spec)).toContain("contains('/')");
    expect(JSON.stringify(bindings).toLowerCase()).toContain('fail');
  });

  it('emits CEL expressions with balanced parentheses', () => {
    const policies = admissionResources('test', 'wasmcloud').filter(
      (resource) => resource.kind === 'ValidatingAdmissionPolicy',
    );
    for (const policy of policies) {
      const spec = policy.spec as {
        variables?: { expression: string }[];
        validations: { expression: string }[];
      };
      for (const { expression } of [...(spec.variables ?? []), ...spec.validations]) {
        // String literals may contain parentheses that are not CEL syntax.
        const syntax = expression.replace(/'[^']*'|"[^"]*"/g, '');
        let depth = 0;
        for (const character of syntax) {
          if (character === '(') depth++;
          if (character === ')') depth--;
          expect(depth).toBeGreaterThanOrEqual(0);
        }
        expect(depth).toBe(0);
      }
    }
  });

  it('isolates backing-service pods to hostgroup ingress while retaining port-forward RBAC', () => {
    const resources = tenantResources(tenant(), cfg, { data: { 'tls.key': 'x' } });
    const backendNet = resources.find(
      (r) => r.kind === 'NetworkPolicy' && r.metadata.name === 'di-bs-backend-network',
    ) as unknown as {
      spec: {
        podSelector: { matchLabels: Record<string, string> };
        ingress: { from: { podSelector?: { matchLabels: Record<string, string> } }[] }[];
      };
    };
    expect(backendNet.spec.podSelector.matchLabels[`${GROUP}/component`]).toBe('backing-service');
    expect(
      backendNet.spec.ingress[0]?.from[0]?.podSelector?.matchLabels['wasmcloud.com/name'],
    ).toBe('hostgroup');
    const redis = resources.find((r) => r.kind === 'Deployment' && r.metadata.name === 'di-redis');
    expect(JSON.stringify(redis)).toContain(`"${GROUP}/component":"backing-service"`);
    const runtimeDev = resources.find(
      (r) => r.kind === 'Role' && r.metadata.name === 'di-runtime-developer',
    );
    expect(JSON.stringify(runtimeDev)).toContain('pods/portforward');
  });

  it('keeps allowSharedHosts false contract out of tenant resource generation', () => {
    // allowSharedHosts lives in index.ts.tmpl operator values — never flipped by tenancy.
    const text = JSON.stringify(tenantResources(tenant(), cfg));
    expect(text).not.toContain('allowSharedHosts');
  });
});
