import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { schedulerNatsServerResources } from './scheduler-nats-server';

/**
 * Keeps the Service when a Helm upgrade drops it from the release: Helm skips deleting a removed
 * object whose live copy carries this annotation.
 */
export const HELM_KEEP = { 'helm.sh/resource-policy': 'keep' } as const;

/** Pulumi's annotation that skips its readiness wait for the annotated object. */
const SKIP_AWAIT = 'pulumi.com/skipAwait';

export interface SchedulerNatsInstallArgs {
  namespace: string;
  /** The runtime-operator Helm release name, for the chart's labels on the objects. */
  release?: string;
  provider: k8s.Provider;
  /**
   * The admin kubeconfig `provider` uses. The Service `nats` is applied through a provider of its
   * own built from it, which adopts the chart's Service of an existing install in place. Without
   * it the Service is created through `provider`, which works on a fresh install only.
   */
  kubeconfig?: pulumi.Input<string>;
  kubeContext?: pulumi.Input<string | undefined>;
  /** The platform namespace and the scheduler PKI Job, whose Secrets and accounts file it mounts. */
  dependsOn: pulumi.Resource[];
}

/**
 * Installs the platform-owned scheduler NATS (#541 m6e, design-541 §4.1): its ConfigMap,
 * ServiceAccount and Deployment `di-scheduler-nats`, awaited Ready, then the Service `nats`.
 *
 * The Service keeps the chart's name, labels, selector and port, so its clients and the policies
 * keep working. An upgrade from a release whose chart rendered `nats` adopts that Service in place
 * (server-side apply, `upsertExistingObjects`), so its UID and ClusterIP survive, and it carries
 * {@link HELM_KEEP}, so the Helm upgrade that stops rendering it leaves it alone. The adopting
 * provider is used for this object only: everything else keeps failing on an existing object.
 */
export function installSchedulerNats(args: SchedulerNatsInstallArgs): {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  resources: pulumi.Resource[];
} {
  const [config, account, workload, serviceManifest] = schedulerNatsServerResources({
    namespace: args.namespace,
    release: args.release,
  });
  if (args.kubeconfig === undefined)
    pulumi.log.warn(
      'installSchedulerNats: no kubeconfig, so the Service `nats` is created, not adopted; an upgrade of an install whose chart rendered it fails at that Service',
    );
  const adopt =
    args.kubeconfig === undefined
      ? args.provider
      : new k8s.Provider('scheduler-nats-adopt', {
          // A secret, like every admin kubeconfig: provider inputs go to the state as they are.
          kubeconfig: pulumi.secret(args.kubeconfig),
          context: args.kubeContext,
          enableServerSideApply: true,
          upsertExistingObjects: true,
        });
  // Adopted first, so an upgrade that cannot adopt it fails before the new server takes traffic.
  // Not awaited: on a fresh install it has no endpoints until the server below is Ready, and the
  // release waits for that server.
  const service = new k8s.core.v1.Service(
    'scheduler-nats-service',
    {
      ...serviceManifest,
      metadata: {
        ...serviceManifest.metadata,
        annotations: { ...HELM_KEEP, [SKIP_AWAIT]: 'true' },
      },
    },
    { provider: adopt, dependsOn: args.dependsOn },
  );
  const opts = { provider: args.provider, dependsOn: [...args.dependsOn, service] };
  const configMap = new k8s.core.v1.ConfigMap('scheduler-nats-config', config, opts);
  const serviceAccount = new k8s.core.v1.ServiceAccount('scheduler-nats-account', account, opts);
  const deployment = new k8s.apps.v1.Deployment('scheduler-nats', workload, {
    ...opts,
    dependsOn: [...opts.dependsOn, configMap, serviceAccount],
  });
  return { deployment, service, resources: [service, configMap, serviceAccount, deployment] };
}
