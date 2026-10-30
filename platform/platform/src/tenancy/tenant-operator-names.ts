/**
 * The names that identify a tenant's runtime-operator (design-541 §4.6). They live apart from the
 * renderer in `tenant-operator.ts` so the controller's removal sequence (§4.5) can use them
 * without loading the renderer.
 */

/** The three fixed ClusterRoles every tenant operator is bound to, one per kind of namespace. */
export const TENANT_OPERATOR_CLUSTER_ROLES = {
  /** Bound in `di-operator-<t>`. */
  self: 'di-tenant-operator-self',
  /** Bound in `di-tenant-<t>`. */
  workloads: 'di-tenant-operator-workloads',
  /** Bound in `di-runtime-<t>`. */
  hosts: 'di-tenant-operator-hosts',
} as const;

/** The operator's Deployment and ServiceAccount name. */
export const TENANT_OPERATOR_NAME = 'runtime-operator';
/** The `COMPONENT` label on the operator Deployment, the R2 sweep's second guard (§4.5). */
export const TENANT_OPERATOR_COMPONENT = 'tenant-operator';

export const operatorNamespace = (tenant: string): string => `di-operator-${tenant}`;
