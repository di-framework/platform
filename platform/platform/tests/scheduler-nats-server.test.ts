import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadAll } from 'js-yaml';
import {
  SCHEDULER_NATS_CONFIG,
  SCHEDULER_NATS_IMAGE,
  SCHEDULER_NATS_RELOADER_IMAGE,
  schedulerNatsLabels,
  schedulerNatsServerConfig,
  schedulerNatsServerResources,
} from '../src/scheduler-nats-server';
import { ACCOUNTS_KEY, SCHEDULER_NATS_ACCOUNTS } from '../src/tenancy/scheduler-nats';
import { natsServerLeaf, newSchedulerCa, PLATFORM_SECRETS } from '../src/tenancy/scheduler-pki';
import { GOLDEN_FILE, GOLDEN_NAMESPACE } from './support/scheduler-accounts';

const accounts = readFileSync(GOLDEN_FILE, 'utf8');

// #541 m6b: the platform-owned scheduler NATS server (design-541 §4.1-4.4).

// biome-ignore lint/suspicious/noExplicitAny: parsed manifests
type Doc = any;
const chart = (
  loadAll(
    readFileSync(path.join(import.meta.dir, 'fixtures/runtime-operator-2.8.0-nats.yaml'), 'utf8'),
  ) as Doc[]
).filter(Boolean);
const chartOf = (kind: string): Doc => chart.find((doc) => doc.kind === kind);

const rendered = schedulerNatsServerResources({ namespace: 'wasmcloud' }) as Doc[];
const of = (kind: string): Doc => rendered.find((doc) => doc.kind === kind);
const deployment = of('Deployment');
const pod = deployment.spec.template.spec;
const container = (name: string): Doc => pod.containers.find((c: Doc) => c.name === name);
const config = schedulerNatsServerConfig();

describe('identical to the chart where clients and policies look', () => {
  it('keeps the Service name, labels, selector, type and ports', () => {
    const ours = of('Service');
    const theirs = chartOf('Service');
    expect(ours.metadata).toEqual(theirs.metadata);
    expect(ours.spec).toEqual(theirs.spec);
  });

  it('keeps the workload kind, name, labels, selector, replicas and ports', () => {
    const theirs = chartOf('Deployment');
    expect(deployment.kind).toBe(theirs.kind);
    expect(deployment.metadata).toEqual(theirs.metadata);
    expect(deployment.spec.replicas).toBe(theirs.spec.replicas);
    expect(deployment.spec.selector).toEqual(theirs.spec.selector);
    expect(deployment.spec.template.metadata.labels).toEqual(theirs.spec.template.metadata.labels);
    const chartNats = theirs.spec.template.spec.containers[0];
    expect(container('nats').ports).toEqual(chartNats.ports);
    expect(container('nats').livenessProbe).toEqual(chartNats.livenessProbe);
    expect(container('nats').readinessProbe).toEqual(chartNats.readinessProbe);
    expect(container('nats').resources).toEqual(chartNats.resources);
    expect(container('nats').securityContext).toEqual(chartNats.securityContext);
    expect(pod.securityContext).toEqual(theirs.spec.template.spec.securityContext);
    expect(pod.automountServiceAccountToken).toBe(false);
  });

  it('carries the chart label set for another release name', () => {
    const labels = schedulerNatsLabels('other');
    expect(labels['app.kubernetes.io/instance']).toBe('other');
    const ours = schedulerNatsServerResources({ namespace: 'p', release: 'other' }) as Doc[];
    for (const doc of ours) {
      expect(doc.metadata.namespace).toBe('p');
      expect(doc.metadata.labels).toEqual(labels);
    }
  });
});

