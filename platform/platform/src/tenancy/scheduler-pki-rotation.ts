/**
 * Issuance, forced rotation and routine renewal of scheduler NATS identities (#541 m4,
 * design-541 §4.5), as pure transitions of one identity-record entry.
 *
 * Each transition takes plain data (the current entry, what was observed of its Secret and, for
 * hosts, of the Deployment rollout, and the time) and returns the next entry, the action to take
 * and the condition to report. The caller writes the returned record before it issues any
 * certificate, so a user name always names exactly one certificate. Nothing here reads or writes
 * the cluster, and nothing here sees key material: a Secret is observed only by its certificate's
 * expiry and digest.
 *
 * - **Forced rotation**: the Tenant annotation {@link ROTATE_ANNOTATION} changed, or the
 *   identity's Secret is missing. A new current ID, no previous, so the old user is revoked in the
 *   next reload.
 * - **Routine renewal**: the certificate has at most {@link SCHEDULER_LEAF_RENEW_DAYS} days left.
 *   A new current ID, the old one kept as `previous` until `previousUntil` (now +
 *   {@link RENEWAL_OVERLAP_MS}).
 * - **Pending issuance**: the Secret's certificate carries another ID than the recorded `current`
 *   (the record was written but issuance did not land). The certificate is re-issued for the
 *   recorded `current`; no new ID is drawn and `previous` stays, so the ID the live certificate
 *   carries never leaves the record.
 * - **Operators** drop `previous` at `previousUntil`, once the Secret carries `current`.
 * - **Hosts** drop `previous` only once the rollout of the current certificate is observed
 *   ({@link SCHEDULER_TLS_ANNOTATION} on the pod template, all replicas updated and ready). Past
 *   `previousUntil` without that, both users stay and {@link RENEWAL_STALLED} is reported, also
 *   when no rollout was observed at all (it then names the expected Deployment).
 *
 * A missing or unparseable `previousUntil` counts as passed, so such an entry still converges.
 */
import { createHash } from 'node:crypto';
import {
  codeUnitOrder,
  type IdentityEntry,
  type IdentityRecord,
  ISSUANCE_ID,
  newIssuanceId,
  SCHEDULER_LEAF_RENEW_DAYS,
} from './scheduler-pki';

/** Changing this Tenant annotation force-rotates both of the tenant's scheduler identities. */
export const ROTATE_ANNOTATION = 'platform.di-framework.dev/rotate-scheduler-identity';
/** The host pod-template annotation carrying the digest of the scheduler certificate it mounts. */
export const SCHEDULER_TLS_ANNOTATION = 'platform.di-framework.dev/scheduler-tls-sha256';
/** The condition set while a host renewal's rollout has not been observed in time. */
export const RENEWAL_STALLED = 'SchedulerIdentityRenewalStalled';
/** How long a routine renewal keeps the previous user: 10 minutes. */
export const RENEWAL_OVERLAP_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** The digest {@link SCHEDULER_TLS_ANNOTATION} carries: sha256 of the certificate PEM, hex. */
export const schedulerCertDigest = (cert: string): string =>
  createHash('sha256').update(cert).digest('hex');

/**
 * True when the Tenant's rotation annotation differs from the value last handled; removing the
 * annotation counts as a change. The handled value is stored by the m6 wiring in Tenant status,
 * written after the record and before issuance, so an interrupted forced rotation repeats at most
 * once.
 */
export const rotationRequested = (annotation?: string, handled?: string): boolean =>
  (annotation ?? '') !== (handled ?? '');

/** The issuance ID a leaf's DNS SAN (its NATS user) carries. */
export const issuanceIdOf = (user: string): string | undefined => {
  const id = user.split('.', 1)[0] as string;
  return ISSUANCE_ID.test(id) ? id : undefined;
};

/** Who presents the identity: an operator reconnects by itself; hosts must be rolled. */
export type IdentityClient = 'operator' | 'host';

/** What was observed of one identity. */
export interface IdentityObservation {
  client: IdentityClient;
  /**
   * The identity's Secret; undefined when it is missing. `id` is the issuance ID its certificate
   * carries ({@link issuanceIdOf} of the leaf's DNS SAN).
   */
  secret?: { notAfter: Date; digest: string; id: string };
  /** A forced rotation was requested (see {@link rotationRequested}). */
  forced?: boolean;
  /** Hosts only: the Deployment expected to present the identity, named when no rollout is seen. */
  deployment?: string;
  /** Hosts only: the Deployment that presents the identity, and its observed rollout. */
  rollout?: {
    deployment: string;
    /** The {@link SCHEDULER_TLS_ANNOTATION} value of its pod template. */
    digest?: string;
    /** `observedGeneration` is current and all replicas are updated and ready. */
    complete: boolean;
  };
}

