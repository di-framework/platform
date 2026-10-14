import {
  type Action,
  type BackupView,
  type DestinationView,
  destinationType,
  type Egress,
  GROUP,
  type HeldEntry,
  type HostView,
  type JobView,
  LEDGER,
  type Ledger,
  OWNER_OBJECT_LABEL,
  OWNER_UID_LABEL,
  PVC_CLAIM,
  pickS3Owner,
  type RestoreView,
  RUNTIME_SECRET,
  runtimeNamespaceFor,
  type ServiceView,
  STORAGE_VOLUME,
  statusOf,
  VERSION,
  type VolumeProgress,
  type WorkloadView,
  type World,
} from './model.ts';

const RUNTIME = '/apis/runtime.wasmcloud.dev/v1alpha1';

/** A failed API call. `status` lets callers tell a 404 or a 409 from anything else. */
export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface KubeClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown, contentType?: string): Promise<unknown>;
  remove(path: string): Promise<void>;
}

interface Owner {
  kind?: string;
  name?: string;
  uid?: string;
  controller?: boolean;
}

interface Item {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    ownerReferences?: Owner[];
    generation?: number;
    creationTimestamp?: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    deletionTimestamp?: string;
    resourceVersion?: string;
    finalizers?: string[];
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  data?: Record<string, string>;
}

function items(value: unknown): Item[] {
  if (!value || typeof value !== 'object') return [];
  const list = (value as { items?: unknown }).items;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is Item => !!item && typeof item === 'object');
}

function phaseOf(status: Record<string, unknown> | undefined): BackupView['phase'] | undefined {
  const phase = status?.phase;
  if (phase === 'Running' || phase === 'Succeeded' || phase === 'Failed') return phase;
  return undefined;
}

function jobPhase(item: Item): JobView['phase'] {
  const status = item.status ?? {};
  const conditions = Array.isArray(status.conditions)
    ? (status.conditions as { type?: string; status?: string }[])
    : [];
  const marked = (type: string) =>
    conditions.some((condition) => condition.type === type && condition.status === 'True');
  // status.failed counts pod attempts while the Job is still retrying.
  if (marked('Complete') || status.succeeded) return 'Succeeded';
  if (marked('Failed')) return 'Failed';
  return 'Running';
}

