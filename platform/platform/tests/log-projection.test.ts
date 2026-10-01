import { describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  admissionResources,
  hostInterfaceAllowed,
  PROJECTION_LABEL,
} from '../src/tenancy/admission';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import {
  appendRing,
  applicationKey,
  attributeEntries,
  attributeLogs,
  formatHostLine,
  formatProjectedLine,
  type HostFailure,
  logsConfigMap,
  logsConfigMapName,
  logsOptedOut,
  MAX_LINES,
  mergeFailures,
  parseGuestLogLine,
  parseHostFailureLine,
  projectedFailures,
  projectedLines,
  redactLogText,
  resolveWorkload,
  validLabelValue,
  type WorkloadIdentity,
} from '../src/tenancy/log-projection';
import {
  type ControllerConfig,
  INSTALLATION,
  names,
  type Resource,
  type Tenant,
  tenantResources,
  VERSION,
} from '../src/tenancy/resources';

const NS = 'di-tenant-alpha';

function linesOf(api: { configMaps: Map<string, Resource> }, name: string): string {
  return (api.configMaps.get(name)?.data as { lines?: string } | undefined)?.lines ?? '';
}

function projectedFailuresText(configMap: Resource | undefined): string {
  return (configMap?.data as { failures?: string } | undefined)?.failures ?? '{}';
}

/** Shape of a wash 2.8 TracingLogger event: fmt layer, no target, no ANSI. */
function hostLine(
  message: string,
  opts: { name?: string; namespace?: string; at?: string; level?: string } = {},
): string {
  const at = opts.at ?? '2026-10-01T10:00:00.000001Z';
  const level = opts.level ?? 'INFO';
  return `${at}  ${level} wasi.logging.log{level=Info context="console"}: ${message} workload.component_id="c-1" workload.name="${opts.name ?? 'mesh-collector'}" workload.namespace="${opts.namespace ?? NS}" context="console"`;
}

const deployments: WorkloadIdentity[] = [
  { name: 'mesh-collector', labels: { 'di-framework.dev/workload': 'mesh' } },
  { name: 'mesh-site', labels: { 'di-framework.dev/workload': 'mesh' } },
  { name: 'greeter', labels: { 'di-framework.dev/application': 'greeter' } },
];

describe('parseGuestLogLine', () => {
  it('reads the TracingLogger fields from the end of the line', () => {
    expect(parseGuestLogLine(hostLine('mqtt session open'))).toEqual({
      timestamp: '2026-10-01T10:00:00.000001Z',
      level: 'INFO',
      workloadName: 'mesh-collector',
      namespace: NS,
      message: 'mqtt session open',
    });
  });

  it('drops raw guest stdio, continuation lines, and host lines without a workload', () => {
    expect(parseGuestLogLine('mqtt session open')).toBeUndefined();
    expect(parseGuestLogLine('  at handler (main.js:1:1)')).toBeUndefined();
    expect(
      parseGuestLogLine('2026-10-01T10:00:00.000001Z  INFO wash_runtime::engine: workload started'),
    ).toBeUndefined();
    expect(parseGuestLogLine('')).toBeUndefined();
  });

  it('cannot be re-attributed by a message that imitates the fields', () => {
    const forged = hostLine(
      'x workload.component_id="c-2" workload.name="greeter" workload.namespace="di-tenant-alpha" context="console"',
    );
    expect(parseGuestLogLine(forged)?.workloadName).toBe('mesh-collector');
  });

  it('keeps escaped quotes in a context and strips terminal colour codes', () => {
    const line = `\u001b[2m2026-10-01T10:00:00.000001Z\u001b[0m  WARN wasi.logging.log{level=Warn context="a}\\"b"}: careful workload.component_id="c-1" workload.name="greeter" workload.namespace="${NS}" context="a}\\"b"\r`;
    expect(parseGuestLogLine(line)).toMatchObject({
      level: 'WARN',
      workloadName: 'greeter',
      message: 'careful',
    });
  });

  it('rejects a tail without a timestamp and level head', () => {
    expect(
      parseGuestLogLine(
        `garbage workload.component_id="c" workload.name="greeter" workload.namespace="${NS}" context="x"`,
      ),
    ).toBeUndefined();
    expect(
      parseGuestLogLine(
        `2026-10-01T10:00:00Z  INFO m workload.component_id="c" workload.name="" workload.namespace="${NS}" context="x"`,
      ),
    ).toBeUndefined();
  });
});

