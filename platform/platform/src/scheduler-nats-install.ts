import * as k8s from '@pulumi/kubernetes';
import type * as pulumi from '@pulumi/pulumi';
import { schedulerNatsServerResources } from './scheduler-nats-server';

/**
 * Keeps the Service when a Helm upgrade drops it from the release: Helm skips deleting a removed
 * object whose live copy carries this annotation.
 */
export const HELM_KEEP = { 'helm.sh/resource-policy': 'keep' } as const;

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
  }) as unknown as [never, never, never, Record<string, Record<string, unknown>>];
  const opts = { provider: args.provider, dependsOn: args.dependsOn };
  const configMap = new k8s.core.v1.ConfigMap('scheduler-nats-config', config, opts);
  const serviceAccount = new k8s.core.v1.ServiceAccount('scheduler-nats-account', account, opts);
  const deployment = new k8s.apps.v1.Deployment('scheduler-nats', workload, {
    ...opts,
    dependsOn: [...args.dependsOn, configMap, serviceAccount],
  });
  const adopt =
    args.kubeconfig === undefined
      ? args.provider
      : new k8s.Provider('scheduler-nats-adopt', {
          kubeconfig: args.kubeconfig,
          context: args.kubeContext,
          enableServerSideApply: true,
          upsertExistingObjects: true,
        });
  const metadata = serviceManifest.metadata as Record<string, unknown>;
  const service = new k8s.core.v1.Service(
    'scheduler-nats-service',
    { ...serviceManifest, metadata: { ...metadata, annotations: HELM_KEEP } } as never,
    { provider: adopt, dependsOn: [deployment] },
  );
  return { deployment, service, resources: [configMap, serviceAccount, deployment, service] };
}
