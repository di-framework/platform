import { expect, test } from 'bun:test';
import type { LiveTenant } from '../src/tenancy/removal';
import { type HostNamespacesArgs, operatorHostNamespaces } from '../src/watched-namespaces';

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
