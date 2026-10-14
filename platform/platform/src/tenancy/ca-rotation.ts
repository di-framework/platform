import { X509Certificate } from 'node:crypto';
import { caCertificate, caPermittedDns, certificateValid, holdsCaKey, type KeyPair } from './tls';

/** Lifetime of a tenant controller CA (days). */
export const CA_DAYS = 3650;
/** A successor CA is published this many days before the signing CA expires. */
export const CA_RENEW_DAYS = 90;
/** How long a published successor is trusted before it starts signing the leaf (days). */
export const CA_OVERLAP_DAYS = 30;
/** The serving leaf is renewed this many days before it expires. */
export const LEAF_RENEW_DAYS = 30;

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

/** What a new tenant controller CA is: its subject and the only DNS names it permits (#365). */
export interface CaProfile {
  commonName: string;
  /** The DNS names the serving leaf needs; the CA's name constraints permit exactly these. */
  dnsNames: string[];
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
/** DNS names as one string, whatever their order or case; '' for none (an unconstrained CA). */
const nameKey = (names: string[] | undefined) =>
  names ? JSON.stringify([...new Set(names.map((n) => n.toLowerCase()))].sort()) : '';
/** The permitted DNS names of `ca` as one string ({@link nameKey}). */
const permittedKey = (ca: string) => nameKey(caPermittedDns(ca));
/**
 * True when `current` permits other names than `old` did (#365): `current` succeeded it because
 * the names changed, or `old` had no name constraints.
 */
const renamed = (old: string, current: string) => permittedKey(old) !== permittedKey(current);
/** True when `cert` is a CA certificate that has not expired (so it parses). */
const trustedCa = (cert: string | undefined, now: Date): cert is string =>
  !!cert && certificateValid(cert, 0, now) && new X509Certificate(cert).ca;
/**
 * Whether `old` stays in the bundle as `previous` beside `current` at `now`. It must be a CA that
 * has not expired, and either:
 *
 * - `current` succeeded it in a rotation: `current` was created within {@link CA_RENEW_DAYS} of
 *   `old`'s expiry (publish, or an early switch), so `old` is kept until it expires, at most that
 *   long;
 * - `current` succeeded it because the permitted names changed (#365): `current` was published
 *   and switched to after {@link CA_OVERLAP_DAYS}, so `old` is kept until `current` is twice that
 *   old, the same {@link CA_OVERLAP_DAYS} after a timely switch as below; or
 * - `current` replaced it at once (its key was lost) less than {@link CA_OVERLAP_DAYS} ago, long
 *   enough for the controller to roll off the leaf `old` signed. A CA replaced that way with years
 *   left (its key may have leaked) is never trusted for longer.
 *
 * All are read from the certificates (`old`'s notAfter, `current`'s notBefore, the name
 * constraints of both), so no extra state is stored and nothing can extend them.
 */
const keptAsPrevious = (old: string | undefined, current: string, now: Date): old is string => {
  if (old === current || !trustedCa(old, now)) return false;
  const created = new Date(new X509Certificate(current).validFrom).getTime();
  const oldEnd = new Date(new X509Certificate(old).validTo).getTime();
  // notBefore is backdated a few minutes for clock skew; a day of slack covers it.
  const succeeded = oldEnd <= created + (CA_RENEW_DAYS + 1) * DAY_MS;
  return succeeded || ageDays(current, now) < (renamed(old, current) ? 2 : 1) * CA_OVERLAP_DAYS;
};

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
 * Every CA this creates permits only the DNS names `profile.dnsNames` (#365). A current CA that
 * permits other names, or has no name constraints (a CA from before #365), goes through the same
 * three steps at once, whatever its age: a successor for the names wanted now is published, and
 * switched to after the overlap. Until then the leaf names only what the current CA permits
 * (`namesPermittedBy`), so an added name outside its subtrees is served from the switch on. A published successor for names no longer
 * wanted is dropped (it never signed, so nothing needs it) and a new one published. A renamed
 * successor that missed its switch by more than {@link CA_OVERLAP_DAYS} (the controller was not
 * running) is published again rather than switched to, since the old CA would leave the bundle in
 * the same pass while its leaf is still served.
 *
 * A current CA that is missing, expired or whose key is missing or wrong is replaced at once
 * (by the successor when there is a usable one): nothing can sign with it. Its certificate stays
 * in the bundle as `previous` for at most {@link CA_OVERLAP_DAYS} (twice that when the names it
 * permits differ too, see `keptAsPrevious`), so the leaf it signed keeps verifying while the
 * controller rolls, but a CA whose key may have leaked is not trusted for the rest of its life. With no CA certificate stored at all there is nothing to
 * keep: that is how a compromised CA is revoked (README, "CA rotation").
 */
export function rotateCas(stored: StoredCas, profile: CaProfile, now: Date): ControllerCas {
  const fresh = () => caCertificate(profile.commonName, CA_DAYS, now, profile.dnsNames);
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
  const wanted = (ca: KeyPair | undefined) =>
    ca && permittedKey(ca.cert) === nameKey(profile.dnsNames) ? ca : undefined;
  const renew = !wanted(current) || !certificateValid(current.cert, CA_RENEW_DAYS, now);
  return advance(cas, wanted(next) ?? (renew ? fresh() : undefined), fresh, now);
}

/** The switch step for `cas` (whose current CA can sign) and its published successor `next`. */
function advance(
  cas: ControllerCas,
  next: KeyPair | undefined,
  fresh: () => KeyPair,
  now: Date,
): ControllerCas {
  if (!next) return cas;
  const expiring = !certificateValid(cas.current.cert, LEAF_RENEW_DAYS, now);
  if (!expiring && ageDays(next.cert, now) < CA_OVERLAP_DAYS) return { ...cas, next };
  if (expiring || keptAsPrevious(cas.current.cert, next.cert, now))
    return { current: next, previous: cas.current.cert };
  // Switching now would drop the old CA from the bundle while its leaf is still served.
  return { ...cas, next: fresh() };
}
