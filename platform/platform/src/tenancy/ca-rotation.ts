import { X509Certificate } from 'node:crypto';
import {
  type CaConstraints,
  type CertNames,
  caCertificate,
  caConstraints,
  certificateValid,
  holdsCaKey,
  type KeyPair,
  namesPermittedBy,
} from './tls';

/** Lifetime of a tenant controller CA (days). */
export const CA_DAYS = 3650;
/** A successor CA is published this many days before the signing CA expires. */
export const CA_RENEW_DAYS = 90;
/** How long a published successor is trusted before it starts signing the leaf (days). */
export const CA_OVERLAP_DAYS = 30;
/** The serving leaf is renewed this many days before it expires. */
export const LEAF_RENEW_DAYS = 30;
/**
 * A renamed successor (#365) is switched to only while the old CA then stays in the bundle at
 * least this many days, so the controller and hosts roll before it is retired.
 */
export const MIN_POST_SWITCH_DAYS = CA_OVERLAP_DAYS / 2;
/**
 * A gated CA set ({@link CaSource.gate}) switches to a published successor this many days before
 * its signing CA expires even while a holder still lacks the successor: the last resort, so a CA
 * that expires never blocks the switch. Two days leave the controller a day of passes to re-sign
 * every leaf against the successor before the old CA is gone.
 */
export const CA_SWITCH_DEADLINE_DAYS = 2;

/**
 * The tenant controller's certificate authorities. Only `current` signs the serving leaf; the
 * trust bundle (ConfigMap `tenant-controller-ca`, oldest first) holds every CA here, so clients
 * that reload it accept a leaf from either side of a rotation.
 */
export interface ControllerCas {
  /** The CA that signs the serving leaf. */
  current: KeyPair;
  /** The successor, trusted but not signing yet. */
  next?: KeyPair;
  /** The CA `current` replaced, trusted until it expires (no key: it never signs again). */
  previous?: string;
}

/**
 * What a new tenant controller CA is: its subject, the only DNS names it permits (#365) and
 * whether it permits IP addresses (#381).
 */
export interface CaProfile {
  commonName: string;
  /** The DNS names the serving leaf needs; the CA's name constraints permit exactly these. */
  dnsNames: string[];
  /**
   * The IP addresses the serving leaf needs (an IP-literal public URL). None or absent, the CA
   * excludes every IP address; otherwise IP addresses are left unconstrained, since BoringSSL
   * rejects a leaf that names one under any IP constraint (#381).
   */
  ipAddresses?: string[];
}

/** What is stored, each part possibly missing or unreadable. */
export interface StoredCas {
  current?: Partial<KeyPair>;
  next?: Partial<KeyPair>;
  previous?: string;
}

const DAY_MS = 86_400_000;
/** The CA in `stored` when it is a CA certificate that has not expired and `key` is its key. */
const usable = (stored: Partial<KeyPair> | undefined, now: Date): KeyPair | undefined =>
  stored?.cert &&
  stored.key &&
  holdsCaKey(stored.cert, stored.key) &&
  certificateValid(stored.cert, 0, now)
    ? { cert: stored.cert, key: stored.key }
    : undefined;
/** Days since `cert` was issued. */
const ageDays = (cert: string, now: Date) =>
  (now.getTime() - new Date(new X509Certificate(cert).validFrom).getTime()) / DAY_MS;
/**
 * Name constraints as one string: the DNS names whatever their order or case, and whether every
 * IP address is excluded; '' for none (an unconstrained CA).
 */
const nameKey = (constraints: CaConstraints | undefined) =>
  constraints
    ? JSON.stringify([
        [...new Set(constraints.dns.map((n) => n.toLowerCase()))].sort((a, b) =>
          a.localeCompare(b),
        ),
        constraints.excludesIps,
      ])
    : '';
/** The name constraints of `ca` as one string ({@link nameKey}). */
const permittedKey = (ca: string) => nameKey(caConstraints(ca));
/** True when a CA for `profile` excludes every IP address (#381). */
const excludesIps = (profile: CaProfile) => !profile.ipAddresses?.length;
/** The name constraints a CA for `profile` carries, as one string ({@link nameKey}). */
const profileKey = (profile: CaProfile) =>
  nameKey({ dns: profile.dnsNames, excludesIps: excludesIps(profile) });
/**
 * True when `current` permits other names than `old` did (#365, #381): `current` succeeded it
 * because the names changed (or whether IP addresses are permitted), or `old` had no name
 * constraints.
 */
const renamed = (old: string, current: string) => permittedKey(old) !== permittedKey(current);
/** True when `cert` is a CA certificate that has not expired (so it parses). */
const trustedCa = (cert: string | undefined, now: Date): cert is string =>
  !!cert && certificateValid(cert, 0, now) && new X509Certificate(cert).ca;
