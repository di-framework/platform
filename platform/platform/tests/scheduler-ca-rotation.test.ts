import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import {
  CA_OVERLAP_DAYS,
  CA_RENEW_DAYS,
  CA_SWITCH_DEADLINE_DAYS,
  type ControllerCas,
} from '../src/tenancy/ca-rotation';
import { ApiError } from '../src/tenancy/controller';
import { COMPONENT, INSTALLATION, names, OWNER, type Resource } from '../src/tenancy/resources';
import {
  bundleTrusts,
  loadSchedulerCas,
  observeIdentity,
  SCHEDULER_CA_EXPIRING,
  SCHEDULER_IDENTITY_COMPONENT,
  TENANT_HOST_SECRET,
} from '../src/tenancy/scheduler-identities';
import {
  bootstrapSchedulerPki,
  CA_KEYS,
  IDENTITIES_KEY,
  newSchedulerCa,
  nextSchedulerCas,
  PLATFORM_SECRETS,
  platformClientLeaf,
  platformUser,
  readSchedulerCaSet,
  SCHEDULER_CA_DAYS,
  SCHEDULER_CA_SECRET,
  SCHEDULER_IDENTITIES,
  type SchedulerCaKind,
  type SchedulerCas,
  schedulerCaData,
  schedulerCaFault,
  schedulerClientBundle,
  schedulerServerBundle,
  storedSchedulerCas,
  tlsSecretData,
} from '../src/tenancy/scheduler-pki';
import {
  type HostObservation,
  identityTransition,
  type OperatorObservation,
  SCHEDULER_TLS_ANNOTATION,
  schedulerCertDigest,
} from '../src/tenancy/scheduler-pki-rotation';
import { PlatformSchedulerIdentities } from '../src/tenancy/scheduler-platform-identities';
import { TENANT_OPERATOR_PROPAGATION_MS } from '../src/tenancy/tenant-operator';
import { caCertificate, issuedBy, type KeyPair } from '../src/tenancy/tls';
import {
  cfg,
  condition,
  MemoryApi,
  PKI,
  prepare as prepareHarness,
  recordPath,
  START,
} from './support/controller-harness';

// #629: both scheduler CAs rotate through a current/next set before they expire (design-541
// §4.5 "Lifetimes"): publish a successor CA_RENEW_DAYS before expiry, trust both for
// CA_OVERLAP_DAYS, switch and re-sign every leaf once, then retire the old CA when it expires.

const DAY = 86_400_000;
const NS = cfg.namespace;
const KINDS = ['platform', 'tenant'] as const;
const caPath = `/api/v1/namespaces/${PKI}/secrets/${SCHEDULER_CA_SECRET}`;
const platformPath = (name: string) => `/api/v1/namespaces/${NS}/secrets/${name}`;
const serverPath = platformPath(PLATFORM_SECRETS.server);
const clientPaths = (['operator', 'host', 'data'] as const).map((r) =>
  platformPath(PLATFORM_SECRETS[r]),
);
const hostPath = `/api/v1/namespaces/${names('alpha').runtimeNamespace}/secrets/${TENANT_HOST_SECRET}`;
const operatorPath = '/api/v1/namespaces/di-operator-alpha/secrets/di-scheduler-operator-tls';
const b64 = (text: string) => Buffer.from(text).toString('base64');
const decode = (value: string | undefined) => Buffer.from(value ?? '', 'base64').toString('utf8');
const print = (pem: string) => new X509Certificate(pem).fingerprint256;
const endOf = (pem: string) => new Date(new X509Certificate(pem).validTo).getTime();
const startOf = (pem: string) => new Date(new X509Certificate(pem).validFrom).getTime();

/** A CA of `kind` that expires `days` days after `from`. */
const caEnding = (kind: SchedulerCaKind, from: Date, days: number) =>
  newSchedulerCa(kind, NS, new Date(from.getTime() - (SCHEDULER_CA_DAYS - days) * DAY));

