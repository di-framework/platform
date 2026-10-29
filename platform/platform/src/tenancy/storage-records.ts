import type { StorageClass } from './storage-mode';
import {
  guestMountPath,
  STORAGE_FORMAT_ANNOTATION,
  STORAGE_FORMAT_PGLITE_ENCFS,
  storageKey,
  type WorkloadDeployment,
} from './workload-storage';

/**
 * Per-key storage records of a Tenant (#200, design-200 §9.1 "Records"): `status.storage.keys`,
 * a map from storage key to `{ kind, requested, mode, observed }`. `kind` and `requested` are
 * written once, before a host pod mounts the key; `mode` once, from the first observation that
 * is not `empty`; `observed` after every host pod start.
 */

export type StorageKind = 'PgliteEncfs' | 'Other';
export type StorageIntegrity = 'Off' | 'AEAD';
export type StorageMode = 'XTS' | 'AEAD' | 'NotEncfs';
export type ObservedClass = StorageClass | 'absent';

export interface StorageRecord {
  kind: StorageKind;
  requested?: StorageIntegrity;
  mode?: StorageMode;
  observed?: ObservedClass;
}
export type StorageRecords = Record<string, StorageRecord>;

export const STORAGE_INTEGRITY_MODES: readonly StorageIntegrity[] = ['Off', 'AEAD'];
/** `maxProperties` of `status.storage.keys`. */
export const STORAGE_RECORD_LIMIT = 2048;
export const STORAGE_CLASSES: readonly StorageClass[] = [
  'empty',
  'unencrypted',
  'xts',
  'aead',
  'reserved',
  'other',
];

/** A workload's declared kind: only the exact value `pglite-encfs` declares one. */
export function workloadKind(workload: WorkloadDeployment): StorageKind {
  return workload.metadata.annotations?.[STORAGE_FORMAT_ANNOTATION] === STORAGE_FORMAT_PGLITE_ENCFS
    ? 'PgliteEncfs'
    : 'Other';
}

/**
 * Parse the `storage-mode` listing. Undefined unless it ends with `done count=<n>` and has
 * exactly `n` well-formed lines before it.
 */
export function parseListing(text: string): Map<string, StorageClass> | undefined {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const done = /^done count=(\d+)$/.exec(lines.at(-1) ?? '');
  if (!done || Number(done[1]) !== lines.length - 1) return undefined;
  const listing = new Map<string, StorageClass>();
  for (const line of lines.slice(0, -1)) {
    const [key, found] = line.split(' ');
    if (!key || !(STORAGE_CLASSES as readonly string[]).includes(found ?? '')) return undefined;
    listing.set(key, found as StorageClass);
  }
  return listing;
}

function modeOf(found: ObservedClass): StorageMode | undefined {
  if (found === 'xts') return 'XTS';
  if (found === 'aead' || found === 'reserved') return 'AEAD';
  return found === 'unencrypted' ? 'NotEncfs' : undefined;
}

/** Whether `found` contradicts a recorded `mode` (§9.1 `IntegrityMismatch`). */
function contradicts(record: StorageRecord): boolean {
  const found = record.observed;
  if (found === undefined || found === 'absent') return false;
  if (found === 'other') return true;
  if (record.mode === 'XTS') return found !== 'xts';
  if (record.mode === 'AEAD') return found !== 'aead' && found !== 'reserved';
  if (record.mode === 'NotEncfs') return found !== 'unencrypted' && found !== 'empty';
  return false;
}

export interface StoragePlanInput {
  records: StorageRecords;
  /** The Tenant's storage workloads. */
  workloads: WorkloadDeployment[];
  /** `spec.storage.integrity`. */
  integrity: StorageIntegrity;
  /** The current host pod's listing, when it has been read. */
  listing?: Map<string, StorageClass>;
}

export interface StoragePlan {
  records: StorageRecords;
  /** Keys the host pod mounts: recorded, with at least one workload of the recorded kind. */
  mounted: string[];
  /** Mounted keys that `storage-mode` reserves when their directory is empty. */
  reserve: string[];
  /** `StorageKindConflict` messages. */
  conflicts: string[];
  /** `RecordLimitReached` messages. */
  limited: string[];
}

/** Whether `workload` may get the storage patch for its key under `records`. */
export function storageAllowed(records: StorageRecords, workload: WorkloadDeployment): boolean {
  const key = storageKey(workload);
  return !!key && records[key]?.kind === workloadKind(workload);
}

