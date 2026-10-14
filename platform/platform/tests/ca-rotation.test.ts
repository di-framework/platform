import { describe, expect, it } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import {
  CA_DAYS,
  CA_OVERLAP_DAYS,
  CA_RENEW_DAYS,
  type ControllerCas,
  LEAF_RENEW_DAYS,
  rotateCas,
} from '../src/tenancy/ca-rotation';
import { controllerTrustBundle } from '../src/tenancy/resources';
import {
  type CertNames,
  caCertificate,
  caPermittedDns,
  holdsCaKey,
  type KeyPair,
  leafCertificate,
  namesPermittedBy,
  selfSignedCertificate,
} from '../src/tenancy/tls';
import { verifiesAt, withinNameConstraints } from './support/tls';

const DAY = 86_400_000;
const NAME = 'tenant-controller CA (di-runtime-alpha)';
const NAMES = ['tenant-controller', 'localhost'];
const PROFILE = { commonName: NAME, dnsNames: NAMES };
/** A tenant controller CA for `NAMES`, as the controller creates it. */
const tenantCa = (days: number, now: Date, names = NAMES) => caCertificate(NAME, days, now, names);
const t0 = new Date('2026-10-14T00:00:00Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const bundle = (cas: ControllerCas) =>
  controllerTrustBundle({
    cert: '',
    key: '',
    caCert: cas.current.cert,
    caKey: cas.current.key,
    ...(cas.next ? { caNext: cas.next } : {}),
    ...(cas.previous ? { caPrevious: cas.previous } : {}),
  });
const stored = (cas: ControllerCas) => ({
  current: cas.current,
  ...(cas.next ? { next: cas.next } : {}),
  ...(cas.previous ? { previous: cas.previous } : {}),
});

/** One reconcile pass: when it ran, the CAs it kept and the leaf the controller then serves. */
interface Step {
  at: Date;
  cas: ControllerCas;
  leaf: string;
}
/**
 * Reconcile passes from `start` on the days given, each with the DNS names wanted then (the leaf
 * also names `127.0.0.1`). Like the controller, a pass issues a leaf when there is none, when the
 * signing CA changes, or when the names the signing CA permits of those wanted change.
 */
const walk = (start: ControllerCas, plan: [day: number, names: string[]][]): Step[] => {
  const steps: Step[] = [];
  let [cas, leaf, leafNames] = [start, '', ''];
  for (const [day, dnsNames] of plan) {
    const now = at(day);
    const next = rotateCas(stored(cas), { commonName: NAME, dnsNames }, now);
    const names = namesPermittedBy(next.current.cert, { dns: dnsNames, ips: ['127.0.0.1'] });
    if (!leaf || next.current.cert !== cas.current.cert || JSON.stringify(names) !== leafNames) {
      const { cert } = next.current;
      leaf = leafCertificate(NAME, names.dns, names.ips, 365, cert, next.current.key, now).cert;
      leafNames = JSON.stringify(names);
    }
    cas = next;
    steps.push({ at: now, cas, leaf });
  }
  return steps;
};
/**
 * A rollout is never atomic: between two passes an old or new controller pod (leaf) meets an old
 * or new host or kubeconfig (bundle). Each leaf of two adjacent steps must verify against each of
 * their bundles at the later step.
 */
const expectNoTrustGap = (steps: Step[]) => {
  for (const [i, to] of steps.entries()) {
    const from = steps[i - 1];
    if (!from) continue;
    for (const l of [from.leaf, to.leaf])
      for (const b of [bundle(from.cas), bundle(to.cas)])
        expect(verifiesAt(l, b, to.at)).toBe(true);
  }
};
/** Serves a leaf `signer` issues for `dns` and `ips`, and fetches it over TLS trusting `ca`. */
const handshake = async (signer: KeyPair, ca: string, dns = ['localhost'], ips: string[] = []) => {
  // Real time, so the handshake's own clock agrees with the certificates.
  const leaf = leafCertificate('localhost', dns, ips, 30, signer.cert, signer.key);
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: { cert: leaf.cert, key: leaf.key },
    fetch: () => new Response('ok'),
  });
  try {
    const response = await fetch(`https://localhost:${server.port}/`, { tls: { ca } });
    return await response.text();
  } catch {
    return 'rejected';
  } finally {
    server.stop(true);
  }
};

