/**
 * The scheduler NATS accounts file (#541 m2, design-541 §4.2-4.4).
 *
 * {@link renderSchedulerAccounts} renders `accounts.conf` from the Tenant list and the identity
 * record `di-scheduler-identities`, never incrementally:
 *
 * - `T_<platform-ns>`: the platform host group (`hostgroup-default`, O1) and the chart's operator;
 * - `T_di-tenant-<t>`, one per Tenant: the tenant's hosts and its runtime-operator, which runs in
 *   `di-operator-<t>` (O6), with per-account limits;
 * - `DATA`: the data connection of `hostgroup-default`, the only account with JetStream (O5).
 *
 * No account imports or exports anything. The output is sorted with a code-unit comparator, so the
 * same Tenants and record always give the same bytes, whatever order they come in. Every user name
 * is checked against its §4.4 pattern and for uniqueness first; on a violation nothing is rendered
 * and the problems are returned, for the controller to report as {@link SCHEDULER_ACCOUNTS_CONDITION}
 * (nats-server would refuse the whole reload and keep its previous configuration).
 *
 * {@link bootstrapSchedulerAccounts} is the bootstrap Job's last step: it creates the ConfigMap
 * {@link SCHEDULER_NATS_ACCOUNTS} with no tenants when it is missing and never overwrites it, since
 * the platform controller is its only writer afterwards. It is not a Pulumi resource, so a
 * `pulumi up` cannot reset it. Nothing reads it until the cut-over (m6).
 */
import type { Condition, Resource } from './resources';
import {
  codeUnitOrder,
  IDENTITIES_KEY,
  type IdentityEntry,
  type IdentityRecord,
  type PkiApi,
  type PlatformRole,
  parseIdentityRecord,
  platformIdentity,
  platformUser,
  SCHEDULER_IDENTITIES,
  SCHEDULER_PKI_COMPONENT,
  type SchedulerPkiConfig,
  SchedulerPkiRefused,
  schedulerPkiNamespace,
  tenantHostUser,
  tenantIdentity,
  tenantOperatorUser,
} from './scheduler-pki';

const INSTALLATION = 'platform.di-framework.dev/installation';
const COMPONENT = 'platform.di-framework.dev/component';

/** The ConfigMap, in the platform namespace, that the `nats` Deployment mounts (from m6). */
export const SCHEDULER_NATS_ACCOUNTS = 'di-scheduler-nats-accounts';
/** The key of {@link SCHEDULER_NATS_ACCOUNTS}: the whole file, so a write is never partial. */
export const ACCOUNTS_KEY = 'accounts.conf';
/** The account of `hostgroup-default`'s data connection; the only one with JetStream (O5). */
export const DATA_ACCOUNT = 'DATA';
/** The Tenant condition that reports a refused render. */
export const SCHEDULER_ACCOUNTS_CONDITION = 'SchedulerAccounts';

/** A tenant account's limits (§4.3): `max_connections` is 2 x host replicas + 4. */
export const TENANT_MAX_SUBSCRIPTIONS = 64;
export const TENANT_MAX_PAYLOAD = 1048576;
export const tenantMaxConnections = (replicas: number): number => 2 * replicas + 4;
/**
 * The `DATA` account's JetStream limits (#541 m6d, O5). They equal the server-wide caps of the m6b
 * `nats` server (`JETSTREAM_MAX_MEMORY_STORE`, `JETSTREAM_MAX_FILE_STORE` in
 * `scheduler-nats-server.ts`), so the only JetStream account can never reserve more than the
 * server holds; a test keeps them within those caps.
 */
export const DATA_MAX_MEMORY = '32M';
export const DATA_MAX_FILE = '1G';

/** A Tenant as the renderer reads it: its name and its host replicas. */
export interface AccountsTenant {
  metadata: { name: string };
  spec?: { runtime?: { replicas?: number } };
}

/** Why a render was refused: the offending Tenant, when there is one. */
export interface AccountsProblem {
  reason:
    | 'InvalidAccountName'
    | 'InvalidReplicas'
    | 'InvalidSchedulerUser'
    | 'DuplicateSchedulerUser'
    | 'EmptyPlatformAccount';
  tenant?: string;
  message: string;
}
export type AccountsRender = { text: string } | { problems: AccountsProblem[] };

