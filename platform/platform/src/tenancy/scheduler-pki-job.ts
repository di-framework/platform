/**
 * The `scheduler-pki` entry point (#541, O4): the one-shot bootstrap Job runs this with the
 * controller's image. It ships only the modules in `SCHEDULER_PKI_MODULES`, so it carries its own
 * small Kubernetes client instead of the controller's. It prints only the names of the objects it
 * wrote, and no API response body reaches an error or the log, since a body may hold Secret data.
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { bootstrapSchedulerPki, type PkiApi, schedulerPkiConfig } from './scheduler-pki';

/** A Kubernetes API error: the method, path and status only. */
export class PkiApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The in-cluster Kubernetes API, as the pod's projected ServiceAccount token reaches it. */
export class InClusterApi implements PkiApi {
  private readonly directory = '/var/run/secrets/kubernetes.io/serviceaccount';
  call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const route = `${method} ${path.split('?')[0]}`;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: process.env.KUBERNETES_SERVICE_HOST,
          port: process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443',
          path,
          method,
          // Fixed Kubernetes-mounted paths: the cluster CA and the projected token.
          ca: readFileSync(`${this.directory}/ca.crt`),
          headers: {
            Authorization: `Bearer ${readFileSync(`${this.directory}/token`, 'utf8').trim()}`,
            'Content-Type': 'application/json',
            ...(data === undefined ? {} : { 'Content-Length': Buffer.byteLength(data) }),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('error', reject);
          res.on('end', () => {
            const status = res.statusCode ?? 500;
            if (status >= 300)
              return reject(new PkiApiError(status, `${route} returned ${status}`));
            try {
              resolve(text ? (JSON.parse(text) as T) : (undefined as T));
            } catch {
              // JSON.parse quotes the text it fails on, so its message is not passed on.
              reject(new Error(`${route} returned a body that is not JSON`));
            }
          });
        },
      );
      req.setTimeout(15_000, () => req.destroy(new Error('Kubernetes API request timed out')));
      req.on('error', reject);
      req.end(data);
    });
  }
}

export async function main(
  api: PkiApi = new InClusterApi(),
  config: string | undefined = process.env.SCHEDULER_PKI_CONFIG,
  print: (line: string) => void = console.log,
): Promise<void> {
  const written = await bootstrapSchedulerPki(api, schedulerPkiConfig(config));
  for (const name of written) print(`wrote ${name}`);
  print(`scheduler PKI ready (${written.length} written)`);
}

/** Reports a failed run: its message only, and exit code 1, so the Job retries. */
export function reportFailure(
  error: Error,
  status: { exitCode?: string | number | null } = process,
  print: (line: string) => void = console.error,
): void {
  print(error.message);
  status.exitCode = 1;
}

if (require.main === module) main().catch((error: Error) => reportFailure(error));
