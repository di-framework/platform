/**
 * The controller's issuance of each tenant's scheduler NATS identities (#541 m6c, design-541 §4.5):
 * the tenant hosts' client certificate, signed by the tenant scheduler CA, and the tenant
 * runtime-operator's, signed by the platform scheduler CA. The m4 transitions
 * ({@link recordTransition}) decide what to issue; this module reads the cluster, writes the
 * identity record before any certificate, and writes the Secrets.
 *
 * - **No CA yet.** Until the bootstrap Job has written `di-scheduler-ca` and the record, nothing is
 *   issued and {@link SCHEDULER_IDENTITY_PENDING} is reported; the next poll retries.
 * - **Fresh read.** The Secrets are observed through one LIST, which the API server may answer from
 *   a stale cache. Before anything is issued, every Secret to be issued is read again by name and
 *   the transitions are recomputed from that read, so a stale LIST never draws a second ID or
 *   overwrites a certificate that exists.
 * - **No write when nothing changed.** The record is written only when its bytes change, and a
 *   Secret only when its transition says `issue`; a steady state writes nothing.
 * - **Secret after propagation (m6e-E).** Pods mount the Secrets by name, so any pod that starts
 *   reads what they hold. A certificate is written into its Secret only once its user has
 *   propagated ({@link AccountsPropagation}): the record names the new user, the accounts file
 *   written from it names the user for the wait, then the Secret is written. Until then the Secret
 *   keeps a certificate whose user is still admitted (the `previous` of a routine renewal), or is
 *   deleted when it holds one whose user is not (a forced rotation revokes the old user at once),
 *   so pods that start meanwhile wait for the Secret volume instead of being refused. While a
 *   deleted Secret waits, its recorded ID is kept in memory, so it is not mistaken for a missing
 *   Secret that needs a new ID; after a restart it is, which only draws one more ID and waits again.
 *   Such a Secret is deleted before the record that drops its user is written, so a failure at any
 *   later step leaves no Secret holding a user the accounts file no longer names. A wait longer
 *   than {@link PROPAGATION_OVERDUE_MS} is reported as `WaitingForAccounts`.
 *
 * Inert until the cut-over (m6e): no pod mounts these Secrets yet. CA keys are held in memory only
 * for signing, and nothing here logs a key, a certificate or an issuance ID.
 */
import { X509Certificate } from 'node:crypto';
import {
  COMPONENT,
  type Condition,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  TENANT,
  TENANT_HOST_SECRET,
  type Tenant,
  VERSION,
} from './resources';
import { SCHEDULER_ACCOUNTS_CONDITION, SCHEDULER_NATS_ACCOUNTS } from './scheduler-nats';
import {
  CA_KEYS,
  IDENTITIES_KEY,
  type IdentityEntry,
  type IdentityRecord,
  PLATFORM_SECRETS,
  parseIdentityRecord,
  SCHEDULER_CA_SECRET,
  SCHEDULER_IDENTITIES,
  SCHEDULER_LEAF_DAYS,
  type SchedulerCaKind,
  schedulerCaFault,
  schedulerPkiNamespace,
  serializeIdentityRecord,
  tenantHostUser,
  tenantIdentity,
  tenantOperatorUser,
  tlsSecretData,
} from './scheduler-pki';
import {
  type HostObservation,
  type IdentityObservation,
  issuanceIdOf,
  RENEWAL_STALLED,
  ROTATE_ANNOTATION,
  recordTransition,
  rotationRequested,
  SCHEDULER_TLS_ANNOTATION,
  schedulerCertDigest,
} from './scheduler-pki-rotation';
import { AccountsPropagation, type Propagation, PropagationWaits } from './scheduler-propagation';
import { TENANT_OPERATOR_PROPAGATION_MS } from './tenant-operator';
import { operatorNamespace } from './tenant-operator-names';
import { certificateNames, issuedBy, type KeyPair, leafCertificate } from './tls';

/** The Kubernetes API calls issuance makes; the controller's `KubernetesApi` is one. */
export interface IdentityApi {
  call<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T>;
}

