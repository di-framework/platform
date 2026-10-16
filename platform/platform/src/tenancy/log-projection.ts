import { type Condition, INSTALLATION, type Resource, TENANT } from './resources';

/**
 * Tenant console log projection (#10).
 *
 * The controller tails the tenant hostgroup pods and keeps only lines the wash 2.8
 * `wasi:logging` TracingLogger emitted. Each of those ends with
 * `workload.component_id="…" workload.name="…" workload.namespace="…" context="…"`.
 * Guest stdio reaches the pod log as raw bytes with no attribution, and one host pod
 * runs every workload in the hostgroup, so every other line is dropped.
 *
 * Host WARN/ERROR events inside a `workload_start{…}` span are kept too (C-FAILURES).
 * The span fields carry `workload.name` and `workload.namespace`; the newest of these
 * per WorkloadDeployment is also published as `data.failures` for console status.
 *
 * `data.lines` is the ring the console shows. `data.deployments` names the WorkloadDeployment
 * of each ring line, in the same order, so a reader can filter one deployment's lines, and
 * `data.envs` the /v1 environment of each line ('' for a workload outside /v1).
 *
 * Projections are keyed by logKey (#106): a /v1 deployment (`<service>-<env>`) gets its own
 * ConfigMap per environment, `di-logs-<service>.<env>`, labelled with the service and the
 * environment. Any other workload keeps the console application key and `di-logs-<key>`,
 * which never contains a dot, so the two kinds of projection cannot share a ConfigMap.
 *
 * The host's service supervisor loop runs in an uninstrumented task (wash-runtime
 * `engine/workload.rs`), so its WARN/ERROR lines carry no span. Those are attributed by
 * a heuristic; see attributeEntries.
 */

/** Label the console selects on; `logs` is the only projection the platform writes. */
const PROJECTION = 'di-framework.dev/projection';
/** Console application name the projection belongs to. */
const APPLICATION = 'di-framework.dev/application';
/** Label cli-plugin-platform and the tenant controller put on the objects they manage. */
const MANAGED_BY = 'app.kubernetes.io/managed-by';
const MANAGED_BY_VALUE = 'di-framework';
/** Selects the WorkloadDeployments the projection (and storage reconcile) consider. */
const MANAGED_SELECTOR = `${MANAGED_BY}=${MANAGED_BY_VALUE}`;
/** /v1 environment of a WorkloadDeployment `/v1/deploy` rendered (tenant-auth v1/config.ts). */
const ENV = 'platform.di-framework.dev/env';
/** The environments `/v1/deploy` accepts. */
const ENVS: readonly string[] = ['prod', 'staging'];
/** Multi-member workload grouping set by the CLI on WorkloadDeployments. */
const WORKLOAD = 'di-framework.dev/workload';
/** WorkloadDeployment annotation; `"false"` opts out of guest (`wasi:logging`) lines. */
const LOGS_ANNOTATION = 'di-framework.dev/logs';
const LOGS_PREFIX = 'di-logs-';
/** The console shows at most 200 lines of 500 characters; stay at that bound. */
const MAX_LINES = 200;
const MAX_LINE_LENGTH = 500;
/** Ring slots reserved for host lines, so a guest flood cannot push failures out. */
const MAX_HOST_LINES = 50;
/** A projected host line; guest lines can never take this shape (formatProjectedLine). */
const HOST_LINE = /^\S+ (WARN|ERROR) host: /;

const QUOTED = '"((?:[^"\\\\]|\\\\.)*)"';
/**
 * Anchored at the end of the line. `context` is Debug-escaped by tracing, so a guest
 * message cannot append a second, forged set of fields after the real ones.
 */
