import { describe, expect, it, spyOn } from 'bun:test';
import { admissionResources, workloadVolumesAllowed } from '../src/tenancy/admission';
import { type Api, Controller, collection } from '../src/tenancy/controller';
import { CONTROLLER_SCRIPT_MODULES, controllerClusterRoleRules } from '../src/tenancy/install';
import {
  type ControllerConfig,
  INSTALLATION,
  names,
  natsHostPort,
  type Resource,
  RUNTIME_NATS_IMAGE,
  type Tenant,
  tenantResources,
  VERSION,
} from '../src/tenancy/resources';
import {
  guestMountPath,
  HOST_UID,
  hostStorage,
  nodeStoragePath,
  STORAGE_ANNOTATION,
  STORAGE_FIELD_MANAGER,
  STORAGE_MOUNT_ANNOTATION,
  storageKey,
  storageKeys,
  storagePatch,
  type WorkloadDeployment,
  wantsStorage,
} from '../src/tenancy/workload-storage';

const cfg: ControllerConfig = {
  installation: 'test',
  namespace: 'wasmcloud',
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
};

function tenant(replicas?: number): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec: replicas === undefined ? {} : { runtime: { replicas } },
  };
}

function workload(
  name: string,
  opts: { workload?: string; storage?: boolean; mount?: string; mounts?: unknown[] } = {},
): WorkloadDeployment {
  return {
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'WorkloadDeployment',
    metadata: {
      name,
      namespace: 'di-tenant-alpha',
      resourceVersion: '7',
      labels: {
        'app.kubernetes.io/managed-by': 'di-framework',
        'di-framework.dev/application': name,
        ...(opts.workload ? { 'di-framework.dev/workload': opts.workload } : {}),
      },
      annotations: {
        ...(opts.storage === false ? {} : { [STORAGE_ANNOTATION]: 'true' }),
        ...(opts.mount ? { [STORAGE_MOUNT_ANNOTATION]: opts.mount } : {}),
      },
    },
    spec: {
      template: {
        spec: {
          environment: 'di-tenant-alpha',
          components: [
            {
              name,
              image: 'registry/app:1',
              localResources: {
                environment: { config: { DI_STORAGE_DIR: '/data' } },
                ...(opts.mounts ? { volumeMounts: opts.mounts } : {}),
              },
            },
          ],
        },
      },
    },
  } as WorkloadDeployment;
}

describe('storage keys and paths', () => {
  it('shares one key across a workload and isolates everyone else', () => {
    expect(storageKey(workload('mesh-collector', { workload: 'mesh' }))).toBe('mesh');
    expect(storageKey(workload('mesh-site', { workload: 'mesh' }))).toBe('mesh');
    expect(storageKey(workload('greeter'))).toBe('greeter');
    expect(storageKey({ metadata: { name: 'bare' } } as WorkloadDeployment)).toBe('bare');
    expect(
      storageKeys([
        workload('mesh-collector', { workload: 'mesh' }),
        workload('mesh-site', { workload: 'mesh' }),
        workload('greeter'),
        workload('stateless', { storage: false }),
      ]),
    ).toEqual(['greeter', 'mesh']);
  });

  it('refuses keys that could escape or exceed a volume name', () => {
    expect(storageKey(workload('x', { workload: '..' }))).toBeUndefined();
    expect(storageKey(workload('x', { workload: 'a/b' }))).toBeUndefined();
    expect(storageKey(workload('x', { workload: 'A' }))).toBeUndefined();
    expect(storageKey(workload('x', { workload: 'a'.repeat(51) }))).toBeUndefined();
    expect(storageKeys([workload('x', { workload: '..' })])).toEqual([]);
  });

  it('accepts only the platform guest mount paths', () => {
    expect(guestMountPath(workload('a'))).toBe('/data');
    expect(guestMountPath(workload('a', { mount: '/data/actors' }))).toBe('/data/actors');
    expect(guestMountPath(workload('a', { mount: '/etc' }))).toBeUndefined();
    expect(storageKeys([workload('a', { mount: '/etc' })])).toEqual([]);
    expect(wantsStorage(workload('a', { storage: false }))).toBe(false);
  });

  it('places each directory under the tenant uid', () => {
    expect(nodeStoragePath(tenant(), cfg, 'mesh')).toBe(
      '/var/lib/k0s/di-tenants/alpha-uid/workloads/mesh',
    );
    expect(nodeStoragePath(tenant(), { ...cfg, storageRoot: '/srv' }, 'mesh')).toBe(
      '/srv/di-tenants/alpha-uid/workloads/mesh',
    );
  });
});

