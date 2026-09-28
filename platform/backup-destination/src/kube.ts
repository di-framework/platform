import {
  type Action,
  type BackupView,
  type DestinationView,
  type Egress,
  GROUP,
  type JobView,
  type RestoreView,
  runtimeNamespaceFor,
  type ServiceView,
  VERSION,
  type World,
} from './model.ts';

export interface KubeClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown, contentType?: string): Promise<unknown>;
  remove(path: string): Promise<void>;
}

interface Item {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
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

export async function loadWorld(
  client: KubeClient,
  tenantNamespace: string,
  agentImage: string,
  now: string,
): Promise<World> {
  const runtimeNamespace = runtimeNamespaceFor(tenantNamespace);
  const base = `/apis/${VERSION}/namespaces/${tenantNamespace}`;
  const [destinations, services, backups, restores, jobs, pods, secret, policy] = await Promise.all(
    [
      client.get(`${base}/backupdestinations`),
      client.get(`${base}/backingservices`),
      client.get(`${base}/backups`),
      client.get(`${base}/backuprestores`),
      client.get(`/apis/batch/v1/namespaces/${runtimeNamespace}/jobs`),
      client.get(`/api/v1/namespaces/${runtimeNamespace}/pods`),
      client.get(`/api/v1/namespaces/${tenantNamespace}/secrets`).catch(() => ({ items: [] })),
      client
        .get(
          `/apis/networking.k8s.io/v1/namespaces/${runtimeNamespace}/networkpolicies/di-backup-agent-network`,
        )
        .catch(() => undefined),
    ],
  );
  const destinationItem = items(destinations)[0];
  const destination: DestinationView | undefined = destinationItem?.metadata?.name
    ? {
        name: destinationItem.metadata.name,
        generation: destinationItem.metadata.generation ?? 1,
        spec: (destinationItem.spec ?? {}) as unknown as DestinationView['spec'],
        status: (destinationItem.status ?? {}) as DestinationView['status'],
        annotations: destinationItem.metadata.annotations ?? {},
      }
    : undefined;
  const secretName = destination?.spec.credentialsSecretRef?.name;
  const credential = items(secret).find((item) => item.metadata?.name === secretName);
  const runtimeSecrets = await client
    .get(`/api/v1/namespaces/${runtimeNamespace}/secrets/di-backup-destination`)
    .then(() => true)
    .catch(() => false);
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
    destination,
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
          phase: phaseOf(item.status),
          reason: typeof item.status?.reason === 'string' ? item.status.reason : undefined,
        },
      ];
    }),
    jobs: items(jobs).flatMap((item): JobView[] => {
      if (!item.metadata?.name) return [];
      const labels = item.metadata.labels ?? {};
      const kind = labels[`${GROUP}/backup-kind`];
      if (kind !== 'dump' && kind !== 'restore' && kind !== 'probe' && kind !== 'gc') return [];
      return [
        {
          name: item.metadata.name,
          backupKind: kind,
          serviceName: labels[`${GROUP}/service`] ?? '',
          phase: jobPhase(item),
          message: messages.get(item.metadata.name),
          backupName: labels[`${GROUP}/backup-name`],
          gcBackups: item.metadata.annotations?.[`${GROUP}/gc-backups`]?.split(',').filter(Boolean),
        },
      ];
    }),
    runtimeSecretPresent: runtimeSecrets,
    credentialKeys: Object.keys(credential?.data ?? {}),
    networkEgress: egressOf(policy),
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
    if (action.type === 'destination-status' && world.destination) {
      await client.patch(
        `/apis/${VERSION}/namespaces/${world.tenantNamespace}/backupdestinations/${world.destination.name}/status`,
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
          metadata: { name: 'di-backup-destination', namespace: world.runtimeNamespace },
          type: 'Opaque',
          data,
        })
        .catch(async () => {
          await client.patch(
            `/api/v1/namespaces/${world.runtimeNamespace}/secrets/di-backup-destination`,
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
    }
  }
}
