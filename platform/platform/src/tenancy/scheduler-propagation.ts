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
import { TENANT_OPERATOR_PROPAGATION_MS } from './tenant-operator';

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
