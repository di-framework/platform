import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretReaderFromKubeconfig } from '../src/token-secret-reader';
import {
  describeReadError,
  type SecretDataReader,
  tokenWaitDelayMs,
  waitForTokenSecret,
} from '../src/token-wait';
import { selfSignedCert } from './support/tls';

class ApiError extends Error {
  constructor(readonly code: number) {
    super(`HTTP-Code: ${code}\nBody: {"data":{"token":"c2VjcmV0"}}`);
  }
}

function harness(readSecret: SecretDataReader, extra: { timeoutMs?: number } = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const options = {
    namespace: 'wasmcloud',
    name: 'di-user-alice-alpha-token',
    readSecret,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...extra,
  };
  return { options, sleeps };
}

test('resolves once the token appears after N polls, retrying 404s with backoff', async () => {
  let calls = 0;
  const { options, sleeps } = harness(async () => {
    if (++calls < 4) throw new ApiError(404);
    return { token: 'dG9rZW4=' };
  });
  await waitForTokenSecret(options);
  expect(calls).toBe(4);
  expect(sleeps).toEqual([1000, 1000, 1000]);
});

test('a Secret without data.token keeps waiting and the timeout says so', async () => {
  let calls = 0;
  const { options } = harness(
    async () => {
      calls++;
      return calls % 2 ? undefined : { 'ca.crt': 'x', token: '' };
    },
    { timeoutMs: 30_000 },
  );
  await expect(waitForTokenSecret(options)).rejects.toThrow(
    'Timed out after 30000 ms waiting for Secret wasmcloud/di-user-alice-alpha-token to have data.token (last observation: Secret exists without data.token)',
  );
  expect(calls).toBeGreaterThan(5);
});

test('never appearing times out naming the Secret and 404, within the wall-clock deadline', async () => {
  const { options, sleeps } = harness(
    async () => {
      throw new ApiError(404);
    },
    { timeoutMs: 300_000 },
  );
  await expect(waitForTokenSecret(options)).rejects.toThrow(
    'wasmcloud/di-user-alice-alpha-token to have data.token (last observation: Secret not found (HTTP 404))',
  );
  expect(sleeps.reduce((a, b) => a + b, 0)).toBe(300_000);
  expect(Math.max(...sleeps)).toBe(10_000);
});

for (const [label, make, expected] of [
  ['HTTP 403', () => new ApiError(403), 'HTTP 403'],
  ['HTTP 500', () => new ApiError(500), 'HTTP 500'],
  [
    'ECONNREFUSED',
    () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    'ECONNREFUSED',
  ],
] as const) {
  test(`${label} is retried, recovers if it clears, and otherwise fails instead of being skipped`, async () => {
    let calls = 0;
    const recovering = harness(async () => {
      if (++calls < 3) throw make();
      return { token: 'dA==' };
    });
    await waitForTokenSecret(recovering.options);
    expect(calls).toBe(3);

    const failing = harness(
      async () => {
        throw make();
      },
      { timeoutMs: 20_000 },
    );
    const error = await waitForTokenSecret(failing.options).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('wasmcloud/di-user-alice-alpha-token');
    expect(message).toContain(`last observation: ${expected}`);
    // Never echo the server's message or any Secret body.
    expect(message).not.toContain('c2VjcmV0');
    expect(message).not.toContain('Body');
  });
}

test('a hung request is abandoned after the per-request timeout and retried', async () => {
  let calls = 0;
  const { options } = harness(() => {
    calls++;
    return calls === 1 ? new Promise(() => {}) : Promise.resolve({ token: 'dA==' });
  });
  await waitForTokenSecret({ ...options, requestTimeoutMs: 10 });
  expect(calls).toBe(2);
});

test('uses real timers and clock by default', async () => {
  let calls = 0;
  await waitForTokenSecret({
    namespace: 'n',
    name: 's',
    readSecret: async () => (++calls < 2 ? undefined : { token: 'dA==' }),
  });
  expect(calls).toBe(2);
}, 10_000);

test('error classification and backoff schedule', () => {
  expect(describeReadError(null)).toBe('unknown error');
  expect(describeReadError('boom')).toBe('unknown error');
  expect(describeReadError({ code: 'ECONNRESET' })).toBe('ECONNRESET');
  expect(describeReadError({ cause: { code: 'ETIMEDOUT' } })).toBe('ETIMEDOUT');
  expect(describeReadError(new RangeError('x'))).toBe('RangeError');
  expect(describeReadError({ name: '' })).toBe('unknown error');
  expect([0, 9, 10, 20, 30, 40, 99].map(tokenWaitDelayMs)).toEqual([
    1000, 1000, 2000, 4000, 8000, 10_000, 10_000,
  ]);
});

