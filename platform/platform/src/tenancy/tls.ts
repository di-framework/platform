import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

/** A PEM certificate and its PKCS#8 PEM private key. */
export interface KeyPair {
  cert: string;
  key: string;
}

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : (() => {
          const bytes: number[] = [];
          for (let n = body.length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
          return Buffer.from([0x80 | bytes.length, ...bytes]);
        })();
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (value: string): Buffer => {
  const [a, b, ...rest] = value.split('.').map(Number) as [number, number, ...number[]];
  const bytes = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
};
const time = (date: Date) =>
  der(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
const name = (commonName: string) =>
  seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(commonName)))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

/**
 * A positive, minimally encoded DER INTEGER body from random bytes: the high bit is cleared (no
 * sign) and the next bit set, so the leading byte is never a redundant `0x00`, which Go and
 * BoringSSL reject as a malformed serial.
 */
export function serialNumber(random: Buffer): Buffer {
  const serial = Buffer.from(random);
  serial[0] = ((serial[0] as number) & 0x7f) | 0x40;
  return serial;
}
/** Clock skew a fresh certificate tolerates: `notBefore` is backdated by this much. */
const BACKDATE_MS = 5 * 60_000;

/**
 * A self-signed P-256 certificate for `commonName`, the DNS names in `dnsNames` and the IPv4 `ipAddresses`, valid for
 * `days` days. Node has no X.509 writer, so this encodes the DER itself. Like `openssl req -x509`
 * it marks the certificate as a CA, so a client can pin it as its own trust anchor.
 */
export function selfSignedCertificate(
  commonName: string,
  dnsNames: string[],
  ipAddresses: string[],
  days: number,
  now: Date = new Date(),
): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = serialNumber(randomBytes(16));
  const san = seq(
    ...dnsNames.map((dns) => der(0x82, Buffer.from(dns))),
    ...ipAddresses.map((ip) => der(0x87, Buffer.from(ip.split('.').map(Number)))),
  );
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ECDSA_SHA256,
    name(commonName),
    seq(
      time(new Date(now.getTime() - BACKDATE_MS)),
      time(new Date(now.getTime() + days * 86_400_000)),
    ),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
    der(
      0xa3,
      seq(
        seq(
          oid('2.5.29.19'),
          der(0x01, Buffer.from([0xff])),
          der(0x04, seq(der(0x01, Buffer.from([0xff])))),
        ),
        seq(oid('2.5.29.17'), der(0x04, san)),
      ),
    ),
  );
  const cert = seq(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const pem = cert
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

/** True when `cert` (PEM) is still valid `marginDays` from `now`; false when unreadable. */
export function certificateValid(
  cert: string,
  marginDays: number,
  now: Date = new Date(),
): boolean {
  try {
    return (
      new Date(new X509Certificate(cert).validTo).getTime() >
      now.getTime() + marginDays * 86_400_000
    );
  } catch {
    return false;
  }
}

/** The DNS names and IP addresses in `cert`'s subjectAltName; undefined when unreadable. */
export function certificateNames(cert: string): { dns: string[]; ips: string[] } | undefined {
  try {
    const entries = (new X509Certificate(cert).subjectAltName ?? '').split(', ');
    const pick = (prefix: string) =>
      entries.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length));
    return { dns: pick('DNS:'), ips: pick('IP Address:') };
  } catch {
    return undefined;
  }
}