export type IdentityReason = 'new' | 'forced' | 'missing' | 'pending' | 'renewal' | 'current';

/** The outcome of one identity's transition. */
export interface IdentityTransition {
  entry: IdentityEntry;
  /** `issue` a certificate for `entry.current` (after the record is written), or `keep` it. */
  action: 'issue' | 'keep';
  reason: IdentityReason;
  /**
   * Hosts only: the pod-template annotation to set, when the Secret holds the certificate of
   * `entry.current`. Absent on `issue`: the new certificate's digest is not known before issuance,
   * so the caller sets {@link schedulerCertDigest} of the issued certificate in the same reconcile.
   */
  annotate?: { [SCHEDULER_TLS_ANNOTATION]: string };
  /** Set when a host renewal has stalled; names the Deployment. */
  stalled?: { type: typeof RENEWAL_STALLED; deployment: string };
}

const drop = ({ current }: IdentityEntry): IdentityEntry => ({ current });

/** The next state of one identity entry. `random` supplies new issuance IDs. */
export function identityTransition(
  entry: IdentityEntry | undefined,
  observed: IdentityObservation,
  now: Date,
  random?: (size: number) => Buffer,
): IdentityTransition {
  const id = () => newIssuanceId(random);
  if (!entry) return { entry: { current: id() }, action: 'issue', reason: 'new' };
  if (observed.forced) return { entry: { current: id() }, action: 'issue', reason: 'forced' };
  const { secret } = observed;
  if (!secret) return { entry: { current: id() }, action: 'issue', reason: 'missing' };
  if (secret.id !== entry.current) return { entry, action: 'issue', reason: 'pending' };
  const annotate =
    observed.client === 'host' ? { [SCHEDULER_TLS_ANNOTATION]: secret.digest } : undefined;
  if (secret.notAfter.getTime() <= now.getTime() + SCHEDULER_LEAF_RENEW_DAYS * DAY_MS)
    return {
      entry: {
        current: id(),
        previous: entry.current,
        previousUntil: new Date(now.getTime() + RENEWAL_OVERLAP_MS).toISOString(),
      },
      action: 'issue',
      reason: 'renewal',
    };
  const keep = (next: IdentityEntry, stalled?: IdentityTransition['stalled']) => ({
    entry: next,
    action: 'keep' as const,
    reason: 'current' as const,
    ...(annotate ? { annotate } : {}),
    ...(stalled ? { stalled } : {}),
  });
  if (entry.previous === undefined) return keep(entry);
  const until = Date.parse(entry.previousUntil ?? '');
  const passed = Number.isNaN(until) || now.getTime() >= until;
  if (observed.client === 'operator') return keep(passed ? drop(entry) : entry);
  const { rollout } = observed;
  if (rollout?.complete && rollout.digest === secret.digest) return keep(drop(entry));
  const deployment = rollout?.deployment ?? observed.deployment;
  if (passed && deployment) return keep(entry, { type: RENEWAL_STALLED, deployment });
  return keep(entry);
}

/** The transitions of several identities, by record key, and the record they produce. */
export interface RecordTransition {
  record: IdentityRecord;
  /** Per key, in code-unit order. */
  transitions: [string, IdentityTransition][];
  /** The stalled renewals, in code-unit order of their keys. */
  stalled: string[];
}

/**
 * Applies {@link identityTransition} to every key of `observed`; entries of `record` not observed
 * are kept unchanged. Keys are visited in code-unit order, so the result (and the IDs drawn from
 * `random`) does not depend on insertion order.
 */
export function recordTransition(
  record: IdentityRecord,
  observed: Record<string, IdentityObservation>,
  now: Date,
  random?: (size: number) => Buffer,
): RecordTransition {
  const next: IdentityRecord = { ...record };
  const transitions: [string, IdentityTransition][] = [];
  const stalled: string[] = [];
  for (const key of Object.keys(observed).sort(codeUnitOrder)) {
    const t = identityTransition(record[key], observed[key] as IdentityObservation, now, random);
    next[key] = t.entry;
    transitions.push([key, t]);
    if (t.stalled) stalled.push(key);
  }
  return { record: next, transitions, stalled };
}
