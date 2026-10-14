import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { MEMBERS_CONFIG, publishedMembers } from '../../tenant-auth/src/kube';
import { admissionResources } from '../src/tenancy/admission';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  CONTROLLER_SCRIPT_MODULES,
  type ControllerClusterRoleRule,
  controllerClusterRoleRules,
  controllerNamespaceRoleRules,
} from '../src/tenancy/install';
import {
  type ControllerConfig,
  INSTALLATION,
  OWNER,
  REGISTRY_PULL_SECRET,
  type Resource,
  TENANT_MEMBERS_CONFIG,
  type Tenant,
  type TenantAuthInputs,
  tenantAuthResources,
  tenantResources,
  type User,
  userResources,
  VERSION,
} from '../src/tenancy/resources';
import { caCertificate, leafCertificate } from '../src/tenancy/tls';

// #115: the platform controller writes tenant RBAC without `escalate` and binds only named Roles.
// Everything below is computed from the objects the controller renders, so a new Role, binding
// or rule that the controller could not create on a real API server fails here.

const RBAC_GROUP = 'rbac.authorization.k8s.io';
const LOG_READER = 'di-platform-log-reader';
type Rule = ControllerClusterRoleRule;
type RoleRef = { apiGroup: string; kind: 'Role' | 'ClusterRole'; name: string };

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  tenantAuth: {
    image: `ghcr.io/di-framework/tenant-auth@sha256:${'a'.repeat(64)}`,
    issuer: 'http://identity.alpha.localhost:28180',
    oauthClient: { id: 'access', secretName: 'tenant-auth-oauth' },
    consolePublicUrl: 'http://console.{tenant}.localhost:28180',
  },
};
const ready = [
  {
    type: 'Ready' as const,
    status: 'True' as const,
    observedGeneration: 1,
    reason: 'Reconciled',
    message: '',
    lastTransitionTime: '2026-01-01T00:00:00Z',
  },
];
function tenant(name: string): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: { name, uid: `${name}-uid`, generation: 1, labels: { [INSTALLATION]: 'test' } },
    spec: {},
    status: { conditions: ready },
  };
}
function user(name: string, role: 'developer' | 'viewer', tenants: string[]): User {
  return {
    apiVersion: VERSION,
    kind: 'User',
    metadata: { name, uid: `${name}-uid`, generation: 1, labels: { [INSTALLATION]: 'test' } },
    spec: { memberships: tenants.map((t) => ({ tenant: t, role })) },
  };
}
const ca = caCertificate('tenant-controller CA', 3650);
const leaf = leafCertificate('tenant-controller', ['tenant-controller'], [], 30, ca.cert, ca.key);
const member = (name: string, suspended = false) =>
  ({ name, role: 'developer', suspended }) as const;
const inputs: TenantAuthInputs = {
  members: [member('alice'), member('bob'), member('carol', true)],
  apiServer: { addresses: ['10.0.0.1'], port: 6443 },
  tls: { ...leaf, caCert: ca.cert, caKey: ca.key },
  clientSecret: 'c2VjcmV0',
};

/** Every RBAC object the controller writes for these tenants and their members. */
function rendered(names: string[]): Resource[] {
  const tenants = names.map(tenant);
  const users = [user('alice', 'developer', names), user('bob', 'viewer', names)];
  return [
    ...tenants.flatMap((t) => [
      ...tenantResources(t, cfg),
      ...tenantResources(t, cfg, undefined, [], true, true, true),
      ...tenantAuthResources(t, cfg, inputs),
    ]),
    ...users.flatMap((u) => userResources(u, tenants, cfg)),
  ].filter((r) => r.apiVersion.startsWith(`${RBAC_GROUP}/`));
}

const matches = (values: string[], value: string) => values.includes(value) || values.includes('*');
/** The RBAC authorizer's rule match for one request attribute set. */
function allows(rules: Rule[], group: string, resource: string, verb: string, name?: string) {
  return rules.some(
    (r) =>
      matches(r.apiGroups, group) &&
      matches(r.resources, resource) &&
      matches(r.verbs, verb) &&
      (!r.resourceNames?.length || (name !== undefined && r.resourceNames.includes(name))),
  );
}
/** Whether `held` covers all of `granted`, as the API server's escalation check requires. */
function covers(held: Rule[], granted: Rule): boolean {
  return granted.apiGroups.every((g) =>
    granted.resources.every((r) =>
      granted.verbs.every((v) =>
        granted.resourceNames?.length
          ? granted.resourceNames.every((n) => allows(held, g, r, v, n))
          : allows(held, g, r, v),
      ),
    ),
  );
}
/**
 * What the controller holds in `namespace` (undefined: cluster scope) from its install-time RBAC
 * only. Grants it writes for itself (such as `di-platform-log-reader`) are left out: they must be
 * creatable before they are bound.
 */