const TRACING_TAIL = new RegExp(
  ` workload\\.component_id=${QUOTED} workload\\.name=${QUOTED} workload\\.namespace=${QUOTED} context=${QUOTED}$`,
);
/** Timestamp, level, then any `span{fields}:` prefixes. Quoted span fields may contain `}`. */
const TRACING_HEAD =
  /^(\S+)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(?:(?:[\w.-]+\{(?:[^}"]|"(?:[^"\\]|\\.)*")*\}:)+\s)?/;
/**
 * Host failure head: timestamp, WARN/ERROR, then a chain of `span{fields}:` with no spaces
 * between spans and one space before the message. The chain is matched from the line start,
 * so message text (which can echo guest input, e.g. `reason="…"`) never supplies a span.
 */
const SPAN_HEAD = /^(\S+)\s+(INFO|WARN|ERROR)\s+((?:[\w.-]+\{(?:[^}"]|"(?:[^"\\]|\\.)*")*\}:)+) /;
const SPAN = /([\w.-]+)\{((?:[^}"]|"(?:[^"\\]|\\.)*")*)\}:/y;
/** One `key=value` span field; values are Debug-quoted strings or bare tokens. */
const SPAN_FIELD = / ?([\w.]+)=(?:"((?:[^"\\]|\\.)*)"|([^\s"]*))/y;
/**
 * Span-less WARN/ERROR messages of the wash 2.8 service supervisor loops (plain, P3, and
 * trigger services). Each is a fixed host string, matched right after the level and
 * followed only by tracing fields.
 */
const SERVICE_LOOP_MESSAGES = [
  'service execution failed',
  'max restarts reached, service will not be restarted',
  'failed to instantiate P3 service',
  'P3 service exited with error',
  'P3 service execution failed',
  'max restarts reached, P3 service will not be restarted',
  'failed to rebuild P3 service store; giving up',
  'failed to re-register service HTTP handler on restart',
  'failed to re-register trigger service messaging handler on restart',
  'trigger service faulted; max restarts reached',
  'trigger service faulted; restarting',
  'failed to rebuild trigger service store; giving up',
];
const SERVICE_LOOP = new RegExp(
  // The messages contain no regular expression metacharacters.
  `^(\\S+)\\s+(WARN|ERROR)\\s+(${SERVICE_LOOP_MESSAGES.join('|')})(?: (.*))?$`,
);
/** `INFO workload_stop{workload_id=…}: Stopping workload …` */
const WORKLOAD_STOP = /^\S+\s+INFO\s+workload_stop\{workload_id=([^\s}"]+)\}: /;
/** Any line the host's tracing fmt layer wrote; everything else is raw stdio. */
const STAMPED = /^\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s/;
/** Rust panic payload of a guest JS exception, printed raw on stderr before the host error. */
const PANIC_EXCEPTION = /^Exception \{ message: Some\("((?:[^"\\]|\\.)*)"\)/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal escapes from host output
const ANSI = /\u001b\[[0-9;]*m/g;

const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const ASSIGNED_SECRET =
  /\b(token|password|passwd|secret|api[_-]?key|kubeconfig|authorization|credentials?)\b\s*[:=]\s*\S+/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{40,}/g;

export interface GuestLogLine {
  timestamp: string;
  level: string;
  workloadName: string;
  namespace: string;
  message: string;
}

function cleanLine(raw: string): string {
  return raw.replace(ANSI, '').replace(/\r$/, '');
}

/** Parse one host pod log line. Returns undefined for anything the platform cannot attribute. */
export function parseGuestLogLine(raw: string): GuestLogLine | undefined {
  const line = cleanLine(raw);
  const tail = TRACING_TAIL.exec(line);
  if (!tail) return undefined;
  const head = TRACING_HEAD.exec(line);
  if (!head) return undefined;
  const [, , workloadName, namespace] = tail;
  if (!workloadName || !namespace) return undefined;
  const message = line.slice(head[0].length, tail.index);
  return {
    timestamp: head[1] as string,
    level: head[2] as string,
    workloadName: unescapeDebug(workloadName),
    namespace: unescapeDebug(namespace),
    message,
  };
}

function unescapeDebug(value: string): string {
  return value.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1');
}

/** Fields of one span body, or undefined when the body is not a clean `k=v k=v` list. */
function spanFields(body: string): Map<string, string> | undefined {
  const fields = new Map<string, string>();
  SPAN_FIELD.lastIndex = 0;
  while (SPAN_FIELD.lastIndex < body.length) {
    const match = SPAN_FIELD.exec(body);
    if (!match) return undefined;
    fields.set(match[1] as string, unescapeDebug(match[2] ?? match[3] ?? ''));
  }
  return fields;
}

export interface WorkloadSpanLine extends GuestLogLine {
  /** `workload_id` of the outer `workload_start` span ('' when absent). */
  workloadId: string;
}

/**
 * Parse a host INFO/WARN/ERROR line emitted inside a `workload_start` span. The outermost
 * span must be `workload_start` with both `workload.name` and `workload.namespace`; nested
 * spans that repeat them must agree. TracingLogger (guest) lines never match.
 */
export function parseWorkloadSpanLine(raw: string): WorkloadSpanLine | undefined {
  const line = cleanLine(raw);
  if (TRACING_TAIL.test(line)) return undefined;
  const head = SPAN_HEAD.exec(line);
  if (!head) return undefined;
  const chain = head[3] as string;
  let workloadId = '';
  let workloadName: string | undefined;
  let namespace: string | undefined;
  SPAN.lastIndex = 0;
  for (let index = 0; SPAN.lastIndex < chain.length; index++) {
    const span = SPAN.exec(chain) as RegExpExecArray;
    const fields = spanFields(span[2] as string);
    if (!fields) return undefined;
    const name = fields.get('workload.name');
    const ns = fields.get('workload.namespace');
    if (index === 0) {
      if (span[1] !== 'workload_start' || !name || !ns) return undefined;
      workloadName = name;
      namespace = ns;
      workloadId = fields.get('workload_id') ?? '';
    } else if (
      (name !== undefined && name !== workloadName) ||
      (ns !== undefined && ns !== namespace)
    ) {
      return undefined;
    }
  }
  return {
    timestamp: head[1] as string,
    level: head[2] as string,
    workloadName: workloadName as string,
    namespace: namespace as string,
    message: line.slice(head[0].length),
    workloadId,
  };
}

/** A host WARN/ERROR line inside a `workload_start` span (see parseWorkloadSpanLine). */
export function parseHostFailureLine(raw: string): GuestLogLine | undefined {
  const parsed = parseWorkloadSpanLine(raw);
  if (!parsed || parsed.level === 'INFO') return undefined;
  const { workloadId: _id, ...line } = parsed;
  return line;
}

export interface ServiceLoopLine {
  timestamp: string;
  level: string;
  /** The fixed host message, e.g. `P3 service execution failed`. */
  summary: string;
  /** The whole message including tracing fields. */
  message: string;
}

/** Parse a span-less WARN/ERROR line of the host service supervisor loop. */
export function parseServiceLoopLine(raw: string): ServiceLoopLine | undefined {
  const line = cleanLine(raw);
  if (TRACING_TAIL.test(line)) return undefined;
  const match = SERVICE_LOOP.exec(line);
  if (!match) return undefined;
  return {
    timestamp: match[1] as string,
    level: match[2] as string,
    summary: match[3] as string,
    message: match[4] ? `${match[3]} ${match[4]}` : (match[3] as string),
  };
}

/** Remove credential-shaped substrings and bound the line before it leaves the controller. */
export function redactLogText(value: string, max = MAX_LINE_LENGTH): string {
  const text = value
    .replace(URL_CREDENTIALS, '$1[redacted]@')
    .replace(BEARER, '[redacted]')
    .replace(ASSIGNED_SECRET, '[redacted]')
    .replace(LONG_TOKEN, '[redacted]');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Projection line shown by the console: `<timestamp> <LEVEL> <message>`. */
export function formatProjectedLine(line: GuestLogLine): string {
  // A guest message that starts like a host line is marked, so it never counts as one.
  const message = line.message.startsWith('host:') ? `(guest) ${line.message}` : line.message;
  return redactLogText(`${line.timestamp} ${line.level} ${message}`);
}

/** Host failure line as the console shows it: `<timestamp> <LEVEL> host: <message>`. */
export function formatHostLine(line: GuestLogLine): string {
  return redactLogText(`${line.timestamp} ${line.level} host: ${line.message}`);
}

export interface WorkloadIdentity {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  /** True when the WorkloadDeployment runs a service (`spec.template.spec.service`). */
  service?: boolean;
}

/** `data.failures` entry: the newest host failure of one WorkloadDeployment. */
export interface HostFailure {
  /** Host `workload.name`, i.e. `<currentReplicaSet name>-<suffix>`. */
  workload: string;
  time: string;
  level: 'WARN' | 'ERROR';
  message: string;
}

/**
 * One ring line, the WorkloadDeployment it is attributed to, and that deployment's /v1
 * environment. `deployment` is '' for a line published before the projection recorded
 * deployments; `env` is '' for a workload outside /v1, and absent when not known.
 */
export interface RingLine {
  line: string;
  deployment: string;
  env?: string;
}

/**
 * One attributed event. `line` is what the ring shows; `failure` is set for host failure
 * lines; `start` (host workload name, no line) marks a `Starting workload` line.
 */
export interface ProjectedEntry {
  time: string;
  line?: string;
  deployment: string;
  /** /v1 environment of `deployment` ('' outside /v1). */
  env?: string;
  failure?: HostFailure;
  start?: string;
}

/** True when the WorkloadDeployment opted out of guest log projection. */
export function logsOptedOut(workload: WorkloadIdentity): boolean {
  return workload.annotations?.[LOGS_ANNOTATION] === 'false';
}

/** Console application key for a WorkloadDeployment, matching the console's grouping. */
export function applicationKey(workload: WorkloadIdentity): string {
  return workload.labels?.[WORKLOAD] ?? workload.labels?.[APPLICATION] ?? workload.name;
}

/** What a projection is keyed by: the application, and the /v1 environment ('' outside /v1). */
export interface LogKey {
  application: string;
  env: string;
}

/**
 * The projection key of a WorkloadDeployment (#106). A deployment `/v1/deploy` rendered
 * (named `<service>-<env>`, labelled with the service as application and with its env) is
 * keyed by service and env, so staging and prod never share a projection. Any other
 * workload is keyed by its console application key with no env.
 */
export function logKey(workload: WorkloadIdentity): LogKey {
  const application = workload.labels?.[APPLICATION];
  const env = workload.labels?.[ENV];
  if (application && env && ENVS.includes(env) && workload.name === `${application}-${env}`)
    return { application, env };
  return { application: applicationKey(workload), env: '' };
}

/**
 * A LogKey as one map key. `/` cannot occur in a label value or an object name, so a /v1
 * key never equals the key of another workload.
 */
export function logKeyId(key: LogKey): string {
  return key.env ? `${key.application}/${key.env}` : key.application;
}

/** The LogKey a projection ConfigMap is labelled with. */
export function configMapLogKey(configMap: Resource | undefined): LogKey {
  // Readers pass API responses as they come; tolerate one without metadata.
  const labels = configMap?.metadata?.labels;
  return { application: labels?.[APPLICATION] ?? '', env: labels?.[ENV] ?? '' };
}

/**
 * Map a host `workload.name` to its WorkloadDeployment. The operator may suffix the
 * deployment name for the running workload, so the longest `<deployment>-` prefix wins.
 */
export function resolveWorkload(
  workloadName: string,
  deployments: WorkloadIdentity[],
): WorkloadIdentity | undefined {
  let best: WorkloadIdentity | undefined;
  for (const deployment of deployments) {
    if (deployment.name === workloadName) return deployment;
    if (
      workloadName.startsWith(`${deployment.name}-`) &&
      (!best || deployment.name.length > best.name.length)
    )
      best = deployment;
  }
  return best;
}

/**
 * Attribute host log text to projections, keyed by logKeyId. Guest lines come from the TracingLogger
 * fields, host failures from the `workload_start` span fields. Lines from another
 * namespace, unknown workloads, and guest lines of an opted-out deployment are dropped.
 * Host failures are kept even then: they are platform diagnostics the console needs for
 * status, not guest output.
 *
 * Span-less service supervisor lines (`P3 service execution failed`, `max restarts
 * reached, …`) are attributed to the most recently started service workload of this
 * namespace in the same text that has not been stopped since: its `Starting workload`
 * line, inside a `workload_start` span, resolves to a WorkloadDeployment with a service.
 * Without such a start the line is dropped. The host pod serves one tenant, so this
 * cannot cross tenants; two services starting together can be confused. When a raw
 * panic `Exception { message: Some("…") }` line directly precedes the host line (no
 * host line between), the exception message replaces the tracing fields.
 */
export function attributeEntries(
  text: string,
  namespace: string,
  deployments: WorkloadIdentity[],
): Map<string, ProjectedEntry[]> {
  const result = new Map<string, ProjectedEntry[]>();
  const add = (workload: WorkloadIdentity, entry: ProjectedEntry) => {
    const logkey = logKey(workload);
    const key = logKeyId(logkey);
    result.set(key, [...(result.get(key) ?? []), { ...entry, env: logkey.env }]);
  };
  const failure = (workload: WorkloadIdentity, line: GuestLogLine) =>
    add(workload, {
      time: line.timestamp,
      line: formatHostLine(line),
      deployment: workload.name,
      failure: {
        workload: line.workloadName,
        time: line.timestamp,
        level: line.level as HostFailure['level'],
        message: redactLogText(line.message),
      },
    });
  /** Started, not yet stopped service workloads of this namespace, oldest first. */
  let running: { id: string; name: string; workload: WorkloadIdentity }[] = [];
  let exception: string | undefined;
  for (const raw of text.split('\n')) {
    const clean = cleanLine(raw);
    if (!STAMPED.test(clean)) {
      const panic = PANIC_EXCEPTION.exec(clean);
      if (panic) exception = unescapeDebug(panic[1] as string);
      continue;
    }
    const pending = exception;
    exception = undefined;
    const guest = parseGuestLogLine(raw);
    if (guest) {
      const workload =
        guest.namespace === namespace
          ? resolveWorkload(guest.workloadName, deployments)
          : undefined;
      if (workload && !logsOptedOut(workload))
        add(workload, {
          time: guest.timestamp,
          line: formatProjectedLine(guest),
          deployment: workload.name,
        });
      continue;
    }
    const span = parseWorkloadSpanLine(raw);
    if (span) {
      if (span.namespace !== namespace) continue;
      const workload = resolveWorkload(span.workloadName, deployments);
      if (!workload) continue;
      if (span.level !== 'INFO') {
        failure(workload, span);
      } else if (span.message.startsWith('Starting workload')) {
        add(workload, {
          time: span.timestamp,
          deployment: workload.name,
          start: span.workloadName,
        });
        if (workload.service) {
          running = running.filter((r) => r.id !== span.workloadId);
          running.push({ id: span.workloadId, name: span.workloadName, workload });
        }
      }
      continue;
    }
    const stop = WORKLOAD_STOP.exec(clean);
    if (stop) {
      running = running.filter((r) => r.id !== stop[1]);
      continue;
    }
    const loop = parseServiceLoopLine(raw);
    const service = running.at(-1);
    if (!loop || !service) continue;
    failure(service.workload, {
      timestamp: loop.timestamp,
      level: loop.level,
      workloadName: service.name,
      namespace,
      message: pending ? `${loop.summary}: ${pending}` : loop.message,
    });
  }
  return result;
}

/** Projected lines per projection key (logKeyId; see attributeEntries). */
export function attributeLogs(
  text: string,
  namespace: string,
  deployments: WorkloadIdentity[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [app, entries] of attributeEntries(text, namespace, deployments))
    result.set(
      app,
      entries.flatMap((entry) => (entry.line ? [entry.line] : [])),
    );
  return result;
}

/**
 * Keep the newest lines, bounded by count (and so well under the 1 MiB ConfigMap limit).
 * The newest `hostMax` host lines are kept first, guest lines fill the rest newest first,
 * and only then older host lines. `existing` is the published ring (older than
 * `incoming`, which may interleave several pods and is put in timestamp order); the
 * result keeps that order. Ring lines are kept or dropped with their deployment.
 */
export function appendRing<T extends string | RingLine>(
  existing: T[],
  incoming: T[],
  max = MAX_LINES,
  hostMax = MAX_HOST_LINES,
): T[] {
  const text = (entry: T) => (typeof entry === 'string' ? entry : entry.line);
  const stamp = (entry: T) => text(entry).split(' ')[0] as string;
  const sorted = [...incoming].sort((a, b) =>
    stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : 0,
  );
  const merged = [...existing, ...sorted];
  if (merged.length <= max) return merged;
  const keep = new Set<number>();
  const fill = (limit: number, take: (line: string) => boolean) => {
    for (let i = merged.length - 1; i >= 0 && keep.size < limit; i--)
      if (take(text(merged[i] as T))) keep.add(i);
  };
  fill(Math.min(hostMax, max), (line) => HOST_LINE.test(line));
  fill(max, (line) => !HOST_LINE.test(line));
  fill(max, () => true);
  return merged.filter((_, i) => keep.has(i));
}

/**
 * Timestamp of the newest line of a published ring ('' when empty). The ring holds lines of
 * several host pods and several passes, so its last line need not be its newest (#316).
 */
export function newestStamp(ring: readonly (string | RingLine)[]): string {
  let newest = '';
  for (const entry of ring) {
    const stamp = (typeof entry === 'string' ? entry : entry.line).split(' ')[0] as string;
    if (stamp > newest) newest = stamp;
  }
  return newest;
}

/**
 * The incoming lines the ring does not hold yet (#316). A write the API applied but reported
 * as failed (e.g. a timeout) is retried with the same lines; those are dropped here, so a retry
 * never publishes a line twice. A line is identified by its text, which starts with its
 * sub-second timestamp, and its deployment; a ring line without a recorded deployment
 * (published before deployments were recorded) matches its text alone. Once the ring is full,
 * a line older than its oldest line is dropped too: the applied write may have evicted it
 * already, and appending it again would push newer lines out.
 */
export function unpublished(
  ring: readonly RingLine[],
  incoming: readonly RingLine[],
  max = MAX_LINES,
): RingLine[] {
  const id = (entry: RingLine) => `${entry.deployment}\n${entry.line}`;
  const stamp = (entry: RingLine) => entry.line.split(' ')[0] as string;
  const published = new Set(ring.map((entry) => (entry.deployment ? id(entry) : entry.line)));
  const [first] = ring;
  let oldest = '';
  if (first && ring.length >= max)
    oldest = ring.reduce((min, entry) => (stamp(entry) < min ? stamp(entry) : min), stamp(first));
  return incoming.filter(
    (entry) => !published.has(id(entry)) && !published.has(entry.line) && stamp(entry) >= oldest,
  );
}

/** A projection ConfigMap write or delete that failed, and on how many polls in a row. */
export interface LogWriteFailure {
  count: number;
  message: string;
}

/** Polls in a row a ConfigMap write must fail before the Tenant reports it (#316). */
const LOG_WRITE_FAILURES_REPORTED = 3;

/**
 * The `LogsProjected` Tenant condition (#316): False while a projection ConfigMap has failed
 * to be written (or deleted) on LOG_WRITE_FAILURES_REPORTED polls in a row, keyed by its name.
 * Undefined otherwise, so a tenant whose logs project normally carries no extra condition.
 */
export function logWriteCondition(
  failures: ReadonlyMap<string, LogWriteFailure> | undefined,
  generation: number,
): Condition | undefined {
  const persistent = [...(failures ?? [])]
    .filter(([, failure]) => failure.count >= LOG_WRITE_FAILURES_REPORTED)
    .sort(([a], [b]) => a.localeCompare(b));
  const [first] = persistent;
  if (!first) return undefined;
  const [name, failure] = first;
  const more = persistent.length > 1 ? ` (and ${persistent.length - 1} more)` : '';
  return {
    type: 'LogsProjected',
    status: 'False',
    reason: 'WriteFailed',
    // No poll count: the message stays the same while the failure lasts, so the Tenant status
    // is not rewritten on every poll.
    message: `logs ConfigMap ${name} could not be written${more}: ${failure.message}`,
    observedGeneration: generation,
    lastTransitionTime: new Date().toISOString(),
  };
}

/** Existing projected lines from a ConfigMap, newest last. */
export function projectedLines(configMap: Resource | undefined): string[] {
  const data = configMap?.data as Record<string, unknown> | undefined;
  const lines = data?.lines;
  if (typeof lines !== 'string' || lines.length === 0) return [];
  return lines.split('\n');
}

/**
 * `data.deployments`: the WorkloadDeployment of each `data.lines` line, in order. Undefined
 * when absent, malformed, or not aligned with the lines, e.g. a ConfigMap written before
 * the projection recorded deployments.
 */
export function projectedDeployments(configMap: Resource | undefined): string[] | undefined {
  const data = configMap?.data as Record<string, unknown> | undefined;
  if (typeof data?.deployments !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.deployments);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((name) => typeof name === 'string') ||
    parsed.length !== projectedLines(configMap).length
  )
    return undefined;
  return parsed;
}

/**
 * `data.envs`: the /v1 environment of each `data.lines` line, in order ('' outside /v1).
 * Undefined when absent, malformed, or not aligned with the lines, e.g. a ConfigMap written
 * before the projection recorded environments.
 */
export function projectedEnvs(configMap: Resource | undefined): string[] | undefined {
  const data = configMap?.data as Record<string, unknown> | undefined;
  if (typeof data?.envs !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.envs);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((env) => typeof env === 'string') ||
    parsed.length !== projectedLines(configMap).length
  )
    return undefined;
  return parsed;
}

/**
 * The published ring: each line with its deployment ('' when not recorded) and env. A line
 * without a recorded env takes the env label of a per-env ConfigMap, and is otherwise left
 * without one (not known).
 */
export function projectedRing(configMap: Resource | undefined): RingLine[] {
  const deployments = projectedDeployments(configMap);
  const envs = projectedEnvs(configMap);
  const env = configMapLogKey(configMap).env;
  return projectedLines(configMap).map((line, index) => {
    const known = envs?.[index] ?? (env || undefined);
    return {
      line,
      deployment: deployments?.[index] ?? '',
      ...(known === undefined ? {} : { env: known }),
    };
  });
}

/**
 * Migration (#106): the lines and failures a new per-env projection of `deployment` takes
 * over from an older ConfigMap every env of the service shared (`di-logs-<service>`, no env
 * label). Lines without a recorded deployment cannot be told apart and are left behind.
 */
export function legacyRing(
  legacy: Resource | undefined,
  deployment: string,
  env: string,
): { lines: RingLine[]; failures: Record<string, HostFailure> } {
  const lines = projectedRing(legacy)
    .filter((entry) => entry.deployment === deployment)
    .map((entry) => ({ ...entry, env }));
  const failure = projectedFailures(legacy)[deployment];
  return { lines, failures: failure ? { [deployment]: failure } : {} };
}

/** Existing `data.failures` from a ConfigMap; malformed entries are ignored. */
export function projectedFailures(configMap: Resource | undefined): Record<string, HostFailure> {
  const data = configMap?.data as Record<string, unknown> | undefined;
  const result: Record<string, HostFailure> = {};
  if (typeof data?.failures !== 'string') return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.failures);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const failure = value as Partial<HostFailure> | null;
    if (
      typeof failure?.workload === 'string' &&
      typeof failure.time === 'string' &&
      (failure.level === 'WARN' || failure.level === 'ERROR') &&
      typeof failure.message === 'string'
    )
      result[name] = {
        workload: failure.workload,
        time: failure.time,
        level: failure.level,
        message: failure.message,
      };
  }
  return result;
}

