import { describe, expect, it } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { COMPONENT, INSTALLATION } from '../src/tenancy/resources';
import {
  bootstrapSchedulerPki,
  CA_KEYS,
  codeUnitOrder,
  IDENTITIES_KEY,
  type IdentityRecord,
  ISSUANCE_ID,
  natsServerLeaf,
  natsServiceNames,
  newIssuanceId,
  newSchedulerCa,
  type PkiApi,
  PLATFORM_ROLES,
  PLATFORM_SECRETS,
  PLATFORM_SUBTREE,
  parseIdentityRecord,
  platformClientLeaf,
  platformIdentity,
  platformUser,
  SCHEDULER_CA_DAYS,
  SCHEDULER_CA_SECRET,
  SCHEDULER_IDENTITIES,
  SCHEDULER_LEAF_DAYS,
  SCHEDULER_LEAF_RENEW_DAYS,
  SchedulerPkiRefused,
  schedulerCaFault,
  schedulerCaProfile,
  schedulerPkiConfig,
  schedulerPkiNamespace,
  serializeIdentityRecord,
  TENANT_SUBTREE,
  tenantHostUser,
  tenantIdentity,
  tenantOperatorUser,
  tlsSecretData,
} from '../src/tenancy/scheduler-pki';
import {
  main,
  PKI_RETRY_BUDGET_MS,
  RetryingApi,
  transientClass,
} from '../src/tenancy/scheduler-pki-job';
import {
  caCertificate,
  caConstraints,
  caOtherPermitted,
  certificateNames,
  issuedBy,
  type KeyPair,
  leafCertificate,
} from '../src/tenancy/tls';
import { OPENSSL, opensslClientLeaf, opensslVerifies, opensslVerifyError } from './support/tls';

