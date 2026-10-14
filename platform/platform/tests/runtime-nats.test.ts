import { describe, expect, it } from 'bun:test';
import {
  assertRuntimeNatsConfig,
  type ControllerConfig,
  INSTALLATION,
  type Resource,
  RUNTIME_NATS_CONFIG,
  RUNTIME_NATS_CONFIG_ANNOTATION,
  RUNTIME_NATS_DEFAULTS,
  type RuntimeNatsConfig,
  runtimeNatsLimits,
  runtimeNatsServerConfig,
  type Tenant,
  tenantResources,
  VERSION,
} from '../src/tenancy/resources';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
};
function tenant(): Tenant {
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
interface Container {
  args: string[];
  volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
}
interface Deployment {
  spec: {
    template: {
      metadata: { annotations?: Record<string, string> };
      spec: {
        containers: Container[];
        volumes: { name: string; configMap?: { name: string }; hostPath?: { path: string } }[];
      };
    };
  };
}
function find(resources: Resource[], kind: string, name: string): Resource {
  const found = resources.find((r) => r.kind === kind && r.metadata.name === name);
  if (!found) throw new Error(`no ${kind} ${name}`);
  return found;
}
function natsConfig(resources: Resource[]): string {
  const map = find(resources, 'ConfigMap', RUNTIME_NATS_CONFIG) as unknown as {
    metadata: { namespace: string };
    data: Record<string, string>;
  };
  expect(map.metadata.namespace).toBe('di-runtime-alpha');
  return map.data['nats.conf'] ?? '';
}
const MiB = 2 ** 20;
const GiB = 2 ** 30;

describe('di-nats JetStream storage caps (#160)', () => {
  it('caps file and memory storage with the defaults when nothing is configured', () => {
    expect(runtimeNatsLimits(undefined)).toEqual({
      maxFileStore: 10 * GiB,
      maxMemoryStore: 32 * MiB,
    });
    const text = natsConfig(tenantResources(tenant(), cfg));
    expect(text).toContain('jetstream {');
    expect(text).toContain('store_dir: "/data"');
    expect(text).toContain(`max_file_store: ${10 * GiB}`);
    expect(text).toContain(`max_memory_store: ${32 * MiB}`);
  });

  it('renders configured caps in bytes', () => {
    const resources = tenantResources(tenant(), {
      ...cfg,
      runtimeNats: { maxFileStore: '2Ti', maxMemoryStore: '64Mi' },
    });
    const text = natsConfig(resources);
    expect(text).toContain(`max_file_store: ${2 * 1024 * GiB}`);
    expect(text).toContain(`max_memory_store: ${64 * MiB}`);
    expect(runtimeNatsLimits({ maxFileStore: '1048576' }).maxFileStore).toBe(MiB);
    expect(runtimeNatsLimits({ maxFileStore: '3Gi', maxMemoryStore: '1024Ki' })).toEqual({
      maxFileStore: 3 * GiB,
      maxMemoryStore: MiB,
    });
  });

  it('runs di-nats from the mounted config on the same host-path store directory', () => {
    const resources = tenantResources(tenant(), cfg);
    const deployment = find(resources, 'Deployment', 'di-nats') as unknown as Deployment;
    const pod = deployment.spec.template.spec;
    const container = pod.containers[0] as Container;
    expect(container.args).toEqual(['-c', '/etc/nats/nats.conf']);
    expect(container.volumeMounts).toEqual([
      { name: 'data', mountPath: '/data' },
      { name: 'config', mountPath: '/etc/nats', readOnly: true },
    ]);
    expect(pod.volumes).toContainEqual({
      name: 'config',
      configMap: { name: RUNTIME_NATS_CONFIG },
    });
    expect(pod.volumes[0]?.hostPath?.path).toBe('/var/lib/k0s/di-tenants/alpha-uid/di-nats');
    // The ConfigMap is applied before the Deployment that mounts it.
    const index = (kind: string, name: string) =>
      resources.findIndex((r) => r.kind === kind && r.metadata.name === name);
    expect(index('ConfigMap', RUNTIME_NATS_CONFIG)).toBeLessThan(index('Deployment', 'di-nats'));
  });

  it('restarts di-nats when the caps change, and only then', () => {
    const digest = (runtimeNats?: RuntimeNatsConfig) =>
      (
        find(
          tenantResources(tenant(), { ...cfg, runtimeNats }),
          'Deployment',
          'di-nats',
        ) as unknown as Deployment
      ).spec.template.metadata.annotations?.[RUNTIME_NATS_CONFIG_ANNOTATION];
    expect(digest()).toMatch(/^[0-9a-f]{64}$/);
    expect(digest({ ...RUNTIME_NATS_DEFAULTS })).toBe(digest());
    expect(digest({ maxFileStore: '20Gi' })).not.toBe(digest());
  });

  it('leaves di-redis without the NATS config', () => {
    const redis = find(
      tenantResources(tenant(), cfg),
      'Deployment',
      'di-redis',
    ) as unknown as Deployment;
    expect(redis.spec.template.metadata.annotations).toBeUndefined();
    expect(redis.spec.template.spec.volumes.map((v) => v.name)).toEqual(['data']);
    expect(redis.spec.template.spec.containers[0]?.volumeMounts).toEqual([
      { name: 'data', mountPath: '/data' },
    ]);
  });

  it('accepts valid configs', () => {
    expect(() => assertRuntimeNatsConfig(undefined)).not.toThrow();
    expect(() => assertRuntimeNatsConfig({})).not.toThrow();
    expect(() =>
      assertRuntimeNatsConfig({ maxFileStore: '1Mi', maxMemoryStore: '127Mi' }),
    ).not.toThrow();
  });

  it.each([
    [[], 'runtimeNats must be an object'],
    ['10Gi', 'runtimeNats must be an object'],
    [
      { maxStore: '1Gi' },
      'runtimeNats.maxStore is not a known setting (maxFileStore, maxMemoryStore)',
    ],
    [{ maxFileStore: '10GB' }, 'runtimeNats.maxFileStore must be a positive binary quantity'],
    [{ maxFileStore: 1024 }, 'runtimeNats.maxFileStore must be a positive binary quantity'],
    [{ maxFileStore: '0' }, 'runtimeNats.maxFileStore must be a positive binary quantity'],
    [{ maxFileStore: '-1Gi' }, 'runtimeNats.maxFileStore must be a positive binary quantity'],
    [{ maxFileStore: '1.5Gi' }, 'runtimeNats.maxFileStore must be a positive binary quantity'],
    [
      { maxFileStore: '99999999999Ti' },
      'runtimeNats.maxFileStore must be a positive binary quantity',
    ],
    [{ maxFileStore: '1023Ki' }, 'runtimeNats.maxFileStore must be at least 1Mi'],
    [{ maxMemoryStore: '' }, 'runtimeNats.maxMemoryStore must be a positive binary quantity'],
    [
      { maxMemoryStore: '128Mi' },
      'runtimeNats.maxMemoryStore must be below the di-nats memory limit (128Mi)',
    ],
    [
      { maxMemoryStore: '1Gi' },
      'runtimeNats.maxMemoryStore must be below the di-nats memory limit (128Mi)',
    ],
  ] as const)('rejects %p', (value, message) => {
    expect(() => assertRuntimeNatsConfig(value as unknown as RuntimeNatsConfig)).toThrow(message);
    expect(() =>
      tenantResources(tenant(), { ...cfg, runtimeNats: value as unknown as RuntimeNatsConfig }),
    ).toThrow(message);
  });

  it('renders the JetStream block with both caps in bytes', () => {
    expect(runtimeNatsServerConfig({ maxFileStore: GiB, maxMemoryStore: MiB })).toBe(
      [
        'port: 4222',
        'jetstream {',
        '  store_dir: "/data"',
        `  max_file_store: ${GiB}`,
        `  max_memory_store: ${MiB}`,
        '}',
        '',
      ].join('\n'),
    );
  });
});
