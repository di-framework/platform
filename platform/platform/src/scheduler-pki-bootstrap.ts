import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as k8s from '@pulumi/kubernetes';
import type * as pulumi from '@pulumi/pulumi';
import { controllerScriptHash } from './tenancy/install';
import { NODE_IMAGE } from './tenancy/node-image';
import { COMPONENT, INSTALLATION, NAMESPACE_ROLE, type Resource } from './tenancy/resources';
import { SCHEDULER_NATS_ACCOUNTS } from './tenancy/scheduler-nats';
import {
  codeUnitOrder,
  PLATFORM_SECRETS,
  SCHEDULER_CA_SECRET,
  SCHEDULER_IDENTITIES,
  SCHEDULER_PKI_COMPONENT,
  SCHEDULER_PKI_MODULES,
  schedulerPkiNamespace,
} from './tenancy/scheduler-pki';

/** The Job's compiled scripts (`SCHEDULER_PKI_MODULES`), read from the package build. */
export function loadSchedulerPkiScripts(
  tenancyDir: string = path.join(__dirname, 'tenancy'),
): Record<string, string> {
  return Object.fromEntries(
    SCHEDULER_PKI_MODULES.map((name) => [
      `${name}.js`,
      readFileSync(path.join(tenancyDir, `${name}.js`), 'utf8'),
    ]),
  );
}

/** The bootstrap Job, its ServiceAccount, Roles and code ConfigMap all carry this name. */
export const SCHEDULER_PKI_NAME = 'di-scheduler-pki';
/** The bootstrap Job. */
export const SCHEDULER_PKI_JOB = 'di-scheduler-pki-bootstrap';
/**
 * A finished Job is deleted after this many seconds. A `pulumi up` that changes its scripts
 * replaces it, so it runs again.
 */
export const SCHEDULER_PKI_JOB_TTL_SECONDS = 600;

/** The Job's ServiceAccount as the API server names it in `request.userInfo.username`. */
export const schedulerPkiUser = (namespace: string): string =>
  `system:serviceaccount:${schedulerPkiNamespace(namespace)}:${SCHEDULER_PKI_NAME}`;

/** The refusal of {@link schedulerPkiWritesPolicy}. */
export const SCHEDULER_PKI_WRITES_MESSAGE =
  'the scheduler PKI Job may write only its named Secrets and ConfigMaps, of their expected types';

/**
 * The Secret rule of {@link schedulerPkiWritesPolicy}: which Secrets the Job's ServiceAccount may
 * create or update. In the PKI namespace, the `Opaque` Secret `di-scheduler-ca`; in the platform
 * namespace, the `kubernetes.io/tls` scheduler Secrets. Nothing else, and never a
 * `kubernetes.io/service-account-token` Secret (W4, design-541 §4.5). Its policy matches only
 * Secrets, so `object.type` type-checks.
 */
export function schedulerPkiWritesRule(namespace: string): string {
  const pki = schedulerPkiNamespace(namespace);
  const names = Object.values(PLATFORM_SECRETS)
    .sort(codeUnitOrder)
    .map((name) => `'${name}'`)
    .join(', ');
  const named = 'has(object.metadata.name)';
  const typed = (type: string) => `has(object.type) && object.type == '${type}'`;
  return [
    `(request.namespace == '${pki}' && ${named} &&`,
    `  object.metadata.name == '${SCHEDULER_CA_SECRET}' && ${typed('Opaque')}) ||`,
    `(request.namespace == '${namespace}' && ${named} &&`,
    `  object.metadata.name in [${names}] && ${typed('kubernetes.io/tls')})`,
  ].join('\n');
}

/**
 * The ConfigMap rule of {@link schedulerPkiWritesPolicy}: in the PKI namespace, only the
 * ConfigMap `di-scheduler-identities`; in the platform namespace, only the ConfigMap
 * `di-scheduler-nats-accounts` (#541 m2). A ConfigMap has no `type`, so this rule has a policy of
 * its own that matches only ConfigMaps.
 */
export function schedulerPkiConfigMapWritesRule(namespace: string): string {
  const pki = schedulerPkiNamespace(namespace);
  const named = 'has(object.metadata.name)';
  return [
    `(request.namespace == '${pki}' && ${named} &&`,
    `  object.metadata.name == '${SCHEDULER_IDENTITIES}') ||`,
    `(request.namespace == '${namespace}' && ${named} &&`,
    `  object.metadata.name == '${SCHEDULER_NATS_ACCOUNTS}')`,
  ].join('\n');
}

/**
 * The admission policies and bindings that confine the Job's writes (W4). RBAC cannot scope
 * `create` by name, so the Job's ServiceAccount could otherwise create any Secret in both
 * namespaces, including a token Secret for another ServiceAccount. Each policy matches only that
 * ServiceAccount, in only those two namespaces, and fails closed. There is one policy per
 * resource kind, because the API server type-checks a rule against every kind its policy
 * matches: `object.type` exists on a Secret, not on a ConfigMap.
 */