describe('tenant host pod', () => {
  function host(keys: string[]) {
    const deployment = tenantResources(tenant(), cfg, { data: { 'ca.crt': 'x' } }, keys).find(
      (r) => r.kind === 'Deployment' && r.metadata.name === 'hostgroup-tenant-alpha',
    );
    return ((deployment as Resource).spec as { template: { spec: Record<string, unknown> } })
      .template.spec as {
      initContainers?: Record<string, unknown>[];
      containers: { securityContext: Record<string, unknown>; volumeMounts: unknown[] }[];
      volumes: unknown[];
    };
  }

  it('replaces the host in place with or without workload storage', () => {
    const strategy = (keys: string[]) =>
      (
        (
          tenantResources(tenant(), cfg, { data: { 'ca.crt': 'x' } }, keys).find(
            (r) => r.kind === 'Deployment' && r.metadata.name === 'hostgroup-tenant-alpha',
          ) as Resource
        ).spec as { strategy?: unknown }
      ).strategy;
    const expected = {
      type: 'RollingUpdate',
      rollingUpdate: { maxSurge: 0, maxUnavailable: 1 },
    };
    expect(strategy([])).toEqual(expected);
    expect(strategy(['mesh'])).toEqual(expected);
  });

  it('lists the workloads root without a chown step when no workload asks for storage', () => {
    const spec = host([]);
    // The NATS wait (#470), then only the storage-mode listing (#200); no storage chown step.
    expect(spec.initContainers?.map((c) => c.name)).toEqual(['wait-for-nats', 'storage-mode']);
    expect(spec.volumes).toHaveLength(4);
    const storage = hostStorage(tenant(), cfg, []);
    expect(storage.volumeMounts).toEqual([]);
    expect(storage.volumes).toEqual([
      {
        name: 'ws-root',
        hostPath: {
          path: '/var/lib/k0s/di-tenants/alpha-uid/workloads',
          type: 'DirectoryOrCreate',
        },
      },
    ]);
    expect(storage.initContainers.map((c) => c.name)).toEqual(['storage-mode']);
  });

  it('mounts one DirectoryOrCreate directory per key and chowns only those paths', () => {
    const spec = host(['greeter', 'mesh']);
    expect(spec.volumes).toContainEqual({
      name: 'ws-mesh',
      hostPath: {
        path: '/var/lib/k0s/di-tenants/alpha-uid/workloads/mesh',
        type: 'DirectoryOrCreate',
      },
    });
    expect(spec.containers[0]?.volumeMounts).toContainEqual({
      name: 'ws-mesh',
      mountPath: '/var/lib/di-framework/workloads/mesh',
    });
    // The host itself stays non-root with a read-only root filesystem.
    expect(spec.containers[0]?.securityContext).toMatchObject({ readOnlyRootFilesystem: true });
    // The storage chown step follows the NATS wait (#470).
    expect(spec.initContainers?.map((c) => c.name)[0]).toBe('wait-for-nats');
    const init = spec.initContainers?.[1] as {
      command: string[];
      securityContext: Record<string, unknown>;
    };
    expect(init.command).toEqual([
      'chown',
      `${HOST_UID}:${HOST_UID}`,
      '/var/lib/di-framework/workloads/greeter',
      '/var/lib/di-framework/workloads/mesh',
    ]);
    expect(init.command).not.toContain('-R');
    expect(init.securityContext).toMatchObject({
      runAsUser: 0,
      runAsNonRoot: false,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'], add: ['CHOWN'] },
    });
  });
});