/**
 * Newest failure per WorkloadDeployment, limited to `deployments` (the application's live
 * members), so the map stays bounded by the application size. A later WARN about the same
 * host workload (e.g. `max restarts reached`) does not replace its ERROR, which says why.
 * A `Starting workload` of a different host workload, later than the recorded failure,
 * removes it: the deployment has moved on (e.g. the host retried the same replica set).
 * Timestamps are compared, so re-reading an older start never removes a newer failure.
 */
export function mergeFailures(
  existing: Record<string, HostFailure>,
  entries: ProjectedEntry[],
  deployments: string[],
): Record<string, HostFailure> {
  const live = new Set(deployments);
  const merged: Record<string, HostFailure> = {};
  for (const [name, failure] of Object.entries(existing))
    if (live.has(name)) merged[name] = failure;
  // Several pods' reads are concatenated; apply events in time order (stable).
  for (const entry of [...entries].sort((a, b) =>
    a.time < b.time ? -1 : a.time > b.time ? 1 : 0,
  )) {
    if (!live.has(entry.deployment)) continue;
    const current = merged[entry.deployment];
    if (entry.start) {
      // A newer host workload of the deployment started after the failure: it is history.
      if (current && current.time < entry.time && current.workload !== entry.start)
        delete merged[entry.deployment];
      continue;
    }
    if (!entry.failure) continue;
    if (current && entry.failure.time <= current.time) continue;
    if (
      current?.workload === entry.failure.workload &&
      current.level === 'ERROR' &&
      entry.failure.level === 'WARN'
    )
      continue;
    merged[entry.deployment] = entry.failure;
  }
  return merged;
}

