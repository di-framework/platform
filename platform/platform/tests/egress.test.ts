import { describe, expect, it, spyOn } from 'bun:test';
import {
  admissionResources,
  approvedClassName,
  validateBackingServiceAdmission,
  validateServiceBindingAdmission,
  workloadEgressAllowed,
} from '../src/tenancy/admission';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  approveEgress,
  EGRESS_FIELD_MANAGER,
  EGRESS_NETWORK_POLICY,
  egressAllowedHosts,
  egressGrants,
  egressLookups,
  egressNameCovers,
  egressNetworkPolicySpec,
  egressPatch,
  egressPorts,
  egressResolvableNames,
  isPublicIpv4,
  resolveIpv4,
  validEgressDestination,
  validEgressPolicyEntry,
} from '../src/tenancy/egress';
import { controllerClusterRoleRules } from '../src/tenancy/install';
import {
  type BackingService,
  type BackingServiceClass,
  type ControllerConfig,
  defaultClassSeed,
  FINALIZER,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  type ServiceBinding,
  type Tenant,
  VERSION,
} from '../src/tenancy/resources';
import {
  bindingHostInterfaceProjections,
  electBindingOwner,
  resolveEgressBindingService,
  sharedBindingConflict,
} from '../src/tenancy/service-binding-reconcile';
import type { WorkloadDeployment } from '../src/tenancy/workload-storage';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  insecureRegistry: true,
};
const NS = names('alpha').namespace;
const RUNTIME = names('alpha').runtimeNamespace;
const READY = [
  {
    type: 'Ready',
    status: 'True' as const,
    reason: 'Ready',
    message: '',
    observedGeneration: 1,
    lastTransitionTime: '2026-10-01T00:00:00Z',
  },
];
const WORKLOADS = collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', NS);
const POLICY = `${collection('networking.k8s.io/v1', 'NetworkPolicy', RUNTIME)}/${EGRESS_NETWORK_POLICY}`;

function tenant(spec: Tenant['spec'] = {}): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec,
  };
}

function egressClass(allowed: string[], extra: Partial<BackingServiceClass['spec']> = {}) {
  return {
    apiVersion: VERSION,
    kind: 'BackingServiceClass',
    metadata: { name: 'egress-public', uid: 'egress-class-uid', generation: 2 },
    spec: { ...defaultClassSeed('egress', allowed), ...extra },
  } as BackingServiceClass;
}

function service(destinations: string[], extra: Partial<BackingService> = {}): BackingService {
  return {
    apiVersion: VERSION,
    kind: 'BackingService',
    metadata: { name: 'mesh-collector-egress', namespace: NS, uid: 'svc-uid', generation: 1 },
    spec: { type: 'egress', destinations },
    ...extra,
  };
}

function approvedService(approved: string[], name = 'mesh-collector-egress'): BackingService {
  return {
    ...service(approved),
    metadata: { name, namespace: NS, uid: `${name}-uid`, generation: 1 },
    status: { conditions: READY, approved },
  };
}

function binding(
  name: string,
  spec: Partial<ServiceBinding['spec']> = {},
  extra: Partial<ServiceBinding> = {},
): ServiceBinding {
  return {
    apiVersion: VERSION,
    kind: 'ServiceBinding',
    metadata: { name, namespace: NS, uid: `${name}-uid`, generation: 1 },
    spec: {
      serviceName: 'mesh-collector-egress',
      bindingName: 'egress',
      capability: 'egress',
      workloadName: 'mesh-collector',
      ...spec,
    },
    ...extra,
  };
}

function readyBinding(name: string, spec: Partial<ServiceBinding['spec']> = {}): ServiceBinding {
  return binding(name, spec, { status: { conditions: READY } });
}

function workload(
  name: string,
  shape: { components?: Record<string, unknown>[]; service?: Record<string, unknown> } = {},
): WorkloadDeployment {
  return {
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'WorkloadDeployment',
    metadata: { name, namespace: NS, resourceVersion: '7' },
    spec: { template: { spec: { environment: NS, ...shape } } },
  } as WorkloadDeployment;
}

/** RFC 7386 merge patch, enough for the controller's own patches. */
function merge(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete result[key];
    else result[key] = merge(result[key], value);
  }
  return result;
}

