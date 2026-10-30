import type { LiveTenant, TenantLister } from './tenancy/removal';

/** The installation's Tenants, listed at most once however often it is called. */
export type TenantSnapshot = () => Promise<LiveTenant[]>;

export interface TenantListRetry {
  /** Injected for tests; waits between attempts of a transient list failure. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; the clock the retry budget is measured with. */
  now?: () => number;
}

/** Waits before the 2nd, 3rd and 4th attempt to list the Tenants (#245): 3.5 s in all. */
export const TENANT_LIST_RETRY_DELAYS_MS = [500, 1000, 2000] as const;
/**
 * No retry starts once this much time has passed since the first attempt, so slow failures
 * (an undici connect timeout is 10 s) cannot stretch `up` by four full attempts.
 */
export const TENANT_LIST_RETRY_BUDGET_MS = 15_000;

/**
 * Transport failures a retry can clear, as Node (`cause.code` under undici's `fetch failed`)
 * and Bun report them. Header and body timeouts (`UND_ERR_HEADERS_TIMEOUT`,
 * `UND_ERR_BODY_TIMEOUT`) are left out: each already waited minutes.
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  // undici: the socket closed or failed mid-request, the connect timed out, the client closed.
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_CLOSED',
  // Bun's fetch.
  'ConnectionRefused',
  'ConnectionReset',
  'ConnectionClosed',
  'FailedToOpenSocket',
]);

/** HTTP 429 or 5xx, or a connection error that a retry can clear. */
export function isTransientListError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (typeof code === 'number') return code === 429 || code >= 500;
  const causeCode = (cause as { code?: unknown } | null | undefined)?.code;
  const name = typeof code === 'string' ? code : causeCode;
  return typeof name === 'string' && TRANSIENT_CODES.has(name);
}

/** The default wait between attempts. */
export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lists the Tenants, retrying transient failures a few times with a short backoff (#245), never
 * starting a retry past `TENANT_LIST_RETRY_BUDGET_MS`.
 */
async function listWithRetry(
  list: TenantLister,
  installation: string,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<LiveTenant[]> {
  const started = now();
  for (const delay of TENANT_LIST_RETRY_DELAYS_MS) {
    try {
      return await list(installation);
    } catch (error) {
      if (!isTransientListError(error)) throw error;
      if (now() - started + delay > TENANT_LIST_RETRY_BUDGET_MS) throw error;
      await sleep(delay);
    }
  }
  return list(installation);
}

/**
 * One Tenant list per run (#245): the first call lists the installation's Tenants, retrying
 * transient failures, and every call returns that same promise, a failure included. The #228
 * Retain check reads it; since #541 m6e the chart's operator watches no tenant namespace, so
 * nothing else does.
 */
export function sharedTenantList(
  list: TenantLister,
  installation: string,
  retry: TenantListRetry = {},
): TenantSnapshot {
  let listed: Promise<LiveTenant[]> | undefined;
  return () => {
    listed ??= listWithRetry(list, installation, retry.sleep ?? realSleep, retry.now ?? Date.now);
    return listed;
  };
}
