import { beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import {
  installSchedulerPki,
  SCHEDULER_PKI_JOB,
  SCHEDULER_PKI_JOB_TTL_SECONDS,
  SCHEDULER_PKI_NAME,
  SCHEDULER_PKI_WRITES_MESSAGE,
  schedulerPkiBootstrap,
  schedulerPkiUser,
} from '../src/scheduler-pki-bootstrap';
import { controllerScriptHash } from '../src/tenancy/install';
import { NODE_IMAGE } from '../src/tenancy/node-image';
import { COMPONENT, INSTALLATION, NAMESPACE_ROLE, type Resource } from '../src/tenancy/resources';
import { evaluate } from './support/cel';

const SCRIPTS = { 'scheduler-pki-job.js': '// job', 'scheduler-pki.js': '// pki' };
const objects = schedulerPkiBootstrap('wasmcloud', 'di-test', SCRIPTS);
const find = (kind: string, namespace?: string) =>
  objects.filter(
    (o) => o.kind === kind && (namespace === undefined || o.metadata.namespace === namespace),
  );
interface Container {
  image: string;
  command: string[];
  env: unknown[];
  securityContext: unknown;
}
/** The fields of the bootstrap objects these tests read. */
interface Inspected extends Resource {
  automountServiceAccountToken?: boolean;
  rules?: unknown[];
  data?: Record<string, string>;
  spec: {
    ttlSecondsAfterFinished?: number;
    backoffLimit?: number;
    template: {
      metadata: { annotations: Record<string, string> };
      spec: {
        restartPolicy: string;
        serviceAccountName: string;
        automountServiceAccountToken: boolean;
        securityContext: unknown;
        volumes: unknown[];
        containers: Container[];
      };
    };
  };
}
const one = (kind: string, namespace?: string) => {
  const [found, ...more] = find(kind, namespace);
  if (!found || more.length) throw new Error(`expected one ${kind}`);
  return found as Inspected;
};
const PKI = 'wasmcloud-scheduler-pki';
const labels = { [INSTALLATION]: 'di-test', [COMPONENT]: 'scheduler-pki' };

describe('scheduler PKI bootstrap objects (#541, O4)', () => {
  it('creates the PKI namespace first and the Job last', () => {
    expect(
      objects.map((o) => `${o.kind} ${o.metadata.namespace ?? ''}/${o.metadata.name}`),
    ).toEqual([
      `Namespace /${PKI}`,
      'ValidatingAdmissionPolicy /di-test-scheduler-pki-writes',
      'ValidatingAdmissionPolicyBinding /di-test-scheduler-pki-writes',
      'ValidatingAdmissionPolicy /di-test-scheduler-pki-configmap-writes',
      'ValidatingAdmissionPolicyBinding /di-test-scheduler-pki-configmap-writes',
      `NetworkPolicy ${PKI}/di-scheduler-pki-deny-ingress`,
      `ServiceAccount ${PKI}/di-scheduler-pki`,
      `Role ${PKI}/di-scheduler-pki`,
      `RoleBinding ${PKI}/di-scheduler-pki`,
      'Role wasmcloud/di-scheduler-pki',
      'RoleBinding wasmcloud/di-scheduler-pki',
      `ConfigMap ${PKI}/di-scheduler-pki`,
      `Job ${PKI}/${SCHEDULER_PKI_JOB}`,
    ]);
    expect(one('Namespace').metadata).toEqual({
      name: PKI,
      labels: { [INSTALLATION]: 'di-test', [NAMESPACE_ROLE]: 'scheduler-pki' },
      annotations: { 'pulumi.com/skipAwait': 'true' },
    });
    for (const o of objects.slice(1)) expect(o.metadata.labels).toEqual(labels);
  });

  it('gives the ServiceAccount no token of its own, and the namespace no ingress', () => {
    expect(one('ServiceAccount').automountServiceAccountToken).toBe(false);
    expect(one('NetworkPolicy').spec as unknown).toEqual({
      podSelector: {},
      policyTypes: ['Ingress'],
    });
  });

  it('grants create, and reads and updates only the named objects', () => {
    expect(one('Role', PKI).rules).toEqual([
      { apiGroups: [''], resources: ['secrets', 'configmaps'], verbs: ['create'] },
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get'],
        resourceNames: ['di-scheduler-ca'],
      },
      {
        apiGroups: [''],
        resources: ['configmaps'],
        verbs: ['get', 'update'],
        resourceNames: ['di-scheduler-identities'],
      },
    ]);
    expect(one('Role', 'wasmcloud').rules).toEqual([
      { apiGroups: [''], resources: ['secrets', 'configmaps'], verbs: ['create'] },
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get'],
        resourceNames: [
          'di-scheduler-data-tls',
          'di-scheduler-nats-tls',
          'di-scheduler-operator-tls',
          'di-scheduler-platform-host-tls',
        ],
      },
      {
        apiGroups: [''],
        resources: ['configmaps'],
        verbs: ['get'],
        resourceNames: ['di-scheduler-nats-accounts'],
      },
    ]);
    for (const ns of [PKI, 'wasmcloud'])
      expect(one('RoleBinding', ns)).toMatchObject({
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: SCHEDULER_PKI_NAME },
        subjects: [{ kind: 'ServiceAccount', name: SCHEDULER_PKI_NAME, namespace: PKI }],
      });
    // No delete, list, watch or patch anywhere, and nothing cluster-scoped.
    const verbs = find('Role').flatMap((r) =>
      (r.rules as { verbs: string[] }[]).flatMap((x) => x.verbs),
    );
    expect([...new Set(verbs)].sort()).toEqual(['create', 'get', 'update']);
    expect(objects.some((o) => o.kind.startsWith('Cluster'))).toBe(false);
  });

  it('is not awaited, so it cannot fail `pulumi up` before m6 (W1)', () => {
    expect(one('Job').metadata.annotations).toEqual({ 'pulumi.com/skipAwait': 'true' });
  });

  it('runs the controller image and scripts once, mounting no Secret', () => {
    expect(one('ConfigMap').data).toEqual(SCRIPTS);
    const job = one('Job');
    expect(job.spec.ttlSecondsAfterFinished).toBe(SCHEDULER_PKI_JOB_TTL_SECONDS);
    expect(job.spec.backoffLimit).toBe(4);
    const pod = job.spec.template.spec;
    expect(job.spec.template.metadata.annotations).toEqual({
      'di-framework.dev/script-hash': controllerScriptHash(SCRIPTS),
    });
    expect(pod.restartPolicy).toBe('Never');
    expect(pod.serviceAccountName).toBe(SCHEDULER_PKI_NAME);
    expect(pod.automountServiceAccountToken).toBe(true);
    expect(pod.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(pod.volumes).toEqual([{ name: 'scripts', configMap: { name: SCHEDULER_PKI_NAME } }]);
    const [container, ...others] = pod.containers as [Container, ...Container[]];
    expect(others).toEqual([]);
    expect(container.image).toBe(NODE_IMAGE);
    expect(container.command).toEqual(['node', '/scheduler-pki/scheduler-pki-job.js']);
    expect(container.env).toEqual([
      {
        name: 'SCHEDULER_PKI_CONFIG',
        value: JSON.stringify({ installation: 'di-test', namespace: 'wasmcloud' }),
      },
    ]);
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(JSON.stringify(objects)).not.toContain('secretName');
  });

  it('refuses a platform namespace whose PKI namespace name does not fit', () => {
    expect(() => schedulerPkiBootstrap('a'.repeat(50), 'di-test', SCRIPTS)).toThrow('at most 63');
  });
});