const DAY = 86_400_000;
const NS = 'wasmcloud';
const PKI = 'wasmcloud-scheduler-pki';
const t0 = new Date('2026-10-29T00:00:00Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const platformCa = newSchedulerCa('platform', NS, t0);
const tenantCa = newSchedulerCa('tenant', NS, t0);
/**
 * A leaf forged with the OpenSSL CLI, valid over the test's fixed window rather than from the
 * wall clock, so that verifying it at `at(1)` never fails for being not yet valid or expired.
 */
const forge = (ca: { cert: string; key: string }, san: string) =>
  opensslClientLeaf(ca, san, { notBefore: t0, notAfter: at(2) });
/** `openssl verify` output for a name-constraint refusal, under OpenSSL 3 and LibreSSL. */
const NAME_CONSTRAINT_REFUSAL = /subtree violation|name constraint/i;
const LIBRESSL = Bun.spawnSync([OPENSSL, 'version']).stdout.toString().includes('LibreSSL');
const opensslText = (cert: string) =>
  Bun.spawnSync([OPENSSL, 'x509', '-noout', '-text'], {
    stdin: Buffer.from(cert),
  }).stdout.toString();
const days = (cert: string) => {
  const x = new X509Certificate(cert);
  return (new Date(x.validTo).getTime() - new Date(x.validFrom).getTime()) / DAY;
};
/** A tenant host leaf as the tenant CA issues it (m4 issues these; the CA must permit them now). */
const tenantHostLeaf = (tenant: string, id: string, ca: KeyPair = tenantCa) => {
  const user = tenantHostUser(tenant, id);
  return leafCertificate(user, [user], [], SCHEDULER_LEAF_DAYS, ca.cert, ca.key, t0, 'client');
};

describe('tls: email and URI name constraints and client-auth leaves (#541)', () => {
  it('writes permitted email and URI subtrees beside the DNS ones and reads them back', () => {
    const ca = caCertificate('x', 30, t0, ['a.invalid'], true, {
      email: ['a.invalid'],
      uri: ['a.invalid'],
    });
    expect(caOtherPermitted(ca.cert)).toEqual({ email: ['a.invalid'], uri: ['a.invalid'] });
    expect(caConstraints(ca.cert)).toEqual({ dns: ['a.invalid'], excludesIps: true });
    const text = opensslText(ca.cert);
    expect(text).toMatch(/X509v3 Name Constraints: critical/);
    expect(text).toContain('DNS:a.invalid');
    expect(text).toContain('email:a.invalid');
    expect(text).toContain('URI:a.invalid');
    // A CA from before #541 permits no other form explicitly; an unconstrained CA has none.
    expect(caOtherPermitted(caCertificate('x', 30, t0, ['a.invalid'], true).cert)).toEqual({
      email: [],
      uri: [],
    });
    expect(caOtherPermitted(caCertificate('x', 30, t0).cert)).toBeUndefined();
    expect(caOtherPermitted('garbage')).toBeUndefined();
  });

  it('refuses email and URI bases that are not plain hosts', () => {
    for (const base of ['', '.a.invalid', 'mailbox@a.invalid'])
      for (const form of ['email', 'uri'] as const)
        expect(() => caCertificate('x', 30, t0, ['a.invalid'], true, { [form]: [base] })).toThrow(
          'not a permitted host',
        );
  });

  it('reads no other permitted form when the name constraints do not parse (fails closed)', () => {
    const ca = caCertificate('x', 30, t0, ['zzzz'], true, { email: ['zzzz'] });
    const der = Buffer.from(new X509Certificate(ca.cert).raw).toString('hex');
    const broken = Buffer.from(der.replace('82047a7a7a7a', '82887a7a7a7a'), 'hex');
    expect(broken.toString('hex')).not.toBe(der);
    const pem = `-----BEGIN CERTIFICATE-----\n${broken.toString('base64')}\n-----END CERTIFICATE-----\n`;
    expect(caOtherPermitted(pem)).toEqual({ email: [], uri: [] });
  });

  it('issues a client-auth leaf only when asked, and a server-auth leaf by default', () => {
    const ca = caCertificate('x', 30, t0);
    const client = leafCertificate('c', ['c'], [], 10, ca.cert, ca.key, t0, 'client');
    const server = leafCertificate('s', ['s'], [], 10, ca.cert, ca.key, t0);
    expect(new X509Certificate(client.cert).keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
    expect(new X509Certificate(server.cert).keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(opensslVerifies(client.cert, ca.cert, at(1), 'sslclient')).toBe(true);
    expect(opensslVerifies(client.cert, ca.cert, at(1), 'sslserver')).toBe(false);
    expect(opensslVerifies(server.cert, ca.cert, at(1), 'sslclient')).toBe(false);
  });
});

describe('scheduler identities and names', () => {
  it('names every identity as the design-541 §4.4 patterns require', () => {
    const id = '0123456789abcdef';
    for (const role of PLATFORM_ROLES)
      expect(platformUser(role, id)).toMatch(
        /^[0-9a-f]{16}\.(operator|host|data)\.platform\.scheduler\.di-framework\.invalid$/,
      );
    expect(tenantHostUser('alpha', id)).toMatch(
      /^[0-9a-f]{16}\.di-tenant-alpha\.tenants\.scheduler\.di-framework\.invalid$/,
    );
    expect(tenantOperatorUser('alpha', id)).toMatch(
      /^[0-9a-f]{16}\.operator\.di-tenant-alpha\.platform\.scheduler\.di-framework\.invalid$/,
    );
    expect(natsServiceNames(NS)).toEqual([
      'nats',
      'nats.wasmcloud',
      'nats.wasmcloud.svc',
      'nats.wasmcloud.svc.cluster.local',
    ]);
  });

  it('draws a fresh 16-hex-character issuance ID each time', () => {
    const ids = new Set(Array.from({ length: 64 }, () => newIssuanceId()));
    expect(ids.size).toBe(64);
    for (const id of ids) expect(id).toMatch(ISSUANCE_ID);
    expect(newIssuanceId(() => Buffer.alloc(8, 0xab))).toBe('abababababababab');
  });

  it('puts the CA keys in <platform-ns>-scheduler-pki, and refuses a name that does not fit', () => {
    expect(schedulerPkiNamespace(NS)).toBe(PKI);
    expect(schedulerPkiNamespace('a'.repeat(49))).toHaveLength(63);
    expect(() => schedulerPkiNamespace('a'.repeat(50))).toThrow('at most 63 characters');
  });
});

describe('scheduler CAs (O2, O3)', () => {
  it('constrains the platform CA to the platform subtree and the nats Service names', () => {
    expect(caConstraints(platformCa.cert)).toEqual({
      dns: [PLATFORM_SUBTREE, ...natsServiceNames(NS)],
      excludesIps: true,
    });
    expect(caOtherPermitted(platformCa.cert)).toEqual({
      email: [PLATFORM_SUBTREE],
      uri: [PLATFORM_SUBTREE],
    });
    expect(opensslText(platformCa.cert)).toMatch(/X509v3 Name Constraints: critical/);
  });

  it('constrains the tenant CA to the tenant subtree in every SAN form, with no IP address', () => {
    expect(caConstraints(tenantCa.cert)).toEqual({ dns: [TENANT_SUBTREE], excludesIps: true });
    expect(caOtherPermitted(tenantCa.cert)).toEqual({
      email: [TENANT_SUBTREE],
      uri: [TENANT_SUBTREE],
    });
  });

  it('lives 10 years; every leaf lives 90 days and is renewed with 30 left', () => {
    expect(SCHEDULER_CA_DAYS).toBe(3650);
    expect(SCHEDULER_LEAF_DAYS).toBe(90);
    expect(SCHEDULER_LEAF_RENEW_DAYS).toBe(30);
    const backdate = 5 / (24 * 60);
    expect(days(platformCa.cert)).toBeCloseTo(3650 + backdate, 5);
    expect(days(tenantCa.cert)).toBeCloseTo(3650 + backdate, 5);
    expect(days(platformClientLeaf('host', 'a'.repeat(16), platformCa, t0).cert)).toBeCloseTo(
      90 + backdate,
      5,
    );
    expect(days(natsServerLeaf(NS, platformCa, t0).cert)).toBeCloseTo(90 + backdate, 5);
    expect(days(tenantHostLeaf('alpha', 'b'.repeat(16)).cert)).toBeCloseTo(90 + backdate, 5);
  });

  it('forges leaves valid at the verification time, whatever the wall clock', () => {
    const leaf = new X509Certificate(forge(tenantCa, 'DNS:nats'));
    expect(new Date(leaf.validFrom).getTime()).toBeLessThanOrEqual(at(1).getTime());
    expect(new Date(leaf.validTo).getTime()).toBeGreaterThanOrEqual(at(1).getTime());
  });

  it('the tenant CA refuses every name under the platform subtree, in every SAN form', () => {
    const id = 'c'.repeat(16);
    const forged = [
      `DNS:${platformUser('operator', id)}`,
      `DNS:${tenantOperatorUser('alpha', id)}`,
      `DNS:${PLATFORM_SUBTREE}`,
      'DNS:nats',
      `email:x@${PLATFORM_SUBTREE}`,
      `email:${platformUser('host', id)}@${PLATFORM_SUBTREE}`,
      `URI:https://${PLATFORM_SUBTREE}/x`,
      'IP:10.0.0.1',
    ];
    for (const san of forged)
      expect([
        san,
        opensslVerifyError(forge(tenantCa, san), tenantCa.cert, at(1), 'sslclient'),
      ]).toEqual([san, expect.stringMatching(NAME_CONSTRAINT_REFUSAL)]);
    // Positive controls: the same forging path within the tenant subtree verifies. LibreSSL (the
    // macOS binary) refuses every URI name under a URI constraint, so that control runs only on
    // OpenSSL (CI); the refusals above hold under both.
    for (const san of [
      `DNS:${tenantHostUser('alpha', id)}`,
      `email:x@${TENANT_SUBTREE}`,
      ...(LIBRESSL ? [] : [`URI:https://${TENANT_SUBTREE}/x`]),
    ])
      expect([
        san,
        opensslVerifies(forge(tenantCa, san), tenantCa.cert, at(1), 'sslclient'),
      ]).toEqual([san, true]);
  });

  it('the platform CA refuses tenant host names and IP addresses', () => {
    const id = 'd'.repeat(16);
    for (const san of [
      `DNS:${tenantHostUser('alpha', id)}`,
      `email:x@${TENANT_SUBTREE}`,
      `URI:https://${TENANT_SUBTREE}/x`,
      'IP:10.0.0.1',
      'DNS:example.com',
    ])
      expect([
        san,
        opensslVerifyError(forge(platformCa, san), platformCa.cert, at(1), 'sslclient'),
      ]).toEqual([san, expect.stringMatching(NAME_CONSTRAINT_REFUSAL)]);
    expect(
      opensslVerifies(
        forge(platformCa, `DNS:${tenantOperatorUser('alpha', id)}`),
        platformCa.cert,
        at(1),
        'sslclient',
      ),
    ).toBe(true);
  });

  it('issues tenant host leaves under the tenant CA, and operator certificates only from the platform CA', () => {
    const id = 'e'.repeat(16);
    const host = tenantHostLeaf('alpha', id);
    expect(opensslVerifies(host.cert, tenantCa.cert, at(1), 'sslclient')).toBe(true);
    // An operator name the tenant CA signed is refused, however it was produced.
    const operator = tenantOperatorUser('alpha', id);
    const misissued = leafCertificate(
      operator,
      [operator],
      [],
      90,
      tenantCa.cert,
      tenantCa.key,
      t0,
      'client',
    );
    expect(opensslVerifies(misissued.cert, tenantCa.cert, at(1), 'sslclient')).toBe(false);
    expect(
      opensslVerifies(misissued.cert, `${platformCa.cert}${tenantCa.cert}`, at(1), 'sslclient'),
    ).toBe(false);
    for (const role of PLATFORM_ROLES) {
      const misissuedPlatform = platformClientLeaf(role, id, tenantCa, t0);
      expect(opensslVerifies(misissuedPlatform.cert, tenantCa.cert, at(1), 'sslclient')).toBe(
        false,
      );
    }
  });

  it('issues platform client leaves with the client-auth EKU and their user as the only DNS SAN', () => {
    for (const role of PLATFORM_ROLES) {
      const id = newIssuanceId();
      const leaf = platformClientLeaf(role, id, platformCa, t0);
      expect(certificateNames(leaf.cert)).toEqual({ dns: [platformUser(role, id)], ips: [] });
      const x = new X509Certificate(leaf.cert);
      expect(x.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
      expect(x.subjectAltName).toBe(`DNS:${platformUser(role, id)}`);
      expect(issuedBy(platformCa.cert, leaf.cert, leaf.key)).toBe(true);
      expect(opensslVerifies(leaf.cert, platformCa.cert, at(1), 'sslclient')).toBe(true);
      expect(opensslVerifies(leaf.cert, platformCa.cert, at(1), 'sslserver')).toBe(false);
    }
  });

  it('issues the NATS server leaf for the four nats Service names, for server auth', () => {
    const leaf = natsServerLeaf(NS, platformCa, t0);
    expect(certificateNames(leaf.cert)).toEqual({ dns: natsServiceNames(NS), ips: [] });
    expect(new X509Certificate(leaf.cert).keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(opensslVerifies(leaf.cert, platformCa.cert, at(1), 'sslserver')).toBe(true);
  });

  it('accepts only a stored CA that matches its key, is unexpired and has its exact constraints', () => {
    expect(schedulerCaFault('platform', NS, platformCa, t0)).toBeUndefined();
    expect(schedulerCaFault('tenant', NS, tenantCa, t0)).toBeUndefined();
    expect(schedulerCaFault('platform', NS, tenantCa, t0)).toContain('name constraints');
    expect(schedulerCaFault('tenant', NS, platformCa, t0)).toContain('name constraints');
    // The platform CA names its own namespace's Service, so another namespace's is refused.
    expect(schedulerCaFault('platform', 'other', platformCa, t0)).toContain('name constraints');
    expect(
      schedulerCaFault('tenant', NS, { cert: tenantCa.cert, key: platformCa.key }, t0),
    ).toContain('does not match');
    expect(schedulerCaFault('tenant', NS, { cert: tenantCa.cert }, t0)).toContain('missing');
    expect(schedulerCaFault('tenant', NS, tenantCa, at(3651))).toContain('expired');
    const p = schedulerCaProfile('tenant', NS);
    const unconstrained = caCertificate(p.commonName, 3650, t0);
    expect(schedulerCaFault('tenant', NS, unconstrained, t0)).toContain('name constraints');
    const dnsOnly = caCertificate(p.commonName, 3650, t0, p.dns, true);
    expect(schedulerCaFault('tenant', NS, dnsOnly, t0)).toContain('name constraints');
    const ipOpen = caCertificate(p.commonName, 3650, t0, p.dns, false, {
      email: p.email,
      uri: p.uri,
    });
    expect(schedulerCaFault('tenant', NS, ipOpen, t0)).toContain('name constraints');
    const noUri = caCertificate(p.commonName, 3650, t0, p.dns, true, { email: p.email });
    expect(schedulerCaFault('tenant', NS, noUri, t0)).toContain('name constraints');
  });
});

describe('identity record', () => {
  const record: IdentityRecord = {
    'platform/host': { current: '1111111111111111' },
    'tenant/alpha/operator': {
      current: '2222222222222222',
      previous: '3333333333333333',
      previousUntil: '2026-10-29T00:10:00.000Z',
    },
    'platform/data': { current: '4444444444444444' },
    'tenant/alpha/hosts': {
      current: '5555555555555555',
      previous: '6666666666666666',
      previousUntil: '2026-10-29T00:10:00Z',
    },
  };

  it('serializes sorted and byte-stable, and parses back what it wrote', () => {
    const text = serializeIdentityRecord(record);
    expect(Object.keys(JSON.parse(text))).toEqual([
      'platform/data',
      'platform/host',
      'tenant/alpha/hosts',
      'tenant/alpha/operator',
    ]);
    const shuffled = Object.fromEntries(Object.entries(record).reverse());
    expect(serializeIdentityRecord(shuffled)).toBe(text);
    expect(parseIdentityRecord(text)).toEqual(record);
    expect(serializeIdentityRecord(parseIdentityRecord(text))).toBe(text);
    expect(platformIdentity('operator')).toBe('platform/operator');
  });

  it('sorts by code unit, not by locale', () => {
    expect(['b', 'B', 'a', 'A', '-', '_'].sort(codeUnitOrder)).toEqual([
      '-',
      'A',
      'B',
      '_',
      'a',
      'b',
    ]);
    expect(codeUnitOrder('a', 'a')).toBe(0);
  });

  it('gives tenant entries their own prefix, so a Tenant named platform cannot collide (W2)', () => {
    expect(tenantIdentity('platform', 'operator')).toBe('tenant/platform/operator');
    expect(tenantIdentity('platform', 'hosts')).toBe('tenant/platform/hosts');
    const both: IdentityRecord = {
      [platformIdentity('operator')]: { current: '1111111111111111' },
      [tenantIdentity('platform', 'operator')]: { current: '2222222222222222' },
      [tenantIdentity('platform', 'hosts')]: { current: '3333333333333333' },
    };
    expect(Object.keys(parseIdentityRecord(serializeIdentityRecord(both)))).toHaveLength(3);
    // The unprefixed tenant forms are not record keys, so `platform/hosts` is not a tenant entry.
    for (const key of ['platform/hosts', 'alpha/hosts', 'alpha/operator', 'tenant/platform/data'])
      expect(() =>
        parseIdentityRecord(JSON.stringify({ [key]: { current: '1111111111111111' } })),
      ).toThrow(`has an invalid entry '${key}'`);
  });

  it('refuses anything it did not write, naming the entry but no value', () => {
    for (const text of ['', 'nope', '[]', 'null', '"x"'])
      expect(() => parseIdentityRecord(text)).toThrow('does not hold a JSON identity record');
    const bad: Record<string, unknown> = {
      'platform/server': { current: '1111111111111111' },
      'tenant/Alpha/hosts': { current: '1111111111111111' },
      'tenant/alpha/other': { current: '1111111111111111' },
      'tenant/alpha/hosts': { current: 'ABCDEFABCDEFABCD' },
      'tenant/beta/hosts': { current: '1111' },
      'tenant/gamma/hosts': null,
      'tenant/delta/hosts': { current: '1111111111111111', extra: 'x' },
      'tenant/eps/hosts': { current: '1111111111111111', previous: 'zz' },
      'tenant/zeta/hosts': { current: '1111111111111111', previousUntil: '2026-10-29T00:00:00Z' },
      'tenant/iota/hosts': { current: '1111111111111111', previous: '2222222222222222' },
      'tenant/eta/hosts': {
        current: '1111111111111111',
        previous: '2222222222222222',
        previousUntil: 'not a time',
      },
      'tenant/theta/hosts': 'x',
    };
    for (const [key, entry] of Object.entries(bad)) {
      const thrown = (() => {
        try {
          parseIdentityRecord(JSON.stringify({ [key]: entry }));
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(thrown).toBe(`${SCHEDULER_IDENTITIES} has an invalid entry '${key}'`);
    }
  });
});

it('every scheduler TLS Secret carries tls.crt, tls.key and ca.crt', () => {
  const leaf = platformClientLeaf('data', newIssuanceId(), platformCa, t0);
  const data = tlsSecretData(leaf, platformCa.cert);
  expect(Object.keys(data).sort()).toEqual(['ca.crt', 'tls.crt', 'tls.key']);
  expect(Buffer.from(data['ca.crt'] as string, 'base64').toString()).toBe(platformCa.cert);
});

it('reads SCHEDULER_PKI_CONFIG, refusing a missing or incomplete one', () => {
  expect(schedulerPkiConfig('{"installation":"di","namespace":"wasmcloud","x":1}')).toEqual({
    installation: 'di',
    namespace: 'wasmcloud',
  });
  for (const text of [undefined, '', 'nope', 'null', '{"installation":"di"}', '{"namespace":"n"}'])
    expect(() => schedulerPkiConfig(text)).toThrow('Missing SCHEDULER_PKI_CONFIG');
  expect(() =>
    schedulerPkiConfig(JSON.stringify({ installation: 'di', namespace: 'a'.repeat(50) })),
  ).toThrow('at most 63');
});

// --- The bootstrap against a fake Kubernetes API -----------------------------------------------

interface Stored {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
  };
  type?: string;
  data?: Record<string, string>;
}
class FakeApi implements PkiApi {
  readonly objects = new Map<string, Stored>();
  readonly calls: string[] = [];
  private version = 1;
  /** Fails the next call to `path` (any method) with this status. */
  failNext?: { path: string; code: number };
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push(`${method} ${path}`);
    if (this.failNext?.path === path) {
      const { code } = this.failNext;
      this.failNext = undefined;
      throw Object.assign(new Error(`${method} ${path} returned ${code}`), { code });
    }
    const missing = () => Object.assign(new Error(`${method} ${path} returned 404`), { code: 404 });
    if (method === 'GET') {
      const found = this.objects.get(path);
      if (!found) throw missing();
      return structuredClone(found) as T;
    }
    const value = structuredClone(body) as Stored;
    if (method === 'POST') {
      const key = `${path}/${value.metadata.name}`;
      if (this.objects.has(key)) throw Object.assign(new Error('conflict'), { code: 409 });
      value.metadata.resourceVersion = String(this.version++);
      this.objects.set(key, value);
      return structuredClone(value) as T;
    }
    if (method === 'PUT') {
      const found = this.objects.get(path);
      if (!found) throw missing();
      if (value.metadata.resourceVersion !== found.metadata.resourceVersion)
        throw Object.assign(new Error('conflict'), { code: 409 });
      value.metadata.resourceVersion = String(this.version++);
      this.objects.set(path, value);
      return structuredClone(value) as T;
    }
    throw new Error(`unexpected ${method}`);
  }
  get(path: string): Stored {
    const found = this.objects.get(path);
    if (!found) throw new Error(`${path} missing`);
    return found;
  }
}

const caPath = `/api/v1/namespaces/${PKI}/secrets/${SCHEDULER_CA_SECRET}`;
const recordPath = `/api/v1/namespaces/${PKI}/configmaps/${SCHEDULER_IDENTITIES}`;
const leafPath = (role: keyof typeof PLATFORM_SECRETS) =>
  `/api/v1/namespaces/${NS}/secrets/${PLATFORM_SECRETS[role]}`;
const decode = (s: Stored, key: string) => Buffer.from(s.data?.[key] ?? '', 'base64').toString();
const readRecord = (api: FakeApi) =>
  parseIdentityRecord(api.get(recordPath).data?.[IDENTITIES_KEY] as string);
const config = { installation: 'di-test', namespace: NS };

describe('scheduler PKI bootstrap', () => {
  it('creates both CAs, the record and the four platform Secrets on an empty cluster', async () => {
    const api = new FakeApi();
    const written = await bootstrapSchedulerPki(api, config, t0);
    expect(written).toEqual([
      `${PKI}/${SCHEDULER_CA_SECRET}`,
      `${PKI}/${SCHEDULER_IDENTITIES}`,
      `${NS}/di-scheduler-nats-tls`,
      `${NS}/di-scheduler-operator-tls`,
      `${NS}/di-scheduler-platform-host-tls`,
      `${NS}/di-scheduler-data-tls`,
    ]);
    const caSecret = api.get(caPath);
    expect(caSecret.type).toBe('Opaque');
    expect(caSecret.metadata.labels).toEqual({
      [INSTALLATION]: 'di-test',
      [COMPONENT]: 'scheduler-pki',
    });
    const platform = {
      cert: decode(caSecret, CA_KEYS.platform.cert),
      key: decode(caSecret, CA_KEYS.platform.key),
    };
    const tenant = {
      cert: decode(caSecret, CA_KEYS.tenant.cert),
      key: decode(caSecret, CA_KEYS.tenant.key),
    };
    expect(schedulerCaFault('platform', NS, platform, t0)).toBeUndefined();
    expect(schedulerCaFault('tenant', NS, tenant, t0)).toBeUndefined();

    const record = readRecord(api);
    expect(Object.keys(record).sort()).toEqual([
      'platform/data',
      'platform/host',
      'platform/operator',
    ]);
    const ids = new Set<string>();
    for (const role of PLATFORM_ROLES) {
      const entry = record[platformIdentity(role)];
      expect(entry).toEqual({ current: expect.stringMatching(ISSUANCE_ID) });
      ids.add(entry?.current as string);
      const secret = api.get(leafPath(role));
      expect(secret.type).toBe('kubernetes.io/tls');
      expect(Object.keys(secret.data ?? {}).sort()).toEqual(['ca.crt', 'tls.crt', 'tls.key']);
      expect(decode(secret, 'ca.crt')).toBe(platform.cert);
      const cert = decode(secret, 'tls.crt');
      expect(certificateNames(cert)?.dns).toEqual([platformUser(role, entry?.current as string)]);
      expect(issuedBy(platform.cert, cert, decode(secret, 'tls.key'))).toBe(true);
      expect(opensslVerifies(cert, platform.cert, at(1), 'sslclient')).toBe(true);
    }
    // Every client certificate gets its own ID.
    expect(ids.size).toBe(3);
    const server = api.get(leafPath('server'));
    expect(decode(server, 'ca.crt')).toBe(`${platform.cert}${tenant.cert}`);
    expect(certificateNames(decode(server, 'tls.crt'))?.dns).toEqual(natsServiceNames(NS));
    expect(opensslVerifies(decode(server, 'tls.crt'), platform.cert, at(1))).toBe(true);
  });

  it('writes the record before it issues any client certificate', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    const writes = api.calls.filter((c) => !c.startsWith('GET'));
    const recordAt = writes.indexOf(`POST /api/v1/namespaces/${PKI}/configmaps`);
    expect(recordAt).toBeGreaterThan(writes.indexOf(`POST /api/v1/namespaces/${PKI}/secrets`));
    expect(writes.slice(recordAt + 1)).toEqual(
      Array(4).fill(`POST /api/v1/namespaces/${NS}/secrets`),
    );
  });

  it('writes nothing on a second run, and never reads back or logs key material', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    const before = structuredClone([...api.objects]);
    api.calls.length = 0;
    expect(await bootstrapSchedulerPki(api, config, at(1))).toEqual([]);
    expect(api.calls.every((c) => c.startsWith('GET'))).toBe(true);
    expect([...api.objects]).toEqual(before);
  });

  it('treats a deleted platform Secret as a forced rotation: a new ID, recorded first, no previous', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    const old = readRecord(api);
    const oldServer = api.get(leafPath('server'));
    api.objects.delete(leafPath('host'));
    api.calls.length = 0;
    expect(await bootstrapSchedulerPki(api, config, at(1))).toEqual([
      `${PKI}/${SCHEDULER_IDENTITIES} (updated)`,
      `${NS}/di-scheduler-platform-host-tls`,
    ]);
    const writes = api.calls.filter((c) => !c.startsWith('GET'));
    expect(writes).toEqual([`PUT ${recordPath}`, `POST /api/v1/namespaces/${NS}/secrets`]);
    const now = readRecord(api);
    expect(now['platform/host']).toEqual({ current: expect.stringMatching(ISSUANCE_ID) });
    expect(now['platform/host']?.current).not.toBe(old['platform/host']?.current);
    expect(now['platform/operator']).toEqual(old['platform/operator'] as never);
    expect(now['platform/data']).toEqual(old['platform/data'] as never);
    expect(api.get(leafPath('server'))).toEqual(oldServer);
    expect(certificateNames(decode(api.get(leafPath('host')), 'tls.crt'))?.dns).toEqual([
      platformUser('host', now['platform/host']?.current as string),
    ]);
  });

  it('keeps other entries of an existing record, tenant entries included', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    const stored = api.get(recordPath);
    const record = readRecord(api);
    record['tenant/alpha/hosts'] = { current: 'abcdefabcdefabcd' };
    stored.data = { [IDENTITIES_KEY]: serializeIdentityRecord(record) };
    api.objects.delete(leafPath('data'));
    await bootstrapSchedulerPki(api, config, at(1));
    expect(readRecord(api)['tenant/alpha/hosts']).toEqual({ current: 'abcdefabcdefabcd' });
  });

  it('updates the record from the stored object, keeping its labels and other keys (S4)', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    const stored = api.get(recordPath);
    stored.metadata.labels = { ...stored.metadata.labels, extra: 'kept' };
    stored.data = { ...stored.data, 'other.json': '{}' };
    api.objects.delete(leafPath('data'));
    await bootstrapSchedulerPki(api, config, at(1));
    const now = api.get(recordPath);
    expect(now.metadata.labels?.extra).toBe('kept');
    expect(now.data?.['other.json']).toBe('{}');
  });

  it('refuses to update a record read without a resourceVersion (S4)', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    api.get(recordPath).metadata.resourceVersion = undefined;
    api.objects.delete(leafPath('data'));
    await expect(bootstrapSchedulerPki(api, config, at(1))).rejects.toThrow(
      'read without a resourceVersion',
    );
    expect(api.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
    expect(api.objects.has(leafPath('data'))).toBe(false);
  });

  it('issues a missing server Secret without touching the record', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    const record = api.get(recordPath);
    api.objects.delete(leafPath('server'));
    expect(await bootstrapSchedulerPki(api, config, at(1))).toEqual([
      `${NS}/di-scheduler-nats-tls`,
    ]);
    expect(api.get(recordPath)).toEqual(record);
  });

  it('refuses to replace a lost CA while identities issued under it remain', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    api.objects.delete(caPath);
    const before = structuredClone([...api.objects]);
    const error = await bootstrapSchedulerPki(api, config, at(1)).catch((e) => e);
    expect(error).toBeInstanceOf(SchedulerPkiRefused);
    expect(error.message).toContain(`${PKI}/${SCHEDULER_IDENTITIES}`);
    expect(error.message).toContain('di-scheduler-operator-tls');
    expect([...api.objects]).toEqual(before);
    // A leaf alone is enough to refuse.
    const lone = new FakeApi();
    lone.objects.set(leafPath('server'), api.get(leafPath('server')));
    await expect(bootstrapSchedulerPki(lone, config, t0)).rejects.toThrow('di-scheduler-nats-tls');
  });

  it('refuses client Secrets that have no record entry', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    const record = readRecord(api);
    delete record['platform/operator'];
    api.get(recordPath).data = { [IDENTITIES_KEY]: serializeIdentityRecord(record) };
    await expect(bootstrapSchedulerPki(api, config, at(1))).rejects.toThrow(
      'di-scheduler-operator-tls exist without an entry',
    );
    // Also when the record itself is gone.
    api.objects.delete(recordPath);
    await expect(bootstrapSchedulerPki(api, config, at(1))).rejects.toBeInstanceOf(
      SchedulerPkiRefused,
    );
  });

  it('refuses a stored CA that is unusable, and a record it cannot read', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    const good = structuredClone(api.get(caPath));
    const unconstrained = caCertificate('x', 3650, t0);
    api.get(caPath).data = {
      ...good.data,
      [CA_KEYS.tenant.cert]: Buffer.from(unconstrained.cert).toString('base64'),
      [CA_KEYS.tenant.key]: Buffer.from(unconstrained.key).toString('base64'),
    };
    await expect(bootstrapSchedulerPki(api, config, at(1))).rejects.toThrow(
      `${PKI}/${SCHEDULER_CA_SECRET}: the tenant CA does not carry`,
    );
    api.get(caPath).data = { [CA_KEYS.tenant.cert]: good.data?.[CA_KEYS.tenant.cert] as string };
    await expect(bootstrapSchedulerPki(api, config, at(1))).rejects.toThrow(
      'the platform CA certificate or key is missing',
    );
    api.get(caPath).data = undefined;
    await expect(bootstrapSchedulerPki(api, config, at(1))).rejects.toBeInstanceOf(
      SchedulerPkiRefused,
    );
    api.objects.set(caPath, good);
    await expect(bootstrapSchedulerPki(api, config, at(3651))).rejects.toThrow('has expired');
    api.get(recordPath).data = { [IDENTITIES_KEY]: '{' };
    await expect(bootstrapSchedulerPki(api, config, at(1))).rejects.toThrow(
      'does not hold a JSON identity record',
    );
    api.get(recordPath).data = undefined;
    await expect(bootstrapSchedulerPki(api, config, at(1))).rejects.toThrow(
      'does not hold a JSON identity record',
    );
  });

  it('does not overwrite a record changed since it was read, nor a Secret created meanwhile', async () => {
    const api = new FakeApi();
    await bootstrapSchedulerPki(api, config, t0);
    api.objects.delete(leafPath('operator'));
    // Another writer updates the record between the bootstrap's read and its write.
    const call = api.call.bind(api);
    api.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (method === 'PUT') {
        const stored = api.get(recordPath);
        stored.metadata.resourceVersion = `${stored.metadata.resourceVersion}-changed`;
      }
      return call<T>(method, path, body);
    };
    await expect(bootstrapSchedulerPki(api, config, at(1))).rejects.toMatchObject({ code: 409 });
    expect(api.objects.has(leafPath('operator'))).toBe(false);
    // A Secret that appears after the read is not overwritten either.
    const racing = new FakeApi();
    const post = racing.call.bind(racing);
    racing.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (method === 'POST' && path === `/api/v1/namespaces/${NS}/secrets`) {
        const name = (body as Stored).metadata.name;
        racing.objects.set(`${path}/${name}`, {
          ...(body as Stored),
          data: { 'tls.crt': 'other' },
        });
      }
      return post<T>(method, path, body);
    };
    await expect(bootstrapSchedulerPki(racing, config, t0)).rejects.toMatchObject({ code: 409 });
    expect(racing.get(leafPath('server')).data).toEqual({ 'tls.crt': 'other' });
  });

  it('completes on the next run after stopping part-way', async () => {
    for (const path of [
      `/api/v1/namespaces/${PKI}/configmaps`,
      `/api/v1/namespaces/${NS}/secrets`,
    ]) {
      const api = new FakeApi();
      api.failNext = { path, code: 500 };
      await expect(bootstrapSchedulerPki(api, config, t0)).rejects.toMatchObject({ code: 500 });
      await bootstrapSchedulerPki(api, config, at(1));
      const record = readRecord(api);
      for (const role of PLATFORM_ROLES) {
        const cert = decode(api.get(leafPath(role)), 'tls.crt');
        expect(certificateNames(cert)?.dns).toEqual([
          platformUser(role, record[platformIdentity(role)]?.current as string),
        ]);
      }
      expect(api.objects.has(leafPath('server'))).toBe(true);
      expect(await bootstrapSchedulerPki(api, config, at(2))).toEqual([]);
    }
  });

  it('propagates API errors other than 404 from its reads', async () => {
    const api = new FakeApi();
    api.failNext = { path: caPath, code: 403 };
    await expect(bootstrapSchedulerPki(api, config, t0)).rejects.toMatchObject({ code: 403 });
    expect(api.objects.size).toBe(0);
  });
});

