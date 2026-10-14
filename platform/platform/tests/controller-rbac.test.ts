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