describe('the server', () => {
  it('runs the pinned nats-server without debug or trace flags', () => {
    expect(SCHEDULER_NATS_IMAGE).toMatch(
      /^docker\.io\/library\/nats:2\.12\.8-alpine@sha256:[0-9a-f]{64}$/,
    );
    // The chart's tag, now by digest.
    expect(SCHEDULER_NATS_IMAGE.split('@')[0]?.replace('/library', '')).toBe(
      chartOf('Deployment').spec.template.spec.containers[0].image,
    );
    expect(container('nats').image).toBe(SCHEDULER_NATS_IMAGE);
    expect(container('nats').args).toEqual(['-c', '/nats-config/nats-server.conf']);
    expect(config).not.toMatch(/\b(debug|trace|logtime)\b/);
  });

  it('serves mTLS from the platform server Secret and maps the certificate to a user', () => {
    expect(config).toContain('tls {');
    expect(config).toContain('cert_file: "/nats-cert/tls.crt"');
    expect(config).toContain('key_file: "/nats-cert/tls.key"');
    expect(config).toContain('ca_file: "/nats-cert/ca.crt"');
    expect(config).toContain('verify_and_map: true');
    const cert = pod.volumes.find((v: Doc) => v.name === 'nats-cert');
    expect(cert.secret.secretName).toBe(PLATFORM_SECRETS.server);
    expect(cert.secret.secretName).toBe('di-scheduler-nats-tls');
  });

  it('includes accounts.conf from the controller-written ConfigMap and has no inline users', () => {
    expect(config).toContain('include "accounts/accounts.conf"');
    expect(config).not.toMatch(/authorization|users|accounts \{/);
    const sources = pod.volumes.find((v: Doc) => v.name === 'nats-config').projected.sources;
    expect(sources).toEqual([
      {
        configMap: {
          name: SCHEDULER_NATS_CONFIG,
          items: [{ key: 'nats-server.conf', path: 'nats-server.conf' }],
        },
      },
      {
        configMap: {
          name: SCHEDULER_NATS_ACCOUNTS,
          items: [{ key: ACCOUNTS_KEY, path: 'accounts/accounts.conf' }],
        },
      },
    ]);
    // Required, never optional: a server without accounts would admit no one.
    expect(JSON.stringify(sources)).not.toContain('optional');
    expect(of('ConfigMap').metadata.name).toBe('di-scheduler-nats');
    expect(of('ConfigMap').data['nats-server.conf']).toBe(config);
  });

  it('enables JetStream at server level only, on the chart store, for the DATA account', () => {
    expect(config).toContain('jetstream {\n  store_dir: "/data/jetstream"\n}');
    // Only the accounts file turns it on per account, and only for DATA (O5).
    expect(accounts.match(/jetstream: enabled/g)).toHaveLength(1);
    expect(accounts).toMatch(/DATA: \{\n\s*jetstream: enabled/);
    expect(container('nats').volumeMounts).toContainEqual({
      name: 'jetstream',
      mountPath: '/data/jetstream',
    });
    expect(pod.volumes).toContainEqual({ name: 'jetstream', emptyDir: {} });
  });

  it('has a token-less ServiceAccount', () => {
    const sa = of('ServiceAccount');
    expect(sa.automountServiceAccountToken).toBe(false);
    expect(pod.serviceAccountName).toBe(sa.metadata.name);
  });
});

describe('the reloader', () => {
  const reloader = container('reloader');

  it('is the pinned upstream reloader in the shared process namespace', () => {
    expect(SCHEDULER_NATS_RELOADER_IMAGE).toMatch(
      /^docker\.io\/natsio\/nats-server-config-reloader:0\.24\.0@sha256:[0-9a-f]{64}$/,
    );
    expect(reloader.image).toBe(SCHEDULER_NATS_RELOADER_IMAGE);
    expect(pod.shareProcessNamespace).toBe(true);
    expect(reloader.securityContext).toEqual(container('nats').securityContext);
  });

  it('watches the config, the accounts file and the certificate, and signals via the pid file', () => {
    expect(config).toContain('pid_file: "/var/run/nats/nats.pid"');
    expect(reloader.args).toEqual([
      '-pid',
      '/var/run/nats/nats.pid',
      '-config',
      '/nats-config/nats-server.conf',
      '-config',
      '/nats-config/accounts/accounts.conf',
      '-config',
      '/nats-cert/tls.crt',
      '-config',
      '/nats-cert/tls.key',
      '-config',
      '/nats-cert/ca.crt',
    ]);
    for (const name of ['nats-config', 'nats-cert', 'pid']) {
      const mount = (c: Doc) => c.volumeMounts.find((m: Doc) => m.name === name);
      expect(mount(reloader)).toEqual(mount(container('nats')));
    }
  });
});

/**
 * `nats-server -t` on the rendered config, the golden accounts file and freshly minted
 * certificates, in the pinned image. It needs docker or podman, so it runs only with
 * SCHEDULER_NATS_BROKER=1, like the broker test.
 */
const broker = process.env.SCHEDULER_NATS_BROKER === '1';
const runtime = !broker
  ? 'docker'
  : (process.env.CONTAINER_RUNTIME ??
    (spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0 ? 'docker' : 'podman'));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.if(broker)('the real nats-server', () => {
  it('accepts the rendered configuration', () => {
    const now = new Date();
    const platformCa = newSchedulerCa('platform', GOLDEN_NAMESPACE, now);
    const tenantCa = newSchedulerCa('tenant', GOLDEN_NAMESPACE, now);
    const leaf = natsServerLeaf(GOLDEN_NAMESPACE, platformCa, now);
    const root = mkdtempSync(path.join(tmpdir(), 'scheduler-nats-server-'));
    dirs.push(root);
    mkdirSync(path.join(root, 'config/accounts'), { recursive: true });
    mkdirSync(path.join(root, 'cert'));
    writeFileSync(path.join(root, 'config/nats-server.conf'), config);
    writeFileSync(path.join(root, 'config/accounts/accounts.conf'), accounts);
    writeFileSync(path.join(root, 'cert/tls.crt'), leaf.cert);
    writeFileSync(path.join(root, 'cert/tls.key'), leaf.key, { mode: 0o644 });
    writeFileSync(path.join(root, 'cert/ca.crt'), `${platformCa.cert}${tenantCa.cert}`);
    const result = spawnSync(
      runtime,
      [
        'run',
        '--rm',
        '-v',
        `${root}/config:/nats-config:ro`,
        '-v',
        `${root}/cert:/nats-cert:ro`,
        SCHEDULER_NATS_IMAGE,
        '-t',
        '-c',
        '/nats-config/nats-server.conf',
      ],
      { encoding: 'utf8', timeout: 300_000 },
    );
    expect(`${result.stdout}${result.stderr}`).toContain('configuration file');
    expect(result.status).toBe(0);
  });
});