/**
 * Until when `old` stays in the bundle as `previous` beside `current` (ms since the epoch), at
 * most until `old` expires:
 *
 * - `current` succeeded it in a rotation: `current` was created within {@link CA_RENEW_DAYS} of
 *   `old`'s expiry (publish, or an early switch), so `old` is kept until it expires, at most that
 *   long;
 * - `current` succeeded it because the permitted names changed (#365): `current` was published
 *   and switched to after {@link CA_OVERLAP_DAYS}, so `old` is kept until `current` is twice that
 *   old; or
 * - `current` replaced it at once (its key was lost): `old` is kept for {@link CA_OVERLAP_DAYS}
 *   after `current` was created, long enough for the controller to roll off the leaf `old`
 *   signed. A CA replaced that way with years left (its key may have leaked) is never trusted for
 *   longer.
 *
 * All are read from the certificates (`old`'s notAfter, `current`'s notBefore, the name
 * constraints of both), so no extra state is stored and nothing can extend them.
 */
const retainedUntil = (old: string, current: string): number => {
  const created = new Date(new X509Certificate(current).validFrom).getTime();
  const oldEnd = new Date(new X509Certificate(old).validTo).getTime();
  // notBefore is backdated a few minutes for clock skew; a day of slack covers it.
  if (oldEnd <= created + (CA_RENEW_DAYS + 1) * DAY_MS) return oldEnd;
  const days = (renamed(old, current) ? 2 : 1) * CA_OVERLAP_DAYS;
  return Math.min(oldEnd, created + days * DAY_MS);
};
/** Whether `old` is a CA that has not expired and stays `previous` beside `current` at `now`. */
export const keptAsPrevious = (
  old: string | undefined,
  current: string,
  now: Date,
): old is string =>
  old !== current && trustedCa(old, now) && now.getTime() < retainedUntil(old, current);

/**
 * The CAs to keep after one reconcile pass at `now`. A rotation has three steps, each its own
 * change to the trust bundle or the leaf, so no party ever meets a leaf from a CA it does not
 * trust:
 *
 * 1. **Publish.** Within {@link CA_RENEW_DAYS} of the current CA's expiry a successor is created
 *    and added to the bundle; the leaf is unchanged, so the hosts roll onto a bundle that trusts
 *    both while the controller keeps serving the old leaf.
 * 2. **Switch.** Once the successor is {@link CA_OVERLAP_DAYS} old it signs the leaf and the old CA
 *    becomes `previous`. The bundle bytes stay the same (oldest first), so the hosts do not roll;
 *    only the controller and console do, for the new leaf. The switch comes early when the
 *    current CA has less than {@link LEAF_RENEW_DAYS} left, so a leaf capped at its expiry is never
 *    renewed on every pass.
 * 3. **Retire.** `previous` leaves the bundle when it expires. No leaf it signed outlives it, so
 *    nothing still needs it.
 *
 * Every CA this creates permits only the DNS names `profile.dnsNames` (#365) and, unless
 * `profile.ipAddresses` names one, no IP address (#381). A current CA that permits other names,
 * differs in whether it permits IP addresses (a CA from before #381), or has no name constraints
 * (a CA from before #365), goes through the same
 * three steps at once, whatever its age: a successor for the names wanted now is published, and
 * switched to after the overlap. Until then the leaf keeps the names it had, so no host goes dark,
 * plus those wanted that the current CA permits ({@link leafNames}). A published successor for
 * names no longer wanted is dropped (it never signed, so nothing needs it) and a new one
 * published. A renamed successor is switched to only while the old CA would stay in the bundle for
 * at least {@link MIN_POST_SWITCH_DAYS} after the switch; past that (the controller was not
 * running) it is published again, so a controller pod still serving the old leaf keeps verifying.
 *
 * A current CA that is missing, expired or whose key is missing or wrong is replaced at once
 * (by the successor when there is a usable one): nothing can sign with it. Its certificate stays
 * in the bundle as `previous` for at most {@link CA_OVERLAP_DAYS} (twice that when the names it
 * permits differ too, see `retainedUntil`), so the leaf it signed keeps verifying while the
 * controller rolls, but a CA whose key may have leaked is not trusted for the rest of its life.
 * With no CA certificate stored at all there is nothing to keep: that is how a compromised CA is
 * revoked (README, "CA rotation").
 */
export function rotateCas(stored: StoredCas, profile: CaProfile, now: Date): ControllerCas {
  return rotateCaSet(
    stored,
    {
      fresh: () =>
        caCertificate(profile.commonName, CA_DAYS, now, profile.dnsNames, excludesIps(profile)),
      wanted: (ca) => permittedKey(ca.cert) === profileKey(profile),
    },
    now,
  );
}

