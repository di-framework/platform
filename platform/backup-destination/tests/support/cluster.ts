import type {
  Action,
  BackupView,
  DestinationView,
  HeldEntry,
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
      // Explicit, as the chart requires (#250): on-demand only, for the destination and source.
      schedule: 'none',
      sources: [{ kind: 'workload-volume', workloadName: 'identity', schedule: 'none' }],
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
    ledger: { entries: {} },
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
  // A merge patch: null removes a field.
  const result: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result as VolumeProgress;
}

/** Why `apply` stopped: an injected failure or a resourceVersion conflict. */
export class ApplyError extends Error {
  constructor(
    readonly status: number,
    readonly action: Action,
  ) {
    super(`${action.type} failed: ${status}`);
  }
}

type Owned = BackupView | RestoreView;

/**
 * An in-memory API server for the reconcile loop. Actions apply the way `applyActions` applies
 * them: in order, stopping at the first failure, with resourceVersion preconditions threaded
 * through one call, a 404 on a scale or a delete ignored, and a 409 on a create ignored.
 * `log` keeps every applied action in order.
 */
export class Cluster {
  world: World;
  log: Action[] = [];
  /** Probe Jobs succeed as soon as they are created. */
  autoProbe = true;
  /** New Jobs have a running pod; false leaves them Pending. */
  jobsStart = true;
  private failures: { match: (action: Action) => boolean; status: number; times: number }[] = [];
  private version = 1;

  constructor(world: World) {
    this.world = world;
  }

  /** One operator tick `seconds` after the previous one. `unknown`: a list failed this tick. */
  tick(seconds = 3, options: { unknown?: boolean } = {}): Action[] {
    this.world = { ...this.world, now: later(this.world.now, seconds) };
    const seen = options.unknown
      ? { ...this.world, workloads: undefined, ledger: undefined }
      : this.world;
    const actions = reconcileAll(seen);
    this.applyQuietly(actions);
    return actions;
  }

  /** A reconciler that read the world earlier (`stale`) acting now. */
  tickFrom(stale: World): Action[] {
    const actions = reconcileAll({ ...stale, now: this.world.now });
    this.applyQuietly(actions);
    return actions;
  }

  /** The next `times` actions matching `match` fail with `status`. */
  fail(match: (action: Action) => boolean, status = 500, times = 1): void {
    this.failures.push({ match, status, times });
  }

  errors: ApplyError[] = [];

  applyQuietly(actions: Action[]): void {
    try {
      this.apply(actions);
    } catch (error) {
      if (!(error instanceof ApplyError)) throw error;
      this.errors.push(error);
    }
  }

  apply(actions: Action[]): void {
    const written = new Map<string, string>();
    for (const action of actions) {
      const injected = this.failures.find((item) => item.times > 0 && item.match(action));
      if (injected) {
        injected.times -= 1;
        throw new ApplyError(injected.status, action);
      }
      this.applyOne(action, written);
      this.log.push(action);
    }
  }

  private nextVersion(): string {
    this.version += 1;
    return String(this.version);
  }

  private precondition(
    key: string,
    current: string | undefined,
    read: string | undefined,
    written: Map<string, string>,
    action: Action,
  ): void {
    const expected = written.get(key) ?? read;
    if (expected !== undefined && expected !== current) throw new ApplyError(409, action);
  }

  private owned(resource: 'backups' | 'backuprestores', name: string): Owned | undefined {
    const list: Owned[] = resource === 'backups' ? this.world.backups : this.world.restores;
    return list.find((item) => item.name === name);
  }

  private replace(resource: 'backups' | 'backuprestores', next: Owned | undefined, name: string) {
    if (resource === 'backups') {
      this.world = {
        ...this.world,
        backups: this.world.backups.flatMap((item) =>
          item.name === name ? (next ? [next as BackupView] : []) : [item],
        ),
      };
    } else {
      this.world = {
        ...this.world,
        restores: this.world.restores.flatMap((item) =>
          item.name === name ? (next ? [next as RestoreView] : []) : [item],
        ),
      };
    }
  }