describe('nextSchedulerCas: the scheduler CA set (#629)', () => {
  it('returns the fault of a missing signing CA without creating one', () => {
    expect(nextSchedulerCas('platform', NS, {}, START)).toContain('missing');
    expect(nextSchedulerCas('tenant', NS, { current: { cert: 'x' } }, START)).toContain('missing');
  });
  it('promotes a usable successor when the signing CA is unusable, without keeping the old one', () => {
    for (const kind of KINDS) {
      const next = caEnding(kind, START, 3000);
      const expired = caEnding(kind, START, -1);
      const set = nextSchedulerCas(kind, NS, { current: expired, next }, START) as ControllerCas;
      expect(set).toEqual({ current: next });
      // A successor of the other kind is not usable: the fault stays.
      const other = caEnding(kind === 'platform' ? 'tenant' : 'platform', START, 3000);
      expect(nextSchedulerCas(kind, NS, { current: expired, next: other }, START)).toContain(
        'expired',
      );
    }
  });

  it('publishes one successor in the renewal window, switches after the overlap and retires the old CA at its expiry', () => {
    for (const kind of KINDS) {
      const old = caEnding(kind, START, 200);
      const end = endOf(old.cert);
      // Outside the window nothing changes.
      expect(nextSchedulerCas(kind, NS, { current: old }, START)).toEqual({ current: old });
      // Publish: a successor with the kind's exact constraints, the old CA still signs.
      const publishAt = new Date(end - (CA_RENEW_DAYS - 1) * DAY);
      const published = nextSchedulerCas(kind, NS, { current: old }, publishAt) as ControllerCas;
      expect(published.current).toEqual(old);
      const next = published.next as KeyPair;
      expect(schedulerCaFault(kind, NS, next, publishAt)).toBeUndefined();
      expect(endOf(next.cert)).toBeGreaterThan(end);
      // Stable while it waits: the same successor, not another.
      const waiting = new Date(publishAt.getTime() + (CA_OVERLAP_DAYS - 1) * DAY);
      expect(nextSchedulerCas(kind, NS, published, waiting)).toEqual(published);
      // Switch, once every holder trusts the successor: it signs, the old CA is kept as previous
      // until it expires.
      const switchAt = new Date(startOf(next.cert) + (CA_OVERLAP_DAYS + 1) * DAY);
      expect(nextSchedulerCas(kind, NS, published, switchAt)).toEqual(published);
      const switched = nextSchedulerCas(kind, NS, published, switchAt, true) as ControllerCas;
      expect(switched).toEqual({ current: next, previous: old.cert });
      expect(nextSchedulerCas(kind, NS, switched, new Date(end - DAY))).toEqual(switched);
      // Retire.
      expect(nextSchedulerCas(kind, NS, switched, new Date(end + 60_000))).toEqual({
        current: next,
      });
    }
  });

  it('never switches in the pass that publishes, waits for the holders, and switches at the deadline (W1)', () => {
    for (const kind of KINDS) {
      // Late: under 30 days left and no successor stored. It is published, never switched to in
      // that pass, even with every holder trusting and even in the CA's last day.
      const old = caEnding(kind, START, 20);
      const end = endOf(old.cert);
      const published = nextSchedulerCas(kind, NS, { current: old }, START, true) as ControllerCas;
      expect(published.current).toEqual(old);
      const next = published.next as KeyPair;
      expect(schedulerCaFault(kind, NS, next, START)).toBeUndefined();
      const lastDay = new Date(end - DAY / 2);
      expect(
        (nextSchedulerCas(kind, NS, { current: old }, lastDay, true) as ControllerCas).current,
      ).toEqual(old);
      // A later pass: it waits while a holder lacks the successor, and switches once none does.
      expect(nextSchedulerCas(kind, NS, published, START)).toEqual(published);
      const switched = { current: next, previous: old.cert };
      expect(nextSchedulerCas(kind, NS, published, START, true)).toEqual(switched);
      // The hard deadline: a holder that never takes it up does not block the switch.
      const before = new Date(end - (CA_SWITCH_DEADLINE_DAYS + 0.5) * DAY);
      expect(nextSchedulerCas(kind, NS, published, before)).toEqual(published);
      const deadline = new Date(end - (CA_SWITCH_DEADLINE_DAYS - 0.5) * DAY);
      expect(nextSchedulerCas(kind, NS, published, deadline)).toEqual(switched);
    }
  });

  it('replaces a successor that does not carry the kind constraints', () => {
    const old = caEnding('tenant', START, 60);
    const wrong = caCertificate('stranger', SCHEDULER_CA_DAYS, START, ['example.com'], true);
    const set = nextSchedulerCas('tenant', NS, { current: old, next: wrong }, START);
    const next = (set as ControllerCas).next as KeyPair;
    expect(print(next.cert)).not.toBe(print(wrong.cert));
    expect(schedulerCaFault('tenant', NS, next, START)).toBeUndefined();
    // Outside the window it is only dropped.
    const fresh = caEnding('tenant', START, 3000);
    expect(nextSchedulerCas('tenant', NS, { current: fresh, next: wrong }, START)).toEqual({
      current: fresh,
    });
  });
});