function failedReason(item: Item): string | undefined {
  const conditions = Array.isArray(item.status?.conditions)
    ? (item.status.conditions as { type?: string; status?: string; reason?: string }[])
    : [];
  return conditions.find((condition) => condition.type === 'Failed' && condition.status === 'True')
    ?.reason;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface ComponentLike {
  image?: string;
  localResources?: { volumeMounts?: { name?: string }[] };
}

/** The image of the component that mounts the storage volume, else the first one. */
function dataImage(item: Item): string | undefined {
  const template = record(record(item.spec?.template)?.spec);
  const components = (
    Array.isArray(template?.components) ? template.components : []
  ) as ComponentLike[];
  const service = record(template?.service) as ComponentLike | undefined;
  const all = [...components, ...(service ? [service] : [])];
  const mounts = (component: ComponentLike) =>
    (component.localResources?.volumeMounts ?? []).some((mount) => mount.name === STORAGE_VOLUME);
  return (all.find(mounts) ?? all[0])?.image;
}

/** WorkloadDeployment -> WorkloadReplicaSet -> Workload, by controller owner references. */
function workloadViews(
  deployments: unknown,
  replicaSets: unknown,
  instances: unknown,
): WorkloadView[] {
  const controller = (item: Item, kind: string) =>
    item.metadata?.ownerReferences?.find(
      (owner) => owner.controller !== false && owner.kind === kind,
    );
  const sets = items(replicaSets);
  const running = items(instances);
  return items(deployments).flatMap((item): WorkloadView[] => {
    const name = item.metadata?.name;
    const uid = item.metadata?.uid;
    if (!name || !uid) return [];
    const owned = new Set(
      sets
        .filter((set) => controller(set, 'WorkloadDeployment')?.uid === uid)
        .map((set) => set.metadata?.name),
    );
    const count = running.filter((workload) =>
      owned.has(controller(workload, 'WorkloadReplicaSet')?.name),
    ).length;
    const reported = Number(item.status?.currentReplicas ?? 0) || 0;
    const replicas = item.spec?.replicas;
    return [
      {
        name,
        uid,
        replicas: typeof replicas === 'number' ? replicas : 1,
        instances: Math.max(count, reported),
        labels: item.metadata?.labels ?? {},
        annotations: item.metadata?.annotations ?? {},
        image: dataImage(item),
        deleting: !!item.metadata?.deletionTimestamp,
      },
    ];
  });
}

/** Tenant host pods: where each runs and which hostPath directories it mounts. */
function hostViews(pods: unknown, hostgroup: string): HostView[] {
  return items(pods).flatMap((pod): HostView[] => {
    if (pod.metadata?.labels?.['wasmcloud.com/hostgroup'] !== hostgroup) return [];
    const spec = pod.spec as
      | { nodeName?: string; volumes?: { hostPath?: { path?: string } }[] }
      | undefined;
    const conditions = (pod.status?.conditions ?? []) as { type?: string; status?: string }[];
    const terminating = !!pod.metadata?.deletionTimestamp;
    return [
      {
        name: pod.metadata?.name ?? '',
        node: spec?.nodeName,
        ready:
          pod.status?.phase === 'Running' &&
          !terminating &&
          conditions.some((condition) => condition.type === 'Ready' && condition.status === 'True'),
        ...(terminating ? { terminating } : {}),
        hostPaths: (spec?.volumes ?? []).flatMap((volume) =>
          volume.hostPath?.path ? [volume.hostPath.path] : [],
        ),
      },
    ];
  });
}

function volumeOf(status: Record<string, unknown> | undefined): VolumeProgress | undefined {
  return record(status?.volume) as VolumeProgress | undefined;
}

/** Fields every Backup and BackupRestore view carries for concurrency and deletion. */
function objectMeta(item: Item) {
  return {
    ...(item.metadata?.uid ? { objectUid: item.metadata.uid } : {}),
    ...(item.metadata?.resourceVersion ? { resourceVersion: item.metadata.resourceVersion } : {}),
    ...(item.metadata?.finalizers?.length ? { finalizers: item.metadata.finalizers } : {}),
    ...(item.metadata?.deletionTimestamp ? { deleting: true } : {}),
  };
}

/**
 * One ledger entry as written. Shape only: a value that is not an object with a numeric
 * `replicas` and a string `heldBy` is skipped. Bounds, names and the destination are checked by
 * the sweeper (`heldEntryProblem`), which refuses anything the operator would not have written.
 */
function entryOf(value: string): HeldEntry | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<HeldEntry>;
    if (typeof parsed?.replicas !== 'number' || typeof parsed.heldBy !== 'string') return undefined;
    return {
      replicas: parsed.replicas,
      heldBy: parsed.heldBy,
      since: String(parsed.since ?? ''),
      ...(typeof parsed.destination === 'string' ? { destination: parsed.destination } : {}),
      ...(typeof parsed.storageKey === 'string' ? { storageKey: parsed.storageKey } : {}),
      ...(typeof parsed.workloadUid === 'string' ? { workloadUid: parsed.workloadUid } : {}),
    };
  } catch {
    return undefined;
  }
}

function ledgerOf(value: unknown): Ledger {
  const item = (value ?? {}) as Item;
  const entries: Record<string, HeldEntry> = {};
  for (const [name, text] of Object.entries(item.data ?? {})) {
    const entry = entryOf(text);
    if (entry) entries[name] = entry;
  }
  return {
    ...(item.metadata?.resourceVersion ? { resourceVersion: item.metadata.resourceVersion } : {}),
    entries,
  };
}

/** A positive 404 is "absent"; any other failure is "unknown" and rejects. */
function absentOn404<T>(promise: Promise<T>): Promise<T | undefined> {
  return promise.catch((error: unknown) => {
    if (statusOf(error) === 404) return undefined;
    throw error;
  });
}

interface PodLike {
  metadata?: { ownerReferences?: { kind?: string; name?: string }[] };
  status?: {
    phase?: string;
    containerStatuses?: { state?: { running?: unknown; terminated?: unknown } }[];
  };
}

