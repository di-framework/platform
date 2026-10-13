import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { handle } from './console.ts';
import { applyActions, type KubeClient, KubeError, loadWorld } from './kube.ts';
import { leaderTick, releaseLease } from './leader.ts';
import { runtimeNamespaceFor } from './model.ts';
import { reconcileAll } from './reconcile.ts';

const serviceAccountCa = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const clusterCa = existsSync(serviceAccountCa) ? readFileSync(serviceAccountCa, 'utf8') : undefined;

const tenantNamespace = process.env.TENANT_NAMESPACE ?? '';
const agentImage = process.env.AGENT_IMAGE ?? 'di-framework/backup-agent:dev';
const storageRoot = process.env.STORAGE_ROOT || undefined;
const identity = `${process.env.POD_NAME || hostname()}-${randomUUID().slice(0, 8)}`;
runtimeNamespaceFor(tenantNamespace);

function clusterClient(): KubeClient {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) throw new Error('KUBERNETES_SERVICE_HOST is not set');
  const token = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
  const base = `https://${host}:${port}`;
  async function call(
    method: string,
    path: string,
    body?: unknown,
    contentType?: string,
  ): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': contentType ?? 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Bun's compiled binary does not honor NODE_EXTRA_CA_CERTS. The API
      // certificate is signed by the in-cluster CA and named for the Service.
      tls: clusterCa ? { ca: clusterCa, serverName: 'kubernetes.default.svc' } : undefined,
    } as RequestInit);
    if (!response.ok) {
      throw new KubeError(response.status, `${method} ${path} failed: ${response.status}`);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    patch: (path, body) => call('PATCH', path, body, 'application/merge-patch+json'),
    remove: async (path) => {
      await call('DELETE', path);
    },
  };
}

const client = clusterClient();

// No overlapping ticks, and only the Lease holder reconciles (#232 W2).
const tick = leaderTick({
  client,
  namespace: tenantNamespace,
  identity,
  async reconcile() {
    const world = await loadWorld(
      client,
      tenantNamespace,
      agentImage,
      new Date().toISOString(),
      storageRoot,
    );
    await applyActions(client, world, reconcileAll(world));
  },
});

process.on('SIGTERM', () => {
  void releaseLease(client, tenantNamespace, identity).finally(() => process.exit(0));
});

Bun.serve({
  hostname: '0.0.0.0',
  port: 8080,
  async fetch(request) {
    const world = await loadWorld(
      client,
      tenantNamespace,
      agentImage,
      new Date().toISOString(),
      storageRoot,
    );
    const body = request.method === 'POST' ? await request.text() : '';
    const url = new URL(request.url);
    const result = handle(request.method, url.pathname, body, world);
    if (result.actions.length > 0) await applyActions(client, world, result.actions);
    return new Response(result.html, {
      status: result.status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
});

setInterval(() => {
  void tick().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'backup tick failed');
  });
}, 3_000);
