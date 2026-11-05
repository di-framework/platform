/**
 * The scheduler NATS PKI (#541, design-541 §4.5): two certificate authorities, the identity
 * record, and the platform's own scheduler identities, created once by the bootstrap Job.
 *
 * - The **platform scheduler CA** signs the NATS server and every operator and platform client.
 *   It may sign DNS names only under {@link PLATFORM_SUBTREE} and the `nats` Service names, email
 *   and URI names only under {@link PLATFORM_SUBTREE}, and no IP address.
 * - The **tenant scheduler CA** signs tenant host certificates only. It may sign DNS, email and
 *   URI names only under {@link TENANT_SUBTREE}, and no IP address, so it can never produce an
 *   operator or platform identity.
 *
 * Every client certificate names exactly one NATS user, `<id>.<role>…`, where `<id>` is a fresh
 * {@link newIssuanceId} recorded in {@link SCHEDULER_IDENTITIES} before the certificate is
 * issued. The CA keys and the record live in {@link schedulerPkiNamespace}, which no pod mounts.
 *
 * Both CAs rotate through a current/next set ({@link nextSchedulerCas}, `ca-rotation.ts`): the
 * controller publishes a successor `CA_RENEW_DAYS` before a CA expires, switches the signing CA to
 * it after `CA_OVERLAP_DAYS`, and retires the old CA when it expires (#629). The bootstrap creates
 * the first CAs only and never rotates them.
 *
 * Nothing here logs or returns key material, other than as the data of the Secrets it writes.
 */
import { randomBytes } from 'node:crypto';
import {
  CA_DAYS,
  type ControllerCas,
  caBundle,
  keptAsPrevious,
  LEAF_RENEW_DAYS,
  rotateCaSet,
  type StoredCas,
} from './ca-rotation';
import type { Resource } from './resources';
import {
  caCertificate,
  caConstraints,
  caOtherPermitted,
  certificateValid,
  holdsCaKey,
  type KeyPair,
  leafCertificate,
} from './tls';

/**
 * The modules the bootstrap Job runs: this one, its entry point and what they import. The Job
 * imports nothing else, so these keys are written here rather than imported from `resources`
 * (a test keeps them equal).
 */
export const SCHEDULER_PKI_MODULES = [
  'tls',
  'ca-rotation',
  'scheduler-pki',
  'scheduler-nats',
  'scheduler-pki-job',
];
const INSTALLATION = 'platform.di-framework.dev/installation';
const COMPONENT = 'platform.di-framework.dev/component';

/** The parent of every scheduler NATS user name. `.invalid` names never resolve (RFC 2606). */
export const SCHEDULER_DOMAIN = 'scheduler.di-framework.invalid';
/** The subtree of operator and platform identities; only the platform CA signs names in it. */
export const PLATFORM_SUBTREE = `platform.${SCHEDULER_DOMAIN}`;
/** The subtree of tenant host identities; the only names the tenant CA may sign. */
export const TENANT_SUBTREE = `tenants.${SCHEDULER_DOMAIN}`;

/** Lifetime of both scheduler CAs (days): 10 years (O3). */
export const SCHEDULER_CA_DAYS = CA_DAYS;
/** Lifetime of every scheduler leaf (days): 90 (O3). */
export const SCHEDULER_LEAF_DAYS = 90;
/** A scheduler leaf is renewed this many days before it expires (O3). */
export const SCHEDULER_LEAF_RENEW_DAYS = LEAF_RENEW_DAYS;

/** The Secret, in {@link schedulerPkiNamespace}, holding both CAs and their keys. */
export const SCHEDULER_CA_SECRET = 'di-scheduler-ca';
/** The ConfigMap, in {@link schedulerPkiNamespace}, holding the identity record. */
export const SCHEDULER_IDENTITIES = 'di-scheduler-identities';
/** The key of the identity record in {@link SCHEDULER_IDENTITIES}. */
export const IDENTITIES_KEY = 'identities.json';
/**
 * The keys of {@link SCHEDULER_CA_SECRET}, per CA: the signing CA (`cert`, `key`) and, during a
 * rotation (#629), its published successor (`nextCert`, `nextKey`) and the CA it replaced
 * (`previous`, certificate only: it never signs again).
 */
