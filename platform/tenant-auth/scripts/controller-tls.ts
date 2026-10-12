import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  caCertificate,
  certificateNames,
  certificateValid,
  holdsCaKey,
  issuedBy,
  leafCertificate,
} from '../../platform/src/tenancy/tls.ts';

/** Lifetimes the platform controller uses for the same pair (`controllerTls`). */
const CA_DAYS = 3650;
const CA_RENEW_DAYS = 90;
const LEAF_DAYS = 365;
const LEAF_RENEW_DAYS = 30;

/** Paths of the controller's TLS files in `dir`. */
export interface ControllerTlsFiles {
  /** The CA certificate: the console and kubeconfigs pin it. */
  caCrt: string;
  /** The CA key; only this script uses it, to sign the leaf. */
  caKey: string;
  /** The leaf the controller serves (`CA:FALSE`, signed by the CA). */
  crt: string;
  key: string;
}

/**
 * Ensures `dir` holds a CA and a CA-signed leaf for the tenant controller in `namespace`, the
 * layout the platform controller uses (#163), and returns their paths. A single `CA:TRUE`
 * certificate served as its own trust anchor is rejected by rustls (`CaUsedAsEndEntity`, #148).
 *
 * Existing files are kept while they verify: the CA while it holds its key and is valid for 90
 * more days, the leaf while the CA issued it, its names match and it is valid for 30 more days.
 * A directory from before the split (a `tls.crt` and no `ca.crt`) gets a new CA and leaf.
 */
export function ensureControllerTls(
  dir: string,
  namespace: string,
  now: Date = new Date(),
): ControllerTlsFiles {
  // `mode` applies only when a path is created, so set it on an existing directory or file too.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const files: ControllerTlsFiles = {
    caCrt: join(dir, 'ca.crt'),
    caKey: join(dir, 'ca.key'),
    crt: join(dir, 'tls.crt'),
    key: join(dir, 'tls.key'),
  };
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  const write = (path: string, pem: string) => {
    writeFileSync(path, pem, { mode: 0o600 });
    chmodSync(path, 0o600);
  };

  let ca = { cert: read(files.caCrt), key: read(files.caKey) };
  const keepCa = holdsCaKey(ca.cert, ca.key) && certificateValid(ca.cert, CA_RENEW_DAYS, now);
  if (!keepCa) {
    ca = caCertificate(`tenant-controller CA (${namespace})`, CA_DAYS, now);
    write(files.caKey, ca.key);
    write(files.caCrt, ca.cert);
  }

  const names = {
    dns: ['tenant-controller', `tenant-controller.${namespace}.svc`, 'localhost'],
    ips: ['127.0.0.1'],
  };
  const cert = read(files.crt);
  const keepLeaf =
    keepCa &&
    issuedBy(ca.cert, cert, read(files.key)) &&
    certificateValid(cert, LEAF_RENEW_DAYS, now) &&
    JSON.stringify(certificateNames(cert)) === JSON.stringify(names);
  if (!keepLeaf) {
    const leaf = leafCertificate(
      `tenant-controller.${namespace}.svc`,
      names.dns,
      names.ips,
      LEAF_DAYS,
      ca.cert,
      ca.key,
      now,
    );
    write(files.key, leaf.key);
    write(files.crt, leaf.cert);
  }
  return files;
}

/** The pod template annotation that carries {@link controllerTlsDigest}. */
export const TLS_DIGEST_ANNOTATION = 'platform.di-framework.dev/tls-cert-sha256';

/**
 * Digest of the certificates the pods load at startup: the leaf the controller serves and the CA the
 * console pins. Both pod templates carry it, as the platform controller's `tls-cert-sha256` does,
 * so replacing the pair rolls the pods even when the bundle is unchanged.
 */
export function controllerTlsDigest(files: Pick<ControllerTlsFiles, 'caCrt' | 'crt'>): string {
  return createHash('sha256')
    .update(readFileSync(files.crt))
    .update(readFileSync(files.caCrt))
    .digest('hex');
}