describe('readSchedulerCaSet, storedSchedulerCas, schedulerCaData and the bundles (#629)', () => {
  it('reads a set as stored, leaving out an unusable successor and a retired previous', () => {
    // Created a day ago, so the previous CA it succeeded stays until it expires.
    const current = caEnding('platform', START, SCHEDULER_CA_DAYS - 1);
    const next = caEnding('platform', START, 3600);
    const previous = caEnding('platform', START, 10).cert;
    const retired = caEnding('platform', START, -1).cert;
    expect(readSchedulerCaSet('platform', NS, { current, next, previous }, START)).toEqual({
      current,
      next,
      previous,
    });
    expect(
      readSchedulerCaSet(
        'platform',
        NS,
        { current, next: { cert: next.cert }, previous: retired },
        START,
      ),
    ).toEqual({ current });
    expect(
      readSchedulerCaSet('platform', NS, { current: next, previous: 'garbage' }, START),
    ).toEqual({ current: next });
    expect(readSchedulerCaSet('platform', NS, {}, START)).toContain('missing');
  });

  it('bounds previous as the rotation does, so a refused write trusts nothing longer (S1)', () => {
    // A CA that replaced the previous one 650 days ago keeps it only CA_OVERLAP_DAYS, not until
    // the previous CA expires (its key may have been lost or leaked).
    const current = caEnding('platform', START, 3000);
    const previous = caEnding('platform', START, 10).cert;
    expect(readSchedulerCaSet('platform', NS, { current, previous }, START)).toEqual({ current });
    expect(nextSchedulerCas('platform', NS, { current, previous }, START)).toEqual({ current });
  });

  it('round-trips a set through the Secret data, and removes absent parts', () => {
    const set: ControllerCas = {
      current: caEnding('tenant', START, 3000),
      next: caEnding('tenant', START, 3600),
      previous: caEnding('tenant', START, 10).cert,
    };
    const data = schedulerCaData('tenant', set);
    expect(Object.keys(data).sort()).toEqual(Object.values(CA_KEYS.tenant).sort());
    expect(storedSchedulerCas(data as Record<string, string>, 'tenant')).toEqual(set);
    const only = schedulerCaData('tenant', { current: set.current });
    expect(only[CA_KEYS.tenant.nextCert]).toBeUndefined();
    expect(only[CA_KEYS.tenant.previous]).toBeUndefined();
    expect(storedSchedulerCas(undefined, 'tenant')).toEqual({ current: {} });
    expect(storedSchedulerCas({ [CA_KEYS.tenant.nextKey]: b64('k') }, 'tenant').next).toEqual({
      key: 'k',
    });
  });

  it('bundles the platform set for clients and both sets for the server, oldest first', () => {
    const cas: SchedulerCas = {
      platform: { current: { cert: 'P1', key: '' }, next: { cert: 'P2', key: '' }, previous: 'P0' },
      tenant: { current: { cert: 'T1', key: '' } },
    };
    expect(schedulerClientBundle(cas)).toBe('P0P1P2');
    expect(schedulerServerBundle(cas)).toBe('P0P1P2T1');
  });

  it('bundleTrusts compares certificates by fingerprint, in any order, skipping unparseable blocks', () => {
    const a = caEnding('platform', START, 3000).cert;
    const b = caEnding('platform', START, 3100).cert;
    const junk = '-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----\n';
    expect(bundleTrusts(`${b}${a}`, `${a}${b}`)).toBe(true);
    expect(bundleTrusts(`${junk}${a}`, a)).toBe(true);
    expect(bundleTrusts(a, `${a}${b}`)).toBe(false);
    expect(bundleTrusts('', a)).toBe(false);
  });
});

describe('a leaf observed during a CA rotation (#629)', () => {
  const old = caEnding('platform', START, 60);
  const next = caEnding('platform', START, 3600);
  const user = (id: string) => platformUser('operator', id);
  const ID = 'aaaaaaaaaaaaaaaa';
  const leafFrom = (ca: KeyPair, bundle: string) => ({
    data: tlsSecretData(platformClientLeaf('operator', ID, ca, START), bundle),
  });
  const observe = (secret: { data: Record<string, string> }, cas: ControllerCas) =>
    observeIdentity<OperatorObservation>(
      { client: 'operator' },
      secret,
      cas,
      user,
      [cas.previous, cas.current.cert, cas.next?.cert].filter(Boolean).join(''),
    );

  it('is stale while its bundle lacks the published successor, and capped by its CA', () => {
    const secret = observe(leafFrom(old, old.cert), { current: old, next }).secret;
    expect(secret).toMatchObject({ id: ID, stale: true, capped: true });
    const trusted = observe(leafFrom(old, `${old.cert}${next.cert}`), { current: old, next });
    expect(trusted.secret?.stale).toBeUndefined();
  });

  it('is stale once the CA that signed it is only previous, and unusable once that CA is gone', () => {
    const bundle = `${old.cert}${next.cert}`;
    const secret = observe(leafFrom(old, bundle), { current: next, previous: old.cert }).secret;
    expect(secret).toMatchObject({ id: ID, stale: true });
    expect(observe(leafFrom(old, bundle), { current: next }).secret).toEqual({
      notAfter: new Date(0),
      digest: '',
    });
    expect(
      observe(leafFrom(next, bundle), { current: next, previous: old.cert }).secret?.stale,
    ).toBe(undefined);
  });

  it('a stale leaf is renewed even when capped, unlike a capped leaf that is only due', () => {
    const notAfter = new Date(START.getTime() + 10 * DAY);
    const capped = { notAfter, digest: 'd', id: ID, capped: true };
    const random = () => Buffer.alloc(8, 7);
    expect(
      identityTransition({ current: ID }, { client: 'operator', secret: capped }, START, random),
    ).toMatchObject({ action: 'keep', caExpiring: true });
    expect(
      identityTransition(
        { current: ID },
        { client: 'operator', secret: { ...capped, stale: true } },
        START,
        random,
      ),
    ).toMatchObject({ action: 'issue', reason: 'renewal', entry: { previous: ID } });
  });

  it('a stale leaf waits for a renewal in progress, so the user running pods present stays (W2)', () => {
    const B = 'bbbbbbbbbbbbbbbb';
    const A = 'cccccccccccccccc';
    const secret = { notAfter: new Date(START.getTime() + 80 * DAY), digest: 'dB', id: B };
    const stale = { ...secret, stale: true };
    const random = () => Buffer.alloc(8, 9);
    const midRollout = {
      current: B,
      previous: A,
      previousUntil: new Date(START.getTime() + 5 * 60_000).toISOString(),
    };
    const host = (complete: boolean, digest = 'dB'): HostObservation => ({
      client: 'host',
      deployment: 'hostgroup-tenant-alpha',
      rollout: { deployment: 'hostgroup-tenant-alpha', digest, complete },
      secret: stale,
    });
    // The reviewer's probe: a host mid-rollout keeps {current: B, previous: A}.
    expect(identityTransition(midRollout, host(false), START, random)).toMatchObject({
      action: 'keep',
      entry: midRollout,
    });
    // Past previousUntil with the rollout still not observed: kept, reported as stalled.
    const late = new Date(START.getTime() + 6 * 60_000);
    expect(identityTransition(midRollout, host(false), late, random)).toMatchObject({
      action: 'keep',
      entry: midRollout,
      stalled: { deployment: 'hostgroup-tenant-alpha' },
    });
    // Once the rollout is observed, `previous` is dropped; the next pass renews.
    const done = identityTransition(midRollout, host(true), START, random);
    expect(done).toMatchObject({ action: 'keep', entry: { current: B } });
    expect(identityTransition(done.entry, host(true), START, random)).toMatchObject({
      action: 'issue',
      entry: { previous: B },
    });
    // An operator inside previousUntil keeps it; past it, `previous` is dropped first.
    const operator: OperatorObservation = { client: 'operator', secret: stale };
    expect(identityTransition(midRollout, operator, START, random)).toMatchObject({
      action: 'keep',
      entry: midRollout,
    });
    expect(identityTransition(midRollout, operator, late, random)).toMatchObject({
      action: 'keep',
      entry: { current: B },
    });
    // A host group with no Deployment has no pod presenting either user: renewed at once.
    expect(
      identityTransition(
        midRollout,
        { client: 'host', deployment: 'hostgroup-tenant-alpha', secret: stale },
        START,
        random,
      ),
    ).toMatchObject({ action: 'issue', entry: { previous: B } });
  });
});

