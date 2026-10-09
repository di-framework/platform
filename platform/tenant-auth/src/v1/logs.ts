import type { HttpCall } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
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
  object?: LogsConfigMap & { metadata?: { resourceVersion?: string } };
}

/** Stream timing. The heartbeat keeps gateways from closing an idle `--follow` stream. */
export const timing = { heartbeatMs: 15_000 };

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
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `since` as an RFC 3339 lower bound: a duration such as `10m`, or a timestamp. */
function sinceBound(since: string | undefined, now = Date.now()): string | undefined | null {
  if (!since) return undefined;
  const duration = DURATION.exec(since);
  if (duration)
    return new Date(
      now - Number(duration[1]) * (UNIT_MS[duration[2] as string] as number),
    ).toISOString();
  const time = Date.parse(since);
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
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      const cursor = new Cursor();
      const emit = (events: LogEvent[]) => {
        for (const event of events) {
          cursor.sent(event);
          send(sse('log', event));
        }
      };
      const backlog = (first.items ?? []).flatMap(logEvents);
      backlog.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      emit(select(backlog, options));
      if (!follow) {
        send(sse('end'));
        controller.close();
        return;
      }
      heartbeat = setInterval(() => send(': heartbeat\n\n'), timing.heartbeatMs);
      const live = { ...options, tail: Number.MAX_SAFE_INTEGER };
      let resourceVersion = first.metadata?.resourceVersion ?? '';
      try {
        while (!abort.signal.aborted) {
          const response = await kube.fetch(
            'GET',
            `${collection}?watch=true&allowWatchBookmarks=true&labelSelector=${encodeURIComponent(selector)}&resourceVersion=${encodeURIComponent(resourceVersion)}`,
            { headers: { Accept: 'application/json' }, signal: abort.signal },
          );
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            break;
          }
          for await (const event of watchEvents(response.body)) {
            if (event.object?.metadata?.resourceVersion)
              resourceVersion = event.object.metadata.resourceVersion;
            if (event.type === 'ADDED' || event.type === 'MODIFIED')
              emit(select(cursor.fresh(logEvents(event.object as LogsConfigMap)), live));
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
    cancel: stop,
  });
}

/** `GET /v1/services/:service/logs` (platform#54): the `logs` projection as server-sent events. */
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
