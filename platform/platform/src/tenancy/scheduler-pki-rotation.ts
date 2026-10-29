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
 * - **Operators** drop `previous` at `previousUntil`.
 * - **Hosts** drop `previous` only once the rollout of the current certificate is observed
 *   ({@link SCHEDULER_TLS_ANNOTATION} on the pod template, all replicas updated and ready). Past
 *   `previousUntil` without that, both users stay and {@link RENEWAL_STALLED} is reported.
 */
import { createHash } from 'node:crypto';
import {
  codeUnitOrder,
  type IdentityEntry,
  type IdentityRecord,
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

/** True when the Tenant's rotation annotation differs from the value last handled. */
export const rotationRequested = (annotation?: string, handled?: string): boolean =>
  (annotation ?? '') !== (handled ?? '');

/** Who presents the identity: an operator reconnects by itself; hosts must be rolled. */
export type IdentityClient = 'operator' | 'host';

/** What was observed of one identity. */
export interface IdentityObservation {
  client: IdentityClient;
  /** The identity's Secret; undefined when it is missing. */
  secret?: { notAfter: Date; digest: string };
  /** A forced rotation was requested (see {@link rotationRequested}). */
  forced?: boolean;
  /** Hosts only: the Deployment that presents the identity, and its observed rollout. */
  rollout?: {
    deployment: string;
    /** The {@link SCHEDULER_TLS_ANNOTATION} value of its pod template. */
    digest?: string;
    /** `observedGeneration` is current and all replicas are updated and ready. */
    complete: boolean;
  };
}

export type IdentityReason = 'new' | 'forced' | 'missing' | 'renewal' | 'current';

/** The outcome of one identity's transition. */
export interface IdentityTransition {
  entry: IdentityEntry;
  /** `issue` a certificate for `entry.current` (after the record is written), or `keep` it. */
  action: 'issue' | 'keep';
  reason: IdentityReason;
  /** Hosts only: the pod-template annotation to set, when the Secret holds a certificate. */
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
  if (observed.client === 'operator') return keep(now.getTime() >= until ? drop(entry) : entry);
  const rollout = observed.rollout;
  if (rollout?.complete && rollout.digest === secret.digest) return keep(drop(entry));
  if (now.getTime() >= until && rollout)
    return keep(entry, { type: RENEWAL_STALLED, deployment: rollout.deployment });
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
