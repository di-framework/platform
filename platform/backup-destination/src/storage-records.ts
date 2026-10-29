/**
 * The platform's per-key storage records (#553, design-200 §9.4 "Restore" step 1).
 *
 * The platform controller keeps a copy of the Tenant's `status.storage.keys` in the runtime
 * namespace, as the ConfigMap `di-storage-records`, with its installation and owner labels. Its
 * `keys` entry is that map as JSON: `{ "<storage key>": { kind, requested?, mode?, ... } }`.
 * Everything about that shape is read here, so a change to it stays in this file.
 */

import { OWNER_UID_LABEL } from './model.ts';

/** The ConfigMap the platform controller writes in `di-runtime-<tenant>`. */
export const STORAGE_RECORDS = 'di-storage-records';
export const INSTALLATION_LABEL = 'platform.di-framework.dev/installation';

export const ENCFS_MODES = ['XTS', 'AEAD', 'NotEncfs'] as const;
export type EncfsMode = (typeof ENCFS_MODES)[number];

/** One key's record: what the restore check reads of a `status.storage.keys` entry. */
export interface StorageRecord {
  kind: 'PgliteEncfs' | 'Other';
  requested?: 'Off' | 'AEAD';
  mode?: EncfsMode;
}

export type StorageRecords =
  /** No ConfigMap: a controller older than the records. The record check is skipped. */
  | { state: 'absent' }
  /** A ConfigMap the controller did not write, or whose content it would not write. */
  | { state: 'untrusted' | 'invalid'; message: string }
  | { state: 'present'; keys: Record<string, StorageRecord> };

interface ConfigMapLike {
  metadata?: { labels?: Record<string, string> };
  data?: Record<string, string>;
}

function recordOf(value: unknown): StorageRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { kind, requested, mode } = value as Record<string, unknown>;
  if (kind !== 'PgliteEncfs' && kind !== 'Other') return undefined;
  if (requested !== undefined && requested !== 'Off' && requested !== 'AEAD') return undefined;
  if (mode !== undefined && !ENCFS_MODES.includes(mode as EncfsMode)) return undefined;
  // `requested` is only ever written on a PgliteEncfs entry, and an Other key never takes AEAD.
  if (kind === 'Other' && (requested !== undefined || mode === 'AEAD')) return undefined;
  // A PgliteEncfs entry has `requested` (write-ahead) or `mode` (backfill), never neither.
  if (kind === 'PgliteEncfs' && requested === undefined && mode === undefined) return undefined;
  return {
    kind,
    ...(requested ? { requested: requested as 'Off' | 'AEAD' } : {}),
    ...(mode ? { mode: mode as EncfsMode } : {}),
  };
}

/**
 * Read the ConfigMap as `get` returned it (undefined on 404). `expected` holds the labels the
 * controller puts on objects it writes for this Tenant, taken from the tenant host Deployment.
 * Anything malformed fails closed.
 */
export function storageRecordsOf(
  item: unknown,
  expected: { installation?: string; ownerUid?: string },
): StorageRecords {
  if (item === undefined) return { state: 'absent' };
  const map = item as ConfigMapLike;
  const labels = map.metadata?.labels ?? {};
  const object = `ConfigMap ${STORAGE_RECORDS}`;
  if (
    !expected.installation ||
    !expected.ownerUid ||
    labels[INSTALLATION_LABEL] !== expected.installation ||
    labels[OWNER_UID_LABEL] !== expected.ownerUid
  ) {
    return {
      state: 'untrusted',
      message: `${object} does not carry the platform controller's installation and owner labels`,
    };
  }
  const invalid = (why: string): StorageRecords => ({
    state: 'invalid',
    message: `${object} is malformed: ${why}`,
  });
  const text = map.data?.keys;
  if (typeof text !== 'string') return invalid('no keys entry');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('keys is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('keys is not an object');
  }
  // No prototype: tenants choose key names, so `constructor` or `__proto__` must stay plain keys.
  const keys: Record<string, StorageRecord> = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    const record = recordOf(value);
    if (!record) return invalid(`entry ${JSON.stringify(key)} is not a storage record`);
    keys[key] = record;
  }
  return { state: 'present', keys };
}

/** A key's own record, never something inherited from Object.prototype. */
export function recordFor(
  records: Record<string, StorageRecord>,
  key: string,
): StorageRecord | undefined {
  return Object.hasOwn(records, key) ? records[key] : undefined;
}

/** The backup modes a key's record accepts (design-200 §9.4, the restore table). */
export function acceptedModes(record: StorageRecord): EncfsMode[] {
  if (record.mode) return [record.mode];
  if (record.kind === 'Other') return ['XTS', 'NotEncfs'];
  return record.requested === 'AEAD' ? ['AEAD'] : ['XTS', 'AEAD'];
}