export function schedulerPkiWritesPolicy(namespace: string, installation: string): Resource[] {
  return [
    ...pkiWritesPolicy(namespace, installation, `${installation}-scheduler-pki-writes`, {
      resource: 'secrets',
      expression: schedulerPkiWritesRule(namespace),
    }),
    ...pkiWritesPolicy(namespace, installation, `${installation}-scheduler-pki-configmap-writes`, {
      resource: 'configmaps',
      expression: schedulerPkiConfigMapWritesRule(namespace),
    }),
  ];
}

function pkiWritesPolicy(
  namespace: string,
  installation: string,
  name: string,
  rule: { resource: 'secrets' | 'configmaps'; expression: string },
): Resource[] {
  const labels = { [INSTALLATION]: installation, [COMPONENT]: SCHEDULER_PKI_COMPONENT };
  return [
    {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicy',
      metadata: { name, labels },
      spec: {
        failurePolicy: 'Fail',
        matchConstraints: {
          namespaceSelector: {
            matchExpressions: [
              {
                key: 'kubernetes.io/metadata.name',
                operator: 'In',
                values: [namespace, schedulerPkiNamespace(namespace)],
              },
            ],
          },
          resourceRules: [
            {
              apiGroups: [''],
              apiVersions: ['v1'],
              operations: ['CREATE', 'UPDATE'],
              resources: [rule.resource],
            },
          ],
        },
        matchConditions: [
          {
            name: 'scheduler-pki-job',
            expression: `request.userInfo.username == '${schedulerPkiUser(namespace)}'`,
          },
        ],
        validations: [{ expression: rule.expression, message: SCHEDULER_PKI_WRITES_MESSAGE }],
      },
    },
    {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicyBinding',
      metadata: { name, labels },
      spec: { policyName: name, validationActions: ['Deny'] },
    },
  ];
}

/**
 * The scheduler PKI namespace and the one-shot bootstrap Job that fills it (#541, O4), in the
 * order they are applied. The Job runs the controller's image with the scheduler PKI scripts
 * (`scripts`, from {@link loadSchedulerPkiScripts}) and the `scheduler-pki` entry point, and no
 * other controller code. It creates the CAs, the
 * identity record and the platform's scheduler Secrets when missing, and overwrites nothing, so
 * no key enters Pulumi state.
 *
 * RBAC `resourceNames` cannot restrict `create`, so the Role grants `create` on Secrets and
 * ConfigMaps (design-541 §4.5, "RBAC, as it really is"), and {@link schedulerPkiWritesPolicy}
 * refuses every write but the Job's named objects of their expected types. It reads and updates
 * only the named objects. The ServiceAccount
 * mounts no token by default; only the Job's pod receives one. The PKI namespace admits no
 * ingress, and nothing else runs there.
 */