/** Per Job: did a pod get as far as running, and how many pods have not finished. */
function jobPods(pods: unknown): Map<string, { started: boolean; active: number }> {
  const found = new Map<string, { started: boolean; active: number }>();
  for (const pod of items(pods) as PodLike[]) {
    const job = pod.metadata?.ownerReferences?.find((owner) => owner.kind === 'Job')?.name;
    if (!job) continue;
    const phase = pod.status?.phase;
    const ran =
      phase === 'Running' ||
      phase === 'Succeeded' ||
      phase === 'Failed' ||
      (pod.status?.containerStatuses ?? []).some(
        (status) => status.state?.running || status.state?.terminated,
      );
    const done = phase === 'Succeeded' || phase === 'Failed';
    const seen = found.get(job) ?? { started: false, active: 0 };
    found.set(job, { started: seen.started || ran, active: seen.active + (done ? 0 : 1) });
  }
  return found;
}

/**
 * Workload volume state (#232), read in full or not at all. A failed list is never an empty
 * list: it would read as "no workloads, no instances", which skips scale-ups and starts copies
 * on live volumes. Unknown state stops every volume step until a tick reads it whole.
 */
async function volumeState(
  client: KubeClient,
  tenantNamespace: string,
  runtimeNamespace: string,
): Promise<{
  deployments?: unknown;
  replicaSets?: unknown;
  instances?: unknown;
  hostgroup?: unknown;
  ledger?: Ledger;
}> {
  const tenant = tenantNamespace.slice('di-tenant-'.length);
  const runtime = `${RUNTIME}/namespaces/${tenantNamespace}`;
  try {
    const [deployments, replicaSets, instances, hostgroup, ledger] = await Promise.all([
      client.get(`${runtime}/workloaddeployments`),
      client.get(`${runtime}/workloadreplicasets`),
      client.get(`${runtime}/workloads`),
      absentOn404(
        client.get(
          `/apis/apps/v1/namespaces/${runtimeNamespace}/deployments/hostgroup-tenant-${tenant}`,
        ),
      ),
      // The runtime namespace, where tenant users cannot write ConfigMaps (W6). A ledger an
      // earlier build left in the tenant namespace is never read.
      absentOn404(client.get(`/api/v1/namespaces/${runtimeNamespace}/configmaps/${LEDGER}`)),
    ]);
    return { deployments, replicaSets, instances, hostgroup, ledger: ledgerOf(ledger) };
  } catch (error) {
    console.error(
      `workload volume state unknown, volume steps wait: ${error instanceof Error ? error.message : 'read failed'}`,
    );
    return {};
  }
}

