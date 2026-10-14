import { expect, test } from 'bun:test';
import { type LiveTenant, type TenantLister, warnRemovedTenants } from '../src/tenancy/removal';
import {
  describeListError,
  type HostNamespacesArgs,
  isTransientListError,
  operatorHostNamespaces,
  realSleep,
  sharedTenantList,
  TENANT_LIST_RETRY_BUDGET_MS,
  TENANT_LIST_RETRY_DELAYS_MS,
  type TenantListRetry,
} from '../src/watched-namespaces';

/** A `tenancy/removal` lister stub that records the installation it is asked for. */
function live(...tenants: string[]) {
  const asked: string[] = [];
  const list = async (installation: string): Promise<LiveTenant[]> => {
    asked.push(installation);
    return tenants.map((name) => ({ metadata: { name } }));
  };
  return { asked, list };
}

/** An API error as client-node raises it: an HTTP status code and the response body. */
class ApiError extends Error {
  constructor(readonly code: number) {
    super(`HTTP-Code: ${code}\nBody: {"message":"secret detail"}`);
  }
}

function recorder() {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    log: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) },
  };
}

/** Arguments with `listTenants` behind this run's shared list, as `createPlatform` passes it. */
function args(
  {
    listTenants,
    sleep = async () => {},
    now,
    ...extra
  }: Partial<HostNamespacesArgs> & TenantListRetry & { listTenants?: TenantLister },
  log: HostNamespacesArgs['log'],
): HostNamespacesArgs {
  return {
    platformNamespace: 'wasmcloud',
    installation: 'di-test',
    declared: ['alpha'],
    dryRun: false,
    log,
    tenants: listTenants && sharedTenantList(listTenants, 'di-test', { sleep, now }),
    ...extra,
  };
}

test('a removed tenant whose Tenant still exists keeps its runtime namespace watched (#227)', async () => {
  const { info, warn, log } = recorder();
  const cluster = live('zeta', 'beta', 'alpha', 'beta');
  const namespaces = await operatorHostNamespaces(args({ listTenants: cluster.list }, log));
  expect(cluster.asked).toEqual(['di-test']);
  // Declared first, then the removed ones once each, sorted, so the Helm values are stable.
  expect(namespaces).toEqual([
    'wasmcloud',
    'di-runtime-alpha',
    'di-runtime-beta',
    'di-runtime-zeta',
  ]);
  expect(warn).toEqual([]);
  expect(info).toHaveLength(2);
  expect(info[0]).toContain('Tenant beta is no longer declared but still exists');
  expect(info[0]).toContain('di-runtime-beta');
  expect(info[0]).toContain('next up, after the Tenant is gone');
});

test('once the removed Tenant is gone, its runtime namespace is no longer watched', async () => {
  const { info, log } = recorder();
  expect(await operatorHostNamespaces(args({ listTenants: live('alpha').list }, log))).toEqual([
    'wasmcloud',
    'di-runtime-alpha',
  ]);
  // A declared tenant whose Tenant does not exist yet (a first up) is watched too.
  expect(
    await operatorHostNamespaces(
      args({ declared: ['alpha', 'gamma'], listTenants: live().list }, log),
    ),
  ).toEqual(['wasmcloud', 'di-runtime-alpha', 'di-runtime-gamma']);
  expect(info).toEqual([]);
});

test('preview reads the Tenant list too, so its diff matches the up (#245)', async () => {
  const { info, warn, log } = recorder();
  const cluster = live('alpha', 'beta');
  const namespaces = await operatorHostNamespaces(
    args({ dryRun: true, listTenants: cluster.list }, log),
  );
  expect(cluster.asked).toEqual(['di-test']);
  expect(namespaces).toEqual(['wasmcloud', 'di-runtime-alpha', 'di-runtime-beta']);
  expect(warn).toEqual([]);
  expect(info).toHaveLength(1);
  expect(info[0]).toContain('Tenant beta is no longer declared but still exists');
});

test('preview logs nothing when no tenant is being removed (#245)', async () => {
  const { info, warn, log } = recorder();
  expect(
    await operatorHostNamespaces(args({ dryRun: true, listTenants: live('alpha').list }, log)),
  ).toEqual(['wasmcloud', 'di-runtime-alpha']);
  expect(info).toEqual([]);
  expect(warn).toEqual([]);
});

