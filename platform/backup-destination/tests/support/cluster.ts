import type {
  Action,
  BackupView,
  DestinationView,
  JobView,
  RestoreView,
  VolumeProgress,
  WorkloadView,
  World,
} from '../../src/model.ts';
import { reconcileAll } from '../../src/reconcile.ts';

export const NOW = '2026-10-13T03:30:00.000Z';
export const IMAGE = `ghcr.io/acme/identity@sha256:${'ab'.repeat(32)}`;
export const TENANT_UID = 'uid-tenant';
export const VOLUME = `/var/lib/kubesolo/di-tenants/${TENANT_UID}/workloads/identity`;

export function workload(overrides: Partial<WorkloadView> = {}): WorkloadView {
  return {
    name: 'identity',
    uid: 'uid-identity',
    replicas: 2,
    instances: 2,
    labels: {},
    annotations: { 'di-framework.dev/persistent-storage': 'true' },
    image: IMAGE,
    deleting: false,
    ...overrides,
  };
}

export function pvcDestination(overrides: Partial<DestinationView['spec']> = {}): DestinationView {
  return {
    name: 'pvc',
    generation: 1,
    annotations: {},
    spec: {
      type: 'pvc',
      existingClaimName: 'claim',
      sources: [{ kind: 'workload-volume', workloadName: 'identity' }],
      ...overrides,
    },
    // Service dumps are not due: the tests here are about workload volumes.
    status: { lastAttemptTime: NOW },
  };
}

export function volumeWorld(overrides: Partial<World> = {}): World {
  const destination = overrides.destination ?? pvcDestination();
  return {
    now: NOW,
    tenantNamespace: 'di-tenant-alpha',
    runtimeNamespace: 'di-runtime-alpha',
    agentImage: 'di-framework/backup-agent:dev',
    services: [],
    backups: [],
    restores: [],
    jobs: [],
    runtimeSecretPresent: true,
    credentialKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    networkEgress: [],
    destination,
    destinations: [destination],
    workloads: [workload()],
    hosts: [{ name: 'hostgroup-tenant-alpha-0', node: 'node-a', ready: true, hostPaths: [VOLUME] }],
    tenantUid: TENANT_UID,
    storageRoot: '/var/lib/kubesolo',
    ...overrides,
  };
}

function later(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function merged(current: VolumeProgress | undefined, next: unknown): VolumeProgress | undefined {
  if (!next) return current;
  return { ...current, ...(next as VolumeProgress) };
}

/**
 * Applies actions the way the API server would, so a test can step the reconcile loop.
 * `log` keeps every action in order.
 */
export class Cluster {
  world: World;
  log: Action[] = [];

  constructor(world: World) {
    this.world = world;
  }

  /** One operator tick `seconds` after the previous one. */
  tick(seconds = 3): Action[] {
    this.world = { ...this.world, now: later(this.world.now, seconds) };
    const actions = reconcileAll(this.world);
    this.apply(actions);
    return actions;
  }

  apply(actions: Action[]): void {
    for (const action of actions) {
      this.log.push(action);
      const world = this.world;
      if (action.type === 'create-backup') {
        const meta = action.body.metadata as { name: string };
        const spec = action.body.spec as Record<string, unknown>;
        const source = spec.source as BackupView['source'];
        this.world = {
          ...world,
          backups: [
            ...world.backups,
            {
              name: meta.name,
              serviceName: String(spec.serviceName),
              destinationName: String(spec.destinationName),
              uid: String(spec.uid),
              type: String(spec.type),
              className: String(spec.className),
              storage: '1Gi',
              createdAt: world.now,
              ...(source ? { source } : {}),
            },
          ],
        };
      } else if (action.type === 'backup-status') {
        this.world = {
          ...world,
          backups: world.backups.map((item) =>
            item.name === action.name
              ? ({
                  ...item,
                  ...action.status,
                  volume: merged(item.volume, action.status.volume),
                } as BackupView)
              : item,
          ),
        };
      } else if (action.type === 'restore-status') {
        this.world = {
          ...world,
          restores: world.restores.map((item) =>
            item.name === action.name
              ? ({
                  ...item,
                  ...action.status,
                  volume: merged(item.volume, action.status.volume),
                } as RestoreView)
              : item,
          ),
        };
      } else if (action.type === 'create-restore') {
        const meta = action.body.metadata as { name: string };
        const spec = action.body.spec as Omit<RestoreView, 'name'>;
        this.world = {
          ...world,
          restores: [
            ...world.restores,
            { ...spec, targetServiceName: spec.targetServiceName ?? '', name: meta.name },
          ],
        };
      } else if (action.type === 'scale-workload') {
        this.world = {
          ...world,
          workloads: (world.workloads ?? []).map((item) =>
            item.name === action.name ? { ...item, replicas: action.replicas } : item,
          ),
        };
      } else if (action.type === 'create-job') {
        const meta = action.body.metadata as { name: string; labels: Record<string, string> };
        const label = (key: string) => meta.labels[`platform.di-framework.dev/${key}`];
        this.world = {
          ...world,
          jobs: [
            ...world.jobs,
            {
              name: meta.name,
              backupKind: label('backup-kind') as JobView['backupKind'],
              serviceName: label('service') ?? '',
              phase: 'Running',
              backupName: label('backup-name'),
              destinationName: label('destination'),
            },
          ],
        };
      } else if (action.type === 'delete-job') {
        this.world = { ...world, jobs: world.jobs.filter((job) => job.name !== action.name) };
      } else if (action.type === 'delete-backup') {
        this.world = {
          ...world,
          backups: world.backups.filter((item) => item.name !== action.name),
        };
      } else if (action.type === 'destination-status') {
        const update = (item: DestinationView) =>
          item.name === action.name ? { ...item, status: action.status } : item;
        this.world = {
          ...world,
          destinations: world.destinations?.map(update),
          destination: world.destination && update(world.destination),
        };
      }
    }
  }

  /** The workload's instances stop (or start) as the runtime would. */
  instances(name: string, count: number): void {
    this.world = {
      ...this.world,
      workloads: (this.world.workloads ?? []).map((item) =>
        item.name === name ? { ...item, instances: count } : item,
      ),
    };
  }

  finishJob(phase: 'Succeeded' | 'Failed', message?: unknown, failedReason?: string): void {
    this.world = {
      ...this.world,
      jobs: this.world.jobs.map((job) =>
        job.phase === 'Running'
          ? {
              ...job,
              phase,
              ...(message === undefined ? {} : { message: JSON.stringify(message) }),
              ...(failedReason ? { failedReason } : {}),
            }
          : job,
      ),
    };
  }

  replicas(name = 'identity'): number | undefined {
    return this.world.workloads?.find((item) => item.name === name)?.replicas;
  }

  backup(name?: string): BackupView | undefined {
    return name
      ? this.world.backups.find((item) => item.name === name)
      : this.world.backups.find((item) => item.source);
  }

  destination(name = 'pvc'): DestinationView | undefined {
    return this.world.destinations?.find((item) => item.name === name);
  }

  /** Every action type in order, for ordering assertions. */
  types(actions: Action[]): string[] {
    return actions.map((action) => action.type);
  }
}