class RotationApi extends MemoryApi {
  /** Refuses writes of `di-scheduler-ca` while set. */
  refuseCa = false;
  override async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.refuseCa && method === 'PUT' && path === caPath) {
      this.operations.push({ method, path, body });
      throw new ApiError(409, 'Conflict');
    }
    const result = await super.call<T>(method, path, body);
    // Every Deployment rollout completes at once, as a kubelet would after the pods roll.
    const deployment = this.objects.get(path.split('?')[0] as string) as
      | (Resource & { spec?: { replicas?: number }; status?: Record<string, unknown> })
      | undefined;
    if (method === 'PATCH' && deployment?.kind === 'Deployment') {
      const replicas = deployment.spec?.replicas ?? 1;
      deployment.status = {
        ...deployment.status,
        updatedReplicas: replicas,
        readyReplicas: replicas,
      };
    }
    return result;
  }
  writes(path: string): number {
    return this.operations.filter((o) => o.method !== 'GET' && o.path === path).length;
  }
}

/** Seeds `di-scheduler-ca` with one set per kind, as the bootstrap or a rotation writes it. */
function seedCas(api: MemoryApi, sets: SchedulerCas): void {
  const data: Record<string, string> = {};
  for (const kind of KINDS)
    for (const [key, value] of Object.entries(schedulerCaData(kind, sets[kind])))
      if (value !== undefined) data[key] = value;
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: SCHEDULER_CA_SECRET, namespace: PKI },
    type: 'Opaque',
    data,
  } as unknown as Resource);
}
const caData = (api: MemoryApi) =>
  (api.objects.get(caPath) as unknown as { data: Record<string, string> }).data;
const storedSet = (api: MemoryApi, kind: SchedulerCaKind) => storedSchedulerCas(caData(api), kind);

describe('loadSchedulerCas (#629)', () => {
  it('waits for the bootstrap, and reports a broken signing CA without writing', async () => {
    const api = new RotationApi();
    expect(await loadSchedulerCas(api, cfg, START)).toMatchObject({ reason: 'CaNotReady' });
    seedCas(api, {
      platform: { current: caEnding('platform', START, 3000) },
      tenant: { current: caEnding('platform', START, 3000) },
    });
    const read = await loadSchedulerCas(api, cfg, START);
    expect(read).toMatchObject({ reason: 'CaNotReady' });
    expect((read as { message: string }).message).toContain('tenant CA does not carry');
    expect(api.writes(caPath)).toBe(0);
  });

  it('writes a rotation once, under the read resourceVersion, and nothing while it is unchanged', async () => {
    const api = new RotationApi();
    const platform = caEnding('platform', START, 60);
    const tenant = caEnding('tenant', START, 3000);
    seedCas(api, { platform: { current: platform }, tenant: { current: tenant } });
    const first = await loadSchedulerCas(api, cfg, START);
    expect(api.writes(caPath)).toBe(1);
    const cas = (first as { cas: SchedulerCas }).cas;
    expect(cas.platform.current).toEqual(platform);
    expect(cas.tenant).toEqual({ current: tenant });
    expect(storedSet(api, 'platform').next).toEqual(cas.platform.next as KeyPair);
    expect(await loadSchedulerCas(api, cfg, START)).toEqual({ cas });
    expect(api.writes(caPath)).toBe(1);
  });

  it('keeps signing with the stored set when the rotation cannot be written', async () => {
    const api = new RotationApi();
    const platform = caEnding('platform', START, 60);
    const tenant = caEnding('tenant', START, 3000);
    seedCas(api, { platform: { current: platform }, tenant: { current: tenant } });
    api.refuseCa = true;
    const read = await loadSchedulerCas(api, cfg, START);
    expect(read).toEqual({
      cas: { platform: { current: platform }, tenant: { current: tenant } },
      rotationFailed: `the scheduler CA rotation write to ${PKI}/${SCHEDULER_CA_SECRET} was refused (Conflict); the stored CAs keep signing and the write will be retried on the next pass`,
    });
    // Promoting a successor over an expired CA is not possible without the write.
    seedCas(api, {
      platform: {
        current: caEnding('platform', START, -1),
        next: caEnding('platform', START, 3000),
      },
      tenant: { current: tenant },
    });
    expect(await loadSchedulerCas(api, cfg, START)).toMatchObject({ reason: 'CaNotReady' });
  });
});

