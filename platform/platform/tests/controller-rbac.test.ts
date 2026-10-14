import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  CONTROLLER_SCRIPT_MODULES,
  type ControllerClusterRoleRule,
  controllerClusterRoleRules,
  controllerNamespaceRoleRules,
} from '../src/tenancy/install';
import {
  type ControllerConfig,
  INSTALLATION,
  type Resource,
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
const inputs: TenantAuthInputs = {
  members: ['alice', 'bob'],
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

/** The renderers checked above; a Role or binding built anywhere else would go unchecked. */
const RBAC_RENDERERS = ['tenantResources', 'userResources', 'tenantAuthResources'];
const RBAC_KIND = /'(Cluster)?Role(Binding)?'/;
/** Builds an RBAC object (not a list, prune or kind comparison of existing ones). */
const RBAC_CONSTRUCTION = [
  /kind:\s*'(Cluster)?Role(Binding)?'/,
  /apiVersion:\s*'rbac\.authorization\.k8s\.io\//,
  /\b(make|resource)\(\s*('rbac\.authorization\.k8s\.io\/v1'|rbac\b)/,
];
const source = (module: string) =>
  readFileSync(path.join(import.meta.dir, '../src/tenancy', `${module}.ts`), 'utf8').split('\n');
/** The top-level function each line belongs to, by the last `function name(` above it. */
function enclosingFunctions(lines: string[]): (string | undefined)[] {
  let current: string | undefined;
  return lines.map((line) => {
    const start = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(line);
    if (start) current = start[1];
    else if (/^(?:export\s+)?(?:const|let|class|interface|type)\s/.test(line)) current = undefined;
    return current;
  });
}

describe('controller RBAC sources (#115)', () => {
  it('builds Roles and bindings only in the renderers the checks above cover', () => {
    const found: string[] = [];
    for (const module of CONTROLLER_SCRIPT_MODULES) {
      const lines = source(module);
      const owners = enclosingFunctions(lines);
      lines.forEach((line, i) => {
        const builds = RBAC_CONSTRUCTION.some((pattern) => pattern.test(line));
        // In resources.ts every RBAC kind literal is part of building an object.
        if (builds || (module === 'resources' && RBAC_KIND.test(line)))
          found.push(`${module}:${owners[i] ?? '<top level>'}`);
      });
    }
    expect(found.length).toBeGreaterThan(0);
    expect([...new Set(found)].sort()).toEqual(
      RBAC_RENDERERS.map((name) => `resources:${name}`).sort(),
    );
  });

  it('flags an RBAC object built outside those renderers', () => {
    const lines = [
      'function backingServiceResources() {',
      "  return [{ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role' }];",
      '}',
    ];
    expect(enclosingFunctions(lines)[1]).toBe('backingServiceResources');
    expect(RBAC_CONSTRUCTION.some((pattern) => pattern.test(lines[1] as string))).toBe(true);
    // Reads of existing objects are not constructions.
    for (const line of [
      "  ['rbac.authorization.k8s.io/v1', 'RoleBinding'],",
      "await this.list<Resource>('rbac.authorization.k8s.io/v1', 'RoleBinding', {",
      "value.kind === 'RoleBinding' &&",
    ])
      expect(RBAC_CONSTRUCTION.some((pattern) => pattern.test(line))).toBe(false);
  });
});
