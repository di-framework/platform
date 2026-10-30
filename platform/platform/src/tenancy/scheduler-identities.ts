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
  type Tenant,
  VERSION,
} from './resources';
import {
  CA_KEYS,
  IDENTITIES_KEY,
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
import { operatorNamespace } from './tenant-operator-names';
import { certificateNames, issuedBy, type KeyPair, leafCertificate } from './tls';

/** The Kubernetes API calls issuance makes; the controller's `KubernetesApi` is one. */
export interface IdentityApi {
  call<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T>;
}

/**
 * The tenant hosts' identity Secret, in `di-runtime-<t>`. The design names it `di-scheduler-tls`,
 * but until the cut-over (m6e) that name holds the controller's copy of the chart's
 * `wasmcloud-runtime-tls`, which the hosts mount; issuing into it would replace their live
 * certificate. The identity is therefore issued under its own name, which m6e mounts.
 */
export const TENANT_HOST_SECRET = 'di-scheduler-host-tls';
/** The tenant runtime-operator's identity Secret, in `di-operator-<t>`. */
export const TENANT_OPERATOR_SECRET = PLATFORM_SECRETS.operator;
/** The component label on both identity Secrets; the LIST that observes them selects it. */
export const SCHEDULER_IDENTITY_COMPONENT = 'scheduler-identity';
/** The Tenant condition set while an identity cannot be issued (the CA is not ready, or a write failed). */
export const SCHEDULER_IDENTITY_PENDING = 'SchedulerIdentityPending';

/** What the controller keeps in Tenant status: the rotation annotation value last handled. */
export interface SchedulerIdentityStatus {
  rotation: string;
}

type Kind = 'hosts' | 'operator';
interface Identity {
  key: string;
  kind: Kind;
  ca: SchedulerCaKind;
  namespace: string;
  name: string;
  user: (id: string) => string;
}
interface Stored {
  metadata: {
    name: string;
    namespace?: string;
    resourceVersion?: string;
    uid?: string;
    labels?: Record<string, string>;
  };
  data?: Record<string, string>;
}
interface Pending {
  reason: string;
  message: string;
}

const secretPath = (ns: string, name = '') =>
  `/api/v1/namespaces/${ns}/secrets${name ? `/${name}` : ''}`;
const configMapPath = (ns: string, name: string) => `/api/v1/namespaces/${ns}/configmaps/${name}`;
const namespacePath = (name: string) => `/api/v1/namespaces/${name}`;
const decode = (value: string | undefined) =>
  value === undefined ? undefined : Buffer.from(value, 'base64').toString('utf8');

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
   * Per tenant, a rotation whose handled value the API server did not keep in status (a Tenant CRD
   * older than this controller prunes it). It is treated as handled, so it is not repeated on every
   * poll.
   */
  private readonly unpersisted = new Map<string, string>();
  constructor(
    private readonly api: IdentityApi,
    private readonly cfg: { installation: string; namespace: string },
    private readonly now: () => Date,
    private readonly random?: (size: number) => Buffer,
  ) {}

  private async get<T>(path: string): Promise<T | undefined> {
    try {
      return await this.api.call<T>('GET', path);
    } catch (error) {
      if ((error as { code?: number })?.code === 404) return undefined;
      throw error;
    }
  }

  /** Drops the in-memory state of tenants no longer listed. */
  forget(listed: ReadonlySet<string>): void {
    for (const name of this.logged.keys()) if (!listed.has(name)) this.logged.delete(name);
    for (const name of this.unpersisted.keys())
      if (!listed.has(name)) this.unpersisted.delete(name);
  }

  /**
   * Issues, renews and rotates the tenant's identities, and returns the conditions to report:
   * {@link SCHEDULER_IDENTITY_PENDING} while issuance cannot proceed, and {@link RENEWAL_STALLED}
   * while a host renewal's rollout is not observed. Never throws: a failure becomes the pending
   * condition, retried on the next poll.
   */
  async reconcile(tenant: Tenant): Promise<Condition[]> {
    const name = tenant.metadata.name;
    let pending: Pending | undefined;
    let stalled: string | undefined;
    try {
      ({ pending, stalled } = await this.issue(tenant));
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

  /** The CAs, or why they cannot sign yet. Key material stays in memory and out of every message. */
  private async cas(): Promise<Record<SchedulerCaKind, KeyPair> | Pending> {
    const pki = schedulerPkiNamespace(this.cfg.namespace);
    const secret = await this.get<Stored>(secretPath(pki, SCHEDULER_CA_SECRET));
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
      const fault = schedulerCaFault(kind, this.cfg.namespace, ca, this.now());
      if (fault)
        return { reason: 'CaNotReady', message: `${pki}/${SCHEDULER_CA_SECRET}: ${fault}` };
      cas[kind] = ca as KeyPair;
    }
    return cas;
  }

  /** What `secret` shows of `identity`: its expiry, digest and the ID it carries, if it verifies. */
  private observe(
    identity: Identity,
    secret: Stored | undefined,
    cas: Record<SchedulerCaKind, KeyPair>,
    hosts: HostObservation | undefined,
  ): IdentityObservation {
    const base = hosts ?? { client: 'operator' as const };
    if (!secret) return { ...base, secret: undefined };
    const cert = decode(secret.data?.['tls.crt']) ?? '';
    const key = decode(secret.data?.['tls.key']) ?? '';
    // A certificate that does not verify against its CA with its key carries no usable ID, so it
    // is re-issued for the recorded one.
    if (!issuedBy(cas[identity.ca].cert, cert, key))
      return { ...base, secret: { notAfter: new Date(0), digest: '' } };
    const dns = certificateNames(cert)?.dns ?? [];
    const id = dns.length === 1 ? issuanceIdOf(dns[0] as string) : undefined;
    return {
      ...base,
      secret: {
        notAfter: new Date(new X509Certificate(cert).validTo),
        digest: schedulerCertDigest(cert),
        ...(id && dns[0] === identity.user(id) ? { id } : {}),
      },
    };
  }

  /** The hosts' observation base: the hostgroup Deployment and its rollout of the certificate. */
  private async hostRollout(tenant: Tenant): Promise<HostObservation> {
    const n = names(tenant.metadata.name);
    const deployment = `hostgroup-${n.hostgroup}`;
    const value = await this.get<{
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
    }>(`/apis/apps/v1/namespaces/${n.runtimeNamespace}/deployments/${deployment}`);
    if (!value) return { client: 'host', deployment };
    const replicas = value.spec?.replicas ?? 1;
    const digest = value.spec?.template?.metadata?.annotations?.[SCHEDULER_TLS_ANNOTATION];
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

  private async issue(tenant: Tenant): Promise<{ pending?: Pending; stalled?: string }> {
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
    // The operator's identity waits for `di-operator-<t>`, which the cut-over (m6e) creates.
    const identities: Identity[] = [];
    for (const identity of tenantIdentities(t))
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
    const handled = (value: Tenant | undefined) =>
      (value?.status?.schedulerIdentity as SchedulerIdentityStatus | undefined)?.rotation;
    // A Tenant from a stale LIST may lack the rotation already handled, so a requested rotation is
    // confirmed against a fresh read before it draws new IDs.
    const requested =
      this.unpersisted.get(t) !== rotation && rotationRequested(rotation, handled(tenant));
    const current = requested
      ? await this.get<Tenant>(`/apis/${VERSION}/tenants/${encodeURIComponent(t)}`)
      : undefined;
    const forced = requested && rotationRequested(rotation, handled(current));
    const observed: Record<string, IdentityObservation> = {};
    for (const identity of identities) {
      const secret = listed.find(
        (s) => s.metadata.namespace === identity.namespace && s.metadata.name === identity.name,
      );
      observed[identity.key] = {
        ...this.observe(identity, secret, cas, identity.kind === 'hosts' ? hosts : undefined),
        ...(forced ? { forced } : {}),
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
          ...this.observe(identity, secret, cas, identity.kind === 'hosts' ? hosts : undefined),
          ...(forced ? { forced } : {}),
        };
      }
      next = recordTransition(record, observed, this.now(), this.random);
    }
    // The record first: a user name then always names exactly one certificate.
    const text = serializeIdentityRecord(next.record);
    if (text !== serializeIdentityRecord(record))
      await this.api.call('PUT', configMapPath(pki, SCHEDULER_IDENTITIES), {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        ...stored,
        data: { ...stored.data, [IDENTITIES_KEY]: text },
      });
    // After the record and before issuance, so an interrupted forced rotation repeats at most once.
    if (forced) {
      const updated = await this.api.call<Tenant>(
        'PATCH',
        `/apis/${VERSION}/tenants/${encodeURIComponent(t)}/status`,
        {
          // The fresh read's, so a stale LIST does not make this write conflict.
          metadata: { resourceVersion: current?.metadata.resourceVersion },
          status: { schedulerIdentity: { rotation } },
        },
        'application/merge-patch+json',
      );
      tenant.metadata = updated.metadata;
      tenant.status = { ...tenant.status, schedulerIdentity: { rotation } };
      if (handled(updated) !== rotation) this.unpersisted.set(t, rotation);
    }
    for (const identity of identities) {
      if (!issuing().includes(identity.key)) continue;
      const id = (next.record[identity.key] as { current: string }).current;
      const user = identity.user(id);
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
      const existing = fresh.get(identity.key);
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
    }
    return {
      ...(next.stalled.length > 0 ? { stalled: hosts.deployment } : {}),
      ...(this.unpersisted.get(t) === rotation
        ? {
            pending: {
              reason: 'RotationNotPersisted',
              message: `The API server did not keep status.schedulerIdentity.rotation, so the Tenant CRD may predate this controller; the rotation was applied once and is not repeated`,
            },
          }
        : {}),
    };
  }

  /**
   * Removal steps R1 (`hosts`) and R4 (`operator`): drop the tenant's entry from the record, so the
   * next accounts render leaves its user out. Done once the record holds no such entry; nothing to
   * do while the PKI does not exist.
   */
  async drop(tenant: string, kind: Kind): Promise<void> {
    const pki = schedulerPkiNamespace(this.cfg.namespace);
    const stored = await this.get<Stored>(configMapPath(pki, SCHEDULER_IDENTITIES));
    if (!stored) return;
    const record = parseIdentityRecord(stored.data?.[IDENTITIES_KEY] ?? '');
    const key = tenantIdentity(tenant, kind);
    if (!record[key]) return;
    delete record[key];
    await this.api.call('PUT', configMapPath(pki, SCHEDULER_IDENTITIES), {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      ...stored,
      data: { ...stored.data, [IDENTITIES_KEY]: serializeIdentityRecord(record) },
    });
  }
}
