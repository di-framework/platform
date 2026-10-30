import { type Api, ApiError, Controller, collection } from '../../src/tenancy/controller';
import {
  type ControllerConfig,
  INSTALLATION,
  type Resource,
  type Tenant,
  VERSION,
} from '../../src/tenancy/resources';
import { bootstrapSchedulerPki, SCHEDULER_IDENTITIES } from '../../src/tenancy/scheduler-pki';

/**
 * The controller-tick harness shared by the scheduler identity (#541 m6c) and accounts (m6d)
 * tests: an in-memory API server and one Tenant `alpha` in installation `test`.
 */
export const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
};
export const PKI = 'wasmcloud-scheduler-pki';
export const recordPath = `/api/v1/namespaces/${PKI}/configmaps/${SCHEDULER_IDENTITIES}`;
export const tenantPath = `${collection(VERSION, 'Tenant')}/alpha`;
export const START = new Date('2026-10-30T00:00:00Z');

const key = (v: { apiVersion: string; kind: string; metadata: Resource['metadata'] }) =>
  `${collection(v.apiVersion, v.kind, v.metadata.namespace)}/${v.metadata.name}`;

/** An in-memory API server for the controller's tick and the bootstrap's create and update calls. */
export class MemoryApi implements Api {
  objects = new Map<string, Resource>();
  operations: { method: string; path: string; body?: unknown }[] = [];
  private version = 1;
  seed(value: Resource | Tenant): void {
    this.objects.set(key(value), {
      ...structuredClone(value),
      metadata: { ...value.metadata, resourceVersion: String(this.version++) },
    } as Resource);
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.operations.push({ method, path, body });
    const url = new URL(path, 'https://kubernetes');
    const data = structuredClone(body) as Resource;
    const notFound = () => new ApiError(404, 'Not found');
    if (method === 'GET' && url.searchParams.has('labelSelector')) {
      const selector = url.searchParams.get('labelSelector') ?? '';
      const labels = selector ? selector.split(',').map((v) => v.split('=')) : [];
      return {
        items: [...this.objects.values()]
          .filter(
            (v) =>
              (collection(v.apiVersion, v.kind) === url.pathname ||
                collection(v.apiVersion, v.kind, v.metadata.namespace) === url.pathname) &&
              labels.every(([k, x]) => v.metadata.labels?.[k as string] === x),
          )
          .map(({ apiVersion: _v, kind: _k, ...item }) => structuredClone(item)),
      } as T;
    }
    const target = url.pathname.replace(/\/status$/, '');
    const existing = this.objects.get(target);
    if (method === 'GET') {
      if (!existing) throw notFound();
      return structuredClone(existing) as T;
    }
    if (method === 'DELETE') {
      if (!existing) throw notFound();
      this.objects.delete(target);
      return {} as T;
    }
    const stamp = (value: Resource) => {
      value.metadata.resourceVersion = String(this.version++);
      this.objects.set(key(value), value);
      return structuredClone(value) as T;
    };
    if (method === 'POST') return stamp(data);
    if (method === 'PUT') {
      if (!existing) throw notFound();
      if (data.metadata.resourceVersion !== existing.metadata.resourceVersion)
        throw new ApiError(409, 'Conflict');
      return stamp(data);
    }
    if (method === 'PATCH') {
      const rv = data.metadata?.resourceVersion;
      if (existing && rv && rv !== existing.metadata.resourceVersion)
        throw new ApiError(409, 'Conflict');
      const value = {
        ...existing,
        ...data,
        metadata: { ...existing?.metadata, ...data.metadata },
        ...(path.split('?')[0]?.endsWith('/status')
          ? { status: { ...(existing?.status as object), ...(data.status as object) } }
          : {}),
      } as Resource;
      value.metadata.uid ??= `${value.metadata.name}-uid`;
      value.metadata.generation ??= 1;
      if (value.kind === 'Deployment')
        value.status = {
          observedGeneration: value.metadata.generation,
          replicas: (value.spec as { replicas: number }).replicas,
        };
      return stamp(value);
    }
    throw new Error(`Unexpected ${method}`);
  }
}

export function tenant(): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec: {},
  };
}

/** `api` seeded with Tenant `alpha` and the PKI namespace, bootstrapped when `pki`, and a controller on `now`. */
export async function prepare<T extends MemoryApi>(
  api: T,
  options: { pki: boolean },
  now: () => Date,
): Promise<{ api: T; controller: Controller }> {
  api.seed(tenant());
  api.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'wasmcloud-runtime-tls', namespace: cfg.namespace },
    data: { 'ca.crt': 'test' },
  });
  api.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: PKI } });
  if (options.pki) await bootstrapSchedulerPki(api, cfg, START);
  return { api, controller: new Controller(api, cfg, async () => [], now) };
}

export const stored = (api: MemoryApi) => api.objects.get(tenantPath) as unknown as Tenant;
export const condition = (api: MemoryApi, type: string) =>
  stored(api).status?.conditions?.find((c) => c.type === type);