class EgressApi implements Api {
  objects = new Map<string, Resource>();
  workloads: WorkloadDeployment[] = [];
  calls: { method: string; path: string; body?: unknown; contentType?: string }[] = [];
  async call<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
    this.calls.push({ method, path, body: structuredClone(body), contentType });
    const url = new URL(path, 'https://kubernetes');
    if (method === 'GET' && url.pathname === WORKLOADS)
      return { items: this.workloads.map((w) => structuredClone(w)) } as T;
    if (url.pathname.startsWith(`${WORKLOADS}/`) && method === 'PATCH') {
      const name = decodeURIComponent(url.pathname.slice(WORKLOADS.length + 1));
      const index = this.workloads.findIndex((w) => w.metadata.name === name);
      const { metadata: _metadata, ...patch } = body as Resource;
      this.workloads[index] = merge(this.workloads[index], patch) as WorkloadDeployment;
      return structuredClone(this.workloads[index]) as T;
    }
    const target = url.pathname.replace(/\/status$/, '');
    const existing = this.objects.get(target);
    if (method === 'GET') {
      if (!existing) throw new ApiError(404, 'Not found');
      return structuredClone(existing) as T;
    }
    if (method === 'DELETE') {
      this.objects.delete(target);
      return {} as T;
    }
    if (method === 'PATCH') {
      const value = merge(existing, body) as Resource;
      this.objects.set(target, value);
      return structuredClone(value) as T;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  }
  patchesTo(prefix: string) {
    return this.calls.filter((c) => c.method === 'PATCH' && c.path.startsWith(prefix));
  }
}

describe('egress entries', () => {
  it('accepts policy entries only with a port and destinations with an optional port', () => {
    for (const ok of ['mqtt.meshtastic.org:1883', '*.example.com:443', 'a:65535', '1.2.3.4:80'])
      expect(validEgressPolicyEntry(ok)).toBe(true);
    for (const bad of ['mqtt.meshtastic.org', 'a:0', 'a:65536', 'A.b:1', '*:443', 'a.b:1:2', 7])
      expect(validEgressPolicyEntry(bad)).toBe(false);
    expect(validEgressPolicyEntry(`${'a'.repeat(256)}:1`)).toBe(false);
    for (const ok of ['mqtt.meshtastic.org', '*.example.com', 'host:1883'])
      expect(validEgressDestination(ok)).toBe(true);
    for (const bad of ['https://a.b', 'a.b/', '*foo.com', '*', '-a.b', 'a_b'])
      expect(validEgressDestination(bad)).toBe(false);
  });

  it('matches names exactly or under a wildcard suffix', () => {
    expect(egressNameCovers('a.example.com', 'a.example.com')).toBe(true);
    expect(egressNameCovers('a.example.com', 'b.example.com')).toBe(false);
    expect(egressNameCovers('*.example.com', 'a.example.com')).toBe(true);
    expect(egressNameCovers('*.example.com', 'a.b.example.com')).toBe(true);
    expect(egressNameCovers('*.example.com', 'example.com')).toBe(false);
    expect(egressNameCovers('*.example.com', 'evilexample.com')).toBe(false);
    expect(egressNameCovers('*.example.com', '*.example.com')).toBe(true);
    expect(egressNameCovers('*.example.com', '*.a.example.com')).toBe(true);
    expect(egressNameCovers('*.a.example.com', '*.example.com')).toBe(false);
    expect(egressNameCovers('a.example.com', '*.example.com')).toBe(false);
  });

  it('approves covered destinations and resolves ports from the policy', () => {
    const policy = ['mqtt.meshtastic.org:1883', 'mqtt.meshtastic.org:8883', '*.example.com:443'];
    expect(approveEgress(['mqtt.meshtastic.org'], policy)).toEqual({
      approved: ['mqtt.meshtastic.org:1883', 'mqtt.meshtastic.org:8883'],
      denied: [],
    });
    expect(approveEgress(['mqtt.meshtastic.org:1883', 'api.example.com'], policy)).toEqual({
      approved: ['api.example.com:443', 'mqtt.meshtastic.org:1883'],
      denied: [],
    });
    expect(
      approveEgress(['mqtt.meshtastic.org:443', 'evil.org', 'bad/x', 'api.example.com'], policy),
    ).toEqual({
      approved: ['api.example.com:443'],
      denied: ['mqtt.meshtastic.org:443', 'evil.org', 'bad/x'],
    });
    // Malformed policy entries approve nothing.
    expect(approveEgress(['a.b'], ['a.b', 'a.b:x'])).toEqual({ approved: [], denied: ['a.b'] });
    expect(approveEgress(['a.b'], [])).toEqual({ approved: [], denied: ['a.b'] });
  });

  it('derives ports, lookups, and resolvable names', () => {
    const approved = ['*.example.com:443', 'mqtt.meshtastic.org:1883', 'mqtt.meshtastic.org:443'];
    expect(egressPorts(approved)).toEqual([443, 1883]);
    expect(egressLookups(approved)).toEqual(['*.example.com', 'mqtt.meshtastic.org']);
    expect(egressResolvableNames(approved)).toEqual(['mqtt.meshtastic.org']);
  });

  it('grants only public IPv4 addresses', () => {
    expect(isPublicIpv4('15.204.60.243')).toBe(true);
    expect(isPublicIpv4('172.32.0.1')).toBe(true);
    for (const ip of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '127.0.0.1',
      '::1',
      '1.2.3',
      '1.2.3.256',
      '01.2.3.4',
    ])
      expect(isPublicIpv4(ip)).toBe(false);
  });

  it('builds the entries wash checks for HTTP, lookups, and socket connects', () => {
    const addresses = new Map([
      ['mqtt.meshtastic.org', ['15.204.60.243', '10.0.0.5']],
      ['api.example.com', ['93.184.216.34']],
    ]);
    expect(
      egressAllowedHosts(
        ['api.example.com:443', 'mqtt.meshtastic.org:1883', 'plain.example.com:80', '*.x.org:443'],
        addresses,
      ),
    ).toEqual([
      '*.x.org:443',
      '15.204.60.243:1883',
      '93.184.216.34:443',
      'api.example.com:443',
      'http://plain.example.com',
      'https://*.x.org',
      'https://api.example.com',
      'mqtt.meshtastic.org:1883',
      'plain.example.com:80',
    ]);
    expect(egressAllowedHosts([], addresses)).toEqual([]);
  });

  it('resolves through the system resolver and drops private answers', async () => {
    expect(await resolveIpv4('8.8.8.8')).toEqual(['8.8.8.8']);
    expect(await resolveIpv4('localhost')).toEqual([]);
  });

  it('builds the tenant host NetworkPolicy for the approved ports', () => {
    expect(egressNetworkPolicySpec('tenant-alpha', [443, 1883])).toEqual({
      podSelector: {
        matchLabels: {
          'wasmcloud.com/hostgroup': 'tenant-alpha',
          'wasmcloud.com/name': 'hostgroup',
        },
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              ipBlock: {
                cidr: '0.0.0.0/0',
                except: [
                  '10.0.0.0/8',
                  '172.16.0.0/12',
                  '192.168.0.0/16',
                  '169.254.0.0/16',
                  '127.0.0.0/8',
                ],
              },
            },
          ],
          ports: [
            { protocol: 'TCP', port: 443 },
            { protocol: 'TCP', port: 1883 },
          ],
        },
      ],
    });
  });
});

