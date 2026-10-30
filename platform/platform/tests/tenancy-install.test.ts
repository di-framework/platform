import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { declarations, installTenancy, seedTenantNamespaces } from '../src/tenancy';
import * as install from '../src/tenancy/install';
import { INSTALLATION, TENANT } from '../src/tenancy/resources';
import {
  TENANT_OPERATOR_CLUSTER_ROLES,
  tenantOperatorClusterRoleRules,
} from '../src/tenancy/tenant-operator';

// The Pulumi wiring of the platform controller's own RBAC (#115, #321): which objects
// `installTenancy` creates, with which rules, and in which order `pulumi up` applies them.

/** The parts of a resource's inputs these tests read. */
interface Inputs {
  metadata?: Record<string, unknown>;
  data?: Record<string, string>;
  spec?: {
    template: {
      metadata: { annotations?: Record<string, string> };
      spec: { serviceAccountName?: string };
    };
  };
  [key: string]: unknown;
}
/** The registration request the mock monitor receives. */
interface RegisterRequest {
  getName(): string;
  getType(): string;
  getDependenciesList(): string[];
}
interface Registered {
  type: string;
  name: string;
  inputs: Inputs;
  /** URNs of the resources it depends on. */
  dependencies: string[];
}

const SCRIPTS = { 'controller.js': '// controller', 'resources.js': '// resources' };
const registered = new Map<string, Registered>();
const inputs = new Map<string, Inputs>();
let scripts: ReturnType<typeof spyOn>;

/** The URN of a resource created in this stack (Pulumi derives it from type and name). */
const urnOf = (name: string) => {
  const found = registered.get(name);
  if (!found) throw new Error(`${name} was not registered`);
  return `urn:pulumi:test::project::${found.type}::${name}`;
};
const dependsOn = (name: string) => registered.get(name)?.dependencies ?? [];

beforeAll(async () => {
  await pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        inputs.set(args.name, args.inputs);
        return { id: args.name, state: args.inputs };
      },
      call: (args) => args.inputs,
    },
    'project',
    'test',
    false,
  );
  // The mocks do not report dependencies, so read them off each registration request.
  const monitor = (
    pulumi.runtime as unknown as {
      getMonitor(): { registerResource(request: RegisterRequest, callback: unknown): unknown };
    }
  ).getMonitor();
  const register = monitor.registerResource.bind(monitor);
  monitor.registerResource = (request, callback) => {
    registered.set(request.getName(), {
      type: request.getType(),
      name: request.getName(),
      inputs: {},
      dependencies: request.getDependenciesList(),
    });
    return register(request, callback);
  };
  // The controller scripts are read from the package build, which unit tests do not have.
  scripts = spyOn(install, 'loadControllerScripts').mockReturnValue(SCRIPTS);
  const provider = new k8s.Provider('test', {});
  const created = installTenancy({
    installation: 'di-test',
    namespace: 'wasmcloud',
    provider,
    dependsOn: [],
    tenants: [{ name: 'alpha' }],
    users: [{ name: 'alice', memberships: [{ tenant: 'alpha', role: 'developer' }] }],
    hostImage: 'wash:test',
    hostImagePullPolicy: 'IfNotPresent',
  });
  const namespaces = seedTenantNamespaces([{ name: 'alpha' }], 'di-test', provider);
  // A User depends on the controller and the Tenants, so once it is registered everything
  // upstream of it is too.
  await Promise.all(
    [...created.users, ...created.backingServiceClasses, ...namespaces].map(
      (r) => new Promise((resolve) => r.urn.apply(resolve)),
    ),
  );
  for (const [name, value] of registered) value.inputs = inputs.get(name) ?? {};
});
afterAll(() => scripts.mockRestore());

