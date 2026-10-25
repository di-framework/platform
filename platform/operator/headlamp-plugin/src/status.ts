/** Pure helpers that turn a PlatformInstance's status into what the list and detail views show. */

import { CONDITION_TYPES, type Condition, type PlatformInstanceObject } from './types';

export type Severity = 'success' | 'warning' | 'error' | '';

/** The status of the Ready condition, or '' when the operator hasn't reported it yet. */
export function readyStatus(obj: Pick<PlatformInstanceObject, 'status'>): string {
  return obj.status?.conditions?.find((c) => c.type === 'Ready')?.status ?? '';
}

export function phaseOf(obj: Pick<PlatformInstanceObject, 'status'>): string {
  return obj.status?.phase ?? '';
}

export function phaseSeverity(phase: string): Severity {
  switch (phase) {
    case 'Ready':
      return 'success';
    case 'Failed':
      return 'error';
    case 'Pending':
    case 'Provisioning':
    case 'Installing':
    case 'Deleting':
      return 'warning';
    default:
      return '';
  }
}

export function conditionSeverity(status: string): Severity {
  switch (status) {
    case 'True':
      return 'success';
    case 'False':
      return 'error';
    case 'Unknown':
      return 'warning';
    default:
      return '';
  }
}

export interface ConditionRow {
  type: string;
  status: string;
  reason: string;
  message: string;
  lastTransitionTime: string;
  /** True when the condition describes an older generation than the object's current spec. */
  stale: boolean;
}

/**
 * The conditions to show, the operator's own (TargetReady, Installed, Ready) first in reconcile
 * order, then any others by type. Each keeps its reason and message.
 */
export function conditionRows(
  obj: Pick<PlatformInstanceObject, 'status'> & { metadata?: { generation?: unknown } },
): ConditionRow[] {
  const conditions: Condition[] = obj.status?.conditions ?? [];
  const generation =
    typeof obj.metadata?.generation === 'number' ? obj.metadata.generation : undefined;
  const order = (type: string) => {
    const i = (CONDITION_TYPES as readonly string[]).indexOf(type);
    return i === -1 ? CONDITION_TYPES.length : i;
  };
  return [...conditions]
    .sort((a, b) => order(a.type) - order(b.type) || a.type.localeCompare(b.type))
    .map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason ?? '',
      message: c.message ?? '',
      lastTransitionTime: c.lastTransitionTime ?? '',
      stale:
        generation !== undefined &&
        c.observedGeneration !== undefined &&
        c.observedGeneration < generation,
    }));
}