describe('scheduler-pki entry point', () => {
  it('prints only the names it wrote', async () => {
    const api = new FakeApi();
    const lines: string[] = [];
    await main(api, JSON.stringify(config), (line) => lines.push(line));
    expect(lines).toEqual([
      `wrote ${PKI}/${SCHEDULER_CA_SECRET}`,
      `wrote ${PKI}/${SCHEDULER_IDENTITIES}`,
      `wrote ${NS}/di-scheduler-nats-tls`,
      `wrote ${NS}/di-scheduler-operator-tls`,
      `wrote ${NS}/di-scheduler-platform-host-tls`,
      `wrote ${NS}/di-scheduler-data-tls`,
      `wrote ${NS}/di-scheduler-nats-accounts`,
      'scheduler PKI ready (7 written)',
    ]);
    expect(lines.join('\n')).not.toContain('BEGIN');
  });

  it('fails on a missing config before any API call', async () => {
    const api = new FakeApi();
    await expect(main(api, undefined, () => {})).rejects.toThrow('Missing SCHEDULER_PKI_CONFIG');
    expect(api.calls).toEqual([]);
  });
});

describe('scheduler-pki connection retry (#583)', () => {
  /** Refuses the first `refusals` connections, then lets every call through to `inner`. */
  class RefusingApi implements PkiApi {
    attempts = 0;
    constructor(
      readonly inner: FakeApi,
      private refusals: number,
      private readonly code: string | number = 'ECONNREFUSED',
    ) {}
    call<T>(method: string, path: string, body?: unknown): Promise<T> {
      this.attempts++;
      if (this.refusals > 0) {
        this.refusals--;
        const error =
          typeof this.code === 'number'
            ? Object.assign(new Error(`${method} ${path} returned ${this.code}`), {
                code: this.code,
              })
            : Object.assign(new Error(`connect ${this.code} 10.0.0.1:443`), { code: this.code });
        return Promise.reject(error);
      }
      return this.inner.call<T>(method, path, body);
    }
  }
  /** A clock the injected sleep advances, so no test waits. */
  function clock() {
    let t = 0;
    const waits: number[] = [];
    return {
      waits,
      now: () => t,
      sleep: async (ms: number) => {
        waits.push(ms);
        t += ms;
      },
    };
  }

  it('classifies connection codes and 429/5xx as transient, other statuses not', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT'])
      expect(transientClass({ code })).toBe(code);
    expect(transientClass({ code: 503 })).toBe('HTTP 503');
    expect(transientClass({ code: 429 })).toBe('HTTP 429');
    for (const code of [403, 404, 409, 'ENOENT', undefined])
      expect(transientClass({ code })).toBeUndefined();
    expect(transientClass(null)).toBeUndefined();
  });

  it('retries refused connections and writes everything once', async () => {
    const store = new FakeApi();
    const refusing = new RefusingApi(store, 5);
    const c = clock();
    const lines: string[] = [];
    await main(new RetryingApi(refusing, c.sleep, c.now), JSON.stringify(config), (l) =>
      lines.push(l),
    );
    expect(c.waits).toEqual([250, 500, 1000, 2000, 4000]);
    expect(lines.at(-1)).toBe('scheduler PKI ready (7 written)');
    // The same calls, each once, as a run that was never refused.
    const plain = new FakeApi();
    await main(plain, JSON.stringify(config), () => {});
    expect(store.calls).toEqual(plain.calls);
    expect(store.objects.size).toBe(7);
  });

  it('caps the backoff at 5 s and gives up after the budget with the error class', async () => {
    const store = new FakeApi();
    const c = clock();
    const api = new RetryingApi(new RefusingApi(store, Number.POSITIVE_INFINITY), c.sleep, c.now);
    const error = (await main(api, JSON.stringify(config), () => {}).catch(
      (e: Error) => e,
    )) as Error;
    expect(error.message).toMatch(
      /^GET \/api\/v1\/\S+ still failing with ECONNREFUSED after \d+ s of retries$/,
    );
    expect(Math.max(...c.waits)).toBe(5000);
    expect(c.now()).toBeLessThanOrEqual(PKI_RETRY_BUDGET_MS);
    expect(c.now()).toBeGreaterThan(PKI_RETRY_BUDGET_MS - 5000);
    expect(store.calls).toEqual([]);
  });

  it('does not retry HTTP 403', async () => {
    const refusing = new RefusingApi(new FakeApi(), 1, 403);
    const c = clock();
    await expect(
      main(new RetryingApi(refusing, c.sleep, c.now), JSON.stringify(config), () => {}),
    ).rejects.toMatchObject({ code: 403 });
    expect(refusing.attempts).toBe(1);
    expect(c.waits).toEqual([]);
  });

  it('waits on the real clock by default', async () => {
    const refusing = new RefusingApi(new FakeApi(), 1, 'ECONNRESET');
    const started = Date.now();
    await new RetryingApi(refusing).call('POST', `/api/v1/namespaces/${PKI}/configmaps`, {
      metadata: { name: 'x' },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(refusing.attempts).toBe(2);
  });
});