describe('tenant host NATS wait (#470)', () => {
  function initContainers(t: Tenant, schedulerNatsUrl = cfg.schedulerNatsUrl) {
    const deployment = tenantResources(
      t,
      { ...cfg, schedulerNatsUrl },
      { data: { 'ca.crt': 'x' } },
      [],
    ).find((r) => r.kind === 'Deployment' && r.metadata.name === 'hostgroup-tenant-alpha');
    return (
      (deployment as Resource).spec as {
        template: { spec: { initContainers: Record<string, unknown>[] } };
      }
    ).template.spec.initContainers;
  }

  it('waits for the scheduler and data NATS before the host starts', () => {
    const [wait] = initContainers(tenant(), 'nats://nats.wasmcloud.svc.cluster.local:4222');
    expect(wait).toMatchObject({
      name: 'wait-for-nats',
      image: RUNTIME_NATS_IMAGE,
      resources: {
        requests: { cpu: '10m', memory: '16Mi' },
        limits: { cpu: '100m', memory: '32Mi' },
      },
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      },
    });
    const command = wait?.command as string[];
    expect(command.slice(0, 2)).toEqual(['sh', '-c']);
    const script = command[2] as string;
    expect(script).toContain(
      'for t in nats.wasmcloud.svc.cluster.local:4222 di-nats.di-runtime-alpha.svc.cluster.local:4222; do',
    );
    expect(script).toContain('nc -z -w 2 "$h" "$p"');
    expect(script).toContain('sleep 2');
    expect(script).toContain('+ 600 ))');
    expect(script).toContain('exit 1');
  });

  it('defaults to the NATS port when the URL names none', () => {
    expect(natsHostPort('nats://nats.example')).toBe('nats.example:4222');
    expect(natsHostPort('nats://nats.example:4333')).toBe('nats.example:4333');
  });

  it('still renders for a suspended tenant', () => {
    const t = tenant(0);
    t.spec.suspended = true;
    expect(initContainers(t)[0]?.name).toBe('wait-for-nats');
  });
});

describe('storagePatch', () => {
  it('adds the platform volume and the guest preopen', () => {
    const patch = storagePatch(workload('mesh-site', { workload: 'mesh' }));
    expect(patch?.metadata).toEqual({
      name: 'mesh-site',
      namespace: 'di-tenant-alpha',
      resourceVersion: '7',
    });
    const spec = ((patch as Resource).spec as { template: { spec: Record<string, unknown> } })
      .template.spec;
    expect(spec.volumes).toEqual([
      { name: 'di-storage', hostPath: { path: '/var/lib/di-framework/workloads/mesh' } },
    ]);
    expect(spec.components).toEqual([
      {
        name: 'mesh-site',
        image: 'registry/app:1',
        localResources: {
          environment: { config: { DI_STORAGE_DIR: '/data' } },
          volumeMounts: [{ name: 'di-storage', mountPath: '/data' }],
        },
      },
    ]);
  });

  it('is idempotent once applied and replaces a stale platform mount', () => {
    const applied = workload('a', { mount: '/data/actors' });
    const spec = applied.spec?.template?.spec as NonNullable<
      NonNullable<WorkloadDeployment['spec']>['template']
    >['spec'] & { components: { localResources: Record<string, unknown> }[] };
    spec.volumes = [
      { name: 'di-storage', hostPath: { path: '/var/lib/di-framework/workloads/a' } },
    ];
    (
      spec.components[0] as { localResources: Record<string, unknown> }
    ).localResources.volumeMounts = [{ name: 'di-storage', mountPath: '/data/actors' }];
    expect(storagePatch(applied)).toBeUndefined();
    const stale = workload('a', { mounts: [{ name: 'di-storage', mountPath: '/old' }] });
    const components = (
      (storagePatch(stale) as Resource).spec as {
        template: { spec: { components: { localResources: { volumeMounts: unknown[] } }[] } };
      }
    ).template.spec.components;
    expect(components[0]?.localResources.volumeMounts).toEqual([
      { name: 'di-storage', mountPath: '/data' },
    ]);
  });

  it('treats the API server key order as already applied', () => {
    const applied = workload('a');
    const spec = applied.spec?.template?.spec as NonNullable<
      NonNullable<WorkloadDeployment['spec']>['template']
    >['spec'] & { components: { localResources: Record<string, unknown> }[] };
    spec.volumes = [
      { hostPath: { path: '/var/lib/di-framework/workloads/a' }, name: 'di-storage' },
    ];
    (
      spec.components[0] as { localResources: Record<string, unknown> }
    ).localResources.volumeMounts = [{ mountPath: '/data', name: 'di-storage' }];
    expect(storagePatch(applied)).toBeUndefined();
  });

  it('does nothing for unusable keys, mounts, or a missing template', () => {
    expect(storagePatch(workload('x', { workload: '..' }))).toBeUndefined();
    expect(storagePatch(workload('x', { mount: '/etc' }))).toBeUndefined();
    expect(storagePatch({ metadata: { name: 'x' } })).toBeUndefined();
    const empty = storagePatch({ metadata: { name: 'x' }, spec: { template: { spec: {} } } });
    expect(
      ((empty as Resource).spec as { template: { spec: Record<string, unknown> } }).template.spec,
    ).toEqual({
      volumes: [{ name: 'di-storage', hostPath: { path: '/var/lib/di-framework/workloads/x' } }],
      components: [],
    });
  });
});

