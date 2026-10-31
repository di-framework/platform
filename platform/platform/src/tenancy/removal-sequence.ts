/**
 * The Tenant removal sequence R1-R7 (design-541 §4.5, "Removal sequence"): the step IDs, the
 * per-step deadline and the `RemovalStuck` condition, and the two guards that keep the tenant's
 * own runtime-operator running and bound until R5 (the R2 sweep exclusion and the `revoke` keep
 * rule, review suggestion S1).
 *
 * #541 m5; m6e-D adds the R1 and R4 checks on the written accounts file and the R3 `Retain`
 * finalizer removal.
 */
import { COMPONENT, type Condition, GROUP, type Resource } from './resources';
import {
  operatorNamespace,
  TENANT_OPERATOR_CLUSTER_ROLES,
  TENANT_OPERATOR_COMPONENT,
  TENANT_OPERATOR_NAME,
} from './tenant-operator-names';

export const REMOVAL_STEPS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] as const;
export type RemovalStep = (typeof REMOVAL_STEPS)[number];

/** How long one step may stay incomplete before the Tenant reports `RemovalStuck`. */
export const REMOVAL_STEP_DEADLINE_MS = 15 * 60 * 1000;
/** The Tenant annotation holding the step removal waits on and when it started: `<step>@<ISO time>`. */
export const REMOVAL_STEP_ANNOTATION = `${GROUP}/removal-step`;
export const REMOVAL_STUCK = 'RemovalStuck';

/**
 * Where removal stands on `step`, given the Tenant's current annotation. A different (or no)
 * recorded step, or a start in the future, starts the step's clock now; the same step keeps its
 * start. `stuck` once the
 * deadline has passed.
 */
export function removalProgress(
  annotation: string | undefined,
  step: RemovalStep,
  now: Date,
): { annotation: string; since: Date; stuck: boolean } {
  const [recorded, at] = (annotation ?? '').split('@');
  const parsed = at ? new Date(at) : undefined;
  const since =
    recorded === step && parsed && !Number.isNaN(parsed.getTime()) && parsed <= now
      ? parsed
      : new Date(now);
  return {
    annotation: `${step}@${since.toISOString()}`,
    since,
    stuck: now.getTime() - since.getTime() >= REMOVAL_STEP_DEADLINE_MS,
  };
}

/** The objects a step still waits for, sorted, at most five named and then a count. */
export function remainingSummary(remaining: string[]): string {
  const sorted = [...remaining].sort((a, b) => a.localeCompare(b));
  const shown = sorted.slice(0, 5);
  if (sorted.length > shown.length) shown.push(`and ${sorted.length - shown.length} more`);
  return shown.join(', ');
}

/** The `RemovalStuck` condition: `reason` is the step ID, the message names what remains. */
export function removalStuckCondition(
  step: RemovalStep,
  remaining: string[],
  since: Date,
  generation: number,
): Condition {
  return {
    type: REMOVAL_STUCK,
    status: 'True',
    reason: step,
    message: `Removal step ${step} has not completed since ${since.toISOString()}; remaining: ${remainingSummary(remaining)}`,
    observedGeneration: generation,
    lastTransitionTime: new Date(since.getTime() + REMOVAL_STEP_DEADLINE_MS).toISOString(),
  };
}

const OPERATOR_ROLES = new Set<string>(Object.values(TENANT_OPERATOR_CLUSTER_ROLES));

/** Whether `binding` grants one of the three tenant-operator ClusterRoles (by its `roleRef`). */
export function bindsTenantOperatorRole(binding: Resource): boolean {
  const roleRef = binding.roleRef as
    | { apiGroup?: string; kind?: string; name?: string }
    | undefined;
  return (
    roleRef?.apiGroup === 'rbac.authorization.k8s.io' &&
    roleRef.kind === 'ClusterRole' &&
    OPERATOR_ROLES.has(roleRef.name ?? '')
  );
}

/**
 * S1: the bindings `revoke` keeps before R5. Only a RoleBinding whose `roleRef` names a
 * tenant-operator ClusterRole **and** whose every subject is the tenant's own operator
 * ServiceAccount; either half alone is revoked as usual.
 */
export function isTenantOperatorBinding(binding: Resource, tenant: string): boolean {
  const subjects = binding.subjects as
    | { kind?: string; name?: string; namespace?: string }[]
    | undefined;
  return (
    binding.kind === 'RoleBinding' &&
    bindsTenantOperatorRole(binding) &&
    !!subjects?.length &&
    subjects.every(
      (s) =>
        s.kind === 'ServiceAccount' &&
        s.name === TENANT_OPERATOR_NAME &&
        s.namespace === operatorNamespace(tenant),
    )
  );
}

/**
 * Whether the R2 sweep scales `deployment` to zero. The tenant operator is skipped by its
 * namespace `di-operator-<t>` and, as a second guard, by its component label.
 */
export function sweepsDeployment(deployment: Resource, tenant: string): boolean {
  return (
    deployment.metadata.namespace !== operatorNamespace(tenant) &&
    deployment.metadata.labels?.[COMPONENT] !== TENANT_OPERATOR_COMPONENT
  );
}

/**
 * The finalizers the runtime-operator (v2.8.0) sets on Workloads and Artifacts
 * (`workload_controller.go`, `artifact_controller.go`). Under `Retain`, R3 removes these and only
 * these once the tenant operator is gone.
 */
export const OPERATOR_FINALIZERS: readonly string[] = [
  'runtime.wasmcloud.dev/workload-finalizer',
  'runtime.wasmcloud.dev/artifact-finalizer',
];

/** Splits `finalizers` into the ones R3 keeps and whether it removes any operator finalizer. */
export function withoutOperatorFinalizers(finalizers: string[]): {
  kept: string[];
  removes: boolean;
} {
  const kept = finalizers.filter((f) => !OPERATOR_FINALIZERS.includes(f));
  return { kept, removes: kept.length !== finalizers.length };
}