function held(namespace: string | undefined, cluster: Rule[] = controllerClusterRoleRules()) {
  return namespace === cfg.namespace ? [...cluster, ...controllerNamespaceRoleRules()] : cluster;
}
const rulesOf = (r: Resource) => (r.rules as Rule[] | undefined) ?? [];
const roleRefOf = (r: Resource) => r.roleRef as RoleRef;
/** The Role or ClusterRole a rendered binding refers to. */
function referenced(objects: Resource[], binding: Resource): Resource | undefined {
  const ref = roleRefOf(binding);
  return objects.find(
    (o) =>
      o.kind === ref.kind &&
      o.metadata.name === ref.name &&
      (ref.kind === 'ClusterRole' || o.metadata.namespace === binding.metadata.namespace),
  );
}
const bindNames = () =>
  controllerClusterRoleRules()
    .filter((r) => r.apiGroups.includes(RBAC_GROUP) && r.verbs.includes('bind'))
    .flatMap((r) => r.resourceNames ?? []);
/** Roles every tenant gets under the same name, so they can be listed in `resourceNames`. */
function fixedNameBindings(objects: Resource[]): Set<string> {
  const bindings = objects.filter(
    (o) => o.kind === 'RoleBinding' || o.kind === 'ClusterRoleBinding',
  );
  const byTenant = (t: string) =>
    new Set(
      bindings
        .filter((b) => b.metadata.namespace?.endsWith(`-${t}`) || b.metadata.name.endsWith(`-${t}`))
        .map((b) => `${roleRefOf(b).kind}/${roleRefOf(b).name}`),
    );
  const alpha = byTenant('alpha');
  return new Set([...byTenant('beta')].filter((ref) => alpha.has(ref)));
}

describe('platform controller RBAC (#115)', () => {
  const objects = rendered(['alpha', 'beta']);
  const roles = objects.filter((o) => o.kind === 'Role' || o.kind === 'ClusterRole');
  const bindings = objects.filter(
    (o) => o.kind === 'RoleBinding' || o.kind === 'ClusterRoleBinding',
  );

  it('renders the Roles and bindings the checks below cover', () => {
    expect(roles.length).toBeGreaterThan(0);
    expect(bindings.length).toBeGreaterThan(0);
    expect(roles.some((r) => r.kind === 'ClusterRole')).toBe(true);
    expect(bindings.some((b) => b.kind === 'ClusterRoleBinding')).toBe(true);
    expect(bindings.some((b) => b.metadata.namespace === cfg.namespace)).toBe(true);
  });

  it('holds no escalate and no unrestricted bind', () => {
    for (const rule of [...controllerClusterRoleRules(), ...controllerNamespaceRoleRules()]) {
      expect(rule.verbs).not.toContain('*');
      expect(rule.verbs).not.toContain('escalate');
      expect(rule.apiGroups).not.toContain('*');
      expect(rule.resources).not.toContain('*');
      if (rule.verbs.includes('bind')) {
        expect(rule.verbs).toEqual(['bind']);
        expect(rule.resourceNames?.length).toBeGreaterThan(0);
      }
    }
    expect(controllerNamespaceRoleRules().flatMap((r) => r.verbs)).not.toContain('bind');
  });

  it('lists every fixed-name Role it binds, and nothing else, in bind resourceNames', () => {
    const fixed = fixedNameBindings(objects);
    expect(fixed.size).toBeGreaterThan(0);
    // Fixed-name bindings all refer to Roles (no cluster-wide bind on ClusterRoles).
    expect([...fixed].every((ref) => ref.startsWith('Role/'))).toBe(true);
    const names = bindNames();
    expect(new Set(names)).toEqual(new Set([...fixed].map((ref) => ref.slice('Role/'.length))));
    expect(
      controllerClusterRoleRules().some(
        (r) => r.verbs.includes('bind') && !r.resources.every((x) => x === 'roles'),
      ),
    ).toBe(false);
  });

  it('may create every binding it renders', () => {
    for (const binding of bindings) {
      const ref = roleRefOf(binding);
      const target = referenced(objects, binding);
      expect(target, `${binding.kind} ${binding.metadata.name}`).toBeDefined();
      const resource = ref.kind === 'Role' ? 'roles' : 'clusterroles';
      const namespace = binding.kind === 'RoleBinding' ? binding.metadata.namespace : undefined;
      const bindable = allows(held(namespace), RBAC_GROUP, resource, 'bind', ref.name);
      const holdsAll = rulesOf(target as Resource).every((rule) => covers(held(namespace), rule));
      expect(bindable || holdsAll, `${binding.kind} ${binding.metadata.name} -> ${ref.name}`).toBe(
        true,
      );
    }
  });

  it('holds every rule of every Role it writes, so it needs no escalate', () => {
    for (const role of roles) {
      const namespace = role.kind === 'Role' ? role.metadata.namespace : undefined;
      for (const rule of rulesOf(role))
        expect(
          covers(held(namespace), rule),
          `${role.kind} ${namespace ?? ''}/${role.metadata.name}: ${JSON.stringify(rule)}`,
        ).toBe(true);
    }
  });

  it('holds TokenRequest only in its own namespace', () => {
    const tokenRules = rendered(['alpha'])
      .filter((o) => o.kind === 'Role')
      .flatMap((o) => rulesOf(o).map((rule) => ({ rule, namespace: o.metadata.namespace })))
      .filter(({ rule }) => rule.resources.includes('serviceaccounts/token'));
    expect(tokenRules.length).toBeGreaterThan(0);
    for (const { namespace } of tokenRules) expect(namespace).toBe(cfg.namespace);
    expect(allows(held(undefined), '', 'serviceaccounts/token', 'create', 'di-user-alice')).toBe(
      false,
    );
    expect(allows(held('di-runtime-alpha'), '', 'serviceaccounts/token', 'create')).toBe(false);
  });

  it('detects a Role rule the controller does not hold', () => {
    // The checks above would catch a dropped permission: without the events read, the tenant
    // viewer Role is no longer covered.
    const cluster = controllerClusterRoleRules().filter((r) => !r.resources.includes('events'));
    const viewer = roles.find((r) => r.metadata.name === 'di-viewer') as Resource;
    expect(rulesOf(viewer).every((rule) => covers(held('di-tenant-alpha', cluster), rule))).toBe(
      false,
    );
  });
});

