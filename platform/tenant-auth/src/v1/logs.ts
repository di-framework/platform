import type { HttpCall } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
// Imported across packages on purpose (platform#54): the controller reads the ConfigMaps the
// platform's log projection writes, so it shares that module's format instead of copying it.
import {
  APPLICATION,
  ENV,
  ENVS,
  PROJECTION,
  projectedDeployments,
  projectedEnvs,
  projectedFailures,
  projectedLines,
  validLabelValue,
} from '../../../platform/src/tenancy/log-projection.ts';
import type { UserKube } from '../kube.ts';
import type { V1Context, V1Module } from './context.ts';

/** One line of a service log, as the contract's LogEvent describes it. */
export interface LogEvent {
  timestamp: string;
  deployment: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/**
 * A LogEvent and the /v1 environment of its line: '' for a workload outside /v1, absent when
 * the ConfigMap does not tell (lines published before deployments were recorded).
 */
export interface ProjectedLogEvent extends LogEvent {
  env?: string;
}

interface LogsConfigMap {
  metadata: { labels?: Record<string, string>; resourceVersion?: string };
  data?: Record<string, string>;
}
interface ConfigMapList {
  metadata?: { resourceVersion?: string };
  items?: LogsConfigMap[];
}
interface WatchEvent {
  type: string;
  object?: LogsConfigMap & { metadata?: { resourceVersion?: string }; code?: number };
}

/**
 * Stream timing. The heartbeat keeps gateways from closing an idle `--follow` stream. A watch
 * that closes without delivering an event is retried after a bounded exponential backoff, so a
 * misbehaving API server cannot make the controller hammer it as the user.
 */
export const timing = {
  heartbeatMs: 15_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  /** Bytes the SSE queue holds before it reports backpressure (`desiredSize <= 0`). */
  queueBytes: 1 << 20,
  /** Bytes queued for a client that stopped reading before the stream is ended. */
  queueLimitBytes: 4 << 20,
};

const DEFAULT_TAIL = 100;
const LEVELS: Record<string, LogEvent['level']> = {
  TRACE: 'debug',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};
/** A projected line: `<timestamp> <LEVEL> <message>` (formatProjectedLine, formatHostLine). */
const LINE = /^(\S+) (TRACE|DEBUG|INFO|WARN|ERROR) (.*)$/s;
const DURATION = /^(\d+)(s|m|h|d)$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `since` as an RFC 3339 lower bound: a duration such as `10m`, or a timestamp. */
function sinceBound(since: string | undefined, now = Date.now()): string | undefined | null {
  if (!since) return undefined;
  const duration = DURATION.exec(since);
  if (duration)
    return new Date(
      now - Number(duration[1]) * (UNIT_MS[duration[2] as string] as number),
    ).toISOString();
  const time = RFC3339.test(since) ? Date.parse(since) : Number.NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * The /v1 environment of a line whose ConfigMap recorded no `data.envs` (#106): the env label
 * of a per-env ConfigMap; in a ConfigMap staging and prod shared before, the env of the
 * recorded deployment `<service>-<env>` ('' for any other deployment); otherwise not known.
 */
function legacyEnv(
  label: string | undefined,
  application: string,
  deployment: string | undefined,
): string | undefined {
  if (label) return label;
  if (!deployment) return undefined;
  return ENVS.find((env) => deployment === `${application}-${env}`) ?? '';
}

/**
 * The /v1 deployment (`<service>-<env>`) whose lines a per-env logs ConfigMap holds (#106), or
 * undefined for any other projection.
 */
function perEnvDeployment(configMap: LogsConfigMap): string | undefined {
  const env = configMap.metadata.labels?.[ENV];
  const application = configMap.metadata.labels?.[APPLICATION];
  return env && application && ENVS.includes(env) ? `${application}-${env}` : undefined;
}

/**
 * The LogEvents of one logs ConfigMap, oldest first. A line is attributed to the
 * WorkloadDeployment the projection recorded for it (`data.deployments`). A line without one,
 * written before the projection recorded deployments, falls back to the deployment whose
 * newest host failure it reports (`data.failures`), and otherwise to the application. Its env
 * is the one recorded in `data.envs`, else derived as legacyEnv describes.
 *
 * `moved` names /v1 deployments that have their own per-env ConfigMap. In a ConfigMap without
 * an env label (one staging and prod shared before #106), lines recorded for those are
 * skipped: the projection copied them into the per-env ConfigMap before it publishes anything
 * there, so serving them here too would repeat them while the migration is incomplete (#316).
 */
export function logEvents(
  configMap: LogsConfigMap,
  moved: ReadonlySet<string> = new Set(),
): ProjectedLogEvent[] {
  const application = configMap.metadata.labels?.[APPLICATION] ?? '';
  const label = configMap.metadata.labels?.[ENV];
  const deployments = projectedDeployments(configMap as never);
  const envs = projectedEnvs(configMap as never);
  const failures = Object.entries(projectedFailures(configMap as never));
  const failed = (timestamp: string, message: string) =>
    failures.find(([, f]) => f.time === timestamp && message === `host: ${f.message}`)?.[0];
  const events: ProjectedLogEvent[] = [];
  for (const [index, line] of projectedLines(configMap as never).entries()) {
    if (!label && moved.has(deployments?.[index] ?? '')) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const [, timestamp, level, message] = match as unknown as [string, string, string, string];
    const env = envs?.[index] ?? legacyEnv(label, application, deployments?.[index]);
    events.push({
      timestamp,
      deployment: deployments?.[index] || failed(timestamp, message) || application,
      level: LEVELS[level],
      message,
      ...(env === undefined ? {} : { env }),
    });
  }
  return events;
}

/** The event as the contract's LogEvent, without the env it was selected by. */
const contractEvent = ({ env: _env, ...event }: ProjectedLogEvent): LogEvent => event;

const sse = (event: string, data?: unknown) =>
  `event: ${event}\ndata: ${data === undefined ? '' : JSON.stringify(data)}\n\n`;

interface Options {
  /** prod or staging. */
  env: string;
  deployment?: string;
  since?: string;
  tail: number;
}

/**
 * Lines of a /v1 deployment in the requested env. A line of a workload outside /v1 (env '')
 * is never served; a line whose env is not known (published before deployments were
 * recorded) is served in every env, as before.
 */
const inEnv = (event: ProjectedLogEvent, env: string) =>
  event.env === undefined || event.env === env;

/** Applies the env, deployment and since filters, then keeps the newest `tail` events. */
function select(events: ProjectedLogEvent[], options: Options): ProjectedLogEvent[] {
  const kept = events.filter(
    (event) =>
      inEnv(event, options.env) &&
      (!options.deployment || event.deployment === options.deployment) &&
      (!options.since || Date.parse(event.timestamp) >= Date.parse(options.since)),
  );
  return options.tail === 0 ? [] : kept.slice(-options.tail);
}

/**
 * Remembers what the stream already sent, so a ConfigMap update only yields its new lines.
 * The ring is ordered by time; a line is new when it is newer than the newest one sent, or as
 * new and not sent yet.
 */
class Cursor {
  private newest = '';
  private atNewest = new Set<string>();

  fresh(events: ProjectedLogEvent[]): ProjectedLogEvent[] {
    return events.filter((event) => {
      const key = JSON.stringify(event);
      if (event.timestamp < this.newest) return false;
      if (event.timestamp === this.newest) return !this.atNewest.has(key);
      return true;
    });
  }

  sent(event: ProjectedLogEvent): void {
    if (event.timestamp > this.newest) {
      this.newest = event.timestamp;
      this.atNewest = new Set();
    }
    this.atNewest.add(JSON.stringify(event));
  }
}

/** Reads newline-delimited watch events until the body ends or the signal aborts. */
async function* watchEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<WatchEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as WatchEvent;
        newline = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Watch event types that show the watch is alive and advancing. */
const PROGRESS = new Set(['ADDED', 'MODIFIED', 'DELETED', 'BOOKMARK']);

const byTime = (a: ProjectedLogEvent, b: ProjectedLogEvent) =>
  a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;

/** The /v1 deployments with their own per-env ConfigMap among `configMaps` (see logEvents). */
const movedDeployments = (configMaps: readonly LogsConfigMap[]) =>
  new Set(configMaps.flatMap((configMap) => perEnvDeployment(configMap) ?? []));

/** The LogEvents of a list of the service's logs ConfigMaps, each line once, oldest first. */
export function listEvents(list: ConfigMapList): ProjectedLogEvent[] {
  const items = list.items ?? [];
  const moved = movedDeployments(items);
  return items.flatMap((configMap) => logEvents(configMap, moved)).sort(byTime);
}

/** Resolves after `ms`, or as soon as the signal aborts. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

function stream(
  kube: UserKube,
  collection: string,
  selector: string,
  first: ConfigMapList,
  options: Options,
  follow: boolean,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(heartbeat);
    abort.abort();
  };
  let closed = false;
  return new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        /**
         * Queues `text` for the client. A client that stops reading lets the queue grow; past
         * `queueLimitBytes` the watch is stopped and the stream closed, so memory stays bounded.
         */
        const send = (text: string) => {
          if (closed) return;
          controller.enqueue(encoder.encode(text));
          if ((controller.desiredSize ?? 0) <= timing.queueBytes - timing.queueLimitBytes) {
            closed = true;
            stop();
            controller.close();
          }
        };
        // Flushes the headers at once, even when the backlog is empty.
        send(': connected\n\n');
        const cursor = new Cursor();
        const live = { ...options, tail: Number.MAX_SAFE_INTEGER };
        /** Sends the selected events, then marks every event seen, sent or filtered out. */
        const deliver = (events: ProjectedLogEvent[], selected: ProjectedLogEvent[]) => {
          for (const event of selected) send(sse('log', contractEvent(event)));
          for (const event of events) cursor.sent(event);
        };
        /** /v1 deployments with a per-env ConfigMap, kept current from the watch (logEvents). */
        let moved = movedDeployments(first.items ?? []);
        const backlog = listEvents(first);
        deliver(backlog, select(backlog, options));
        if (!follow) {
          send(sse('end'));
          if (closed) return;
          closed = true;
          controller.close();
          return;
        }
        heartbeat = setInterval(() => {
          // A full queue already proves the stream is open; do not grow it further.
          if ((controller.desiredSize ?? 0) > 0) send(': heartbeat\n\n');
        }, timing.heartbeatMs);
        let resourceVersion = first.metadata?.resourceVersion ?? '';
        /** The watch expired (410): relist, send what is new, resume from the list's version. */
        const relist = async () => {
          const list = await kube.call<ConfigMapList>(
            'GET',
            `${collection}?labelSelector=${encodeURIComponent(selector)}`,
          );
          moved = movedDeployments(list.items ?? []);
          const fresh = cursor.fresh(listEvents(list));
          deliver(fresh, select(fresh, live));
          resourceVersion = list.metadata?.resourceVersion ?? '';
        };
        let idle = 0;
        try {
          while (!abort.signal.aborted) {
            const response = await kube.fetch(
              'GET',
              `${collection}?watch=true&allowWatchBookmarks=true&labelSelector=${encodeURIComponent(selector)}&resourceVersion=${encodeURIComponent(resourceVersion)}`,
              { headers: { Accept: 'application/json' }, signal: abort.signal },
            );
            // Only real events count as progress: a relist after a 410 does not, so a server that
            // keeps expiring watches at the same resourceVersion is retried with backoff.
            let delivered = false;
            let ended = false;
            if (response.status === 410) {
              await response.body?.cancel();
              await relist();
              if (abort.signal.aborted) break;
            } else if (!response.ok || !response.body) {
              await response.body?.cancel();
              break;
            } else {
              for await (const event of watchEvents(response.body)) {
                if (event.type === 'ERROR') {
                  if (event.object?.code === 410) await relist();
                  else ended = true;
                  break;
                }
                if (PROGRESS.has(event.type)) delivered = true;
                if (event.object?.metadata?.resourceVersion)
                  resourceVersion = event.object.metadata.resourceVersion;
                const object = event.object as LogsConfigMap | undefined;
                const deployment = object?.metadata ? perEnvDeployment(object) : undefined;
                if (event.type === 'ADDED' || event.type === 'MODIFIED') {
                  if (deployment) moved.add(deployment);
                  const fresh = cursor.fresh(logEvents(object as LogsConfigMap, moved));
                  deliver(fresh, select(fresh, live));
                } else if (event.type === 'DELETED' && deployment) moved.delete(deployment);
              }
            }
            if (ended || abort.signal.aborted) break;
            if (delivered) idle = 0;
            else {
              await sleep(
                Math.min(timing.backoffMaxMs, timing.backoffBaseMs * 2 ** idle),
                abort.signal,
              );
              idle = Math.min(idle + 1, 30);
            }
          }
        } catch {
          // The client went away (the watch was aborted) or the API server dropped the watch.
        }
        if (abort.signal.aborted || closed) return;
        stop();
        send(sse('end'));
        if (closed) return;
        closed = true;
        controller.close();
      },
      cancel: stop,
    },
    new ByteLengthQueuingStrategy({ highWaterMark: timing.queueBytes }),
  );
}