/** Real wash 2.8 host log from the `examples` cluster (ANSI stripped), tenant meshtastic. */
const SAMPLE = readFileSync(join(import.meta.dir, 'fixtures/host-log-sample.txt'), 'utf8');
const MESH_NS = 'di-tenant-meshtastic';
const meshDeployments: WorkloadIdentity[] = [
  { name: 'mesh-collector', labels: { 'di-framework.dev/workload': 'mesh' } },
  { name: 'mesh-site', labels: { 'di-framework.dev/workload': 'mesh' } },
];
const sampleLine = (needle: string) =>
  SAMPLE.split('\n').find((line) => line.includes(needle)) as string;

/** A host failure line shaped like wash 2.8: outer span, nested span, message. */
function failureLine(
  message: string,
  opts: { name?: string; namespace?: string; at?: string; level?: string; nested?: string } = {},
): string {
  const name = opts.name ?? 'mesh-collector-ff55d9589-795c7b5cd6';
  const namespace = opts.namespace ?? NS;
  const nested =
    opts.nested ??
    `workload_start{workload.id="w-1" workload.name="${name}" workload.namespace="${namespace}"}:`;
  return `${opts.at ?? '2026-10-01T10:00:00.000001Z'}  ${opts.level ?? 'WARN'} workload_start{workload_id=w-1 workload.name="${name}" workload.namespace="${namespace}"}:${nested} ${message}`;
}

describe('parseHostFailureLine', () => {
  it('attributes real host WARN/ERROR lines by their workload_start span fields', () => {
    expect(
      parseHostFailureLine(
        sampleLine(
          '5d8e1b04-4e6d-48b9-a7af-222f9b257528" workload.name="mesh-collector-ff55d9589-795c7b5cd6" workload.namespace="di-tenant-meshtastic"}: service did not',
        ),
      ),
    ).toEqual({
      timestamp: '2026-10-01T19:19:39.903159Z',
      level: 'WARN',
      workloadName: 'mesh-collector-ff55d9589-795c7b5cd6',
      namespace: MESH_NS,
      message:
        'service did not properly execute workload_id="5d8e1b04-4e6d-48b9-a7af-222f9b257528"',
    });
    expect(parseHostFailureLine(sampleLine('ERROR workload_start{workload_id=12fa'))).toMatchObject(
      {
        level: 'ERROR',
        workloadName: 'mesh-site-dd5fc4dc-558f5d4b4',
        message:
          'failed to start workload workload_id="12fa33da-760e-4018-9e62-c9722f56bc1b" reason="no host header found"',
      },
    );
    // Three spans deep (resolve_workload), still the same workload.
    expect(parseHostFailureLine(sampleLine('notify HTTP handler'))?.message).toStartWith(
      'failed to notify HTTP handler of resolved workload',
    );
  });

  it('ignores INFO, other spans, and lines without a span chain', () => {
    expect(parseHostFailureLine(sampleLine('Starting workload'))).toBeUndefined();
    expect(parseHostFailureLine(sampleLine('connected to NATS'))).toBeUndefined();
    expect(
      parseHostFailureLine('2026-10-01T10:00:00Z  WARN workload_stop{workload_id=x}: oops'),
    ).toBeUndefined();
    expect(parseHostFailureLine('2026-10-01T10:00:00Z ERROR no span here')).toBeUndefined();
    expect(parseHostFailureLine('')).toBeUndefined();
  });

  it('requires both fields on the outer span and agreement in nested spans', () => {
    expect(
      parseHostFailureLine(
        `2026-10-01T10:00:00Z  WARN workload_start{workload_id=w workload.name="greeter"}: x`,
      ),
    ).toBeUndefined();
    expect(
      parseHostFailureLine(
        failureLine('x', {
          nested: 'workload_start{workload.name="greeter" workload.namespace="di-tenant-alpha"}:',
        }),
      ),
    ).toBeUndefined();
    expect(
      parseHostFailureLine(
        failureLine('x', { nested: 'resolve_workload{workload.namespace="di-tenant-beta"}:' }),
      ),
    ).toBeUndefined();
    // A nested span without workload fields is fine.
    expect(parseHostFailureLine(failureLine('x', { nested: 'plugin{}:' }))?.message).toBe('x');
    // Malformed span fields are rejected rather than guessed.
    expect(
      parseHostFailureLine(
        `2026-10-01T10:00:00Z  WARN workload_start{workload.name="a" workload.namespace="${NS}" "junk"}: x`,
      ),
    ).toBeUndefined();
  });

  it('cannot be re-attributed by message text that imitates a span or guest fields', () => {
    const forged = failureLine(
      'failed to start workload reason="workload_start{workload.name=\\"greeter\\"}: x"',
      { level: 'ERROR' },
    );
    expect(parseHostFailureLine(forged)?.workloadName).toBe('mesh-collector-ff55d9589-795c7b5cd6');
    // A guest TracingLogger line is never a host failure, even inside a workload_start span.
    const guest = `2026-10-01T10:00:00Z  WARN workload_start{workload_id=w workload.name="greeter" workload.namespace="${NS}"}: hi workload.component_id="c" workload.name="greeter" workload.namespace="${NS}" context="x"`;
    expect(parseHostFailureLine(guest)).toBeUndefined();
    expect(parseGuestLogLine(guest)?.message).toBe('hi');
  });

  it('strips terminal colour codes and unescapes quoted span values', () => {
    const line = `\u001b[2m2026-10-01T10:00:00Z\u001b[0m \u001b[31mERROR\u001b[0m workload_start{workload_id=w workload.name="a\\"b" workload.namespace="${NS}"}: boom\r`;
    expect(parseHostFailureLine(line)).toMatchObject({ workloadName: 'a"b', message: 'boom' });
  });
});

