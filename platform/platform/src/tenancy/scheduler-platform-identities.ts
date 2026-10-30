/**
 * The controller's renewal of the platform's own scheduler NATS identities (#541 m6e-A,
 * design-541 §4.5): the `platform/{operator,host,data}` client leaves and the NATS server leaf in
 * `di-scheduler-nats-tls`. The bootstrap Job creates them once; this module renews them, once per
 * tick, through the same m4 transitions as the tenant identities ({@link recordTransition}).
 *
 * - **Renewal only.** A Secret that is missing, was not written by this installation's bootstrap,
 *   or has no record entry is left alone: creating platform identities stays the Job's.
 * - **Fresh read.** Each Secret is read by name (never from a LIST), so what is observed is what
 *   the API server holds, and a certificate is never issued over one written since.
 * - **Record first.** The identity record is written before any client certificate is issued, so a
 *   user name always names exactly one certificate; a Secret is written under the resourceVersion
 *   it was read with.
 * - **`hostgroup-default`.** After a `platform/host` renewal the Deployment is rolled by a
 *   pod-template annotation PATCH carrying {@link schedulerCertDigest} of the new certificate,
 *   and only if it exists. `previous` is dropped once that rollout is observed; past
 *   `previousUntil` without it, the stall is logged once.
 * - **Failures** are logged once per distinct message and retried on the next tick; nothing here
 *   retries within a tick, and a steady state writes nothing.
 *
 * Inert until the cut-over (m6e-C): nothing mounts these Secrets yet. Nothing here logs a key, a
 * certificate or an issuance ID.
 */
import { X509Certificate } from 'node:crypto';
import { COMPONENT, INSTALLATION } from './resources';
import {
  getIfExists,
  type IdentityApi,
  observeHostRollout,
  observeIdentity,
  putIdentityRecord,
  readSchedulerCas,
  type Stored,
} from './scheduler-identities';
import {
  IDENTITIES_KEY,
  natsServerLeaf,
  PLATFORM_ROLES,
  PLATFORM_SECRETS,
  type PlatformRole,
  parseIdentityRecord,
  platformClientLeaf,
  platformIdentity,
  platformUser,
  SCHEDULER_IDENTITIES,
  SCHEDULER_LEAF_RENEW_DAYS,
  SCHEDULER_PKI_COMPONENT,
  type SchedulerCas,
  schedulerPkiNamespace,
  serializeIdentityRecord,
  tlsSecretData,
} from './scheduler-pki';
import {
  type IdentityObservation,
  recordTransition,
  SCHEDULER_TLS_ANNOTATION,
  schedulerCertDigest,
} from './scheduler-pki-rotation';
import { issuedBy, type KeyPair } from './tls';

/** The chart's platform host group, which presents `platform/host` and `platform/data`. */
export const PLATFORM_HOST_DEPLOYMENT = 'hostgroup-default';
const DAY_MS = 86_400_000;

const secretPath = (ns: string, name: string) => `/api/v1/namespaces/${ns}/secrets/${name}`;
const decode = (value: string | undefined) => Buffer.from(value ?? '', 'base64').toString('utf8');

export class PlatformSchedulerIdentities {
  /** The problem last logged ('' for none), so each change is logged once. */
  private logged = '';
  /** True while the `hostgroup-default` stall has been logged and not yet cleared. */
  private stallLogged = false;
  /** The digest of an issued `platform/host` certificate whose rollout PATCH has not landed. */
  private roll: string | undefined;

  constructor(
    private readonly api: IdentityApi,
    private readonly cfg: { installation: string; namespace: string },
    private readonly now: () => Date,
    private readonly random?: (size: number) => Buffer,
  ) {}