describe('loadSchedulerCas: the switch waits for the holders (#629 W1)', () => {
  const published = (api: MemoryApi) => {
    const platform = caEnding('platform', START, 60);
    const next = newSchedulerCa(
      'platform',
      NS,
      new Date(START.getTime() - (CA_OVERLAP_DAYS + 1) * DAY),
    );
    const tenant = caEnding('tenant', START, 3000);
    seedCas(api, { platform: { current: platform, next }, tenant: { current: tenant } });
    return { platform, next, tenant };
  };
  const holder = (
    name: string,
    namespace: string,
    labels: Record<string, string>,
    bundle: string,
  ) =>
    ({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace, labels },
      data: { 'ca.crt': b64(bundle) },
    }) as unknown as Resource;

  it('switches when no holder exists, and waits while an identity still has previous, past previousUntil too', async () => {
    const api = new RotationApi();
    const { platform, next } = published(api);
    api.seed({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: SCHEDULER_IDENTITIES, namespace: PKI },
      data: {
        [IDENTITIES_KEY]: JSON.stringify({
          'platform/operator': {
            current: 'bbbbbbbbbbbbbbbb',
            previous: 'cccccccccccccccc',
            previousUntil: new Date(START.getTime() + 60_000).toISOString(),
          },
        }),
      },
    } as unknown as Resource);
    expect((await loadSchedulerCas(api, cfg, START)) as { cas: SchedulerCas }).toMatchObject({
      cas: { platform: { current: platform, next } },
    });
    expect(api.writes(caPath)).toBe(0);
    // Past previousUntil the renewal may still be rolling out (a slow or stalled host): it waits.
    const later = new Date(START.getTime() + 2 * 60_000);
    expect(await loadSchedulerCas(api, cfg, later)).toMatchObject({
      cas: { platform: { current: platform, next } },
    });
    expect(api.writes(caPath)).toBe(0);
    // Once `previous` is dropped (the rollout was observed), it switches.
    api.seed({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: SCHEDULER_IDENTITIES, namespace: PKI },
      data: {
        [IDENTITIES_KEY]: JSON.stringify({ 'platform/operator': { current: 'bbbbbbbbbbbbbbbb' } }),
      },
    } as unknown as Resource);
    expect(await loadSchedulerCas(api, cfg, later)).toMatchObject({
      cas: { platform: { current: next, previous: platform.cert } },
    });
    expect(api.writes(caPath)).toBe(1);
  });

  it('waits for a client Secret of the installation that lacks the successor, not for a stranger', async () => {
    const api = new RotationApi();
    const { platform, next } = published(api);
    const pkiLabels = { [INSTALLATION]: cfg.installation, [COMPONENT]: 'scheduler-pki' };
    // Not written by this installation: not a holder.
    api.seed(holder(PLATFORM_SECRETS.operator, NS, { [INSTALLATION]: 'other' }, ''));
    api.seed(holder(PLATFORM_SECRETS.host, NS, pkiLabels, `${platform.cert}${next.cert}`));
    const tenantLabels = {
      [INSTALLATION]: cfg.installation,
      [COMPONENT]: SCHEDULER_IDENTITY_COMPONENT,
    };
    api.seed(holder(TENANT_HOST_SECRET, 'di-runtime-alpha', tenantLabels, platform.cert));
    expect(await loadSchedulerCas(api, cfg, START)).toMatchObject({
      cas: { platform: { current: platform, next } },
    });
    api.seed(
      holder(TENANT_HOST_SECRET, 'di-runtime-alpha', tenantLabels, `${platform.cert}${next.cert}`),
    );
    // The server must carry the server bundle, not only the client one.
    api.seed(holder(PLATFORM_SECRETS.server, NS, pkiLabels, `${platform.cert}${next.cert}`));
    expect(await loadSchedulerCas(api, cfg, START)).toMatchObject({
      cas: { platform: { current: platform, next } },
    });
    expect(api.writes(caPath)).toBe(0);
    const cas = {
      platform: { current: platform, next },
      tenant: storedSet(api, 'tenant') as ControllerCas,
    };
    api.seed(holder(PLATFORM_SECRETS.server, NS, pkiLabels, schedulerServerBundle(cas)));
    expect(await loadSchedulerCas(api, cfg, START)).toMatchObject({
      cas: { platform: { current: next, previous: platform.cert } },
    });
  });
});

describe('a refused rotation write (#629 S2)', () => {
  it('is logged once by the platform pass, also without the identity record, until it lands', async () => {
    const api = new RotationApi();
    api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: PKI } });
    seedCas(api, {
      platform: { current: caEnding('platform', START, 60) },
      tenant: { current: caEnding('tenant', START, 3000) },
    });
    api.refuseCa = true;
    const identities = new PlatformSchedulerIdentities(api, cfg, () => START);
    await identities.reconcile();
    await identities.reconcile();
    const refused = 'Platform scheduler identities: the scheduler CA rotation write';
    expect(warned(refused)).toBe(1);
    api.refuseCa = false;
    await identities.reconcile();
    expect(api.writes(caPath)).toBe(3);
    api.refuseCa = true;
    seedCas(api, {
      platform: { current: caEnding('platform', START, 60) },
      tenant: { current: caEnding('tenant', START, 3000) },
    });
    await identities.reconcile();
    expect(warned(refused)).toBe(2);
  });
});