export async function loadWorld(
  client: KubeClient,
  tenantNamespace: string,
  agentImage: string,
  now: string,
  storageRoot?: string,
): Promise<World> {
  const runtimeNamespace = runtimeNamespaceFor(tenantNamespace);
  const tenant = tenantNamespace.slice('di-tenant-'.length);
  const base = `/apis/${VERSION}/namespaces/${tenantNamespace}`;
  // Workload volumes (#232). Without them (no RBAC, API trouble) services are still backed up.
  const volumes = await volumeState(client, tenantNamespace, runtimeNamespace);
  const [destinations, services, backups, restores, jobs, pods, policy] = await Promise.all([
    client.get(`${base}/backupdestinations`),
    client.get(`${base}/backingservices`),
    client.get(`${base}/backups`),
    client.get(`${base}/backuprestores`),
    client.get(`/apis/batch/v1/namespaces/${runtimeNamespace}/jobs`),
    client.get(`/api/v1/namespaces/${runtimeNamespace}/pods`),
    client
      .get(
        `/apis/networking.k8s.io/v1/namespaces/${runtimeNamespace}/networkpolicies/di-backup-agent-network`,
      )
      .catch(() => undefined),
  ]);
  const views = items(destinations).flatMap((item): DestinationView[] => {
    if (!item.metadata?.name) return [];
    const spec = (item.spec ?? {}) as unknown as DestinationView['spec'];
    return [
      {
        name: item.metadata.name,
        generation: item.metadata.generation ?? 1,
        spec: { ...spec, type: destinationType(spec) },
        status: (item.status ?? {}) as DestinationView['status'],
        annotations: item.metadata.annotations ?? {},
        createdAt: item.metadata.creationTimestamp,
      },
    ];
  });
  // The runtime Secret holds one set of S3 keys: those of the oldest S3 destination.
  const s3 = pickS3Owner(views);
  const secretName = s3?.spec.credentialsSecretRef?.name;
  // Only the named credentials Secret is read; no other Secret in the tenant namespace is.
  const credential = secretName
    ? ((await client
        .get(`/api/v1/namespaces/${tenantNamespace}/secrets/${secretName}`)
        .catch(() => undefined)) as Item | undefined)
    : undefined;
  const runtimeSecrets = await client
    .get(`/api/v1/namespaces/${runtimeNamespace}/secrets/${RUNTIME_SECRET}`)
    .then(() => true)
    .catch(() => false);
  const claims = await client
    .get(`/api/v1/namespaces/${runtimeNamespace}/persistentvolumeclaims`)
    .then((list) => new Set(items(list).map((item) => item.metadata?.name)))
    .catch(() => undefined);
  const missingClaims = claims
    ? [
        ...new Set(
          views
            .filter((view) => view.spec.type === 'pvc')
            .map((view) => view.spec.existingClaimName || PVC_CLAIM)
            .filter((name) => !claims.has(name)),
        ),
      ]
    : undefined;
  const podsByJob = jobPods(pods);
  const messages = new Map<string, string>();
  for (const pod of items(pods)) {
    const statuses = (pod.status?.containerStatuses ?? []) as {
      state?: { terminated?: { message?: string } };
    }[];
    const message = statuses.find((status) => status.state?.terminated?.message)?.state?.terminated
      ?.message;
    const owners = (pod.metadata as { ownerReferences?: { name?: string }[] } | undefined)
      ?.ownerReferences;
    const job = owners?.find((owner) => owner.name)?.name;
    if (job && message) messages.set(job, message);
  }
  return {
    now,
    tenantNamespace,
    runtimeNamespace,
    agentImage,
    destination: views[0],
    destinations: views,
    missingClaims,
    services: items(services).flatMap((item) => {
      const type = item.spec?.type;
      if (type !== 'postgres' && type !== 'keyvalue' && type !== 'messaging') return [];
      if (!item.metadata?.name || !item.metadata.uid) return [];
      const conditions = (item.status?.conditions ?? []) as { type?: string; status?: string }[];
      const parameters = (item.spec?.parameters ?? {}) as {
        storage?: string;
        memory?: string;
        cpu?: string;
      };
      return [
        {
          name: item.metadata.name,
          uid: item.metadata.uid,
          type,
          className: String(item.spec?.className ?? ''),
          storage: parameters.storage ?? '1Gi',
          memory: parameters.memory,
          cpu: parameters.cpu,
          ready: conditions.some(
            (condition) => condition.type === 'Ready' && condition.status === 'True',
          ),
          suspended: item.spec?.suspended === true,
          deleting: !!item.metadata.deletionTimestamp,
        } satisfies ServiceView,
      ];
    }),
    backups: items(backups).flatMap((item): BackupView[] => {
      if (!item.metadata?.name) return [];
      const spec = item.spec ?? {};
      return [
        {
          name: item.metadata.name,
          serviceName: String(spec.serviceName ?? ''),
          destinationName: String(spec.destinationName ?? ''),
          phase: phaseOf(item.status),
          objectKey: typeof item.status?.objectKey === 'string' ? item.status.objectKey : undefined,
          digest: typeof item.status?.digest === 'string' ? item.status.digest : undefined,
          bytes: typeof item.status?.bytes === 'number' ? item.status.bytes : undefined,
          reason: typeof item.status?.reason === 'string' ? item.status.reason : undefined,
          uid: String(spec.uid ?? ''),
          type: String(spec.type ?? ''),
          className: String(spec.className ?? ''),
          storage: String((spec.parameters as { storage?: string } | undefined)?.storage ?? '1Gi'),
          createdAt: item.metadata.creationTimestamp ?? '',
          ...(record(spec.source)?.kind === 'workload-volume'
            ? {
                source: {
                  kind: 'workload-volume' as const,
                  workloadName: String(record(spec.source)?.workloadName ?? ''),
                },
              }
            : {}),
          ...(volumeOf(item.status) ? { volume: volumeOf(item.status) } : {}),
          ...(typeof item.status?.message === 'string' ? { message: item.status.message } : {}),
          ...objectMeta(item),
        },
      ];
    }),
    restores: items(restores).flatMap((item): RestoreView[] => {
      if (!item.metadata?.name) return [];
      return [
        {
          name: item.metadata.name,
          sourceBackupName: String(item.spec?.sourceBackupName ?? ''),
          targetServiceName: String(item.spec?.targetServiceName ?? ''),
          ...(typeof item.spec?.targetWorkloadName === 'string'
            ? { targetWorkloadName: item.spec.targetWorkloadName }
            : {}),
          ...(item.spec?.force === true ? { force: true } : {}),
          ...(typeof item.spec?.expectedKcv === 'string'
            ? { expectedKcv: item.spec.expectedKcv }
            : {}),
          phase: phaseOf(item.status),
          reason: typeof item.status?.reason === 'string' ? item.status.reason : undefined,
          ...(volumeOf(item.status) ? { volume: volumeOf(item.status) } : {}),
          ...objectMeta(item),
        },
      ];
    }),
    jobs: items(jobs).flatMap((item): JobView[] => {
      if (!item.metadata?.name) return [];
      const labels = item.metadata.labels ?? {};
      const kind = labels[`${GROUP}/backup-kind`];
      if (
        kind !== 'dump' &&
        kind !== 'restore' &&
        kind !== 'probe' &&
        kind !== 'gc' &&
        kind !== 'volume-copy' &&
        kind !== 'volume-restore' &&
        kind !== 'volume-probe'
      )
        return [];
      const pods = podsByJob.get(item.metadata.name);
      return [
        {
          name: item.metadata.name,
          backupKind: kind,
          serviceName: labels[`${GROUP}/service`] ?? '',
          phase: jobPhase(item),
          message: messages.get(item.metadata.name),
          backupName: labels[`${GROUP}/backup-name`],
          gcBackups: item.metadata.annotations?.[`${GROUP}/gc-backups`]?.split(',').filter(Boolean),
          destinationName: labels[`${GROUP}/destination`],
          failedReason: failedReason(item),
          started: pods?.started ?? false,
          activePods: pods?.active ?? 0,
          ...(labels[OWNER_OBJECT_LABEL] ? { ownerUid: labels[OWNER_OBJECT_LABEL] } : {}),
        },
      ];
    }),
    runtimeSecretPresent: runtimeSecrets,
    credentialKeys: Object.keys(credential?.data ?? {}),
    networkEgress: egressOf(policy),
    ...(volumes.ledger
      ? {
          workloads: workloadViews(volumes.deployments, volumes.replicaSets, volumes.instances),
          ledger: volumes.ledger,
        }
      : {}),
    hosts: hostViews(pods, `tenant-${tenant}`),
    tenantUid: (volumes.hostgroup as Item | undefined)?.metadata?.labels?.[OWNER_UID_LABEL],
    storageRoot,
  };
}