test('preview falls back to the declared tenants with a warning when the list fails (#245)', async () => {
  const { info, warn, log } = recorder();
  let calls = 0;
  const listTenants = async (): Promise<LiveTenant[]> => {
    calls++;
    throw new ApiError(403);
  };
  expect(await operatorHostNamespaces(args({ dryRun: true, listTenants }, log))).toEqual([
    'wasmcloud',
    'di-runtime-alpha',
  ]);
  expect(calls).toBe(1);
  expect(info).toEqual([]);
  expect(warn).toHaveLength(1);
  expect(warn[0]).toContain(
    'Preview cannot list the Tenants of installation di-test, so it shows the wasmCloud operator',
  );
  expect(warn[0]).toEndWith('(#227): HTTP 403');
  expect(warn[0]).not.toContain('secret detail');
  // Transient failures are retried in preview as on up; a missing CRD means no Tenants.
  const retried = recorder();
  const failures: unknown[] = [new ApiError(503)];
  const flaky = async (): Promise<LiveTenant[]> => {
    const failure = failures.shift();
    if (failure) throw failure;
    return [{ metadata: { name: 'beta' } }];
  };
  expect(
    await operatorHostNamespaces(args({ dryRun: true, listTenants: flaky }, retried.log)),
  ).toEqual(['wasmcloud', 'di-runtime-alpha', 'di-runtime-beta']);
  const missingCrd = recorder();
  expect(
    await operatorHostNamespaces(
      args(
        {
          dryRun: true,
          listTenants: async () => {
            throw new ApiError(404);
          },
        },
        missingCrd.log,
      ),
    ),
  ).toEqual(['wasmcloud', 'di-runtime-alpha']);
  expect(missingCrd.warn).toEqual([]);
});

test('preview without the admin kubeconfig watches the declared tenants only, with a warning', async () => {
  const { warn, log } = recorder();
  expect(await operatorHostNamespaces(args({ dryRun: true }, log))).toEqual([
    'wasmcloud',
    'di-runtime-alpha',
  ]);
  expect(warn).toHaveLength(1);
  expect(warn[0]).toContain('Pass kubeconfig to createPlatform');
});

test('the Tenant list is read once per run and shared by both callers (#245)', async () => {
  let calls = 0;
  const asked: string[] = [];
  const listTenants = async (installation: string): Promise<LiveTenant[]> => {
    calls++;
    asked.push(installation);
    return [
      { metadata: { name: 'alpha' } },
      { metadata: { name: 'beta' }, spec: { deletionPolicy: 'Retain' } },
    ];
  };
  const tenants = sharedTenantList(listTenants, 'di-test', { sleep: async () => {} });
  expect(calls).toBe(0); // listed lazily, on first use
  const { info, log } = recorder();
  const warnings: string[] = [];
  const [namespaces, notices] = await Promise.all([
    operatorHostNamespaces(args({ tenants }, log)),
    warnRemovedTenants({
      installation: 'di-test',
      declared: ['alpha'],
      list: tenants,
      warn: (m) => warnings.push(m),
    }),
  ]);
  expect(calls).toBe(1);
  expect(asked).toEqual(['di-test']);
  expect(namespaces).toEqual(['wasmcloud', 'di-runtime-alpha', 'di-runtime-beta']);
  expect(info[0]).toContain('Tenant beta is no longer declared');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('Tenant beta is being removed with deletionPolicy Retain');
  expect(warnings).toEqual(notices);
  // The same snapshot, not a second request, however often it is read.
  expect(await tenants()).toBe(await tenants());
  expect(calls).toBe(1);
});

test('a shared list failure keeps how each caller handles it: up fails, the Retain check skips (#245)', async () => {
  let calls = 0;
  const tenants = sharedTenantList(
    async () => {
      calls++;
      throw new ApiError(403);
    },
    'di-test',
    { sleep: async () => {} },
  );
  const { log } = recorder();
  const debug: string[] = [];
  const notices = await warnRemovedTenants({
    installation: 'di-test',
    declared: ['alpha'],
    list: tenants,
    warn: () => {},
    debug: (m) => debug.push(m),
  });
  expect(notices).toEqual([]);
  expect(debug).toHaveLength(1);
  await expect(operatorHostNamespaces(args({ tenants }, log))).rejects.toThrow(
    "Cannot list the Tenants of installation di-test, which keep a removed tenant's runtime namespace watched by the wasmCloud operator until the Tenant is deleted (#227): HTTP 403",
  );
  expect(calls).toBe(1);
});

