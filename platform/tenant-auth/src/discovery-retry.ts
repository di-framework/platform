/**
 * Background OIDC issuer discovery shared by the controller (#225) and the console (#489): one
 * attempt at a time, a wait that doubles from `initialMs` up to `maxMs`, and no retry budget,
 * since the issuer may come up at any time and the process has to recover without a restart.
 */
import { discover, type ProviderMetadata } from './oidc.ts';

/** Wait between issuer discovery attempts; doubles from `initialMs` up to `maxMs`. */
export interface DiscoveryBackoff {
  initialMs: number;
  maxMs: number;
}

export const DISCOVERY_BACKOFF_DEFAULT: DiscoveryBackoff = { initialMs: 1_000, maxMs: 30_000 };

/** Pending until the issuer answers; `retryAfterSeconds` is the wait until the next attempt. */
export type DiscoveryState =
  | { status: 'pending'; retryAfterSeconds: number }
  | { status: 'complete'; provider: ProviderMetadata };

/** Resolves after `ms`, or early once `signal` aborts. */
export type DiscoverySleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface BackgroundDiscoveryOptions {
  issuer: string;
  backoff?: DiscoveryBackoff;
  /** Writes one audit line (`discovery.failed`, `discovery.succeeded`). */
  audit: (event: string, fields: Record<string, unknown>) => void;
  /** Runs once the issuer has answered, before `discovery.succeeded` is logged. */
  onDiscovered?: (provider: ProviderMetadata) => void;
  /** One discovery attempt; only overridden by tests. */
  discover?: (issuer: string, attempts: number, signal: AbortSignal) => Promise<ProviderMetadata>;
  /** The wait between attempts; only overridden by tests. */
  sleep?: DiscoverySleep;
}

export const sleepUnlessAborted: DiscoverySleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

export class BackgroundDiscovery {
  private current: DiscoveryState;
  private readonly abort = new AbortController();
  private readonly markDiscovered: () => void;
  /** Resolves once the issuer has been discovered (or discovery was stopped). */
  readonly discovered: Promise<void>;

  constructor(
    private readonly options: BackgroundDiscoveryOptions,
    provider: ProviderMetadata | null = null,
  ) {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.discovered = promise;
    this.markDiscovered = resolve;
    this.current = provider
      ? { status: 'complete', provider }
      : { status: 'pending', retryAfterSeconds: 1 };
    if (provider) resolve();
  }

  get state(): DiscoveryState {
    return this.current;
  }

  /** Provider metadata; null until discovery completes. */
  get provider(): ProviderMetadata | null {
    return this.current.status === 'complete' ? this.current.provider : null;
  }

  /** Stops discovery: aborts an in-flight attempt and wakes the retry sleep. */
  stop(): void {
    this.abort.abort();
    this.markDiscovered();
  }

  /** Attempts discovery until it succeeds or {@link stop} is called. */
  async run(): Promise<void> {
    const { issuer, audit } = this.options;
    const { initialMs, maxMs } = this.options.backoff ?? DISCOVERY_BACKOFF_DEFAULT;
    const attempt = this.options.discover ?? discover;
    const sleep = this.options.sleep ?? sleepUnlessAborted;
    const signal = this.abort.signal;
    for (let n = 0; !signal.aborted; n++) {
      try {
        const provider = await attempt(issuer, 1, signal);
        this.current = { status: 'complete', provider };
        this.options.onDiscovered?.(provider);
        audit('discovery.succeeded', { issuer });
        this.markDiscovered();
        return;
      } catch (error) {
        if (signal.aborted) return;
        const delayMs = Math.min(maxMs, initialMs * 2 ** n);
        this.current = {
          status: 'pending',
          retryAfterSeconds: Math.max(1, Math.ceil(delayMs / 1000)),
        };
        audit('discovery.failed', {
          error: (error as Error).message,
          issuer,
          retryInMs: delayMs,
        });
        await sleep(delayMs, signal);
      }
    }
  }
}
