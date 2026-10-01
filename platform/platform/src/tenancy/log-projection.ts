import { INSTALLATION, type Resource, TENANT } from './resources';

/**
 * Tenant console log projection (#10).
 *
 * The controller tails the tenant hostgroup pods and keeps only lines the wash 2.8
 * `wasi:logging` TracingLogger emitted. Each of those ends with
 * `workload.component_id="…" workload.name="…" workload.namespace="…" context="…"`.
 * Guest stdio reaches the pod log as raw bytes with no attribution, and one host pod
 * runs every workload in the hostgroup, so every other line is dropped.
 */

/** Label the console selects on; `logs` is the only projection the platform writes. */
const PROJECTION = 'di-framework.dev/projection';
/** Console application name the projection belongs to. */
const APPLICATION = 'di-framework.dev/application';
/** Multi-member workload grouping set by the CLI on WorkloadDeployments. */
const WORKLOAD = 'di-framework.dev/workload';
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

/** Parse one host pod log line. Returns undefined for anything the platform cannot attribute. */
export function parseGuestLogLine(raw: string): GuestLogLine | undefined {
  const line = raw.replace(ANSI, '').replace(/\r$/, '');
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

export interface WorkloadIdentity {
  name: string;
  labels?: Record<string, string>;
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
 * Attribute host log text to console applications. Lines from another namespace,
 * unknown workloads, or without the TracingLogger fields are dropped.
 */
export function attributeLogs(
  text: string,
  namespace: string,
  deployments: WorkloadIdentity[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const raw of text.split('\n')) {
    const line = parseGuestLogLine(raw);
    if (!line || line.namespace !== namespace) continue;
    const workload = resolveWorkload(line.workloadName, deployments);
    if (!workload) continue;
    const key = applicationKey(workload);
    const lines = result.get(key) ?? [];
    lines.push(formatProjectedLine(line));
    result.set(key, lines);
  }
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
): Resource {
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
    data: { lines: lines.join('\n') },
  };
}

export { APPLICATION, LOGS_PREFIX, MAX_LINE_LENGTH, MAX_LINES, PROJECTION, WORKLOAD };