describe('redaction and formatting', () => {
  it('removes bearer tokens, assigned secrets, URL credentials, and long tokens', () => {
    expect(redactLogText('Authorization: Bearer abc.def')).toBe('[redacted]');
    expect(redactLogText('password=hunter2 ok')).toBe('[redacted] ok');
    expect(redactLogText('api_key: xyz')).toBe('[redacted]');
    expect(redactLogText('connect nats://user:pw@di-bs-bus:4222')).toBe(
      'connect nats://[redacted]@di-bs-bus:4222',
    );
    expect(redactLogText(`id ${'a'.repeat(48)}`)).toBe('id [redacted]');
  });

  it('bounds each line to 500 characters', () => {
    const line = redactLogText('word '.repeat(200));
    expect(line).toHaveLength(500);
    expect(line.endsWith('…')).toBe(true);
  });

  it('formats a projected line as timestamp, level, message', () => {
    const parsed = parseGuestLogLine(hostLine('token=abc started'));
    expect(parsed && formatProjectedLine(parsed)).toBe(
      '2026-10-01T10:00:00.000001Z INFO [redacted] started',
    );
  });

  it('formats a host failure line with a host: prefix, redacted', () => {
    const parsed = parseHostFailureLine(failureLine('failed reason="password=hunter2"'));
    expect(parsed && formatHostLine(parsed)).toBe(
      '2026-10-01T10:00:00.000001Z WARN host: failed reason="[redacted]',
    );
  });
});