interface PolicyRule {
  to?: { ipBlock?: { cidr?: string } }[];
  ports?: { protocol?: string; port?: number }[];
}

/** Destination-specific ipBlocks. The chart's DNS, backend, and public-443 rules stay. */
function managedEgress(rule: PolicyRule): boolean {
  const cidr = rule.to?.find((peer) => peer.ipBlock?.cidr)?.ipBlock?.cidr;
  return !!cidr && cidr !== '0.0.0.0/0';
}

function egressRule(rule: Egress): PolicyRule {
  return {
    to: [{ ipBlock: { cidr: rule.cidr } }],
    ports: [{ protocol: rule.protocol, port: rule.port }],
  };
}

function egressOf(policy: unknown): Egress[] {
  const rules = (
    policy as {
      spec?: { egress?: { ports?: { port?: number }[]; to?: { ipBlock?: { cidr?: string } }[] }[] };
    }
  )?.spec?.egress;
  if (!rules) return [];
  const found: Egress[] = [];
  for (const rule of rules) {
    const cidr = rule.to?.find((peer) => peer.ipBlock?.cidr)?.ipBlock?.cidr;
    const port = rule.ports?.find((entry) => entry.port)?.port;
    if (!cidr || !port || cidr === '0.0.0.0/0') continue;
    found.push({ cidr, port, protocol: 'TCP' });
  }
  return found;
}

/** Ignore one HTTP status: a 409 on a create (already exists) or a 404 on a delete. */
async function except(status: number, call: Promise<unknown>): Promise<unknown> {
  return call.catch((error: unknown) => {
    if (statusOf(error) === status) return undefined;
    throw error;
  });
}