/** How a CA set creates a CA, and which of its CAs carry what is wanted now. */
export interface CaSource {
  /** A new CA, valid from now. */
  fresh: () => KeyPair;
  /** True when `ca` (whose key is its own) carries the name constraints wanted now. */
  wanted: (ca: KeyPair) => boolean;
  /**
   * Set for a CA set whose holders take up a published successor at their own pace (the scheduler
   * CAs, #629): the switch then never comes in the pass that publishes the successor, and comes
   * only once `holdersTrust` (every holder's trust bundle carries the successor) or, as a last
   * resort, within {@link CA_SWITCH_DEADLINE_DAYS} of the signing CA's expiry. Absent, the switch
   * follows the overlap alone and comes at once in the signing CA's last {@link LEAF_RENEW_DAYS}.
   */
  gate?: { holdersTrust: boolean };
}

/**
 * {@link rotateCas} for any CA set: the same publish, switch and retire steps, with the CAs that
 * `source` creates and accepts. The scheduler CAs (#629) rotate through it with their own name
 * constraints, and a switch gated on their holders ({@link CaSource.gate}).
 */
export function rotateCaSet(stored: StoredCas, source: CaSource, now: Date): ControllerCas {
  const { fresh } = source;
  const current = usable(stored.current, now);
  const next = usable(stored.next, now);
  if (!current) {
    // Its leaf may still be served until the controller rolls, so a CA that is still valid stays
    // trusted (it never signs again), within the bounds of `keptAsPrevious`.
    const replacement = next ?? fresh();
    const old = stored.current?.cert;
    return keptAsPrevious(old, replacement.cert, now)
      ? { current: replacement, previous: old }
      : { current: replacement };
  }
  const cas: ControllerCas = {
    current,
    ...(keptAsPrevious(stored.previous, current.cert, now) ? { previous: stored.previous } : {}),
  };
  // A successor for names no longer wanted never signed, so it is dropped.
  const wanted = (ca: KeyPair | undefined) => (ca && source.wanted(ca) ? ca : undefined);
  const renew = !wanted(current) || !certificateValid(current.cert, CA_RENEW_DAYS, now);
  const published = wanted(next);
  return advance(cas, published ?? (renew ? fresh() : undefined), !!published, source, now);
}

/**
 * The switch step for `cas` (whose current CA can sign) and its successor `next`, which was
 * stored before this pass when `published`, or created in it.
 */
function advance(
  cas: ControllerCas,
  next: KeyPair | undefined,
  published: boolean,
  source: CaSource,
  now: Date,
): ControllerCas {
  if (!next) return cas;
  const expiring = !certificateValid(cas.current.cert, LEAF_RENEW_DAYS, now);
  const due = expiring || ageDays(next.cert, now) >= CA_OVERLAP_DAYS;
  if (source.gate) {
    const deadline = !certificateValid(cas.current.cert, CA_SWITCH_DEADLINE_DAYS, now);
    return published && (deadline || (due && source.gate.holdersTrust))
      ? { current: next, previous: cas.current.cert }
      : { ...cas, next };
  }
  if (!due) return { ...cas, next };
  const keptFor = (retainedUntil(cas.current.cert, next.cert) - now.getTime()) / DAY_MS;
  if (expiring || keptFor >= MIN_POST_SWITCH_DAYS)
    return { current: next, previous: cas.current.cert };
  // The old CA would leave the bundle too soon after the switch, while its leaf is still served.
  return { ...cas, next: source.fresh() };
}

/**
 * The names the serving leaf carries (#365): of `wanted` and, while a successor is published, of
 * the names the current leaf `served` already carries, those the signing CA permits. Removed names
 * thus stay served until the switch (the CA that signs still permits them) and added ones are
 * served as soon as a CA that signs permits them. Without a successor the leaf names `wanted`.
 * An IP address is kept only while the signing CA permits IP addresses: a leaf signed by a CA that
 * excludes them (#381) names none, so `127.0.0.1` leaves the leaf at the switch to such a CA.
 */
export function leafNames(cas: ControllerCas, wanted: CertNames, served?: CertNames): CertNames {
  const union = (a: string[], b: string[] = []) => [...new Set([...a, ...b])];
  const names =
    cas.next && served
      ? { dns: union(wanted.dns, served.dns), ips: union(wanted.ips, served.ips) }
      : wanted;
  return namesPermittedBy(cas.current.cert, names);
}

/**
 * The trust bundle of `cas`, oldest first: `previous`, `current`, `next`. Switching which CA signs
 * keeps the same bytes, so only publishing a successor and retiring `previous` change it.
 */
export const caBundle = (cas: ControllerCas): string =>
  [cas.previous, cas.current.cert, cas.next?.cert].filter(Boolean).join('');