/**
 * The tenant hosts' identity Secret, in `di-runtime-<t>`. Not `di-scheduler-tls`, which held the
 * controller's copy of the chart's `wasmcloud-runtime-tls` until the cut-over (m6e) deletes it.
 */
export { TENANT_HOST_SECRET };
/** The tenant runtime-operator's identity Secret, in `di-operator-<t>`. */
export const TENANT_OPERATOR_SECRET = PLATFORM_SECRETS.operator;
/** The component label on both identity Secrets; the LIST that observes them selects it. */
export const SCHEDULER_IDENTITY_COMPONENT = 'scheduler-identity';
/** The Tenant condition set while an identity cannot be issued (the CA is not ready, or a write failed). */
export const SCHEDULER_IDENTITY_PENDING = 'SchedulerIdentityPending';

/**
 * What the controller keeps in Tenant status: per identity kind, the rotation annotation value
 * last handled. Per kind, because an identity out of scope when the rotation is requested (the
 * operator's, before `di-operator-<t>` exists) must still be rotated once it comes into scope.
 */
export type SchedulerIdentityStatus = Partial<Record<Kind, string>>;

type Kind = 'hosts' | 'operator';
interface Identity {
  key: string;
  kind: Kind;
  ca: SchedulerCaKind;
  namespace: string;
  name: string;
  user: (id: string) => string;
}
export interface Stored {
  metadata: {
    name: string;
    namespace?: string;
    resourceVersion?: string;
    uid?: string;
    labels?: Record<string, string>;
  };
  data?: Record<string, string>;
}
export interface Pending {
  reason: string;
  message: string;
}

const secretPath = (ns: string, name = '') =>
  `/api/v1/namespaces/${ns}/secrets${name ? `/${name}` : ''}`;
const configMapPath = (ns: string, name: string) => `/api/v1/namespaces/${ns}/configmaps/${name}`;
const namespacePath = (name: string) => `/api/v1/namespaces/${name}`;
const decode = (value: string | undefined) =>
  value === undefined ? undefined : Buffer.from(value, 'base64').toString('utf8');

/** The object at `path`, or undefined when the API server answers 404. */
export async function getIfExists<T>(api: IdentityApi, path: string): Promise<T | undefined> {
  try {
    return await api.call<T>('GET', path);
  } catch (error) {
    if ((error as { code?: number })?.code === 404) return undefined;
    throw error;
  }
}

/**
 * What a client identity's `secret` shows on top of `base`: its expiry, digest and the ID it
 * carries, if it verifies against `caCert` with its key and names `user(id)`. A certificate that
 * does not verify carries no usable ID, so it is re-issued for the recorded one.
 */
export function observeIdentity<B extends IdentityObservation>(
  base: B,
  secret: { data?: Record<string, string> } | undefined,
  caCert: string,
  user: (id: string) => string,
): B {
  if (!secret) return { ...base, secret: undefined };
  const cert = decode(secret.data?.['tls.crt']) ?? '';
  const key = decode(secret.data?.['tls.key']) ?? '';
  if (!issuedBy(caCert, cert, key))
    return { ...base, secret: { notAfter: new Date(0), digest: '' } };
  const dns = certificateNames(cert)?.dns ?? [];
  const id = dns.length === 1 ? issuanceIdOf(dns[0] as string) : undefined;
  return {
    ...base,
    secret: {
      notAfter: new Date(new X509Certificate(cert).validTo),
      digest: schedulerCertDigest(cert),
      ...(id && dns[0] === user(id) ? { id } : {}),
    },
  };
}

/** The fields of a host group Deployment that its rollout observation reads. */
export interface HostDeployment {
  metadata: { generation?: number };
  spec?: {
    replicas?: number;
    template?: { metadata?: { annotations?: Record<string, string> } };
  };
  status?: {
    observedGeneration?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
  };
}

/**
 * A host identity's observation base from Deployment `deployment` as read (`value`, undefined when
 * absent): its rollout of the certificate whose digest the pod-template `annotation` carries.
 */
