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
  caCertificate,
  holdsCaKey,
  leafCertificate,
  selfSignedCertificate,
} from '../src/tenancy/tls';
import { verifiesAt } from './support/tls';

const DAY = 86_400_000;
const NAME = 'tenant-controller CA (di-runtime-alpha)';
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

describe('rotateCas (#170)', () => {
  it('creates a CA when none is stored and keeps it while far from expiry', () => {
    const first = rotateCas({}, NAME, t0);
    expect(holdsCaKey(first.current.cert, first.current.key)).toBe(true);
    expect(new X509Certificate(first.current.cert).subject).toBe(`CN=${NAME}`);
    expect(first.next).toBeUndefined();
    expect(first.previous).toBeUndefined();
    expect(rotateCas(stored(first), NAME, at(CA_DAYS - CA_RENEW_DAYS - 1))).toEqual(first);
  });

  it('replaces a current CA at once when its key is missing or wrong, or it expired', () => {
    const a = caCertificate(NAME, CA_DAYS, t0);
    const other = caCertificate('other', CA_DAYS, t0);
    // A CA that lost its key stays trusted as `previous` while valid: its leaf is still served
    // until the controller rolls.
    for (const current of [{ cert: a.cert }, { cert: a.cert, key: other.key }]) {
      const cas = rotateCas({ current }, NAME, t0);
      expect(cas.current.cert).not.toBe(a.cert);
      expect(holdsCaKey(cas.current.cert, cas.current.key)).toBe(true);
      expect(cas.previous).toBe(a.cert);
      expect(cas.next).toBeUndefined();
    }
    const garbage = rotateCas({ current: { cert: 'garbage', key: a.key } }, NAME, t0);
    expect(garbage.previous).toBeUndefined();
    // An expired CA is not kept.
    const expired = rotateCas({ current: a }, NAME, at(CA_DAYS + 1));
    expect(expired.current.cert).not.toBe(a.cert);
    expect(expired.previous).toBeUndefined();
    // A leaf certificate is never taken for a CA, current or previous.
    const leaf = leafCertificate('leaf', ['a'], [], 30, a.cert, a.key, t0);
    const fromLeaf = rotateCas({ current: leaf }, NAME, t0);
    expect(fromLeaf.current.cert).not.toBe(leaf.cert);
    expect(fromLeaf.previous).toBeUndefined();
  });

  it('promotes a published successor when the current CA becomes unusable', () => {
    const a = caCertificate(NAME, CA_DAYS, t0);
    const b = caCertificate(NAME, CA_DAYS, at(CA_DAYS - CA_RENEW_DAYS));
    const cas = rotateCas({ current: { cert: a.cert }, next: b }, NAME, at(CA_DAYS - 80));
    expect(cas).toEqual({ current: b, previous: a.cert });
  });

  it('publishes, switches and retires on schedule, keeping the bundle bytes at the switch', () => {
    const a = caCertificate(NAME, CA_DAYS, t0);
    const published = rotateCas({ current: a }, NAME, at(CA_DAYS - CA_RENEW_DAYS + 1));
    expect(published.current).toEqual(a);
    expect(published.previous).toBeUndefined();
    const b = published.next;
    if (!b) throw new Error('no successor was published');
    // Within the overlap nothing changes.
    const overlap = at(CA_DAYS - CA_RENEW_DAYS + CA_OVERLAP_DAYS);
    expect(rotateCas(stored(published), NAME, overlap)).toEqual(published);
    const switched = rotateCas(stored(published), NAME, at(CA_DAYS - CA_RENEW_DAYS + 32));
    expect(switched).toEqual({ current: b, previous: a.cert });
    expect(bundle(switched)).toBe(bundle(published));
    expect(bundle(published)).toBe(a.cert + b.cert);
    // The old CA stays trusted until it expires, then leaves the bundle.
    expect(rotateCas(stored(switched), NAME, at(CA_DAYS - 1))).toEqual(switched);
    const retired = rotateCas(stored(switched), NAME, at(CA_DAYS + 1));
    expect(retired).toEqual({ current: b });
    expect(bundle(retired)).toBe(b.cert);
  });

  it('switches in the same pass when the current CA is about to expire', () => {
    const a = caCertificate(NAME, CA_DAYS, t0);
    // Reconciled again only LEAF_RENEW_DAYS before expiry: waiting would renew the capped leaf
    // on every pass, so the successor signs at once while the old CA stays in the bundle.
    const late = rotateCas({ current: a }, NAME, at(CA_DAYS - LEAF_RENEW_DAYS + 1));
    expect(late.current.cert).not.toBe(a.cert);
    expect(late.previous).toBe(a.cert);
    expect(late.next).toBeUndefined();
    // A successor younger than the overlap is promoted early for the same reason.
    const b = caCertificate(NAME, CA_DAYS, at(CA_DAYS - 40));
    expect(rotateCas({ current: a, next: b }, NAME, at(CA_DAYS - 20))).toEqual({
      current: b,
      previous: a.cert,
    });
  });

  it('keeps a CA replaced for a lost key for at most the overlap', () => {
    const a = caCertificate(NAME, CA_DAYS, t0);
    // The key is lost 100 days in, years before A would expire.
    const replaced = rotateCas({ current: { cert: a.cert } }, NAME, at(100));
    expect(replaced.previous).toBe(a.cert);
    expect(bundle(replaced)).toBe(a.cert + replaced.current.cert);
    const kept = rotateCas(stored(replaced), NAME, at(100 + CA_OVERLAP_DAYS - 1));
    expect(kept).toEqual(replaced);
    const dropped = rotateCas(stored(replaced), NAME, at(100 + CA_OVERLAP_DAYS + 1));
    expect(dropped).toEqual({ current: replaced.current });
    expect(bundle(dropped)).not.toContain(a.cert);
    // Stored again later, it is not taken back.
    expect(rotateCas(stored(replaced), NAME, at(1000))).toEqual({ current: replaced.current });
  });

  it('keeps a predecessor until it expires when its successor was published for it', () => {
    const a = caCertificate(NAME, CA_DAYS, t0);
    const b = caCertificate(NAME, CA_DAYS, at(CA_DAYS - CA_RENEW_DAYS + 1));
    // A lost its key during the overlap: the published B takes over, and A stays until it expires
    // (less than CA_RENEW_DAYS), past the overlap that bounds an unplanned replacement.
    const promoted = rotateCas({ current: { cert: a.cert }, next: b }, NAME, at(CA_DAYS - 80));
    expect(promoted).toEqual({ current: b, previous: a.cert });
    expect(rotateCas(stored(promoted), NAME, at(CA_DAYS - 1))).toEqual(promoted);
    expect(rotateCas(stored(promoted), NAME, at(CA_DAYS + 1))).toEqual({ current: b });
  });

  it('drops a stored successor whose key does not match, and publishes a new one', () => {
    const a = caCertificate(NAME, CA_DAYS, t0);
    const b = caCertificate(NAME, CA_DAYS, at(CA_DAYS - CA_RENEW_DAYS));
    const other = caCertificate('other', CA_DAYS, t0);
    const far = rotateCas({ current: a, next: { cert: b.cert, key: other.key } }, NAME, at(10));
    expect(far).toEqual({ current: a });
    const near = rotateCas(
      { current: a, next: { cert: b.cert, key: other.key } },
      NAME,
      at(CA_DAYS - CA_RENEW_DAYS + 1),
    );
    expect(near.next?.cert).not.toBe(b.cert);
    expect(holdsCaKey(near.next?.cert ?? '', near.next?.key ?? '')).toBe(true);
  });

  it('keeps only a previous CA that is a CA certificate and has not expired', () => {
    const a = caCertificate(NAME, CA_DAYS, t0);
    const old = caCertificate(NAME, 10, t0);
    const leaf = leafCertificate('leaf', ['a'], [], 30, a.cert, a.key, t0);
    expect(rotateCas({ current: a, previous: old.cert }, NAME, at(5)).previous).toBe(old.cert);
    expect(rotateCas({ current: a, previous: old.cert }, NAME, at(11)).previous).toBeUndefined();
    expect(rotateCas({ current: a, previous: leaf.cert }, NAME, at(5)).previous).toBeUndefined();
    expect(rotateCas({ current: a, previous: 'garbage' }, NAME, at(5)).previous).toBeUndefined();
    expect(rotateCas({ current: a, previous: a.cert }, NAME, at(5)).previous).toBeUndefined();
  });

  it('keeps every leaf of a rotation verifiable against each adjacent bundle (X.509 path check)', () => {
    const steps: { at: Date; cas: ControllerCas; leaf: string }[] = [];
    let cas: ControllerCas = { current: caCertificate(NAME, CA_DAYS, t0) };
    let leaf = '';
    // Steady (after a yearly leaf renewal), publish, switch, retire.
    for (const day of [
      CA_DAYS - CA_RENEW_DAYS - 10,
      CA_DAYS - CA_RENEW_DAYS + 1,
      CA_DAYS - CA_RENEW_DAYS + 32,
      CA_DAYS + 1,
    ]) {
      const now = at(day);
      const next = rotateCas(stored(cas), NAME, now);
      // The controller issues a leaf when the signing CA changes, and here once for the renewal.
      if (!leaf || next.current.cert !== cas.current.cert)
        leaf = leafCertificate(
          'tenant-controller',
          ['localhost'],
          [],
          365,
          next.current.cert,
          next.current.key,
          now,
        ).cert;
      cas = next;
      steps.push({ at: now, cas, leaf });
    }
    for (const [i, to] of steps.entries()) {
      const from = steps[i - 1];
      if (!from) continue;
      for (const l of [from.leaf, to.leaf])
        for (const b of [bundle(from.cas), bundle(to.cas)])
          expect(verifiesAt(l, b, to.at)).toBe(true);
    }
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
    // Real time, so the handshake's own clock agrees with the certificates.
    const a = caCertificate('A', 30);
    const b = caCertificate('B', 30);
    const handshake = async (signer: typeof a, ca: string) => {
      const leaf = leafCertificate('localhost', ['localhost'], [], 30, signer.cert, signer.key);
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
    expect(await handshake(a, a.cert + b.cert)).toBe('ok');
    expect(await handshake(b, a.cert + b.cert)).toBe('ok');
    expect(await handshake(a, b.cert)).toBe('rejected');
  });

  it('checks every link of the path in the X.509 helper the rotation tests rely on', () => {
    const a = caCertificate(NAME, 100, t0);
    const leaf = leafCertificate('localhost', ['localhost'], [], 30, a.cert, a.key, t0).cert;
    expect(verifiesAt(leaf, a.cert, at(1))).toBe(true);
    // Each of these must fail, or the matrices above could pass on a broken setup.
    expect(verifiesAt(leaf, a.cert, at(-1))).toBe(false);
    expect(verifiesAt(leaf, a.cert, at(31))).toBe(false);
    const sameName = caCertificate(NAME, 100, t0);
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