  /** Renews what is due. Never throws: a failure is logged once and retried on the next tick. */
  async reconcile(): Promise<void> {
    let problem = '';
    try {
      await this.renew();
    } catch (error) {
      problem = `renewal failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (problem !== this.logged) {
      if (problem) console.warn(`Platform scheduler identities: ${problem}`);
      this.logged = problem;
    }
  }

  /** True when `secret` was written by this installation's scheduler PKI bootstrap. */
  private owned(secret: Stored | undefined): secret is Stored {
    const labels = secret?.metadata.labels;
    return (
      labels?.[INSTALLATION] === this.cfg.installation &&
      labels?.[COMPONENT] === SCHEDULER_PKI_COMPONENT
    );
  }

  private put(secret: Stored, leaf: KeyPair, bundle: string): Promise<unknown> {
    const { namespace, name } = secret.metadata;
    return this.api.call('PUT', secretPath(namespace as string, name), {
      apiVersion: 'v1',
      kind: 'Secret',
      ...secret,
      type: 'kubernetes.io/tls',
      data: tlsSecretData(leaf, bundle),
    });
  }

  /**
   * Renews the due identities. Without a PKI namespace, a usable CA or the record there is nothing
   * to renew: the bootstrap Job has not run, and each Tenant already reports that as
   * `SchedulerIdentityPending`, so it is not logged again here.
   */
  private async renew(): Promise<void> {
    const { namespace } = this.cfg;
    const pki = schedulerPkiNamespace(namespace);
    if (!(await getIfExists(this.api, `/api/v1/namespaces/${pki}`))) return;
    const now = this.now();
    const cas = await readSchedulerCas(this.api, namespace, now);
    if ('reason' in cas) return;
    const stored = await getIfExists<Stored>(
      this.api,
      `/api/v1/namespaces/${pki}/configmaps/${SCHEDULER_IDENTITIES}`,
    );
    if (!stored) return;
    const record = parseIdentityRecord(stored.data?.[IDENTITIES_KEY] ?? '');

    const hosts = await observeHostRollout(this.api, namespace, PLATFORM_HOST_DEPLOYMENT);
    const secrets = new Map<string, { role: PlatformRole; secret: Stored }>();
    const observed: Record<string, IdentityObservation> = {};
    for (const role of PLATFORM_ROLES) {
      const key = platformIdentity(role);
      const secret = await getIfExists<Stored>(
        this.api,
        secretPath(namespace, PLATFORM_SECRETS[role]),
      );
      if (!this.owned(secret) || !record[key]) continue;
      secrets.set(key, { role, secret });
      observed[key] = observeIdentity<IdentityObservation>(
        role === 'host' ? hosts : { client: 'operator' },
        secret,
        cas.platform.cert,
        (id) => platformUser(role, id),
      );
    }
    const next = recordTransition(record, observed, now, this.random);
    // The record first: a user name then always names exactly one certificate.
    if (serializeIdentityRecord(next.record) !== serializeIdentityRecord(record))
      await putIdentityRecord(this.api, pki, stored, next.record);
    let annotate: string | undefined;
    for (const [key, transition] of next.transitions) {
      const { role, secret } = secrets.get(key) as { role: PlatformRole; secret: Stored };
      if (transition.action === 'keep') {
        annotate ??= transition.annotate?.[SCHEDULER_TLS_ANNOTATION];
        continue;
      }
      const leaf = platformClientLeaf(role, transition.entry.current, cas.platform, now);
      await this.put(secret, leaf, cas.platform.cert);
      if (role === 'host') this.roll = schedulerCertDigest(leaf.cert);
    }
    await this.renewServer(cas, now);
    await this.rollHosts(hosts, this.roll ?? annotate);
    const stalled = next.stalled.length > 0;
    if (stalled && !this.stallLogged)
      console.warn(
        `Platform scheduler identities: Deployment ${namespace}/${PLATFORM_HOST_DEPLOYMENT} has not rolled out the renewed scheduler certificate; the previous user stays admitted`,
      );
    this.stallLogged = stalled;
  }

  /**
   * Rolls `hostgroup-default` to the certificate `digest`: only if it exists, and only after a
   * renewal issued here or once its template already carries another digest (a PATCH that
   * failed after issuance in an earlier run), so a Deployment never annotated is not restarted.
   */
  private async rollHosts(
    hosts: Awaited<ReturnType<typeof observeHostRollout>>,
    digest: string | undefined,
  ): Promise<void> {
    const { rollout } = hosts;
    if (!rollout || !digest || rollout.digest === digest) {
      if (rollout) this.roll = undefined;
      return;
    }
    if (!this.roll && rollout.digest === undefined) return;
    await this.api.call(
      'PATCH',
      `/apis/apps/v1/namespaces/${this.cfg.namespace}/deployments/${PLATFORM_HOST_DEPLOYMENT}`,
      { spec: { template: { metadata: { annotations: { [SCHEDULER_TLS_ANNOTATION]: digest } } } } },
      'application/merge-patch+json',
    );
    this.roll = undefined;
  }

  /**
   * Re-issues the NATS server leaf in `di-scheduler-nats-tls` when it has at most
   * {@link SCHEDULER_LEAF_RENEW_DAYS} days left or does not verify against the platform CA: same
   * CA, same Service names, and the bundle of both CAs, as the bootstrap writes it.
   */
  private async renewServer(cas: SchedulerCas, now: Date): Promise<void> {
    const { namespace } = this.cfg;
    const secret = await getIfExists<Stored>(
      this.api,
      secretPath(namespace, PLATFORM_SECRETS.server),
    );
    if (!this.owned(secret)) return;
    const cert = decode(secret.data?.['tls.crt']);
    const valid =
      issuedBy(cas.platform.cert, cert, decode(secret.data?.['tls.key'])) &&
      new Date(new X509Certificate(cert).validTo).getTime() >
        now.getTime() + SCHEDULER_LEAF_RENEW_DAYS * DAY_MS;
    if (valid) return;
    await this.put(
      secret,
      natsServerLeaf(namespace, cas.platform, now),
      `${cas.platform.cert}${cas.tenant.cert}`,
    );
  }
}