describe('the bootstrap Job during a rotation (#629)', () => {
  it('signs with the signing CA and writes the bundles of each whole set', async () => {
    const api = new RotationApi();
    api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: PKI } });
    const sets: SchedulerCas = {
      platform: {
        current: caEnding('platform', START, 3000),
        next: caEnding('platform', START, 3600),
      },
      tenant: {
        current: caEnding('tenant', START, SCHEDULER_CA_DAYS - 1),
        previous: caEnding('tenant', START, 9).cert,
      },
    };
    seedCas(api, sets);
    await bootstrapSchedulerPki(api, cfg, START);
    const secret = (path: string) =>
      (api.objects.get(path) as unknown as { data: Record<string, string> }).data;
    expect(decode(secret(serverPath)['ca.crt'])).toBe(schedulerServerBundle(sets));
    for (const path of clientPaths) {
      expect(decode(secret(path)['ca.crt'])).toBe(schedulerClientBundle(sets));
      const data = secret(path);
      expect(
        issuedBy(sets.platform.current.cert, decode(data['tls.crt']), decode(data['tls.key'])),
      ).toBe(true);
    }
    expect(api.writes(caPath)).toBe(0);
  });
});

const clock = { now: START };
let warn: ReturnType<typeof spyOn>;
const warned = (text: string) =>
  warn.mock.calls.filter(([message]: unknown[]) => String(message).includes(text)).length;
beforeEach(() => {
  clock.now = START;
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const at = (ms: number) => {
  clock.now = new Date(ms);
};
/**
 * The ticks of one renewal: record, the users named, the Secrets after the propagation wait, the
 * overlap. `check` runs after each tick.
 */
async function settle(controller: { tick(): Promise<void> }, check: () => void = () => {}) {
  for (const step of [0, 0, TENANT_OPERATOR_PROPAGATION_MS, 11 * 60_000]) {
    clock.now = new Date(clock.now.getTime() + step);
    await controller.tick();
    check();
  }
}
/** `ticks` more ticks, `step` ms apart; returns the writes they made to `paths` and the CA Secret. */
async function quiet(
  api: RotationApi,
  controller: { tick(): Promise<void> },
  paths: string[],
  ticks: number,
  step: number,
) {
  api.operations.length = 0;
  for (let i = 0; i < ticks; i++) {
    clock.now = new Date(clock.now.getTime() + step);
    await controller.tick();
  }
  return [caPath, recordPath, ...paths].map(api.writes.bind(api)).reduce((a, b) => a + b, 0);
}
const secretOf = (api: MemoryApi, path: string) =>
  (api.objects.get(path) as unknown as { data: Record<string, string> }).data;
/** True when the leaf in `path` verifies against `ca` with its key. */
const signedBy = (api: MemoryApi, path: string, ca: string) => {
  const data = secretOf(api, path);
  return issuedBy(ca, decode(data['tls.crt']), decode(data['tls.key']));
};
const trusted = (api: MemoryApi, path: string) =>
  [
    ...decode(secretOf(api, path)['ca.crt']).matchAll(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ),
  ].map(([pem]) => print(pem));

/**
 * A controller whose scheduler CAs, both expiring 100 days after START, were seeded before the
 * bootstrap, so the leaves it issues at START are not capped. `tenant` adds the tenant's operator
 * namespace, so both tenant identities are issued.
 */
async function prepare(tenant: boolean) {
  const api = new RotationApi();
  const old = {
    platform: caEnding('platform', START, 100),
    tenant: caEnding('tenant', START, 100),
  };
  seedCas(api, { platform: { current: old.platform }, tenant: { current: old.tenant } });
  const harness = await prepareHarness(api, { pki: true }, () => clock.now);
  // The platform and the tenant host group, so each renewal's rollout is observed and `previous`
  // dropped: an entry with `previous` holds the switch (#629). The harness does not render the
  // tenant's host group, so after each tick its template takes the digest of the certificate in
  // the host Secret, as the controller renders it.
  const tenantHosts = `/apis/apps/v1/namespaces/${names('alpha').runtimeNamespace}/deployments/hostgroup-${names('alpha').hostgroup}`;
  const controller = {
    async tick() {
      await harness.controller.tick();
      const secret = api.objects.get(hostPath) as unknown as
        | { data: Record<string, string> }
        | undefined;
      const hosts = api.objects.get(tenantHosts) as unknown as {
        spec: { template: { metadata: { annotations: Record<string, string> } } };
      };
      if (secret)
        hosts.spec.template.metadata.annotations[SCHEDULER_TLS_ANNOTATION] = schedulerCertDigest(
          decode(secret.data['tls.crt']),
        );
    },
  };
  for (const [name, namespace] of [
    ['hostgroup-default', NS],
    [`hostgroup-${names('alpha').hostgroup}`, names('alpha').runtimeNamespace],
  ] as const)
    api.seed({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace, generation: 1 },
      spec: { replicas: 1, template: { metadata: { annotations: {} } } },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1 },
    } as unknown as Resource);
  if (tenant)
    api.seed({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'di-operator-alpha',
        labels: { [INSTALLATION]: 'test', [OWNER]: 'alpha-uid' },
      },
    });
  await settle(controller);
  return { api, controller, old, end: endOf(old.platform.cert) };
}

