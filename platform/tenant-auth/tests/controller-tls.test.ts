import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfSignedCertificate } from '../../platform/src/tenancy/tls.ts';
import { ensureControllerTls } from '../scripts/controller-tls.ts';

const NAMESPACE = 'di-runtime-acme';
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenant-auth-tls-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const read = (path: string) => readFileSync(path, 'utf8');

describe('deploy-local controller TLS', () => {
  test('issues a CA and a CA:FALSE leaf that the CA signed', () => {
    const files = ensureControllerTls(tempDir(), NAMESPACE);
    const ca = new X509Certificate(read(files.caCrt));
    const leaf = new X509Certificate(read(files.crt));
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.issuer).toBe(ca.subject);
    expect(leaf.subject).not.toBe(leaf.issuer);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.subjectAltName).toBe(
      `DNS:tenant-controller, DNS:tenant-controller.${NAMESPACE}.svc, DNS:localhost, IP Address:127.0.0.1`,
    );
    // The same chain check a TLS client makes: the leaf verifies against the CA as trust anchor.
    const verified = execFileSync('openssl', ['verify', '-CAfile', files.caCrt, files.crt]);
    expect(verified.toString()).toContain(': OK');
    expect(statSync(files.caKey).mode & 0o077).toBe(0);
  });

  test('keeps a valid pair across runs', () => {
    const dir = tempDir();
    const first = ensureControllerTls(dir, NAMESPACE);
    const before = [read(first.caCrt), read(first.caKey), read(first.crt), read(first.key)];
    const second = ensureControllerTls(dir, NAMESPACE);
    expect([read(second.caCrt), read(second.caKey), read(second.crt), read(second.key)]).toEqual(
      before,
    );
  });

  test('replaces the single CA:TRUE certificate of older runs', () => {
    const dir = tempDir();
    const old = selfSignedCertificate(`tenant-controller.${NAMESPACE}.svc`, ['localhost'], [], 30);
    writeFileSync(join(dir, 'tls.crt'), old.cert);
    writeFileSync(join(dir, 'tls.key'), old.key);
    const files = ensureControllerTls(dir, NAMESPACE);
    expect(read(files.crt)).not.toBe(old.cert);
    expect(new X509Certificate(read(files.crt)).ca).toBe(false);
    expect(
      new X509Certificate(read(files.crt)).checkIssued(new X509Certificate(read(files.caCrt))),
    ).toBe(true);
  });

  test('renews an expiring leaf under the same CA', () => {
    const dir = tempDir();
    const now = new Date();
    const first = ensureControllerTls(dir, NAMESPACE, now);
    const ca = read(first.caCrt);
    const leaf = read(first.crt);
    // 340 days on, the 365-day leaf is inside its 30-day renewal window; the CA is not.
    const later = new Date(now.getTime() + 340 * 86_400_000);
    const renewed = ensureControllerTls(dir, NAMESPACE, later);
    expect(read(renewed.caCrt)).toBe(ca);
    expect(read(renewed.crt)).not.toBe(leaf);
    expect(new X509Certificate(read(renewed.crt)).checkIssued(new X509Certificate(ca))).toBe(true);
  });
});