describe('installTenancy controller RBAC wiring', () => {
  it('grants the ClusterRole rules and binds them to the controller ServiceAccount', () => {
    expect(registered.get('clusterrole-di-test-controller')?.inputs).toMatchObject({
      metadata: { name: 'di-test-controller' },
      rules: install.controllerClusterRoleRules(),
    });
    expect(registered.get('clusterrolebinding-di-test-controller')?.inputs).toMatchObject({
      roleRef: { kind: 'ClusterRole', name: 'di-test-controller' },
      subjects: [
        { kind: 'ServiceAccount', name: 'di-platform-controller', namespace: 'wasmcloud' },
      ],
    });
  });

  it('installs the three tenant-operator ClusterRoles and binds none of them (#541 m3)', () => {
    const rules = tenantOperatorClusterRoleRules();
    for (const [scope, name] of Object.entries(TENANT_OPERATOR_CLUSTER_ROLES))
      expect(registered.get(`clusterrole-${name}`)?.inputs).toMatchObject({
        metadata: { name, labels: { [INSTALLATION]: 'di-test' } },
        rules: rules[scope as keyof typeof rules],
      });
    const operatorRoles: string[] = Object.values(TENANT_OPERATOR_CLUSTER_ROLES);
    const refs = [...registered.values()]
      .filter((r) => r.type.endsWith('Binding'))
      .map((r) => (r.inputs.roleRef as { name?: string } | undefined)?.name);
    expect(refs.length).toBeGreaterThan(0);
    for (const name of refs) expect(operatorRoles).not.toContain(name);
  });

  it('holds TokenRequest only through a Role in its own namespace', () => {
    expect(registered.get('role-di-test-controller')?.inputs).toMatchObject({
      metadata: { name: 'di-test-controller', namespace: 'wasmcloud' },
      rules: install.controllerNamespaceRoleRules(),
    });
    expect(registered.get('rolebinding-di-test-controller')?.inputs).toMatchObject({
      metadata: { name: 'di-test-controller', namespace: 'wasmcloud' },
      roleRef: { kind: 'Role', name: 'di-test-controller' },
      subjects: [
        { kind: 'ServiceAccount', name: 'di-platform-controller', namespace: 'wasmcloud' },
      ],
    });
  });

  it('applies the namespaced grant before the ClusterRole, and both before the controller', () => {
    expect(dependsOn('rolebinding-di-test-controller')).toEqual(
      expect.arrayContaining([
        urnOf('role-di-test-controller'),
        urnOf('serviceaccount-di-platform-controller'),
      ]),
    );
    // The ClusterRole holds no `escalate` (#115), so the running controller must already hold
    // TokenRequest in its namespace when `pulumi up` updates it.
    // The tenant-operator admission policies confine its `bind` before it holds it (#541 m3).
    expect(dependsOn('clusterrole-di-test-controller')).toEqual([
      urnOf('rolebinding-di-test-controller'),
      ...['clusterrolebindings', 'rolebindings', 'clusterroles'].flatMap((kind) => [
        urnOf(`validatingadmissionpolicy-di-test-tenant-operator-${kind}`),
        urnOf(`validatingadmissionpolicybinding-di-test-tenant-operator-${kind}`),
      ]),
      // And the policies limiting its ClusterRole and ClusterRoleBinding writes (#586).
      ...['clusterroles', 'clusterrolebindings'].flatMap((kind) => [
        urnOf(`validatingadmissionpolicy-di-test-controller-${kind}`),
        urnOf(`validatingadmissionpolicybinding-di-test-controller-${kind}`),
      ]),
    ]);
    expect(dependsOn('clusterrolebinding-di-test-controller')).toEqual(
      expect.arrayContaining([
        urnOf('clusterrole-di-test-controller'),
        urnOf('serviceaccount-di-platform-controller'),
      ]),
    );
    expect(dependsOn('deployment-di-platform-controller')).toEqual(
      expect.arrayContaining([
        urnOf('clusterrolebinding-di-test-controller'),
        urnOf('rolebinding-di-test-controller'),
        urnOf('configmap-di-platform-controller'),
        urnOf('networkpolicy-di-tenant-scheduler'),
        urnOf('validatingadmissionpolicy-di-test-tenant-controller-secrets'),
      ]),
    );
  });

  it('creates no other RBAC for the controller and nothing per tenant', () => {
    const rbac = [...registered.values()].filter((r) =>
      r.type.startsWith('kubernetes:rbac.authorization.k8s.io/'),
    );
    expect(rbac.map((r) => r.name).sort()).toEqual([
      // The tenant operators' fixed ClusterRoles (#541 m3), not the controller's: unbound here.
      'clusterrole-di-tenant-operator-hosts',
      'clusterrole-di-tenant-operator-self',
      'clusterrole-di-tenant-operator-workloads',
      'clusterrole-di-test-controller',
      'clusterrolebinding-di-test-controller',
      'role-di-test-controller',
      'rolebinding-di-test-controller',
    ]);
  });

  it('rolls the controller when its scripts change', () => {
    const deployment = registered.get('deployment-di-platform-controller')?.inputs;
    expect(deployment?.spec?.template.metadata.annotations).toEqual({
      'di-framework.dev/script-hash': install.controllerScriptHash(SCRIPTS),
    });
    expect(registered.get('configmap-di-platform-controller')?.inputs.data).toEqual(SCRIPTS);
    expect(deployment?.spec?.template.spec.serviceAccountName).toBe('di-platform-controller');
  });

  it('creates Tenants after the controller and Users after their Tenants', () => {
    expect(dependsOn('tenant-alpha')).toContain(urnOf('deployment-di-platform-controller'));
    expect(dependsOn('user-alice')).toEqual(
      expect.arrayContaining([urnOf('deployment-di-platform-controller'), urnOf('tenant-alpha')]),
    );
    expect(dependsOn('backingserviceclass-keyvalue-redis')).toContain(
      urnOf('customresourcedefinition-tenants.platform.di-framework.dev'),
    );
  });

  it('seeds both tenant namespaces with the installation and tenant labels', () => {
    for (const name of ['di-tenant-alpha', 'di-runtime-alpha'])
      expect(registered.get(name)?.inputs.metadata).toEqual({
        name,
        labels: { [INSTALLATION]: 'di-test', [TENANT]: 'alpha' },
      });
  });
});