// The reader talks to real HTTP servers so we can prove which cluster it contacts.
const hits: { label: string; path: string; auth: string | null }[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
let realUrl = '';
let decoyUrl = '';
let status = 200;

const tls = selfSignedCert();

function kubeconfigFor(clusters: Record<string, string>, current: string): string {
  const names = Object.keys(clusters);
  return `${[
    'apiVersion: v1',
    'kind: Config',
    `current-context: ${current}`,
    'clusters:',
    ...names.flatMap((n) => [
      `- name: ${n}`,
      '  cluster:',
      `    server: ${clusters[n]}`,
      `    certificate-authority-data: ${Buffer.from(tls.cert).toString('base64')}`,
    ]),
    'users:',
    ...names.flatMap((n) => [`- name: ${n}`, '  user:', `    token: tok-${n}`]),
    'contexts:',
    ...names.flatMap((n) => [`- name: ${n}`, '  context:', `    cluster: ${n}`, `    user: ${n}`]),
  ].join('\n')}\n`;
}

function api(label: string) {
  const server = Bun.serve({
    port: 0,
    tls: { key: tls.key, cert: tls.cert },
    fetch(req) {
      hits.push({ label, path: new URL(req.url).pathname, auth: req.headers.get('authorization') });
      if (status !== 200) return new Response('{"message":"nope"}', { status });
      return Response.json({
        kind: 'Secret',
        apiVersion: 'v1',
        metadata: { name: 'x' },
        data: { token: 'dG9rZW4=' },
      });
    },
  });
  servers.push(server);
  return `https://127.0.0.1:${server.port}`;
}

// Bun's fetch ignores the undici dispatcher (and so the kubeconfig CA) that client-node installs,
// so trust the self-signed fake server through Bun's process-wide switch. Under node (Pulumi's
// runtime) the CA from the kubeconfig is honored; platform.test.ts covers that path.
let savedReject: string | undefined;

beforeAll(() => {
  savedReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  realUrl = api('real');
  decoyUrl = api('decoy');
});
afterAll(() => {
  if (savedReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedReject;
  for (const server of servers) server.stop(true);
});

test('secretReaderFromKubeconfig reads via the given kubeconfig and context, not $KUBECONFIG', async () => {
  const ambient = join(mkdtempSync(join(tmpdir(), 'ambient-')), 'config');
  await Bun.write(ambient, kubeconfigFor({ decoy: decoyUrl }, 'decoy'));
  const saved = process.env.KUBECONFIG;
  process.env.KUBECONFIG = ambient;
  try {
    hits.length = 0;
    status = 200;
    const yaml = kubeconfigFor({ first: decoyUrl, second: realUrl }, 'first');
    const read = secretReaderFromKubeconfig(yaml, 'second');
    expect(await read('wasmcloud', 'di-user-alice-alpha-token')).toEqual({ token: 'dG9rZW4=' });
    expect(hits).toEqual([
      {
        label: 'real',
        path: '/api/v1/namespaces/wasmcloud/secrets/di-user-alice-alpha-token',
        auth: 'Bearer tok-second',
      },
    ]);
    // Without a context, the kubeconfig's own current-context applies.
    hits.length = 0;
    await secretReaderFromKubeconfig(yaml)('wasmcloud', 's');
    expect(hits.map((h) => h.label)).toEqual(['decoy']);
  } finally {
    if (saved === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = saved;
  }
});

test('HTTP failures surface as errors the poller retries and then reports by status', async () => {
  status = 403;
  hits.length = 0;
  const read = secretReaderFromKubeconfig(kubeconfigFor({ only: realUrl }, 'only'));
  const { options } = harness(read, { timeoutMs: 3000 });
  await expect(waitForTokenSecret(options)).rejects.toThrow('last observation: HTTP 403');
  expect(hits.length).toBeGreaterThan(1);
  status = 200;
});

test('an unreachable API server fails with an error class, not a skip', async () => {
  const read = secretReaderFromKubeconfig(kubeconfigFor({ down: 'https://127.0.0.1:1' }, 'down'));
  const { options } = harness(read, { timeoutMs: 3000 });
  await expect(waitForTokenSecret(options)).rejects.toThrow(
    /to have data\.token \(last observation: \S+\)/,
  );
});

test('an unknown context throws at construction', () => {
  expect(() => secretReaderFromKubeconfig(kubeconfigFor({ a: realUrl }, 'a'), 'missing')).toThrow();
});