export function schedulerPkiBootstrap(
  namespace: string,
  installation: string,
  scripts: Record<string, string>,
): Resource[] {
  const pki = schedulerPkiNamespace(namespace);
  const labels = { [INSTALLATION]: installation, [COMPONENT]: SCHEDULER_PKI_COMPONENT };
  const meta = (name: string, ns: string = pki) => ({ name, namespace: ns, labels });
  const role = (ns: string, rules: unknown[]): Resource[] => [
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: meta(SCHEDULER_PKI_NAME, ns),
      rules,
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: meta(SCHEDULER_PKI_NAME, ns),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: SCHEDULER_PKI_NAME },
      subjects: [{ kind: 'ServiceAccount', name: SCHEDULER_PKI_NAME, namespace: pki }],
    },
  ];
  return [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: pki,
        labels: { [INSTALLATION]: installation, [NAMESPACE_ROLE]: SCHEDULER_PKI_COMPONENT },
        // As for the platform namespace: teardown does not wait on namespace GC.
        annotations: { 'pulumi.com/skipAwait': 'true' },
      },
    },
    // Before anything the Job could write with: it confines the Job's `create` (W4).
    ...schedulerPkiWritesPolicy(namespace, installation),
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: meta('di-scheduler-pki-deny-ingress'),
      spec: { podSelector: {}, policyTypes: ['Ingress'] },
    },
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: meta(SCHEDULER_PKI_NAME),
      automountServiceAccountToken: false,
    },
    ...role(pki, [
      { apiGroups: [''], resources: ['secrets', 'configmaps'], verbs: ['create'] },
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get'],
        resourceNames: [SCHEDULER_CA_SECRET],
      },
      {
        apiGroups: [''],
        resources: ['configmaps'],
        verbs: ['get', 'update'],
        resourceNames: [SCHEDULER_IDENTITIES],
      },
    ]),
    ...role(namespace, [
      { apiGroups: [''], resources: ['secrets', 'configmaps'], verbs: ['create'] },
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get'],
        resourceNames: Object.values(PLATFORM_SECRETS).sort(codeUnitOrder),
      },
      {
        apiGroups: [''],
        resources: ['configmaps'],
        verbs: ['get'],
        resourceNames: [SCHEDULER_NATS_ACCOUNTS],
      },
    ]),
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: meta(SCHEDULER_PKI_NAME),
      data: scripts,
    },
    {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        ...meta(SCHEDULER_PKI_JOB),
        // Awaited: the scheduler NATS and the Helm release mount its Secrets (#541 m6e). A Job left
        // unfinished by an interrupted `up` is replaced on the next one rather than awaited (#567 S2).
        annotations: { 'pulumi.com/replaceUnready': 'true' },
      },
      spec: {
        backoffLimit: 4,
        activeDeadlineSeconds: 300,
        ttlSecondsAfterFinished: SCHEDULER_PKI_JOB_TTL_SECONDS,
        template: {
          metadata: {
            labels: { app: SCHEDULER_PKI_JOB },
            annotations: { 'di-framework.dev/script-hash': controllerScriptHash(scripts) },
          },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: SCHEDULER_PKI_NAME,
            automountServiceAccountToken: true,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'scheduler-pki',
                image: NODE_IMAGE,
                command: ['node', '/scheduler-pki/scheduler-pki-job.js'],
                env: [
                  {
                    name: 'SCHEDULER_PKI_CONFIG',
                    value: JSON.stringify({ installation, namespace }),
                  },
                ],
                resources: {
                  requests: { cpu: '20m', memory: '64Mi' },
                  limits: { cpu: '250m', memory: '128Mi' },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [{ name: 'scripts', mountPath: '/scheduler-pki', readOnly: true }],
              },
            ],
            volumes: [{ name: 'scripts', configMap: { name: SCHEDULER_PKI_NAME } }],
          },
        },
      },
    },
  ];
}

/**
 * Applies {@link schedulerPkiBootstrap}: the namespace first, then the Job's admission policy,
 * RBAC, code and network policy, then the Job. It returns the Job, which Pulumi awaits: the
 * scheduler NATS and the Helm release depend on it (#541 m6e).
 */
export function installSchedulerPki(args: {
  namespace: string;
  installation: string;
  provider: k8s.Provider;
  /** The platform namespace resource and anything else the PKI waits for. */
  dependsOn: pulumi.Resource[];
  scripts: Record<string, string>;
}): pulumi.Resource {
  const objects = schedulerPkiBootstrap(args.namespace, args.installation, args.scripts);
  // Typed resources, so each object gets its standard type token and await behaviour.
  const kinds: Record<
    string,
    new (
      name: string,
      value: never,
      opts: pulumi.CustomResourceOptions,
    ) => pulumi.CustomResource
  > = {
    Namespace: k8s.core.v1.Namespace,
    ValidatingAdmissionPolicy: k8s.admissionregistration.v1.ValidatingAdmissionPolicy,
    ValidatingAdmissionPolicyBinding: k8s.admissionregistration.v1.ValidatingAdmissionPolicyBinding,
    NetworkPolicy: k8s.networking.v1.NetworkPolicy,
    ServiceAccount: k8s.core.v1.ServiceAccount,
    Role: k8s.rbac.v1.Role,
    RoleBinding: k8s.rbac.v1.RoleBinding,
    ConfigMap: k8s.core.v1.ConfigMap,
    Job: k8s.batch.v1.Job,
  };
  // `deleteBeforeReplace` stays unset unless given: the Kubernetes provider then deletes a
  // fixed-name object before creating its replacement. An explicit `false` overrides that, and
  // replacing the code ConfigMap collides with the old one ("already exists", #594).
  const create = (value: Resource, dependsOn: pulumi.Resource[], deleteBeforeReplace?: true) => {
    const Kind = kinds[value.kind] as (typeof kinds)[string];
    return new Kind(
      `scheduler-pki-${value.kind.toLowerCase()}-${value.metadata.namespace ?? 'cluster'}-${value.metadata.name}`,
      value as never,
      { provider: args.provider, dependsOn, ...(deleteBeforeReplace && { deleteBeforeReplace }) },
    );
  };
  const [namespace, ...rest] = objects as [Resource, ...Resource[]];
  const pki = create(namespace, args.dependsOn);
  const job = rest.pop() as Resource;
  const prerequisites = rest.map((value) => create(value, [pki, ...args.dependsOn]));
  // A changed Job is replaced under the same name, so the old one goes first. Its pod template
  // carries the scripts' hash, so changed scripts replace the Job and it runs them once more; it
  // creates only missing PKI objects, so the re-run changes nothing that exists.
  return create(job, prerequisites, true);
}
