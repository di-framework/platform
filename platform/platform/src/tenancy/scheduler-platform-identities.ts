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
 * - **`hostgroup-default`** presents `platform/host` and, on its DATA connection, `platform/data`,
 *   so both follow the host rule: each `previous` is dropped only once the Deployment has rolled
 *   out that role's current certificate, whose {@link schedulerCertDigest} its pod template
 *   carries ({@link SCHEDULER_TLS_ANNOTATION} for host, {@link SCHEDULER_DATA_TLS_ANNOTATION} for
 *   data). Both annotations go in one PATCH, after a renewal of either role, and only if the
 *   Deployment exists. Whether a roll is still due is derived from persisted state (an entry with
 *   `previous`, a Secret carrying `current`, a template digest that differs), so a restart between
 *   the Secret write and the PATCH still rolls. Past `previousUntil` without the rollout the stall
 *   is logged once. Without the Deployment, `previous` stays recorded (and its user rendered) until
 *   the next renewal, as for a tenant whose host group is absent.
 * - **Secret after propagation (m6e-E).** The pods mount these Secrets by name, so a renewed
 *   certificate is written only once its user has propagated ({@link AccountsPropagation}); until
 *   then the Secret keeps the previous certificate, whose user stays admitted, and the roll waits
 *   with it. These Secrets are never deleted: they are renewed, never force-rotated here.
 * - **The server leaf** is not a NATS user: clients verify it against the platform CA set, so it is
 *   re-issued without the wait.
 * - **CA rotation (#629).** {@link loadSchedulerCas} advances the rotation of both scheduler CAs
 *   first. A published successor joins the server's bundle at once and, through a renewal, each
 *   client's `ca.crt`; after the switch every leaf the old CA signed, the server's included, is
 *   re-signed by the new one. A rotation that cannot be written is logged and retried; renewal
 *   goes on under the CA that still signs.
 * - **Failures** are logged once per distinct message and retried on the next tick; nothing here
 *   retries within a tick, and a steady state writes nothing.
 *
 * Inert until the cut-over (m6e-C): nothing mounts these Secrets yet. Nothing here logs a key, a
 * certificate or an issuance ID.
 */
import { X509Certificate } from 'node:crypto';
import { COMPONENT, INSTALLATION } from './resources';
import {
  cappedByCa,
  deploymentPath,
  getIfExists,
  type HostDeployment,
  hostRolloutOf,
  type IdentityApi,
  loadSchedulerCas,
  observeIdentity,
  putIdentityRecord,
  type Stored,
} from './scheduler-identities';
import { SCHEDULER_NATS_ACCOUNTS } from './scheduler-nats';
import {
  IDENTITIES_KEY,
  type IdentityRecord,
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
  schedulerClientBundle,
  schedulerPkiNamespace,
  schedulerServerBundle,
  serializeIdentityRecord,
  tlsSecretData,
} from './scheduler-pki';
import {
  type IdentityObservation,
  type IdentityTransition,
  recordTransition,
  SCHEDULER_TLS_ANNOTATION,
  schedulerCertDigest,
} from './scheduler-pki-rotation';
import { AccountsPropagation, type Propagation, PropagationWaits } from './scheduler-propagation';
import { issuedBy, type KeyPair } from './tls';

/** The chart's platform host group, which presents `platform/host` and `platform/data`. */
export const PLATFORM_HOST_DEPLOYMENT = 'hostgroup-default';
/** The pod-template annotation carrying the digest of the `platform/data` certificate. */
export const SCHEDULER_DATA_TLS_ANNOTATION = 'platform.di-framework.dev/scheduler-data-tls-sha256';
/** The pod-template annotation each host-group role's certificate digest goes in. */
const ROLL_ANNOTATIONS: Partial<Record<PlatformRole, string>> = {
  host: SCHEDULER_TLS_ANNOTATION,
  data: SCHEDULER_DATA_TLS_ANNOTATION,
};
const DAY_MS = 86_400_000;

const secretPath = (ns: string, name: string) => `/api/v1/namespaces/${ns}/secrets/${name}`;
const decode = (value: string | undefined) => Buffer.from(value ?? '', 'base64').toString('utf8');

/** What one tick read: the CAs, the record and `hostgroup-default`. */
interface Context {
  pki: string;
  now: Date;
  cas: SchedulerCas;
  /** Why this tick's CA rotation was not written, if it was not. */
  rotationFailed?: string;
  stored: Stored;
  record: IdentityRecord;
  deployment: HostDeployment | undefined;
}

/** A host-group annotation the Deployment should carry, and whether it must be rolled to it. */
interface RollTarget {
  annotation: string;
  digest: string;
  due: boolean;
}

export class PlatformSchedulerIdentities {
  /** The problem last logged ('' for none), so each change is logged once. */
  private logged = '';
  /** True while the `hostgroup-default` stall has been logged and not yet cleared. */
  private stallLogged = false;
  /** True while the platform CA's approaching expiry has been logged (#612). */
  private caLogged = false;
  /** Per record key, how long its renewed user has waited to propagate, and which were logged. */
  private readonly waits = new PropagationWaits();
  private readonly waitLogged = new Set<string>();

  constructor(
    private readonly api: IdentityApi,
    private readonly cfg: { installation: string; namespace: string },
    private readonly now: () => Date,
    private readonly random?: (size: number) => Buffer,
    private readonly propagation: Propagation = new AccountsPropagation(api, cfg.namespace, now),
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
   * The tick's context. Without a PKI namespace, a usable CA or the record there is nothing to
   * renew: the bootstrap Job has not run, and each Tenant already reports that as
   * `SchedulerIdentityPending`, so it is not logged again here.
   */
  private async context(): Promise<Context | undefined> {
    const { namespace } = this.cfg;
    const pki = schedulerPkiNamespace(namespace);
    if (!(await getIfExists(this.api, `/api/v1/namespaces/${pki}`))) return undefined;
    const now = this.now();
    const loaded = await loadSchedulerCas(this.api, namespace, now);
    if ('reason' in loaded) return undefined;
    const { cas, rotationFailed } = loaded;
    const stored = await getIfExists<Stored>(
      this.api,
      `/api/v1/namespaces/${pki}/configmaps/${SCHEDULER_IDENTITIES}`,
    );
    if (!stored) return undefined;
    const record = parseIdentityRecord(stored.data?.[IDENTITIES_KEY] ?? '');
    const deployment = await getIfExists<HostDeployment>(
      this.api,
      deploymentPath(namespace, PLATFORM_HOST_DEPLOYMENT),
    );
    return {
      pki,
      now,
      cas,
      ...(rotationFailed ? { rotationFailed } : {}),
      stored,
      record,
      deployment,
    };
  }

  /** Renews the due identities, then the server leaf, then rolls `hostgroup-default`. */
  private async renew(): Promise<void> {
    const ctx = await this.context();
    if (!ctx) return;
    const { secrets, observed } = await this.observe(ctx);
    const next = recordTransition(ctx.record, observed, ctx.now, this.random);
    // The record first: a user name then always names exactly one certificate.
    if (serializeIdentityRecord(next.record) !== serializeIdentityRecord(ctx.record))
      await putIdentityRecord(this.api, ctx.pki, ctx.stored, next.record);
    const targets: RollTarget[] = [];
    const issuing = next.transitions.some(([, t]) => t.action === 'issue');
    const propagated = issuing ? await this.propagation.read() : () => false;
    for (const [key, transition] of next.transitions) {
      const { role, secret } = secrets.get(key) as { role: PlatformRole; secret: Stored };
      const user = platformUser(role, transition.entry.current);
      if (transition.action === 'issue' && !propagated(user)) {
        this.logWait(key, user, ctx.now);
        continue;
      }
      this.waits.done(key);
      this.waitLogged.delete(key);
      const target = await this.apply(ctx, role, secret, transition);
      if (target) targets.push(target);
    }
    await this.renewServer(ctx.cas, ctx.now);
    await this.rollHosts(ctx.deployment, targets);
    this.logStall(next.stalled.length > 0);
    this.logCaExpiring(next.caExpiring.length > 0, ctx.cas.platform.current.cert);
    // Logged once by `reconcile`, after this tick's renewals under the CA that still signs.
    if (ctx.rotationFailed) throw new Error(ctx.rotationFailed);
  }

  /** Logs once that the platform CA caps the identities it signs, until it no longer does (#612). */
  private logCaExpiring(expiring: boolean, ca: string): void {
    if (expiring && !this.caLogged)
      console.warn(
        `Platform scheduler identities: the scheduler platform CA expires ${new X509Certificate(ca).validTo}; certificates it signs cannot outlive it, so they are not renewed until the CA is replaced`,
      );
    this.caLogged = expiring;
  }

  /** The owned, recorded platform Secrets, and their observations. */
  private async observe(ctx: Context) {
    const secrets = new Map<string, { role: PlatformRole; secret: Stored }>();
    const observed: Record<string, IdentityObservation> = {};
    for (const role of PLATFORM_ROLES) {
      const key = platformIdentity(role);
      const secret = await getIfExists<Stored>(
        this.api,
        secretPath(this.cfg.namespace, PLATFORM_SECRETS[role]),
      );
      if (!this.owned(secret) || !ctx.record[key]) continue;
      secrets.set(key, { role, secret });
      const annotation = ROLL_ANNOTATIONS[role];
      observed[key] = observeIdentity<IdentityObservation>(
        annotation
          ? hostRolloutOf(ctx.deployment, PLATFORM_HOST_DEPLOYMENT, annotation)
          : { client: 'operator' },
        secret,
        ctx.cas.platform,
        (id) => platformUser(role, id),
        schedulerClientBundle(ctx.cas),
      );
    }
    return { secrets, observed };
  }

  /**
   * Issues `role`'s certificate when `transition` says so. For a host-group role, returns the
   * annotation the Deployment should carry. It is due after an issuance, and otherwise while the
   * template differs from it and either a `previous` waits for the roll (persisted, so a restart
   * before the PATCH still rolls) or the template already carries another digest.
   */
  private async apply(
    ctx: Context,
    role: PlatformRole,
    secret: Stored,
    transition: IdentityTransition,
  ): Promise<RollTarget | undefined> {
    const annotation = ROLL_ANNOTATIONS[role];
    if (transition.action === 'issue') {
      const leaf = platformClientLeaf(
        role,
        transition.entry.current,
        ctx.cas.platform.current,
        ctx.now,
      );
      await this.put(secret, leaf, schedulerClientBundle(ctx.cas));
      return annotation
        ? { annotation, digest: schedulerCertDigest(leaf.cert), due: true }
        : undefined;
    }
    const digest = transition.annotate?.[SCHEDULER_TLS_ANNOTATION];
    if (!annotation || !digest) return undefined;
    const carried = ctx.deployment?.spec?.template?.metadata?.annotations?.[annotation];
    const waiting = transition.entry.previous !== undefined || carried !== undefined;
    return { annotation, digest, due: waiting && carried !== digest };
  }

  /**
   * Rolls `hostgroup-default` when any of `targets` is due, setting every target annotation in one
   * PATCH; only if it exists, so a Deployment never installed is not created.
   */
  private async rollHosts(
    deployment: HostDeployment | undefined,
    targets: RollTarget[],
  ): Promise<void> {
    if (!deployment || !targets.some((t) => t.due)) return;
    const annotations = Object.fromEntries(targets.map((t) => [t.annotation, t.digest]));
    await this.api.call(
      'PATCH',
      deploymentPath(this.cfg.namespace, PLATFORM_HOST_DEPLOYMENT),
      { spec: { template: { metadata: { annotations } } } },
      'application/merge-patch+json',
    );
  }

  /** Logs once that `key`'s user has waited past the bound to propagate, until it is written. */
  private logWait(key: string, user: string, now: Date): void {
    const since = this.waits.overdue(key, user, now);
    if (!since || this.waitLogged.has(key)) return;
    this.waitLogged.add(key);
    console.warn(
      `Platform scheduler identities: ${key} has waited since ${since.toISOString()} for ${SCHEDULER_NATS_ACCOUNTS} to name its renewed user; the previous certificate stays in its Secret`,
    );
  }

  /** Logs a `hostgroup-default` stall once, until it clears. */
  private logStall(stalled: boolean): void {
    if (stalled && !this.stallLogged)
      console.warn(
        `Platform scheduler identities: Deployment ${this.cfg.namespace}/${PLATFORM_HOST_DEPLOYMENT} has not rolled out the renewed scheduler certificate; the previous user stays admitted`,
      );
    this.stallLogged = stalled;
  }

  /**
   * Re-issues the NATS server leaf in `di-scheduler-nats-tls` when it has at most
   * {@link SCHEDULER_LEAF_RENEW_DAYS} days left (unless it already expires with the CA, #612), does
   * not verify against the signing platform CA (after a switch, #629), or its `ca.crt` is not the
   * bundle of both CA sets (a successor was published or an old CA retired): signed by the signing
   * platform CA, for the same Service names, with that bundle, as the bootstrap writes it.
   */
  private async renewServer(cas: SchedulerCas, now: Date): Promise<void> {
    const { namespace } = this.cfg;
    const secret = await getIfExists<Stored>(
      this.api,
      secretPath(namespace, PLATFORM_SECRETS.server),
    );
    if (!this.owned(secret)) return;
    const cert = decode(secret.data?.['tls.crt']);
    const valid = (pem: string) => {
      const notAfter = new Date(new X509Certificate(pem).validTo);
      return (
        notAfter.getTime() > now.getTime() + SCHEDULER_LEAF_RENEW_DAYS * DAY_MS ||
        cappedByCa(notAfter, cas.platform.current.cert)
      );
    };
    const bundle = schedulerServerBundle(cas);
    if (
      issuedBy(cas.platform.current.cert, cert, decode(secret.data?.['tls.key'])) &&
      valid(cert) &&
      decode(secret.data?.['ca.crt']) === bundle
    )
      return;
    await this.put(secret, natsServerLeaf(namespace, cas.platform.current, now), bundle);
  }
}
