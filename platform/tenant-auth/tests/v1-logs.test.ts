import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { events } from '@di-framework/tenant-cli/src/client/sse.ts';
import { Controller, configFromEnv } from '../src/controller.ts';
import type { Principal } from '../src/identity.ts';
import { KubeClient } from '../src/kube.ts';
import { logEvents, timing } from '../src/v1/logs.ts';
import { json, type Recorded, serve } from './support/servers.ts';

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
  let onWatch: (() => void) | undefined;
  const api = serve((request: Recorded) => {
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
      if (watchStatus !== 200) return json({ message: 'gone' }, watchStatus);
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
    return json({ metadata: { resourceVersion: '42' }, items });
  });
  const viewer: Principal = {
    user: 'alice',
    account: 'acme',
    role: 'viewer',
    via: 'identity',
    credentialId: 's',
  };
  const kube = new KubeClient({ server: api.url, token: 'admin' }, 'wasmcloud');
  const controller = new Controller(
    configFromEnv({ TENANT_CONTROLLER_TENANT: 'acme' }),
    kube,
    { issuer: 'https://issuer.test' } as never,
    { resolve: async () => viewer, forget: () => {} } as never,
    { kube, namespace: 'di-runtime-acme', tenant: 'acme' },
  );
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => controller.handle(r) });
  const base = `http://127.0.0.1:${server.port}/v1/services`;
  let log: ReturnType<typeof spyOn>;
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    watches = [];
    watchStatus = 200;
    onWatch = undefined;
    api.requests.length = 0;
  });
  afterAll(() => {
    log.mockRestore();
    server.stop(true);
    api.stop();
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
    timing.heartbeatMs = 15_000;
  });

  test('follow ends the stream when the watch is refused', async () => {
    watchStatus = 410;
    const out = await read(await fetch(`${base}/web/logs?env=prod&follow=true&tail=1`));
    expect(messages(out)).toEqual(['fourth']);
    expect(out.at(-1)?.event).toBe('end');
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
