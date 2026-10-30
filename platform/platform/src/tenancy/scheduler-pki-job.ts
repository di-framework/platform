/**
 * The `scheduler-pki` entry point (#541, O4): the one-shot bootstrap Job runs this with the
 * controller's image. It ships only the modules in `SCHEDULER_PKI_MODULES`, so it carries its own
 * small Kubernetes client instead of the controller's. It prints only the names of the objects it
 * wrote, and no API response body reaches an error or the log, since a body may hold Secret data.
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { bootstrapSchedulerAccounts } from './scheduler-nats';
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
      req.setTimeout(15_000, () =>
        req.destroy(
          Object.assign(new Error('Kubernetes API request timed out'), { code: 'ETIMEDOUT' }),
        ),
      );
      req.on('error', reject);
      req.end(data);
    });
  }
}

/**
 * Connection errors a retry can clear (#583), the Node subset of the controller's #245 list in
 * `watched-namespaces.ts`, which this Job cannot import: it ships only `SCHEDULER_PKI_MODULES`.
 * A new pod's first connections can be refused while the network policy agent admits its IP.
 */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
]);

/** The error class a retry can clear: a connection code, or HTTP 429 or 5xx as in #245. */
export function transientClass(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number') return code === 429 || code >= 500 ? `HTTP ${code}` : undefined;
  return typeof code === 'string' && TRANSIENT_CODES.has(code) ? code : undefined;
}

/** The first retry waits this long; each later one doubles, up to `PKI_RETRY_MAX_DELAY_MS`. */
export const PKI_RETRY_FIRST_DELAY_MS = 250;
export const PKI_RETRY_MAX_DELAY_MS = 5_000;
/** No retry starts once this much time has passed since a call's first attempt. */
export const PKI_RETRY_BUDGET_MS = 120_000;

/**
 * Retries each call on a transient error (#583). Every other error, such as 403, 404 or 409,
 * passes on at once, so create-if-missing stays as it is: a create retried after an ambiguous
 * failure that did land gets 409, which fails this pod; the next Job pod reads and keeps what is
 * there. Each retry logs one line: method, path without query, error class, attempt and wait.
 */
export class RetryingApi implements PkiApi {
  constructor(
    private readonly api: PkiApi,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = console.log,
  ) {}
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const started = this.now();
    const route = `${method} ${path.split('?')[0]}`;
    let delay = PKI_RETRY_FIRST_DELAY_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.api.call<T>(method, path, body);
      } catch (error) {
        const kind = transientClass(error);
        if (kind === undefined) throw error;
        if (this.now() - started + delay > PKI_RETRY_BUDGET_MS)
          throw new Error(
            `${route} still failing with ${kind} after ${Math.round((this.now() - started) / 1000)} s of retries`,
          );
        this.log(`retrying ${route} after ${kind} (attempt ${attempt}) in ${delay} ms`);
        await this.sleep(delay);
        delay = Math.min(delay * 2, PKI_RETRY_MAX_DELAY_MS);
      }
    }
  }
}

export async function main(
  api: PkiApi = new RetryingApi(new InClusterApi()),
  config: string | undefined = process.env.SCHEDULER_PKI_CONFIG,
  print: (line: string) => void = console.log,
): Promise<void> {
  const settings = schedulerPkiConfig(config);
  const written = await bootstrapSchedulerPki(api, settings);
  // The accounts file last: it is rendered from the record the PKI step completed.
  written.push(...(await bootstrapSchedulerAccounts(api, settings)));
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