/**
 * Every owner (top-level declaration, or `Class.member`) in the controller modules that mentions
 * RBAC. Default-deny: a new line naming the RBAC API group or a Role kind anywhere else fails the
 * scan until it is either moved into a renderer checked above or reviewed and listed here.
 */
const RBAC_OWNERS = [
  // The renderers whose objects the checks above evaluate.
  'resources:tenantResources',
  'resources:userResources',
  'resources:tenantAuthResources',
  // Read-only uses in controller.ts: URL plurals, the tenant-auth prune kinds, the roleRef
  // comparison before a re-bind, the binding revoke, and the user binding list and count.
  'controller:plurals',
  'controller:TENANT_AUTH_KINDS',
  'controller:Controller.ensure',
  'controller:Controller.revoke',
  'controller:Controller.reconcileUser',
  // The kinds of the leftover log reader that pruneLogReader deletes when this installation owns it.
  'controller:LOG_READER_KINDS',
];
/** The RBAC API group, a quoted RBAC kind, or an RBAC kind used as an object key. */
const RBAC_MENTION = [
  /rbac\.authorization\.k8s\.io/,
  /['"`](Cluster)?Role(Binding)?['"`]/,
  /\b(Cluster)?Role(Binding)?\s*:/,
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'await', 'new']);
const source = (module: string) =>
  readFileSync(path.join(import.meta.dir, '../src/tenancy', `${module}.ts`), 'utf8').split('\n');
/**
 * The owner of each line: the last top-level declaration above it, refined to `Class.member` for
 * a class member declared at two-space indentation.
 */
function owners(lines: string[]): (string | undefined)[] {
  let top: string | undefined;
  let member: string | undefined;
  let inClass = false;
  return lines.map((line) => {
    const cls = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(line);
    const decl =
      /^(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)/.exec(line) ??
      /^(?:export\s+)?(?:const|let|var|type|interface|enum)\s+(\w+)/.exec(line);
    if (cls) [top, member, inClass] = [cls[1], undefined, true];
    else if (decl) [top, member, inClass] = [decl[1], undefined, false];
    else if (inClass) {
      const m =
        /^ {2}(?:(?:private|protected|public|static|readonly|async|override|get|set)\s+)*(\w+)\s*[(<:=]/.exec(
          line,
        );
      if (m?.[1] && !KEYWORDS.has(m[1])) member = m[1];
    }
    return top && member ? `${top}.${member}` : top;
  });
}
/** Owners of the non-comment lines in `lines` that mention RBAC, as `<module>:<owner>`. */
function rbacOwners(module: string, lines: string[]): Set<string> {
  const owner = owners(lines);
  const found = new Set<string>();
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (RBAC_MENTION.some((pattern) => pattern.test(line)))
      found.add(`${module}:${owner[i] ?? '<top level>'}`);
  });
  return found;
}