describe('egressGrants', () => {
  it('grants Ready bindings of Ready egress services to their workload', () => {
    const services = new Map(
      [
        approvedService(['mqtt.meshtastic.org:1883']),
        approvedService(['api.example.com:443'], 'api'),
        { ...approvedService(['x.org:443'], 'pending'), status: { approved: ['x.org:443'] } },
        { ...approvedService(['y.org:443'], 'stock'), spec: { type: 'keyvalue' as const } },
        { ...approvedService([], 'empty'), status: { conditions: READY } },
      ].map((s) => [`${NS}/${s.metadata.name}`, s]),
    );
    const grants = egressGrants(
      NS,
      [
        readyBinding('a'),
        readyBinding('b', { serviceName: 'api' }),
        readyBinding('c', { serviceName: 'api', workloadName: 'mesh-site' }),
        readyBinding('d', { serviceName: 'pending', workloadName: 'other' }),
        readyBinding('e', { serviceName: 'stock', workloadName: 'other' }),
        readyBinding('f', { serviceName: 'missing', workloadName: 'other' }),
        readyBinding('g', { capability: 'keyvalue', workloadName: 'other' }),
        readyBinding('h', { workloadName: undefined }),
        binding('i', { workloadName: 'other' }),
        {
          ...readyBinding('j', { workloadName: 'other' }),
          metadata: { name: 'j', namespace: 'x' },
        },
        {
          ...readyBinding('k', { workloadName: 'other' }),
          metadata: { name: 'k', namespace: NS, deletionTimestamp: 'now' },
        },
        readyBinding('l', { serviceName: 'empty', workloadName: 'quiet' }),
      ],
      services,
    );
    expect(Object.fromEntries(grants)).toEqual({
      'mesh-collector': ['api.example.com:443', 'mqtt.meshtastic.org:1883'],
      'mesh-site': ['api.example.com:443'],
      quiet: [],
    });
  });
});