describe('declarations', () => {
  const config = (values: Record<string, unknown>) =>
    ({ getObject: (key: string) => values[key] }) as unknown as pulumi.Config;

  it('reads tenants and users, defaulting to none', () => {
    expect(declarations(config({}))).toEqual({ tenants: [], users: [] });
    const tenants = [{ name: 'alpha' }];
    const users = [{ name: 'alice', memberships: [{ tenant: 'alpha', role: 'viewer' as const }] }];
    expect(declarations(config({ tenants, users }))).toEqual({ tenants, users });
  });

  it('rejects invalid or duplicate names', () => {
    expect(() => declarations(config({ tenants: [{ name: 'Alpha' }] }))).toThrow(
      'tenants must be an array with valid names',
    );
    expect(() => declarations(config({ users: {} }))).toThrow('users must be an array');
    expect(() => declarations(config({ tenants: [{ name: 'a' }, { name: 'a' }] }))).toThrow(
      'Duplicate tenants names',
    );
    expect(() =>
      declarations(config({ tenants: [{ name: 'a', deletionPolicy: 'Keep' }] })),
    ).toThrow("deletionPolicy must be 'Retain' or 'Delete'");
  });

  it('rejects memberships that are duplicated, unknown or of an unknown role', () => {
    const tenants = [{ name: 'alpha' }];
    for (const memberships of [
      undefined,
      [
        { tenant: 'alpha', role: 'viewer' },
        { tenant: 'alpha', role: 'developer' },
      ],
      [{ tenant: 'beta', role: 'viewer' }],
      [{ tenant: 'alpha', role: 'admin' }],
    ])
      expect(() =>
        declarations(config({ tenants, users: [{ name: 'alice', memberships }] })),
      ).toThrow('User alice must have unique memberships');
  });
});