describe('controller RBAC sources (#115)', () => {
  it('mentions RBAC only in the renderers checked above and the reviewed read-only uses', () => {
    const found = new Set<string>();
    for (const module of CONTROLLER_SCRIPT_MODULES)
      for (const owner of rbacOwners(module, source(module))) found.add(owner);
    // Exact: a new owner fails, and so does an entry that no longer mentions RBAC.
    expect([...found].sort()).toEqual([...RBAC_OWNERS].sort());
  });

  it('flags a one-line resource() Role built outside the renderers', () => {
    const lines = [
      'export class Controller {',
      '  private async reconcileEgress(tenant: Tenant): Promise<void> {',
      "    await this.ensure(resource(tenant, this.cfg.installation, 'rbac.authorization.k8s.io/v1', 'Role', 'x', ns, { rules }));",
      '  }',
      '}',
    ];
    expect([...rbacOwners('controller', lines)]).toEqual(['controller:Controller.reconcileEgress']);
  });

  it('flags a multi-line resource() Role built outside the renderers', () => {
    const lines = [
      'export class Controller {',
      '  private async reconcileEgress(tenant: Tenant): Promise<void> {',
      '    const role = resource(',
      '      tenant,',
      '      this.cfg.installation,',
      "      'rbac.authorization.k8s.io/v1',",
      '      kind,',
      "      'x',",
      '      ns,',
      '      { rules },',
      '    );',
      '  }',
      '}',
    ];
    expect([...rbacOwners('controller', lines)]).toEqual(['controller:Controller.reconcileEgress']);
  });

  it('flags make() with an RBAC apiVersion constant', () => {
    const lines = [
      'function backingServiceResources(service: BackingService): Resource[] {',
      "  return [make(RBAC_V1, 'Role', 'x', ns, {})];",
      '}',
    ];
    expect([...rbacOwners('backing-services', lines)]).toEqual([
      'backing-services:backingServiceResources',
    ]);
  });

  it('attributes class members and skips comments', () => {
    const lines = [
      "const RBAC_V1 = 'rbac.authorization.k8s.io/v1';",
      'export class Controller {',
      '  private readonly cache = new Map();',
      '  async reconcile(): Promise<void> {',
      "    // A Role named 'Role' in a comment is not code.",
      '    if (ready) {',
      "      return this.list('rbac.authorization.k8s.io/v1', kind);",
      '    }',
      '  }',
      '}',
    ];
    expect([...rbacOwners('m', lines)].sort()).toEqual(['m:Controller.reconcile', 'm:RBAC_V1']);
  });
});