test('a transient failure is retried once for both callers, not per caller (#245)', async () => {
  let calls = 0;
  const slept: number[] = [];
  const tenants = sharedTenantList(
    async () => {
      calls++;
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    },
    'di-test',
    {
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
  );
  const { log } = recorder();
  const [hostNamespaces, notices] = await Promise.allSettled([
    operatorHostNamespaces(args({ tenants }, log)),
    warnRemovedTenants({ installation: 'di-test', declared: [], list: tenants, warn: () => {} }),
  ]);
  expect(hostNamespaces.status).toBe('rejected');
  expect(notices).toEqual({ status: 'fulfilled', value: [] });
  expect(calls).toBe(TENANT_LIST_RETRY_DELAYS_MS.length + 1);
  expect(slept).toEqual([...TENANT_LIST_RETRY_DELAYS_MS]);
});

test('without the admin kubeconfig only declared tenants are watched, with a warning', async () => {
  const { warn, log } = recorder();
  expect(await operatorHostNamespaces(args({}, log))).toEqual(['wasmcloud', 'di-runtime-alpha']);
  expect(warn).toHaveLength(1);
  expect(warn[0]).toContain('Pass kubeconfig to createPlatform');
});

test('a missing Tenant CRD (first install) means no removed tenants', async () => {
  const { log } = recorder();
  const listTenants = async () => {
    throw new ApiError(404);
  };
  expect(await operatorHostNamespaces(args({ listTenants }, log))).toEqual([
    'wasmcloud',
    'di-runtime-alpha',
  ]);
});

test('API errors fail the update with a clear message, never the response body', async () => {
  const { log } = recorder();
  const failing = (error: unknown) =>
    operatorHostNamespaces(
      args(
        {
          listTenants: async () => {
            throw error;
          },
        },
        log,
      ),
    );
  const forbidden = failing(new ApiError(403));
  await expect(forbidden).rejects.toThrow(
    "Cannot list the Tenants of installation di-test, which keep a removed tenant's runtime namespace watched by the wasmCloud operator until the Tenant is deleted (#227): HTTP 403",
  );
  await expect(forbidden).rejects.not.toThrow('secret detail');
  // A connection failure names its code; an unusable kubeconfig names only the error class.
  await expect(
    failing(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })),
  ).rejects.toThrow('(#227): ECONNREFUSED');
  await expect(failing(new Error('token: hunter2'))).rejects.toThrow('(#227): Error');
  await expect(failing(new Error('token: hunter2'))).rejects.not.toThrow('hunter2');
});

test('transient list failures are retried with a short backoff before failing (#245)', async () => {
  const { log } = recorder();
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };
  const failures: unknown[] = [
    new ApiError(503),
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    new ApiError(429),
  ];
  let calls = 0;
  const listTenants = async (): Promise<LiveTenant[]> => {
    calls++;
    const failure = failures.shift();
    if (failure) throw failure;
    return [{ metadata: { name: 'alpha' } }, { metadata: { name: 'beta' } }];
  };
  expect(await operatorHostNamespaces(args({ listTenants, sleep }, log))).toEqual([
    'wasmcloud',
    'di-runtime-alpha',
    'di-runtime-beta',
  ]);
  expect(calls).toBe(4);
  expect(slept).toEqual([...TENANT_LIST_RETRY_DELAYS_MS]);
});

test('a transient failure that persists still fails the update after the last attempt', async () => {
  const { log } = recorder();
  let calls = 0;
  const listTenants = async (): Promise<LiveTenant[]> => {
    calls++;
    throw Object.assign(new Error('connect'), { cause: { code: 'ETIMEDOUT' } });
  };
  await expect(operatorHostNamespaces(args({ listTenants }, log))).rejects.toThrow(
    '(#227): ETIMEDOUT',
  );
  expect(calls).toBe(TENANT_LIST_RETRY_DELAYS_MS.length + 1);
});