describe('egressPatch', () => {
  const hosts = ['15.204.60.243:1883', 'mqtt.meshtastic.org:1883'];
  const lookups = ['mqtt.meshtastic.org'];

  it('grants every component and keeps their other local resources', () => {
    const patch = egressPatch(
      workload('mesh-site', {
        components: [
          {
            name: 'a',
            localResources: { volumeMounts: [{ name: 'di-storage', mountPath: '/data' }] },
          },
          { name: 'b' },
        ],
      }),
      hosts,
      lookups,
    ) as Resource;
    expect(patch.metadata).toEqual({ name: 'mesh-site', namespace: NS, resourceVersion: '7' });
    expect(patch.spec).toEqual({
      template: {
        spec: {
          components: [
            {
              name: 'a',
              localResources: {
                volumeMounts: [{ name: 'di-storage', mountPath: '/data' }],
                allowedHosts: hosts,
                allowedIpNameLookups: lookups,
              },
            },
            { name: 'b', localResources: { allowedHosts: hosts, allowedIpNameLookups: lookups } },
          ],
        },
      },
    });
  });

  it('grants a service guest with a nested merge patch', () => {
    expect(
      (
        egressPatch(
          workload('mesh-collector', { service: { image: 'x' } }),
          hosts,
          lookups,
        ) as Resource
      ).spec,
    ).toEqual({
      template: {
        spec: {
          service: { localResources: { allowedHosts: hosts, allowedIpNameLookups: lookups } },
        },
      },
    });
  });

  it('is idempotent once applied and removes the fields when the grant goes away', () => {
    const granted = workload('mesh-collector', {
      components: [
        { name: 'a', localResources: { allowedHosts: hosts, allowedIpNameLookups: lookups } },
      ],
      service: { localResources: { allowedHosts: hosts, allowedIpNameLookups: lookups } },
    });
    expect(egressPatch(granted, hosts, lookups)).toBeUndefined();
    expect((egressPatch(granted, [], []) as Resource).spec).toEqual({
      template: {
        spec: {
          components: [{ name: 'a', localResources: {} }],
          service: { localResources: { allowedHosts: null, allowedIpNameLookups: null } },
        },
      },
    });
    // Nothing granted and nothing present: no patch.
    expect(
      egressPatch(workload('plain', { components: [{ name: 'a' }], service: {} }), [], []),
    ).toBeUndefined();
    expect(
      egressPatch(
        workload('plain', { components: [{ name: 'a', localResources: { allowedHosts: [] } }] }),
        [],
        [],
      ),
    ).toBeUndefined();
    expect(egressPatch({ metadata: { name: 'x' } }, hosts, lookups)).toBeUndefined();
  });
});

describe('egress binding helpers', () => {
  it('needs a Ready egress service and a target workload', () => {
    const ready = approvedService(['a.b:443']);
    expect(resolveEgressBindingService(binding('a'), ready)).toEqual({ service: ready });
    expect(resolveEgressBindingService(binding('a'), undefined)).toEqual({
      error: `BackingService mesh-collector-egress not found in namespace ${NS}`,
    });
    expect(
      resolveEgressBindingService(binding('a'), { ...ready, spec: { type: 'keyvalue' } }),
    ).toEqual({
      error: 'capability egress does not match BackingService mesh-collector-egress type keyvalue',
    });
    expect(resolveEgressBindingService(binding('a', { workloadName: undefined }), ready)).toEqual({
      error: 'egress bindings need spec.workloadName (the WorkloadDeployment to grant)',
    });
    expect(
      resolveEgressBindingService(binding('a'), {
        ...ready,
        metadata: { ...ready.metadata, deletionTimestamp: 'now' },
      }),
    ).toEqual({
      error: 'BackingService mesh-collector-egress is deleting; new associations are refused',
    });
    expect(resolveEgressBindingService(binding('a'), service(['a.b']))).toEqual({
      error: 'BackingService mesh-collector-egress is not approved',
    });
  });

  it('projects no host interface and never shares a projection', () => {
    expect(
      bindingHostInterfaceProjections({ bindingName: 'egress', capability: 'egress' }),
    ).toEqual([]);
    const kv = binding('cache', { capability: 'keyvalue', serviceName: 'cache' });
    const peers = [binding('a-egress'), binding('b-egress', { serviceName: 'other' }), kv];
    expect(sharedBindingConflict(kv, peers)).toBeUndefined();
    expect(electBindingOwner('egress', peers)).toBe(kv);
  });
});