// --- Admission of the Job's writes (W4) -----------------------------------------------------

interface Policy {
  spec: {
    failurePolicy: string;
    matchConstraints: {
      namespaceSelector: {
        matchExpressions: { key: string; operator: string; values: string[] }[];
      };
      resourceRules: { apiGroups: string[]; operations: string[]; resources: string[] }[];
    };
    matchConditions: { expression: string }[];
    validations: { expression: string; message: string }[];
  };
}

describe('scheduler PKI writes policy (#541, W4)', () => {
  const policies = find('ValidatingAdmissionPolicy') as unknown as (Policy & Resource)[];
  const bindings = find('ValidatingAdmissionPolicyBinding');
  const JOB_USER = `system:serviceaccount:${PKI}:${SCHEDULER_PKI_NAME}`;
  /** The one policy whose resourceRules match `resource`; a write is admitted by its rule. */
  const policyFor = (resource: 'secrets' | 'configmaps') => {
    const [found, ...more] = policies.filter((p) =>
      p.spec.matchConstraints.resourceRules.some((r) => r.resources.includes(resource)),
    );
    if (!found || more.length) throw new Error(`expected one policy for ${resource}`);
    return found;
  };
  const admit = (
    namespace: string,
    resource: 'secrets' | 'configmaps',
    object: Record<string, unknown>,
  ) =>
    policyFor(resource).spec.validations.every(
      (rule) =>
        evaluate(rule.expression, {
          request: { namespace, resource: { resource }, userInfo: { username: JOB_USER } },
          object: { metadata: {}, ...object },
        }) === true,
    );
  const named = (name: string, type?: string) => ({
    metadata: { name },
    ...(type === undefined ? {} : { type }),
  });

  it('has one policy per kind, each binding the Job ServiceAccount in two namespaces', () => {
    expect(schedulerPkiUser('wasmcloud')).toBe(JOB_USER);
    expect(policies.map((p) => p.metadata.name)).toEqual([
      'di-test-scheduler-pki-writes',
      'di-test-scheduler-pki-configmap-writes',
    ]);
    expect(policyFor('secrets').metadata.name).toBe('di-test-scheduler-pki-writes');
    expect(policyFor('configmaps').metadata.name).toBe('di-test-scheduler-pki-configmap-writes');
    for (const policy of policies) {
      expect(policy.spec.failurePolicy).toBe('Fail');
      expect(policy.spec.matchConstraints.namespaceSelector.matchExpressions).toEqual([
        { key: 'kubernetes.io/metadata.name', operator: 'In', values: ['wasmcloud', PKI] },
      ]);
      expect(policy.spec.matchConstraints.resourceRules).toHaveLength(1);
      expect(policy.spec.matchConstraints.resourceRules[0]).toMatchObject({
        apiGroups: [''],
        operations: ['CREATE', 'UPDATE'],
      });
      expect(policy.spec.matchConstraints.resourceRules[0]?.resources).toHaveLength(1);
      const [condition] = policy.spec.matchConditions as [{ expression: string }];
      expect(
        evaluate(condition.expression, { request: { userInfo: { username: JOB_USER } } }),
      ).toBe(true);
      expect(
        evaluate(condition.expression, {
          request: {
            userInfo: { username: 'system:serviceaccount:wasmcloud:di-platform-controller' },
          },
        }),
      ).toBe(false);
      expect(policy.spec.validations.map((v) => v.message)).toEqual([SCHEDULER_PKI_WRITES_MESSAGE]);
    }
    expect(bindings.map((b) => b.spec as unknown)).toEqual(
      policies.map((p) => ({ policyName: p.metadata.name, validationActions: ['Deny'] })),
    );
  });

  it('reads object.type only in the policy that matches Secrets alone (it type-checks)', () => {
    const configMapRule = policyFor('configmaps').spec.validations[0]?.expression ?? '';
    expect(configMapRule).not.toContain('object.type');
    expect(configMapRule).not.toContain('request.resource');
    expect(policyFor('secrets').spec.validations[0]?.expression).toContain('object.type');
  });

  it('admits the named objects of their expected types', () => {
    expect(admit(PKI, 'secrets', named('di-scheduler-ca', 'Opaque'))).toBe(true);
    expect(admit(PKI, 'configmaps', named('di-scheduler-identities'))).toBe(true);
    for (const name of [
      'di-scheduler-nats-tls',
      'di-scheduler-operator-tls',
      'di-scheduler-platform-host-tls',
      'di-scheduler-data-tls',
    ])
      expect(admit('wasmcloud', 'secrets', named(name, 'kubernetes.io/tls'))).toBe(true);
    // #541 m2: the accounts file, in the platform namespace.
    expect(admit('wasmcloud', 'configmaps', named('di-scheduler-nats-accounts'))).toBe(true);
  });

  it('refuses token Secrets, other names, other types and the wrong namespace', () => {
    const token = 'kubernetes.io/service-account-token';
    for (const [namespace, resource, object] of [
      ['wasmcloud', 'secrets', named('di-scheduler-nats-tls', token)],
      ['wasmcloud', 'secrets', named('controller-token', token)],
      [PKI, 'secrets', named('di-scheduler-ca', token)],
      [PKI, 'secrets', named('job-token', token)],
      ['wasmcloud', 'secrets', named('di-scheduler-nats-tls', 'Opaque')],
      ['wasmcloud', 'secrets', named('di-scheduler-nats-tls')],
      ['wasmcloud', 'secrets', named('other-tls', 'kubernetes.io/tls')],
      [PKI, 'secrets', named('di-scheduler-ca', 'kubernetes.io/tls')],
      [PKI, 'secrets', named('di-scheduler-ca')],
      [PKI, 'secrets', named('di-scheduler-nats-tls', 'kubernetes.io/tls')],
      ['wasmcloud', 'secrets', named('di-scheduler-ca', 'Opaque')],
      [PKI, 'configmaps', named('other')],
      ['wasmcloud', 'configmaps', named('di-scheduler-identities')],
      [PKI, 'configmaps', named('di-scheduler-nats-accounts')],
      ['wasmcloud', 'configmaps', named('other')],
      ['wasmcloud', 'secrets', named('di-scheduler-nats-accounts', 'Opaque')],
      ['wasmcloud', 'configmaps', { metadata: { generateName: 'di-scheduler-nats-accounts' } }],
      [PKI, 'configmaps', named('di-scheduler-ca')],
      ['wasmcloud', 'configmaps', named('di-scheduler-nats-tls')],
      [PKI, 'secrets', named('di-scheduler-identities', 'Opaque')],
      [PKI, 'configmaps', {}],
      [PKI, 'secrets', { metadata: { generateName: 'di-scheduler-ca' }, type: 'Opaque' }],
    ] as const)
      expect(admit(namespace, resource, object as Record<string, unknown>)).toBe(false);
  });
});

