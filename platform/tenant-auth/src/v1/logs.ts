import type { HttpCall } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
// Imported across packages on purpose (platform#54): the controller reads the ConfigMaps the
// platform's log projection writes, so it shares that module's format instead of copying it.
import {
  APPLICATION,
  PROJECTION,
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
export const timing = { heartbeatMs: 15_000, backoffBaseMs: 1_000, backoffMaxMs: 30_000 };

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
 * The LogEvents of one logs ConfigMap, oldest first. A line is attributed to the
 * WorkloadDeployment of the host failure it reports (`data.failures`); every other line to the
 * application, since the projection keeps one ring per application.
 */
export function logEvents(configMap: LogsConfigMap): LogEvent[] {
  const application = configMap.metadata.labels?.[APPLICATION] ?? '';
  const failures = Object.entries(projectedFailures(configMap as never));
  const events: LogEvent[] = [];
  for (const line of projectedLines(configMap as never)) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, timestamp, level, message] = match as unknown as [string, string, string, string];
    const failure = failures.find(
      ([, f]) => f.time === timestamp && message === `host: ${f.message}`,
    );
    events.push({
      timestamp,
      deployment: failure ? failure[0] : application,
      level: LEVELS[level],
      message,
    });
  }
  return events;
}

const sse = (event: string, data?: unknown) =>
  `event: ${event}\ndata: ${data === undefined ? '' : JSON.stringify(data)}\n\n`;

interface Options {
  deployment?: string;
  since?: string;
  tail: number;
}

/** Applies the deployment and since filters, then keeps the newest `tail` events. */
function select(events: LogEvent[], options: Options): LogEvent[] {
  const kept = events.filter(
    (event) =>
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

  fresh(events: LogEvent[]): LogEvent[] {
    return events.filter((event) => {
      const key = JSON.stringify(event);
      if (event.timestamp < this.newest) return false;
      if (event.timestamp === this.newest) return !this.atNewest.has(key);
      return true;
    });
  }

  sent(event: LogEvent): void {
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

const byTime = (a: LogEvent, b: LogEvent) =>
  a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;

const listEvents = (list: ConfigMapList) => (list.items ?? []).flatMap(logEvents).sort(byTime);

/** Resolves after `ms`, or as soon as the signal aborts. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
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
  let demand: (() => void) | undefined;
  const stop = () => {
    clearInterval(heartbeat);
    abort.abort();
    demand?.();
  };
  return new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const send = (text: string) => controller.enqueue(encoder.encode(text));
        // Flushes the headers at once, even when the backlog is empty.
        send(': connected\n\n');
        const cursor = new Cursor();
        const live = { ...options, tail: Number.MAX_SAFE_INTEGER };
        /** Sends the selected events, then marks every event seen, sent or filtered out. */
        const deliver = (events: LogEvent[], selected: LogEvent[]) => {
          for (const event of selected) send(sse('log', event));
          for (const event of events) cursor.sent(event);
        };
        const backlog = listEvents(first);
        deliver(backlog, select(backlog, options));
        if (!follow) {
          send(sse('end'));
          controller.close();
          return;
        }
        heartbeat = setInterval(() => send(': heartbeat\n\n'), timing.heartbeatMs);
        let resourceVersion = first.metadata?.resourceVersion ?? '';
        /** The watch expired (410): relist, send what is new, resume from the list's version. */
        const relist = async () => {
          const list = await kube.call<ConfigMapList>(
            'GET',
            `${collection}?labelSelector=${encodeURIComponent(selector)}`,
          );
          const fresh = cursor.fresh(listEvents(list));
          deliver(fresh, select(fresh, live));
          resourceVersion = list.metadata?.resourceVersion ?? '';
        };
        /** Backpressure: stops reading the watch while the client is not reading the stream. */
        const drained = async () => {
          while ((controller.desiredSize ?? 1) <= 0 && !abort.signal.aborted)
            await new Promise<void>((resolve) => {
              demand = resolve;
            });
        };
        let idle = 0;
        try {
          while (!abort.signal.aborted) {
            const response = await kube.fetch(
              'GET',
              `${collection}?watch=true&allowWatchBookmarks=true&labelSelector=${encodeURIComponent(selector)}&resourceVersion=${encodeURIComponent(resourceVersion)}`,
              { headers: { Accept: 'application/json' }, signal: abort.signal },
            );
            let delivered = false;
            let ended = false;
            if (response.status === 410) {
              await response.body?.cancel();
              await relist();
              delivered = true;
            } else if (!response.ok || !response.body) {
              await response.body?.cancel();
              break;
            } else {
              for await (const event of watchEvents(response.body)) {
                delivered = true;
                if (event.type === 'ERROR') {
                  if (event.object?.code === 410) await relist();
                  else ended = true;
                  break;
                }
                if (event.object?.metadata?.resourceVersion)
                  resourceVersion = event.object.metadata.resourceVersion;
                if (event.type === 'ADDED' || event.type === 'MODIFIED') {
                  const fresh = cursor.fresh(logEvents(event.object as LogsConfigMap));
                  deliver(fresh, select(fresh, live));
                }
                await drained();
              }
            }
            if (ended) break;
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
        if (abort.signal.aborted) return;
        stop();
        send(sse('end'));
        controller.close();
      },
      pull() {
        demand?.();
      },
      cancel: stop,
    },
    // Room for a burst of events and heartbeats before the watch stops being read.
    { highWaterMark: 256 },
  );
}

/**
 * `GET /v1/services/:service/logs` (platform#54): the `logs` projection as server-sent events.
 * `env` is accepted and ignored: the log ConfigMaps carry no environment label. The `deployment`
 * filter only sees lines attributed through `data.failures`, which keeps the newest host failure
 * per deployment, so older failure lines of a deployment are attributed to the application.
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
  const options: Options = { deployment: value('deployment'), since, tail };
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
