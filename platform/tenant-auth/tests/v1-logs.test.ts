import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { events } from '@di-framework/tenant-cli/client';
import { Controller, configFromEnv } from '../src/controller.ts';
import type { Principal } from '../src/identity.ts';
import { KubeClient } from '../src/kube.ts';
import { logEvents, timing } from '../src/v1/logs.ts';
import { type FakeServer, json, type Recorded, serve } from './support/servers.ts';

const configMap = (application: string, lines: string[], failures?: unknown, rv = '1') => ({
  metadata: {
    name: `di-logs-${application}`,
    resourceVersion: rv,
    labels: {
      'di-framework.dev/projection': 'logs',
      'di-framework.dev/application': application,
    },
  },
  data: {
    lines: lines.join('\n'),
    ...(failures ? { failures: JSON.stringify(failures) } : {}),
  },
});

const WEB = configMap(
  'web',
  [
    '2020-01-01T10:00:00Z INFO first',
    '2020-01-01T10:01:00Z DEBUG second',
    'not a projected line',
    '2020-01-01T10:02:00Z ERROR host: boom',
    '2020-01-01T10:03:00Z WARN fourth',
  ],
  {
    'web-v2': {
      workload: 'web-v2-abc',
      time: '2020-01-01T10:02:00Z',
      level: 'ERROR',
      message: 'boom',
    },
  },
  '41',
);

/** A watch the test feeds by hand; `closed` resolves when the controller drops the connection. */
interface Watch {
  path: string;
  push(event: unknown): void;
  end(): void;
  closed: Promise<void>;
}