export function hostRolloutOf(
  value: HostDeployment | undefined,
  deployment: string,
  annotation: string = SCHEDULER_TLS_ANNOTATION,
): HostObservation {
  if (!value) return { client: 'host', deployment };
  const replicas = value.spec?.replicas ?? 1;
  const digest = value.spec?.template?.metadata?.annotations?.[annotation];
  return {
    client: 'host',
    deployment,
    rollout: {
      deployment,
      ...(digest ? { digest } : {}),
      complete:
        value.status?.observedGeneration === value.metadata.generation &&
        (value.status?.updatedReplicas ?? 0) === replicas &&
        (value.status?.readyReplicas ?? 0) === replicas,
    },
  };
}

/** The path of Deployment `name` in `namespace`. */
export const deploymentPath = (namespace: string, name: string) =>
  `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`;

/** A host identity's observation base: Deployment `deployment` and its rollout of the certificate. */
export async function observeHostRollout(
  api: IdentityApi,
  namespace: string,
  deployment: string,
): Promise<HostObservation> {
  const value = await getIfExists<HostDeployment>(api, deploymentPath(namespace, deployment));
  return hostRolloutOf(value, deployment);
}

/** The scheduler CAs, or why they cannot sign yet. */
export type SchedulerCasRead = Record<SchedulerCaKind, KeyPair> | Pending;

/**
 * Both scheduler CAs from `<namespace>-scheduler-pki/di-scheduler-ca`, or why they cannot sign
 * yet. Key material stays in memory and out of every message.
 */
export async function readSchedulerCas(
  api: IdentityApi,
  namespace: string,
  now: Date,
): Promise<SchedulerCasRead> {
  const pki = schedulerPkiNamespace(namespace);
  const secret = await getIfExists<Stored>(api, secretPath(pki, SCHEDULER_CA_SECRET));
  if (!secret)
    return {
      reason: 'CaNotReady',
      message: `Waiting for the scheduler PKI bootstrap Job to create ${pki}/${SCHEDULER_CA_SECRET}`,
    };
  const cas = {} as Record<SchedulerCaKind, KeyPair>;
  for (const kind of ['platform', 'tenant'] as const) {
    const ca = {
      cert: decode(secret.data?.[CA_KEYS[kind].cert]),
      key: decode(secret.data?.[CA_KEYS[kind].key]),
    };
    const fault = schedulerCaFault(kind, namespace, ca, now);
    if (fault) return { reason: 'CaNotReady', message: `${pki}/${SCHEDULER_CA_SECRET}: ${fault}` };
    cas[kind] = ca as KeyPair;
  }
  return cas;
}

/**
 * Replaces the identity record read as `stored` with `record`, under `stored`'s resourceVersion,
 * so a record changed since it was read is not overwritten.
 */
export async function putIdentityRecord(
  api: IdentityApi,
  pki: string,
  stored: Stored,
  record: IdentityRecord,
): Promise<void> {
  await api.call('PUT', configMapPath(pki, SCHEDULER_IDENTITIES), {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    ...stored,
    data: { ...stored.data, [IDENTITIES_KEY]: serializeIdentityRecord(record) },
  });
}

/** The tenant's two identities: its hosts (tenant CA) and its runtime-operator (platform CA). */
export function tenantIdentities(tenant: string): Identity[] {
  return [
    {
      key: tenantIdentity(tenant, 'hosts'),
      kind: 'hosts',
      ca: 'tenant',
      namespace: names(tenant).runtimeNamespace,
      name: TENANT_HOST_SECRET,
      user: (id) => tenantHostUser(tenant, id),
    },
    {
      key: tenantIdentity(tenant, 'operator'),
      kind: 'operator',
      ca: 'platform',
      namespace: operatorNamespace(tenant),
      name: TENANT_OPERATOR_SECRET,
      user: (id) => tenantOperatorUser(tenant, id),
    },
  ];
}

