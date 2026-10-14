import { expect, test } from 'bun:test';
import type { LiveTenant } from '../src/tenancy/removal';
import {
  describeListError,
  type HostNamespacesArgs,
  isTransientListError,
  operatorHostNamespaces,
  TENANT_LIST_RETRY_DELAYS_MS,
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

function args(
  extra: Partial<HostNamespacesArgs>,
  log: HostNamespacesArgs['log'],
): HostNamespacesArgs {
  return {
    platformNamespace: 'wasmcloud',
    installation: 'di-test',
    declared: ['alpha'],
    dryRun: false,
    log,
    sleep: async () => {},
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

test('preview never lists Tenants and says when a removed namespace stops being watched', async () => {
  const { info, warn, log } = recorder();
  const cluster = live('beta');
  const namespaces = await operatorHostNamespaces(
    args({ dryRun: true, listTenants: cluster.list }, log),
  );
  expect(cluster.asked).toEqual([]);
  expect(namespaces).toEqual(['wasmcloud', 'di-runtime-alpha']);
  expect(warn).toEqual([]);
  expect(info).toHaveLength(1);
  expect(info[0]).toContain('stays watched while its Tenant is deleted');
  expect(info[0]).toContain('stops being watched on the next up, after the Tenant is gone');
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

test('without an injected sleep, a retry really waits before the next attempt', async () => {
  const { log } = recorder();
  let calls = 0;
  const listTenants = async (): Promise<LiveTenant[]> => {
    if (calls++ === 0) throw new ApiError(502);
    return [];
  };
  const started = Date.now();
  expect(await operatorHostNamespaces(args({ listTenants, sleep: undefined }, log))).toEqual([
    'wasmcloud',
    'di-runtime-alpha',
  ]);
  expect(calls).toBe(2);
  expect(Date.now() - started).toBeGreaterThanOrEqual(TENANT_LIST_RETRY_DELAYS_MS[0] - 50);
});