describe('workload attribution', () => {
  it('groups multi-member workloads under the console application name', () => {
    expect(applicationKey(deployments[0] as never)).toBe('mesh');
    expect(applicationKey(deployments[2] as never)).toBe('greeter');
    expect(applicationKey({ name: 'bare' })).toBe('bare');
  });

  it('matches an exact deployment, else the longest operator-suffixed prefix', () => {
    const list = [{ name: 'mesh' }, { name: 'mesh-site' }];
    expect(resolveWorkload('mesh', list)?.name).toBe('mesh');
    expect(resolveWorkload('mesh-site-7c9f', list)?.name).toBe('mesh-site');
    expect(resolveWorkload('mesh-7c9f', list)?.name).toBe('mesh');
    expect(resolveWorkload('other', list)).toBeUndefined();
  });

  it('attributes only this namespace and known workloads', () => {
    const text = [
      hostLine('collector up'),
      hostLine('site up', { name: 'mesh-site' }),
      'raw stderr from some guest',
      hostLine('hello', { name: 'greeter' }),
      hostLine('other tenant', { namespace: 'di-tenant-beta' }),
      hostLine('unknown', { name: 'stranger' }),
    ].join('\n');
    const result = attributeLogs(text, NS, deployments);
    expect([...result.keys()].sort()).toEqual(['greeter', 'mesh']);
    expect(result.get('mesh')).toEqual([
      '2026-10-01T10:00:00.000001Z INFO collector up',
      '2026-10-01T10:00:00.000001Z INFO site up',
    ]);
  });

  it('attributes every real host failure in the sample to mesh, newest per deployment', () => {
    const entries = attributeEntries(SAMPLE, MESH_NS, meshDeployments).get('mesh') ?? [];
    expect(entries.every((entry) => entry.failure)).toBe(true);
    expect(entries.map((entry) => entry.line)).toContain(
      '2026-10-01T19:19:39.903159Z WARN host: service did not properly execute workload_id="5d8e1b04-4e6d-48b9-a7af-222f9b257528"',
    );
    const failures = mergeFailures({}, entries, ['mesh-collector', 'mesh-site']);
    expect(failures).toEqual({
      'mesh-collector': {
        workload: 'mesh-collector-ff55d9589-795c7b5cd6',
        time: '2026-10-01T19:19:39.903159Z',
        level: 'WARN',
        message:
          'service did not properly execute workload_id="5d8e1b04-4e6d-48b9-a7af-222f9b257528"',
      },
      'mesh-site': {
        workload: 'mesh-site-86db6d86d4-5b677f4cd5',
        time: '2026-10-01T18:56:38.649965Z',
        level: 'ERROR',
        message:
          'failed to start workload workload_id="86e465e9-9d32-4663-9998-5ac3c9005420" reason="no host header found"',
      },
    });
    // The running collector (currentReplicaSet mesh-collector-ff55d9589) is FAILED; the
    // running site (mesh-site-64f85bb94f) is not, its failures belong to old replica sets.
    expect(failures['mesh-collector']?.workload.startsWith('mesh-collector-ff55d9589-')).toBe(true);
    expect(failures['mesh-site']?.workload.startsWith('mesh-site-64f85bb94f-')).toBe(false);
    // Another tenant's namespace attributes nothing.
    expect(attributeEntries(SAMPLE, NS, meshDeployments).size).toBe(0);
  });

  it('drops guest lines of an opted-out deployment but keeps its host failures', () => {
    const optedOut = [
      { ...deployments[0], annotations: { 'di-framework.dev/logs': 'false' } } as WorkloadIdentity,
      ...deployments.slice(1),
    ];
    expect(logsOptedOut(optedOut[0] as WorkloadIdentity)).toBe(true);
    expect(logsOptedOut({ name: 'x', annotations: { 'di-framework.dev/logs': 'true' } })).toBe(
      false,
    );
    const text = [
      hostLine('collector secret output'),
      hostLine('site up', { name: 'mesh-site' }),
      failureLine('service did not properly execute', { name: 'mesh-collector-abc-1' }),
    ].join('\n');
    expect(attributeLogs(text, NS, optedOut).get('mesh')).toEqual([
      '2026-10-01T10:00:00.000001Z INFO site up',
      '2026-10-01T10:00:00.000001Z WARN host: service did not properly execute',
    ]);
  });
});