test('permanent failures and a missing CRD are not retried', async () => {
  const { log } = recorder();
  for (const [error, outcome] of [
    [new ApiError(403), 'reject'],
    [new ApiError(404), 'empty'],
    [new Error('bad kubeconfig'), 'reject'],
  ] as const) {
    let calls = 0;
    const listTenants = async (): Promise<LiveTenant[]> => {
      calls++;
      throw error;
    };
    const result = operatorHostNamespaces(args({ listTenants }, log));
    if (outcome === 'empty') expect(await result).toEqual(['wasmcloud', 'di-runtime-alpha']);
    else await expect(result).rejects.toThrow('(#227)');
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

test('a kubeconfig error says what to check, quoting only known client-node messages (#245)', async () => {
  const { log } = recorder();
  const failing = (error: unknown) =>
    operatorHostNamespaces(
      args(
        {
          listTenants: async () => {
            throw error;
          },
        },
        log,
      ),
    );
  await expect(
    failing(new Error('HTTP protocol is not allowed when skipTLSVerify is not set or false')),
  ).rejects.toThrow(
    '(#227): Error: HTTP protocol is not allowed when skipTLSVerify is not set or false (check the kubeconfig)',
  );
  expect(describeListError(new Error('No active cluster!'))).toBe(
    'Error: No active cluster! (check the kubeconfig)',
  );
  expect(describeListError(new Error('Unsupported proxy type'))).toBe(
    'Error: Unsupported proxy type (check the kubeconfig)',
  );
  expect(describeListError(new Error('users[0].name is missing'))).toBe(
    'Error: users[0].name is missing (check the kubeconfig)',
  );
  expect(describeListError(new Error('clusters[2].cluster.server is missing'))).toContain(
    'clusters[2].cluster.server is missing',
  );
  // Any other message may quote the kubeconfig: only the class and a fixed hint are shown.
  const unknown = describeListError(new Error('token: hunter2'));
  expect(unknown).toBe(
    "Error (no HTTP status or error code; check the kubeconfig's server URL, TLS settings and credentials)",
  );
  expect(describeListError(new Error('Duplicate user: hunter2'))).not.toContain('hunter2');
  const yaml = Object.assign(new Error('bad indentation: password: hunter2'), {
    name: 'YAMLException',
  });
  expect(describeListError(yaml)).toStartWith('YAMLException (no HTTP status');
  expect(describeListError(yaml)).not.toContain('hunter2');
  // A status or code is enough on its own.
  expect(describeListError(new ApiError(403))).toBe('HTTP 403');
  expect(describeListError(Object.assign(new Error('x'), { cause: { code: 'EPIPE' } }))).toBe(
    'EPIPE',
  );
  expect(describeListError(null)).toBe(
    "unknown error (no HTTP status or error code; check the kubeconfig's server URL, TLS settings and credentials)",
  );
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
  const { log } = recorder();
  let calls = 0;
  const listTenants = async (): Promise<LiveTenant[]> => {
    if (calls++ === 0) throw error;
    return [{ metadata: { name: 'beta' } }];
  };
  expect(await operatorHostNamespaces(args({ listTenants }, log))).toEqual([
    'wasmcloud',
    'di-runtime-alpha',
    'di-runtime-beta',
  ]);
  expect(calls).toBe(2);
});

test('header and body timeouts are not retried: each already waited minutes', () => {
  expect(isTransientListError(undiciError('UND_ERR_HEADERS_TIMEOUT'))).toBe(false);
  expect(isTransientListError(undiciError('UND_ERR_BODY_TIMEOUT'))).toBe(false);
});

test('a persistent undici error fails with its code after the last attempt', async () => {
  const { log } = recorder();
  const listTenants = async (): Promise<LiveTenant[]> => {
    throw undiciError('UND_ERR_SOCKET');
  };
  await expect(operatorHostNamespaces(args({ listTenants }, log))).rejects.toThrow(
    '(#227): UND_ERR_SOCKET',
  );
});

test('no retry starts past the retry budget, so slow failures stay bounded (#245)', async () => {
  const { log } = recorder();
  let clock = 0;
  const slept: number[] = [];
  let calls = 0;
  const listTenants = async (): Promise<LiveTenant[]> => {
    calls++;
    clock += 10_000; // each attempt fails only after an undici connect timeout
    throw undiciError('UND_ERR_CONNECT_TIMEOUT');
  };
  const sleep = async (ms: number) => {
    slept.push(ms);
    clock += ms;
  };
  await expect(
    operatorHostNamespaces(args({ listTenants, sleep, now: () => clock }, log)),
  ).rejects.toThrow('(#227): UND_ERR_CONNECT_TIMEOUT');
  // 10 s + 0.5 s wait fits the budget; a second retry would start past it.
  expect(calls).toBe(2);
  expect(slept).toEqual([TENANT_LIST_RETRY_DELAYS_MS[0]]);
  expect(clock).toBeLessThanOrEqual(TENANT_LIST_RETRY_BUDGET_MS + 10_000);
});