describe('controller tick: the platform path rotates the platform scheduler CA (#629)', () => {
  it('publishes one successor, re-signs each platform leaf and the server leaf once against it, then retires the old CA', async () => {
    const { api, controller, old, end } = await prepare(false);
    const leaves = [serverPath, ...clientPaths];
    expect(await quiet(api, controller, leaves, 3, DAY)).toBe(0);

    // Publish: one successor per kind; every bundle trusts it while the old CA still signs.
    at(end - (CA_RENEW_DAYS - 1) * DAY);
    api.operations.length = 0;
    await settle(controller);
    expect(api.writes(caPath)).toBe(1);
    const next = {
      platform: storedSet(api, 'platform').next as KeyPair,
      tenant: storedSet(api, 'tenant').next as KeyPair,
    };
    for (const kind of KINDS)
      expect(schedulerCaFault(kind, NS, next[kind], clock.now)).toBeUndefined();
    for (const path of leaves) {
      expect(api.writes(path)).toBe(1);
      expect(signedBy(api, path, old.platform.cert)).toBe(true);
      expect(trusted(api, path)).toContain(print(next.platform.cert));
    }
    expect(trusted(api, serverPath)).toContain(print(next.tenant.cert));
    expect(await quiet(api, controller, leaves, 5, DAY)).toBe(0);

    // Switch: the successor signs; every leaf the old CA signed is re-signed once against it.
    at(startOf(next.platform.cert) + (CA_OVERLAP_DAYS + 1) * DAY);
    api.operations.length = 0;
    await settle(controller);
    expect(api.writes(caPath)).toBe(1);
    expect(storedSet(api, 'platform')).toEqual({
      current: next.platform,
      previous: old.platform.cert,
    });
    expect(storedSet(api, 'tenant')).toEqual({ current: next.tenant, previous: old.tenant.cert });
    for (const path of leaves) {
      expect(api.writes(path)).toBe(1);
      expect(signedBy(api, path, next.platform.cert)).toBe(true);
      expect(trusted(api, path)).toContain(print(old.platform.cert));
    }
    expect(warned('the scheduler platform CA expires')).toBe(0);
    expect(await quiet(api, controller, leaves, 5, DAY)).toBe(0);

    // Retire: the old CAs leave the CA Secret and the server's bundle; no client is re-issued.
    at(end + 60 * 60_000);
    api.operations.length = 0;
    await controller.tick();
    expect(api.writes(caPath)).toBe(1);
    expect(storedSet(api, 'platform')).toEqual({ current: next.platform });
    expect(storedSet(api, 'tenant')).toEqual({ current: next.tenant });
    expect(api.writes(serverPath)).toBe(1);
    expect(trusted(api, serverPath)).toEqual([print(next.platform.cert), print(next.tenant.cert)]);
    for (const path of clientPaths) expect(api.writes(path)).toBe(0);
    expect(await quiet(api, controller, leaves, 3, 60 * 60_000)).toBe(0);
  });

  it('renews capped leaves once the rotation can be written: publishes, then switches once every client carries the successor', async () => {
    const { api, controller, old, end } = await prepare(false);
    const leaves = [serverPath, ...clientPaths];
    api.refuseCa = true;
    at(end - 20 * DAY);
    await settle(controller);
    expect(warned('the scheduler platform CA expires')).toBe(1);
    // A refused rotation is logged once by each pass (S2).
    expect(warned('Platform scheduler identities: the scheduler CA rotation write')).toBe(1);
    expect(warned('Tenant scheduler identities: the scheduler CA rotation write')).toBe(1);
    api.operations.length = 0;
    for (let i = 0; i < 2; i++) await controller.tick();
    for (const path of leaves) expect(api.writes(path)).toBe(0);
    api.refuseCa = false;
    api.operations.length = 0;
    // Late, under 30 days left: the pass that publishes the successor does not switch to it.
    await controller.tick();
    expect(api.writes(caPath)).toBe(1);
    const next = storedSet(api, 'platform').next as KeyPair;
    expect(storedSet(api, 'platform').current).toEqual(old.platform);
    expect(signedBy(api, serverPath, old.platform.cert)).toBe(true);
    expect(trusted(api, serverPath)).toContain(print(next.cert));
    // Until every client's ca.crt carries the successor, the server leaf stays on the old CA.
    const holders = [...clientPaths, hostPath];
    let lacked = 0;
    await settle(controller, () => {
      if (holders.every((path) => trusted(api, path).includes(print(next.cert)))) return;
      lacked++;
      expect(storedSet(api, 'platform').current).toEqual(old.platform);
      expect(signedBy(api, serverPath, old.platform.cert)).toBe(true);
    });
    expect(lacked).toBeGreaterThan(0);
    // Then the switch, and every leaf is re-signed once against the successor.
    await settle(controller);
    expect(storedSet(api, 'platform')).toEqual({ current: next, previous: old.platform.cert });
    for (const path of leaves) {
      expect(api.writes(path)).toBe(2);
      expect(signedBy(api, path, next.cert)).toBe(true);
    }
    // The leaves renewed for the bundle are capped again until the switch, so the expiry is
    // logged once more (twice in all); after the switch it is not.
    const logged = warned('the scheduler platform CA expires');
    expect(logged).toBe(2);
    expect(await quiet(api, controller, leaves, 3, DAY)).toBe(0);
    expect(warned('the scheduler platform CA expires')).toBe(logged);
  });

  it('switches at the hard deadline when a client never carries the successor', async () => {
    const { api, controller, old, end } = await prepare(false);
    // A client Secret of the installation whose ca.crt never takes up the successor.
    api.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: TENANT_HOST_SECRET,
        namespace: 'di-runtime-stuck',
        labels: { [INSTALLATION]: cfg.installation, [COMPONENT]: SCHEDULER_IDENTITY_COMPONENT },
      },
      data: { 'ca.crt': b64(old.platform.cert) },
    } as unknown as Resource);
    at(end - 20 * DAY);
    await settle(controller);
    await settle(controller);
    const next = storedSet(api, 'platform').next as KeyPair;
    expect(storedSet(api, 'platform').current).toEqual(old.platform);
    at(end - (CA_SWITCH_DEADLINE_DAYS + 0.5) * DAY);
    await settle(controller);
    expect(storedSet(api, 'platform').current).toEqual(old.platform);
    at(end - (CA_SWITCH_DEADLINE_DAYS - 0.5) * DAY);
    await settle(controller);
    expect(storedSet(api, 'platform')).toEqual({ current: next, previous: old.platform.cert });
    expect(signedBy(api, serverPath, next.cert)).toBe(true);
  });
});

