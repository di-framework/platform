import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Generates a throwaway self-signed certificate for a fake Kubernetes API server. */
export function selfSignedCert(): { key: string; cert: string; keyPath: string; certPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-api-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    '/usr/bin/openssl',
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
 *   key identifiers and key usage, per `checkIssued`) and whose key verifies the leaf's signature.
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
        certificate.verify(anchor.publicKey),
    )
  );
}