// --- Pulumi ordering -------------------------------------------------------------------------

interface RegisterRequest {
  getName(): string;
  getType(): string;
  getDependenciesList(): string[];
  getDeletebeforereplace(): boolean;
}
const registered = new Map<
  string,
  { type: string; dependencies: string[]; deleteBeforeReplace: boolean }
>();
const urnOf = (name: string) => {
  const found = registered.get(name);
  if (!found) throw new Error(`${name} was not registered`);
  return `urn:pulumi:test::project::${found.type}::${name}`;
};

describe('installSchedulerPki', () => {
  beforeAll(async () => {
    await pulumi.runtime.setMocks(
      {
        newResource: (args) => ({ id: args.name, state: args.inputs }),
        call: (args) => args.inputs,
      },
      'project',
      'test',
      false,
    );
    const monitor = (
      pulumi.runtime as unknown as {
        getMonitor(): { registerResource(request: RegisterRequest, callback: unknown): unknown };
      }
    ).getMonitor();
    const register = monitor.registerResource.bind(monitor);
    monitor.registerResource = (request, callback) => {
      registered.set(request.getName(), {
        type: request.getType(),
        dependencies: request.getDependenciesList(),
        deleteBeforeReplace: request.getDeletebeforereplace(),
      });
      return register(request, callback);
    };
    const provider = new k8s.Provider('test', {});
    const platformNamespace = new k8s.core.v1.Namespace('wasmcloud', {}, { provider });
    const job = installSchedulerPki({
      namespace: 'wasmcloud',
      installation: 'di-test',
      provider,
      dependsOn: [platformNamespace],
      scripts: SCRIPTS,
    });
    await new Promise((resolve) => job.urn.apply(resolve));
  });

  it('applies the namespace, then the prerequisites, then the Job (replaced delete-first)', () => {
    const ns = 'scheduler-pki-namespace-cluster-wasmcloud-scheduler-pki';
    const job = `scheduler-pki-job-${PKI}-${SCHEDULER_PKI_JOB}`;
    const prerequisites = [
      'scheduler-pki-validatingadmissionpolicy-cluster-di-test-scheduler-pki-writes',
      'scheduler-pki-validatingadmissionpolicybinding-cluster-di-test-scheduler-pki-writes',
      'scheduler-pki-validatingadmissionpolicy-cluster-di-test-scheduler-pki-configmap-writes',
      'scheduler-pki-validatingadmissionpolicybinding-cluster-di-test-scheduler-pki-configmap-writes',
      `scheduler-pki-networkpolicy-${PKI}-di-scheduler-pki-deny-ingress`,
      `scheduler-pki-serviceaccount-${PKI}-di-scheduler-pki`,
      `scheduler-pki-role-${PKI}-di-scheduler-pki`,
      `scheduler-pki-rolebinding-${PKI}-di-scheduler-pki`,
      'scheduler-pki-role-wasmcloud-di-scheduler-pki',
      'scheduler-pki-rolebinding-wasmcloud-di-scheduler-pki',
      `scheduler-pki-configmap-${PKI}-di-scheduler-pki`,
    ];
    expect(registered.get(ns)?.dependencies).toEqual([urnOf('wasmcloud')]);
    for (const name of prerequisites) {
      expect(registered.get(name)?.dependencies.sort()).toEqual(
        [urnOf(ns), urnOf('wasmcloud')].sort(),
      );
      expect(registered.get(name)?.deleteBeforeReplace).toBe(false);
    }
    expect(registered.get(job)?.dependencies.sort()).toEqual(prerequisites.map(urnOf).sort());
    expect(registered.get(job)?.deleteBeforeReplace).toBe(true);
  });
});

