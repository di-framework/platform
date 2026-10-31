import { COMPONENT, type Resource, TENANT, TENANT_HOST_SECRET } from '../../src/tenancy/resources';
import { SCHEDULER_IDENTITY_COMPONENT } from '../../src/tenancy/scheduler-identities';
import { ACCOUNTS_KEY, SCHEDULER_NATS_ACCOUNTS } from '../../src/tenancy/scheduler-nats';
import {
  IDENTITIES_KEY,
  PLATFORM_SECRETS,
  parseIdentityRecord,
  tenantIdentity,
} from '../../src/tenancy/scheduler-pki';
import { issuanceIdOf } from '../../src/tenancy/scheduler-pki-rotation';
import { TENANT_OPERATOR_PROPAGATION_MS } from '../../src/tenancy/tenant-operator';
import { certificateNames } from '../../src/tenancy/tls';
import { cfg, type MemoryApi, recordPath } from './controller-harness';

const accountsPath = `/api/v1/namespaces/${cfg.namespace}/configmaps/${SCHEDULER_NATS_ACCOUNTS}`;
const platformPaths = (['operator', 'host', 'data'] as const).map(
  (role) => `/api/v1/namespaces/${cfg.namespace}/secrets/${PLATFORM_SECRETS[role]}`,
);

/**
 * The m6e-E invariant, checked after each tick: the certificate in every controller-issued
 * scheduler identity Secret names a user that the written accounts file has named for at least
 * {@link TENANT_OPERATOR_PROPAGATION_MS}, or the `previous` user of its record entry, still named.
 * A pod that starts at any moment then presents a user NATS admits.
 *
 * The clock of each user starts at the first check that sees it named and is dropped when the file
 * stops naming it, as the controller's does. The certificates already in a Secret when the check is
 * created were not issued by the controller (the bootstrap Job writes the platform ones before any
 * accounts file exists), so their users count as loaded.
 */
export class PropagationInvariant {
  private readonly since = new Map<string, number>();
  private readonly preexisting: Set<string>;
  constructor(
    private readonly api: MemoryApi,
    private readonly now: () => Date,
  ) {
    this.preexisting = new Set();
    this.trust();
  }

  /** Counts the users of the certificates the Secrets hold now as loaded: they were not issued by the controller (a test ran the bootstrap Job). */
  trust(): void {
    for (const [, secret] of this.secrets()) this.preexisting.add(userOf(secret));
  }

  private secrets(): [string, Resource][] {
    return [...this.api.objects.entries()].filter(
      ([path, value]) =>
        value.kind === 'Secret' &&
        (value.metadata.labels?.[COMPONENT] === SCHEDULER_IDENTITY_COMPONENT ||
          platformPaths.includes(path)),
    );
  }

  private text(): string {
    return (this.api.objects.get(accountsPath)?.data as Record<string, string> | undefined)?.[
      ACCOUNTS_KEY
    ] as string;
  }

  /** The violations at this moment, one line per Secret; empty when the invariant holds. */
  violations(): string[] {
    const text = this.text() ?? '';
    const named = new Set([...text.matchAll(/user: "([^"]+)"/g)].map((m) => m[1] as string));
    const now = this.now().getTime();
    for (const user of this.since.keys()) if (!named.has(user)) this.since.delete(user);
    for (const user of named)
      if (!this.since.has(user))
        this.since.set(user, this.preexisting.has(user) ? Number.NEGATIVE_INFINITY : now);
    const stored = (this.api.objects.get(recordPath)?.data as Record<string, string> | undefined)?.[
      IDENTITIES_KEY
    ];
    const record = stored ? parseIdentityRecord(stored) : {};
    const previous = new Set(Object.values(record).map((entry) => entry.previous));
    const found: string[] = [];
    for (const [path, secret] of this.secrets()) {
      // A tenant identity whose entry removal dropped (R1, R4) is revoked on purpose, once its
      // clients are gone; its Secret goes with the namespace.
      const tenant = secret.metadata.labels?.[TENANT];
      const kind = secret.metadata.name === TENANT_HOST_SECRET ? 'hosts' : 'operator';
      if (tenant && !record[tenantIdentity(tenant, kind)]) continue;
      const user = userOf(secret);
      const age = now - (this.since.get(user) ?? now);
      const admitted = named.has(user);
      const ok =
        admitted &&
        (age >= TENANT_OPERATOR_PROPAGATION_MS || previous.has(issuanceIdOf(user) as string));
      if (!ok)
        found.push(
          `${path}: ${admitted ? `named for ${age / 1000} s` : 'not in the accounts file'}`,
        );
    }
    return found;
  }

  /** Throws when the invariant does not hold. */
  check(): void {
    const found = this.violations();
    if (found.length > 0) throw new Error(`m6e-E invariant violated:\n${found.join('\n')}`);
  }
}

/** The user (DNS SAN) of the certificate a Secret holds, '' when it holds none that parses. */
export function userOf(secret: Resource): string {
  const data = secret.data as Record<string, string> | undefined;
  const pem = Buffer.from(data?.['tls.crt'] ?? '', 'base64').toString('utf8');
  return certificateNames(pem)?.dns?.[0] ?? '';
}
