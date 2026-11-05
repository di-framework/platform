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
 * - **Routine renewal**: the certificate has at most {@link SCHEDULER_LEAF_RENEW_DAYS} days left
 *   and expires before its CA does. A new current ID, the old one kept as `previous` since
 *   `previousSince` (now) until `previousUntil` (now + {@link RENEWAL_OVERLAP_MS}). A leaf capped
 *   at its CA's expiry is not renewed (a renewal would be capped the same way, so every tick would
 *   re-issue it, #612); the transition reports `caExpiring` instead. A rotation of the scheduler CAs (#629) replaces such a
 *   CA well before then.
 * - **CA rotation** (#629): a certificate signed by a CA that no longer signs, or whose Secret's
 *   trust bundle lacks a CA of the current set, is `stale`. It is renewed as above whatever its
 *   expiry, capped or not, so each published successor reaches every client's bundle and each
 *   switch re-signs every leaf against the new CA, once. Only once a renewal in progress is
 *   complete, though: while the entry still has `previous` (a host rollout not yet observed, an
 *   operator within `previousUntil`) the stale leaf is kept and renewed on a later pass, unless
 *   the host group has no Deployment, so no pod presents either user.
 * - **Pending issuance**: the Secret's certificate carries another ID than the recorded `current`
 *   (the record was written but issuance did not land). The certificate is re-issued for the
 *   recorded `current`; no new ID is drawn and `previous` stays, with `previousUntil` moved to now
 *   + {@link RENEWAL_OVERLAP_MS}, so the ID the live certificate carries never leaves the record
 *   and the overlap counts from the issuance that lands. `previousSince` never moves: it is how
 *   long the renewal has been pending, which bounds how long it holds a scheduler CA switch
 *   (`renewalHold` in `scheduler-identities.ts`, #642). An entry that keeps `previous` without it
 *   (recorded before #642) gets it from its `previousUntil` less the overlap, the issuance time
 *   already in the record, in the next pass that keeps the entry.
 * - **Operators** drop `previous` at `previousUntil`, once the Secret carries `current`.
 * - **Hosts** drop `previous` only once the rollout of the current certificate is observed
 *   ({@link SCHEDULER_TLS_ANNOTATION} on the pod template, all replicas updated and ready). Past
 *   `previousUntil` without that, both users stay and {@link RENEWAL_STALLED} is reported, also
 *   when no rollout was observed at all (it then names the expected Deployment, which a host
 *   observation must always carry).
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
/** The chart's platform host group, which presents `platform/host` and `platform/data`. */
export const PLATFORM_HOST_DEPLOYMENT = 'hostgroup-default';
/** The pod-template annotation carrying the digest of the `platform/data` certificate. */
export const SCHEDULER_DATA_TLS_ANNOTATION = 'platform.di-framework.dev/scheduler-data-tls-sha256';

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

interface ObservationBase {
  /**
   * The identity's Secret; undefined when it is missing. `id` is the issuance ID its certificate
   * carries ({@link issuanceIdOf} of the leaf's DNS SAN), undefined when it carries none.
   */
  secret?: {
    notAfter: Date;
    digest: string;
    id?: string;
    /** The certificate expires when its CA does (a leaf never outlives its CA), #612. */
    capped?: boolean;
    /**
     * The certificate was signed by a CA that no longer signs, or its Secret's trust bundle lacks
     * a CA of the current set (#629): it is renewed even when capped.
     */
    stale?: boolean;
  };
  /** A forced rotation was requested (see {@link rotationRequested}). */
  forced?: boolean;
}

/** What was observed of an operator identity. */
export interface OperatorObservation extends ObservationBase {
  client: 'operator';
}

/** What was observed of a host identity. */
export interface HostObservation extends ObservationBase {
  client: 'host';
  /**
   * The Deployment expected to present the identity (`hostgroup-tenant-<t>`, or
   * `hostgroup-default` for platform hosts), named in a stall when no rollout is seen. Required,
   * so a stalled renewal can never stay silent for lack of a name.
   */
  deployment: string;
  /** The Deployment that presents the identity, and its observed rollout. */
  rollout?: {
    deployment: string;
    /** The {@link SCHEDULER_TLS_ANNOTATION} value of its pod template. */
    digest?: string;
    /** `observedGeneration` is current and all replicas are updated and ready. */
    complete: boolean;
  };
}

/** What was observed of one identity. */
export type IdentityObservation = OperatorObservation | HostObservation;

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
  /**
   * Set when the certificate is due for renewal but already expires with its CA, so it is kept:
   * the CA is approaching its expiry and must be replaced (#612).
   */
  caExpiring?: true;
}

const drop = ({ current }: IdentityEntry): IdentityEntry => ({ current });
/**
 * `entry` with `previousSince` beside its `previous` when it lacks it: the issuance time its
 * `previousUntil` was set from (or `now`, when that is unreadable), so a renewal recorded before
 * #642 is bounded from a fixed time too, rather than from each pass that moves `previousUntil`.
 */
function sinceRecorded(entry: IdentityEntry, now: Date): IdentityEntry {
  if (entry.previous === undefined || entry.previousSince !== undefined) return entry;
  const issued = Date.parse(entry.previousUntil ?? '') - RENEWAL_OVERLAP_MS;
  const since = Number.isNaN(issued) ? now.getTime() : issued;
  return { ...entry, previousSince: new Date(since).toISOString() };
}

/** A `keep` transition of `entry`, with only the optional fields that are set. */
function kept(
  entry: IdentityEntry,
  extra: Pick<IdentityTransition, 'annotate' | 'stalled'> & { caExpiring: boolean },
): IdentityTransition {
  const { annotate, stalled, caExpiring } = extra;
  return {
    entry,
    action: 'keep',
    reason: 'current',
    ...(annotate ? { annotate } : {}),
    ...(stalled ? { stalled } : {}),
    ...(caExpiring ? { caExpiring: true as const } : {}),
  };
}

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
  const held = sinceRecorded(entry, now);
  if (secret.id !== held.current) {
    // The overlap must count from the issuance that actually lands, so every pending retry moves
    // previousUntil to now + RENEWAL_OVERLAP_MS: the user the live certificate carries stays
    // rendered while issuance fails, and hosts start their stall clock at issuance. Setting it on
    // every pending reconcile (not only when the window runs short) is the only way to guarantee
    // the full 10 minutes after a late issuance; it costs one record write per retry, and each
    // retry issues a certificate anyway. A record without `previous` is returned unchanged.
    const next =
      held.previous === undefined
        ? held
        : { ...held, previousUntil: new Date(now.getTime() + RENEWAL_OVERLAP_MS).toISOString() };
    return { entry: next, action: 'issue', reason: 'pending' };
  }
  const annotate =
    observed.client === 'host' ? { [SCHEDULER_TLS_ANNOTATION]: secret.digest } : undefined;
  const due = secret.notAfter.getTime() <= now.getTime() + SCHEDULER_LEAF_RENEW_DAYS * DAY_MS;
  // A stale leaf waits until a renewal in progress is complete (no `previous`), so the user its
  // running pods present is never dropped (#629); a host group with no Deployment has no such pod.
  const settled = held.previous === undefined || (observed.client === 'host' && !observed.rollout);
  if ((due && !secret.capped) || (secret.stale && settled))
    return {
      entry: {
        current: id(),
        previous: held.current,
        previousSince: now.toISOString(),
        previousUntil: new Date(now.getTime() + RENEWAL_OVERLAP_MS).toISOString(),
      },
      action: 'issue',
      reason: 'renewal',
    };
  const keep = (next: IdentityEntry, stalled?: IdentityTransition['stalled']) =>
    kept(next, { annotate, stalled, caExpiring: due });
  if (held.previous === undefined) return keep(held);
  const until = Date.parse(held.previousUntil ?? '');
  const passed = Number.isNaN(until) || now.getTime() >= until;
  if (observed.client === 'operator') return keep(passed ? drop(held) : held);
  const { rollout } = observed;
  if (rollout?.complete && rollout.digest === secret.digest) return keep(drop(held));
  const deployment = rollout?.deployment ?? observed.deployment;
  if (passed) return keep(held, { type: RENEWAL_STALLED, deployment });
  return keep(held);
}

/** The transitions of several identities, by record key, and the record they produce. */
export interface RecordTransition {
  record: IdentityRecord;
  /** Per key, in code-unit order. */
  transitions: [string, IdentityTransition][];
  /** The stalled renewals, in code-unit order of their keys. */
  stalled: string[];
  /** The keys kept because their certificate expires with its CA, in code-unit order. */
  caExpiring: string[];
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
  const caExpiring: string[] = [];
  for (const key of Object.keys(observed).sort(codeUnitOrder)) {
    const t = identityTransition(record[key], observed[key] as IdentityObservation, now, random);
    next[key] = t.entry;
    transitions.push([key, t]);
    if (t.stalled) stalled.push(key);
    if (t.caExpiring) caExpiring.push(key);
  }
  return { record: next, transitions, stalled, caExpiring };
}