it('createPlatform installs the bootstrap Job, and the Helm release does not wait for it (W1)', () => {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    const registered = {};
    pulumi.runtime.setMocks({ newResource: a => ({id:a.name, state:a.inputs}), call: a => a.inputs }, 'project', 'test', false);
    const monitor = pulumi.runtime.getMonitor();
    const register = monitor.registerResource.bind(monitor);
    monitor.registerResource = (request, callback) => {
      registered[request.getName()] = { type: request.getType(), dependencies: request.getDependenciesList() };
      return register(request, callback);
    };
    pulumi.runtime.runInPulumiStack(async () => {
      const platform = require('./dist').createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test' });
      await new Promise(r => platform.release.urn.apply(r));
      // The release no longer waits for the Job, so wait for the Job's own registration.
      while (!registered['scheduler-pki-job-${PKI}-${SCHEDULER_PKI_JOB}']) await new Promise(r => setTimeout(r, 10));
    }).then(() => console.log(JSON.stringify(registered))).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: join(import.meta.dir, '..'), encoding: 'utf8' },
  );
  const all = JSON.parse(output) as Record<string, { type: string; dependencies: string[] }>;
  const job = `scheduler-pki-job-${PKI}-${SCHEDULER_PKI_JOB}`;
  expect(all[job]?.type).toBe('kubernetes:batch/v1:Job');
  // Until m6 mounts its Secrets, the release must not be gated on the Job (m6 restores this).
  expect(all.wasmcloud?.dependencies.length).toBeGreaterThan(0);
  expect(all.wasmcloud?.dependencies.filter((urn) => urn.includes('scheduler-pki'))).toEqual([]);
  // The Job's scripts are the controller's, read from the package build.
  const scripts = all[`scheduler-pki-configmap-${PKI}-di-scheduler-pki`];
  expect(scripts?.type).toBe('kubernetes:core/v1:ConfigMap');
  expect(all[`scheduler-pki-namespace-cluster-${PKI}`]?.type).toBe('kubernetes:core/v1:Namespace');
  expect(all[`scheduler-pki-role-wasmcloud-di-scheduler-pki`]?.type).toBe(
    'kubernetes:rbac.authorization.k8s.io/v1:Role',
  );
}, 60_000);

it('createPlatform refuses a namespace too long for its PKI namespace before any resource', () => {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    const resources = [];
    pulumi.runtime.setMocks({ newResource: a => { resources.push(a.type); return {id:a.name, state:a.inputs}; }, call: a => a.inputs }, 'project', 'test', false);
    pulumi.runtime.runInPulumiStack(async () => {
      try { require('./dist').createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', namespace:'${'a'.repeat(50)}' }); }
      catch (e) { return e.message; }
    }).then(error => console.log(JSON.stringify({ error, resources: resources.filter(t => !t.startsWith('pulumi:')) })));
  `,
    ],
    { cwd: join(import.meta.dir, '..'), encoding: 'utf8' },
  );
  const { error, resources } = JSON.parse(output);
  expect(error).toContain('at most 63 characters');
  expect(resources).toEqual([]);
}, 60_000);