  private applyOne(action: Action, written: Map<string, string>): void {
    const world = this.world;
    if (action.type === 'create-backup') {
      const meta = action.body.metadata as { name: string };
      if (world.backups.some((item) => item.name === meta.name)) return;
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
            resourceVersion: this.nextVersion(),
            objectUid: `uid-backup-${this.version}`,
            ...(source ? { source } : {}),
          },
        ],
      };
    } else if (action.type === 'backup-status' || action.type === 'restore-status') {
      const resource = action.type === 'backup-status' ? 'backups' : 'backuprestores';
      const item = this.owned(resource, action.name);
      if (!item) throw new ApplyError(404, action);
      const key = `${resource}/${action.name}`;
      this.precondition(key, item.resourceVersion, action.resourceVersion, written, action);
      const version = this.nextVersion();
      written.set(key, version);
      const status = { ...action.status };
      for (const field of Object.keys(status))
        if (status[field] === undefined) delete status[field];
      this.replace(
        resource,
        {
          ...item,
          ...status,
          volume: merged(item.volume, action.status.volume),
          resourceVersion: version,
        } as Owned,
        action.name,
      );
    } else if (action.type === 'finalizers') {
      const item = this.owned(action.resource, action.name);
      if (!item) return;
      const key = `${action.resource}/${action.name}`;
      this.precondition(key, item.resourceVersion, action.resourceVersion, written, action);
      const version = this.nextVersion();
      written.set(key, version);
      // The API server removes a deleting object once its last finalizer is gone.
      const gone = item.deleting && action.finalizers.length === 0;
      this.replace(
        action.resource,
        gone ? undefined : { ...item, finalizers: action.finalizers, resourceVersion: version },
        action.name,
      );
    } else if (action.type === 'ledger') {
      const ledger = world.ledger ?? { entries: {} };
      const read = action.resourceVersion;
      if (written.has('ledger') || read !== undefined) {
        this.precondition('ledger', ledger.resourceVersion, read, written, action);
      } else if (ledger.resourceVersion !== undefined) {
        throw new ApplyError(409, action); // create of an existing ConfigMap
      }
      const entries: Record<string, HeldEntry> = { ...ledger.entries };
      for (const [name, entry] of Object.entries(action.set)) {
        if (entry) entries[name] = entry;
        else delete entries[name];
      }
      const version = this.nextVersion();
      written.set('ledger', version);
      this.world = { ...world, ledger: { resourceVersion: version, entries } };
    } else if (action.type === 'create-restore') {
      const meta = action.body.metadata as { name: string };
      if (world.restores.some((item) => item.name === meta.name)) return;
      const spec = action.body.spec as Omit<RestoreView, 'name'>;
      this.world = {
        ...world,
        restores: [
          ...world.restores,
          {
            ...spec,
            targetServiceName: spec.targetServiceName ?? '',
            name: meta.name,
            resourceVersion: this.nextVersion(),
            objectUid: `uid-restore-${this.version}`,
          },
        ],
      };
    } else if (action.type === 'scale-workload') {
      // A missing WorkloadDeployment answers 404, which applyActions ignores.
      this.world = {
        ...world,
        workloads: (world.workloads ?? []).map((item) =>
          item.name === action.name ? { ...item, replicas: action.replicas } : item,
        ),
      };
    } else if (action.type === 'create-job') {
      const meta = action.body.metadata as { name: string; labels: Record<string, string> };
      const label = (key: string) => meta.labels[`platform.di-framework.dev/${key}`];
      const existing = world.jobs.find((job) => job.name === meta.name);
      // A 409 is ours only when the existing Job carries the same owner uid (applyActions).
      if (existing) {
        const owner = label('backup-uid');
        if (owner && existing.ownerUid !== owner) throw new ApplyError(409, action);
        return;
      }
      const kind = label('backup-kind') as JobView['backupKind'];
      const probe = kind === 'volume-probe' && this.autoProbe;
      this.world = {
        ...world,
        jobs: [
          ...world.jobs,
          {
            name: meta.name,
            backupKind: kind,
            serviceName: label('service') ?? '',
            phase: probe ? 'Succeeded' : 'Running',
            backupName: label('backup-name'),
            destinationName: label('destination'),
            started: this.jobsStart || probe,
            activePods: this.jobsStart && !probe ? 1 : 0,
            ...(label('backup-uid') ? { ownerUid: label('backup-uid') } : {}),
            ...(probe ? { message: JSON.stringify({ ok: true }) } : {}),
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

  /** `kubectl delete`: with a finalizer the object stays, marked as deleting. */
  remove(resource: 'backups' | 'backuprestores', name: string): void {
    const item = this.owned(resource, name);
    if (!item) return;
    this.replace(
      resource,
      item.finalizers?.length
        ? { ...item, deleting: true, resourceVersion: this.nextVersion() }
        : undefined,
      name,
    );
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
              started: true,
              activePods: 0,
              ...(message === undefined ? {} : { message: JSON.stringify(message) }),
              ...(failedReason ? { failedReason } : {}),
            }
          : job,
      ),
    };
  }

  /** Change one Job as the cluster would (a pod starts, a pod goes away). */
  job(name: string, change: Partial<JobView>): void {
    this.world = {
      ...this.world,
      jobs: this.world.jobs.map((job) => (job.name === name ? { ...job, ...change } : job)),
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

  held(): Record<string, HeldEntry> {
    return this.world.ledger?.entries ?? {};
  }

  /** Every action type in order, for ordering assertions. */
  types(actions: Action[]): string[] {
    return actions.map((action) => action.type);
  }
}
