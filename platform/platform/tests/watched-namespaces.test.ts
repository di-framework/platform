import { expect, test } from 'bun:test';
import { type LiveTenant, warnRemovedTenants } from '../src/tenancy/removal';
import {
  isTransientListError,
  realSleep,
  sharedTenantList,
  TENANT_LIST_RETRY_BUDGET_MS,
  TENANT_LIST_RETRY_DELAYS_MS,
  type TenantListRetry,
} from '../src/watched-namespaces';

/** An API error as client-node raises it: an HTTP status code and the response body. */
class ApiError extends Error {
  constructor(readonly code: number) {
    super(`HTTP-Code: ${code}\nBody: {"message":"secret detail"}`);
  }
}

/** This run's shared list over `list`, as `createPlatform` builds it, with no real waits. */
const shared = (
  list: (installation: string) => Promise<LiveTenant[]>,
  retry: TenantListRetry = {},
) => sharedTenantList(list, 'di-test', { sleep: async () => {}, ...retry });

test('the Tenant list is read once per run, lazily, and shared (#245)', async () => {
  let calls = 0;
  const asked: string[] = [];
  const tenants = shared(async (installation) => {
    calls++;
    asked.push(installation);
    return [
      { metadata: { name: 'alpha' } },
      { metadata: { name: 'beta' }, spec: { deletionPolicy: 'Retain' } },
    ];
  });
  expect(calls).toBe(0); // listed lazily, on first use
  const warnings: string[] = [];
  const notices = await warnRemovedTenants({
    declared: ['alpha'],
    list: tenants,
    warn: (m) => warnings.push(m),
  });
  expect(calls).toBe(1);
  expect(asked).toEqual(['di-test']);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('Tenant beta is being removed with deletionPolicy Retain');
  expect(warnings).toEqual(notices);
  // The same snapshot, not a second request, however often it is read.
  expect(await tenants()).toBe(await tenants());
  expect(calls).toBe(1);
});

test('a list failure is shared too, and the Retain check skips on it (#245)', async () => {
  let calls = 0;
  const tenants = shared(async () => {
    calls++;
    throw new ApiError(403);
  });
  const debug: string[] = [];
  const notices = await warnRemovedTenants({
    declared: ['alpha'],
    list: tenants,
    warn: () => {},
    debug: (m) => debug.push(m),
  });
  expect(notices).toEqual([]);
  expect(debug).toHaveLength(1);
  await expect(tenants()).rejects.toThrow('HTTP-Code: 403');
  expect(calls).toBe(1);
});

test('transient list failures are retried with a short backoff (#245)', async () => {
  const slept: number[] = [];
  const failures: unknown[] = [
    new ApiError(503),
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    new ApiError(429),
  ];
  let calls = 0;
  const tenants = shared(
    async () => {
      calls++;
      const failure = failures.shift();
      if (failure) throw failure;
      return [{ metadata: { name: 'alpha' } }, { metadata: { name: 'beta' } }];
    },
    {
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
  );
  expect((await tenants()).map((t) => t.metadata.name)).toEqual(['alpha', 'beta']);
  expect(calls).toBe(4);
  expect(slept).toEqual([...TENANT_LIST_RETRY_DELAYS_MS]);
});

test('a transient failure that persists still fails after the last attempt', async () => {
  let calls = 0;
  const tenants = shared(async () => {
    calls++;
    throw Object.assign(new Error('connect'), { cause: { code: 'ETIMEDOUT' } });
  });
  await expect(tenants()).rejects.toThrow('connect');
  expect(calls).toBe(TENANT_LIST_RETRY_DELAYS_MS.length + 1);
});

test('permanent failures and a missing CRD are not retried', async () => {
  for (const error of [new ApiError(403), new ApiError(404), new Error('bad kubeconfig')]) {
    let calls = 0;
    const tenants = shared(async () => {
      calls++;
      throw error;
    });
    await expect(tenants()).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});

test('transient errors are HTTP 429, 5xx and connection codes only', () => {
  expect(isTransientListError(new ApiError(500))).toBe(true);
  expect(isTransientListError(new ApiError(429))).toBe(true);
  expect(isTransientListError(new ApiError(401))).toBe(false);
  expect(isTransientListError(Object.assign(new Error(), { code: 'EAI_AGAIN' }))).toBe(true);
  expect(isTransientListError(Object.assign(new Error(), { code: 'ENOTFOUND' }))).toBe(false);
  expect(isTransientListError(Object.assign(new Error(), { cause: { code: 'EPIPE' } }))).toBe(true);
  expect(isTransientListError(new Error('plain'))).toBe(false);
  expect(isTransientListError('ECONNRESET')).toBe(false);
  expect(isTransientListError(null)).toBe(false);
});

test('the default wait really sleeps', async () => {
  const started = performance.now();
  await realSleep(5);
  expect(performance.now() - started).toBeGreaterThanOrEqual(4);
});

/** A `fetch failed` TypeError as undici raises it under Node: the code is on `cause`. */
function undiciError(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('other side'), { code }) });
}

/** A fetch error as Bun raises it: the code is on the error itself. */
function bunError(code: string): Error {
  return Object.assign(new Error('Unable to connect'), { code });
}

test.each([
  ['undici socket', undiciError('UND_ERR_SOCKET')],
  ['undici connect timeout', undiciError('UND_ERR_CONNECT_TIMEOUT')],
  ['undici closed', undiciError('UND_ERR_CLOSED')],
  ['undici ECONNRESET', undiciError('ECONNRESET')],
  ['Bun ConnectionRefused', bunError('ConnectionRefused')],
  ['Bun ConnectionReset', bunError('ConnectionReset')],
  ['Bun ConnectionClosed', bunError('ConnectionClosed')],
  ['Bun FailedToOpenSocket', bunError('FailedToOpenSocket')],
])('a %s error is retried (#245)', async (_, error) => {
  expect(isTransientListError(error)).toBe(true);
  let calls = 0;
  const tenants = shared(async () => {
    if (calls++ === 0) throw error;
    return [{ metadata: { name: 'beta' } }];
  });
  expect((await tenants()).map((t) => t.metadata.name)).toEqual(['beta']);
  expect(calls).toBe(2);
});

test('header and body timeouts are not retried: each already waited minutes', () => {
  expect(isTransientListError(undiciError('UND_ERR_HEADERS_TIMEOUT'))).toBe(false);
  expect(isTransientListError(undiciError('UND_ERR_BODY_TIMEOUT'))).toBe(false);
});

test('no retry starts past the retry budget, so slow failures stay bounded (#245)', async () => {
  let clock = 0;
  const slept: number[] = [];
  let calls = 0;
  const tenants = shared(
    async () => {
      calls++;
      clock += 10_000; // each attempt fails only after an undici connect timeout
      throw undiciError('UND_ERR_CONNECT_TIMEOUT');
    },
    {
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      now: () => clock,
    },
  );
  await expect(tenants()).rejects.toThrow('fetch failed');
  // 10 s + 0.5 s wait fits the budget; a second retry would start past it.
  expect(calls).toBe(2);
  expect(slept).toEqual([TENANT_LIST_RETRY_DELAYS_MS[0]]);
  expect(clock).toBeLessThanOrEqual(TENANT_LIST_RETRY_BUDGET_MS + 10_000);
});
