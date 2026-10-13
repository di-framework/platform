import type { TenantLister } from './tenancy/removal';
import { names } from './tenancy/resources';
import { describeReadError } from './token-wait';

export interface HostNamespacesArgs {
  /** The platform namespace; always watched, first. */
  platformNamespace: string;
  /** The installation whose Tenants are listed. */
  installation: string;
  /** Tenant names in the stack config. */
  declared: string[];
  /** `pulumi.runtime.isDryRun()`: a preview never reads the cluster. */
  dryRun: boolean;
  /** `tenancy/removal`'s lister on the admin kubeconfig; absent without one. */
  listTenants?: TenantLister;
  log: { info(message: string): void; warn(message: string): void };
}

/**
 * The wasmCloud operator's `hostNamespaces` (#227): the platform namespace plus the runtime
 * namespace of every tenant that is declared or whose Tenant object still exists in the cluster.
 *
 * Pulumi applies the Helm update before it deletes a Tenant that left the config, so the update
 * must not stop the operator watching that tenant's runtime namespace: the operator removes its
 * host pods' finalizers there while the controller drains the tenant. The Tenant object exists
 * only until that drain is done, under both deletion policies (`Delete` removes the namespaces
 * first; `Retain` scales the hosts to zero and keeps the namespaces), so the next `up` stops
 * watching the namespace. A retained namespace is never watched on its own account.
 */
export async function operatorHostNamespaces(args: HostNamespacesArgs): Promise<string[]> {
  const runtime = (tenant: string) => names(tenant).runtimeNamespace;
  const declaredNamespaces = [args.platformNamespace, ...args.declared.map(runtime)];
  if (args.dryRun) {
    args.log.info(
      "Preview lists the wasmCloud operator's hostNamespaces for the declared tenants only. On up, a removed tenant's runtime namespace stays watched while its Tenant is deleted, and stops being watched on the next up, after the Tenant is gone (#227).",
    );
    return declaredNamespaces;
  }
  if (!args.listTenants) {
    args.log.warn(
      "Without the admin kubeconfig, the wasmCloud operator's hostNamespaces list the declared tenants only, so removing a tenant can strand its host pods' finalizers (#227). Pass kubeconfig to createPlatform.",
    );
    return declaredNamespaces;
  }
  let live: string[];
  try {
    live = (await args.listTenants(args.installation)).map((t) => t.metadata.name);
  } catch (error) {
    // No Tenant CRD yet (a first install): no Tenants. Anything else fails the update rather
    // than shrinking the list; the message never carries a response body or the kubeconfig.
    if ((error as { code?: unknown } | null)?.code !== 404)
      throw new Error(
        `Cannot list the Tenants of installation ${args.installation}, which keep a removed tenant's runtime namespace watched by the wasmCloud operator until the Tenant is deleted (#227): ${describeReadError(error)}`,
      );
    live = [];
  }
  const declared = new Set(args.declared);
  const draining = [...new Set(live)]
    .filter((t) => !declared.has(t))
    .sort((a, b) => a.localeCompare(b));
  for (const tenant of draining)
    args.log.info(
      `Tenant ${tenant} is no longer declared but still exists, so ${runtime(tenant)} stays in the wasmCloud operator's hostNamespaces while the Tenant is deleted; it stops being watched on the next up, after the Tenant is gone (#227).`,
    );
  return [...declaredNamespaces, ...draining.map(runtime)];
}
