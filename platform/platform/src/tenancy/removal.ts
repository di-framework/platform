import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';
import type { DeletionPolicy } from './backing-services';
import { GROUP, INSTALLATION, names } from './resources';

/** A Tenant custom resource as listed from the cluster; only the fields this check reads. */
export interface LiveTenant {
  metadata: { name: string };
  spec?: { deletionPolicy?: DeletionPolicy };
}
/** Lists the Tenants labelled with one installation. */
export type TenantLister = (installation: string) => Promise<LiveTenant[]>;

/** The line for one tenant whose removal keeps its namespaces. */
export function retainedNamespacesMessage(tenant: string): string {
  const n = names(tenant);
  return (
    `Tenant ${tenant} is being removed with deletionPolicy Retain: namespaces ${n.namespace}, ` +
    `${n.runtimeNamespace} and ${n.apiKeysNamespace} are kept (tenant data directories are never removed). ` +
    `To remove the namespaces, run: kubectl delete namespace ${n.namespace} ${n.runtimeNamespace} ${n.apiKeysNamespace}. ` +
    `To have the platform remove them next time, set deletionPolicy: Delete on the tenants entry, ` +
    `run up, then remove the entry and run up again.`
  );
}

/**
 * Messages for live Tenants that have no `tenants` entry and whose live policy is Retain (an
 * absent field counts as Retain). The policy comes from the cluster object, as the controller
 * reads it when the Tenant is deleted.
 */
export function removalWarnings(live: LiveTenant[], declared: string[]): string[] {
  const keep = new Set(declared);
  return live
    .filter((t) => !keep.has(t.metadata.name) && (t.spec?.deletionPolicy ?? 'Retain') === 'Retain')
    .map((t) => retainedNamespacesMessage(t.metadata.name));
}

/** Lists Tenants with exactly the kubeconfig (and context) the program's provider uses. */
export function tenantListerFromKubeconfig(kubeconfig: string, context?: string): TenantLister {
  const kc = new KubeConfig();
  kc.loadFromString(kubeconfig);
  if (context) kc.setCurrentContext(context);
  const api = kc.makeApiClient(CustomObjectsApi);
  return async (installation) => {
    const list = (await api.listClusterCustomObject({
      group: GROUP,
      version: 'v1alpha1',
      plural: 'tenants',
      labelSelector: `${INSTALLATION}=${installation}`,
    })) as { items?: LiveTenant[] };
    return list.items ?? [];
  };
}

/**
 * Warns for each live Tenant that has no `tenants` entry and will be removed with Retain. A
 * cluster that cannot be read yet (first install, CRD not present) has nothing to remove, so a
 * read failure is logged at debug level and never fails the update.
 *
 * `list` returns the installation's Tenants and takes no arguments: the caller passes the run's
 * shared Tenant snapshot (#245), which is already scoped to one installation.
 */
export async function warnRemovedTenants(args: {
  declared: string[];
  list: () => Promise<LiveTenant[]>;
  warn: (message: string) => void;
  debug?: (message: string) => void;
}): Promise<string[]> {
  let live: LiveTenant[];
  try {
    live = await args.list();
  } catch (error) {
    args.debug?.(`Skipping tenant removal check: ${(error as Error).message}`);
    return [];
  }
  const messages = removalWarnings(live, args.declared);
  for (const message of messages) args.warn(message);
  return messages;
}
