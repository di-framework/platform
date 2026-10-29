import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type AccountsRender, renderSchedulerAccounts } from '../src/tenancy/scheduler-nats';
import {
  type IdentityRecord,
  natsServerLeaf,
  newSchedulerCa,
  type PlatformRole,
  platformClientLeaf,
  platformUser,
  SCHEDULER_LEAF_DAYS,
  tenantHostUser,
  tenantOperatorUser,
} from '../src/tenancy/scheduler-pki';
import { type KeyPair, leafCertificate } from '../src/tenancy/tls';
import { type Credentials, NatsClient } from './support/nats-client';
import {
  GOLDEN_FILE,
  GOLDEN_IDS,
  GOLDEN_NAMESPACE,
  GOLDEN_NOW,
  GOLDEN_RECORD,
  GOLDEN_TENANTS,
} from './support/scheduler-accounts';

/**
 * The scheduler NATS broker test (#541 m2, design-541 §8.2): nats-server 2.12.8, pinned by
 * digest, serving the golden `accounts.conf` behind freshly minted scheduler CAs, with the static
 * server settings of §4.1 (`verify_and_map`, both CAs, JetStream at server level) and no network
 * policy. It checks the authorization matrix, forged certificates, and reloads.
 *
 * It needs docker or podman and pulls one image, so it runs only with SCHEDULER_NATS_BROKER=1 (the
 * `scheduler-nats-broker` job in .github/workflows/ci.yml); plain `bun test` skips it.
 * CONTAINER_RUNTIME picks the runtime; docker is the default when it is on PATH.
 */
const SCHEDULER_NATS_TEST_IMAGE =
  'docker.io/library/nats:2.12.8-alpine@sha256:6b2156f7491cdeddfa8b7ca15cd6fd59b9cabadec5019e933c65c01cf82b1c5f';

const enabled = process.env.SCHEDULER_NATS_BROKER === '1';
const runtime = !enabled
  ? 'docker'
  : (process.env.CONTAINER_RUNTIME ??
    (spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0 ? 'docker' : 'podman'));
const server = `scheduler-nats-broker-${randomBytes(4).toString('hex')}`;
const DIR = '/tmp/nats';
const ACCOUNTS = `${DIR}/accounts/accounts.conf`;
const SERVER_CONF = `port: 4222
pid_file: "/tmp/nats.pid"
tls {
  cert_file: "${DIR}/server.crt"
  key_file: "${DIR}/server.key"
  ca_file: "${DIR}/ca.crt"
  verify_and_map: true
}
jetstream { store_dir: "/tmp/js" }
include "accounts/accounts.conf"
`;

function container(args: string[], env: Record<string, string> = {}) {
  const child = spawnSync(runtime, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}
function mustRun(args: string[], env: Record<string, string> = {}) {
  const result = container(args, env);
  if (result.status !== 0) throw new Error(`${runtime} ${args[0]} failed: ${result.stderr}`);
  return result;
}
const text = (render: AccountsRender): string => {
  if (!('text' in render)) throw new Error(`refused: ${JSON.stringify(render.problems)}`);
  return render.text;
};
/** Replaces the server's accounts file and signals a reload, as the reloader does from m6. */
function reload(accounts: string) {
  mustRun(
    [
      'exec',
      '-e',
      'ACCOUNTS',
      server,
      'sh',
      '-c',
      `printf '%s' "$ACCOUNTS" > ${ACCOUNTS} && nats-server --signal reload=/tmp/nats.pid`,
    ],
    { ACCOUNTS: accounts },
  );
}
const until = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(100);
  }
  return false;
};

const now = new Date();
const platformCa = newSchedulerCa('platform', GOLDEN_NAMESPACE, now);
const tenantCa = newSchedulerCa('tenant', GOLDEN_NAMESPACE, now);
const serverLeaf = natsServerLeaf(GOLDEN_NAMESPACE, platformCa, now);
/** Clients verify the server against the platform CA (§4.5). */
const creds = (leaf: KeyPair): Credentials => ({ ca: platformCa.cert, ...leaf });
const clientLeaf = (user: string, ca: KeyPair, at = now, usage: 'client' | 'server' = 'client') =>
  leafCertificate(user, [user], [], SCHEDULER_LEAF_DAYS, ca.cert, ca.key, at, usage);
const platform = (role: PlatformRole, id: string) =>
  creds(platformClientLeaf(role, id, platformCa, now));
const host = (tenant: string, id: string) =>
  creds(clientLeaf(tenantHostUser(tenant, id), tenantCa));