describe('controller tick: the tenant path rotates both scheduler CAs (#629)', () => {
  it('publishes one successor, re-signs the host and operator leaves once against it, then retires the old CA', async () => {
    const { api, controller, old, end } = await prepare(true);
    const leaves = [hostPath, operatorPath];
    expect(api.objects.has(hostPath) && api.objects.has(operatorPath)).toBe(true);
    expect(await quiet(api, controller, leaves, 3, DAY)).toBe(0);

    at(end - (CA_RENEW_DAYS - 1) * DAY);
    api.operations.length = 0;
    await settle(controller);
    expect(api.writes(caPath)).toBe(1);
    const next = {
      platform: storedSet(api, 'platform').next as KeyPair,
      tenant: storedSet(api, 'tenant').next as KeyPair,
    };
    // Each client's bundle gains the platform successor, so each is renewed once under the old CA.
    for (const path of leaves) {
      expect(api.writes(path)).toBe(1);
      expect(trusted(api, path)).toEqual([print(old.platform.cert), print(next.platform.cert)]);
    }
    expect(signedBy(api, hostPath, old.tenant.cert)).toBe(true);
    expect(signedBy(api, operatorPath, old.platform.cert)).toBe(true);
    expect(await quiet(api, controller, leaves, 5, DAY)).toBe(0);

    at(startOf(next.platform.cert) + (CA_OVERLAP_DAYS + 1) * DAY);
    api.operations.length = 0;
    await settle(controller);
    expect(api.writes(caPath)).toBe(1);
    for (const path of leaves) expect(api.writes(path)).toBe(1);
    expect(signedBy(api, hostPath, next.tenant.cert)).toBe(true);
    expect(signedBy(api, operatorPath, next.platform.cert)).toBe(true);
    expect(condition(api, SCHEDULER_CA_EXPIRING)).toBeUndefined();
    expect(await quiet(api, controller, leaves, 5, DAY)).toBe(0);

    at(end + 60 * 60_000);
    api.operations.length = 0;
    await controller.tick();
    expect(api.writes(caPath)).toBe(1);
    expect(storedSet(api, 'tenant')).toEqual({ current: next.tenant });
    expect(storedSet(api, 'platform')).toEqual({ current: next.platform });
    for (const path of leaves) expect(api.writes(path)).toBe(0);
    expect(trusted(api, serverPath)).toEqual([print(next.platform.cert), print(next.tenant.cert)]);
    expect(await quiet(api, controller, leaves, 3, 60 * 60_000)).toBe(0);
  });

  it('renews capped leaves once the rotation can be written, switches once every client carries the successor, and clears SchedulerCaExpiring', async () => {
    const { api, controller, old, end } = await prepare(true);
    const leaves = [hostPath, operatorPath];
    api.refuseCa = true;
    at(end - 20 * DAY);
    await settle(controller);
    expect(condition(api, SCHEDULER_CA_EXPIRING)).toMatchObject({ reason: 'CaExpiring' });
    api.refuseCa = false;
    api.operations.length = 0;
    await controller.tick();
    // Published, not switched: both sets keep signing with the old CAs.
    expect(storedSet(api, 'tenant').current).toEqual(old.tenant);
    expect(storedSet(api, 'platform').current).toEqual(old.platform);
    const next = storedSet(api, 'platform').next as KeyPair;
    const holders = [...clientPaths, ...leaves];
    await settle(controller, () => {
      if (holders.every((path) => trusted(api, path).includes(print(next.cert)))) return;
      expect(storedSet(api, 'tenant').current).toEqual(old.tenant);
      expect(signedBy(api, operatorPath, old.platform.cert)).toBe(true);
    });
    await settle(controller);
    for (const path of leaves) expect(api.writes(path)).toBe(2);
    expect(signedBy(api, hostPath, (storedSet(api, 'tenant').current as KeyPair).cert)).toBe(true);
    expect(signedBy(api, operatorPath, next.cert)).toBe(true);
    expect(condition(api, SCHEDULER_CA_EXPIRING)).toBeUndefined();
    expect(await quiet(api, controller, leaves, 3, DAY)).toBe(0);
  });
});