function versionOf(response: unknown): string | undefined {
  const version = (response as Item | undefined)?.metadata?.resourceVersion;
  return typeof version === 'string' ? version : undefined;
}

/**
 * Optimistic concurrency across the writes of one tick. An action carries the resourceVersion
 * its object had when the world was read; once this tick has written that object, the version
 * the API returned replaces it. A write whose object changed in between fails with 409, which
 * stops the tick: a stale reconciler cannot overwrite what a newer one wrote.
 */
class Versions {
  private seen = new Map<string, string>();

  precondition(key: string, read: string | undefined): { resourceVersion: string } | object {
    const version = this.seen.get(key) ?? read;
    return version ? { resourceVersion: version } : {};
  }

  record(key: string, response: unknown): void {
    const version = versionOf(response);
    if (version) this.seen.set(key, version);
  }
}

/**
 * Apply actions in order and stop at the first failure, so a later action never runs without
 * the earlier ones (replicas are recorded before they are scaled; they are back before the
 * outcome is written).
 */
export async function applyActions(
  client: KubeClient,
  world: World,
  actions: Action[],
): Promise<void> {
  const versions = new Versions();
  const crd = `/apis/${VERSION}/namespaces/${world.tenantNamespace}`;
  for (const action of actions) {
    if (action.type === 'log') {
      console.log(action.message);
    } else if (action.type === 'destination-status') {
      const name = action.name ?? world.destination?.name;
      if (!name) continue;
      await client.patch(
        `/apis/${VERSION}/namespaces/${world.tenantNamespace}/backupdestinations/${name}/status`,
        { status: action.status },
      );
    } else if (action.type === 'annotate' || action.type === 'clear-annotation') {
      const value = action.type === 'annotate' ? action.value : null;
      await client.patch(
        `/apis/${VERSION}/namespaces/${world.tenantNamespace}/backupdestinations/${action.name}`,
        { metadata: { annotations: { [action.key]: value } } },
      );
    } else if (action.type === 'copy-credentials') {
      const secret = (await client.get(
        `/api/v1/namespaces/${world.tenantNamespace}/secrets/${action.secretName}`,
      )) as Item;
      const data: Record<string, string> = {};
      for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
        const encoded = secret.data?.[key];
        if (encoded) data[key] = encoded;
      }
      await client
        .post(`/api/v1/namespaces/${world.runtimeNamespace}/secrets`, {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: RUNTIME_SECRET, namespace: world.runtimeNamespace },
          type: 'Opaque',
          data,
        })
        .catch(async () => {
          await client.patch(
            `/api/v1/namespaces/${world.runtimeNamespace}/secrets/${RUNTIME_SECRET}`,
            { data },
          );
        });
    } else if (action.type === 'sync-egress') {
      const policyPath = `/apis/networking.k8s.io/v1/namespaces/${world.runtimeNamespace}/networkpolicies/di-backup-agent-network`;
      const policy = (await client.get(policyPath)) as { spec?: { egress?: PolicyRule[] } };
      const base = (policy.spec?.egress ?? []).filter((rule) => !managedEgress(rule));
      await client.patch(policyPath, {
        spec: { egress: [...base, ...action.extraEgress.map(egressRule)] },
      });
    } else if (action.type === 'create-backup' || action.type === 'create-restore') {
      const kind = action.type === 'create-backup' ? 'backups' : 'backuprestores';
      // Names are deterministic (a schedule fire, a console request): a 409 is the same request.
      await except(409, client.post(`${crd}/${kind}`, action.body));
    } else if (action.type === 'backup-status' || action.type === 'restore-status') {
      const kind = action.type === 'backup-status' ? 'backups' : 'backuprestores';
      const key = `${kind}/${action.name}`;
      const response = await client.patch(`${crd}/${key}/status`, {
        metadata: versions.precondition(key, action.resourceVersion),
        status: action.status,
      });
      versions.record(key, response);
    } else if (action.type === 'finalizers') {
      const key = `${action.resource}/${action.name}`;
      const response = await except(
        404,
        client.patch(`${crd}/${key}`, {
          metadata: {
            ...versions.precondition(key, action.resourceVersion),
            finalizers: action.finalizers,
          },
        }),
      );
      versions.record(key, response);
    } else if (action.type === 'ledger') {
      await writeLedger(client, world, action, versions);
    } else if (action.type === 'delete-backup') {
      await except(404, client.remove(`${crd}/backups/${action.name}`));
    } else if (action.type === 'create-job') {
      await createJob(client, action.body);
    } else if (action.type === 'scale-workload') {
      // A 404 is the only proof a member is gone; anything else fails the tick and is retried.
      await except(
        404,
        client.patch(
          `${RUNTIME}/namespaces/${world.tenantNamespace}/workloaddeployments/${action.name}/scale`,
          { spec: { replicas: action.replicas } },
        ),
      );
    } else if (action.type === 'delete-job') {
      await except(
        404,
        client.remove(
          `/apis/batch/v1/namespaces/${world.runtimeNamespace}/jobs/${action.name}?propagationPolicy=Background`,
        ),
      );
    } else if (action.type === 'event') {
      await recordEvent(client, world, action);
    }
  }
}