/**
 * `GET /v1/services/:service/logs` (platform#54): the `logs` projection as server-sent events.
 * The service's projections are selected by application; `env` keeps the lines of that
 * environment (#106), read from `data.envs`, the per-env ConfigMap's env label, or, in a
 * ConfigMap staging and prod shared before, the recorded deployment. Lines of a workload
 * outside /v1 that shares the service's application name are never served. While the shared
 * ConfigMap is being migrated, its lines of a deployment that already has a per-env ConfigMap
 * are skipped, so no line is served twice (#316). The `deployment` filter matches the
 * WorkloadDeployment each line is attributed to (see logEvents).
 */
async function serveLogs(_command: unknown, call: HttpCall, context: V1Context): Promise<Response> {
  const service = call.request.params?.service ?? '';
  const query = call.request.query ?? {};
  const value = (name: string) => {
    const raw = query[name];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const since = sinceBound(value('since'));
  if (since === null)
    return problem(400, 'Bad Request', 'since must be a duration such as 10m or an RFC 3339 time');
  const env = value('env');
  if (env === undefined || !ENVS.includes(env))
    return problem(400, 'Bad Request', `env must be one of ${ENVS.join(', ')}`);
  const tailText = value('tail');
  const tail = tailText === undefined ? DEFAULT_TAIL : Number(tailText);
  if (!Number.isInteger(tail) || tail < 0)
    return problem(400, 'Bad Request', 'tail must be a non-negative integer');
  if (!validLabelValue(service))
    return problem(404, 'Not Found', `service ${service} has no published logs`);
  const kube = context.asUser();
  const collection = `/api/v1/namespaces/di-tenant-${context.tenant}/configmaps`;
  const selector = `${PROJECTION}=logs,${APPLICATION}=${service}`;
  const first = await kube.call<ConfigMapList>(
    'GET',
    `${collection}?labelSelector=${encodeURIComponent(selector)}`,
  );
  if (!first.items?.length)
    return problem(404, 'Not Found', `service ${service} has no published logs`);
  const options: Options = { env, deployment: value('deployment'), since, tail };
  return new Response(
    stream(kube, collection, selector, first, options, value('follow') === 'true'),
    {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      },
    },
  );
}

/** `/v1/services/:service/logs` (platform#54). */
export const logs: V1Module = {
  logs: serveLogs,
};
