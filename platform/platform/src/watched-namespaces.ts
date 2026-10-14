import type { LiveTenant, TenantLister } from './tenancy/removal';
import { names } from './tenancy/resources';
import { describeReadError } from './token-wait';

export interface HostNamespacesArgs {
  /** The platform namespace; always watched, first. */
  platformNamespace: string;
  /** The installation whose Tenants are listed. */
  installation: string;
  /** Tenant names in the stack config. */
  declared: string[];
  /**
   * `pulumi.runtime.isDryRun()`. A preview uses the Tenant list on a best-effort basis: if it
   * cannot be read, the preview shows the declared tenants only, with a warning.
   */
  dryRun: boolean;
  /** This run's shared Tenant list (`sharedTenantList`) on the admin kubeconfig; absent without one. */
  tenants?: TenantSnapshot;
  log: { info(message: string): void; warn(message: string): void };
}

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

/**
 * @kubernetes/client-node raises kubeconfig problems as plain `Error`s. These messages are fixed
 * text (or name only a list index), so they are safe to repeat; any other message may quote the
 * kubeconfig and is never shown.
 */
const SAFE_KUBECONFIG_MESSAGES = [
  /^HTTP protocol is not allowed when skipTLSVerify is not set or false$/,
  /^No active cluster!$/,
  /^Unsupported proxy type$/,
  /^(clusters|users|contexts)\[\d+\]\.[a-z.]+ is missing$/,
];

/**
 * `describeReadError` (HTTP status, error code or class), plus what to check when the error has
 * no status or code (#245): the kubeconfig could not be used, which client-node reports as a
 * plain `Error`. A known client-node message is quoted; nothing else the error says is.
 */
export function describeListError(error: unknown): string {
  const described = describeReadError(error);
  const { code, cause } = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    cause?: unknown;
  };
  if (code !== undefined || (cause as { code?: unknown } | null | undefined)?.code !== undefined)
    return described;
  const message = error instanceof Error ? error.message : '';
  const known = SAFE_KUBECONFIG_MESSAGES.some((pattern) => pattern.test(message));
  return known
    ? `${described}: ${message} (check the kubeconfig)`
    : `${described} (no HTTP status or error code; check the kubeconfig's server URL, TLS settings and credentials)`;
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
 * transient failures, and every call returns that same promise. The watched-namespaces
 * computation and the #228 Retain check share it, so they decide from one snapshot with one
 * request. A failure is shared too; each caller handles it as before.
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

/**
 * The wasmCloud operator's `hostNamespaces` (#227): the platform namespace plus the runtime
 * namespace of every tenant that is declared or whose Tenant object still exists in the cluster.
 *
 * Pulumi applies the Helm update before it deletes a Tenant that left the config, so the update
 * must not stop the operator watching that tenant's runtime namespace: the operator removes its
 * host pods' finalizers there while the controller drains the tenant. The Tenant object exists
 * only until that drain is done, under both deletion policies (`Delete` removes the namespaces
 * first; `Retain` scales the hosts to zero and keeps the namespaces), so the next `up` stops
 * watching the namespace. A retained namespace is never watched on its own account. Transient
 * list failures are retried briefly (#245); on `up`, other failures, except a missing Tenant
 * CRD, fail the update. A preview reads the same list, so its diff matches the `up` (#245); when
 * the list cannot be read there, it shows the declared tenants only, with a warning.
 */
export async function operatorHostNamespaces(args: HostNamespacesArgs): Promise<string[]> {
  const runtime = (tenant: string) => names(tenant).runtimeNamespace;
  const declaredNamespaces = [args.platformNamespace, ...args.declared.map(runtime)];
  if (!args.tenants) {
    args.log.warn(
      "Without the admin kubeconfig, the wasmCloud operator's hostNamespaces list the declared tenants only, so removing a tenant can strand its host pods' finalizers (#227). Pass kubeconfig to createPlatform.",
    );
    return declaredNamespaces;
  }
  let live: string[];
  try {
    live = (await args.tenants()).map((t) => t.metadata.name);
  } catch (error) {
    // No Tenant CRD yet (a first install): no Tenants. The messages below never carry a
    // response body or the kubeconfig.
    if ((error as { code?: unknown } | null)?.code === 404) live = [];
    else if (args.dryRun) {
      // Best effort: the up lists again and fails if the list still cannot be read.
      args.log.warn(
        `Preview cannot list the Tenants of installation ${args.installation}, so it shows the wasmCloud operator's hostNamespaces for the declared tenants only; up lists them again and keeps a removed tenant's runtime namespace watched until its Tenant is deleted (#227): ${describeListError(error)}`,
      );
      return declaredNamespaces;
    }
    // On up, anything else fails the update rather than shrinking the list.
    else
      throw new Error(
        `Cannot list the Tenants of installation ${args.installation}, which keep a removed tenant's runtime namespace watched by the wasmCloud operator until the Tenant is deleted (#227): ${describeListError(error)}`,
      );
  }
  const declared = new Set(args.declared);
  const draining = [...new Set(live)]
    .filter((t) => !declared.has(t))
    .sort((a, b) => a.localeCompare(b));
  for (const tenant of draining)
    args.log.info(
      `Tenant ${tenant} is no longer declared but still exists, so ${runtime(tenant)} stays in the wasmCloud operator's hostNamespaces while the Tenant is deleted; it stops being watched on the next up, after the Tenant is gone (#227).`,
    );
  return [...declaredNamespaces, ...draining.map(runtime)];
}