const operator = (tenant: string, id: string) =>
  creds(clientLeaf(tenantOperatorUser(tenant, id), platformCa));

const PERMISSION_PUB = (subject: string) => `Permissions Violation for Publish to "${subject}"`;
const PERMISSION_SUB = (subject: string) =>
  `Permissions Violation for Subscription to "${subject}"`;

let port = 0;
/** Clients closed after each test, so no account reaches its connection limit by accident. */
const open: NatsClient[] = [];
/** Clients kept across the reload tests. */
const kept: NatsClient[] = [];
async function connect(credentials: Credentials, keep = false): Promise<NatsClient> {
  const result = await NatsClient.connect(port, credentials);
  if ('refused' in result) throw new Error(`refused: ${result.refused}`);
  (keep ? kept : open).push(result.client);
  return result.client;
}
/** True when `credentials` connect; the connection is closed again. */
async function admitted(credentials: Credentials): Promise<boolean> {
  const result = await NatsClient.connect(port, credentials);
  if ('client' in result) result.client.close();
  return 'client' in result;
}
async function refused(credentials: Credentials): Promise<string> {
  const result = await NatsClient.connect(port, credentials);
  if ('client' in result) {
    result.client.close();
    throw new Error('connected');
  }
  return result.refused;
}

describe.skipIf(!enabled)('scheduler NATS broker (#541 m2, design-541 §8.2)', () => {
  const golden = readFileSync(GOLDEN_FILE, 'utf8');

  beforeAll(async () => {
    const files = {
      SERVER_CONF,
      ACCOUNTS_CONF: golden,
      SERVER_CRT: serverLeaf.cert,
      SERVER_KEY: serverLeaf.key,
      // The server's ca_file: both CAs (§4.1).
      CA_CRT: `${platformCa.cert}${tenantCa.cert}`,
    };
    const write = [
      `mkdir -p ${DIR}/accounts`,
      `printf '%s' "$SERVER_CONF" > ${DIR}/nats-server.conf`,
      `printf '%s' "$ACCOUNTS_CONF" > ${ACCOUNTS}`,
      `printf '%s' "$SERVER_CRT" > ${DIR}/server.crt`,
      `printf '%s' "$SERVER_KEY" > ${DIR}/server.key`,
      `printf '%s' "$CA_CRT" > ${DIR}/ca.crt`,
      `exec nats-server -c ${DIR}/nats-server.conf`,
    ].join(' && ');
    mustRun(
      [
        'run',
        '-d',
        '--name',
        server,
        '-p',
        '127.0.0.1::4222',
        ...Object.keys(files).flatMap((name) => ['-e', name]),
        '--entrypoint',
        'sh',
        SCHEDULER_NATS_TEST_IMAGE,
        '-c',
        write,
      ],
      files,
    );
    const mapped = mustRun(['port', server, '4222/tcp']).stdout.trim().split('\n')[0] ?? '';
    port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
    const ready = await until(() => admitted(platform('host', GOLDEN_IDS.platformHost)), 60_000);
    if (!ready) throw new Error(`nats-server did not start: ${container(['logs', server]).stderr}`);
  }, 300_000);

  afterEach(async () => {
    for (const client of open.splice(0)) client.close();
    await Bun.sleep(200);
  });

  afterAll(() => {
    for (const client of kept) client.close();
    if (enabled) container(['rm', '-f', server]);
  });

  it('serves the golden accounts file, which the renderer reproduces', () => {
    expect(
      text(renderSchedulerAccounts(GOLDEN_NAMESPACE, GOLDEN_TENANTS, GOLDEN_RECORD, GOLDEN_NOW)),
    ).toBe(golden);
    expect(container(['logs', server]).stderr).toContain('Server is ready');
  });

  it('admits every recorded identity, the routine-renewal previous user included', async () => {
    for (const credentials of [
      platform('operator', GOLDEN_IDS.platformOperator),
      platform('host', GOLDEN_IDS.platformHost),
      platform('data', GOLDEN_IDS.platformData),
      host('a', GOLDEN_IDS.aHosts),
      operator('a', GOLDEN_IDS.aOperator),
      operator('a', GOLDEN_IDS.aOperatorPrevious),
      host('b', GOLDEN_IDS.bHosts),
      operator('b', GOLDEN_IDS.bOperator),
    ]) {
      const client = await connect(credentials);
      expect(await client.flush()).toBe(true);
      expect(client.errors).toEqual([]);
    }
  });

  it('delivers heartbeats only to their own tenant operator', async () => {
    const aOperator = await connect(operator('a', GOLDEN_IDS.aOperator));
    const bOperator = await connect(operator('b', GOLDEN_IDS.bOperator));
    const platformOperator = await connect(platform('operator', GOLDEN_IDS.platformOperator));
    for (const op of [aOperator, bOperator, platformOperator]) {
      op.sub('runtime.operator.heartbeat.>');
      await op.flush();
    }
    const aHost = await connect(host('a', GOLDEN_IDS.aHosts));
    const bHost = await connect(host('b', GOLDEN_IDS.bHosts));
    const platformHost = await connect(platform('host', GOLDEN_IDS.platformHost));
    aHost.pub('runtime.operator.heartbeat.HA', '{"environment":"di-tenant-a"}');
    // B claims A's environment and host ID: it still reaches only B's operator.
    bHost.pub('runtime.operator.heartbeat.HA', '{"environment":"di-tenant-a"}');
    platformHost.pub('runtime.operator.heartbeat.HP', '{}');
    for (const client of [aHost, bHost, platformHost, aOperator, bOperator, platformOperator])
      expect(await client.flush()).toBe(true);
    expect(aOperator.messages.map((m) => m.subject)).toEqual(['runtime.operator.heartbeat.HA']);
    expect(bOperator.messages.map((m) => m.subject)).toEqual(['runtime.operator.heartbeat.HA']);
    expect(platformOperator.messages.map((m) => m.subject)).toEqual([
      'runtime.operator.heartbeat.HP',
    ]);
    for (const client of [aHost, bHost, platformHost]) expect(client.errors).toEqual([]);
  });

  it('delivers commands only inside the account, with the reply through its own _INBOX', async () => {
    const aOperator = await connect(operator('a', GOLDEN_IDS.aOperator));
    const bOperator = await connect(operator('b', GOLDEN_IDS.bOperator));
    const aHost = await connect(host('a', GOLDEN_IDS.aHosts));
    const aWatcher = await connect(host('a', GOLDEN_IDS.aHosts));
    aOperator.sub('_INBOX.a.>');
    aHost.sub('runtime.host.HA.>');
    aWatcher.sub('runtime.host.*.>');
    for (const client of [aOperator, aHost, aWatcher]) await client.flush();
    bOperator.pub('runtime.host.HA.workload.start', 'secret-of-b', '_INBOX.b.1');
    aOperator.pub('runtime.host.HA.workload.start', 'start-a', '_INBOX.a.1');
    await bOperator.flush();
    await aOperator.flush();
    await aHost.flush();
    await aWatcher.flush();
    expect(aHost.messages).toEqual([
      {
        subject: 'runtime.host.HA.workload.start',
        sid: '1',
        reply: '_INBOX.a.1',
        payload: 'start-a',
      },
    ]);
    expect(aWatcher.messages.map((m) => m.payload)).toEqual(['start-a']);
    // allow_responses: the host answers the request it received, once.
    aHost.pub('_INBOX.a.1', 'ok');
    aHost.pub('_INBOX.a.1', 'again');
    await aHost.flush();
    expect(await aOperator.flush()).toBe(true);
    expect(aOperator.on('_INBOX.a.1').map((m) => m.payload)).toEqual(['ok']);
    expect(aHost.errors).toEqual([PERMISSION_PUB('_INBOX.a.1')]);
    expect(bOperator.errors).toEqual([]);
  });

  it('refuses every subject outside a role with a permissions violation', async () => {
    const aHost = await connect(host('a', GOLDEN_IDS.aHosts));
    aHost.sub('_INBOX.>');
    aHost.sub('runtime.operator.heartbeat.>');
    aHost.sub('>');
    aHost.pub('runtime.host.HX.workload.start');
    aHost.pub('runtime.host.HB.workload.status');
    aHost.pub('_INBOX.x');
    aHost.pub('$JS.API.INFO');
    expect(await aHost.flush()).toBe(true);
    expect(aHost.errors).toEqual([
      PERMISSION_SUB('_INBOX.>'),
      PERMISSION_SUB('runtime.operator.heartbeat.>'),
      PERMISSION_SUB('>'),
      PERMISSION_PUB('runtime.host.HX.workload.start'),
      PERMISSION_PUB('runtime.host.HB.workload.status'),
      PERMISSION_PUB('_INBOX.x'),
      PERMISSION_PUB('$JS.API.INFO'),
    ]);
    const aOperator = await connect(operator('a', GOLDEN_IDS.aOperator));
    aOperator.sub('>');
    aOperator.sub('runtime.host.>');
    aOperator.pub('runtime.operator.heartbeat.HA');
    // Another account's reply subject (and any _INBOX) is not the operator's to publish.
    aOperator.pub('_INBOX.b.1');
    aOperator.pub('$JS.API.INFO');
    expect(await aOperator.flush()).toBe(true);
    expect(aOperator.errors).toEqual([
      PERMISSION_SUB('>'),
      PERMISSION_SUB('runtime.host.>'),
      PERMISSION_PUB('runtime.operator.heartbeat.HA'),
      PERMISSION_PUB('_INBOX.b.1'),
      PERMISSION_PUB('$JS.API.INFO'),
    ]);
  });

  it('gives JetStream to DATA only (O5), which sees no scheduler traffic', async () => {
    const data = await connect(platform('data', GOLDEN_IDS.platformData));
    data.sub('runtime.>');
    data.sub('_INBOX.data.>');
    await data.flush();
    data.pub('$JS.API.INFO', '', '_INBOX.data.1');
    const platformHost = await connect(platform('host', GOLDEN_IDS.platformHost));
    platformHost.pub('runtime.operator.heartbeat.HP');
    await platformHost.flush();
    expect(await until(() => data.on('_INBOX.data.1').length === 1)).toBe(true);
    expect(JSON.parse(data.on('_INBOX.data.1')[0]?.payload ?? '{}').type).toBe(
      'io.nats.jetstream.api.v1.account_info_response',
    );
    expect(data.messages.filter((m) => m.subject.startsWith('runtime.'))).toEqual([]);
  });

  describe('forged certificates are refused', () => {
    const foreignPlatform = newSchedulerCa('platform', GOLDEN_NAMESPACE, now);
    const foreignTenant = newSchedulerCa('tenant', GOLDEN_NAMESPACE, now);
    const aHostLeaf = clientLeaf(tenantHostUser('a', GOLDEN_IDS.aHosts), tenantCa);

    it('a CA that is not the tenant CA, claiming a recorded user', async () => {
      expect(
        await refused(creds(clientLeaf(tenantHostUser('b', GOLDEN_IDS.bHosts), foreignTenant))),
      ).toMatch(/^(tls|closed)/);
      expect(
        await refused(
          creds(clientLeaf(tenantOperatorUser('a', GOLDEN_IDS.aOperator), foreignPlatform)),
        ),
      ).toMatch(/^(tls|closed)/);
    });

    it("a tenant host's own certificate used as a CA to claim another tenant", async () => {
      expect(
        await refused(creds(clientLeaf(tenantHostUser('b', GOLDEN_IDS.bHosts), aHostLeaf))),
      ).toMatch(/^(tls|closed)/);
    });

    it('a tenant CA certificate claiming another tenant, or an unrecorded issuance', async () => {
      expect(
        await refused(creds(clientLeaf(tenantHostUser('b', 'bbbbbbbbbbbbbbbf'), tenantCa))),
      ).toBe('Authorization Violation');
      expect(
        await refused(creds(clientLeaf(tenantHostUser('a', 'aaaaaaaaaaaaaaaf'), tenantCa))),
      ).toBe('Authorization Violation');
    });

    it('a tenant CA certificate outside its name constraints', async () => {
      for (const user of [
        tenantOperatorUser('a', GOLDEN_IDS.aOperator),
        platformUser('operator', GOLDEN_IDS.platformOperator),
        'aaaaaaaaaaaaaaa1.di-tenant-a.tenants.scheduler.example',
      ])
        expect(await refused(creds(clientLeaf(user, tenantCa)))).toMatch(/^(tls|closed)/);
    });

    it('an expired certificate of a recorded user', async () => {
      const issued = new Date(now.getTime() - (SCHEDULER_LEAF_DAYS + 1) * 86_400_000);
      expect(
        await refused(creds(clientLeaf(tenantHostUser('a', GOLDEN_IDS.aHosts), tenantCa, issued))),
      ).toMatch(/^(tls|closed)/);
    });

    it('a server-auth certificate, and one with no user name', async () => {
      expect(
        await refused(
          creds(clientLeaf(tenantHostUser('a', GOLDEN_IDS.aHosts), tenantCa, now, 'server')),
        ),
      ).toMatch(/^(tls|closed)/);
      expect(
        await refused(
          creds(
            leafCertificate(
              tenantHostUser('a', GOLDEN_IDS.aHosts),
              [],
              [],
              90,
              tenantCa.cert,
              tenantCa.key,
              now,
              'client',
            ),
          ),
        ),
      ).toBe('Authorization Violation');
    });
  });

  describe('reloads', () => {
    const cHosts = 'ccccccccccccccc1';
    const cOperator = 'ccccccccccccccc2';
    const withC: IdentityRecord = {
      ...GOLDEN_RECORD,
      'tenant/c/hosts': { current: cHosts },
      'tenant/c/operator': { current: cOperator },
    };
    const tenantsWithC = [...GOLDEN_TENANTS, { metadata: { name: 'c' } }];
    let aHost: NatsClient;
    let bHost: NatsClient;
    let bOperator: NatsClient;

    beforeAll(async () => {
      aHost = await connect(host('a', GOLDEN_IDS.aHosts), true);
      bHost = await connect(host('b', GOLDEN_IDS.bHosts), true);
      bOperator = await connect(operator('b', GOLDEN_IDS.bOperator), true);
    });

    it('adds a tenant without disconnecting anyone else', async () => {
      expect(await refused(host('c', cHosts))).toBe('Authorization Violation');
      reload(text(renderSchedulerAccounts(GOLDEN_NAMESPACE, tenantsWithC, withC, now)));
      expect(await until(() => admitted(host('c', cHosts)))).toBe(true);
      for (const client of [aHost, bHost, bOperator]) expect(await client.flush()).toBe(true);
    });

    it('enforces max_connections per account, leaving other accounts untouched', async () => {
      const cs: NatsClient[] = [];
      for (let i = 0; i < 6; i++) cs.push(await connect(host('c', cHosts)));
      for (const c of cs) expect(await c.flush()).toBe(true);
      expect(await refused(host('c', cHosts))).toBe('maximum account active connections exceeded');
      expect(await refused(operator('c', cOperator))).toBe(
        'maximum account active connections exceeded',
      );
      const other = await connect(host('a', GOLDEN_IDS.aHosts));
      expect(await other.flush()).toBe(true);
      for (const c of cs) c.close();
    });

    it('keeps the previous configuration when a reload has a colliding user', async () => {
      const dHosts = 'ddddddddddddddd1';
      const withD = text(
        renderSchedulerAccounts(
          GOLDEN_NAMESPACE,
          [...tenantsWithC, { metadata: { name: 'd' } }],
          { ...withC, 'tenant/d/hosts': { current: dHosts } },
          now,
        ),
      );
      // The renderer would refuse this: B's host user also in D's account.
      const bUser = tenantHostUser('b', GOLDEN_IDS.bHosts);
      const colliding = withD.replace(
        `{ user: "${tenantHostUser('d', dHosts)}"`,
        `{ user: "${bUser}" }\n      { user: "${tenantHostUser('d', dHosts)}"`,
      );
      expect(colliding).not.toBe(withD);
      reload(colliding);
      await Bun.sleep(1_000);
      expect(await refused(host('d', dHosts))).toBe('Authorization Violation');
      for (const client of [aHost, bHost, bOperator]) expect(await client.flush()).toBe(true);
    });

    it('removing a tenant disconnects only its identities, which are then refused', async () => {
      const cHost = await connect(host('c', cHosts));
      reload(
        text(
          renderSchedulerAccounts(
            GOLDEN_NAMESPACE,
            [...GOLDEN_TENANTS.filter((t) => t.metadata.name !== 'b'), { metadata: { name: 'c' } }],
            withC,
            now,
          ),
        ),
      );
      expect(await until(() => bHost.closed && bOperator.closed)).toBe(true);
      expect(await refused(host('b', GOLDEN_IDS.bHosts))).toBe('Authorization Violation');
      expect(await refused(operator('b', GOLDEN_IDS.bOperator))).toBe('Authorization Violation');
      expect(await aHost.flush()).toBe(true);
      expect(await cHost.flush()).toBe(true);
    });

    it('a forced rotation disconnects only the old identity, which is then refused', async () => {
      const aOld = await connect(operator('a', GOLDEN_IDS.aOperator));
      const rotated = 'aaaaaaaaaaaaaaa9';
      reload(
        text(
          renderSchedulerAccounts(
            GOLDEN_NAMESPACE,
            [{ metadata: { name: 'a' } }, { metadata: { name: 'c' } }],
            { ...withC, 'tenant/a/operator': { current: rotated } },
            now,
          ),
        ),
      );
      expect(await until(() => aOld.closed)).toBe(true);
      expect(await refused(operator('a', GOLDEN_IDS.aOperator))).toBe('Authorization Violation');
      expect(await (await connect(operator('a', rotated))).flush()).toBe(true);
      expect(await aHost.flush()).toBe(true);
    });
  });
});