/** The next records and what the host pod mounts and reserves (design-200 §9.1). */
export function planStorage({
  records: old,
  workloads,
  integrity,
  listing,
}: StoragePlanInput): StoragePlan {
  const byKey = new Map<string, { kinds: Set<StorageKind>; names: string[] }>();
  for (const workload of workloads) {
    const key = storageKey(workload);
    if (!key || !guestMountPath(workload)) continue;
    const entry = byKey.get(key) ?? { kinds: new Set(), names: [] };
    entry.kinds.add(workloadKind(workload));
    entry.names.push(`${workload.metadata.name} (${workloadKind(workload)})`);
    byKey.set(key, entry);
  }
  const records: StorageRecords = {};
  // An entry is removed only once a listing reported its directory gone and no workload uses it.
  for (const [key, record] of Object.entries(old)) {
    if (record.observed === 'absent' && !byKey.has(key)) continue;
    records[key] = { ...record };
  }
  const conflicts: string[] = [];
  const limited: string[] = [];
  const mounted: string[] = [];
  for (const [key, { kinds, names }] of [...byKey].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let record = records[key];
    if (!record) {
      if (kinds.size > 1) {
        conflicts.push(`key ${key} is used by workloads of both kinds: ${names.join(', ')}`);
        continue;
      }
      if (Object.keys(records).length >= STORAGE_RECORD_LIMIT) {
        limited.push(`key ${key} (${names.join(', ')})`);
        continue;
      }
      const kind = [...kinds][0] as StorageKind;
      record = kind === 'PgliteEncfs' ? { kind, requested: integrity } : { kind };
      records[key] = record;
    }
    const kind = record.kind;
    const others = names.filter((name) => !name.endsWith(`(${kind})`));
    if (others.length > 0)
      conflicts.push(`key ${key} is recorded ${kind}; not mounted for ${others.join(', ')}`);
    if (kinds.has(kind)) mounted.push(key);
  }
  if (listing) {
    for (const [key, found] of [...listing].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const record = records[key];
      if (!record) {
        if (found === 'empty') continue;
        if (Object.keys(records).length >= STORAGE_RECORD_LIMIT) {
          limited.push(`directory ${key}`);
          continue;
        }
        const mode = modeOf(found);
        records[key] = {
          kind: found === 'unencrypted' || found === 'other' ? 'Other' : 'PgliteEncfs',
          ...(mode ? { mode } : {}),
          observed: found,
        };
        continue;
      }
      record.observed = found;
      const mode = modeOf(found);
      if (record.mode || !mode) continue;
      if (mode === 'AEAD' && record.kind === 'Other') {
        conflicts.push(`key ${key} is recorded Other but its directory is ${found}`);
        continue;
      }
      record.mode = mode;
    }
    for (const [key, record] of Object.entries(records))
      if (!listing.has(key) && !byKey.has(key)) record.observed = 'absent';
  }
  const reserve = mounted.filter((key) => {
    const record = records[key] as StorageRecord;
    return record.requested ? record.requested === 'AEAD' : record.mode === 'AEAD';
  });
  return { records, mounted, reserve, conflicts, limited };
}

/** The changes from `old` to `next` as a JSON merge patch of `status.storage.keys`. */
export function recordsPatch(
  old: StorageRecords,
  next: StorageRecords,
): Record<string, StorageRecord | null> | undefined {
  const patch: Record<string, StorageRecord | null> = {};
  for (const key of Object.keys(old)) if (!(key in next)) patch[key] = null;
  for (const [key, record] of Object.entries(next))
    if (JSON.stringify(old[key]) !== JSON.stringify(record)) patch[key] = record;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** What `storage-mode` reported for the current host pod. */
export type Observation =
  | { state: 'read'; listing: Map<string, StorageClass> }
  | { state: 'failed'; message: string }
  | { state: 'pending' };

export interface IntegrityCondition {
  status: 'True' | 'False' | 'Unknown';
  reason: string;
  message: string;
}

/**
 * The `StorageIntegrity` condition. The first reason that applies is reported, and its message
 * counts the keys under the others.
 */
export function integrityCondition(
  plan: StoragePlan,
  observation: Observation,
  foreignRecords?: string,
): IntegrityCondition {
  const mismatch = Object.entries(plan.records)
    .filter(([, record]) => contradicts(record))
    .map(
      ([key, record]) =>
        `${key} (recorded ${record.mode ?? 'without a mode'}, observed ${record.observed})`,
    );
  const notApplied = Object.entries(plan.records)
    .filter(([, record]) => record.requested === 'AEAD' && record.mode && record.mode !== 'AEAD')
    .map(([key, record]) => `${key} (${record.mode})`);
  const awaiting =
    observation.state === 'read'
      ? plan.mounted.filter((key) => !observation.listing.has(key))
      : plan.mounted;
  const reasons: [string, 'False' | 'Unknown', string[]][] = [
    ['ObservationFailed', 'False', observation.state === 'failed' ? [observation.message] : []],
    ['StorageKindConflict', 'False', plan.conflicts],
    ['RecordLimitReached', 'False', plan.limited],
    ['IntegrityMismatch', 'False', mismatch],
    ['IntegrityNotApplied', 'False', notApplied],
    ['StorageRecordsForeign', 'False', foreignRecords ? [foreignRecords] : []],
    [
      'AwaitingObservation',
      'Unknown',
      observation.state === 'pending' || awaiting.length > 0
        ? [
            `the host pod's storage listing has not been read${awaiting.length ? ` for ${awaiting.join(', ')}` : ''}`,
          ]
        : [],
    ],
  ];
  const applying = reasons.filter(([, , items]) => items.length > 0);
  const first = applying[0];
  if (!first) {
    return {
      status: 'True',
      reason: 'AsRecorded',
      message: `${Object.keys(plan.records).length} storage keys as recorded`,
    };
  }
  const others = applying
    .slice(1)
    .map(([reason, , items]) => `${reason}: ${items.length}`)
    .join(', ');
  return {
    status: first[1],
    reason: first[0],
    message: `${first[2].join('; ')}${others ? ` (also ${others})` : ''}`,
  };
}
