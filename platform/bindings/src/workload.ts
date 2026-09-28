import { defineMetadata, getOwnMetadata } from '@di-framework/core/container';

export const WORKLOAD_KEY = 'di:workload';
export const WORKLOAD_COMPONENT_KEY = 'di:workload-component';
export const WORKLOAD_SERVICE_KEY = 'di:workload-service';

export type WorkloadFetchHandler = (request: Request) => Response | Promise<Response>;
export type WorkloadRunHandler = () => Promise<void>;

export type WorkloadMetadata = {
  name: string;
};

export type WorkloadComponentOptions = {
  /** Optional legacy assertion; deployment membership comes from di-framework.config.json. */
  workload?: string;
  /** Path identifying this component within its implicit workload. */
  path: string;
};

export type WorkloadServiceOptions = {
  /** Path identifying this service within its implicit workload. */
  path: string;
  /** Optional legacy assertion; deployment membership comes from di-framework.config.json. */
  workload?: string;
  /** Broker subjects delivered to this service by the host. */
  subscriptions?: string[];
};

function requireName(kind: string, name: string): string {
  if (!name.trim()) {
    throw new Error(`${kind} name is required`);
  }
  return name;
}

/**
 * Names a colocation namespace. Not an HTTP gateway and not a deployable.
 * Components and services join it via {@link WorkloadComponent} / {@link WorkloadService}.
 */
export function Workload(name: string) {
  const metadata: WorkloadMetadata = { name: requireName('Workload', name) };
  return <T extends object>(target: T): T => {
    defineMetadata(WORKLOAD_KEY, metadata, target);
    return target;
  };
}

function requirePath(kind: string, path: string): string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\s?#\\]/.test(path)
  ) {
    throw new Error(`${kind} path is required and must be an absolute path starting with "/"`);
  }
  return path;
}

/**
 * Describes an independently deployed component in an implicit workload.
 * `path` identifies the member and is its HTTP route in the generated manifest.
 */
export function WorkloadComponent(options: WorkloadComponentOptions) {
  const metadata: WorkloadComponentOptions = {
    ...(options.workload === undefined
      ? {}
      : { workload: requireName('WorkloadComponent', options.workload) }),
    path: requirePath('WorkloadComponent', options.path),
  };
  return <T extends object>(target: T): T => {
    defineMetadata(WORKLOAD_COMPONENT_KEY, metadata, target);
    return target;
  };
}

/**
 * Describes a service in an implicit workload. The host invokes broker subscriptions
 * when declared; otherwise the service exports a CLI run entrypoint.
 */
export function WorkloadService(options: WorkloadServiceOptions) {
  const workload =
    options.workload === undefined ? undefined : requireName('WorkloadService', options.workload);
  const path = requirePath('WorkloadService', options.path);
  return <T extends object>(target: T): T => {
    defineMetadata(
      WORKLOAD_SERVICE_KEY,
      {
        ...(workload === undefined ? {} : { workload }),
        path,
        ...(options.subscriptions ? { subscriptions: [...options.subscriptions] } : {}),
      },
      target,
    );
    return target;
  };
}

export function getWorkload(target: object): WorkloadMetadata | undefined {
  return getOwnMetadata(WORKLOAD_KEY, target) as WorkloadMetadata | undefined;
}

export function getWorkloadComponent(target: object): WorkloadComponentOptions | undefined {
  return getOwnMetadata(WORKLOAD_COMPONENT_KEY, target) as WorkloadComponentOptions | undefined;
}

export function getWorkloadService(target: object): WorkloadServiceOptions | undefined {
  return getOwnMetadata(WORKLOAD_SERVICE_KEY, target) as WorkloadServiceOptions | undefined;
}