describe('data.failures', () => {
  const failure = (time: string, workload = 'mesh-collector-a-1'): HostFailure => ({
    workload,
    time,
    level: 'ERROR',
    message: 'boom',
  });

  it('keeps the newest failure per live deployment', () => {
    const entry = (deployment: string, time: string, withFailure = true) => ({
      time,
      line: `${time} ERROR host: boom`,
      deployment,
      failure: withFailure ? failure(time) : undefined,
    });
    expect(
      mergeFailures(
        {
          'mesh-collector': failure('2026-10-01T10:00:02Z'),
          gone: failure('2026-10-01T10:00:09Z'),
        },
        [
          entry('mesh-collector', '2026-10-01T10:00:01Z'),
          entry('mesh-site', '2026-10-01T10:00:03Z'),
          entry('mesh-site', '2026-10-01T10:00:04Z'),
          entry('mesh-site', '2026-10-01T10:00:05Z', false),
          entry('stranger', '2026-10-01T10:00:06Z'),
        ],
        ['mesh-collector', 'mesh-site'],
      ),
    ).toEqual({
      'mesh-collector': failure('2026-10-01T10:00:02Z'),
      'mesh-site': failure('2026-10-01T10:00:04Z'),
    });
  });

  it('reads well-formed entries only', () => {
    const cm = (failures: unknown) =>
      ({
        ...logsConfigMap('alpha', NS, 'test', 'mesh', []),
        data: { lines: '', failures },
      }) as Resource;
    expect(projectedFailures(undefined)).toEqual({});
    expect(projectedFailures(cm(undefined))).toEqual({});
    expect(projectedFailures(cm('{not json'))).toEqual({});
    expect(projectedFailures(cm('[]'))).toEqual({});
    expect(projectedFailures(cm('null'))).toEqual({});
    expect(
      projectedFailures(
        cm(
          JSON.stringify({
            ok: { ...failure('t'), extra: 'dropped' },
            badLevel: { ...failure('t'), level: 'INFO' },
            noTime: { workload: 'w', level: 'WARN', message: 'm' },
            empty: null,
          }),
        ),
      ),
    ).toEqual({ ok: failure('t') });
  });

  it('writes data.failures only when there are failures', () => {
    expect(logsConfigMap('alpha', NS, 'test', 'mesh', ['a']).data).toEqual({ lines: 'a' });
    expect(
      logsConfigMap('alpha', NS, 'test', 'mesh', ['a'], { 'mesh-site': failure('t') }).data,
    ).toEqual({ lines: 'a', failures: JSON.stringify({ 'mesh-site': failure('t') }) });
  });
});

describe('ring buffer and ConfigMap shape', () => {
  it('keeps the newest lines up to the bound', () => {
    expect(appendRing(['a', 'b'], ['c'], 2)).toEqual(['b', 'c']);
    expect(appendRing([], ['a'])).toEqual(['a']);
    const full = appendRing(
      Array.from({ length: MAX_LINES }, (_, i) => `old ${i}`),
      ['new'],
    );
    expect(full).toHaveLength(MAX_LINES);
    expect(full.at(-1)).toBe('new');
    expect(full.join('\n').length).toBeLessThan(1024 * 1024);
  });

  it('reads existing lines from data.lines only', () => {
    expect(projectedLines(undefined)).toEqual([]);
    expect(
      projectedLines({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'x' } }),
    ).toEqual([]);
    expect(
      projectedLines({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'x' },
        data: { lines: 'a\nb' },
      }),
    ).toEqual(['a', 'b']);
  });

  it('names ConfigMaps di-logs-<app>, hashing names that do not fit', () => {
    expect(logsConfigMapName('mesh')).toBe('di-logs-mesh');
    const long = logsConfigMapName('a'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long.startsWith('di-logs-a')).toBe(true);
    expect(logsConfigMapName('My_App')).toMatch(/^di-logs-my-app-[0-9a-f]+$/);
    expect(logsConfigMapName('___')).toMatch(/^di-logs-app-[0-9a-f]+$/);
    expect(validLabelValue('mesh')).toBe(true);
    expect(validLabelValue('bad value')).toBe(false);
    expect(validLabelValue('a'.repeat(64))).toBe(false);
  });

  it('labels the projection the way the console selects it', () => {
    expect(logsConfigMap('alpha', NS, 'test', 'mesh', ['a', 'b'])).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'di-logs-mesh',
        namespace: NS,
        labels: {
          [INSTALLATION]: 'test',
          'platform.di-framework.dev/tenant': 'alpha',
          'di-framework.dev/projection': 'logs',
          'di-framework.dev/application': 'mesh',
        },
      },
      data: { lines: 'a\nb' },
    });
  });
});

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  insecureRegistry: true,
};