/**
 * ConfigMap name for a projection: `di-logs-<application>`, or `di-logs-<service>.<env>` for
 * a /v1 key. Long or odd applications are hashed down to a DNS label, so only a /v1 name
 * contains a dot.
 */
export function logsConfigMapName(application: string, env = ''): string {
  const suffix = env ? `.${env}` : '';
  const name = `${LOGS_PREFIX}${application}`;
  if (name.length + suffix.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name))
    return `${name}${suffix}`;
  let hash = 0;
  for (const char of application) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const safe = application
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40 - suffix.length);
  return `${LOGS_PREFIX}${safe || 'app'}-${hash.toString(16)}${suffix}`;
}

/** Label values must be ≤63 characters of the label alphabet; skip anything else. */
export function validLabelValue(value: string): boolean {
  return value.length <= 63 && /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/.test(value);
}

export function logsConfigMap(
  tenantName: string,
  namespace: string,
  installation: string,
  application: string,
  lines: (string | RingLine)[],
  failures: Record<string, HostFailure> = {},
  env = '',
): Resource {
  const ring: RingLine[] = lines.map((entry) =>
    typeof entry === 'string' ? { line: entry, deployment: '' } : entry,
  );
  const data: Record<string, string> = { lines: ring.map((entry) => entry.line).join('\n') };
  // Written only when a line is attributed, so a ring of unattributed lines stays as before.
  // The envs go with the deployments, so a reader can tell '' (outside /v1) from not known.
  if (ring.some((entry) => entry.deployment)) {
    data.deployments = JSON.stringify(ring.map((entry) => entry.deployment));
    data.envs = JSON.stringify(ring.map((entry) => entry.env ?? env));
  }
  if (Object.keys(failures).length > 0) data.failures = JSON.stringify(failures);
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: logsConfigMapName(application, env),
      namespace,
      labels: {
        [INSTALLATION]: installation,
        [TENANT]: tenantName,
        [PROJECTION]: 'logs',
        [APPLICATION]: application,
        ...(env ? { [ENV]: env } : {}),
      },
    },
    data,
  };
}

export {
  APPLICATION,
  ENV,
  ENVS,
  HOST_LINE,
  LOG_WRITE_FAILURES_REPORTED,
  LOGS_ANNOTATION,
  LOGS_PREFIX,
  MANAGED_BY,
  MANAGED_BY_VALUE,
  MANAGED_SELECTOR,
  MAX_HOST_LINES,
  MAX_LINE_LENGTH,
  MAX_LINES,
  PROJECTION,
  WORKLOAD,
};
