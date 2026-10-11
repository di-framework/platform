import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Generates a throwaway self-signed certificate for a fake Kubernetes API server. */
export function selfSignedCert(): { key: string; cert: string; keyPath: string; certPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-api-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
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
