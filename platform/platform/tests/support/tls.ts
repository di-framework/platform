import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * True when OpenSSL verifies `leaf` (PEM) as a TLS server certificate for `localhost` against the
 * PEM trust bundle `bundle`, at time `at` (strict X.509 checks).
 */
export function verifiesAt(leaf: string, bundle: string, at: Date): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'verify-'));
  try {
    writeFileSync(join(dir, 'leaf.pem'), leaf);
    writeFileSync(join(dir, 'bundle.pem'), bundle);
    execFileSync(
      'openssl',
      [
        'verify',
        '-x509_strict',
        '-purpose',
        'sslserver',
        '-verify_hostname',
        'localhost',
        '-attime',
        String(Math.floor(at.getTime() / 1000)),
        '-CAfile',
        join(dir, 'bundle.pem'),
        join(dir, 'leaf.pem'),
      ],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