describe('GET /v1/services/:service/logs', () => {
  let watches: Watch[] = [];
  let watchStatus = 200;
  let watchStatuses: number[] = [];
  let listed: unknown;
  let lists = 0;
  let onWatch: (() => void) | undefined;
  /** Awaited before answering every list after the first (a relist). */
  let onRelist: (() => Promise<void>) | undefined;
  /** Bumped after every test: a fake API answers 503 once it is no longer current. */
  let generation = 0;
  const handler = (mine: number) => async (request: Recorded) => {
    if (mine !== generation) return json({ message: 'stale test server' }, 503);
    if (request.pathname.endsWith('/serviceaccounts/di-user-alice/token'))
      return json({
        status: {
          token: 'sa-alice',
          expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    const url = new URL(`http://x${request.path}`);
    if (request.pathname !== '/api/v1/namespaces/di-tenant-acme/configmaps')
      return json({ message: 'not found' }, 404);
    if (url.searchParams.get('watch') === 'true') {
      const status = watchStatuses.shift() ?? watchStatus;
      if (status !== 200) return json({ message: 'gone' }, status);
      let control!: ReadableStreamDefaultController<Uint8Array>;
      let closed!: () => void;
      const watch: Watch = {
        path: request.path,
        push: (event) => control.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)),
        end: () => control.close(),
        closed: new Promise((resolve) => {
          closed = resolve;
        }),
      };
      watches.push(watch);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          control = c;
        },
        cancel() {
          closed();
        },
      });
      queueMicrotask(() => onWatch?.());
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    }
    const selector = url.searchParams.get('labelSelector') ?? '';
    const items = selector.endsWith('application=web') ? [WEB] : [];
    lists++;
    if (lists > 1 && onRelist) await onRelist();
    return json(listed ?? { metadata: { resourceVersion: '42' }, items });
  };
  const viewer: Principal = {
    user: 'alice',
    account: 'acme',
    role: 'viewer',
    via: 'identity',
    credentialId: 's',
  };
  // A fresh fake API, client, controller and server per test, so a previous test's follow loop
  // can never reach the next test's state.
  let api: FakeServer;
  let controller: Controller;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  beforeEach(() => {
    api = serve(handler(generation));
    const kube = new KubeClient({ server: api.url, token: 'admin' }, 'wasmcloud');
    controller = new Controller(
      configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
      kube,
      { issuer: 'https://issuer.test' } as never,
      { resolve: async () => viewer, forget: () => {} } as never,
      { kube, namespace: 'di-runtime-acme', tenant: 'acme' },
    );
    const current = controller;
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => current.handle(r) });
    base = `http://127.0.0.1:${server.port}/v1/services`;
  });
  let log: ReturnType<typeof spyOn>;
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    // Retire this test's servers before resetting state, so late requests get a 503.
    generation++;
    api.stop();
    server.stop(true);
    watches = [];
    watchStatus = 200;
    watchStatuses = [];
    listed = undefined;
    lists = 0;
    timing.heartbeatMs = 15_000;
    timing.backoffBaseMs = 1_000;
    timing.backoffMaxMs = 30_000;
    timing.queueBytes = 1 << 20;
    timing.queueLimitBytes = 4 << 20;
    onWatch = undefined;
    onRelist = undefined;
  });
  afterAll(() => {
    log.mockRestore();
  });

  const read = async (response: Response) => {
    const out: { event?: string; data: string }[] = [];
    for await (const event of events(response.body as ReadableStream<Uint8Array>)) out.push(event);
    return out;
  };
  const messages = (out: { event?: string; data: string }[]) =>
    out.filter((e) => e.event === 'log').map((e) => JSON.parse(e.data).message);

  test('streams the projection as LogEvents and ends, as the user', async () => {
    const response = await fetch(`${base}/web/logs?env=prod`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const out = await read(response);
    expect(out.at(-1)).toEqual({ event: 'end', data: '' });
    expect(out.filter((e) => e.event === 'log').map((e) => JSON.parse(e.data))).toEqual([
      { timestamp: '2020-01-01T10:00:00Z', deployment: 'web', level: 'info', message: 'first' },
      { timestamp: '2020-01-01T10:01:00Z', deployment: 'web', level: 'debug', message: 'second' },
      {
        timestamp: '2020-01-01T10:02:00Z',
        deployment: 'web-v2',
        level: 'error',
        message: 'host: boom',
      },
      { timestamp: '2020-01-01T10:03:00Z', deployment: 'web', level: 'warn', message: 'fourth' },
    ]);
    const list = api.requests.find((r) => r.pathname.endsWith('/configmaps'));
    expect(list?.headers.get('authorization')).toBe('Bearer sa-alice');
    expect(decodeURIComponent(list?.path ?? '')).toContain(
      'labelSelector=di-framework.dev/projection=logs,di-framework.dev/application=web',
    );
  });

  test('tail keeps the newest lines', async () => {
    expect(messages(await read(await fetch(`${base}/web/logs?env=prod&tail=2`)))).toEqual([
      'host: boom',
      'fourth',
    ]);
    expect(messages(await read(await fetch(`${base}/web/logs?env=prod&tail=0`)))).toEqual([]);
  });

  test('since takes a timestamp or a duration', async () => {
    expect(
      messages(await read(await fetch(`${base}/web/logs?env=prod&since=2020-01-01T10:01:00Z`))),
    ).toEqual(['second', 'host: boom', 'fourth']);
    expect(messages(await read(await fetch(`${base}/web/logs?env=prod&since=1h`)))).toEqual([]);
  });

  test('the deployment filter keeps that deployment only', async () => {
    expect(
      messages(await read(await fetch(`${base}/web/logs?env=prod&deployment=web-v2`))),
    ).toEqual(['host: boom']);
  });

  test.each([
    ['since=yesterday', 'since must be'],
    ['since=5', 'since must be'],
    ['since=2020-01-01', 'since must be'],
    ['tail=-1', 'tail must be'],
  ])('rejects %s', async (query, detail) => {
    const response = await fetch(`${base}/web/logs?env=prod&${query}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { detail: string }).detail).toContain(detail);
  });

  test.each(['api', 'a,b'])('an unknown service %s is a 404', async (service) => {
    const response = await fetch(`${base}/${encodeURIComponent(service)}/logs?env=prod`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { detail: string }).detail).toContain('no published logs');
  });

  test('follow delivers new entries from the watch, and a disconnect closes the watch', async () => {
    timing.heartbeatMs = 20;
    const opened = new Promise<void>((resolve) => {
      onWatch = resolve;
    });
    const abort = new AbortController();
    const response = await fetch(`${base}/web/logs?env=prod&follow=true&tail=1`, {
      signal: abort.signal,
    });
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let text = '';
    const until = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };
    await until('fourth');
    expect(text).not.toContain('first');
    await opened;
    const watch = watches[0] as Watch;
    expect(watch.path).toContain('watch=true');
    expect(watch.path).toContain('resourceVersion=42');
    expect(api.requests.at(-1)?.headers.get('authorization')).toBe('Bearer sa-alice');
    watch.push({
      type: 'MODIFIED',
      object: configMap(
        'web',
        [
          '2020-01-01T10:03:00Z WARN fourth',
          '2020-01-01T10:03:00Z INFO same-second',
          '2020-01-01T10:04:00Z INFO fifth',
        ],
        undefined,
        '43',
      ),
    });
    watch.push({ type: 'DELETED', object: configMap('web', [], undefined, '44') });
    watch.push({ type: 'BOOKMARK', object: { metadata: { resourceVersion: '45' } } });
    await until('fifth');
    expect(text.split('fourth').length).toBe(2);
    expect(text).toContain('same-second');
    await until(': heartbeat');

    // The API server ends the watch: the stream re-watches from the newest resourceVersion.
    const again = new Promise<void>((resolve) => {
      onWatch = resolve;
    });
    watch.end();
    await again;
    expect(watches[1]?.path).toContain('resourceVersion=45');

    abort.abort();
    await (watches[1] as Watch).closed;
  });

  test('follow ends the stream when the watch is refused', async () => {
    watchStatus = 403;
    const out = await read(await fetch(`${base}/web/logs?env=prod&follow=true&tail=1`));
    expect(messages(out)).toEqual(['fourth']);
    expect(out.at(-1)?.event).toBe('end');
  });

  /** Reads a follow stream as text, chunk by chunk. */
  const follow = async (query: string, signal: AbortSignal) => {
    const response = await fetch(`${base}/web/logs?env=prod&follow=true&${query}`, { signal });
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    const state = { text: '' };
    const until = async (needle: string) => {
      while (!state.text.includes(needle)) {
        const { done, value } = await reader.read();
        if (done) return;
        state.text += decoder.decode(value);
      }
    };
    return { state, until };
  };
  const RELISTED = {
    metadata: { resourceVersion: '50' },
    items: [
      configMap(
        'web',
        ['2020-01-01T10:03:00Z WARN fourth', '2020-01-01T10:05:00Z INFO relisted'],
        undefined,
        '50',
      ),
    ],
  };

  test('an in-stream 410 relists, sends only new lines, and resumes from the new version', async () => {
    timing.backoffBaseMs = 20;
    const abort = new AbortController();
    onWatch = () => {
      if (watches.length !== 1) return;
      listed = RELISTED;
      (watches[0] as Watch).push({ type: 'ERROR', object: { kind: 'Status', code: 410 } });
    };
    const s = await follow('tail=1', abort.signal);
    await s.until('relisted');
    while (watches.length < 2) await Bun.sleep(5);
    expect(s.state.text.split('fourth').length).toBe(2);
    expect(s.state.text.split('relisted').length).toBe(2);
    expect(watches[1]?.path).toContain('resourceVersion=50');
    expect(lists).toBe(2);
    abort.abort();
    await (watches[1] as Watch).closed;
  });

  test('an HTTP 410 relists and re-watches', async () => {
    const abort = new AbortController();
    timing.backoffBaseMs = 20;
    watchStatuses = [410];
    listed = undefined;
    const opened = new Promise<void>((resolve) => {
      onWatch = resolve;
    });
    const first = await fetch(`${base}/web/logs?env=prod&follow=true&tail=1`, {
      signal: abort.signal,
    });
    await opened;
    expect(lists).toBe(2);
    expect(watches[0]?.path).toContain('resourceVersion=42');
    abort.abort();
    await first.body?.cancel().catch(() => {});
    await (watches[0] as Watch).closed;
  });

  test('any other ERROR event ends the stream', async () => {
    onWatch = () =>
      (watches[0] as Watch).push({ type: 'ERROR', object: { kind: 'Status', code: 500 } });
    const out = await read(await fetch(`${base}/web/logs?env=prod&follow=true&tail=0`));
    expect(out.at(-1)).toEqual({ event: 'end', data: '' });
    expect(watches.length).toBe(1);
  });

  /** Opens a follow, keeps reading it for `ms`, then cancels it. */
  const followFor = async (ms: number) => {
    const abort = new AbortController();
    const response = await fetch(`${base}/web/logs?env=prod&follow=true&tail=0`, {
      signal: abort.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const reading = (async () => {
      for (;;) if ((await reader.read()).done) return;
    })().catch(() => {});
    await Bun.sleep(ms);
    abort.abort();
    await reader.cancel().catch(() => {});
    await reading;
  };

  test('watches that close empty are retried with a bounded backoff', async () => {
    timing.backoffBaseMs = 20;
    timing.backoffMaxMs = 40;
    onWatch = () => (watches.at(-1) as Watch).end();
    await followFor(200);
    // 20 + 40 + 40 + 40 ... ms between watches: about 5 in 200ms, not hundreds.
    expect(watches.length).toBeGreaterThanOrEqual(2);
    expect(watches.length).toBeLessThanOrEqual(8);
  });

  test('cancelling the stream interrupts a backoff at once', async () => {
    timing.backoffBaseMs = 60_000;
    onWatch = () => (watches.at(-1) as Watch).end();
    const response = await controller.handle(
      new Request(`${base}/web/logs?env=prod&follow=true&tail=0`),
    );
    while (watches.length < 1) await Bun.sleep(5);
    await Bun.sleep(20);
    const started = Date.now();
    await response.body?.cancel();
    await Bun.sleep(20);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(watches.length).toBe(1);
  });

  test('a disconnect during a relist ends start() without backing off', async () => {
    timing.backoffBaseMs = 60_000;
    watchStatuses = [410];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const relisting = new Promise<void>((resolve) => {
      onRelist = () => {
        resolve();
        return gate;
      };
    });
    const response = await controller.handle(
      new Request(`${base}/web/logs?env=prod&follow=true&tail=0`),
    );
    await relisting;
    await response.body?.cancel();
    const timeout = spyOn(globalThis, 'setTimeout');
    try {
      release();
      await Bun.sleep(50);
      expect(timeout.mock.calls.some(([, ms]) => (ms ?? 0) >= 1_000)).toBe(false);
    } finally {
      timeout.mockRestore();
    }
    const watchCalls = api.requests.filter((r) => r.path.includes('watch=true')).length;
    expect(watchCalls).toBe(1);
  });

  test('watches that keep answering ERROR 410 back off', async () => {
    timing.backoffBaseMs = 20;
    timing.backoffMaxMs = 40;
    onWatch = () => {
      const watch = watches.at(-1) as Watch;
      watch.push({ type: 'ERROR', object: { kind: 'Status', code: 410 } });
      watch.end();
    };
    await followFor(200);
    expect(watches.length).toBeGreaterThanOrEqual(2);
    expect(watches.length).toBeLessThanOrEqual(8);
    expect(lists).toBeLessThanOrEqual(9);
  });

  test('watches that keep answering HTTP 410 back off', async () => {
    timing.backoffBaseMs = 20;
    timing.backoffMaxMs = 40;
    watchStatus = 410;
    await followFor(200);
    const watchCalls = api.requests.filter((r) => r.path.includes('watch=true')).length;
    expect(watchCalls).toBeGreaterThanOrEqual(2);
    expect(watchCalls).toBeLessThanOrEqual(8);
    expect(lists).toBeLessThanOrEqual(9);
  });

  test('a client that stops reading has its stream closed and the watch aborted', async () => {
    timing.queueBytes = 16_384;
    timing.queueLimitBytes = 65_536;
    const opened = new Promise<void>((resolve) => {
      onWatch = resolve;
    });
    // Called directly and never read, so nothing drains the queue.
    const response = await controller.handle(
      new Request(`${base}/web/logs?env=prod&follow=true&tail=0`),
    );
    expect(response.status).toBe(200);
    await opened;
    const watch = watches[0] as Watch;
    const filler = 'x'.repeat(4_000);
    for (let i = 0; i < 100; i++)
      watch.push({
        type: 'MODIFIED',
        object: configMap(
          'web',
          [`2020-01-02T00:00:${String(i % 60).padStart(2, '0')}.${i}Z INFO ${filler}`],
          undefined,
          String(100 + i),
        ),
      });
    await watch.closed;
    // The stream ended: draining it terminates instead of waiting for more events.
    const text = await response.text();
    expect(text.length).toBeLessThan(100 * 4_100);
  });

  test('follow with tail=0 does not replay the backlog on the first update', async () => {
    const abort = new AbortController();
    const opened = new Promise<void>((resolve) => {
      onWatch = resolve;
    });
    const s = await follow('tail=0', abort.signal);
    await opened;
    (watches[0] as Watch).push({
      type: 'MODIFIED',
      object: configMap(
        'web',
        ['2020-01-01T10:00:00Z INFO first', '2020-01-01T10:06:00Z INFO newer'],
        undefined,
        '43',
      ),
    });
    await s.until('newer');
    expect(s.state.text).not.toContain('first');
    abort.abort();
    await (watches[0] as Watch).closed;
  });

  test('follow ends the stream when the watch sends garbage', async () => {
    onWatch = () => {
      const watch = watches[0] as Watch;
      watch.push('not an event');
      watch.push(undefined);
    };
    const pending = read(await fetch(`${base}/web/logs?env=prod&follow=true&tail=0`));
    const out = await pending;
    expect(out.at(-1)?.event).toBe('end');
  });
});

test('logEvents tolerates a ConfigMap without labels or data', () => {
  expect(logEvents({ metadata: {} })).toEqual([]);
});