function tenant(): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec: {},
  };
}

/** Minimal API for the log path: pods, pod logs, WorkloadDeployments, ConfigMaps. */
class LogApi implements Api {
  configMaps = new Map<string, Resource>();
  logs = new Map<string, string>();
  logQueries: string[] = [];
  pods = [
    { metadata: { name: 'host-0', uid: 'pod-0' }, status: { phase: 'Running' } },
    { metadata: { name: 'host-1', uid: 'pod-1' }, status: { phase: 'Pending' } },
  ];
  workloads = deployments.map((d) => ({ metadata: d }));
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, 'https://kubernetes');
    const n = names('alpha');
    if (url.pathname === collection('v1', 'Pod', n.runtimeNamespace)) {
      expect(url.searchParams.get('labelSelector')).toBe(
        'wasmcloud.com/hostgroup=tenant-alpha,wasmcloud.com/name=hostgroup',
      );
      return { items: this.pods } as T;
    }
    if (url.pathname.endsWith('/log')) {
      this.logQueries.push(url.search);
      return (this.logs.get(url.pathname.split('/').at(-2) ?? '') ?? '') as T;
    }
    if (
      url.pathname ===
      collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', n.namespace)
    ) {
      expect(url.searchParams.get('labelSelector')).toBe(
        'app.kubernetes.io/managed-by=di-framework',
      );
      return { items: this.workloads } as T;
    }
    const configMaps = collection('v1', 'ConfigMap', n.namespace);
    if (url.pathname === configMaps && method === 'GET') {
      return {
        items: [...this.configMaps.values()].map(({ apiVersion: _a, kind: _k, ...rest }) => rest),
      } as T;
    }
    const name = decodeURIComponent(url.pathname.slice(configMaps.length + 1));
    if (method === 'GET') {
      const value = this.configMaps.get(name);
      if (!value) throw new ApiError(404, 'Not found');
      return structuredClone(value) as T;
    }
    if (method === 'PATCH') {
      this.configMaps.set(name, structuredClone(body) as Resource);
      return structuredClone(body) as T;
    }
    if (method === 'DELETE') {
      this.configMaps.delete(name);
      return {} as T;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  }
}

