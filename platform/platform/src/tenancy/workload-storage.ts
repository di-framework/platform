import type { ControllerConfig, Resource, Tenant } from './resources';

/**
 * Platform-managed persistent directory for tenant workloads (#11).
 *
 * A tenant WorkloadDeployment asks for storage with an annotation and carries no volume
 * fields. The controller mounts `<storageRoot>/di-tenants/<tenant uid>/workloads/<key>`
 * into the tenant host pod and patches the matching hostPath volume and guest preopen
 * into the WorkloadDeployment. Members sharing `di-framework.dev/workload` share `<key>`.
 */

export const STORAGE_ANNOTATION = 'di-framework.dev/persistent-storage';
export const STORAGE_MOUNT_ANNOTATION = 'di-framework.dev/storage-mount';
/** Guest preopen paths the platform accepts. Actor workloads keep their state under /data/actors. */
export const GUEST_MOUNT_PATHS = ['/data', '/data/actors'] as const;
/** Where the tenant host container sees each workload directory. */
export const HOST_MOUNT_ROOT = '/var/lib/di-framework/workloads';
export const WORKLOAD_VOLUME = 'di-storage';
/** The host runs as this uid with a read-only root; the directory must be writable by it. */
export const HOST_UID = 65532;
/** Fixed image for the ownership init step — never tenant-supplied. */
export const STORAGE_INIT_IMAGE = 'busybox:1.37.0';
/** Field manager for the controller's WorkloadDeployment patch. */
export const STORAGE_FIELD_MANAGER = 'di-platform-storage';

const WORKLOAD_LABEL = 'di-framework.dev/workload';
const APPLICATION_LABEL = 'di-framework.dev/application';
const STORAGE_KEY = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

interface WorkloadMetadata {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  resourceVersion?: string;
}

interface LocalResources {
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
  [key: string]: unknown;
}

interface Component {
  name?: string;
  localResources?: LocalResources;
  [key: string]: unknown;
}

export interface WorkloadDeployment {
  apiVersion?: string;
  kind?: string;
  metadata: WorkloadMetadata;
  spec?: {
    template?: {
      spec?: {
        volumes?: { name: string; hostPath?: { path: string } }[];
        components?: Component[];
        [key: string]: unknown;
      };
    };
    [key: string]: unknown;
  };
}

export function wantsStorage(workload: WorkloadDeployment): boolean {
  return workload.metadata.annotations?.[STORAGE_ANNOTATION] === 'true';
}

/**
 * Directory key shared by a workload's members. The value must be a DNS label short enough
 * for a host volume name; anything else gets no storage rather than a guessed path.
 */
export function storageKey(workload: WorkloadDeployment): string | undefined {
  const key =
    workload.metadata.labels?.[WORKLOAD_LABEL] ??
    workload.metadata.labels?.[APPLICATION_LABEL] ??
    workload.metadata.name;
  return key.length <= 50 && STORAGE_KEY.test(key) ? key : undefined;
}

export function guestMountPath(workload: WorkloadDeployment): string | undefined {
  const requested = workload.metadata.annotations?.[STORAGE_MOUNT_ANNOTATION] ?? '/data';
  return (GUEST_MOUNT_PATHS as readonly string[]).includes(requested) ? requested : undefined;
}

/** Sorted, de-duplicated keys of every workload that asked for storage. */
export function storageKeys(workloads: WorkloadDeployment[]): string[] {
  const keys = new Set<string>();
  for (const workload of workloads) {
    if (!wantsStorage(workload)) continue;
    const key = storageKey(workload);
    if (key && guestMountPath(workload)) keys.add(key);
  }
  return [...keys].sort();
}

export function nodeStoragePath(tenant: Tenant, cfg: ControllerConfig, key: string): string {
  return `${cfg.storageRoot ?? '/var/lib/k0s'}/di-tenants/${tenant.metadata.uid}/workloads/${key}`;
}

export function hostStoragePath(key: string): string {
  return `${HOST_MOUNT_ROOT}/${key}`;
}

/**
 * Host pod additions for the given keys: one DirectoryOrCreate volume and mount per key,
 * plus a root init container that hands each directory (not its contents) to the host uid.
 */
export function hostStorage(
  tenant: Tenant,
  cfg: ControllerConfig,
  keys: string[],
): {
  volumes: Record<string, unknown>[];
  volumeMounts: Record<string, unknown>[];
  initContainers: Record<string, unknown>[];
} {
  if (keys.length === 0) return { volumes: [], volumeMounts: [], initContainers: [] };
  const volumes = keys.map((key) => ({
    name: `ws-${key}`,
    hostPath: { path: nodeStoragePath(tenant, cfg, key), type: 'DirectoryOrCreate' },
  }));
  const volumeMounts = keys.map((key) => ({ name: `ws-${key}`, mountPath: hostStoragePath(key) }));
  return {
    volumes,
    volumeMounts,
    initContainers: [
      {
        name: 'storage-owner',
        image: STORAGE_INIT_IMAGE,
        imagePullPolicy: 'IfNotPresent',
        command: ['chown', `${HOST_UID}:${HOST_UID}`, ...keys.map(hostStoragePath)],
        securityContext: {
          runAsUser: 0,
          runAsGroup: 0,
          runAsNonRoot: false,
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'], add: ['CHOWN'] },
        },
        resources: {
          requests: { cpu: '10m', memory: '16Mi' },
          limits: { cpu: '100m', memory: '32Mi' },
        },
        volumeMounts,
      },
    ],
  };
}

/**
 * The volume and preopen fields the controller owns on a WorkloadDeployment, or undefined
 * when the workload already carries exactly those fields.
 */
export function storagePatch(workload: WorkloadDeployment): Resource | undefined {
  const key = storageKey(workload);
  const mountPath = guestMountPath(workload);
  const template = workload.spec?.template?.spec;
  if (!key || !mountPath || !template) return undefined;
  const volumes = [{ name: WORKLOAD_VOLUME, hostPath: { path: hostStoragePath(key) } }];
  const components = (template.components ?? []).map((component) => {
    const mounts = (component.localResources?.volumeMounts ?? []).filter(
      (mount) => mount.name !== WORKLOAD_VOLUME,
    );
    return {
      ...component,
      localResources: {
        ...component.localResources,
        volumeMounts: [...mounts, { name: WORKLOAD_VOLUME, mountPath }],
      },
    };
  });
  if (
    JSON.stringify(template.volumes ?? []) === JSON.stringify(volumes) &&
    JSON.stringify(template.components ?? []) === JSON.stringify(components)
  )
    return undefined;
  return {
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'WorkloadDeployment',
    metadata: {
      name: workload.metadata.name,
      namespace: workload.metadata.namespace,
      resourceVersion: workload.metadata.resourceVersion,
    },
    spec: { template: { spec: { volumes, components } } },
  };
}
