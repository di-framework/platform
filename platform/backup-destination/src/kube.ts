import {
  type Action,
  type BackupView,
  type DestinationView,
  destinationType,
  type Egress,
  GROUP,
  type HostView,
  type JobView,
  OWNER_UID_LABEL,
  PVC_CLAIM,
  pickS3Owner,
  type RestoreView,
  RUNTIME_SECRET,
  runtimeNamespaceFor,
  type ServiceView,
  STORAGE_VOLUME,
  VERSION,
  type VolumeProgress,
  type WorkloadView,
  type World,
} from './model.ts';

const RUNTIME = '/apis/runtime.wasmcloud.dev/v1alpha1';

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
    return [
      {
        name: pod.metadata?.name ?? '',
        node: spec?.nodeName,
        ready:
          pod.status?.phase === 'Running' &&
          !pod.metadata?.deletionTimestamp &&
          conditions.some((condition) => condition.type === 'Ready' && condition.status === 'True'),
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
  const runtime = `${RUNTIME}/namespaces/${tenantNamespace}`;
  const none = () => ({ items: [] });
  // Workload volumes (#232). A chart without the RBAC for these still backs up services.
  const [deployments, replicaSets, instances, hostgroup] = await Promise.all([
    client.get(`${runtime}/workloaddeployments`).catch(none),
    client.get(`${runtime}/workloadreplicasets`).catch(none),
    client.get(`${runtime}/workloads`).catch(none),
    client
      .get(`/apis/apps/v1/namespaces/${runtimeNamespace}/deployments/hostgroup-tenant-${tenant}`)
      .catch(() => undefined),
  ]);
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
        kind !== 'volume-restore'
      )
        return [];
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
        },
      ];
    }),
    runtimeSecretPresent: runtimeSecrets,
    credentialKeys: Object.keys(credential?.data ?? {}),
    networkEgress: egressOf(policy),
    workloads: workloadViews(deployments, replicaSets, instances),
    hosts: hostViews(pods, `tenant-${tenant}`),
    tenantUid: (hostgroup as Item | undefined)?.metadata?.labels?.[OWNER_UID_LABEL],
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

export async function applyActions(
  client: KubeClient,
  world: World,
  actions: Action[],
): Promise<void> {
  for (const action of actions) {
    if (action.type === 'destination-status') {
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
      await client.post(
        `/apis/${VERSION}/namespaces/${world.tenantNamespace}/${kind}`,
        action.body,
      );
    } else if (action.type === 'backup-status') {
      await client.patch(
        `/apis/${VERSION}/namespaces/${world.tenantNamespace}/backups/${action.name}/status`,
        { status: action.status },
      );
    } else if (action.type === 'restore-status') {
      await client.patch(
        `/apis/${VERSION}/namespaces/${world.tenantNamespace}/backuprestores/${action.name}/status`,
        { status: action.status },
      );
    } else if (action.type === 'delete-backup') {
      await client.remove(
        `/apis/${VERSION}/namespaces/${world.tenantNamespace}/backups/${action.name}`,
      );
    } else if (action.type === 'create-job') {
      const meta = (action.body.metadata ?? {}) as { namespace?: string };
      await client.post(`/apis/batch/v1/namespaces/${meta.namespace}/jobs`, action.body);
    } else if (action.type === 'scale-workload') {
      await client.patch(
        `${RUNTIME}/namespaces/${world.tenantNamespace}/workloaddeployments/${action.name}/scale`,
        { spec: { replicas: action.replicas } },
      );
    } else if (action.type === 'delete-job') {
      await client.remove(
        `/apis/batch/v1/namespaces/${world.runtimeNamespace}/jobs/${action.name}?propagationPolicy=Background`,
      );
    }
  }
}
