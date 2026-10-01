import { INSTALLATION, type Resource, TENANT } from './resources';

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
 */

/** Label the console selects on; `logs` is the only projection the platform writes. */
const PROJECTION = 'di-framework.dev/projection';
/** Console application name the projection belongs to. */
const APPLICATION = 'di-framework.dev/application';
/** Multi-member workload grouping set by the CLI on WorkloadDeployments. */
const WORKLOAD = 'di-framework.dev/workload';
/** WorkloadDeployment annotation; `"false"` opts out of guest (`wasi:logging`) lines. */
const LOGS_ANNOTATION = 'di-framework.dev/logs';
const LOGS_PREFIX = 'di-logs-';
/** The console shows at most 200 lines of 500 characters; stay at that bound. */
const MAX_LINES = 200;
const MAX_LINE_LENGTH = 500;

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
const FAILURE_HEAD = /^(\S+)\s+(WARN|ERROR)\s+((?:[\w.-]+\{(?:[^}"]|"(?:[^"\\]|\\.)*")*\}:)+) /;
const SPAN = /([\w.-]+)\{((?:[^}"]|"(?:[^"\\]|\\.)*")*)\}:/y;
/** One `key=value` span field; values are Debug-quoted strings or bare tokens. */
const SPAN_FIELD = / ?([\w.]+)=(?:"((?:[^"\\]|\\.)*)"|([^\s"]*))/y;
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
  return value.replace(/\\(.)/g, '$1');
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

/**
 * Parse a host WARN/ERROR line emitted inside a `workload_start` span. The outermost span
 * must be `workload_start` with both `workload.name` and `workload.namespace`; nested spans
 * that repeat them must agree. TracingLogger (guest) lines are never host failures.
 */
export function parseHostFailureLine(raw: string): GuestLogLine | undefined {
  const line = cleanLine(raw);
  if (TRACING_TAIL.test(line)) return undefined;
  const head = FAILURE_HEAD.exec(line);
  if (!head) return undefined;
  const chain = head[3] as string;
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
  return redactLogText(`${line.timestamp} ${line.level} ${line.message}`);
}

/** Host failure line as the console shows it: `<timestamp> <LEVEL> host: <message>`. */
export function formatHostLine(line: GuestLogLine): string {
  return redactLogText(`${line.timestamp} ${line.level} host: ${line.message}`);
}

export interface WorkloadIdentity {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/** `data.failures` entry: the newest host failure of one WorkloadDeployment. */
export interface HostFailure {
  /** Host `workload.name`, i.e. `<currentReplicaSet name>-<suffix>`. */
  workload: string;
  time: string;
  level: 'WARN' | 'ERROR';
  message: string;
}

/** One projected line; `failure` is set for host failure lines. */
export interface ProjectedEntry {
  time: string;
  line: string;
  deployment: string;
  failure?: HostFailure;
}

/** True when the WorkloadDeployment opted out of guest log projection. */
export function logsOptedOut(workload: WorkloadIdentity): boolean {
  return workload.annotations?.[LOGS_ANNOTATION] === 'false';
}

/** Console application key for a WorkloadDeployment, matching the console's grouping. */
export function applicationKey(workload: WorkloadIdentity): string {
  return workload.labels?.[WORKLOAD] ?? workload.labels?.[APPLICATION] ?? workload.name;
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
 * Attribute host log text to console applications. Guest lines come from the TracingLogger
 * fields, host failures from the `workload_start` span fields. Lines from another
 * namespace, unknown workloads, and guest lines of an opted-out deployment are dropped.
 * Host failures are kept even then: they are platform diagnostics the console needs for
 * status, not guest output.
 */
export function attributeEntries(
  text: string,
  namespace: string,
  deployments: WorkloadIdentity[],
): Map<string, ProjectedEntry[]> {
  const result = new Map<string, ProjectedEntry[]>();
  for (const raw of text.split('\n')) {
    const guest = parseGuestLogLine(raw);
    const line = guest ?? parseHostFailureLine(raw);
    if (!line || line.namespace !== namespace) continue;
    const workload = resolveWorkload(line.workloadName, deployments);
    if (!workload || (guest && logsOptedOut(workload))) continue;
    const entry: ProjectedEntry = guest
      ? { time: line.timestamp, line: formatProjectedLine(line), deployment: workload.name }
      : {
          time: line.timestamp,
          line: formatHostLine(line),
          deployment: workload.name,
          failure: {
            workload: line.workloadName,
            time: line.timestamp,
            level: line.level as HostFailure['level'],
            message: redactLogText(line.message),
          },
        };
    const key = applicationKey(workload);
    result.set(key, [...(result.get(key) ?? []), entry]);
  }
  return result;
}

/** Projected lines per console application (see attributeEntries). */
export function attributeLogs(
  text: string,
  namespace: string,
  deployments: WorkloadIdentity[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [app, entries] of attributeEntries(text, namespace, deployments))
    result.set(
      app,
      entries.map((entry) => entry.line),
    );
  return result;
}

/** Keep the newest lines, bounded by count (and so well under the 1 MiB ConfigMap limit). */
export function appendRing(existing: string[], incoming: string[], max = MAX_LINES): string[] {
  const merged = [...existing, ...incoming];
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/** Existing projected lines from a ConfigMap, newest last. */
export function projectedLines(configMap: Resource | undefined): string[] {
  const data = configMap?.data as Record<string, unknown> | undefined;
  const lines = data?.lines;
  if (typeof lines !== 'string' || lines.length === 0) return [];
  return lines.split('\n');
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
 * members), so the map stays bounded by the application size.
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
  for (const entry of entries) {
    if (!entry.failure || !live.has(entry.deployment)) continue;
    const current = merged[entry.deployment];
    if (!current || entry.failure.time > current.time) merged[entry.deployment] = entry.failure;
  }
  return merged;
}

/** ConfigMap name for an application; long or odd keys are hashed down to a DNS name. */
export function logsConfigMapName(application: string): string {
  const name = `${LOGS_PREFIX}${application}`;
  if (name.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) return name;
  let hash = 0;
  for (const char of application) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const safe = application
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${LOGS_PREFIX}${safe || 'app'}-${hash.toString(16)}`;
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
  lines: string[],
  failures: Record<string, HostFailure> = {},
): Resource {
  const data: Record<string, string> = { lines: lines.join('\n') };
  if (Object.keys(failures).length > 0) data.failures = JSON.stringify(failures);
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: logsConfigMapName(application),
      namespace,
      labels: {
        [INSTALLATION]: installation,
        [TENANT]: tenantName,
        [PROJECTION]: 'logs',
        [APPLICATION]: application,
      },
    },
    data,
  };
}

export {
  APPLICATION,
  LOGS_ANNOTATION,
  LOGS_PREFIX,
  MAX_LINE_LENGTH,
  MAX_LINES,
  PROJECTION,
  WORKLOAD,
};
