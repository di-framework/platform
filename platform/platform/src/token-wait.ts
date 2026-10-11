/** Reads one Secret; resolves with its `data` map or rejects with the transport/API error. */
export type SecretDataReader = (
  namespace: string,
  name: string,
) => Promise<Record<string, string> | undefined>;

export interface TokenWaitOptions {
  namespace: string;
  name: string;
  readSecret: SecretDataReader;
  /** Wall-clock budget for the whole wait. Default 5 minutes. */
  timeoutMs?: number;
  /** Budget for one read, so a hung connection cannot stretch the wait. Default 10 seconds. */
  requestTimeoutMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. */
  now?: () => number;
}

export const DEFAULT_TOKEN_WAIT_TIMEOUT_MS = 300_000;
export const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 10_000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff: 1 s, doubling every 10 attempts, capped at 10 s. */
export function tokenWaitDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.floor(attempt / 10), 10_000);
}

/**
 * Names an error without including anything the server or a Secret body said: the HTTP status
 * when there is one, else the system error code, else the error class name.
 */
export function describeReadError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const { code, cause, name } = error as { code?: unknown; cause?: unknown; name?: unknown };
  if (typeof code === 'number') return `HTTP ${code}`;
  if (typeof code === 'string') return code;
  const causeCode = (cause as { code?: unknown } | null | undefined)?.code;
  if (typeof causeCode === 'string') return causeCode;
  return typeof name === 'string' && name !== '' ? name : 'unknown error';
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 404;
}

class RequestTimeout extends Error {
  override name = 'RequestTimeout';
}

async function readWithTimeout(
  options: TokenWaitOptions,
  requestTimeoutMs: number,
): Promise<Record<string, string> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestTimeout('request timed out')), requestTimeoutMs);
  });
  try {
    return await Promise.race([options.readSecret(options.namespace, options.name), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves once the Secret exists with a non-empty `data.token`. A missing Secret, a Secret
 * without a token and every read failure (HTTP status, auth, TLS, connection) are retried until
 * the deadline; the final error names `namespace/name` and the last observation, never a
 * response body.
 */
export async function waitForTokenSecret(options: TokenWaitOptions): Promise<void> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOKEN_WAIT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TOKEN_REQUEST_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  let last = 'not read';

  for (let attempt = 0; ; attempt++) {
    try {
      const data = await readWithTimeout(options, requestTimeoutMs); // NOSONAR: sequential polling
      if (data?.token) return;
      last = 'Secret exists without data.token';
    } catch (error) {
      last = isNotFound(error) ? 'Secret not found (HTTP 404)' : describeReadError(error);
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(tokenWaitDelayMs(attempt), remaining)); // NOSONAR: polls are sequential by design
  }

  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for Secret ${options.namespace}/${options.name} to have data.token (last observation: ${last})`,
  );
}
