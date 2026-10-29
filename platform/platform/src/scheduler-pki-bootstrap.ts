import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as k8s from '@pulumi/kubernetes';
import type * as pulumi from '@pulumi/pulumi';
import { controllerScriptHash } from './tenancy/install';
import { NODE_IMAGE } from './tenancy/node-image';
import { COMPONENT, INSTALLATION, NAMESPACE_ROLE, type Resource } from './tenancy/resources';
import {
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

/**
 * The scheduler PKI namespace and the one-shot bootstrap Job that fills it (#541, O4), in the
 * order they are applied. The Job runs the controller's image with the scheduler PKI scripts
 * (`scripts`, from {@link loadSchedulerPkiScripts}) and the `scheduler-pki` entry point, and no
 * other controller code. It creates the CAs, the
 * identity record and the platform's scheduler Secrets when missing, and overwrites nothing, so
 * no key enters Pulumi state.
 *
 * RBAC `resourceNames` cannot restrict `create`, so the Job's ServiceAccount may create any Secret
 * or ConfigMap in the PKI namespace and any Secret in the platform namespace (design-541 §4.5,
 * "RBAC, as it really is"). It reads and updates only the named objects. The ServiceAccount
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
      { apiGroups: [''], resources: ['secrets'], verbs: ['create'] },
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get'],
        resourceNames: Object.values(PLATFORM_SECRETS).sort(),
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
      metadata: meta(SCHEDULER_PKI_JOB),
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
 * Applies {@link schedulerPkiBootstrap}: the namespace first, then the Job's RBAC, code and
 * policy, then the Job. It returns the Job, which the Helm release depends on.
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
    NetworkPolicy: k8s.networking.v1.NetworkPolicy,
    ServiceAccount: k8s.core.v1.ServiceAccount,
    Role: k8s.rbac.v1.Role,
    RoleBinding: k8s.rbac.v1.RoleBinding,
    ConfigMap: k8s.core.v1.ConfigMap,
    Job: k8s.batch.v1.Job,
  };
  const create = (value: Resource, dependsOn: pulumi.Resource[], deleteBeforeReplace = false) => {
    const Kind = kinds[value.kind] as (typeof kinds)[string];
    return new Kind(
      `scheduler-pki-${value.kind.toLowerCase()}-${value.metadata.namespace ?? 'cluster'}-${value.metadata.name}`,
      value as never,
      { provider: args.provider, dependsOn, deleteBeforeReplace },
    );
  };
  const [namespace, ...rest] = objects as [Resource, ...Resource[]];
  const pki = create(namespace, args.dependsOn);
  const job = rest.pop() as Resource;
  const prerequisites = rest.map((value) => create(value, [pki, ...args.dependsOn]));
  // A changed Job is replaced under the same name, so the old one goes first.
  return create(job, prerequisites, true);
}
