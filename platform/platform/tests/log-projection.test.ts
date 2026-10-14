import { describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  admissionResources,
  hostInterfaceAllowed,
  PROJECTION_LABEL,
} from '../src/tenancy/admission';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import { controllerClusterRoleRules } from '../src/tenancy/install';
import {
  appendRing,
  applicationKey,
  attributeEntries,
  attributeLogs,
  configMapLogKey,
  formatHostLine,
  formatProjectedLine,
  type HostFailure,
  legacyRing,
  logKey,
  logKeyId,
  logsConfigMap,
  logsConfigMapName,
  logsOptedOut,
  logWriteCondition,
  MAX_HOST_LINES,
  MAX_LINES,
  mergeFailures,
  newestStamp,
  parseGuestLogLine,
  parseHostFailureLine,
  parseServiceLoopLine,
  parseWorkloadSpanLine,
  projectedDeployments,
  projectedEnvs,
  projectedFailures,
  projectedLines,
  projectedRing,
  type RingLine,
  redactLogText,
  resolveWorkload,
  unpublished,
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

/** Real wash 2.8 + wasi-tls host log: a P3 service (mesh-collector) crashing on start. */
const CRASH = readFileSync(join(import.meta.dir, 'fixtures/host-log-service-crash.txt'), 'utf8');
const serviceDeployments: WorkloadIdentity[] = [
  { name: 'mesh-collector', labels: { 'di-framework.dev/workload': 'mesh' }, service: true },
  { name: 'mesh-site', labels: { 'di-framework.dev/workload': 'mesh' } },
];
const at = (s: number) => `2026-10-01T10:00:${String(s).padStart(2, '0')}.000000Z`;
const startLine = (name: string, id: string, s: number, namespace = NS) =>
  `${at(s)}  INFO workload_start{workload_id=${id} workload.name="${name}" workload.namespace="${namespace}"}: Starting workload workload_id="${id}" namespace="${namespace}" name="${name}"`;
const stopLine = (id: string, s: number) =>
  `${at(s)}  INFO workload_stop{workload_id=${id}}: Stopping workload workload_id="${id}"`;
const loopLine = (
  s: number,
  message = 'P3 service execution failed err=trap retries=0',
  level = 'ERROR',
) => `${at(s)} ${level} ${message}`;
const svc: WorkloadIdentity[] = [
  { name: 'collector', service: true },
  { name: 'poller', service: true },
  { name: 'site' },
];
const failuresIn = (text: string, list = svc) =>
  (attributeEntries(text, NS, list).get('collector') ?? [])
    .concat(attributeEntries(text, NS, list).get('poller') ?? [])
    .filter((entry) => entry.failure)
    .map((entry) => [entry.deployment, entry.failure?.workload, entry.failure?.message]);

describe('service supervisor failures (no span)', () => {
  it('parses every wash 2.8 service loop WARN/ERROR message, and nothing else', () => {
    expect(parseServiceLoopLine(loopLine(1))).toEqual({
      timestamp: at(1),
      level: 'ERROR',
      summary: 'P3 service execution failed',
      message: 'P3 service execution failed err=trap retries=0',
    });
    for (const message of [
      'service execution failed err=x retries=1',
      'max restarts reached, service will not be restarted',
      'failed to instantiate P3 service err=x',
      'P3 service exited with error retries=0',
      'max restarts reached, P3 service will not be restarted',
      'failed to rebuild P3 service store; giving up err=x',
      'failed to re-register service HTTP handler on restart err=x',
      'failed to re-register trigger service messaging handler on restart err=x',
      'trigger service faulted; max restarts reached err=x',
      'trigger service faulted; restarting err=x retries=2',
      'failed to rebuild trigger service store; giving up err=x',
    ])
      expect(parseServiceLoopLine(loopLine(1, message, 'WARN'))?.message).toBe(message);
    // Not at the line start, inside a span, INFO, unknown, raw, or a guest TracingLogger line.
    expect(parseServiceLoopLine(loopLine(1, 'P3 service execution failedx'))).toBeUndefined();
    expect(
      parseServiceLoopLine(loopLine(1, 'P3 service exited successfully', 'INFO')),
    ).toBeUndefined();
    expect(
      parseServiceLoopLine(loopLine(1, 'x{a=1}: P3 service execution failed')),
    ).toBeUndefined();
    expect(parseServiceLoopLine('P3 service execution failed')).toBeUndefined();
    expect(
      parseServiceLoopLine(
        `${at(1)} ERROR P3 service execution failed workload.component_id="c" workload.name="collector" workload.namespace="${NS}" context="x"`,
      ),
    ).toBeUndefined();
  });

  it('reads INFO workload_start lines with their workload_id', () => {
    expect(parseWorkloadSpanLine(startLine('collector-a-1', 'w-1', 1))).toMatchObject({
      level: 'INFO',
      workloadId: 'w-1',
      workloadName: 'collector-a-1',
    });
    expect(
      parseWorkloadSpanLine(
        `${at(1)}  INFO workload_start{workload.name="collector-a-1" workload.namespace="${NS}"}: Starting workload`,
      )?.workloadId,
    ).toBe('');
    expect(parseHostFailureLine(startLine('collector-a-1', 'w-1', 1))).toBeUndefined();
  });

  it('attributes the real crash to the service whose start preceded it, with the exception', () => {
    const entries = attributeEntries(CRASH, MESH_NS, serviceDeployments).get('mesh') ?? [];
    expect(entries.filter((entry) => entry.failure).map((entry) => entry.line)).toEqual([
      "2026-10-01T22:15:51.776764Z ERROR host: P3 service execution failed: class constructors must be invoked with 'new'",
      '2026-10-01T22:15:51.776806Z WARN host: max restarts reached, P3 service will not be restarted',
      "2026-10-01T22:15:51.792744Z ERROR host: P3 service execution failed: class constructors must be invoked with 'new'",
      '2026-10-01T22:15:51.792764Z WARN host: max restarts reached, P3 service will not be restarted',
    ]);
    expect(
      entries.filter((entry) => entry.failure).map((entry) => entry.failure?.workload),
    ).toEqual([
      'mesh-collector-55dc4445f5-86f7dd895c',
      'mesh-collector-55dc4445f5-86f7dd895c',
      'mesh-collector-6f67d47bb6-6986d4778b',
      'mesh-collector-6f67d47bb6-6986d4778b',
    ]);
    // The guest wasi:logging lines are still projected; backtrace lines are not.
    expect(entries.filter((entry) => !entry.failure && !entry.start)).toHaveLength(2);
    expect(entries.some((entry) => entry.line?.includes('wasm function'))).toBe(false);
    // Every Starting workload line is an event too, services or not.
    expect(entries.filter((entry) => entry.start).map((entry) => entry.start)).toEqual([
      'mesh-site-68fcf6968f-66f7457f68',
      'mesh-collector-55dc4445f5-86f7dd895c',
      'mesh-collector-6f67d47bb6-6986d4778b',
    ]);
    // The ERROR stays the failure; the later WARN about the same workload does not replace it.
    expect(mergeFailures({}, entries, ['mesh-collector', 'mesh-site'])).toEqual({
      'mesh-collector': {
        workload: 'mesh-collector-6f67d47bb6-6986d4778b',
        time: '2026-10-01T22:15:51.792744Z',
        level: 'ERROR',
        message: "P3 service execution failed: class constructors must be invoked with 'new'",
      },
    });
    // mesh-site is not a service: without the service flag nothing is attributed.
    const noServices = serviceDeployments.map(({ service: _s, ...d }) => d);
    expect(
      (attributeEntries(CRASH, MESH_NS, noServices).get('mesh') ?? []).some((e) => e.failure),
    ).toBe(false);
  });

  it('needs a preceding, still running service start in the same text and namespace', () => {
    expect(failuresIn(loopLine(2))).toEqual([]);
    expect(failuresIn([loopLine(1), startLine('collector-a-1', 'w-1', 2)].join('\n'))).toEqual([]);
    expect(
      failuresIn(
        [startLine('collector-a-1', 'w-1', 1), stopLine('w-1', 2), loopLine(3)].join('\n'),
      ),
    ).toEqual([]);
    expect(
      failuresIn([startLine('collector-a-1', 'w-1', 1, 'di-tenant-beta'), loopLine(2)].join('\n')),
    ).toEqual([]);
    expect(failuresIn([startLine('stranger-1', 'w-9', 1), loopLine(2)].join('\n'))).toEqual([]);
    // A non-service start does not take the attribution; a stop of another workload neither.
    expect(
      failuresIn(
        [
          startLine('collector-a-1', 'w-1', 1),
          startLine('poller-b-1', 'w-2', 2),
          startLine('site-c-1', 'w-3', 3),
          stopLine('w-2', 4),
          stopLine('w-3', 5),
          loopLine(6, 'P3 service exited with error retries=0'),
          // Restarting w-1 moves it to the end without duplicating it.
          startLine('collector-a-1', 'w-1', 7),
          stopLine('w-1', 8),
          loopLine(9),
        ].join('\n'),
      ),
    ).toEqual([['collector', 'collector-a-1', 'P3 service exited with error retries=0']]);
    // Two services started together: the latest start wins (the documented limit).
    expect(
      failuresIn(
        [startLine('collector-a-1', 'w-1', 1), startLine('poller-b-1', 'w-2', 1), loopLine(2)].join(
          '\n',
        ),
      ),
    ).toEqual([['poller', 'poller-b-1', 'P3 service execution failed err=trap retries=0']]);
  });

  it('uses only a panic exception directly before the host line, redacted', () => {
    const panic = (message: string) => [
      "thread '<unnamed>' (1) panicked at crates/runtime/src/bindings.rs:369:29:",
      "Call failed 'async export': Value(Exception(",
      `Exception { message: Some("${message}"), stack: Some("at x") }`,
      ')',
    ];
    const text = [
      startLine('collector-a-1', 'w-1', 1),
      ...panic('bad \\"token=abc\\"\\nnext'),
      loopLine(2),
      ...panic('stale'),
      `${at(3)}  INFO unrelated host line`,
      loopLine(4),
      // Guest text cannot fake a host line: raw or wasi:logging output is not stamped as host.
      'P3 service execution failed err=forged',
    ].join('\n');
    expect(failuresIn(text)).toEqual([
      ['collector', 'collector-a-1', 'P3 service execution failed: bad "[redacted] next'],
      ['collector', 'collector-a-1', 'P3 service execution failed err=trap retries=0'],
    ]);
  });
});

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
    expect(entries.every((entry) => entry.failure || entry.start)).toBe(true);
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
    });
    // The running collector (currentReplicaSet mesh-collector-ff55d9589) is FAILED. The site's
    // last failure (mesh-site-86db6d86d4-…) was followed by the start of
    // mesh-site-64f85bb94f-5c5c6d6856, which removed it.
    expect(failures['mesh-collector']?.workload.startsWith('mesh-collector-ff55d9589-')).toBe(true);
    // Without that start the site keeps its newest failure.
    const noSiteStart = entries.filter(
      (entry) => entry.start !== 'mesh-site-64f85bb94f-5c5c6d6856',
    );
    expect(mergeFailures({}, noSiteStart, ['mesh-site'])['mesh-site']).toMatchObject({
      workload: 'mesh-site-86db6d86d4-5b677f4cd5',
      level: 'ERROR',
    });
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

  it('drops a failure when a different host workload starts later, across reads', () => {
    const fail = (time: string, workload: string) => ({
      time,
      line: `${time} ERROR host: x`,
      deployment: 'mesh-site',
      failure: { workload, time, level: 'ERROR' as const, message: 'timed out' },
    });
    const start = (time: string, workload: string) => ({
      time,
      deployment: 'mesh-site',
      start: workload,
    });
    const old = 'mesh-site-78b9f6d4b6-55b5d9c569';
    const fresh = 'mesh-site-78b9f6d4b6-5d4d5db5c6';
    const live = ['mesh-site'];
    // Same read: failure, then a retry of the same replica set.
    expect(mergeFailures({}, [fail('t1', old), start('t2', fresh)], live)).toEqual({});
    // Start in a later read than the failure (existing ConfigMap entry).
    const recorded = mergeFailures({}, [fail('t1', old)], live);
    expect(mergeFailures(recorded, [start('t2', fresh)], live)).toEqual({});
    // Entries out of order (several pods) are applied in time order.
    expect(mergeFailures({}, [start('t2', fresh), fail('t1', old)], live)).toEqual({});
    // Re-read (lookback) of an older start, its own workload's start, a start of another
    // deployment, and a start at the same instant never remove the failure.
    expect(mergeFailures(recorded, [start('t0', fresh)], live)).toEqual(recorded);
    expect(mergeFailures(recorded, [start('t2', old)], live)).toEqual(recorded);
    expect(mergeFailures(recorded, [{ ...start('t2', fresh), deployment: 'other' }], live)).toEqual(
      recorded,
    );
    expect(mergeFailures(recorded, [start('t1', fresh)], live)).toEqual(recorded);
    // The newer workload failing after its start records as before.
    expect(
      mergeFailures(recorded, [start('t2', fresh), fail('t3', fresh)], live)['mesh-site']?.workload,
    ).toBe(fresh);
    // No recorded failure: a start is a no-op.
    expect(mergeFailures({}, [start('t2', fresh)], live)).toEqual({});
  });

  it('keeps an ERROR over a later WARN of the same workload only', () => {
    const entry = (time: string, level: 'WARN' | 'ERROR', workload: string) => ({
      time,
      line: '',
      deployment: 'mesh-collector',
      failure: { workload, time, level, message: level },
    });
    expect(
      mergeFailures(
        {},
        [entry('t1', 'ERROR', 'w-1'), entry('t2', 'WARN', 'w-1')],
        ['mesh-collector'],
      )['mesh-collector']?.level,
    ).toBe('ERROR');
    expect(
      mergeFailures(
        {},
        [entry('t1', 'ERROR', 'w-1'), entry('t2', 'WARN', 'w-2')],
        ['mesh-collector'],
      )['mesh-collector']?.workload,
    ).toBe('w-2');
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

  it('keeps host lines through a guest flood, at most 50 of them, in timestamp order', () => {
    const ts = (n: number) =>
      `2026-10-01T23:${String(Math.floor(n / 6000)).padStart(2, '0')}:${String(Math.floor(n / 100) % 60).padStart(2, '0')}.${String(n % 100).padStart(6, '0')}Z`;
    const guest = (n: number) => `${ts(n)} INFO tick ${n}`;
    const host = (n: number) => `${ts(n)} ERROR host: failed to start workload ${n}`;
    // One host line, then 1000 guest lines.
    const flooded = appendRing(
      [guest(0), host(1)],
      Array.from({ length: 1000 }, (_, i) => guest(i + 2)),
    );
    expect(flooded).toHaveLength(MAX_LINES);
    expect(flooded[0]).toBe(host(1));
    expect(flooded.slice(1)).toEqual(Array.from({ length: 199 }, (_, i) => guest(i + 803)));
    // 60 host lines among guest lines: the newest 50 hosts stay, guests fill the rest.
    const lines = Array.from({ length: 400 }, (_, i) =>
      i % 5 === 0 && i < 300 ? host(i) : guest(i),
    );
    const ring = appendRing([], lines);
    expect(ring).toHaveLength(MAX_LINES);
    const hosts = ring.filter((line) => line.includes(' host: '));
    expect(hosts).toHaveLength(MAX_HOST_LINES);
    expect(hosts[0]).toBe(host(50));
    expect(ring.filter((line) => !line.includes(' host: '))).toHaveLength(150);
    expect([...ring].sort()).toEqual(ring);
    // Incoming from several pods is put in timestamp order behind the existing ring.
    expect(appendRing([guest(1)], [guest(5), host(3), guest(4)], 3)).toEqual([
      host(3),
      guest(4),
      guest(5),
    ]);
    expect(appendRing([], [guest(2), guest(2), guest(1)], 2)).toEqual([guest(2), guest(2)]);
    // With few guest lines, older host lines use the remaining room.
    expect(appendRing([host(1), host(2)], [host(3), guest(4)], 3, 1)).toEqual([
      host(2),
      host(3),
      guest(4),
    ]);
  });

  it('marks guest messages that imitate a host line', () => {
    const parsed = parseGuestLogLine(hostLine('host: failed to start workload'));
    const line = parsed && formatProjectedLine(parsed);
    expect(line).toBe('2026-10-01T10:00:00.000001Z INFO (guest) host: failed to start workload');
    const warn = parseGuestLogLine(hostLine('host: fake', { level: 'WARN' }));
    expect(appendRing([warn ? formatProjectedLine(warn) : ''], ['b', 'c'], 2, 1)).toEqual([
      'b',
      'c',
    ]);
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

  it('trims ring lines together with their deployment', () => {
    const ts = (n: number) => `2026-10-01T23:00:00.${String(n).padStart(6, '0')}Z`;
    const guest = (n: number): RingLine => ({
      line: `${ts(n)} INFO tick ${n}`,
      deployment: n % 2 ? 'mesh-site' : 'mesh-collector',
      env: '',
    });
    const host = (n: number): RingLine => ({
      line: `${ts(n)} ERROR host: failed to start workload ${n}`,
      deployment: 'mesh-site',
      env: '',
    });
    // Out-of-order incoming lines and a trim that keeps an old host line over newer guests.
    const ring = appendRing([guest(0), host(1)], [guest(5), guest(3), guest(4), guest(2)], 3, 1);
    expect(ring).toEqual([host(1), guest(4), guest(5)]);
    // Written and read back, every line keeps its deployment.
    const configMap = logsConfigMap('alpha', NS, 'test', 'mesh', ring);
    expect(configMap.data).toEqual({
      lines: ring.map((entry) => entry.line).join('\n'),
      deployments: JSON.stringify(['mesh-site', 'mesh-collector', 'mesh-site']),
      envs: JSON.stringify(['', '', '']),
    });
    expect(projectedRing(configMap)).toEqual(ring);
    const flood = appendRing(
      [host(1)],
      Array.from({ length: 1000 }, (_, i) => guest(i + 2)),
    );
    expect(flood).toHaveLength(MAX_LINES);
    expect(flood[0]).toEqual(host(1));
    for (const entry of flood.slice(1))
      expect(entry.deployment).toBe(
        Number(entry.line.split(' ').at(-1)) % 2 ? 'mesh-site' : 'mesh-collector',
      );
  });

  it('reads data.deployments only when it is aligned with data.lines', () => {
    const cm = (data: Record<string, string>): Resource => ({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'x' },
      data,
    });
    expect(projectedDeployments(undefined)).toBeUndefined();
    expect(projectedDeployments(cm({ lines: 'a\nb' }))).toBeUndefined();
    expect(projectedDeployments(cm({ lines: 'a\nb', deployments: '{' }))).toBeUndefined();
    expect(projectedDeployments(cm({ lines: 'a\nb', deployments: '{"a":1}' }))).toBeUndefined();
    expect(projectedDeployments(cm({ lines: 'a\nb', deployments: '["x",1]' }))).toBeUndefined();
    expect(projectedDeployments(cm({ lines: 'a\nb', deployments: '["x"]' }))).toBeUndefined();
    expect(projectedDeployments(cm({ lines: 'a\nb', deployments: '["x",""]' }))).toEqual(['x', '']);
    // Without (aligned) deployments, the ring reads as unattributed lines.
    expect(projectedRing(cm({ lines: 'a\nb', deployments: '["x"]' }))).toEqual([
      { line: 'a', deployment: '' },
      { line: 'b', deployment: '' },
    ]);
    // A ring of unattributed lines is written as before.
    expect(
      logsConfigMap('alpha', NS, 'test', 'mesh', [{ line: 'a', deployment: '' }]).data,
    ).toEqual({ lines: 'a' });
    expect(
      logsConfigMap('alpha', NS, 'test', 'mesh', [
        { line: 'a', deployment: '' },
        'b',
        {
          line: 'c',
          deployment: 'mesh-site',
        },
      ]).data,
    ).toEqual({
      lines: 'a\nb\nc',
      deployments: JSON.stringify(['', '', 'mesh-site']),
      envs: JSON.stringify(['', '', '']),
    });
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
  /** ConfigMap writes, `<name>?<query>`. */
  writes: string[] = [];
  /** `<METHOD> <ConfigMap name>` calls the API refuses, as at the namespace quota. */
  refused = new Set<string>();
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
    if (this.refused.has(`${method} ${name}`))
      throw new ApiError(403, `exceeded quota: count/configmaps (${name})`);
    if (method === 'PATCH') {
      this.writes.push(`${name}${url.search}`);
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
    // The read starts two minutes before the cursor; the floor drops what was published.
    expect(api.logQueries.at(-1)).toBe(`?sinceTime=${encodeURIComponent('2026-10-01T09:58:02Z')}`);
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

  it('clears a failure when the deployment starts a new host workload, dropping the key', async () => {
    const api = new LogApi();
    const failed = failureLine('failed to start workload reason="timed out"', {
      name: 'mesh-site-78b9f6d4b6-55b5d9c569',
      level: 'ERROR',
      at: at(2),
    });
    api.logs.set(
      'host-0',
      [startLine('mesh-site-78b9f6d4b6-55b5d9c569', 'w-1', 1), failed].join('\n'),
    );
    const controller = new Controller(api, cfg);
    await controller.projectLogs(tenant());
    expect(
      Object.keys(JSON.parse(projectedFailuresText(api.configMaps.get('di-logs-mesh')))),
    ).toEqual(['mesh-site']);
    // The retry's start arrives in a later read, with the failure again in the lookback.
    api.logs.set(
      'host-0',
      [failed, startLine('mesh-site-78b9f6d4b6-5d4d5db5c6', 'w-2', 3)].join('\n'),
    );
    await controller.projectLogs(tenant());
    // The failure line stays in the ring, still attributed to its deployment.
    expect(api.configMaps.get('di-logs-mesh')?.data).toEqual({
      lines: `${at(2)} ERROR host: failed to start workload reason="timed out"`,
      deployments: JSON.stringify(['mesh-site']),
      envs: JSON.stringify(['']),
    });
  });

  it('records the deployment of every line, so older failures stay attributed', async () => {
    const api = new LogApi();
    api.logs.set(
      'host-0',
      [
        hostLine('site up', { name: 'mesh-site-a-1', at: at(1) }),
        failureLine('failed to start workload reason="first"', {
          name: 'mesh-site-a-1',
          level: 'ERROR',
          at: at(2),
        }),
        hostLine('collector up', { name: 'mesh-collector-c-1', at: at(3) }),
        failureLine('failed to start workload reason="second"', {
          name: 'mesh-site-a-1',
          level: 'ERROR',
          at: at(4),
        }),
      ].join('\n'),
    );
    const controller = new Controller(api, cfg);
    await controller.projectLogs(tenant());
    expect(projectedRing(api.configMaps.get('di-logs-mesh'))).toEqual([
      { line: `${at(1)} INFO site up`, deployment: 'mesh-site', env: '' },
      {
        line: `${at(2)} ERROR host: failed to start workload reason="first"`,
        deployment: 'mesh-site',
        env: '',
      },
      { line: `${at(3)} INFO collector up`, deployment: 'mesh-collector', env: '' },
      {
        line: `${at(4)} ERROR host: failed to start workload reason="second"`,
        deployment: 'mesh-site',
        env: '',
      },
    ]);
    // data.failures still keeps only the newest failure per deployment.
    expect(
      Object.values(JSON.parse(projectedFailuresText(api.configMaps.get('di-logs-mesh')))),
    ).toEqual([expect.objectContaining({ time: at(4) })]);

    // A ring published before deployments were recorded keeps its old lines unattributed.
    api.configMaps.set(
      'di-logs-mesh',
      logsConfigMap('alpha', NS, 'test', 'mesh', [`${at(5)} INFO earlier`]),
    );
    api.logs.set('host-0', hostLine('later', { name: 'mesh-site-a-1', at: at(6) }));
    await new Controller(api, cfg).projectLogs(tenant());
    expect(projectedRing(api.configMaps.get('di-logs-mesh'))).toEqual([
      { line: `${at(5)} INFO earlier`, deployment: '', env: '' },
      { line: `${at(6)} INFO later`, deployment: 'mesh-site', env: '' },
    ]);
  });

  it('keeps a host line in the ring across a guest flood and a controller restart', async () => {
    const api = new LogApi();
    const stamp = (n: number) =>
      `2026-10-01T23:03:${String(55 + Math.floor(n / 1000)).padStart(2, '0')}.${String(n % 1000).padStart(6, '0')}Z`;
    const flood = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        hostLine(`mqtt ${from + i}`, { name: 'mesh-collector-a-1', at: stamp(from + i) }),
      );
    const failed = failureLine('failed to start workload reason="no host header found"', {
      name: 'mesh-site-b-1',
      level: 'ERROR',
      at: stamp(1),
    });
    api.logs.set('host-0', [...flood(0, 1), failed, ...flood(2, 500)].join('\n'));
    await new Controller(api, cfg).projectLogs(tenant());
    const expected = `${stamp(1)} ERROR host: failed to start workload reason="no host header found"`;
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toHaveLength(MAX_LINES);
    expect(linesOf(api, 'di-logs-mesh').split('\n')[0]).toBe(expected);
    // A restarted controller re-merges with the published ring under another flood.
    api.logs.set('host-0', flood(502, 998).join('\n'));
    await new Controller(api, cfg).projectLogs(tenant());
    const ring = linesOf(api, 'di-logs-mesh').split('\n');
    expect(ring).toHaveLength(MAX_LINES);
    expect(ring[0]).toBe(expected);
    expect(ring.at(-1)).toBe(`${stamp(1499)} INFO mqtt 1499`);
  });

  it('attributes a service crash logged after the tick that saw its start', async () => {
    const api = new LogApi();
    api.workloads = [
      {
        metadata: { name: 'collector', labels: { 'di-framework.dev/workload': 'mesh' } },
        spec: { template: { spec: { service: { image: 'x' } } } },
      } as never,
      { metadata: { name: 'site', labels: { 'di-framework.dev/workload': 'mesh' } } },
    ];
    const start = startLine('collector-a-1', 'w-1', 1);
    const guest = hostLine('connecting', {
      name: 'collector-a-1',
      at: at(1).replace('.000000', '.000001'),
    });
    api.logs.set('host-0', [start, guest].join('\n'));
    const controller = new Controller(api, cfg);
    await controller.projectLogs(tenant());
    expect(projectedFailuresText(api.configMaps.get('di-logs-mesh'))).toBe('{}');
    // The next read overlaps the cursor, so it sees the start again with the crash.
    api.logs.set('host-0', [start, guest, loopLine(2)].join('\n'));
    await controller.projectLogs(tenant());
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toEqual([
      `${at(1).replace('.000000', '.000001')} INFO connecting`,
      `${at(2)} ERROR host: P3 service execution failed err=trap retries=0`,
    ]);
    expect(JSON.parse(projectedFailuresText(api.configMaps.get('di-logs-mesh')))).toEqual({
      collector: {
        workload: 'collector-a-1',
        time: at(2),
        level: 'ERROR',
        message: 'P3 service execution failed err=trap retries=0',
      },
    });
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

  it('drops the cursor of a host pod that is gone, and keeps the others (#131)', async () => {
    const api = new LogApi();
    api.pods = [
      { metadata: { name: 'host-0', uid: 'pod-0' }, status: { phase: 'Running' } },
      { metadata: { name: 'host-1', uid: 'pod-1' }, status: { phase: 'Running' } },
    ];
    api.logs.set('host-0', hostLine('zero up', { at: '2026-10-01T10:00:01.000000Z' }));
    api.logs.set('host-1', hostLine('one up', { at: '2026-10-01T10:00:02.000000Z' }));
    const controller = new Controller(api, cfg);
    const cursors = () =>
      (controller as unknown as { logCursors: Map<string, Map<string, Map<string, string>>> })
        .logCursors;
    await controller.projectLogs(tenant());
    expect([...(cursors().get('alpha')?.keys() ?? [])]).toEqual(['pod-0', 'pod-1']);
    // host-1 is gone; host-0 is listed but not running and keeps its cursor.
    api.pods = [{ metadata: { name: 'host-0', uid: 'pod-0' }, status: { phase: 'Pending' } }];
    await controller.projectLogs(tenant());
    expect([...(cursors().get('alpha')?.entries() ?? [])]).toEqual([
      ['pod-0', new Map([['mesh', '2026-10-01T10:00:01.000000Z']])],
    ]);
    api.pods = [{ metadata: { name: 'host-0', uid: 'pod-0' }, status: { phase: 'Running' } }];
    api.logQueries = [];
    await controller.projectLogs(tenant());
    expect(api.logQueries).toEqual([`?sinceTime=${encodeURIComponent('2026-10-01T09:58:01Z')}`]);
  });

  it('forgets the host wiring and log cursors of tenants that are gone (#131)', async () => {
    const controller = new Controller(new LogApi(), cfg);
    const state = controller as unknown as {
      logCursors: Map<string, Map<string, Map<string, string>>>;
      logWriteFailures: Map<string, Map<string, { count: number; message: string }>>;
      hostPulls: Map<string, { caDigest?: string } | undefined>;
    };
    for (const name of ['alpha', 'beta', 'gone']) {
      state.logCursors.set(
        name,
        new Map([['pod', new Map([['mesh', '2026-10-01T10:00:00.000000Z']])]]),
      );
      state.logWriteFailures.set(name, new Map([['di-logs-mesh', { count: 1, message: 'quota' }]]));
      state.hostPulls.set(name, { caDigest: `${name}-digest` });
    }
    const suspended = {
      ...tenant(),
      metadata: { ...tenant().metadata, name: 'beta' },
      spec: { suspended: true },
    };
    const spies = [
      spyOn(controller, 'reconcileTenant').mockResolvedValue(),
      spyOn(controller, 'projectLogs').mockResolvedValue(),
      spyOn(controller, 'reconcileWorkloadStorage').mockResolvedValue(),
      spyOn(controller, 'reconcileTenantEgress').mockResolvedValue(),
      spyOn(
        controller as unknown as { list: (...args: unknown[]) => Promise<unknown[]> },
        'list',
      ).mockImplementation(async (_v: unknown, kind: unknown) =>
        kind === 'Tenant' ? [tenant(), suspended] : [],
      ),
    ];
    try {
      await controller.tick();
      // The live tenant keeps both; the suspended one keeps its wiring but projects no logs.
      expect([...state.hostPulls.keys()]).toEqual(['alpha', 'beta']);
      expect(state.hostPulls.get('alpha')).toEqual({ caDigest: 'alpha-digest' });
      expect([...state.logCursors.keys()]).toEqual(['alpha']);
      expect([...(state.logCursors.get('alpha')?.keys() ?? [])]).toEqual(['pod']);
      expect([...state.logWriteFailures.keys()]).toEqual(['alpha']);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('log projection security', () => {
  it('reads host logs through its own ClusterRole and grants itself nothing per tenant', () => {
    // #321: the controller holds `pods/log get` cluster-wide (the runtime Roles grant it), so the
    // per-tenant `di-platform-log-reader` Role and binding are no longer rendered.
    expect(controllerClusterRoleRules()).toContainEqual({
      apiGroups: [''],
      resources: ['pods/log'],
      verbs: ['get'],
    });
    const resources = tenantResources(tenant(), cfg);
    expect(resources.some((r) => r.metadata.name === 'di-platform-log-reader')).toBe(false);
    expect(
      resources.some((r) =>
        ((r.subjects as { name: string }[] | undefined) ?? []).some(
          (s) => s.name === 'di-platform-controller',
        ),
      ),
    ).toBe(false);
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

describe('projection keys per deployment and env (#106)', () => {
  /** The labels `/v1/deploy` renders on service `web`'s WorkloadDeployment in `env`. */
  const v1 = (env: string, service = 'web'): WorkloadIdentity => ({
    name: `${service}-${env}`,
    labels: {
      'app.kubernetes.io/managed-by': 'di-framework',
      'app.kubernetes.io/name': `${service}-${env}`,
      'di-framework.dev/application': service,
      'di-framework.dev/service': service,
      'platform.di-framework.dev/env': env,
    },
  });
  /** A CLI workload whose application label equals the /v1 service name. */
  const cli: WorkloadIdentity = { name: 'web', labels: { 'di-framework.dev/application': 'web' } };

  it('keys a /v1 deployment by service and env, anything else by application', () => {
    expect(logKey(v1('prod'))).toEqual({ application: 'web', env: 'prod' });
    expect(logKey(v1('staging'))).toEqual({ application: 'web', env: 'staging' });
    expect(logKey(cli)).toEqual({ application: 'web', env: '' });
    // An env label alone does not make a /v1 key: the name must be `<service>-<env>`.
    expect(logKey({ ...v1('prod'), name: 'other' })).toEqual({ application: 'web', env: '' });
    expect(logKey(v1('dev'))).toEqual({ application: 'web', env: '' });
    expect(logKey({ name: 'bare' })).toEqual({ application: 'bare', env: '' });
    expect(logKeyId(logKey(v1('prod')))).toBe('web/prod');
    expect(logKeyId(logKey(cli))).toBe('web');
  });

  it('names /v1 projections with a dot, which no other projection name has', () => {
    expect(logsConfigMapName('web', 'prod')).toBe('di-logs-web.prod');
    expect(logsConfigMapName('web', 'staging')).toBe('di-logs-web.staging');
    const long = logsConfigMapName('a'.repeat(60), 'staging');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^di-logs-a+-[0-9a-f]+\.staging$/);
    for (const app of ['web.prod', 'web-prod', 'My.App', 'a'.repeat(80)])
      expect(logsConfigMapName(app)).not.toContain('.');
  });

  it('labels a /v1 projection with its env and records the env of every line', () => {
    const configMap = logsConfigMap(
      'alpha',
      NS,
      'test',
      'web',
      [{ line: '2026-10-01T10:00:00Z INFO up', deployment: 'web-prod', env: 'prod' }],
      {},
      'prod',
    );
    expect(configMap.metadata.name).toBe('di-logs-web.prod');
    expect(configMap.metadata.labels).toMatchObject({
      'di-framework.dev/application': 'web',
      'platform.di-framework.dev/env': 'prod',
    });
    expect(configMap.data).toMatchObject({
      deployments: JSON.stringify(['web-prod']),
      envs: JSON.stringify(['prod']),
    });
    expect(configMapLogKey(configMap)).toEqual({ application: 'web', env: 'prod' });
    expect(projectedEnvs(configMap)).toEqual(['prod']);
    // A line without a recorded env takes the ConfigMap's env label.
    const { envs: _envs, ...data } = configMap.data as Record<string, string>;
    expect(projectedRing({ ...configMap, data })).toEqual([
      { line: '2026-10-01T10:00:00Z INFO up', deployment: 'web-prod', env: 'prod' },
    ]);
  });

  it('reads data.envs only when it is aligned with data.lines', () => {
    const cm = (data: Record<string, string>): Resource => ({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'x' },
      data,
    });
    expect(projectedEnvs(undefined)).toBeUndefined();
    expect(projectedEnvs(cm({ lines: 'a\nb' }))).toBeUndefined();
    expect(projectedEnvs(cm({ lines: 'a\nb', envs: '{' }))).toBeUndefined();
    expect(projectedEnvs(cm({ lines: 'a\nb', envs: '{"a":1}' }))).toBeUndefined();
    expect(projectedEnvs(cm({ lines: 'a\nb', envs: '["prod",1]' }))).toBeUndefined();
    expect(projectedEnvs(cm({ lines: 'a\nb', envs: '["prod"]' }))).toBeUndefined();
    expect(projectedEnvs(cm({ lines: 'a\nb', envs: '["prod",""]' }))).toEqual(['prod', '']);
    // Without a recorded env or an env label, the env of a line is not known.
    expect(projectedRing(cm({ lines: 'a' }))).toEqual([{ line: 'a', deployment: '' }]);
  });

  it('takes over the lines and failure of one deployment from a shared ConfigMap', () => {
    const failure: HostFailure = {
      workload: 'web-prod-a-1',
      time: '2026-10-01T10:00:02Z',
      level: 'ERROR',
      message: 'boom',
    };
    const legacy = logsConfigMap(
      'alpha',
      NS,
      'test',
      'web',
      [
        { line: '2026-10-01T10:00:00Z INFO before deployments', deployment: '' },
        { line: '2026-10-01T10:00:01Z INFO prod up', deployment: 'web-prod' },
        { line: '2026-10-01T10:00:02Z ERROR host: boom', deployment: 'web-prod' },
        { line: '2026-10-01T10:00:03Z INFO staging up', deployment: 'web-staging' },
      ],
      { 'web-prod': failure },
    );
    expect(legacyRing(legacy, 'web-prod', 'prod')).toEqual({
      lines: [
        { line: '2026-10-01T10:00:01Z INFO prod up', deployment: 'web-prod', env: 'prod' },
        { line: '2026-10-01T10:00:02Z ERROR host: boom', deployment: 'web-prod', env: 'prod' },
      ],
      failures: { 'web-prod': failure },
    });
    expect(legacyRing(legacy, 'web-staging', 'staging')).toEqual({
      lines: [
        {
          line: '2026-10-01T10:00:03Z INFO staging up',
          deployment: 'web-staging',
          env: 'staging',
        },
      ],
      failures: {},
    });
    expect(legacyRing(undefined, 'web-prod', 'prod')).toEqual({ lines: [], failures: {} });
  });

  it('attributes staging, prod, and a same-named CLI workload to three projections', () => {
    const text = [
      hostLine('prod up', { name: 'web-prod', at: '2026-10-01T10:00:01Z' }),
      hostLine('staging up', { name: 'web-staging', at: '2026-10-01T10:00:02Z' }),
      hostLine('cli up', { name: 'web', at: '2026-10-01T10:00:03Z' }),
    ].join('\n');
    const entries = attributeEntries(text, NS, [v1('prod'), v1('staging'), cli]);
    expect([...entries.keys()]).toEqual(['web/prod', 'web/staging', 'web']);
    expect(entries.get('web/prod')).toEqual([
      {
        time: '2026-10-01T10:00:01Z',
        line: '2026-10-01T10:00:01Z INFO prod up',
        deployment: 'web-prod',
        env: 'prod',
      },
    ]);
    expect(entries.get('web')?.[0]?.env).toBe('');
  });

  it('publishes one ConfigMap per deployment env, apart from the CLI workload', async () => {
    const api = new LogApi();
    api.workloads = [v1('prod'), v1('staging'), cli].map((metadata) => ({ metadata }));
    api.logs.set(
      'host-0',
      [
        hostLine('prod up', { name: 'web-prod', at: '2026-10-01T10:00:01.000000Z' }),
        hostLine('staging up', { name: 'web-staging', at: '2026-10-01T10:00:02.000000Z' }),
        hostLine('cli up', { name: 'web', at: '2026-10-01T10:00:03.000000Z' }),
      ].join('\n'),
    );
    await new Controller(api, cfg).projectLogs(tenant());
    expect([...api.configMaps.keys()].sort()).toEqual([
      'di-logs-web',
      'di-logs-web.prod',
      'di-logs-web.staging',
    ]);
    expect(projectedRing(api.configMaps.get('di-logs-web.prod'))).toEqual([
      { line: '2026-10-01T10:00:01.000000Z INFO prod up', deployment: 'web-prod', env: 'prod' },
    ]);
    expect(projectedRing(api.configMaps.get('di-logs-web.staging'))).toEqual([
      {
        line: '2026-10-01T10:00:02.000000Z INFO staging up',
        deployment: 'web-staging',
        env: 'staging',
      },
    ]);
    expect(projectedRing(api.configMaps.get('di-logs-web'))).toEqual([
      { line: '2026-10-01T10:00:03.000000Z INFO cli up', deployment: 'web', env: '' },
    ]);
    expect(api.configMaps.get('di-logs-web.prod')?.metadata.labels).toMatchObject({
      'di-framework.dev/application': 'web',
      'platform.di-framework.dev/env': 'prod',
    });
    expect(
      api.configMaps.get('di-logs-web')?.metadata.labels?.['platform.di-framework.dev/env'],
    ).toBeUndefined();
  });

  it('migrates a ConfigMap staging and prod shared into per-env ones, then deletes it', async () => {
    const api = new LogApi();
    api.workloads = [v1('prod'), v1('staging')].map((metadata) => ({ metadata }));
    const failure: HostFailure = {
      workload: 'web-prod-a-1',
      time: '2026-10-01T10:00:02.000000Z',
      level: 'ERROR',
      message: 'boom',
    };
    api.configMaps.set(
      'di-logs-web',
      logsConfigMap(
        'alpha',
        NS,
        'test',
        'web',
        [
          { line: '2026-10-01T10:00:00.000000Z INFO unattributed', deployment: '' },
          { line: '2026-10-01T10:00:01.000000Z INFO prod up', deployment: 'web-prod' },
          { line: '2026-10-01T10:00:02.000000Z ERROR host: boom', deployment: 'web-prod' },
          { line: '2026-10-01T10:00:03.000000Z INFO staging up', deployment: 'web-staging' },
        ],
        { 'web-prod': failure },
      ),
    );
    // The host log still holds a published prod line and one new one.
    api.logs.set(
      'host-0',
      [
        hostLine('prod up', { name: 'web-prod', at: '2026-10-01T10:00:01.000000Z' }),
        hostLine('prod later', { name: 'web-prod', at: '2026-10-01T10:00:04.000000Z' }),
      ].join('\n'),
    );
    await new Controller(api, cfg).projectLogs(tenant());
    expect([...api.configMaps.keys()].sort()).toEqual(['di-logs-web.prod', 'di-logs-web.staging']);
    // Published lines are not repeated: the taken-over ring sets the floor.
    expect(linesOf(api, 'di-logs-web.prod').split('\n')).toEqual([
      '2026-10-01T10:00:01.000000Z INFO prod up',
      '2026-10-01T10:00:02.000000Z ERROR host: boom',
      '2026-10-01T10:00:04.000000Z INFO prod later',
    ]);
    expect(JSON.parse(projectedFailuresText(api.configMaps.get('di-logs-web.prod')))).toEqual({
      'web-prod': failure,
    });
    // Staging had no new lines this tick; its lines were still taken over before the delete.
    expect(projectedRing(api.configMaps.get('di-logs-web.staging'))).toEqual([
      {
        line: '2026-10-01T10:00:03.000000Z INFO staging up',
        deployment: 'web-staging',
        env: 'staging',
      },
    ]);
  });

  it('keeps a shared ConfigMap a live CLI application still owns, after the takeover', async () => {
    const api = new LogApi();
    api.workloads = [v1('prod'), cli].map((metadata) => ({ metadata }));
    api.configMaps.set(
      'di-logs-web',
      logsConfigMap('alpha', NS, 'test', 'web', [
        { line: '2026-10-01T10:00:01.000000Z INFO prod up', deployment: 'web-prod' },
        { line: '2026-10-01T10:00:02.000000Z INFO cli up', deployment: 'web' },
      ]),
    );
    api.logs.set('host-0', '');
    const controller = new Controller(api, cfg);
    await controller.projectLogs(tenant());
    expect([...api.configMaps.keys()].sort()).toEqual(['di-logs-web', 'di-logs-web.prod']);
    expect(linesOf(api, 'di-logs-web.prod')).toBe('2026-10-01T10:00:01.000000Z INFO prod up');
    // The kept ConfigMap is rewritten in the same pass, after the takeover, by server-side
    // apply: the prod line now lives in di-logs-web.prod only.
    expect(api.writes).toEqual([
      'di-logs-web.prod?fieldManager=di-platform-controller',
      'di-logs-web?fieldManager=di-platform-controller',
    ]);
    expect(projectedRing(api.configMaps.get('di-logs-web'))).toEqual([
      { line: '2026-10-01T10:00:02.000000Z INFO cli up', deployment: 'web', env: '' },
    ]);
    // The next tick finds the per-env ConfigMap and has nothing to take over or prune.
    await controller.projectLogs(tenant());
    expect(api.writes).toHaveLength(2);
    expect(linesOf(api, 'di-logs-web.prod')).toBe('2026-10-01T10:00:01.000000Z INFO prod up');
  });

  it('keeps going when one ConfigMap write fails, and holds back an untaken shared one', async () => {
    const api = new LogApi();
    api.workloads = [v1('prod'), v1('staging'), cli].map((metadata) => ({ metadata }));
    const shared = logsConfigMap('alpha', NS, 'test', 'web', [
      { line: '2026-10-01T10:00:01.000000Z INFO prod up', deployment: 'web-prod' },
      { line: '2026-10-01T10:00:02.000000Z INFO staging up', deployment: 'web-staging' },
      { line: '2026-10-01T10:00:03.000000Z INFO cli up', deployment: 'web' },
    ]);
    api.configMaps.set('di-logs-web', shared);
    api.configMaps.set('di-logs-gone', logsConfigMap('alpha', NS, 'test', 'gone', ['x']));
    api.refused.add('PATCH di-logs-web.prod');
    api.refused.add('DELETE di-logs-gone');
    api.logs.set('host-0', '');
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await new Controller(api, cfg).projectLogs(tenant());
      // Staging was still taken over; the shared ConfigMap keeps prod's line for the next try.
      expect(linesOf(api, 'di-logs-web.staging')).toBe(
        '2026-10-01T10:00:02.000000Z INFO staging up',
      );
      expect(api.configMaps.get('di-logs-web')).toEqual(shared);
      expect(api.configMaps.has('di-logs-gone')).toBe(true);
      expect(errors.mock.calls.map(([line]) => line)).toEqual([
        'Tenant/alpha logs ConfigMap di-logs-web.prod: exceeded quota: count/configmaps (di-logs-web.prod)',
        'Tenant/alpha logs ConfigMap di-logs-gone: exceeded quota: count/configmaps (di-logs-gone)',
      ]);
      // Once there is room, the next poll finishes the move.
      api.refused.clear();
      await new Controller(api, cfg).projectLogs(tenant());
      expect(linesOf(api, 'di-logs-web.prod')).toBe('2026-10-01T10:00:01.000000Z INFO prod up');
      expect(linesOf(api, 'di-logs-web')).toBe('2026-10-01T10:00:03.000000Z INFO cli up');
      expect(api.configMaps.has('di-logs-gone')).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('deletes a shared ConfigMap with nothing to take over', async () => {
    const api = new LogApi();
    api.workloads = [{ metadata: v1('prod') }];
    api.configMaps.set(
      'di-logs-web',
      logsConfigMap('alpha', NS, 'test', 'web', ['2026-10-01T10:00:00.000000Z INFO old']),
    );
    api.logs.set('host-0', '');
    await new Controller(api, cfg).projectLogs(tenant());
    expect(api.configMaps.size).toBe(0);
  });
});

describe('projection cursor and write failures (#316)', () => {
  const at = (second: number) => `2026-10-01T10:00:0${second}.000000Z`;
  const mesh = (message: string, second: number, name = 'mesh-collector') =>
    hostLine(message, { name, at: at(second) });
  const published = (message: string, second: number) => `${at(second)} INFO ${message}`;
  const failuresOf = (controller: Controller) =>
    (
      controller as unknown as {
        logWriteFailures: Map<string, Map<string, { count: number; message: string }>>;
      }
    ).logWriteFailures.get('alpha');
  /** Runs `body` with console.error silenced, and returns how often it was called. */
  const quietly = async (body: () => Promise<void>): Promise<number> => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await body();
      return errors.mock.calls.length;
    } finally {
      errors.mockRestore();
    }
  };
  /** The API stores the first ConfigMap PATCH, then its response is lost (e.g. a timeout). */
  const loseFirstPatch = (api: LogApi) => {
    const call = api.call.bind(api);
    let lose = true;
    return spyOn(api, 'call').mockImplementation(async (method, path, body) => {
      const result = await call(method, path, body);
      if (method === 'PATCH' && lose) {
        lose = false;
        throw new Error('timed out');
      }
      return result as never;
    });
  };
  /** Both host pods running. */
  const twoPods = (api: LogApi) => {
    api.pods = [
      { metadata: { name: 'host-0', uid: 'pod-0' }, status: { phase: 'Running' } },
      { metadata: { name: 'host-1', uid: 'pod-1' }, status: { phase: 'Running' } },
    ];
  };

  it('retries the lines of a failed write on the next poll, once', async () => {
    const api = new LogApi();
    const controller = new Controller(api, cfg);
    api.logs.set('host-0', mesh('one', 1));
    await controller.projectLogs(tenant());
    expect(linesOf(api, 'di-logs-mesh')).toBe(published('one', 1));

    // The next write is refused: its lines stay unpublished, and the greeter key still moves on.
    api.refused.add('PATCH di-logs-mesh');
    api.logs.set(
      'host-0',
      [mesh('one', 1), mesh('two', 2), hostLine('hi', { name: 'greeter', at: at(3) })].join('\n'),
    );
    const logged = await quietly(async () => {
      await controller.projectLogs(tenant());
      await controller.projectLogs(tenant());
    });
    // Logged once while the failure does not change.
    expect(logged).toBe(1);
    expect(linesOf(api, 'di-logs-mesh')).toBe(published('one', 1));
    expect(linesOf(api, 'di-logs-greeter')).toBe(published('hi', 3));
    // The read starts from the held cursor, bounded while a write keeps failing.
    expect(api.logQueries.at(-1)).toBe(
      `?sinceTime=${encodeURIComponent('2026-10-01T09:58:01Z')}&tailLines=1000`,
    );

    // Once the write goes through, the held lines are published with the new one, each once.
    api.refused.clear();
    api.logs.set(
      'host-0',
      [
        mesh('one', 1),
        mesh('two', 2),
        hostLine('hi', { name: 'greeter', at: at(3) }),
        mesh('three', 4),
      ].join('\n'),
    );
    await controller.projectLogs(tenant());
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toEqual([
      published('one', 1),
      published('two', 2),
      published('three', 4),
    ]);
    expect(linesOf(api, 'di-logs-greeter')).toBe(published('hi', 3));
    expect(failuresOf(controller)).toBeUndefined();
    // Both keys moved on; the bound is gone again.
    await controller.projectLogs(tenant());
    expect(api.logQueries.at(-1)).toBe(`?sinceTime=${encodeURIComponent('2026-10-01T09:58:04Z')}`);
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toHaveLength(3);
  });

  it('keeps the first lines of a key whose very first write failed', async () => {
    const api = new LogApi();
    const controller = new Controller(api, cfg);
    api.refused.add('PATCH di-logs-mesh');
    api.logs.set('host-0', mesh('one', 1));
    await quietly(() => controller.projectLogs(tenant()));
    expect(api.configMaps.has('di-logs-mesh')).toBe(false);
    api.refused.clear();
    api.logs.set('host-0', [mesh('one', 1), mesh('two', 2)].join('\n'));
    await controller.projectLogs(tenant());
    // Nothing was published, so the retry reads the bounded tail again.
    expect(api.logQueries.at(-1)).toBe('?tailLines=1000');
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toEqual([
      published('one', 1),
      published('two', 2),
    ]);
  });

  it('does not repeat lines of a write that applied but reported a failure', async () => {
    const api = new LogApi();
    const controller = new Controller(api, cfg);
    api.logs.set('host-0', mesh('one', 1));
    // The API stores the ConfigMap, then the response is lost.
    const lost = loseFirstPatch(api);
    try {
      await quietly(async () => {
        await controller.projectLogs(tenant());
        expect(linesOf(api, 'di-logs-mesh')).toBe(published('one', 1));
        api.logs.set('host-0', [mesh('one', 1), mesh('two', 2)].join('\n'));
        await controller.projectLogs(tenant());
      });
    } finally {
      lost.mockRestore();
    }
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toEqual([
      published('one', 1),
      published('two', 2),
    ]);
  });

  it('keeps a retried batch within the ring bound', async () => {
    const api = new LogApi();
    const controller = new Controller(api, cfg);
    api.refused.add('PATCH di-logs-mesh');
    const flood = Array.from({ length: MAX_LINES + 50 }, (_, i) =>
      hostLine(`line ${i}`, {
        at: `2026-10-01T10:${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000000Z`,
      }),
    );
    api.logs.set('host-0', flood.join('\n'));
    await quietly(() => controller.projectLogs(tenant()));
    api.refused.clear();
    await controller.projectLogs(tenant());
    const lines = linesOf(api, 'di-logs-mesh').split('\n');
    expect(lines).toHaveLength(MAX_LINES);
    expect(new Set(lines).size).toBe(MAX_LINES);
    expect(lines.at(-1)).toEndWith(`line ${MAX_LINES + 49}`);
  });

  /** A timestamp `micros` microseconds after `second` (10:00:0<second>). */
  const tick = (second: number, micros: number) =>
    `2026-10-01T10:00:0${second}.${String(micros).padStart(6, '0')}Z`;

  it('does not put back evicted lines when a write applied but reported a failure', async () => {
    const api = new LogApi();
    const controller = new Controller(api, cfg);
    const batch = Array.from({ length: MAX_LINES + 50 }, (_, i) =>
      hostLine(`line ${i}`, { at: tick(1, i) }),
    );
    api.logs.set('host-0', batch.join('\n'));
    // The API stores the full batch (the ring keeps lines 50-249), then the response is lost.
    const lost = loseFirstPatch(api);
    try {
      await quietly(async () => {
        await controller.projectLogs(tenant());
        const applied = linesOf(api, 'di-logs-mesh');
        expect(applied.split('\n')[0]).toEndWith('line 50');
        // The retry reads the same batch; nothing changes, and lines 0-49 do not come back.
        await controller.projectLogs(tenant());
        expect(linesOf(api, 'di-logs-mesh')).toBe(applied);
        // A newer line still pushes out the oldest one.
        api.logs.set('host-0', [...batch, hostLine('newest', { at: tick(2, 0) })].join('\n'));
        await controller.projectLogs(tenant());
      });
    } finally {
      lost.mockRestore();
    }
    const lines = linesOf(api, 'di-logs-mesh').split('\n');
    expect(lines).toEqual([
      ...Array.from({ length: MAX_LINES - 1 }, (_, i) => `${tick(1, i + 51)} INFO line ${i + 51}`),
      `${tick(2, 0)} INFO newest`,
    ]);
  });

  it('resumes after the newest stored line when pods logged out of order (#335)', async () => {
    const api = new LogApi();
    twoPods(api);
    const controller = new Controller(api, cfg);
    // Both pods publish (so each has a cursor), host-1 adds an older line, then host-0 fills the
    // ring at :06.
    const zero = [
      mesh('old', 5),
      ...Array.from({ length: MAX_LINES - 3 }, (_, i) => hostLine(`zero ${i}`, { at: tick(6, i) })),
    ];
    const one = [mesh('first', 1), mesh('early', 3)];
    api.logs.set('host-0', zero[0] as string);
    api.logs.set('host-1', one[0] as string);
    await controller.projectLogs(tenant());
    api.logs.set('host-1', one.join('\n'));
    await controller.projectLogs(tenant());
    api.logs.set('host-0', zero.join('\n'));
    await controller.projectLogs(tenant());
    // host-1 then logs two lines older than host-0's newest. They evict `first` and `old`, and
    // the ring's last line is no longer its newest.
    const later = hostLine('later', { at: tick(4, 500000) });
    one.push(mesh('late', 4), later);
    api.logs.set('host-1', one.join('\n'));
    await controller.projectLogs(tenant());
    const stored = linesOf(api, 'di-logs-mesh').split('\n');
    expect(stored).toHaveLength(MAX_LINES);
    expect(stored[0]).toBe(published('early', 3));
    expect(stored.slice(-2)).toEqual([published('late', 4), `${tick(4, 500000)} INFO later`]);
    expect(stored).not.toContain(published('old', 5));

    // After a restart (or a suspend and resume) both pods are read again. Resuming after the
    // last line (:04.5) would publish `old` (:05) a second time, as it is no longer in the ring.
    api.logs.set('host-0', [...zero, mesh('zero new', 8)].join('\n'));
    api.logs.set('host-1', [...one, mesh('one new', 9)].join('\n'));
    await new Controller(api, cfg).projectLogs(tenant());
    const lines = linesOf(api, 'di-logs-mesh').split('\n');
    expect(lines).not.toContain(published('old', 5));
    expect(lines.slice(-3)).toEqual([
      `${tick(4, 500000)} INFO later`,
      published('zero new', 8),
      published('one new', 9),
    ]);
  });

  it('keeps distinct lines that share the floor timestamp, from two pods and one', async () => {
    const api = new LogApi();
    twoPods(api);
    api.logs.set('host-0', mesh('zero', 5));
    api.logs.set('host-1', '');
    await new Controller(api, cfg).projectLogs(tenant());
    // After a restart, host-1 has a distinct line with exactly that stamp, and host-0 logs one
    // more at its own cursor after the read that set it.
    api.logs.set('host-1', mesh('one', 5, 'mesh-site'));
    const controller = new Controller(api, cfg);
    await controller.projectLogs(tenant());
    api.logs.set('host-0', [mesh('zero', 5), mesh('zero again', 5)].join('\n'));
    await controller.projectLogs(tenant());
    expect(linesOf(api, 'di-logs-mesh').split('\n')).toEqual([
      published('zero', 5),
      published('one', 5),
      published('zero again', 5),
    ]);
    // Read again, nothing is repeated or rewritten.
    const writes = api.writes.length;
    await controller.projectLogs(tenant());
    expect(api.writes).toHaveLength(writes);
  });

  it('reports a write that keeps failing, and clears it once it succeeds', async () => {
    const api = new LogApi();
    const controller = new Controller(api, cfg);
    api.refused.add('PATCH di-logs-mesh');
    api.logs.set('host-0', mesh('one', 1));
    await quietly(async () => {
      await controller.projectLogs(tenant());
      await controller.projectLogs(tenant());
      expect(logWriteCondition(failuresOf(controller), 1)).toBeUndefined();
      await controller.projectLogs(tenant());
    });
    expect(logWriteCondition(failuresOf(controller), 1)).toMatchObject({
      type: 'LogsProjected',
      status: 'False',
      reason: 'WriteFailed',
      message:
        'logs ConfigMap di-logs-mesh could not be written: exceeded quota: count/configmaps (di-logs-mesh)',
    });
    api.refused.clear();
    await controller.projectLogs(tenant());
    expect(failuresOf(controller)).toBeUndefined();
    expect(logWriteCondition(failuresOf(controller), 1)).toBeUndefined();
    expect(linesOf(api, 'di-logs-mesh')).toBe(published('one', 1));
  });

  it('names the first persistent failure and counts the others', () => {
    const failures = new Map([
      ['di-logs-b', { count: 3, message: 'b' }],
      ['di-logs-a', { count: 5, message: 'a' }],
      ['di-logs-c', { count: 1, message: 'c' }],
    ]);
    expect(logWriteCondition(failures, 2)).toMatchObject({
      observedGeneration: 2,
      message: 'logs ConfigMap di-logs-a could not be written (and 1 more): a',
    });
    expect(logWriteCondition(undefined, 1)).toBeUndefined();
  });

  it('finds the newest stamp anywhere in a ring and drops published lines', () => {
    expect(newestStamp([published('b', 3), published('a', 5), published('c', 4)])).toBe(at(5));
    expect(newestStamp([])).toBe('');
    const ring: RingLine[] = [{ line: published('a', 1), deployment: 'mesh-collector' }];
    expect(
      unpublished(ring, [
        { line: published('a', 1), deployment: 'mesh-collector' },
        { line: published('a', 1), deployment: 'mesh-site' },
      ]),
    ).toEqual([{ line: published('a', 1), deployment: 'mesh-site' }]);
  });
});