describe('Controller egress services and bindings', () => {
  it('approves a service the class covers and lists the resolved entries', async () => {
    const api = new EgressApi();
    const svc = service(['mqtt.meshtastic.org']);
    await new Controller(api, cfg).reconcileBackingService(svc, tenant(), [
      egressClass(['mqtt.meshtastic.org:1883']),
    ]);
    expect(svc.metadata.finalizers).toEqual([FINALIZER]);
    expect(svc.status).toMatchObject({
      runtimeNamespace: RUNTIME,
      classRef: { name: 'egress-public', uid: 'egress-class-uid', generation: 2 },
      approved: ['mqtt.meshtastic.org:1883'],
      conditions: [{ type: 'Ready', status: 'True', reason: 'Ready' }],
    });
    // No backend is provisioned.
    expect(api.calls.some((c) => c.path.includes('/deployments/'))).toBe(false);
  });

  it('reports NotApproved naming the uncovered destinations', async () => {
    const api = new EgressApi();
    const svc = service(['mqtt.meshtastic.org', 'evil.org:25']);
    await new Controller(api, cfg).reconcileBackingService(svc, tenant(), [
      egressClass(['mqtt.meshtastic.org:1883']),
    ]);
    expect(svc.status?.approved).toEqual(['mqtt.meshtastic.org:1883']);
    expect(svc.status?.conditions?.[0]).toMatchObject({
      status: 'False',
      reason: 'NotApproved',
      message: 'BackingServiceClass egress-public does not approve evil.org:25',
    });
    // The default class approves nothing.
    const fresh = service(['mqtt.meshtastic.org']);
    await new Controller(api, cfg).reconcileBackingService(fresh, tenant(), [egressClass([])]);
    expect(fresh.status?.conditions?.[0]?.reason).toBe('NotApproved');
    const missingPolicy = service(['a.b']);
    await new Controller(api, cfg).reconcileBackingService(missingPolicy, tenant(), [
      {
        ...egressClass([]),
        spec: { type: 'egress', provider: 'platform', visibility: 'AllTenants' },
      },
    ]);
    expect(missingPolicy.status?.conditions?.[0]?.reason).toBe('NotApproved');
    const noDestinations = service([]);
    delete noDestinations.spec.destinations;
    await new Controller(api, cfg).reconcileBackingService(noDestinations, tenant(), [
      egressClass(['a.b:443']),
    ]);
    expect(noDestinations.status?.conditions?.[0]?.reason).toBe('Ready');
  });

  it('fails without a visible class and suspends with the tenant', async () => {
    const api = new EgressApi();
    const svc = service(['a.b']);
    await new Controller(api, cfg).reconcileBackingService(svc, tenant(), []);
    expect(svc.status?.conditions?.[0]).toMatchObject({
      reason: 'Failed',
      message: 'BackingServiceClass egress-public not found',
    });
    const suspended = service(['a.b']);
    await new Controller(api, cfg).reconcileBackingService(suspended, tenant({ suspended: true }), [
      egressClass(['a.b:443']),
    ]);
    expect(suspended.status?.conditions?.[0]).toMatchObject({
      status: 'False',
      reason: 'Suspended',
    });
  });

  it('marks a binding Ready for its workload and fails it without an approved service', async () => {
    const api = new EgressApi();
    const controller = new Controller(api, cfg);
    const ok = binding('mesh-collector-egress');
    await controller.reconcileServiceBinding(ok, tenant(), approvedService(['a.b:443']), [ok]);
    expect(ok.status).toMatchObject({
      serviceRef: { name: 'mesh-collector-egress', uid: 'mesh-collector-egress-uid' },
      conditions: [
        {
          status: 'True',
          reason: 'Ready',
          message: 'Egress granted to WorkloadDeployment mesh-collector',
        },
      ],
    });
    // No projection ConfigMap is written for egress.
    expect(api.calls.some((c) => c.path.includes('/configmaps/'))).toBe(false);
    const pending = binding('pending');
    await controller.reconcileServiceBinding(pending, tenant(), service(['a.b']), [pending]);
    expect(pending.status?.conditions?.[0]).toMatchObject({
      reason: 'Failed',
      message: 'BackingService mesh-collector-egress is not approved',
    });
    const suspended = binding('suspended');
    await controller.reconcileServiceBinding(
      suspended,
      tenant({ suspended: true }),
      approvedService(['a.b:443']),
      [suspended],
    );
    expect(suspended.status?.conditions?.[0]?.reason).toBe('Suspended');
  });

  it('revokes and releases a deleting binding', async () => {
    const api = new EgressApi();
    const deleting = binding('gone', {}, {});
    deleting.metadata.deletionTimestamp = 'now';
    deleting.metadata.finalizers = [FINALIZER];
    await new Controller(api, cfg).reconcileServiceBinding(deleting, tenant(), undefined, [
      deleting,
    ]);
    expect(deleting.status?.conditions?.[0]).toMatchObject({
      reason: 'Deleting',
      message: 'Egress grant revoked',
    });
    expect(deleting.metadata.finalizers).toEqual([]);
  });
});