describe('tenant controller RBAC (#321)', () => {
  const clusterRole = (objects: Resource[], t: string) =>
    objects.find(
      (o) => o.kind === 'ClusterRole' && o.metadata.name === `di-tenant-controller-${t}`,
    );

  it("reads only its own active members' Users, by name, and never lists them", () => {
    const role = clusterRole(rendered(['alpha']), 'alpha') as Resource;
    expect(rulesOf(role)).toEqual([
      {
        apiGroups: ['platform.di-framework.dev'],
        resources: ['tenants'],
        verbs: ['get'],
        resourceNames: ['alpha'],
      },
      {
        apiGroups: ['platform.di-framework.dev'],
        resources: ['users'],
        verbs: ['get'],
        resourceNames: ['alice', 'bob'],
      },
    ]);
    for (const rule of rulesOf(role)) expect(rule.resourceNames?.length).toBeGreaterThan(0);
  });

  it('grants no users rule at all to a tenant without members', () => {
    const t = tenant('gamma');
    const objects = tenantAuthResources(t, cfg, { ...inputs, members: [] });
    const role = clusterRole(objects, 'gamma') as Resource;
    expect(rulesOf(role).flatMap((r) => r.resources)).toEqual(['tenants']);
    const members = objects.find((o) => o.metadata.name === 'tenant-controller-members');
    expect(members?.data).toEqual({ members: '[]', entries: '[]' });
  });

  it('grants nothing to a tenant whose only members are suspended, but still lists them', () => {
    const objects = tenantAuthResources(tenant('gamma'), cfg, {
      ...inputs,
      members: [member('carol', true)],
    });
    expect(rulesOf(clusterRole(objects, 'gamma') as Resource).flatMap((r) => r.resources)).toEqual([
      'tenants',
    ]);
    const tokens = objects.find(
      (o) => o.kind === 'Role' && o.metadata.name === 'di-tenant-controller-gamma',
    );
    expect(rulesOf(tokens as Resource)).toEqual([]);
    const members = objects.find((o) => o.metadata.name === 'tenant-controller-members');
    expect(JSON.parse(((members as Resource).data as { entries: string }).entries)).toEqual([
      { name: 'carol', role: 'developer', suspended: true },
    ]);
  });

  it('publishes the member list it may read in its own namespace only', () => {
    const objects = tenantAuthResources(tenant('alpha'), cfg, {
      ...inputs,
      members: [
        member('carol', true),
        { name: 'bob', role: 'viewer', suspended: false },
        member('bob'),
        member('alice'),
      ],
    });
    const members = objects.find((o) => o.metadata.name === 'tenant-controller-members');
    expect(members).toMatchObject({
      kind: 'ConfigMap',
      metadata: { namespace: 'di-runtime-alpha' },
    });
    const published = (members as Resource).data as { members: string; entries: string };
    // Active names for older tenant-auth images; every membership, flagged, for `/-/members`.
    expect(JSON.parse(published.members)).toEqual(['alice', 'bob']);
    expect(JSON.parse(published.entries)).toEqual([
      { name: 'alice', role: 'developer', suspended: false },
      { name: 'bob', role: 'developer', suspended: false },
      { name: 'bob', role: 'viewer', suspended: false },
      { name: 'carol', role: 'developer', suspended: true },
    ]);
    const keys = objects.find(
      (o) => o.kind === 'Role' && o.metadata.name === 'tenant-controller-keys',
    );
    expect(rulesOf(keys as Resource)).toContainEqual({
      apiGroups: [''],
      resources: ['configmaps'],
      verbs: ['get'],
      resourceNames: ['tenant-controller-members'],
    });
    // Its write access to Secrets is narrowed by admission, not RBAC (#115 S2).
    expect(
      admissionResources('test', cfg.namespace).some(
        (r) => r.metadata.name === 'test-tenant-controller-secrets',
      ),
    ).toBe(true);
  });

  it('publishes the member list under the name and format tenant-auth reads', () => {
    expect(TENANT_MEMBERS_CONFIG).toBe(MEMBERS_CONFIG);
    const objects = tenantAuthResources(tenant('alpha'), cfg, inputs);
    const published = objects.find(
      (o) => o.kind === 'ConfigMap' && o.metadata.name === MEMBERS_CONFIG,
    ) as Resource & { data: Record<string, string> };
    expect(publishedMembers(published)).toEqual([...inputs.members]);
    const keys = objects.find(
      (o) => o.kind === 'Role' && o.metadata.name === 'tenant-controller-keys',
    ) as Resource;
    expect(rulesOf(keys).find((r) => r.resources.includes('configmaps'))?.resourceNames).toEqual([
      MEMBERS_CONFIG,
    ]);
  });

  it('no longer renders the redundant log reader or binds anything to itself', () => {
    expect(objects().some((o) => o.metadata.name === 'di-platform-log-reader')).toBe(false);
    expect(bindNames()).not.toContain('di-platform-log-reader');
    for (const binding of objects().filter((o) => o.kind.endsWith('Binding')))
      expect(
        ((binding.subjects as { name: string }[] | undefined) ?? []).map((s) => s.name),
      ).not.toContain('di-platform-controller');
  });
  const objects = () => rendered(['alpha', 'beta']);
});

// Runtime coverage: drive the real Controller against an in-memory API server and check every
// Role and binding it actually sends, and every request it makes, against its install-time RBAC.
// This catches what the static render above can miss: a code path that builds or changes RBAC
// only for some tenant states (registry host pull, suspended, no members).

/** A request as the RBAC authorizer sees it. */
interface Attributes {
  group: string;
  resource: string;
  verb: string;
  namespace?: string;
  name?: string;
}
/**
 * The RBAC attributes of one API call, as the API server would derive them. A server-side apply
 * (PATCH) that creates the object is authorized as both `patch` and `create`.
 */