class StorageApi implements Api {
  workloads: WorkloadDeployment[] = [];
  patches: { path: string; body: Resource; contentType?: string }[] = [];
  async call<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
    const url = new URL(path, 'https://kubernetes');
    const list = collection(
      'runtime.wasmcloud.dev/v1alpha1',
      'WorkloadDeployment',
      names('alpha').namespace,
    );
    if (method === 'GET' && url.pathname === list) {
      expect(url.searchParams.get('labelSelector')).toBe(
        'app.kubernetes.io/managed-by=di-framework',
      );
      return {
        items: this.workloads.map(({ metadata: { namespace: _n, ...metadata }, ...rest }) => ({
          ...rest,
          metadata,
        })),
      } as T;
    }
    if (method === 'PATCH') {
      this.patches.push({ path, body: body as Resource, contentType });
      return body as T;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  }
}

describe('Controller.reconcileWorkloadStorage', () => {
  it('patches storage workloads with its own field manager and skips the rest', async () => {
    const api = new StorageApi();
    api.workloads = [
      workload('mesh-collector', { workload: 'mesh' }),
      workload('stateless', { storage: false }),
    ];
    // Only a key recorded with the workload's kind gets the patch (#200).
    const recorded = { ...tenant(), status: { storage: { keys: { mesh: { kind: 'Other' } } } } };
    await new Controller(api, cfg).reconcileWorkloadStorage(recorded);
    expect(api.patches).toHaveLength(1);
    expect(api.patches[0]?.path).toBe(
      `/apis/runtime.wasmcloud.dev/v1alpha1/namespaces/di-tenant-alpha/workloaddeployments/mesh-collector?fieldManager=${STORAGE_FIELD_MANAGER}`,
    );
    expect(api.patches[0]?.contentType).toBe('application/merge-patch+json');
    expect(api.patches[0]?.body.metadata.namespace).toBe('di-tenant-alpha');
  });

  it('does not patch again once the fields are in place', async () => {
    const api = new StorageApi();
    const applied = workload('a');
    const patch = storagePatch(applied);
    applied.spec = {
      template: {
        spec: {
          ...applied.spec?.template?.spec,
          ...((patch as Resource).spec as { template: { spec: object } }).template.spec,
        },
      },
    };
    api.workloads = [applied];
    await new Controller(api, cfg).reconcileWorkloadStorage(tenant());
    expect(api.patches).toHaveLength(0);
  });

  it('gives a multi-replica tenant runtime no storage', async () => {
    const api = new StorageApi();
    api.workloads = [workload('a')];
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await new Controller(api, cfg).reconcileWorkloadStorage(tenant(2));
      expect(api.patches).toHaveLength(0);
      expect(errors).toHaveBeenCalledWith(
        'Tenant/alpha storage: persistent storage needs a single runtime replica',
      );
    } finally {
      errors.mockRestore();
    }
  });

  it('treats a missing list body as no workloads', async () => {
    const api = { call: async () => undefined } as Api;
    await new Controller(api, cfg).reconcileWorkloadStorage(tenant());
  });

  it('runs from tick before log projection and never blocks reconciliation', async () => {
    const controller = new Controller(new StorageApi(), cfg);
    const storage = spyOn(controller, 'reconcileWorkloadStorage').mockRejectedValue(
      new Error('no'),
    );
    const logs = spyOn(controller, 'projectLogs').mockResolvedValue();
    const reconcile = spyOn(controller, 'reconcileTenant').mockResolvedValue();
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const listing = spyOn(
      controller as unknown as { list: (...args: unknown[]) => Promise<unknown[]> },
      'list',
    ).mockImplementation(async (_v: unknown, kind: unknown) =>
      kind === 'Tenant' ? [tenant()] : [],
    );
    try {
      await controller.tick();
      expect(storage).toHaveBeenCalledTimes(1);
      expect(logs).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith('Tenant/alpha storage: no');
      storage.mockRejectedValue('not an error');
      await controller.tick();
      expect(errors).toHaveBeenCalledWith('Tenant/alpha storage: Storage reconcile failed');
    } finally {
      listing.mockRestore();
      errors.mockRestore();
    }
  });
});