/**
 * Post an Event on the held-replicas ledger in the runtime namespace, where tenant roles read
 * events. A signal, not a step: a failure is logged and the tick goes on.
 */
async function recordEvent(
  client: KubeClient,
  world: World,
  action: Extract<Action, { type: 'event' }>,
): Promise<void> {
  const namespace = world.runtimeNamespace;
  try {
    await client.post(`/api/v1/namespaces/${namespace}/events`, {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { generateName: `${LEDGER}.`, namespace },
      involvedObject: { apiVersion: 'v1', kind: 'ConfigMap', name: LEDGER, namespace },
      type: action.eventType,
      reason: action.reason,
      message: action.message,
      source: { component: 'di-backup-operator' },
      reportingComponent: 'di-backup-operator',
      firstTimestamp: world.now,
      lastTimestamp: world.now,
      count: 1,
    });
  } catch (error) {
    console.error(
      `event ${action.reason} not recorded: ${error instanceof Error ? error.message : 'post failed'}`,
    );
  }
}

/**
 * Create a Job. Its name comes from the request, so a 409 is normally this request's own Job
 * from an earlier tick. A volume Job carries its owner's uid: the existing Job counts as ours
 * only when it carries the same one, and anything else fails the tick instead of adopting a Job
 * (and its result) that another object created.
 */
async function createJob(client: KubeClient, body: Record<string, unknown>): Promise<void> {
  const meta = (body.metadata ?? {}) as {
    namespace?: string;
    name?: string;
    labels?: Record<string, string>;
  };
  const path = `/apis/batch/v1/namespaces/${meta.namespace}/jobs`;
  try {
    await client.post(path, body);
  } catch (error) {
    if (statusOf(error) !== 409) throw error;
    const owner = meta.labels?.[OWNER_OBJECT_LABEL];
    if (!owner) return;
    const existing = (await client.get(`${path}/${meta.name}`)) as Item;
    const found = existing.metadata?.labels?.[OWNER_OBJECT_LABEL];
    if (found !== owner) {
      throw new Error(
        `Job ${meta.name} already exists for another object (backup-uid ${found ?? 'unset'}, expected ${owner}); not reusing it`,
      );
    }
  }
}

/** Set or remove held-replicas entries; the first write creates the ConfigMap. */
async function writeLedger(
  client: KubeClient,
  world: World,
  action: Extract<Action, { type: 'ledger' }>,
  versions: Versions,
): Promise<void> {
  const path = `/api/v1/namespaces/${world.runtimeNamespace}/configmaps`;
  const data = Object.fromEntries(
    Object.entries(action.set).map(([name, entry]) => [name, entry ? JSON.stringify(entry) : null]),
  );
  const precondition = versions.precondition('ledger', action.resourceVersion);
  if (!('resourceVersion' in precondition)) {
    const created = Object.fromEntries(
      Object.entries(data).filter((pair): pair is [string, string] => pair[1] !== null),
    );
    if (Object.keys(created).length === 0) return;
    // A 409 here means another writer created it first: fail, and the next tick reads it.
    const response = await client.post(path, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: LEDGER,
        namespace: world.runtimeNamespace,
        labels: { [`${GROUP}/component`]: 'backup-operator' },
      },
      data: created,
    });
    versions.record('ledger', response);
    return;
  }
  const response = await client.patch(`${path}/${LEDGER}`, { metadata: precondition, data });
  versions.record('ledger', response);
}