describe('rotateCas (#170)', () => {
  it('creates a CA when none is stored and keeps it while far from expiry', () => {
    const first = rotateCas({}, PROFILE, t0);
    expect(holdsCaKey(first.current.cert, first.current.key)).toBe(true);
    expect(new X509Certificate(first.current.cert).subject).toBe(`CN=${NAME}`);
    expect(first.next).toBeUndefined();
    expect(first.previous).toBeUndefined();
    expect(rotateCas(stored(first), PROFILE, at(CA_DAYS - CA_RENEW_DAYS - 1))).toEqual(first);
  });

  it('replaces a current CA at once when its key is missing or wrong, or it expired', () => {
    const a = tenantCa(CA_DAYS, t0);
    const other = caCertificate('other', CA_DAYS, t0);
    // A CA that lost its key stays trusted as `previous` while valid: its leaf is still served
    // until the controller rolls.
    for (const current of [{ cert: a.cert }, { cert: a.cert, key: other.key }]) {
      const cas = rotateCas({ current }, PROFILE, t0);
      expect(cas.current.cert).not.toBe(a.cert);
      expect(holdsCaKey(cas.current.cert, cas.current.key)).toBe(true);
      expect(cas.previous).toBe(a.cert);
      expect(cas.next).toBeUndefined();
    }
    const garbage = rotateCas({ current: { cert: 'garbage', key: a.key } }, PROFILE, t0);
    expect(garbage.previous).toBeUndefined();
    // An expired CA is not kept.
    const expired = rotateCas({ current: a }, PROFILE, at(CA_DAYS + 1));
    expect(expired.current.cert).not.toBe(a.cert);
    expect(expired.previous).toBeUndefined();
    // A leaf certificate is never taken for a CA, current or previous.
    const leaf = leafCertificate('leaf', ['a'], [], 30, a.cert, a.key, t0);
    const fromLeaf = rotateCas({ current: leaf }, PROFILE, t0);
    expect(fromLeaf.current.cert).not.toBe(leaf.cert);
    expect(fromLeaf.previous).toBeUndefined();
  });

  it('promotes a published successor when the current CA becomes unusable', () => {
    const a = tenantCa(CA_DAYS, t0);
    const b = tenantCa(CA_DAYS, at(CA_DAYS - CA_RENEW_DAYS));
    const cas = rotateCas({ current: { cert: a.cert }, next: b }, PROFILE, at(CA_DAYS - 80));
    expect(cas).toEqual({ current: b, previous: a.cert });
  });

  it('publishes, switches and retires on schedule, keeping the bundle bytes at the switch', () => {
    const a = tenantCa(CA_DAYS, t0);
    const published = rotateCas({ current: a }, PROFILE, at(CA_DAYS - CA_RENEW_DAYS + 1));
    expect(published.current).toEqual(a);
    expect(published.previous).toBeUndefined();
    const b = published.next;
    if (!b) throw new Error('no successor was published');
    // Within the overlap nothing changes.
    const overlap = at(CA_DAYS - CA_RENEW_DAYS + CA_OVERLAP_DAYS);
    expect(rotateCas(stored(published), PROFILE, overlap)).toEqual(published);
    const switched = rotateCas(stored(published), PROFILE, at(CA_DAYS - CA_RENEW_DAYS + 32));
    expect(switched).toEqual({ current: b, previous: a.cert });
    expect(bundle(switched)).toBe(bundle(published));
    expect(bundle(published)).toBe(a.cert + b.cert);
    // The old CA stays trusted until it expires, then leaves the bundle.
    expect(rotateCas(stored(switched), PROFILE, at(CA_DAYS - 1))).toEqual(switched);
    const retired = rotateCas(stored(switched), PROFILE, at(CA_DAYS + 1));
    expect(retired).toEqual({ current: b });
    expect(bundle(retired)).toBe(b.cert);
  });

  it('switches in the same pass when the current CA is about to expire', () => {
    const a = tenantCa(CA_DAYS, t0);
    // Reconciled again only LEAF_RENEW_DAYS before expiry: waiting would renew the capped leaf
    // on every pass, so the successor signs at once while the old CA stays in the bundle.
    const late = rotateCas({ current: a }, PROFILE, at(CA_DAYS - LEAF_RENEW_DAYS + 1));
    expect(late.current.cert).not.toBe(a.cert);
    expect(late.previous).toBe(a.cert);
    expect(late.next).toBeUndefined();
    // A successor younger than the overlap is promoted early for the same reason.
    const b = tenantCa(CA_DAYS, at(CA_DAYS - 40));
    expect(rotateCas({ current: a, next: b }, PROFILE, at(CA_DAYS - 20))).toEqual({
      current: b,
      previous: a.cert,
    });
  });

  it('keeps a CA replaced for a lost key for at most the overlap', () => {
    const a = tenantCa(CA_DAYS, t0);
    // The key is lost 100 days in, years before A would expire.
    const replaced = rotateCas({ current: { cert: a.cert } }, PROFILE, at(100));
    expect(replaced.previous).toBe(a.cert);
    expect(bundle(replaced)).toBe(a.cert + replaced.current.cert);
    const kept = rotateCas(stored(replaced), PROFILE, at(100 + CA_OVERLAP_DAYS - 1));
    expect(kept).toEqual(replaced);
    const dropped = rotateCas(stored(replaced), PROFILE, at(100 + CA_OVERLAP_DAYS + 1));
    expect(dropped).toEqual({ current: replaced.current });
    expect(bundle(dropped)).not.toContain(a.cert);
    // Stored again later, it is not taken back.
    expect(rotateCas(stored(replaced), PROFILE, at(1000))).toEqual({ current: replaced.current });
  });

  it('keeps a predecessor until it expires when its successor was published for it', () => {
    const a = tenantCa(CA_DAYS, t0);
    const b = tenantCa(CA_DAYS, at(CA_DAYS - CA_RENEW_DAYS + 1));
    // A lost its key during the overlap: the published B takes over, and A stays until it expires
    // (less than CA_RENEW_DAYS), past the overlap that bounds an unplanned replacement.
    const promoted = rotateCas({ current: { cert: a.cert }, next: b }, PROFILE, at(CA_DAYS - 80));
    expect(promoted).toEqual({ current: b, previous: a.cert });
    expect(rotateCas(stored(promoted), PROFILE, at(CA_DAYS - 1))).toEqual(promoted);
    expect(rotateCas(stored(promoted), PROFILE, at(CA_DAYS + 1))).toEqual({ current: b });
  });

  it('drops a stored successor whose key does not match, and publishes a new one', () => {
    const a = tenantCa(CA_DAYS, t0);
    const b = tenantCa(CA_DAYS, at(CA_DAYS - CA_RENEW_DAYS));
    const other = caCertificate('other', CA_DAYS, t0);
    const far = rotateCas({ current: a, next: { cert: b.cert, key: other.key } }, PROFILE, at(10));
    expect(far).toEqual({ current: a });
    const near = rotateCas(
      { current: a, next: { cert: b.cert, key: other.key } },
      PROFILE,
      at(CA_DAYS - CA_RENEW_DAYS + 1),
    );
    expect(near.next?.cert).not.toBe(b.cert);
    expect(holdsCaKey(near.next?.cert ?? '', near.next?.key ?? '')).toBe(true);
  });

  it('keeps only a previous CA that is a CA certificate and has not expired', () => {
    const a = tenantCa(CA_DAYS, t0);
    const old = tenantCa(10, t0);
    const leaf = leafCertificate('leaf', ['a'], [], 30, a.cert, a.key, t0);
    expect(rotateCas({ current: a, previous: old.cert }, PROFILE, at(5)).previous).toBe(old.cert);
    expect(rotateCas({ current: a, previous: old.cert }, PROFILE, at(11)).previous).toBeUndefined();
    expect(rotateCas({ current: a, previous: leaf.cert }, PROFILE, at(5)).previous).toBeUndefined();
    expect(rotateCas({ current: a, previous: 'garbage' }, PROFILE, at(5)).previous).toBeUndefined();
    expect(rotateCas({ current: a, previous: a.cert }, PROFILE, at(5)).previous).toBeUndefined();
  });

  it('keeps every leaf of a rotation verifiable against each adjacent bundle (X.509 path check)', () => {
    // Steady (after a yearly leaf renewal), publish, switch, retire.
    const steps = walk(
      { current: tenantCa(CA_DAYS, t0) },
      [
        CA_DAYS - CA_RENEW_DAYS - 10,
        CA_DAYS - CA_RENEW_DAYS + 1,
        CA_DAYS - CA_RENEW_DAYS + 32,
        CA_DAYS + 1,
      ].map((day) => [day, NAMES]),
    );
    expectNoTrustGap(steps);
    const [steady, , switched] = steps;
    if (!steady || !switched) throw new Error('missing rotation steps');
    expect(steps.map((step) => step.cas.current.cert === steady.cas.current.cert)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // Without the overlap a host still on the old bundle would reject the new leaf.
    expect(verifiesAt(switched.leaf, steady.cas.current.cert, switched.at)).toBe(false);
  });

  it("verifies a TLS handshake through Bun's client against a two-CA bundle", async () => {
    const a = caCertificate('A', 30);
    const b = caCertificate('B', 30);
    expect(await handshake(a, a.cert + b.cert)).toBe('ok');
    expect(await handshake(b, a.cert + b.cert)).toBe('ok');
    expect(await handshake(a, b.cert)).toBe('rejected');
  });

  it('checks every link of the path in the X.509 helper the rotation tests rely on', () => {
    const a = tenantCa(100, t0);
    const leaf = leafCertificate('localhost', ['localhost'], [], 30, a.cert, a.key, t0).cert;
    expect(verifiesAt(leaf, a.cert, at(1))).toBe(true);
    // Each of these must fail, or the matrices above could pass on a broken setup.
    expect(verifiesAt(leaf, a.cert, at(-1))).toBe(false);
    expect(verifiesAt(leaf, a.cert, at(31))).toBe(false);
    const sameName = tenantCa(100, t0);
    expect(verifiesAt(leaf, sameName.cert, at(1))).toBe(false);
    const elsewhere = leafCertificate('other', ['other.example'], [], 30, a.cert, a.key, t0).cert;
    expect(verifiesAt(elsewhere, a.cert, at(1))).toBe(false);
    const selfSigned = selfSignedCertificate('localhost', ['localhost'], [], 30, t0).cert;
    expect(verifiesAt(selfSigned, selfSigned, at(1))).toBe(false);
    expect(verifiesAt(leaf, leaf, at(1))).toBe(false);
    expect(() => verifiesAt(leaf, '', at(1))).toThrow();
    expect(() =>
      verifiesAt(leaf, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', at(1)),
    ).toThrow();
  });
});

describe('tenant controller CA name constraints (#365)', () => {
  const HOST = 'controller.alpha.example.com';
  const MOVED = [...NAMES, HOST];
  const sans = (leaf: string) => new X509Certificate(leaf).subjectAltName ?? '';
  const profile = (dnsNames: string[]) => ({ commonName: NAME, dnsNames });

  it('writes a critical nameConstraints extension permitting only the given DNS names', () => {
    const ca = tenantCa(CA_DAYS, t0);
    expect(caPermittedDns(ca.cert)).toEqual(NAMES);
    // Read back independently of the parser above.
    const text = Bun.spawnSync(['openssl', 'x509', '-noout', '-text'], {
      stdin: Buffer.from(ca.cert),
    }).stdout.toString();
    expect(text).toMatch(/X509v3 Name Constraints: critical\s+Permitted:\s+DNS:tenant-controller/);
    expect(text).toContain('DNS:localhost');
    expect(text).not.toContain('IP:');
    expect(caPermittedDns(caCertificate(NAME, CA_DAYS, t0).cert)).toBeUndefined();
    expect(caPermittedDns('garbage')).toBeUndefined();
    expect(() => caCertificate(NAME, CA_DAYS, t0, [])).toThrow();
  });

  it('refuses a leaf naming a DNS name outside the constraints', () => {
    const ca = tenantCa(CA_DAYS, t0);
    const evil = ['localhost', 'evil.example'];
    const outside = leafCertificate('x', evil, [], 30, ca.cert, ca.key, t0);
    // node:crypto applies no name constraints: the signature and issuer link check out.
    const leafX = new X509Certificate(outside.cert);
    const caX = new X509Certificate(ca.cert);
    expect(leafX.verify(caX.publicKey) && leafX.checkIssued(caX)).toBe(true);
    // So the path check in the test helper applies them itself.
    expect(withinNameConstraints(outside.cert, ca.cert)).toBe(false);
    expect(verifiesAt(outside.cert, ca.cert, at(1))).toBe(false);
    // A name below a permitted subtree and any IP address are allowed (RFC 5280 §4.2.1.10).
    const below = leafCertificate('x', ['a.localhost'], ['10.1.2.3'], 30, ca.cert, ca.key, t0);
    expect(withinNameConstraints(below.cert, ca.cert)).toBe(true);
    // The same names from an unconstrained CA verify.
    const open = caCertificate(NAME, CA_DAYS, t0);
    const anyName = leafCertificate('x', evil, [], 30, open.cert, open.key, t0);
    expect(verifiesAt(anyName.cert, open.cert, at(1))).toBe(true);
  });

  it("is enforced by Bun's TLS client, which accepts the controller's own names", async () => {
    const ca = caCertificate('A', 30, new Date(), NAMES);
    expect(await handshake(ca, ca.cert, NAMES, ['127.0.0.1'])).toBe('ok');
    expect(await handshake(ca, ca.cert, ['localhost', 'evil.example'])).toBe('rejected');
  });

  it('keeps of the names wanted those the signing CA permits, and every IP address', () => {
    const ca = tenantCa(CA_DAYS, t0);
    const wanted: CertNames = { dns: MOVED, ips: ['127.0.0.1', '10.1.2.3'] };
    expect(namesPermittedBy(ca.cert, wanted)).toEqual({ dns: NAMES, ips: wanted.ips });
    expect(namesPermittedBy(caCertificate(NAME, CA_DAYS, t0).cert, wanted)).toEqual(wanted);
  });

  it('rotates through the overlap when a name is added, with no trust gap', () => {
    const steps = walk({ current: tenantCa(CA_DAYS, t0) }, [
      [100, NAMES],
      [101, MOVED],
      [101 + CA_OVERLAP_DAYS - 1, MOVED],
      [101 + CA_OVERLAP_DAYS + 1, MOVED],
      [101 + 2 * CA_OVERLAP_DAYS - 1, MOVED],
      [101 + 2 * CA_OVERLAP_DAYS + 1, MOVED],
    ]);
    expectNoTrustGap(steps);
    const [steady, published, waiting, switched, kept, retired] = steps as Step[] as [
      Step,
      Step,
      Step,
      Step,
      Step,
      Step,
    ];
    const a = steady.cas.current.cert;
    // Publish: the successor permits the new host; A's leaf, without it, is served meanwhile.
    expect(published.cas.current.cert).toBe(a);
    expect(caPermittedDns(published.cas.next?.cert ?? '')).toEqual(MOVED);
    expect(published.leaf).toBe(steady.leaf);
    expect(waiting.cas).toEqual(published.cas);
    // Switch: the successor signs a leaf for the new host, A stays trusted for the overlap.
    expect(switched.cas).toEqual({ current: published.cas.next as KeyPair, previous: a });
    expect(bundle(switched.cas)).toBe(bundle(published.cas));
    expect(sans(switched.leaf)).toContain(`DNS:${HOST}`);
    expect(withinNameConstraints(switched.leaf, a)).toBe(false);
    expect(kept.cas).toEqual(switched.cas);
    // Retire: A leaves the bundle; the new leaf never depended on it.
    expect(retired.cas).toEqual({ current: published.cas.next as KeyPair });
    expect(verifiesAt(steady.leaf, bundle(retired.cas), retired.at)).toBe(false);
  });

  it('narrows the leaf at once when a name is removed, then rotates to a narrower CA', () => {
    const steps = walk({ current: tenantCa(CA_DAYS, t0, MOVED) }, [
      [100, MOVED],
      [101, NAMES],
      [101 + CA_OVERLAP_DAYS + 1, NAMES],
      [101 + 2 * CA_OVERLAP_DAYS + 1, NAMES],
    ]);
    expectNoTrustGap(steps);
    const [steady, published, switched] = steps as [Step, Step, Step];
    expect(sans(steady.leaf)).toContain(HOST);
    // The current CA still permits everything wanted, so the leaf drops the host now.
    expect(published.cas.current.cert).toBe(steady.cas.current.cert);
    expect(sans(published.leaf)).not.toContain(HOST);
    expect(caPermittedDns(published.cas.next?.cert ?? '')).toEqual(NAMES);
    expect(switched.cas.current).toEqual(published.cas.next as KeyPair);
  });

  it('replaces a published successor for names no longer wanted', () => {
    const a = tenantCa(CA_DAYS, t0);
    const b = tenantCa(CA_DAYS, at(100), MOVED);
    // Changed back before the switch: B never signed, so it is simply dropped.
    expect(rotateCas({ current: a, next: b }, PROFILE, at(110))).toEqual({ current: a });
    // Changed again: a successor for the latest names is published, and the overlap restarts.
    const other = [...NAMES, 'other.example.com'];
    const again = rotateCas({ current: a, next: b }, profile(other), at(110));
    expect(again.current).toEqual(a);
    expect(caPermittedDns(again.next?.cert ?? '')).toEqual(other);
    expect(rotateCas(stored(again), profile(other), at(139)).next).toEqual(again.next as KeyPair);
  });

  it('publishes a renamed successor again when its switch was missed by over the overlap', () => {
    const a = tenantCa(CA_DAYS, t0);
    const b = tenantCa(CA_DAYS, at(100), MOVED);
    const late = rotateCas({ current: a, next: b }, profile(MOVED), at(101 + 2 * CA_OVERLAP_DAYS));
    expect(late.current).toEqual(a);
    expect(late.next?.cert).not.toBe(b.cert);
    expect(caPermittedDns(late.next?.cert ?? '')).toEqual(MOVED);
    // Within the window it switches, keeping A until B is twice the overlap old.
    const timely = rotateCas({ current: a, next: b }, profile(MOVED), at(105 + CA_OVERLAP_DAYS));
    expect(timely).toEqual({ current: b, previous: a.cert });
  });

  it('rolls a CA without name constraints to a constrained one through the overlap', () => {
    const legacy = caCertificate(NAME, CA_DAYS, t0);
    const steps = walk({ current: legacy }, [
      [100, NAMES],
      [100 + CA_OVERLAP_DAYS + 1, NAMES],
      [100 + 2 * CA_OVERLAP_DAYS - 1, NAMES],
      [100 + 2 * CA_OVERLAP_DAYS + 1, NAMES],
    ]);
    expectNoTrustGap(steps);
    const [published, switched, kept, retired] = steps as [Step, Step, Step, Step];
    // Published at once, years before the legacy CA would expire; its leaf keeps every name.
    expect(published.cas.current).toEqual(legacy);
    const successor = published.cas.next as KeyPair;
    expect(caPermittedDns(successor.cert)).toEqual(NAMES);
    expect(sans(published.leaf)).toBe('DNS:tenant-controller, DNS:localhost, IP Address:127.0.0.1');
    expect(switched.cas).toEqual({ current: successor, previous: legacy.cert });
    expect(kept.cas).toEqual(switched.cas);
    expect(retired.cas).toEqual({ current: successor });
  });

  it('keeps an unconstrained CA whose key was lost for at most twice the overlap', () => {
    const legacy = caCertificate(NAME, CA_DAYS, t0);
    const replaced = rotateCas({ current: { cert: legacy.cert } }, PROFILE, at(100));
    expect(replaced.previous).toBe(legacy.cert);
    expect(caPermittedDns(replaced.current.cert)).toEqual(NAMES);
    const later = (days: number) => rotateCas(stored(replaced), PROFILE, at(100 + days)).previous;
    expect(later(2 * CA_OVERLAP_DAYS - 1)).toBe(legacy.cert);
    expect(later(2 * CA_OVERLAP_DAYS + 1)).toBeUndefined();
  });
});
