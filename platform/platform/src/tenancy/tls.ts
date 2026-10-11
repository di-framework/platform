import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from 'node:crypto';

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
const BOOLEAN_TRUE = der(0x01, Buffer.from([0xff]));

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

/** One X.509 extension; `value` is the DER of its extnValue contents. */
const extension = (id: string, value: Buffer, critical = false): Buffer =>
  seq(oid(id), ...(critical ? [BOOLEAN_TRUE] : []), der(0x04, value));
/** A key identifier: SHA-1 of the SubjectPublicKeyInfo (RFC 5280 §4.2.1.2 allows any unique method). */
const keyId = (key: KeyObject): Buffer =>
  createHash('sha1')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest();
const subjectKeyId = (key: KeyObject) => extension('2.5.29.14', der(0x04, keyId(key)));
const authorityKeyId = (key: KeyObject) => extension('2.5.29.35', seq(der(0x80, keyId(key))));
/** A keyUsage extension (critical) with the named bit numbers set (0 digitalSignature, 5 keyCertSign, 6 cRLSign). */
const keyUsage = (...bits: number[]) => {
  const byte = bits.reduce((acc, bit) => acc | (0x80 >> bit), 0);
  const unused = 31 - Math.clz32(byte & -byte); // trailing zero bits, as DER requires
  return extension('2.5.29.15', der(0x03, Buffer.from([unused, byte])), true);
};
const subjectAltName = (dnsNames: string[], ipAddresses: string[]) =>
  extension(
    '2.5.29.17',
    seq(
      ...dnsNames.map((dns) => der(0x82, Buffer.from(dns))),
      ...ipAddresses.map((ip) => der(0x87, Buffer.from(ip.split('.').map(Number)))),
    ),
  );
const pem = (label: string, body: Buffer): string =>
  `-----BEGIN ${label}-----\n${(body.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
const pkcs8 = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }) as string;

/** The DER children of the constructed element at the start of `buf`. */
function children(buf: Buffer): Buffer[] {
  const first = buf[1] as number;
  const out: Buffer[] = [];
  for (let at = first & 0x80 ? 2 + (first & 0x7f) : 2; at < buf.length; ) {
    const lead = buf[at + 1] as number;
    const width = lead & 0x80 ? lead & 0x7f : 0;
    const length = width ? buf.readUIntBE(at + 2, width) : lead;
    out.push(buf.subarray(at, at + 2 + width + length));
    at += 2 + width + length;
  }
  return out;
}

/** The subject Name of a PEM certificate as DER, so a leaf can carry it verbatim as its issuer. */
function subjectDer(cert: string): Buffer {
  const fields = children(children(new X509Certificate(cert).raw)[0] as Buffer);
  return fields[(fields[0] as Buffer)[0] === 0xa0 ? 5 : 4] as Buffer;
}

interface Issue {
  subject: Buffer;
  /** The issuer Name as DER; the subject itself for a self-signed certificate. */
  issuer: Buffer;
  publicKey: KeyObject;
  signingKey: KeyObject;
  extensions: Buffer[];
  days: number;
  now: Date;
}

/** Sign and PEM-encode a v3 certificate. Node has no X.509 writer, so this encodes the DER itself. */
function issueCertificate(i: Issue): string {
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serialNumber(randomBytes(16))),
    ECDSA_SHA256,
    i.issuer,
    seq(
      time(new Date(i.now.getTime() - BACKDATE_MS)),
      time(new Date(i.now.getTime() + i.days * 86_400_000)),
    ),
    i.subject,
    i.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(...i.extensions)),
  );
  return pem(
    'CERTIFICATE',
    seq(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), sign('sha256', tbs, i.signingKey))),
  );
}

/** A fresh P-256 key pair, a self-signed `Issue` for it, and the result of issuing that. */
function selfIssued(
  commonName: string,
  days: number,
  now: Date,
  extensions: (publicKey: KeyObject) => Buffer[],
): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const subject = name(commonName);
  const cert = issueCertificate({
    subject,
    issuer: subject,
    publicKey,
    signingKey: privateKey,
    days,
    now,
    extensions: extensions(publicKey),
  });
  return { cert, key: pkcs8(privateKey) };
}

/**
 * A P-256 certificate authority: a self-signed certificate that may only sign end-entity
 * certificates (`CA:TRUE, pathlen:0`, keyUsage `keyCertSign, cRLSign`, an SKI) and carries no SANs.
 */
export function caCertificate(commonName: string, days: number, now: Date = new Date()): KeyPair {
  return selfIssued(commonName, days, now, (publicKey) => [
    extension('2.5.29.19', seq(BOOLEAN_TRUE, der(0x02, Buffer.from([0]))), true),
    keyUsage(5, 6),
    subjectKeyId(publicKey),
  ]);
}

/**
 * A self-signed P-256 certificate for `commonName` that is its own trust anchor, with the SANs
 * given. Like `openssl req -x509` it marks itself `CA:TRUE`. The controller uses `caCertificate`
 * plus `leafCertificate`; this stays for fixtures and the single-certificate layout older
 * clusters hold.
 */
export function selfSignedCertificate(
  commonName: string,
  dnsNames: string[],
  ipAddresses: string[],
  days: number,
  now: Date = new Date(),
): KeyPair {
  return selfIssued(commonName, days, now, () => [
    extension('2.5.29.19', seq(BOOLEAN_TRUE), true),
    subjectAltName(dnsNames, ipAddresses),
  ]);
}

/**
 * A P-256 end-entity (`CA:FALSE`) server certificate for `commonName`, the DNS names and IPv4
 * addresses given, signed by `caKey`. Its issuer is the subject of `caCert`, so OpenSSL-based
 * clients do not mistake it for self-signed, and its AKI matches the CA's SKI.
 */
export function leafCertificate(
  commonName: string,
  dnsNames: string[],
  ipAddresses: string[],
  days: number,
  caCert: string,
  caKey: string,
  now: Date = new Date(),
): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cert = issueCertificate({
    subject: name(commonName),
    issuer: subjectDer(caCert),
    publicKey,
    signingKey: createPrivateKey(caKey),
    days,
    now,
    extensions: [
      extension('2.5.29.19', seq(), true),
      keyUsage(0),
      extension('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))),
      subjectAltName(dnsNames, ipAddresses),
      subjectKeyId(publicKey),
      authorityKeyId(new X509Certificate(caCert).publicKey),
    ],
  });
  return { cert, key: pkcs8(privateKey) };
}

/** `check` on the parsed certificates; false when anything is unreadable. */
function parsed(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

/** True when `key` (PEM) is the private key of the CA certificate `ca` (PEM). */
export function holdsCaKey(ca: string, key: string): boolean {
  return parsed(() => {
    const caX = new X509Certificate(ca);
    return caX.ca && caX.checkPrivateKey(createPrivateKey(key));
  });
}

/**
 * True when `leaf` is an end-entity certificate that `ca` issued and signed, and `leafKey` is its
 * private key.
 */
export function issuedBy(ca: string, leaf: string, leafKey: string): boolean {
  return parsed(() => {
    const caX = new X509Certificate(ca);
    const leafX = new X509Certificate(leaf);
    return (
      caX.ca &&
      !leafX.ca &&
      leafX.checkIssued(caX) &&
      leafX.verify(caX.publicKey) &&
      leafX.checkPrivateKey(createPrivateKey(leafKey))
    );
  });
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