/** True when this installation wrote `value` for the Tenant `uid` (its installation and owner labels). */
export function ownedBy(
  value: { metadata: { labels?: Record<string, string> } } | undefined,
  installation: string,
  uid: string | undefined,
): boolean {
  const labels = value?.metadata.labels;
  return labels?.[INSTALLATION] === installation && labels?.[OWNER] === uid;
}

/** True when `secret` is a scheduler identity this installation issued for the Tenant `uid`. */
export function ownsIdentitySecret(
  secret: { metadata: { labels?: Record<string, string> } } | undefined,
  installation: string,
  uid: string | undefined,
): boolean {
  return (
    ownedBy(secret, installation, uid) &&
    secret?.metadata.labels?.[COMPONENT] === SCHEDULER_IDENTITY_COMPONENT
  );
}

export class TenantSchedulerIdentities {
  /** The pending state last logged per tenant, so each change is logged once. */
  private readonly logged = new Map<string, string>();
  /**
   * Per `<tenant>/<kind>`, a rotation whose handled value the API server did not keep in status (a
   * Tenant CRD older than this controller prunes it). It is treated as handled, so it is not
   * repeated on every poll.
   */
  private readonly unpersisted = new Map<string, string>();
  /** Per record key, the recorded ID whose Secret was deleted to wait for propagation. */
  private readonly awaiting = new Map<string, string>();
  /** Per record key, how long its user has waited to propagate. */
  private readonly waits = new PropagationWaits();
  constructor(
    private readonly api: IdentityApi,
    private readonly cfg: { installation: string; namespace: string },
    private readonly now: () => Date,
    private readonly random?: (size: number) => Buffer,
    private readonly propagation: Propagation = new AccountsPropagation(api, cfg.namespace, now),
  ) {}

  private get<T>(path: string): Promise<T | undefined> {
    return getIfExists<T>(this.api, path);
  }

  /** Drops the in-memory state of tenants no longer listed. */
  forget(listed: ReadonlySet<string>): void {
    for (const name of this.logged.keys()) if (!listed.has(name)) this.logged.delete(name);
    for (const key of this.unpersisted.keys())
      if (!listed.has(key.slice(0, key.lastIndexOf('/')))) this.unpersisted.delete(key);
    const keys = new Set([...listed].flatMap((t) => tenantIdentities(t).map((i) => i.key)));
    for (const key of this.awaiting.keys()) if (!keys.has(key)) this.awaiting.delete(key);
    this.waits.retain(keys);
  }