function attributes(method: string, url: URL, exists: boolean): Attributes[] {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [group, rest] =
    parts[0] === 'api' ? ['', parts.slice(2)] : [parts[1] ?? '', parts.slice(3)];
  let namespace: string | undefined;
  let tail = rest;
  if (rest[0] === 'namespaces' && rest.length > 2) {
    namespace = rest[1];
    tail = rest.slice(2);
  }
  const [plural, name, sub] = tail as [string, string | undefined, string | undefined];
  const resource = sub ? `${plural}/${sub}` : plural;
  const verbs =
    method === 'GET'
      ? [name ? 'get' : 'list']
      : method === 'PATCH'
        ? exists
          ? ['patch']
          : ['patch', 'create']
        : method === 'PUT'
          ? ['update']
          : method === 'DELETE'
            ? ['delete']
            : ['create'];
  return verbs.map((verb) => ({ group, resource, verb, namespace, name }));
}

/** In-memory API server that records every RBAC object written and every request's attributes. */
class RecordingApi implements Api {
  objects = new Map<string, Resource>();
  /** Every Role, ClusterRole and binding body the controller sent, in order. */
  written: Resource[] = [];
  requests: Attributes[] = [];
  seed(value: Resource | Tenant | User): void {
    this.objects.set(
      `${collection(value.apiVersion, value.kind, value.metadata.namespace)}/${value.metadata.name}`,
      structuredClone(value) as Resource,
    );
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, 'https://kubernetes');
    const target = decodeURIComponent(url.pathname).replace(/\/status$/, '');
    const existing = this.objects.get(target);
    this.requests.push(...attributes(method, url, existing !== undefined));
    if (method === 'GET' && url.searchParams.has('labelSelector')) {
      const labels = (url.searchParams.get('labelSelector') ?? '')
        .split(',')
        .filter(Boolean)
        .map((v) => v.split('='));
      const at = decodeURIComponent(url.pathname);
      return {
        items: [...this.objects.values()]
          .filter(
            (v) =>
              [
                collection(v.apiVersion, v.kind),
                collection(v.apiVersion, v.kind, v.metadata.namespace),
              ].includes(at) && labels.every(([k = '', x]) => v.metadata.labels?.[k] === x),
          )
          .map((item) => structuredClone(item)),
      } as T;
    }
    if (method === 'GET') {
      if (!existing) throw new ApiError(404, 'Not found');
      return structuredClone(existing) as T;
    }
    if (method === 'DELETE') {
      this.objects.delete(target);
      return {} as T;
    }
    const data = structuredClone(body) as Resource;
    if (data.apiVersion?.startsWith(`${RBAC_GROUP}/`)) this.written.push(structuredClone(data));
    const value = {
      ...existing,
      ...data,
      metadata: { ...existing?.metadata, ...data.metadata },
    } as Resource;
    value.metadata.uid ??= `${value.metadata.name}-uid`;
    value.metadata.generation ??= 1;
    if (value.kind === 'Deployment')
      value.status = {
        observedGeneration: 1,
        readyReplicas: (value.spec as { replicas: number }).replicas,
      };
    // Kubernetes fills ServiceAccount token Secrets.
    if (value.kind === 'Secret' && value.type === 'kubernetes.io/service-account-token')
      value.data = { token: 'dG9rZW4=' };
    this.objects.set(target, value);
    return structuredClone(value) as T;
  }
}