export const CA_KEYS = {
  platform: {
    cert: 'platform-ca.crt',
    key: 'platform-ca.key',
    nextCert: 'platform-next-ca.crt',
    nextKey: 'platform-next-ca.key',
    previous: 'platform-previous-ca.crt',
  },
  tenant: {
    cert: 'tenant-ca.crt',
    key: 'tenant-ca.key',
    nextCert: 'tenant-next-ca.crt',
    nextKey: 'tenant-next-ca.key',
    previous: 'tenant-previous-ca.crt',
  },
} as const;
/** The value of the component label on everything the bootstrap writes. */
export const SCHEDULER_PKI_COMPONENT = 'scheduler-pki';

/** The platform's own client identities: the chart's operator, `hostgroup-default` and its data connection. */
export const PLATFORM_ROLES = ['operator', 'host', 'data'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
/** The platform namespace's scheduler Secrets: the NATS server's and one per platform role. */
export const PLATFORM_SECRETS: Record<PlatformRole | 'server', string> = {
  server: 'di-scheduler-nats-tls',
  operator: 'di-scheduler-operator-tls',
  host: 'di-scheduler-platform-host-tls',
  data: 'di-scheduler-data-tls',
};

/** The longest Kubernetes namespace name (a DNS label). */
const MAX_NAMESPACE = 63;
/**
 * The namespace that holds the CA keys and the identity record: `<platform-ns>-scheduler-pki`.
 * Throws when that is not a valid namespace name, so the platform namespace is refused before
 * anything is created.
 */
export function schedulerPkiNamespace(namespace: string): string {
  const name = `${namespace}-scheduler-pki`;
  if (name.length > MAX_NAMESPACE)
    throw new Error(
      `namespace ${namespace} is too long: the scheduler PKI namespace ${name} must be at most ${MAX_NAMESPACE} characters`,
    );
  return name;
}

/** The names a client reaches the scheduler NATS by, and the server certificate carries. */
export const natsServiceNames = (namespace: string): string[] => [
  'nats',
  `nats.${namespace}`,
  `nats.${namespace}.svc`,
  `nats.${namespace}.svc.cluster.local`,
];

/** An issuance ID: 16 random lower-case hex characters, new for every client certificate. */
export const ISSUANCE_ID = /^[0-9a-f]{16}$/;
export const newIssuanceId = (random: (size: number) => Buffer = randomBytes): string =>
  random(8).toString('hex');

/** The NATS user (and only DNS name) of the platform identity `role` issued as `id`. */
export const platformUser = (role: PlatformRole, id: string): string =>
  `${id}.${role}.${PLATFORM_SUBTREE}`;
/** The NATS user of tenant `tenant`'s hosts issued as `id`; under the tenant CA's subtree. */
export const tenantHostUser = (tenant: string, id: string): string =>
  `${id}.di-tenant-${tenant}.${TENANT_SUBTREE}`;
/** The NATS user of tenant `tenant`'s runtime-operator issued as `id`; under the platform subtree. */
export const tenantOperatorUser = (tenant: string, id: string): string =>
  `${id}.operator.di-tenant-${tenant}.${PLATFORM_SUBTREE}`;

/** What a scheduler CA permits, as {@link newSchedulerCa} writes it. */
export interface SchedulerCaProfile {
  commonName: string;
  dns: string[];
  email: string[];
  uri: string[];
}
export type SchedulerCaKind = 'platform' | 'tenant';

/** The name constraints of each scheduler CA for the platform namespace `namespace`. */
export function schedulerCaProfile(kind: SchedulerCaKind, namespace: string): SchedulerCaProfile {
  return kind === 'platform'
    ? {
        commonName: `di-framework platform scheduler CA (${namespace})`,
        dns: [PLATFORM_SUBTREE, ...natsServiceNames(namespace)],
        email: [PLATFORM_SUBTREE],
        uri: [PLATFORM_SUBTREE],
      }
    : {
        commonName: `di-framework tenant scheduler CA (${namespace})`,
        dns: [TENANT_SUBTREE],
        email: [TENANT_SUBTREE],
        uri: [TENANT_SUBTREE],
      };
}

/** A new scheduler CA of `kind`: {@link SCHEDULER_CA_DAYS}, name-constrained, no IP address. */
export function newSchedulerCa(kind: SchedulerCaKind, namespace: string, now: Date): KeyPair {
  const p = schedulerCaProfile(kind, namespace);
  return caCertificate(p.commonName, SCHEDULER_CA_DAYS, now, p.dns, true, {
    email: p.email,
    uri: p.uri,
  });
}

/**
 * Both scheduler CA sets: per kind, the CA that signs (`current`) and, during a rotation, its
 * successor (`next`) and the CA it replaced (`previous`).
 */
export type SchedulerCas = Record<SchedulerCaKind, ControllerCas>;

/**
 * What every scheduler client trusts (`ca.crt` of a client Secret): the platform CA set, oldest
 * first, since clients verify only the NATS server, whose leaf the platform CA signs.
 */
export const schedulerClientBundle = (cas: SchedulerCas): string => caBundle(cas.platform);
/**
 * What the NATS server trusts (`ca.crt` of `di-scheduler-nats-tls`, its `ca_file`): both CA sets,
 * platform first, since it verifies clients of both CAs.
 */
export const schedulerServerBundle = (cas: SchedulerCas): string =>
  `${caBundle(cas.platform)}${caBundle(cas.tenant)}`;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/**
 * Why `ca` cannot serve as the scheduler CA of `kind` at `now`, or undefined when it can: it must
 * be a CA certificate that has not expired, `key` must be its key, and its name constraints must
 * be exactly the profile's, with every IP address excluded.
 */
export function schedulerCaFault(
  kind: SchedulerCaKind,
  namespace: string,
  ca: Partial<KeyPair>,
  now: Date,
): string | undefined {
  if (!ca.cert || !ca.key || !holdsCaKey(ca.cert, ca.key))
    return `the ${kind} CA certificate or key is missing or does not match`;
  if (!certificateValid(ca.cert, 0, now)) return `the ${kind} CA has expired`;
  const profile = schedulerCaProfile(kind, namespace);
  const constraints = caConstraints(ca.cert);
  const other = caOtherPermitted(ca.cert);
  if (
    !constraints?.excludesIps ||
    !sameSet(constraints.dns, profile.dns) ||
    !sameSet(other?.email ?? [], profile.email) ||
    !sameSet(other?.uri ?? [], profile.uri)
  )
    return `the ${kind} CA does not carry the ${kind} scheduler name constraints`;
  return undefined;
}

/** The `kind` CA set as stored in {@link SCHEDULER_CA_SECRET}'s base64 `data`, each part possibly missing. */
export function storedSchedulerCas(
  data: Record<string, string> | undefined,
  kind: SchedulerCaKind,
): StoredCas {
  const read = (key: string) => {
    const value = data?.[key];
    return value === undefined ? undefined : Buffer.from(value, 'base64').toString('utf8');
  };
  const keys = CA_KEYS[kind];
  const next = { cert: read(keys.nextCert), key: read(keys.nextKey) };
  const previous = read(keys.previous);
  return {
    current: { cert: read(keys.cert), key: read(keys.key) },
    ...(next.cert || next.key ? { next } : {}),
    ...(previous ? { previous } : {}),
  };
}

/**
 * The `kind` CA set exactly as stored, or why its signing CA cannot sign: `current` must pass
 * {@link schedulerCaFault}; a `next` that does not is left out, and so is a `previous` that is no
 * longer a CA certificate in force. Nothing is created or switched (the bootstrap Job reads this
 * way, and the controller when it cannot write a rotation).
 */
export function readSchedulerCaSet(
  kind: SchedulerCaKind,
  namespace: string,
  stored: StoredCas,
  now: Date,
): ControllerCas | string {
  const fault = schedulerCaFault(kind, namespace, stored.current ?? {}, now);
  if (fault) return fault;
  const { next, previous } = stored;
  return {
    current: stored.current as KeyPair,
    ...(next && !schedulerCaFault(kind, namespace, next, now) ? { next: next as KeyPair } : {}),
    // The rotation's own bound (`keptAsPrevious`), so the bundles are the same whether or not a
    // rotation write lands.
    ...(keptAsPrevious(previous, (stored.current as KeyPair).cert, now) ? { previous } : {}),
  };
}

/**
 * The `kind` CA set after one rotation pass at `now` (#629): the steps of `rotateCas`
 * (`ca-rotation.ts`) with the scheduler's own CAs.
 *
 * 1. **Publish.** Within `CA_RENEW_DAYS` of the signing CA's expiry a successor is created. It
 *    joins every trust bundle while the current CA still signs.
 * 2. **Switch.** Never in the pass that publishes the successor. Once it is `CA_OVERLAP_DAYS` old
 *    (sooner when the current CA has less than {@link LEAF_RENEW_DAYS} left) and `holdersTrust`
 *    (every client Secret's and the server's `ca.crt` carries it and no renewal still holds it,
 *    see `loadSchedulerCas`, which only the platform pass evaluates), it signs and the old CA
 *    becomes `previous`; within `CA_SWITCH_DEADLINE_DAYS` of the current CA's expiry it signs
 *    whether or not they do. Every leaf the old CA signed is then renewed against the new one.
 * 3. **Retire.** `previous` leaves the bundles when it expires.
 *
 * A successor that does not pass {@link schedulerCaFault} is dropped and a new one published. A
 * signing CA that does not pass it is replaced by a usable successor at once, and is not kept as
 * `previous`; without a usable successor the fault is returned and nothing is created, as before
 * (#541): a missing or broken scheduler CA is an operator's to look at.
 */
export function nextSchedulerCas(
  kind: SchedulerCaKind,
  namespace: string,
  stored: StoredCas,
  now: Date,
  holdersTrust = false,
): ControllerCas | string {
  const fault = (ca: Partial<KeyPair>) => schedulerCaFault(kind, namespace, ca, now);
  const currentFault = fault(stored.current ?? {});
  const next = stored.next && !fault(stored.next) ? stored.next : undefined;
  if (currentFault && !next) return currentFault;
  return rotateCaSet(
    currentFault ? { next } : { current: stored.current, next, previous: stored.previous },
    {
      fresh: () => newSchedulerCa(kind, namespace, now),
      wanted: (ca) => !fault(ca),
      gate: { holdersTrust },
    },
    now,
  );
}

/**
 * The base64 entries of {@link SCHEDULER_CA_SECRET} for `kind`'s set `cas`; a key whose part is
 * absent maps to undefined, so the caller removes it.
 */
export function schedulerCaData(
  kind: SchedulerCaKind,
  cas: ControllerCas,
): Record<string, string | undefined> {
  const b64 = (text: string | undefined) =>
    text === undefined ? undefined : Buffer.from(text).toString('base64');
  const keys = CA_KEYS[kind];
  return {
    [keys.cert]: b64(cas.current.cert),
    [keys.key]: b64(cas.current.key),
    [keys.nextCert]: b64(cas.next?.cert),
    [keys.nextKey]: b64(cas.next?.key),
    [keys.previous]: b64(cas.previous),
  };
}

/** A platform client identity: a client-auth leaf from the platform CA naming only its user. */
export function platformClientLeaf(
  role: PlatformRole,
  id: string,
  platformCa: KeyPair,
  now: Date,
): KeyPair {
  const user = platformUser(role, id);
  return leafCertificate(
    user,
    [user],
    [],
    SCHEDULER_LEAF_DAYS,
    platformCa.cert,
    platformCa.key,
    now,
    'client',
  );
}

/** The scheduler NATS server's leaf: a server-auth leaf from the platform CA for the Service names. */
export function natsServerLeaf(namespace: string, platformCa: KeyPair, now: Date): KeyPair {
  return leafCertificate(
    'nats',
    natsServiceNames(namespace),
    [],
    SCHEDULER_LEAF_DAYS,
    platformCa.cert,
    platformCa.key,
    now,
    'server',
  );
}

/**
 * One identity's entry in the record: its current issuance ID and, during a routine renewal, the
 * previous one, since when it is kept (the pass that recorded the renewal; a pending issuance
 * never moves it, #642) and until when.
 */
export interface IdentityEntry {
  current: string;
  previous?: string;
  previousSince?: string;
  previousUntil?: string;
}
/**
 * The identity record: `platform/<role>` and `tenant/<tenant>/hosts`, `tenant/<tenant>/operator`
 * entries. Tenant keys carry their own prefix, so no Tenant name (`platform` included) can name a
 * platform entry.
 */
export type IdentityRecord = Record<string, IdentityEntry>;

/** The record key of the platform identity `role`. */
export const platformIdentity = (role: PlatformRole): string => `platform/${role}`;
/** The record key of tenant `tenant`'s hosts or runtime-operator. */
export const tenantIdentity = (tenant: string, kind: 'hosts' | 'operator'): string =>
  `tenant/${tenant}/${kind}`;
const RECORD_KEY =
  /^(platform\/(operator|host|data)|tenant\/[a-z]([-a-z0-9]*[a-z0-9])?\/(hosts|operator))$/;

/** Code-unit order, independent of the runtime's locale, so sorted output is byte-stable. */
export const codeUnitOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The identity record in `text`. Throws, naming no value, on anything that is not a record this
 * module writes: the record decides who may connect, so it is never guessed at.
 */
export function parseIdentityRecord(text: string): IdentityRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${SCHEDULER_IDENTITIES} does not hold a JSON identity record`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${SCHEDULER_IDENTITIES} does not hold a JSON identity record`);
  for (const [key, entry] of Object.entries(value)) {
    const e = entry as Partial<Record<string, unknown>> | null;
    const valid =
      RECORD_KEY.test(key) &&
      typeof e === 'object' &&
      e !== null &&
      Object.keys(e).every((field) =>
        ['current', 'previous', 'previousSince', 'previousUntil'].includes(field),
      ) &&
      typeof e.current === 'string' &&
      ISSUANCE_ID.test(e.current) &&
      (e.previous === undefined) === (e.previousUntil === undefined) &&
      (e.previous === undefined ||
        (typeof e.previous === 'string' &&
          ISSUANCE_ID.test(e.previous) &&
          typeof e.previousUntil === 'string' &&
          !Number.isNaN(Date.parse(e.previousUntil)))) &&
      // Recorded only beside `previous`, by the pass that recorded the renewal (#642).
      (e.previousSince === undefined ||
        (e.previous !== undefined &&
          typeof e.previousSince === 'string' &&
          !Number.isNaN(Date.parse(e.previousSince))));
    if (!valid) throw new Error(`${SCHEDULER_IDENTITIES} has an invalid entry '${key}'`);
  }
  return value as IdentityRecord;
}