  /**
   * Issues, renews and rotates the tenant's identities, and returns the conditions to report:
   * {@link SCHEDULER_IDENTITY_PENDING} while issuance cannot proceed, and {@link RENEWAL_STALLED}
   * while a host renewal's rollout is not observed. Never throws: a failure becomes the pending
   * condition, retried on the next poll. With `only`, just that identity: a Tenant being removed
   * keeps its operator's until R4 after R1 dropped its hosts' (#541 m6e).
   */
  async reconcile(tenant: Tenant, only?: Kind): Promise<Condition[]> {
    const name = tenant.metadata.name;
    let pending: Pending | undefined;
    let stalled: string | undefined;
    try {
      ({ pending, stalled } = await this.issue(tenant, only));
    } catch (error) {
      pending = {
        reason: 'IssuanceFailed',
        message: `Scheduler identity issuance failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const state = pending ? `${pending.reason}: ${pending.message}` : '';
    if (this.logged.get(name) !== state) {
      if (pending) console.warn(`Tenant/${name}: scheduler identity pending: ${state}`);
      else if (this.logged.has(name)) console.log(`Tenant/${name}: scheduler identities issued`);
      this.logged.set(name, state);
    }
    const generation = tenant.metadata.generation ?? 1;
    const condition = (type: string, reason: string, message: string): Condition => ({
      type,
      status: 'True',
      reason,
      message,
      observedGeneration: generation,
      lastTransitionTime: this.now().toISOString(),
    });
    return [
      ...(pending ? [condition(SCHEDULER_IDENTITY_PENDING, pending.reason, pending.message)] : []),
      ...(stalled
        ? [
            condition(
              RENEWAL_STALLED,
              'RolloutNotObserved',
              `Deployment ${names(name).runtimeNamespace}/${stalled} has not rolled out the renewed scheduler certificate; the previous user stays admitted`,
            ),
          ]
        : []),
    ];
  }

  private cas(): Promise<SchedulerCasRead> {
    return readSchedulerCas(this.api, this.cfg.namespace, this.now());
  }

  /**
   * The identity's observation. A Secret deleted while its recorded ID waits for propagation reads
   * as one that carries no ID, so the transition re-issues that ID instead of drawing another.
   */
  private observe(
    identity: Identity,
    secret: Stored | undefined,
    cas: Record<SchedulerCaKind, KeyPair>,
    hosts: HostObservation | undefined,
    record: IdentityRecord,
  ): IdentityObservation {
    const base = hosts ?? { client: 'operator' };
    if (!secret && this.awaiting.get(identity.key) === record[identity.key]?.current)
      return { ...base, secret: { notAfter: new Date(0), digest: '' } };
    return observeIdentity<IdentityObservation>(base, secret, cas[identity.ca].cert, identity.user);
  }

  /** The hosts' observation base: the hostgroup Deployment and its rollout of the certificate. */
  private hostRollout(tenant: Tenant): Promise<HostObservation> {
    const n = names(tenant.metadata.name);
    return observeHostRollout(this.api, n.runtimeNamespace, `hostgroup-${n.hostgroup}`);
  }

  private async issue(
    tenant: Tenant,
    only?: Kind,
  ): Promise<{ pending?: Pending; stalled?: string }> {
    const t = tenant.metadata.name;
    const pki = schedulerPkiNamespace(this.cfg.namespace);
    // No PKI namespace: this installation has no scheduler PKI to wait for.
    if (!(await this.get(namespacePath(pki)))) return {};
    const cas = await this.cas();
    if ('reason' in cas) return { pending: cas };
    const stored = await this.get<Stored>(configMapPath(pki, SCHEDULER_IDENTITIES));
    if (!stored)
      return {
        pending: {
          reason: 'CaNotReady',
          message: `Waiting for the scheduler PKI bootstrap Job to create ${pki}/${SCHEDULER_IDENTITIES}`,
        },
      };
    const record: IdentityRecord = parseIdentityRecord(stored.data?.[IDENTITIES_KEY] ?? '');
    // The operator's identity waits for `di-operator-<t>`, which the controller creates (m6e).
    const identities: Identity[] = [];
    for (const identity of tenantIdentities(t).filter((i) => !only || i.kind === only))
      if (
        identity.kind === 'hosts' ||
        // Only into a namespace this installation created for the Tenant, as R5 deletes it.
        ownedBy(
          await this.get<Stored>(namespacePath(identity.namespace)),
          this.cfg.installation,
          tenant.metadata.uid,
        )
      )
        identities.push(identity);
    const hosts = await this.hostRollout(tenant);
    const listed = (
      await this.api.call<{ items: Stored[] }>(
        'GET',
        `/api/v1/secrets?labelSelector=${encodeURIComponent(
          `${INSTALLATION}=${this.cfg.installation},${OWNER}=${tenant.metadata.uid},${COMPONENT}=${SCHEDULER_IDENTITY_COMPONENT}`,
        )}`,
      )
    ).items;
    const rotation = tenant.metadata.annotations?.[ROTATE_ANNOTATION] ?? '';
    const handled = (value: Tenant | undefined, kind: Kind) =>
      (value?.status?.schedulerIdentity as SchedulerIdentityStatus | undefined)?.[kind];
    const unpersisted = (kind: Kind) => this.unpersisted.get(`${t}/${kind}`) === rotation;
    // Only identities in scope are rotated and marked handled, each kind on its own. A Tenant from
    // a stale LIST may lack the rotation already handled, so a requested rotation is confirmed
    // against a fresh read before it draws new IDs.
    const requested = identities
      .map((identity) => identity.kind)
      .filter((kind) => !unpersisted(kind) && rotationRequested(rotation, handled(tenant, kind)));
    const current =
      requested.length > 0
        ? await this.get<Tenant>(`/apis/${VERSION}/tenants/${encodeURIComponent(t)}`)
        : undefined;
    const forcedKinds = requested.filter((kind) =>
      rotationRequested(rotation, handled(current, kind)),
    );
    const observed: Record<string, IdentityObservation> = {};
    for (const identity of identities) {
      const secret = listed.find(
        (s) => s.metadata.namespace === identity.namespace && s.metadata.name === identity.name,
      );
      observed[identity.key] = {
        ...this.observe(
          identity,
          secret,
          cas,
          identity.kind === 'hosts' ? hosts : undefined,
          record,
        ),
        ...(forcedKinds.includes(identity.kind) ? { forced: true } : {}),
      };
    }
    let next = recordTransition(record, observed, this.now(), this.random);
    // The fresh read: a LIST may lag behind the store, so what it shows is never issued over.
    const fresh = new Map<string, Stored | undefined>();
    const issuing = () =>
      next.transitions
        .filter(([, transition]) => transition.action === 'issue')
        .map(([key]) => key);
    if (issuing().length > 0) {
      for (const identity of identities.filter((i) => issuing().includes(i.key))) {
        const secret = await this.get<Stored>(secretPath(identity.namespace, identity.name));
        if (secret && !ownsIdentitySecret(secret, this.cfg.installation, tenant.metadata.uid))
          return {
            pending: {
              reason: 'SecretNotOwned',
              message: `Secret ${identity.namespace}/${identity.name} was not written by this controller for the Tenant; delete it to let the controller issue the identity`,
            },
          };
        fresh.set(identity.key, secret);
        observed[identity.key] = {
          ...this.observe(
            identity,
            secret,
            cas,
            identity.kind === 'hosts' ? hosts : undefined,
            record,
          ),
          ...(forcedKinds.includes(identity.kind) ? { forced: true } : {}),
        };
      }
      next = recordTransition(record, observed, this.now(), this.random);
    }
    // A Secret whose certificate's user the record is about to stop naming is deleted before
    // anything is written: until the DELETE succeeds the record still names that user, so it stays
    // rendered. A pod that starts after it waits for the volume instead of presenting a revoked
    // user. A Secret holding `previous` (a routine renewal) is kept: that user stays admitted.
    const revoked = identities.filter((identity) => {
      const existing = fresh.get(identity.key);
      const held = observed[identity.key]?.secret?.id;
      return (
        existing !== undefined &&
        issuing().includes(identity.key) &&
        (held === undefined || held !== next.record[identity.key]?.previous)
      );
    });
    await Promise.all(
      revoked.map(async (identity) => {
        const existing = fresh.get(identity.key) as Stored;
        await this.api.call('DELETE', secretPath(identity.namespace, identity.name), {
          preconditions: { resourceVersion: existing.metadata.resourceVersion },
        });
        fresh.set(identity.key, undefined);
      }),
    );
    // Then the record: a user name then always names exactly one certificate.
    const text = serializeIdentityRecord(next.record);
    if (text !== serializeIdentityRecord(record))
      await putIdentityRecord(this.api, pki, stored, next.record);
    // Without a Secret, the recorded ID is remembered so the next pass does not draw another.
    for (const key of issuing())
      if (!fresh.get(key)) this.awaiting.set(key, (next.record[key] as IdentityEntry).current);
    // After the record and before issuance, so an interrupted forced rotation repeats at most once.
    if (forcedKinds.length > 0) {
      // The kinds already handled are sent too, so the write never depends on a deep merge.
      const marked = {
        ...(current?.status?.schedulerIdentity as SchedulerIdentityStatus | undefined),
        ...Object.fromEntries(forcedKinds.map((kind) => [kind, rotation])),
      };
      const updated = await this.api.call<Tenant>(
        'PATCH',
        `/apis/${VERSION}/tenants/${encodeURIComponent(t)}/status`,
        {
          // The fresh read's, so a stale LIST does not make this write conflict.
          metadata: { resourceVersion: current?.metadata.resourceVersion },
          status: { schedulerIdentity: marked },
        },
        'application/merge-patch+json',
      );
      tenant.metadata = updated.metadata;
      tenant.status = {
        ...tenant.status,
        schedulerIdentity: { ...(tenant.status?.schedulerIdentity as object), ...marked },
      };
      for (const kind of forcedKinds)
        if (handled(updated, kind) !== rotation) this.unpersisted.set(`${t}/${kind}`, rotation);
    }
    const propagated = issuing().length > 0 ? await this.propagation.read() : () => false;
    let waiting: Pending | undefined;
    for (const identity of identities) {
      if (!issuing().includes(identity.key)) {
        this.waits.done(identity.key);
        continue;
      }
      const user = identity.user((next.record[identity.key] as IdentityEntry).current);
      const existing = fresh.get(identity.key);
      if (!propagated(user)) {
        const since = this.waits.overdue(identity.key, user, this.now());
        if (since)
          waiting ??= {
            reason: 'WaitingForAccounts',
            message: `Secret ${identity.namespace}/${identity.name} has waited since ${since.toISOString()} for ${SCHEDULER_NATS_ACCOUNTS} to name its new user for ${TENANT_OPERATOR_PROPAGATION_MS / 1000} s; see the ${SCHEDULER_ACCOUNTS_CONDITION} condition`,
          };
        continue;
      }
      const ca = cas[identity.ca];
      const leaf = leafCertificate(
        user,
        [user],
        [],
        SCHEDULER_LEAF_DAYS,
        ca.cert,
        ca.key,
        this.now(),
        'client',
      );
      const body = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: identity.name,
          namespace: identity.namespace,
          labels: {
            [INSTALLATION]: this.cfg.installation,
            [OWNER]: tenant.metadata.uid ?? '',
            [TENANT]: t,
            [COMPONENT]: SCHEDULER_IDENTITY_COMPONENT,
          },
          ...(existing ? { resourceVersion: existing.metadata.resourceVersion } : {}),
        },
        type: 'kubernetes.io/tls',
        // Clients verify the server against the platform CA (design-541 §4.5).
        data: tlsSecretData(leaf, cas.platform.cert),
      } as Resource;
      if (existing) await this.api.call('PUT', secretPath(identity.namespace, identity.name), body);
      else await this.api.call('POST', secretPath(identity.namespace), body);
      this.awaiting.delete(identity.key);
      this.waits.done(identity.key);
    }
    const pending: Pending | undefined = identities.some((identity) => unpersisted(identity.kind))
      ? {
          reason: 'RotationNotPersisted',
          message: `The API server did not keep status.schedulerIdentity, so the Tenant CRD may predate this controller; the rotation was applied once and is not repeated`,
        }
      : waiting;
    return {
      ...(next.stalled.length > 0 ? { stalled: hosts.deployment } : {}),
      ...(pending ? { pending } : {}),
    };
  }

  /**
   * Removal steps R1 (`hosts`) and R4 (`operator`): drop the tenant's entry from the record, so the
   * next accounts render leaves its user out. Done once the record holds no such entry; nothing to
   * do while the PKI does not exist. Returns whether the PKI (its identity record) exists.
   */
  async drop(tenant: string, kind: Kind): Promise<boolean> {
    const pki = schedulerPkiNamespace(this.cfg.namespace);
    const stored = await this.get<Stored>(configMapPath(pki, SCHEDULER_IDENTITIES));
    if (!stored) return false;
    const record = parseIdentityRecord(stored.data?.[IDENTITIES_KEY] ?? '');
    const key = tenantIdentity(tenant, kind);
    // A dropped identity waits for nothing: forget its Secret-deleted ID and propagation clock now
    // rather than when the tenant stops being listed.
    this.awaiting.delete(key);
    this.waits.done(key);
    if (!record[key]) return true;
    delete record[key];
    await putIdentityRecord(this.api, pki, stored, record);
    return true;
  }
}