const HOST_PERMISSIONS =
  'permissions: { publish: { allow: ["runtime.operator.heartbeat.*"] }, ' +
  'subscribe: { allow: ["runtime.host.*.>"] }, allow_responses: { max: 1, expires: "2m" } }';
const OPERATOR_PERMISSIONS =
  'permissions: { publish: { allow: ["runtime.host.*.>"] }, ' +
  'subscribe: { allow: ["runtime.operator.heartbeat.>", "_INBOX.>"] } }';

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const ID = '[0-9a-f]{16}';
const TAIL = String.raw`scheduler\.di-framework\.invalid$`;
/** The §4.4 user-name patterns. */
export const USER_PATTERNS = {
  tenantHost: (tenant: string) =>
    new RegExp(String.raw`^${ID}\.di-tenant-${literal(tenant)}\.tenants\.${TAIL}`),
  tenantOperator: (tenant: string) =>
    new RegExp(String.raw`^${ID}\.operator\.di-tenant-${literal(tenant)}\.platform\.${TAIL}`),
  platform: new RegExp(String.raw`^${ID}\.(operator|host|data)\.platform\.${TAIL}`),
};
/** A Tenant name (`validName` in `resources.ts`), so `T_di-tenant-<t>` is a valid account name. */
const TENANT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_TENANT_NAME = 40;
/** A namespace name (a DNS label), so `T_<platform-ns>` is a valid account name. */
const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_NAMESPACE_NAME = 63;
/** The Tenant CRD's bounds on `spec.runtime.replicas`, checked again before they reach the file. */
const MIN_REPLICAS = 1;
const MAX_REPLICAS = 10;

interface User {
  name: string;
  permissions?: string;
  pattern: RegExp;
  tenant?: string;
}
interface Account {
  name: string;
  head: string[];
  users: User[];
  tenant?: string;
}

/**
 * The users of `entry`: current, and previous while the record holds it. For an operator
 * (`cutOff`), previous is rendered only before `previousUntil`; a missing or unparseable
 * `previousUntil` counts as passed. Hosts are never cut off by `previousUntil` (§4.5): their
 * previous user stays until the identity record drops it.
 */
function issuances(entry: IdentityEntry | undefined, now: Date, cutOff: boolean): string[] {
  if (!entry) return [];
  if (entry.previous === undefined) return [entry.current];
  const keep = !cutOff || now.getTime() < Date.parse(entry.previousUntil ?? '');
  return keep ? [entry.current, entry.previous] : [entry.current];
}

function accounts(
  namespace: string,
  tenants: AccountsTenant[],
  record: IdentityRecord,
  now: Date,
): Account[] {
  const platform = (role: PlatformRole, permissions?: string): User[] =>
    issuances(record[platformIdentity(role)], now, role === 'operator').map((id) => ({
      name: platformUser(role, id),
      permissions,
      pattern: USER_PATTERNS.platform,
    }));
  const result: Account[] = [
    {
      name: `T_${namespace}`,
      head: [],
      users: [...platform('host', HOST_PERMISSIONS), ...platform('operator', OPERATOR_PERMISSIONS)],
    },
    {
      name: DATA_ACCOUNT,
      head: [`jetstream: { max_mem: ${DATA_MAX_MEMORY}, max_file: ${DATA_MAX_FILE} }`],
      users: platform('data'),
    },
  ];
  for (const tenant of tenants) {
    const t = tenant.metadata.name;
    const replicas = tenant.spec?.runtime?.replicas ?? 1;
    result.push({
      name: `T_di-tenant-${t}`,
      tenant: t,
      head: [
        `limits: { max_connections: ${tenantMaxConnections(replicas)}, ` +
          `max_subscriptions: ${TENANT_MAX_SUBSCRIPTIONS}, max_payload: ${TENANT_MAX_PAYLOAD} }`,
      ],
      users: [
        ...issuances(record[tenantIdentity(t, 'hosts')], now, false).map((id) => ({
          name: tenantHostUser(t, id),
          permissions: HOST_PERMISSIONS,
          pattern: USER_PATTERNS.tenantHost(t),
          tenant: t,
        })),
        ...issuances(record[tenantIdentity(t, 'operator')], now, true).map((id) => ({
          name: tenantOperatorUser(t, id),
          permissions: OPERATOR_PERMISSIONS,
          pattern: USER_PATTERNS.tenantOperator(t),
          tenant: t,
        })),
      ],
    });
  }
  // An account without users admits nobody; a Tenant whose entries are gone (R4) drops out.
  return result.filter((account) => account.users.length > 0);
}

