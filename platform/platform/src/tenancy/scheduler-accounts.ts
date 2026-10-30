/**
 * The controller's writes of the scheduler NATS accounts file (#541 m6d, design-541 §4.4).
 *
 * On every pass {@link SchedulerAccountsWriter.reconcile} renders `accounts.conf` with the m2
 * renderer from the full Tenant list and the identity record `di-scheduler-identities`, so the
 * users are the record's (current, and previous during an overlap), never the issued Secrets'. A
 * removal step that drops a record entry (R1, R4) drops its user from the next render.
 *
 * - **No write when nothing changed.** `di-scheduler-nats-accounts` is written only when its bytes
 *   differ, so a steady state writes nothing and the server is never reloaded for nothing. A
 *   ConfigMap deleted out of band is created again.
 * - **Refusal.** A render the m2 validation refuses is never written: the previous file keeps
 *   serving, and the problems are returned for the controller to report as the
 *   `SchedulerAccounts` condition on each Tenant.
 * - **Nothing to do** while the installation has no scheduler PKI, or before the bootstrap Job has
 *   written the identity record.
 * - **Unknown.** A failed read or write returns undefined, so the caller keeps the condition it
 *   reported before instead of clearing it.
 *
 * Each state change is logged once. Inert until the cut-over (m6e): the chart's NATS does not read
 * this file.
 */
import { COMPONENT, INSTALLATION, type Resource, type Tenant } from './resources';
import {
  ACCOUNTS_KEY,
  type AccountsProblem,
  renderSchedulerAccounts,
  SCHEDULER_NATS_ACCOUNTS,
} from './scheduler-nats';
import {
  IDENTITIES_KEY,
  parseIdentityRecord,
  SCHEDULER_IDENTITIES,
  SCHEDULER_PKI_COMPONENT,
  schedulerPkiNamespace,
} from './scheduler-pki';

/** The Kubernetes API calls the writer makes; the controller's `KubernetesApi` is one. */
export interface AccountsApi {
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
}

interface Stored {
  metadata: Resource['metadata'];
  data?: Record<string, string>;
}

const configMapPath = (ns: string, name = '') =>
  `/api/v1/namespaces/${ns}/configmaps${name ? `/${name}` : ''}`;

export class SchedulerAccountsWriter {
  /** The state last logged, so each change is logged once; undefined before the first pass. */
  private logged: string | undefined;
  constructor(
    private readonly api: AccountsApi,
    private readonly cfg: { installation: string; namespace: string },
    private readonly now: () => Date,
  ) {}

  private async get<T>(path: string): Promise<T | undefined> {
    try {
      return await this.api.call<T>('GET', path);
    } catch (error) {
      if ((error as { code?: number })?.code === 404) return undefined;
      throw error;
    }
  }

  private log(state: string, write: () => void): void {
    if (state === this.logged) return;
    this.logged = state;
    write();
  }

  /**
   * Renders and, when it changed, writes the accounts file. Returns the problems of a refused
   * render, or an empty list. Never throws: a failed read or write is logged and retried on the
   * next pass, and returns undefined, since it says nothing about the record; the caller then
   * keeps whatever it reported before.
   */
  async reconcile(tenants: Tenant[]): Promise<AccountsProblem[] | undefined> {
    try {
      const problems = await this.write(tenants);
      if (problems.length > 0)
        this.log(`refused: ${problems.map((p) => p.message).join('; ')}`, () =>
          console.warn(
            `${SCHEDULER_NATS_ACCOUNTS} was not written, the previous file keeps serving: ${problems
              .map((p) => p.message)
              .join('; ')}`,
          ),
        );
      else
        this.log('rendered', () =>
          console.log(`${SCHEDULER_NATS_ACCOUNTS} is rendered from the record`),
        );
      return problems;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed: ${message}`, () =>
        console.error(`${SCHEDULER_NATS_ACCOUNTS} could not be written: ${message}`),
      );
      return undefined;
    }
  }

  private async write(tenants: Tenant[]): Promise<AccountsProblem[]> {
    const { namespace, installation } = this.cfg;
    const pki = schedulerPkiNamespace(namespace);
    // No record: the installation has no scheduler PKI, or the bootstrap Job has not run yet, which
    // issuance reports on each Tenant.
    const record = await this.get<Stored>(configMapPath(pki, SCHEDULER_IDENTITIES));
    if (!record) return [];
    const rendered = renderSchedulerAccounts(
      namespace,
      tenants,
      parseIdentityRecord(record.data?.[IDENTITIES_KEY] ?? ''),
      this.now(),
    );
    if ('problems' in rendered) return rendered.problems;
    const path = configMapPath(namespace, SCHEDULER_NATS_ACCOUNTS);
    const stored = await this.get<Stored>(path);
    if (stored?.data?.[ACCOUNTS_KEY] === rendered.text) return [];
    if (stored)
      // Under the read's resourceVersion, so a concurrent write conflicts and is retried.
      await this.api.call('PUT', path, {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        ...stored,
        data: { ...stored.data, [ACCOUNTS_KEY]: rendered.text },
      });
    else
      await this.api.call('POST', configMapPath(namespace), {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: SCHEDULER_NATS_ACCOUNTS,
          namespace,
          labels: { [INSTALLATION]: installation, [COMPONENT]: SCHEDULER_PKI_COMPONENT },
        },
        data: { [ACCOUNTS_KEY]: rendered.text },
      });
    console.log(`${namespace}/${SCHEDULER_NATS_ACCOUNTS} written`);
    return [];
  }
}