/** The record as stored: keys sorted, so an unchanged record is byte-for-byte the same. */
export function serializeIdentityRecord(record: IdentityRecord): string {
  const sorted = Object.fromEntries(
    Object.keys(record)
      .sort(codeUnitOrder)
      .map((key) => {
        const { current, previous, previousSince, previousUntil } = record[key] as IdentityEntry;
        return [
          key,
          {
            current,
            ...(previous === undefined ? {} : { previous }),
            ...(previousSince === undefined ? {} : { previousSince }),
            ...(previousUntil === undefined ? {} : { previousUntil }),
          },
        ];
      }),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** The base64 `data` of a scheduler TLS Secret: the leaf, its key and the trust bundle `caBundle`. */
export function tlsSecretData(leaf: KeyPair, caBundle: string): Record<string, string> {
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  return { 'tls.crt': b64(leaf.cert), 'tls.key': b64(leaf.key), 'ca.crt': b64(caBundle) };
}

/** The Kubernetes API calls the bootstrap makes; the controller's `KubernetesApi` is one. */
export interface PkiApi {
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
}
/** The bootstrap's settings, from `SCHEDULER_PKI_CONFIG`. */
export interface SchedulerPkiConfig {
  installation: string;
  namespace: string;
}
/** The bootstrap found state it will not repair by overwriting; an operator must look at it. */
export class SchedulerPkiRefused extends Error {}

/** `SCHEDULER_PKI_CONFIG` as {@link SchedulerPkiConfig}; throws when it is missing or incomplete. */
export function schedulerPkiConfig(text: string | undefined): SchedulerPkiConfig {
  let parsed: Partial<SchedulerPkiConfig> = {};
  try {
    parsed = JSON.parse(text ?? '') as Partial<SchedulerPkiConfig>;
  } catch {
    /* reported below */
  }
  if (typeof parsed?.installation !== 'string' || typeof parsed.namespace !== 'string')
    throw new Error('Missing SCHEDULER_PKI_CONFIG');
  schedulerPkiNamespace(parsed.namespace);
  return { installation: parsed.installation, namespace: parsed.namespace };
}

interface Stored {
  metadata?: { resourceVersion?: string; [field: string]: unknown };
  data?: Record<string, string>;
  [field: string]: unknown;
}

/** What the bootstrap's steps share: the API, where things live, and what was written. */
interface Run {
  api: PkiApi;
  namespace: string;
  pki: string;
  now: Date;
  random: (size: number) => Buffer;
  metadata: (ns: string, name: string) => Resource['metadata'];
  create: (path: string, value: Resource) => Promise<void>;
  created: string[];
}

const secretPath = (ns: string, name = '') =>
  `/api/v1/namespaces/${ns}/secrets${name ? `/${name}` : ''}`;
const configMapPath = (ns: string, name = '') =>
  `/api/v1/namespaces/${ns}/configmaps${name ? `/${name}` : ''}`;

/** The stored CAs, or new ones written to `di-scheduler-ca` when nothing issued earlier remains. */
async function loadOrCreateCas(
  run: Run,
  storedCas: Stored | undefined,
  storedRecord: Stored | undefined,
  present: Set<string>,
): Promise<SchedulerCas> {
  const { pki, namespace, now } = run;
  if (storedCas) {
    const loaded = {} as SchedulerCas;
    for (const kind of ['platform', 'tenant'] as const) {
      const stored = storedSchedulerCas(storedCas.data, kind);
      const set = readSchedulerCaSet(kind, namespace, stored, now);
      if (typeof set === 'string')
        throw new SchedulerPkiRefused(`${pki}/${SCHEDULER_CA_SECRET}: ${set}`);
      loaded[kind] = set;
    }
    return loaded;
  }
  const roles: (PlatformRole | 'server')[] = ['server', ...PLATFORM_ROLES];
  const remaining = [
    ...(storedRecord ? [`${pki}/${SCHEDULER_IDENTITIES}`] : []),
    ...roles.filter((role) => present.has(role)).map((role) => PLATFORM_SECRETS[role]),
  ];
  if (remaining.length > 0)
    throw new SchedulerPkiRefused(
      `${pki}/${SCHEDULER_CA_SECRET} is missing, but scheduler identities issued under it ` +
        `remain (${remaining.join(', ')}); delete them to bootstrap a new scheduler PKI`,
    );
  const cas: SchedulerCas = {
    platform: { current: newSchedulerCa('platform', namespace, now) },
    tenant: { current: newSchedulerCa('tenant', namespace, now) },
  };
  const data: Record<string, string> = {};
  for (const kind of ['platform', 'tenant'] as const) {
    data[CA_KEYS[kind].cert] = Buffer.from(cas[kind].current.cert).toString('base64');
    data[CA_KEYS[kind].key] = Buffer.from(cas[kind].current.key).toString('base64');
  }
  await run.create(secretPath(pki), {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: run.metadata(pki, SCHEDULER_CA_SECRET),
    type: 'Opaque',
    data,
  } as Resource);
  return cas;
}

/**
 * The record with a new issuance ID for each missing platform identity, written before any
 * certificate is issued. A stored record is updated from the stored object, changing only
 * `identities.json`, and only under its `resourceVersion`, so a record changed since it was read
 * is not overwritten and other writers' labels, annotations and keys survive.
 */
async function updateRecord(
  run: Run,
  storedRecord: Stored | undefined,
  present: Set<string>,
): Promise<{ record: IdentityRecord; issue: PlatformRole[] }> {
  const { pki } = run;
  const record: IdentityRecord = storedRecord
    ? parseIdentityRecord(storedRecord.data?.[IDENTITIES_KEY] ?? '')
    : {};
  const issue = PLATFORM_ROLES.filter((role) => !present.has(role));
  const unrecorded = PLATFORM_ROLES.filter(
    (role) => present.has(role) && !record[platformIdentity(role)],
  );
  if (unrecorded.length > 0)
    throw new SchedulerPkiRefused(
      `${unrecorded.map((role) => PLATFORM_SECRETS[role]).join(', ')} exist without an entry in ` +
        `${pki}/${SCHEDULER_IDENTITIES}; delete them to issue new identities`,
    );
  if (issue.length === 0) return { record, issue };
  for (const role of issue) record[platformIdentity(role)] = { current: newIssuanceId(run.random) };
  const text = serializeIdentityRecord(record);
  if (!storedRecord) {
    await run.create(configMapPath(pki), {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: run.metadata(pki, SCHEDULER_IDENTITIES),
      data: { [IDENTITIES_KEY]: text },
    } as Resource);
    return { record, issue };
  }
  if (!storedRecord.metadata?.resourceVersion)
    throw new SchedulerPkiRefused(
      `${pki}/${SCHEDULER_IDENTITIES} was read without a resourceVersion, so it is not updated`,
    );
  await run.api.call('PUT', configMapPath(pki, SCHEDULER_IDENTITIES), {
    ...storedRecord,
    data: { ...storedRecord.data, [IDENTITIES_KEY]: text },
  });
  run.created.push(`${pki}/${SCHEDULER_IDENTITIES} (updated)`);
  return { record, issue };
}

/** The platform Secrets that are missing: the NATS server's, and one per role in `issue`. */
async function issueMissing(
  run: Run,
  cas: SchedulerCas,
  record: IdentityRecord,
  issue: PlatformRole[],
  present: Set<string>,
): Promise<void> {
  const { namespace, now } = run;
  const secret = (role: PlatformRole | 'server', leaf: KeyPair, bundle: string) =>
    run.create(secretPath(namespace), {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: run.metadata(namespace, PLATFORM_SECRETS[role]),
      type: 'kubernetes.io/tls',
      data: tlsSecretData(leaf, bundle),
    } as Resource);
  if (!present.has('server'))
    // The server verifies clients of both CAs; clients verify the server against the platform CA.
    // During a rotation each bundle carries every CA of the set (#629).
    await secret(
      'server',
      natsServerLeaf(namespace, cas.platform.current, now),
      schedulerServerBundle(cas),
    );
  for (const role of issue) {
    const id = (record[platformIdentity(role)] as IdentityEntry).current;
    await secret(
      role,
      platformClientLeaf(role, id, cas.platform.current, now),
      schedulerClientBundle(cas),
    );
  }
}

/**
 * The one-shot bootstrap (O4, design-541 §4.5). It creates whatever is missing and overwrites
 * nothing that exists:
 *
 * 1. `di-scheduler-ca`, both CAs, when it is missing and nothing issued by an earlier CA exists.
 *    An existing CA Secret must hold both signing CAs with their exact name constraints. The Job
 *    never rotates them (the controller does, #629); it signs with the signing CA and writes the
 *    bundles of each whole set.
 * 2. `di-scheduler-identities`: a new issuance ID for each platform identity whose Secret is
 *    missing, written before that certificate is issued. A missing Secret is a forced rotation
 *    of that identity, so it gets no previous ID. Other entries are kept as they are.
 * 3. The platform Secrets that are missing: the NATS server's, and one per platform role.
 *
 * It refuses, and changes nothing, when what exists is inconsistent: leaves or a record without
 * the CA Secret that signed them, client Secrets without a record entry, or a CA that does not
 * carry its constraints. Every step can be repeated: a run that stops part-way leaves state the
 * next run completes. It returns the objects it wrote, as `<namespace>/<name>`.
 */
export async function bootstrapSchedulerPki(
  api: PkiApi,
  config: SchedulerPkiConfig,
  now: Date = new Date(),
  random: (size: number) => Buffer = randomBytes,
): Promise<string[]> {
  const { installation, namespace } = config;
  const pki = schedulerPkiNamespace(namespace);
  const created: string[] = [];
  const run: Run = {
    api,
    namespace,
    pki,
    now,
    random,
    created,
    metadata: (ns, name) => ({
      name,
      namespace: ns,
      labels: { [INSTALLATION]: installation, [COMPONENT]: SCHEDULER_PKI_COMPONENT },
    }),
    create: async (path, value) => {
      await api.call('POST', path, value);
      created.push(`${value.metadata.namespace}/${value.metadata.name}`);
    },
  };
  const get = (path: string) =>
    api.call<Stored>('GET', path).catch((error: { code?: number }) => {
      if (error?.code === 404) return undefined;
      throw error;
    });

  const storedCas = await get(secretPath(pki, SCHEDULER_CA_SECRET));
  const storedRecord = await get(configMapPath(pki, SCHEDULER_IDENTITIES));
  const present = new Set<string>();
  for (const role of ['server', ...PLATFORM_ROLES] as const)
    if (await get(secretPath(namespace, PLATFORM_SECRETS[role]))) present.add(role);

  const cas = await loadOrCreateCas(run, storedCas, storedRecord, present);
  const { record, issue } = await updateRecord(run, storedRecord, present);
  await issueMissing(run, cas, record, issue, present);
  return created;
}