describe('platform controller RBAC at runtime (#321)', () => {
  const registryCfg: ControllerConfig = {
    ...cfg,
    routeUrlPattern: 'http://{host}.{tenant}.localhost:28180',
    tenantAuth: {
      ...(cfg.tenantAuth as NonNullable<ControllerConfig['tenantAuth']>),
      registry: {
        component: `ghcr.io/di-framework/oci-registry@sha256:${'b'.repeat(64)}`,
        publicUrl: 'https://registry.{tenant}.localhost:28180',
      },
    },
  };
  /** alpha: two members and a registry the hosts pull from; beta: suspended; gamma: no members. */
  async function run() {
    const api = new RecordingApi();
    const beta = tenant('beta');
    beta.spec.suspended = true;
    const tenants = [tenant('alpha'), beta, tenant('gamma')];
    const carol = user('carol', 'viewer', ['alpha']);
    carol.spec.suspended = true;
    const users = [
      user('alice', 'developer', ['alpha', 'beta']),
      user('bob', 'viewer', ['alpha', 'beta']),
      carol,
    ];
    for (const value of [...tenants, ...users]) api.seed(value);
    // Ready hosts, so the tenants turn Ready and their members are bound.
    for (const t of tenants)
      api.seed({
        apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
        kind: 'Host',
        metadata: {
          name: `${t.metadata.name}-host`,
          namespace: cfg.namespace,
          labels: { hostgroup: `tenant-${t.metadata.name}` },
        },
        environment: `di-tenant-${t.metadata.name}`,
        status: { conditions: ready },
      });
    api.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'wasmcloud-runtime-tls', namespace: cfg.namespace },
      data: { 'ca.crt': 'dGVzdA==' },
    });
    api.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'tenant-auth-oauth', namespace: cfg.namespace },
      data: { clientSecret: 'c2hhcmVk' },
    });
    api.seed({
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      metadata: {
        name: 'kubernetes',
        namespace: 'default',
        labels: { 'kubernetes.io/service-name': 'kubernetes' },
      },
      endpoints: [{ addresses: ['10.0.0.1'] }],
      ports: [{ port: 6443 }],
    });
    // Log readers that platforms before #321 wrote: alpha's are this installation's; gamma's are
    // another installation's Role and an unlabelled binding, which must be left alone.
    for (const [namespace, kind, labels] of [
      ['di-runtime-alpha', 'Role', { [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' }],
      ['di-runtime-alpha', 'RoleBinding', { [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' }],
      ['di-runtime-gamma', 'Role', { [INSTALLATION]: 'other', [OWNER]: 'gamma-uid' }],
      ['di-runtime-gamma', 'RoleBinding', undefined],
    ] as const)
      api.seed({
        apiVersion: `${RBAC_GROUP}/v1`,
        kind,
        metadata: { name: LOG_READER, namespace, uid: `${namespace}-${kind}`, labels },
      });
    const controller = new Controller(api, registryCfg);
    // Twice: the first pass deploys the registry, the second wires the hosts to pull from it.
    for (let pass = 0; pass < 2; pass++) {
      for (const t of tenants) await controller.reconcileTenant(t, users);
      for (const u of users) await controller.reconcileUser(u, tenants);
    }
    return { api, written: api.written };
  }
  const held = (namespace: string | undefined, cluster: Rule[] = controllerClusterRoleRules()) =>
    namespace === cfg.namespace ? [...cluster, ...controllerNamespaceRoleRules()] : cluster;
  const ref = (o: Resource) => `${o.kind} ${o.metadata.namespace ?? ''}/${o.metadata.name}`;
  /** The requests that `cluster` (with the namespace Role) does not authorize. */
  const unauthorized = (requests: Attributes[], cluster?: Rule[]) =>
    requests
      .filter((r) => !allows(held(r.namespace, cluster), r.group, r.resource, r.verb, r.name))
      .map((r) => `${r.verb} ${r.group}/${r.resource} ${r.namespace ?? ''}/${r.name ?? ''}`);
  /** `controllerClusterRoleRules()` without `verb` on the rule that grants `resource`. */
  const without = (group: string, resource: string, verb: string) =>
    controllerClusterRoleRules().map((r) =>
      r.apiGroups.includes(group) && r.resources.includes(resource) && !r.resourceNames
        ? { ...r, verbs: r.verbs.filter((v) => v !== verb) }
        : r,
    );

  it('exercises host pull, suspended and member-less tenants', async () => {
    const { api, written } = await run();
    const names = new Set(written.map(ref));
    // alpha: the registry is deployed and its hosts pull with the platform-written credential.
    expect(
      api.objects.get(`${collection('v1', 'Secret', 'di-runtime-alpha')}/${REGISTRY_PULL_SECRET}`),
    ).toBeDefined();
    const hosts = api.objects.get(
      `${collection('apps/v1', 'Deployment', 'di-runtime-alpha')}/hostgroup-tenant-alpha`,
    );
    expect(JSON.stringify(hosts?.spec)).toContain(REGISTRY_PULL_SECRET);
    // beta (suspended) keeps its Roles but gets no tenant-controller or member bindings.
    expect(names.has('ClusterRole /di-tenant-controller-beta')).toBe(true);
    expect(names.has('ClusterRoleBinding /di-tenant-controller-beta')).toBe(false);
    expect(
      written.some((o) => o.kind === 'RoleBinding' && o.metadata.namespace === 'di-tenant-beta'),
    ).toBe(false);
    // gamma has no members: no users rule and an empty TokenRequest Role.
    const gamma = written.findLast((o) => ref(o) === 'ClusterRole /di-tenant-controller-gamma');
    expect(rulesOf(gamma as Resource).flatMap((r) => r.resources)).toEqual(['tenants']);
    const tokens = written.findLast(
      (o) => ref(o) === `Role ${cfg.namespace}/di-tenant-controller-gamma`,
    );
    expect(rulesOf(tokens as Resource)).toEqual([]);
    // Members are bound in alpha; the suspended user nowhere.
    expect(names.has('RoleBinding di-tenant-alpha/di-user-alice')).toBe(true);
    expect(names.has('RoleBinding di-runtime-alpha/di-user-bob')).toBe(true);
    expect([...names].some((n) => n.includes('di-user-carol'))).toBe(false);
  });

  it('holds every rule of every Role and ClusterRole it writes', async () => {
    const { written } = await run();
    const roles = written.filter((o) => o.kind === 'Role' || o.kind === 'ClusterRole');
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      const namespace = role.kind === 'Role' ? role.metadata.namespace : undefined;
      for (const rule of rulesOf(role))
        expect(covers(held(namespace), rule), `${ref(role)}: ${JSON.stringify(rule)}`).toBe(true);
    }
  });

  it('may create every binding it writes', async () => {
    const { api, written } = await run();
    const bindings = written.filter(
      (o) => o.kind === 'RoleBinding' || o.kind === 'ClusterRoleBinding',
    );
    expect(bindings.some((b) => b.kind === 'ClusterRoleBinding')).toBe(true);
    for (const binding of bindings) {
      const role = roleRefOf(binding);
      const namespace = binding.kind === 'RoleBinding' ? binding.metadata.namespace : undefined;
      const target = api.objects.get(
        `${collection(`${RBAC_GROUP}/v1`, role.kind, role.kind === 'Role' ? namespace : undefined)}/${role.name}`,
      );
      expect(target, `${ref(binding)} -> ${role.kind} ${role.name}`).toBeDefined();
      const bindable = allows(
        held(namespace),
        RBAC_GROUP,
        role.kind === 'Role' ? 'roles' : 'clusterroles',
        'bind',
        role.name,
      );
      const holdsAll = rulesOf(target as Resource).every((rule) => covers(held(namespace), rule));
      expect(bindable || holdsAll, `${ref(binding)} -> ${role.name}`).toBe(true);
    }
  });

  it('is authorized for every request it makes', async () => {
    const { api } = await run();
    expect(api.requests.length).toBeGreaterThan(0);
    expect(unauthorized(api.requests)).toEqual([]);
  });

  it('flags a request its install-time RBAC does not authorize', async () => {
    const { api } = await run();
    // Without `delete` on Roles it could not prune the leftover log reader.
    expect(unauthorized(api.requests, without(RBAC_GROUP, 'roles', 'delete'))).toContain(
      `delete ${RBAC_GROUP}/roles di-runtime-alpha/${LOG_READER}`,
    );
    // A server-side apply that creates an object needs `patch` as well as `create`.
    const creates = api.requests.filter((r) => r.resource === 'configmaps' && r.verb === 'create');
    expect(creates.length).toBeGreaterThan(0);
    const flagged = unauthorized(api.requests, without('', 'configmaps', 'patch'));
    for (const r of creates)
      expect(flagged).toContain(`patch /configmaps ${r.namespace ?? ''}/${r.name ?? ''}`);
  });

  it('prunes only the leftover log reader this installation wrote, once per tenant', async () => {
    const { api } = await run();
    const at = (namespace: string, kind: string) =>
      api.objects.get(`${collection(`${RBAC_GROUP}/v1`, kind, namespace)}/${LOG_READER}`);
    expect(at('di-runtime-alpha', 'Role')).toBeUndefined();
    expect(at('di-runtime-alpha', 'RoleBinding')).toBeUndefined();
    expect(at('di-runtime-gamma', 'Role')).toBeDefined();
    expect(at('di-runtime-gamma', 'RoleBinding')).toBeDefined();
    const reads = api.requests.filter((r) => r.name === LOG_READER && r.verb === 'get');
    // Two passes over three tenants, but each Role and binding is checked only on the first.
    expect(reads).toHaveLength(6);
    expect(
      api.requests
        .filter((r) => r.name === LOG_READER && r.verb === 'delete')
        .map((r) => `${r.resource} ${r.namespace}`),
    ).toEqual(['rolebindings di-runtime-alpha', 'roles di-runtime-alpha']);
  });

  it('detects a written rule the controller does not hold', async () => {
    const { written } = await run();
    // Without its cluster-wide users read it could not write the per-tenant users grant.
    const cluster = controllerClusterRoleRules().map((r) =>
      r.resources.includes('users')
        ? { ...r, resources: r.resources.filter((x) => x !== 'users') }
        : r,
    );
    const alpha = written.findLast((o) => ref(o) === 'ClusterRole /di-tenant-controller-alpha');
    expect(rulesOf(alpha as Resource).every((rule) => covers(cluster, rule))).toBe(false);
  });
});