describe('Controller.projectLogs', () => {
  it('publishes one ConfigMap per application from attributed lines only', async () => {
    const api = new LogApi();
    api.logs.set(
      'host-0',
      [
        hostLine('collector up', { at: '2026-10-01T10:00:01.000000Z' }),
        'raw stdout',
        hostLine('site up', { name: 'mesh-site', at: '2026-10-01T10:00:02.000000Z' }),
      ].join('\n'),
    );
    const controller = new Controller(api, cfg);
    await controller.projectLogs(tenant());
    expect([...api.configMaps.keys()]).toEqual(['di-logs-mesh']);
    expect(linesOf(api, 'di-logs-mesh')).toBe(
      '2026-10-01T10:00:01.000000Z INFO collector up\n2026-10-01T10:00:02.000000Z INFO site up',
    );
    // The pending host pod is never read; the first read tails a bounded window.
    expect(api.logQueries).toEqual(['?tailLines=1000']);

    // The next tick resumes from the cursor and appends only newer lines.
    api.logs.set(
      'host-0',
      [
        hostLine('site up', { name: 'mesh-site', at: '2026-10-01T10:00:02.000000Z' }),
        hostLine('collector tick', { at: '2026-10-01T10:00:03.000000Z' }),
      ].join('\n'),
    );
    await controller.projectLogs(tenant());
    expect(api.logQueries.at(-1)).toBe(`?sinceTime=${encodeURIComponent('2026-10-01T10:00:02Z')}`);
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toEqual([
      '2026-10-01T10:00:01.000000Z INFO collector up',
      '2026-10-01T10:00:02.000000Z INFO site up',
      '2026-10-01T10:00:03.000000Z INFO collector tick',
    ]);
  });

  it('resumes after the published lines when the controller restarts', async () => {
    const api = new LogApi();
    api.configMaps.set(
      'di-logs-mesh',
      logsConfigMap('alpha', NS, 'test', 'mesh', [
        '2026-10-01T10:00:02.000000Z INFO already published',
      ]),
    );
    api.logs.set(
      'host-0',
      [
        hostLine('already published', { at: '2026-10-01T10:00:02.000000Z' }),
        hostLine('new', { at: '2026-10-01T10:00:05.000000Z' }),
      ].join('\n'),
    );
    await new Controller(api, cfg).projectLogs(tenant());
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toEqual([
      '2026-10-01T10:00:02.000000Z INFO already published',
      '2026-10-01T10:00:05.000000Z INFO new',
    ]);
  });

  it('publishes host failures, honours the logs opt-out, and survives a restart', async () => {
    const api = new LogApi();
    api.workloads = [
      {
        metadata: {
          ...(deployments[0] as WorkloadIdentity),
          annotations: { 'di-framework.dev/logs': 'false' },
        },
      },
      ...deployments.slice(1).map((d) => ({ metadata: d })),
    ];
    const log = [
      hostLine('collector guest output', { at: '2026-10-01T10:00:01.000000Z' }),
      failureLine('service did not properly execute', {
        name: 'mesh-collector-aaa-1',
        at: '2026-10-01T10:00:02.000000Z',
      }),
      failureLine('failed to start workload reason="no host header found"', {
        name: 'mesh-site-bbb-1',
        level: 'ERROR',
        at: '2026-10-01T10:00:03.000000Z',
      }),
    ];
    api.logs.set('host-0', log.join('\n'));
    await new Controller(api, cfg).projectLogs(tenant());
    const expectedLines = [
      '2026-10-01T10:00:02.000000Z WARN host: service did not properly execute',
      '2026-10-01T10:00:03.000000Z ERROR host: failed to start workload reason="no host header found"',
    ];
    const expectedFailures = {
      'mesh-collector': {
        workload: 'mesh-collector-aaa-1',
        time: '2026-10-01T10:00:02.000000Z',
        level: 'WARN',
        message: 'service did not properly execute',
      },
      'mesh-site': {
        workload: 'mesh-site-bbb-1',
        time: '2026-10-01T10:00:03.000000Z',
        level: 'ERROR',
        message: 'failed to start workload reason="no host header found"',
      },
    };
    const failuresOf = () => JSON.parse(projectedFailuresText(api.configMaps.get('di-logs-mesh')));
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toEqual(expectedLines);
    expect(failuresOf()).toEqual(expectedFailures);

    // A restarted controller re-reads the same tail: no duplicate lines, no lost failures,
    // and no write at all.
    let patches = 0;
    const call = api.call.bind(api);
    api.call = async <T>(method: string, path: string, body?: unknown) => {
      if (method === 'PATCH') patches++;
      return call<T>(method, path, body);
    };
    await new Controller(api, cfg).projectLogs(tenant());
    expect(patches).toBe(0);
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toEqual(expectedLines);
    expect(failuresOf()).toEqual(expectedFailures);

    // A ConfigMap written before failures existed: failures older than the line floor
    // are still recorded, without re-adding the lines.
    api.configMaps.set(
      'di-logs-mesh',
      logsConfigMap('alpha', NS, 'test', 'mesh', ['2026-10-01T10:00:09.000000Z INFO later']),
    );
    await new Controller(api, cfg).projectLogs(tenant());
    expect(linesOf(api, 'di-logs-mesh')).toBe('2026-10-01T10:00:09.000000Z INFO later');
    expect(failuresOf()).toEqual(expectedFailures);
  });

  it('writes nothing without attributed lines and removes projections of removed apps', async () => {
    const api = new LogApi();
    api.pods = [
      { metadata: { name: 'host-0', uid: undefined as never }, status: { phase: 'Running' } },
    ];
    api.configMaps.set('di-logs-gone', {
      ...logsConfigMap('alpha', NS, 'test', 'gone', ['x']),
      metadata: {
        ...logsConfigMap('alpha', NS, 'test', 'gone', ['x']).metadata,
        uid: 'gone-uid',
      },
    });
    api.logs.set('host-0', 'raw stderr only\n');
    await new Controller(api, cfg).projectLogs(tenant());
    expect([...api.configMaps.keys()]).toEqual([]);
  });

  it('skips applications whose name cannot be a label value', async () => {
    const api = new LogApi();
    api.workloads = [
      { metadata: { name: 'odd', labels: { 'di-framework.dev/workload': 'bad name' } } },
    ];
    api.logs.set('host-0', hostLine('hello', { name: 'odd' }));
    await new Controller(api, cfg).projectLogs(tenant());
    expect(api.configMaps.size).toBe(0);
  });

  it('is called from tick for active tenants and never blocks reconciliation', async () => {
    const controller = new Controller(new LogApi(), cfg);
    const project = spyOn(controller, 'projectLogs').mockRejectedValue(new Error('boom'));
    const reconcile = spyOn(controller, 'reconcileTenant').mockResolvedValue();
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const suspended = {
      ...tenant(),
      metadata: { ...tenant().metadata, name: 'beta' },
      spec: { suspended: true },
    };
    const listing = spyOn(
      controller as unknown as { list: (...args: unknown[]) => Promise<unknown[]> },
      'list',
    ).mockImplementation(async (_v: unknown, kind: unknown) =>
      kind === 'Tenant' ? [tenant(), suspended] : [],
    );
    try {
      await controller.tick();
      expect(project).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(errors).toHaveBeenCalledWith('Tenant/alpha logs: boom');
      project.mockRejectedValue('not an error');
      await controller.tick();
      expect(errors).toHaveBeenCalledWith('Tenant/alpha logs: Log projection failed');
    } finally {
      listing.mockRestore();
      errors.mockRestore();
    }
  });
});

