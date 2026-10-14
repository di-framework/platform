import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { CliError, type Credential } from './credentials.ts';

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Reads `--ca-file`: one or more PEM certificates, such as the tenant's `tenant-controller-ca`.
 * Returns them base64-encoded, the form `controller.certificateAuthorityData` takes in the
 * credential store (the console writes the same field).
 */
export function readCaFile(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CliError(`--ca-file ${path}: ${(error as Error).message}`);
  }
  const certificates = text.match(PEM_CERTIFICATE);
  if (!certificates) throw new CliError(`--ca-file ${path} holds no PEM certificate`);
  return Buffer.from(`${certificates.join('\n')}\n`).toString('base64');
}

/** The PEM of the CA stored with the credential, if any. */
export function caPem(controller: Credential['controller']): string | undefined {
  const data = controller.certificateAuthorityData;
  return data ? Buffer.from(data, 'base64').toString('utf8') : undefined;
}

/**
 * A `fetch` that also trusts `pem` (on top of the bundled public roots) for TLS. Without a CA it
 * is the given `fetch` unchanged, so `NODE_EXTRA_CA_CERTS` keeps working as before.
 */
export function trusting(
  base: typeof fetch | undefined,
  pem: string | undefined,
): typeof fetch | undefined {
  if (!pem) return base;
  const doFetch = base ?? fetch;
  const ca = [...rootCertificates, pem];
  const wrapped = (input: string | URL | Request, init?: RequestInit) =>
    doFetch(input, { ...init, tls: { ...(init as { tls?: object } | undefined)?.tls, ca } });
  return wrapped as typeof fetch;
}