describe('Controller.reconcileTenantEgress', () => {
  const services = new Map([
    [`${NS}/mesh-collector-egress`, approvedService(['mqtt.meshtastic.org:1883'])],
  ]);

  it('patches the granted workload under its own field manager and opens the ports', async () => {
    const api = new EgressApi();
    api.workloads = [
      workload('mesh-collector', { service: { image: 'collector' } }),
      workload('mesh-site', { components: [{ name: 'site' }] }),
    ];
    const resolved: string[] = [];
    const controller = new Controller(api, cfg, async (name) => {
      resolved.push(name);
      return ['15.204.60.243'];
    });
    await controller.reconcileTenantEgress(
      tenant(),
      [readyBinding('mesh-collector-egress')],
      services,
    );
    expect(resolved).toEqual(['mqtt.meshtastic.org']);
    const patches = api.patchesTo(WORKLOADS);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe(
      `${WORKLOADS}/mesh-collector?fieldManager=${EGRESS_FIELD_MANAGER}`,
    );
    expect(patches[0]?.contentType).toBe('application/merge-patch+json');
    expect(api.workloads[0]?.spec?.template?.spec?.service).toEqual({
      image: 'collector',
      localResources: {
        allowedHosts: ['15.204.60.243:1883', 'mqtt.meshtastic.org:1883'],
        allowedIpNameLookups: ['mqtt.meshtastic.org'],
      },
    });
    const policy = api.objects.get(POLICY) as Resource;
    expect(policy.metadata.labels).toMatchObject({
      [INSTALLATION]: 'test',
      [OWNER]: 'alpha-uid',
    });
    expect(policy.spec).toEqual(egressNetworkPolicySpec('tenant-alpha', [1883]));

    // A second tick changes nothing on the workload.
    api.calls = [];
    await controller.reconcileTenantEgress(
      tenant(),
      [readyBinding('mesh-collector-egress')],
      services,
    );
    expect(api.patchesTo(WORKLOADS)).toHaveLength(0);
  });

  it('puts the fields back after a redeploy drops them', async () => {
    const api = new EgressApi();
    api.workloads = [workload('mesh-collector', { components: [{ name: 'c' }] })];
    const controller = new Controller(api, cfg, async () => ['15.204.60.243']);
    const grants = [readyBinding('mesh-collector-egress')];
    await controller.reconcileTenantEgress(tenant(), grants, services);
    api.workloads = [workload('mesh-collector', { components: [{ name: 'c' }] })];
    await controller.reconcileTenantEgress(tenant(), grants, services);
    expect(api.patchesTo(WORKLOADS)).toHaveLength(2);
    expect(api.workloads[0]?.spec?.template?.spec?.components?.[0]?.localResources).toEqual({
      allowedHosts: ['15.204.60.243:1883', 'mqtt.meshtastic.org:1883'],
      allowedIpNameLookups: ['mqtt.meshtastic.org'],
    });
  });

  it('removes the grant and the NetworkPolicy when no Ready binding remains', async () => {
    const api = new EgressApi();
    api.workloads = [workload('mesh-collector', { service: {} })];
    const controller = new Controller(api, cfg, async () => ['15.204.60.243']);
    await controller.reconcileTenantEgress(
      tenant(),
      [readyBinding('mesh-collector-egress')],
      services,
    );
    expect(api.objects.has(POLICY)).toBe(true);
    await controller.reconcileTenantEgress(tenant(), [], services);
    expect(api.workloads[0]?.spec?.template?.spec?.service).toEqual({ localResources: {} });
    expect(api.objects.has(POLICY)).toBe(false);
    // Nothing left to remove.
    api.calls = [];
    await controller.reconcileTenantEgress(tenant(), [], services);
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('leaves a NetworkPolicy it does not own', async () => {
    const api = new EgressApi();
    api.objects.set(POLICY, {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: EGRESS_NETWORK_POLICY,
        namespace: RUNTIME,
        labels: { [INSTALLATION]: 'other' },
      },
    });
    await new Controller(api, cfg).reconcileTenantEgress(tenant(), [], services);
    expect(api.objects.has(POLICY)).toBe(true);
    api.objects.set(POLICY, {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: EGRESS_NETWORK_POLICY,
        namespace: RUNTIME,
        labels: { [INSTALLATION]: 'test', [OWNER]: 'someone-else' },
      },
    });
    await new Controller(api, cfg).reconcileTenantEgress(tenant(), [], services);
    expect(api.objects.has(POLICY)).toBe(true);
  });

  it('keeps the last answer when a lookup fails', async () => {
    const api = new EgressApi();
    api.workloads = [workload('mesh-collector', { service: {} })];
    let fail: unknown;
    const controller = new Controller(api, cfg, async () => {
      if (fail) throw fail;
      return ['15.204.60.243'];
    });
    const grants = [readyBinding('mesh-collector-egress')];
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await controller.reconcileTenantEgress(tenant(), grants, services);
      fail = new Error('ENOTFOUND');
      api.calls = [];
      await controller.reconcileTenantEgress(tenant(), grants, services);
      expect(api.patchesTo(WORKLOADS)).toHaveLength(0);
      expect(errors).toHaveBeenCalledWith('egress: cannot resolve mqtt.meshtastic.org: ENOTFOUND');
      // Never resolved: only the name entries are granted.
      const fresh = new Controller(api, cfg, async () => {
        throw 'down';
      });
      await fresh.reconcileTenantEgress(tenant(), grants, services);
      expect(errors).toHaveBeenCalledWith(
        'egress: cannot resolve mqtt.meshtastic.org: lookup failed',
      );
      expect(api.workloads[0]?.spec?.template?.spec?.service).toEqual({
        localResources: {
          allowedHosts: ['mqtt.meshtastic.org:1883'],
          allowedIpNameLookups: ['mqtt.meshtastic.org'],
        },
      });
    } finally {
      errors.mockRestore();
    }
  });

  it('treats a missing list body as no workloads', async () => {
    const api = new EgressApi();
    const empty = {
      call: (method: string, path: string, body?: unknown, type?: string) =>
        path === WORKLOADS ? Promise.resolve(undefined) : api.call(method, path, body, type),
    } as Api;
    await new Controller(empty, cfg).reconcileTenantEgress(tenant(), [], services);
    expect(api.objects.size).toBe(0);
  });

  it('runs from tick after bindings and never blocks reconciliation', async () => {
    const controller = new Controller(new EgressApi(), cfg);
    const egress = spyOn(controller, 'reconcileTenantEgress').mockRejectedValue(new Error('no'));
    spyOn(controller, 'reconcileWorkloadStorage').mockResolvedValue();
    spyOn(controller, 'projectLogs').mockResolvedValue();
    spyOn(controller, 'reconcileTenant').mockResolvedValue();
    const bindingReconcile = spyOn(controller, 'reconcileServiceBinding').mockResolvedValue();
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const egressBinding = readyBinding('mesh-collector-egress');
    const listing = spyOn(
      controller as unknown as { list: (...args: unknown[]) => Promise<unknown[]> },
      'list',
    ).mockImplementation(async (_v: unknown, kind: unknown) =>
      kind === 'Tenant'
        ? [
            tenant(),
            {
              ...tenant(),
              metadata: { ...tenant().metadata, name: 'quiet' },
              spec: { suspended: true },
            },
          ]
        : kind === 'ServiceBinding'
          ? [egressBinding]
          : [],
    );
    try {
      await controller.tick();
      expect(egress).toHaveBeenCalledTimes(1);
      expect(egress.mock.calls[0]?.[1]).toEqual([egressBinding]);
      expect(bindingReconcile.mock.invocationCallOrder[0]).toBeLessThan(
        egress.mock.invocationCallOrder[0] as number,
      );
      expect(errors).toHaveBeenCalledWith('Tenant/alpha egress: no');
      egress.mockRejectedValue('not an error');
      await controller.tick();
      expect(errors).toHaveBeenCalledWith('Tenant/alpha egress: Egress reconcile failed');
    } finally {
      listing.mockRestore();
      errors.mockRestore();
    }
  });
});