/** The problems of each Tenant's account name and replicas; `names` holds the names so far. */
function tenantProblems(tenants: AccountsTenant[], names: Set<string>): AccountsProblem[] {
  const problems: AccountsProblem[] = [];
  for (const { metadata, spec } of tenants) {
    const tenant = metadata.name;
    const account = `T_di-tenant-${tenant}`;
    if (tenant.length > MAX_TENANT_NAME || !TENANT_NAME.test(tenant))
      problems.push({
        reason: 'InvalidAccountName',
        tenant,
        message: `Tenant '${tenant}' does not give a valid account name`,
      });
    else if (names.has(account))
      problems.push({
        reason: 'InvalidAccountName',
        tenant,
        message: `account ${account} of Tenant '${tenant}' is not unique`,
      });
    names.add(account);
    const replicas = spec?.runtime?.replicas ?? MIN_REPLICAS;
    if (!Number.isInteger(replicas) || replicas < MIN_REPLICAS || replicas > MAX_REPLICAS)
      problems.push({
        reason: 'InvalidReplicas',
        tenant,
        message: `Tenant '${tenant}' has replicas outside ${MIN_REPLICAS}-${MAX_REPLICAS}`,
      });
  }
  return problems;
}

function validate(
  namespace: string,
  tenants: AccountsTenant[],
  rendered: Account[],
): AccountsProblem[] {
  const problems: AccountsProblem[] = [];
  if (namespace.length > MAX_NAMESPACE_NAME || !NAMESPACE_NAME.test(namespace))
    problems.push({
      reason: 'InvalidAccountName',
      message: `the platform namespace '${namespace}' does not give a valid account name`,
    });
  problems.push(...tenantProblems(tenants, new Set([`T_${namespace}`])));
  if (problems.length > 0) return problems;
  const seen = new Set<string>();
  for (const account of rendered)
    for (const user of account.users) {
      if (!user.pattern.test(user.name))
        problems.push({
          reason: 'InvalidSchedulerUser',
          tenant: user.tenant,
          message: `user '${user.name}' in account ${account.name} does not match its pattern`,
        });
      if (seen.has(user.name))
        problems.push({
          reason: 'DuplicateSchedulerUser',
          tenant: user.tenant,
          message: `user '${user.name}' appears more than once`,
        });
      seen.add(user.name);
    }
  // The platform accounts are never optional: without their users the platform hosts, the chart's
  // operator or the data connection would be shut out on the next reload.
  for (const name of [`T_${namespace}`, DATA_ACCOUNT])
    if (!rendered.some((account) => account.name === name))
      problems.push({
        reason: 'EmptyPlatformAccount',
        message: `account ${name} has no users in the identity record`,
      });
  return problems;
}

/**
 * `accounts.conf` for the platform namespace `namespace`, the Tenant list `tenants` and the
 * identity record `record` at `now`, or the problems that stop it from being written. Record
 * entries of Tenants not in the list are not rendered.
 */
