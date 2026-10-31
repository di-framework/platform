/**
 * When a scheduler NATS user may first be presented (#541 m6e-E, design-541 §4.5).
 *
 * Nothing reports when NATS has loaded the accounts file (owner decision 1), so a user counts as
 * propagated once the written `di-scheduler-nats-accounts` has named it for
 * {@link TENANT_OPERATOR_PROPAGATION_MS}. Identity Secrets are mounted by name, so any pod that
 * starts reads whatever certificate its Secret holds: the controller writes a certificate into a
 * Secret only once its user has propagated. The clock is in memory and starts when this process
 * first sees the user named, never earlier than the write; a restarted controller waits once more.
 */
import { ACCOUNTS_KEY, accountsNamesUser, SCHEDULER_NATS_ACCOUNTS } from './scheduler-nats';
import { RENEWAL_OVERLAP_MS } from './scheduler-pki-rotation';
import { TENANT_OPERATOR_PROPAGATION_MS } from './tenant-operator';

/**
 * A wait for propagation longer than this is reported: the bound `previousUntil` would have set
 * for a renewal whose certificate was written at once.
 */
export const PROPAGATION_OVERDUE_MS = RENEWAL_OVERLAP_MS;

/** The Kubernetes API call the clock makes; the controller's `KubernetesApi` is one. */
interface ReadApi {
  call<T>(method: string, path: string): Promise<T>;
}

/** Reads the accounts file once and answers, per user, whether it has propagated. */
export interface Propagation {
  read(): Promise<(user: string) => boolean>;
}

export class AccountsPropagation implements Propagation {
  /** Per user named in the written file, when this process first saw it named. */
  private readonly since = new Map<string, number>();
  constructor(
    private readonly api: ReadApi,
    private readonly namespace: string,
    private readonly now: () => Date,
  ) {}

  /**
   * The written file's view: a user it does not name has not propagated, and a user seen named for
   * the first time starts its wait now. Users the file no longer names are forgotten, so a user
   * dropped and named again waits again, and nothing grows without bound.
   */
  async read(): Promise<(user: string) => boolean> {
    let text = '';
    try {
      const stored = await this.api.call<{ data?: Record<string, string> }>(
        'GET',
        `/api/v1/namespaces/${this.namespace}/configmaps/${SCHEDULER_NATS_ACCOUNTS}`,
      );
      text = stored.data?.[ACCOUNTS_KEY] ?? '';
    } catch (error) {
      if ((error as { code?: number })?.code !== 404) throw error;
    }
    const now = this.now().getTime();
    for (const user of this.since.keys())
      if (!accountsNamesUser(text, user)) this.since.delete(user);
    return (user) => {
      if (!accountsNamesUser(text, user)) return false;
      const since = this.since.get(user) ?? now;
      this.since.set(user, since);
      return now - since >= TENANT_OPERATOR_PROPAGATION_MS;
    };
  }
}

/**
 * How long each identity has waited for its user to propagate (#541 m6e-E). While a renewal
 * waits, every pass moves `previousUntil` forward, so the renewal stall never fires for it; past
 * {@link PROPAGATION_OVERDUE_MS} the wait itself is reported. In memory: a restarted controller
 * counts again from its first pass.
 */
export class PropagationWaits {
  /** Per record key, the user it waits for and when this process first saw it wait. */
  private readonly since = new Map<string, { user: string; at: number }>();

  /** Notes that `key` waits for `user`; once the wait is overdue, returns when it began. */
  overdue(key: string, user: string, now: Date): Date | undefined {
    const seen = this.since.get(key);
    const at = seen?.user === user ? seen.at : now.getTime();
    this.since.set(key, { user, at });
    return now.getTime() - at >= PROPAGATION_OVERDUE_MS ? new Date(at) : undefined;
  }

  /** `key` no longer waits. */
  done(key: string): void {
    this.since.delete(key);
  }

  /** Forgets every key not in `keys`. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.since.keys()) if (!keys.has(key)) this.since.delete(key);
  }
}