describe('egress admission and install', () => {
  const tenantUser = 'system:serviceaccount:wasmcloud:di-user-dev';
  const controllerUser = 'system:serviceaccount:wasmcloud:di-platform-controller';
  const granted = {
    allowedHosts: ['15.204.60.243:1883', 'mqtt.meshtastic.org:1883'],
    allowedIpNameLookups: ['mqtt.meshtastic.org'],
  };
  const base = { controllerNamespace: 'wasmcloud' };

  it('denies tenant-authored egress', () => {
    for (const local of [
      { allowedHosts: ['*'] },
      { allowedIpNameLookups: ['mqtt.meshtastic.org'] },
      granted,
    ])
      expect(
        workloadEgressAllowed({
          ...base,
          username: tenantUser,
          operation: 'CREATE',
          locals: [local],
        }),
      ).toBe(false);
    // Widening the controller's grant on update is denied.
    expect(
      workloadEgressAllowed({
        ...base,
        username: tenantUser,
        operation: 'UPDATE',
        oldLocals: [granted],
        locals: [{ ...granted, allowedHosts: [...granted.allowedHosts, '1.1.1.1:22'] }],
      }),
    ).toBe(false);
    expect(
      workloadEgressAllowed({
        ...base,
        username: tenantUser,
        operation: 'UPDATE',
        oldLocals: [{}],
        locals: [{ allowedIpNameLookups: ['*'] }],
      }),
    ).toBe(false);
  });

  it('lets a tenant update keep or drop the grant, and the controller set it', () => {
    for (const locals of [[granted], [{}], [granted, {}], []])
      expect(
        workloadEgressAllowed({
          ...base,
          username: tenantUser,
          operation: 'UPDATE',
          oldLocals: [granted],
          locals,
        }),
      ).toBe(true);
    expect(
      workloadEgressAllowed({ ...base, username: tenantUser, operation: 'UPDATE', locals: [{}] }),
    ).toBe(true);
    expect(
      workloadEgressAllowed({
        ...base,
        username: controllerUser,
        operation: 'CREATE',
        locals: [granted],
      }),
    ).toBe(true);
  });

  it('expresses the same rules in CEL', () => {
    const policy = admissionResources('test', 'wasmcloud').find(
      (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === 'test-workloads',
    ) as Resource;
    const spec = policy.spec as {
      variables: { name: string; expression: string }[];
      validations: { expression: string; message: string }[];
    };
    const oldLocals = spec.variables.find((v) => v.name === 'oldLocals')?.expression;
    expect(oldLocals).toContain("request.operation != 'UPDATE' ? [] :");
    expect(oldLocals).toContain('oldObject.spec.template.spec.service.localResources');
    const egress = spec.validations.find((v) => v.message.includes('allowedIpNameLookups'));
    expect(egress?.expression).toContain('variables.controller || variables.locals.all(l,');
    expect(egress?.expression).toContain(
      'variables.oldLocals.exists(o, has(o.allowedHosts) && o.allowedHosts == l.allowedHosts)',
    );
    expect(egress?.expression).toContain('o.allowedIpNameLookups == l.allowedIpNameLookups');
    const network = spec.validations.find((v) => v.message.includes('network or host filesystem'));
    expect(network?.expression).not.toContain('allowedHosts');
    expect(network?.expression).toContain('allowedHostLoopbackPorts');
    const all = JSON.stringify(admissionResources('test', 'wasmcloud'));
    expect(all).toContain("'egress-public'");
    expect(all).toContain("object.spec.capability != 'egress'");
  });

  it('admits egress services and requires a workload on egress bindings', () => {
    expect(approvedClassName('', 'egress')).toBe(true);
    expect(approvedClassName('egress-public', 'egress')).toBe(true);
    expect(approvedClassName('egress-open', 'egress')).toBe(false);
    expect(
      validateBackingServiceAdmission({
        namespace: NS,
        type: 'egress',
        className: 'egress-public',
      }),
    ).toBeUndefined();
    expect(validateBackingServiceAdmission({ namespace: NS, type: 'objects' })).toBe(
      'BackingService type must be keyvalue, messaging, blobstore, postgres or egress',
    );
    expect(
      validateServiceBindingAdmission({
        namespace: NS,
        serviceName: 'mesh-collector-egress',
        capability: 'egress',
        workloadName: 'mesh-collector',
      }),
    ).toBeUndefined();
    expect(
      validateServiceBindingAdmission({
        namespace: NS,
        serviceName: 'mesh-collector-egress',
        capability: 'egress',
      }),
    ).toBe('An egress ServiceBinding must name its WorkloadDeployment in workloadName');
  });

  it('needs no new controller permissions', () => {
    const rules = controllerClusterRoleRules();
    expect(rules.find((r) => r.resources.includes('workloaddeployments'))?.verbs).toContain(
      'patch',
    );
    expect(rules.find((r) => r.resources.includes('networkpolicies'))?.verbs).toEqual(
      expect.arrayContaining(['get', 'patch', 'delete']),
    );
  });
});