export function renderSchedulerAccounts(
  namespace: string,
  tenants: AccountsTenant[],
  record: IdentityRecord,
  now: Date,
): AccountsRender {
  const rendered = accounts(namespace, tenants, record, now);
  const problems = validate(namespace, tenants, rendered);
  if (problems.length > 0) return { problems };
  const lines = [
    '# Rendered by the platform controller (design-541 sections 4.2-4.4). Do not edit.',
  ];
  lines.push('accounts {');
  rendered.sort((a, b) => codeUnitOrder(a.name, b.name));
  for (const account of rendered) {
    lines.push(`  ${account.name}: {`);
    for (const line of account.head) lines.push(`    ${line}`);
    lines.push('    users: [');
    account.users.sort((a, b) => codeUnitOrder(a.name, b.name));
    for (const user of account.users) {
      const fields = [userField(user.name), user.permissions].filter(Boolean);
      lines.push(`      { ${fields.join(', ')} }`);
    }
    lines.push('    ]', '  }');
  }
  lines.push('}');
  return { text: `${lines.join('\n')}\n` };
}

/** A user's line in the rendered file, by its name. */
const userField = (name: string): string => `user: "${name}"`;

/**
 * True when an accounts file {@link renderSchedulerAccounts} rendered names `user`. The
 * controller's propagation wait starts from it, so it reads the renderer's own line format.
 */
export function accountsNamesUser(text: string, user: string): boolean {
  return text.includes(userField(user));
}

/** The condition reason of a Tenant refused only because of another identity's problem. */
export const REFUSED_FOR_OTHER = 'RefusedForAnotherIdentity';

/**
 * The Tenant condition for a refused render: the first problem naming `tenant`, or a generic
 * refusal that names no other Tenant's user when none does. The controller sets it (from m6); the
 * previous file keeps serving.
 */
export function schedulerAccountsCondition(
  problems: AccountsProblem[],
  tenant: string,
  observedGeneration: number,
  now: Date,
): Condition {
  const problem = problems.find((p) => p.tenant === tenant) ?? {
    reason: REFUSED_FOR_OTHER,
    message: 'refused because of another identity',
  };
  return {
    type: SCHEDULER_ACCOUNTS_CONDITION,
    status: 'False',
    reason: problem.reason,
    message: `${SCHEDULER_NATS_ACCOUNTS} was not written: ${problem.message}`,
    observedGeneration,
    lastTransitionTime: now.toISOString(),
  };
}

const configMapPath = (ns: string, name = '') =>
  `/api/v1/namespaces/${[ns, 'configmaps', name].filter(Boolean).join('/')}`;

/**
 * Creates {@link SCHEDULER_NATS_ACCOUNTS} in the platform namespace with no tenants, rendered from
 * the identity record, when it is missing. It never overwrites it. Returns what it wrote.
 */
export async function bootstrapSchedulerAccounts(
  api: PkiApi,
  config: SchedulerPkiConfig,
  now: Date = new Date(),
): Promise<string[]> {
  const { installation, namespace } = config;
  const get = (path: string) =>
    api.call<{ data?: Record<string, string> }>('GET', path).catch((error: { code?: number }) => {
      if (error?.code === 404) return undefined;
      throw error;
    });
  if (await get(configMapPath(namespace, SCHEDULER_NATS_ACCOUNTS))) return [];
  const pki = schedulerPkiNamespace(namespace);
  const stored = await get(configMapPath(pki, SCHEDULER_IDENTITIES));
  if (!stored)
    throw new SchedulerPkiRefused(
      `${pki}/${SCHEDULER_IDENTITIES} is missing, so ${SCHEDULER_NATS_ACCOUNTS} is not rendered`,
    );
  const rendered = renderSchedulerAccounts(
    namespace,
    [],
    parseIdentityRecord(stored.data?.[IDENTITIES_KEY] ?? ''),
    now,
  );
  if ('problems' in rendered)
    throw new SchedulerPkiRefused(
      `${SCHEDULER_NATS_ACCOUNTS} was not written: ${rendered.problems.map((p) => p.message).join('; ')}`,
    );
  await api.call('POST', configMapPath(namespace), {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: SCHEDULER_NATS_ACCOUNTS,
      namespace,
      labels: { [INSTALLATION]: installation, [COMPONENT]: SCHEDULER_PKI_COMPONENT },
    },
    data: { [ACCOUNTS_KEY]: rendered.text },
  } as Resource);
  return [`${namespace}/${SCHEDULER_NATS_ACCOUNTS}`];
}
