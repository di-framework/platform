import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  type HostNamespacesArgs,
  operatorHostNamespaces,
  tenantListerFromKubeconfig,
} from '../src/watched-namespaces';

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
  return { platformNamespace: 'wasmcloud', declared: ['alpha'], dryRun: false, log, ...extra };
}

test('a removed tenant whose Tenant still exists keeps its runtime namespace watched (#227)', async () => {
  const { info, warn, log } = recorder();
  const namespaces = await operatorHostNamespaces(
    args({ listTenants: async () => ['zeta', 'beta', 'alpha', 'beta'] }, log),
  );
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
  expect(await operatorHostNamespaces(args({ listTenants: async () => ['alpha'] }, log))).toEqual([
    'wasmcloud',
    'di-runtime-alpha',
  ]);
  // A declared tenant whose Tenant does not exist yet (a first up) is watched too.
  expect(
    await operatorHostNamespaces(
      args({ declared: ['alpha', 'gamma'], listTenants: async () => [] }, log),
    ),
  ).toEqual(['wasmcloud', 'di-runtime-alpha', 'di-runtime-gamma']);
  expect(info).toEqual([]);
});

test('preview never lists Tenants and says when a removed namespace stops being watched', async () => {
  const { info, warn, log } = recorder();
  let calls = 0;
  const namespaces = await operatorHostNamespaces(
    args(
      {
        dryRun: true,
        listTenants: async () => {
          calls++;
          return ['beta'];
        },
      },
      log,
    ),
  );
  expect(calls).toBe(0);
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

test('a failed Tenant list fails the computation rather than shrinking the list', async () => {
  const { log } = recorder();
  await expect(
    operatorHostNamespaces(
      args(
        {
          listTenants: async () => {
            throw new Error('boom');
          },
        },
        log,
      ),
    ),
  ).rejects.toThrow('boom');
});

// A plain-HTTP fake Kubernetes API for the lister (client-node allows http only without TLS verify).
const hits: { path: string; auth: string | null }[] = [];
let status = 200;
let tenants: unknown = { items: [{ metadata: { name: 'alpha' } }, { metadata: {} }] };
let server: ReturnType<typeof Bun.serve>;
let url = '';

const kubeconfigFor = (clusters: Record<string, string>, current: string) =>
  `${[
    'apiVersion: v1',
    'kind: Config',
    `current-context: ${current}`,
    'clusters:',
    ...Object.entries(clusters).flatMap(([n, s]) => [
      `- name: ${n}`,
      '  cluster:',
      `    server: ${s}`,
      '    insecure-skip-tls-verify: true',
    ]),
    'users:',
    ...Object.keys(clusters).flatMap((n) => [`- name: ${n}`, '  user:', `    token: tok-${n}`]),
    'contexts:',
    ...Object.keys(clusters).flatMap((n) => [
      `- name: ${n}`,
      '  context:',
      `    cluster: ${n}`,
      `    user: ${n}`,
    ]),
  ].join('\n')}\n`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push({ path: `${u.pathname}${u.search}`, auth: req.headers.get('authorization') });
      if (status !== 200)
        return new Response('{"kind":"Status","message":"secret detail"}', { status });
      return Response.json(tenants);
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

test('tenantListerFromKubeconfig lists the installation Tenants with the given context', async () => {
  hits.length = 0;
  status = 200;
  tenants = { items: [{ metadata: { name: 'alpha' } }, { metadata: {} }] };
  const yaml = kubeconfigFor({ first: 'http://127.0.0.1:1', second: url }, 'first');
  expect(await tenantListerFromKubeconfig(yaml, 'di-test', 'second')()).toEqual(['alpha']);
  expect(hits).toEqual([
    {
      path: '/apis/platform.di-framework.dev/v1alpha1/tenants?labelSelector=platform.di-framework.dev%2Finstallation%3Ddi-test',
      auth: 'Bearer tok-second',
    },
  ]);
  // A list without items, and the kubeconfig's own current context without one given.
  tenants = {};
  expect(
    await tenantListerFromKubeconfig(kubeconfigFor({ only: url }, 'only'), 'di-test')(),
  ).toEqual([]);
});

test('a missing Tenant CRD (first install) lists no Tenants', async () => {
  status = 404;
  expect(await tenantListerFromKubeconfig(kubeconfigFor({ c: url }, 'c'), 'di-test')()).toEqual([]);
});

test('API errors name the installation and status, never the response body', async () => {
  status = 403;
  const failure = tenantListerFromKubeconfig(kubeconfigFor({ c: url }, 'c'), 'di-test')();
  await expect(failure).rejects.toThrow(
    "Cannot list the Tenants of installation di-test, which keep a removed tenant's runtime namespace watched by the wasmCloud operator until the Tenant is deleted (#227): HTTP 403",
  );
  await expect(failure).rejects.not.toThrow('secret detail');
});

test('an unusable kubeconfig fails with the same message and without its contents', async () => {
  const failure = tenantListerFromKubeconfig('token: hunter2', 'di-test')();
  await expect(failure).rejects.toThrow('Cannot list the Tenants of installation di-test');
  await expect(failure).rejects.not.toThrow('hunter2');
});
