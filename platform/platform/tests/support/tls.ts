import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caConstraints, caPermittedDns, certificateNames } from '../../src/tenancy/tls';

/**
 * The OpenSSL binary the tests run, by absolute path rather than through `PATH`: OpenSSL 3 on the
 * CI runners (Ubuntu), LibreSSL on macOS. Both apply X.509 name constraints.
 */
export const OPENSSL = '/usr/bin/openssl';

/** Generates a throwaway self-signed certificate for a fake Kubernetes API server. */
export function selfSignedCert(): { key: string; cert: string; keyPath: string; certPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-api-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    OPENSSL,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
    ].concat(['-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath]),
    { stdio: 'ignore' },
  );
  return {
    key: readFileSync(keyPath, 'utf8'),
    cert: readFileSync(certPath, 'utf8'),
    keyPath,
    certPath,
  };
}

/** Extended key usage OID for TLS server authentication. */
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g;

/**
 * True when every DNS name `leaf` (PEM) carries lies within the permitted DNS subtrees of
 * `anchor`'s name constraints, and it names no IP address when those exclude them all (#381), or
 * `anchor` has none (#365). `node:crypto` does not apply name
 * constraints (`X509Certificate.verify` checks only the signature, `checkIssued` only the issuer
 * link), so the helper checks them itself, matching names on its own rather than with the
 * production matcher; {@link opensslVerifies} checks the same paths with OpenSSL.
 */
export function withinNameConstraints(leaf: string, anchor: string): boolean {
  const permitted = caPermittedDns(anchor)?.map((base) => base.toLowerCase());
  const under = (dns: string, base: string) => dns === base || dns.endsWith(`.${base}`);
  const names = certificateNames(leaf);
  return (
    !permitted ||
    ((names?.dns ?? []).every((dns) => permitted.some((base) => under(dns.toLowerCase(), base))) &&
      // An anchor that excludes every IP address admits no leaf naming one (#381).
      !(caConstraints(anchor)?.excludesIps && names?.ips.length))
  );
}

/**
 * True when `openssl verify` accepts `leaf` (PEM) as a TLS server certificate, strictly
 * (`-x509_strict`), against the PEM trust bundle `bundle` at time `at`. OpenSSL applies name
 * constraints itself, so this is an oracle independent of this repository's X.509 code. LibreSSL
 * has no `-verify_hostname`; {@link verifiesAt} checks the host name. With `purpose` `sslclient`
 * it checks a TLS client certificate instead (#541).
 */
export function opensslVerifies(
  leaf: string,
  bundle: string,
  at: Date,
  purpose: 'sslserver' | 'sslclient' = 'sslserver',
): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'ca-verify-'));
  try {
    writeFileSync(join(dir, 'leaf.pem'), leaf);
    writeFileSync(join(dir, 'bundle.pem'), bundle);
    const result = spawnSync(OPENSSL, [
      'verify',
      '-x509_strict',
      '-purpose',
      purpose,
      '-attime',
      String(Math.floor(at.getTime() / 1000)),
      '-CAfile',
      join(dir, 'bundle.pem'),
      join(dir, 'leaf.pem'),
    ]);
    if (result.error) throw result.error;
    return result.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True when `cert` is within its validity period at `at`. */
const validAt = (cert: X509Certificate, at: Date) =>
  new Date(cert.validFrom).getTime() <= at.getTime() &&
  at.getTime() <= new Date(cert.validTo).getTime();

/**
 * True when `leaf` (PEM) verifies as a TLS server certificate for `localhost` against the PEM
 * trust bundle `bundle`, at time `at`, the way a client's path validation does (#170):
 *
 * - the leaf is an end entity, valid at `at`, for server authentication, and names `localhost`;
 * - some bundle certificate is a self-signed CA, valid at `at`, that issued the leaf (subject,
 *   key identifiers and key usage, per `checkIssued`), whose key verifies the leaf's signature
 *   and whose name constraints permit every DNS name of the leaf ({@link withinNameConstraints},
 *   checked here because `node:crypto` does not).
 *
 * Any certificate in `bundle` that does not parse throws, so a broken bundle fails the test.
 */
export function verifiesAt(leaf: string, bundle: string, at: Date): boolean {
  const certificate = new X509Certificate(leaf);
  const anchors = (bundle.match(PEM_CERTIFICATE) ?? []).map((pem) => new X509Certificate(pem));
  if (anchors.length === 0) throw new Error('the trust bundle holds no certificate');
  return (
    !certificate.ca &&
    validAt(certificate, at) &&
    (certificate.keyUsage ?? []).includes(SERVER_AUTH) &&
    certificate.checkHost('localhost') === 'localhost' &&
    anchors.some(
      (anchor) =>
        anchor.ca &&
        validAt(anchor, at) &&
        anchor.checkIssued(anchor) &&
        anchor.verify(anchor.publicKey) &&
        certificate.checkIssued(anchor) &&
        certificate.verify(anchor.publicKey) &&
        withinNameConstraints(leaf, anchor.toString()),
    )
  );
}

/**
 * A TLS client certificate that `ca` (PEM certificate and key) signs with the OpenSSL CLI, naming
 * exactly `subjectAltName` (OpenSSL syntax, for example `email:a@b` or `URI:https://b`). It stands
 * for a certificate issued outside this repository's X.509 code, such as by a bug or a stolen CA
 * key, so the name constraints of `ca` are checked against forms the platform never issues (#541).
 */
export function opensslClientLeaf(
  ca: { cert: string; key: string },
  subjectAltName: string,
): string {
  return opensslClientPair(ca, subjectAltName).cert;
}

/** {@link opensslClientLeaf} with its private key, for a client that presents it (#541 m2). */
export function opensslClientPair(
  ca: { cert: string; key: string },
  subjectAltName: string,
): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ca-forge-'));
  try {
    const at = (name: string) => join(dir, name);
    writeFileSync(at('ca.pem'), ca.cert);
    writeFileSync(at('ca.key'), ca.key);
    writeFileSync(
      at('ext.cnf'),
      [
        '[v3]',
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature',
        'extendedKeyUsage=clientAuth',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid',
        `subjectAltName=${subjectAltName}`,
        '',
      ].join('\n'),
    );
    const run = (...args: string[]) => execFileSync(OPENSSL, args, { stdio: 'ignore' });
    run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', at('leaf.key'));
    run('req', '-new', '-key', at('leaf.key'), '-subj', '/CN=forged', '-out', at('leaf.csr'));
    run(
      'x509',
      '-req',
      '-in',
      at('leaf.csr'),
      '-CA',
      at('ca.pem'),
      '-CAkey',
      at('ca.key'),
      '-sha256',
      '-set_serial',
      '4660',
      '-days',
      '2',
      '-extfile',
      at('ext.cnf'),
      '-extensions',
      'v3',
      '-out',
      at('leaf.pem'),
    );
    return {
      cert: readFileSync(at('leaf.pem'), 'utf8'),
      key: readFileSync(at('leaf.key'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