describe('log projection security', () => {
  it('grants the controller pods/log in the tenant runtime namespace only', () => {
    const resources = tenantResources(tenant(), cfg);
    const role = resources.find(
      (r) => r.kind === 'Role' && r.metadata.name === 'di-platform-log-reader',
    );
    expect(role?.metadata.namespace).toBe('di-runtime-alpha');
    expect(role?.rules).toEqual([{ apiGroups: [''], resources: ['pods/log'], verbs: ['get'] }]);
    const binding = resources.find(
      (r) => r.kind === 'RoleBinding' && r.metadata.name === 'di-platform-log-reader',
    );
    expect(binding?.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'di-platform-controller', namespace: 'wasmcloud' },
    ]);
    const runtime = resources.find(
      (r) => r.kind === 'ServiceAccount' && r.metadata.name === 'di-runtime',
    );
    expect(runtime?.automountServiceAccountToken).toBe(false);
  });

  it('admits only an unnamed, unconfigured wasi:logging import', () => {
    const logging = { namespace: 'wasi', package: 'logging', interfaces: ['logging'] };
    expect(hostInterfaceAllowed(logging)).toBe(true);
    expect(hostInterfaceAllowed({ ...logging, name: 'x' })).toBe(false);
    expect(hostInterfaceAllowed({ ...logging, config: { level: 'debug' } })).toBe(false);
    expect(hostInterfaceAllowed({ ...logging, configFrom: [{ name: 'di-binding-x' }] })).toBe(
      false,
    );
    expect(hostInterfaceAllowed({ ...logging, interfaces: ['other'] })).toBe(false);
    const policy = JSON.stringify(admissionResources('test', 'wasmcloud'));
    expect(policy).toContain("h['package'] == 'logging'");
  });

  it('reserves projection ConfigMaps for the controller', () => {
    expect(PROJECTION_LABEL).toBe('di-framework.dev/projection');
    const policy = JSON.stringify(admissionResources('test', 'wasmcloud'));
    expect(policy).toContain(`'${PROJECTION_LABEL}' in object.metadata.labels`);
    expect(policy).toContain(`'${PROJECTION_LABEL}' in oldObject.metadata.labels`);
    expect(policy).toContain('published by the platform controller');
  });
});