describe('storage admission and install', () => {
  const tenantUser = 'system:serviceaccount:wasmcloud:di-user-dev';
  const controller = 'system:serviceaccount:wasmcloud:di-platform-controller';
  const platformVolume = [
    { name: 'di-storage', hostPath: { path: '/var/lib/di-framework/workloads/mesh' } },
  ];
  const base = { controllerNamespace: 'wasmcloud', volumeMounts: [] as { name: string }[][] };

  it('denies tenant-authored host volumes and preopens', () => {
    expect(
      workloadVolumesAllowed({
        ...base,
        username: tenantUser,
        operation: 'CREATE',
        volumes: platformVolume,
      }),
    ).toBe(false);
    expect(
      workloadVolumesAllowed({
        ...base,
        username: tenantUser,
        operation: 'CREATE',
        volumeMounts: [[{ name: 'di-storage' }]],
      }),
    ).toBe(false);
    // Changing the controller's path on update is denied.
    expect(
      workloadVolumesAllowed({
        ...base,
        username: tenantUser,
        operation: 'UPDATE',
        oldVolumes: platformVolume,
        volumes: [{ name: 'di-storage', hostPath: { path: '/var/lib/k0s/di-tenants/x/di-nats' } }],
      }),
    ).toBe(false);
    // A preopen of anything other than the kept volume is denied.
    expect(
      workloadVolumesAllowed({
        ...base,
        username: tenantUser,
        operation: 'UPDATE',
        oldVolumes: platformVolume,
        volumes: platformVolume,
        volumeMounts: [[{ name: 'other' }]],
      }),
    ).toBe(false);
  });

  it('lets a tenant redeploy keep the controller volume, and the controller set it', () => {
    expect(
      workloadVolumesAllowed({
        ...base,
        username: tenantUser,
        operation: 'UPDATE',
        oldVolumes: platformVolume,
        volumes: platformVolume,
        volumeMounts: [[{ name: 'di-storage' }], []],
      }),
    ).toBe(true);
    expect(workloadVolumesAllowed({ ...base, username: tenantUser, operation: 'CREATE' })).toBe(
      true,
    );
    expect(
      workloadVolumesAllowed({
        ...base,
        username: controller,
        operation: 'UPDATE',
        volumes: platformVolume,
        volumeMounts: [[{ name: 'di-storage' }]],
      }),
    ).toBe(true);
  });

  it('expresses the same rules in CEL', () => {
    const policy = JSON.stringify(admissionResources('test', 'wasmcloud'));
    expect(policy).toContain(
      "request.userInfo.username == 'system:serviceaccount:wasmcloud:di-platform-controller'",
    );
    expect(policy).toContain('variables.w.volumes == oldObject.spec.template.spec.volumes');
    expect(policy).toContain('variables.controller || variables.keptVolumes');
  });

  it('ships workload-storage with the controller and grants patch, plus create/delete for the registry (#83)', () => {
    expect(CONTROLLER_SCRIPT_MODULES).toContain('workload-storage');
    expect(
      controllerClusterRoleRules().find((r) => r.resources.includes('workloaddeployments')),
    ).toEqual({
      apiGroups: ['runtime.wasmcloud.dev'],
      resources: ['workloaddeployments'],
      // update only because the di-developer Role it writes grants it (#115).
      verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
    });
  });
});
