import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import { claimsRegistryHost } from './admission';
import {
  type ApiKeyMigration,
  type ApiKeySecret,
  apiKeyMoveBlocker,
  migrateApiKeys,
  type TenantControllerDeployment,
  type TenantControllerPod,
} from './api-keys';
import {
  backingServiceResourceName,
  backingServiceResources,
  type DeploymentFailure,
  deploymentFailure,
  endpointFor,
  RUNTIME_DATA_NATS,
  type RuntimeProvider,
  refuseReservedNames,
  resolveBackingSizing,
  resolveClass,
  tenantNameFromNamespace,
} from './backing-service-reconcile';
import { LEAF_RENEW_DAYS, leafNames, rotateCas } from './ca-rotation';
import {
  approveEgress,
  EGRESS_FIELD_MANAGER,
  EGRESS_NETWORK_POLICY,
  egressAllowedHosts,
  egressGrants,
  egressLookups,
  egressNetworkPolicySpec,
  egressPatch,
  egressPorts,
  egressResolvableNames,
  resolveIpv4,
} from './egress';
import {
  appendRing,
  attributeEntries,
  configMapLogKey,
  type LogKey,
  type LogWriteFailure,
  legacyRing,
  logKey,
  logKeyId,
  logsConfigMap,
  logWriteCondition,
  MANAGED_SELECTOR,
  mergeFailures,
  newestStamp,
  PROJECTION,
  type ProjectedEntry,
  projectedFailures,
  projectedRing,
  type RingLine,
  unpublished,
  validLabelValue,
  type WorkloadIdentity,
} from './log-projection';
import {
  assertPostgresOwner,
  ensurePostgresCredentials,
  ensurePostgresStorage,
  type PostgresApi,
  postgresNames,
  postgresReadiness,
  postgresServingResources,
} from './postgres';
import {
  hostImageSupportsNatsCredentials,
  NATS_REGISTRY_ACCOUNT,
  NATS_TENANT_ACCOUNT,
  newRegistryNatsPassword,
  REGISTRY_NATS_AUTH_ANNOTATION,
  REGISTRY_NATS_MIGRATION,
  REGISTRY_NATS_MIGRATION_JOB,
  REGISTRY_NATS_PASSWORD,
  REGISTRY_NATS_SECRET,
  REGISTRY_NATS_VOLUME,
  registryNatsAuthDigest,
} from './registry-nats';
import {
  bindsTenantOperatorRole,
  isTenantOperatorBinding,
  REMOVAL_STEP_ANNOTATION,
  type RemovalStep,
  remainingSummary,
  removalProgress,
  removalStuckCondition,
  sweepsDeployment,
} from './removal-sequence';
import {
  assertTenantAuthConfig,
  type BackingService,
  type BackingServiceClass,
  BINDING,
  COMPONENT,
  type Condition,
  type ControllerConfig,
  FINALIZER,
  type HostPull,
  INSTALLATION,
  NAMESPACE_ROLE,
  names,
  OWNER,
  REGISTRY_CA_ANNOTATION,
  REGISTRY_PULL_SECRET,
  REGISTRY_PULL_SERVICE,
  REGISTRY_WORKLOAD,
  type RegistryNats,
  type RegistryNatsMode,
  type Resource,
  ROUTES_CONFIG_NAME,
  registryHttpHost,
  resource,
  runtimeQuota,
  SCHEDULER_TLS_COPY,
  type ServiceBinding,
  type SizingParameters,
  STORAGE_RECORDS_CONFIG,
  storageRecordsConfigMap,
  TENANT,
  TENANT_CONTROLLER_CA_KEY_SECRET,
  type Tenant,
  type TenantAuthConfig,
  type TenantAuthInputs,
  tenantAuthResources,
  tenantAuthRoutes,
  tenantControllerCaSecret,
  tenantControllerCertNames,
  tenantQuota,
  tenantResources,
  tlsCertDigest,
  type User,
  userResources,
  VERSION,
  validName,
} from './resources';
import { SchedulerAccountsWriter } from './scheduler-accounts';
import {
  hostRolloutOf,
  ownsIdentitySecret,
  TENANT_HOST_SECRET,
  TenantSchedulerIdentities,
} from './scheduler-identities';
import {
  ACCOUNTS_KEY,
  type AccountsProblem,
  accountsNamesUser,
  SCHEDULER_ACCOUNTS_CONDITION,
  SCHEDULER_NATS_ACCOUNTS,
  schedulerAccountsCondition,
} from './scheduler-nats';
import {
  IDENTITIES_KEY,
  parseIdentityRecord,
  SCHEDULER_IDENTITIES,
  schedulerPkiNamespace,
  tenantHostUser,
  tenantIdentity,
  tenantOperatorUser,
} from './scheduler-pki';
import { SCHEDULER_TLS_ANNOTATION, schedulerCertDigest } from './scheduler-pki-rotation';
import { PlatformSchedulerIdentities } from './scheduler-platform-identities';
import {
  assertSafeBindingStatus,
  bindingProjectionName,
  bindingSecretName,
  electBindingOwner,
  resolveBindingService,
  resolveEgressBindingService,
  serviceBindingResources,
  sharedBindingConflict,
} from './service-binding-reconcile';
import {
  integrityCondition,
  type Observation,
  parseListing,
  planStorage,
  recordsPatch,
  type StoragePlan,
  type StorageRecords,
  storageAllowed,
} from './storage-records';
import { TENANT_OPERATOR_PROPAGATION_MS, tenantOperatorResources } from './tenant-operator';
import { operatorNamespace } from './tenant-operator-names';
import { certificateNames, certificateValid, holdsCaKey, issuedBy, leafCertificate } from './tls';
import {
  STORAGE_FIELD_MANAGER,
  storagePatch,
  type WorkloadDeployment,
  wantsStorage,
} from './workload-storage';

const plurals: Record<string, string> = {
  Namespace: 'namespaces',
  ServiceAccount: 'serviceaccounts',
  Secret: 'secrets',
  ConfigMap: 'configmaps',
  Service: 'services',
  ResourceQuota: 'resourcequotas',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  StorageClass: 'storageclasses',
  Pod: 'pods',
  Deployment: 'deployments',
  Role: 'roles',
  RoleBinding: 'rolebindings',
  ClusterRole: 'clusterroles',
  ClusterRoleBinding: 'clusterrolebindings',
  EndpointSlice: 'endpointslices',
  NetworkPolicy: 'networkpolicies',
  Tenant: 'tenants',
  User: 'users',
  Host: 'hosts',
  BackingServiceClass: 'backingserviceclasses',
  BackingService: 'backingservices',
  ServiceBinding: 'servicebindings',
  WorkloadDeployment: 'workloaddeployments',
  WorkloadReplicaSet: 'workloadreplicasets',
  Workload: 'workloads',
  Artifact: 'artifacts',
  Job: 'jobs',
};
type RolloutDeployment = Resource & {
  spec?: {
    replicas?: number;
    template?: {
      metadata?: { annotations?: Record<string, string> };
      spec?: { volumes?: { name: string }[] };
    };
  };
  status?: {
    observedGeneration?: number;
    replicas?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
  };
};
type MigrationJob = Resource & {
  status?: {
    succeeded?: number;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
};
type WorkloadObject = Resource & {
  metadata: Resource['metadata'] & {
    ownerReferences?: { kind: string; name: string; uid: string; controller?: boolean }[];
  };
  spec?: { replicas?: number };
  status?: Record<string, unknown> & { observedGeneration?: number };
};
/** Annotation that re-queues an unplaced Workload once its tenant has a Ready host (#418). */
export const PLACEMENT_RETRY = 'di-framework.dev/placement-retry';
/** How long a Host must have been Ready before it is used for the nudge (S1 of the #418 review). */
const NUDGE_HOST_SETTLE_MS = 1_000;
/** How old an unplaced Workload must be before it is nudged (S2 of the #418 review). */
const NUDGE_WORKLOAD_MIN_AGE_MS = 5_000;
/** Whether `time` is unset or at least `ms` before `now`. */
function olderThan(time: string | undefined, ms: number, now: number): boolean {
  return !time || now - Date.parse(time) >= ms;
}
/** The sorted uids of the hosts Ready for {@link NUDGE_HOST_SETTLE_MS}, joined; empty if none (#418). */
function settledHostKey(readyHosts: Resource[], now: number): string {
  return readyHosts
    .filter((h) =>
      olderThan(
        (h.status as { conditions?: Condition[] } | undefined)?.conditions?.find(
          (c) => c.type === 'Ready',
        )?.lastTransitionTime,
        NUDGE_HOST_SETTLE_MS,
        now,
      ),
    )
    .map((h) => h.metadata.uid ?? h.metadata.name)
    .sort((a, b) => a.localeCompare(b))
    .join(',');
}
/** Whether an unplaced, live, old-enough Workload still lacks the nudge for `host` (#418). */
function needsNudge(workload: WorkloadObject, host: string, now: number): boolean {
  return (
    !workload.status?.hostId &&
    !workload.metadata.deletionTimestamp &&
    workload.metadata.annotations?.[PLACEMENT_RETRY] !== host &&
    olderThan(workload.metadata.creationTimestamp, NUDGE_WORKLOAD_MIN_AGE_MS, now)
  );
}
/** The controlling owner of `value` of `kind`, as the wasmCloud operator sets it. */
function controllerOf(value: WorkloadObject, kind: string) {
  return value.metadata.ownerReferences?.find(
    (owner) => owner.controller !== false && owner.kind === kind,
  );
}
/** The largest replica count a wasmCloud status reports (absent fields count as zero). */
function runningCount(status: Record<string, unknown>): number {
  return Math.max(
    0,
    ...['replicas', 'currentReplicas', 'readyReplicas', 'availableReplicas'].map(
      (key) => Number(status[key] ?? 0) || 0,
    ),
  );
}
/**
 * Whether `deployment` runs with the registry NATS password whose digest is `digest` (#159): its
 * template carries the digest (and, with `mounted`, the credentials volume), and every replica is
 * updated and ready with no old pod left.
 */
function rolledOutWith(
  deployment: RolloutDeployment | undefined,
  digest: string,
  mounted: boolean,
): boolean {
  const want = deployment?.spec?.replicas ?? 0;
  const template = deployment?.spec?.template;
  const status = deployment?.status;
  return (
    !!deployment &&
    want > 0 &&
    template?.metadata?.annotations?.[REGISTRY_NATS_AUTH_ANNOTATION] === digest &&
    (!mounted || !!template.spec?.volumes?.some((v) => v.name === REGISTRY_NATS_VOLUME)) &&
    status?.observedGeneration === deployment.metadata.generation &&
    status?.updatedReplicas === want &&
    status?.readyReplicas === want &&
    status?.replicas === want
  );
}
export function collection(apiVersion: string, kind: string, namespace?: string): string {
  const plural = plurals[kind];
  if (!plural) throw new Error(`Unsupported resource kind: ${kind}`);
  return `${apiVersion === 'v1' ? '/api/v1' : `/apis/${apiVersion}`}${namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''}/${plural}`;
}
type Owned = Tenant | User | BackingService | ServiceBinding;
function location(value: Resource | Owned): string {
  return `${collection(value.apiVersion, value.kind, value.metadata.namespace)}/${encodeURIComponent(value.metadata.name)}`;
}
export interface Api {
  call<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T>;
}
const CONFLICT_SUMMARY_LIMIT = 1024;
/**
 * Summarize a Kubernetes Status 409 body as the conflicting managers and fields.
 * The raw body is never retained; non-JSON and non-Status bodies yield undefined.
 */
export function summarizeConflict(body: string): string | undefined {
  let status: unknown;
  try {
    status = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof status !== 'object' || status === null) return undefined;
  const s = status as {
    kind?: unknown;
    message?: unknown;
    details?: { causes?: { reason?: unknown; message?: unknown; field?: unknown }[] };
  };
  if (s.kind !== 'Status') return undefined;
  const causes = Array.isArray(s.details?.causes) ? s.details.causes : [];
  const pairs = causes
    .filter((c) => c && c.reason === 'FieldManagerConflict')
    .map((c) => {
      const manager = /conflict with "([^"]*)"/.exec(String(c.message ?? ''))?.[1];
      const field = typeof c.field === 'string' ? c.field : undefined;
      return manager && field ? `${manager}: ${field}` : (manager ?? field);
    })
    .filter((v): v is string => Boolean(v));
  const summary = pairs.length
    ? pairs.join('; ')
    : typeof s.message === 'string'
      ? s.message
      : undefined;
  if (!summary) return undefined;
  return summary.length > CONFLICT_SUMMARY_LIMIT
    ? `${summary.slice(0, CONFLICT_SUMMARY_LIMIT)}...`
    : summary;
}
/** The field manager for the controller's own patches (Tenant metadata, Deployments, Workloads). */
const CONTROLLER_FIELD_MANAGER = 'di-platform-controller';

/** What {@link Controller.removeOwnedNamespace} found: gone, being deleted, or not this Tenant's. */
type NamespaceRemoval = 'gone' | 'deleting' | 'foreign';

/** The remaining-item entry for a namespace a removal step still waits on. */
function namespaceRemaining(state: Exclude<NamespaceRemoval, 'gone'>, name: string): string {
  return state === 'foreign' ? `foreign-namespace/${name}` : `namespace/${name}`;
}

export class ApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
/**
 * A `tenant-controller-ca-<tenant>` Secret this installation did not write for the Tenant (#170).
 * Reported on `TenantAuthReady` (reason `ControllerCaNotOwned`) and logged once, not every pass.
 */
export class ControllerCaRefused extends Error {}
/** `ensure` refused an existing object it did not write (another owner or installation). */
export class AdoptionRefused extends Error {}
export class KubernetesApi implements Api {
  private readonly directory = '/var/run/secrets/kubernetes.io/serviceaccount';
  async call<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<T> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: process.env.KUBERNETES_SERVICE_HOST,
          port: process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443',
          path,
          method,
          // Trust the cluster CA and authenticate with the projected ServiceAccount token.
          // These fixed Kubernetes-mounted paths are never selected by tenant input.
          ca: readFileSync(`${this.directory}/ca.crt`),
          headers: {
            Authorization: `Bearer ${readFileSync(`${this.directory}/token`, 'utf8').trim()}`,
            'Content-Type': contentType,
            ...(data === undefined ? {} : { 'Content-Length': Buffer.byteLength(data) }),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('error', reject);
          res.on('end', () => {
            const plainText = path.split('?')[0]?.endsWith('/log');
            if ((res.statusCode ?? 500) >= 300) {
              // Only a parsed 409 conflict summary is surfaced; other API response bodies
              // stay out of errors and logs because they may contain Secret data.
              const conflict = res.statusCode === 409 ? summarizeConflict(text) : undefined;
              reject(
                new ApiError(
                  res.statusCode ?? 500,
                  `${method} ${path.split('?')[0]} returned ${res.statusCode}${conflict ? `: ${conflict}` : ''}`,
                ),
              );
            } else if (plainText) {
              // Pod logs are plain text, never JSON.
              resolve(text as T);
            } else {
              try {
                resolve(text ? (JSON.parse(text) as T) : (undefined as T));
              } catch (error) {
                reject(error);
              }
            }
          });
        },
      );
      req.setTimeout(15_000, () => req.destroy(new Error('Kubernetes API request timed out')));
      req.on('error', reject);
      req.end(data);
    });
  }
}
/** How far before the cursor each pod log read starts (see projectLogs). */
const LOG_LOOKBACK_MS = 120_000;
/** A generated host pull token: 32 random bytes, base64url. */
const HOST_PULL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TENANT_AUTH_KINDS = [
  ['apps/v1', 'Deployment'],
  ['v1', 'Service'],
  ['networking.k8s.io/v1', 'NetworkPolicy'],
  ['rbac.authorization.k8s.io/v1', 'ClusterRoleBinding'],
  ['rbac.authorization.k8s.io/v1', 'RoleBinding'],
  ['rbac.authorization.k8s.io/v1', 'ClusterRole'],
  ['rbac.authorization.k8s.io/v1', 'Role'],
  ['v1', 'Secret'],
  ['v1', 'ConfigMap'],
  ['v1', 'ServiceAccount'],
  // The tenant registry (#83) carries the same component label.
  ['runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment'],
] as const;
/**
 * The `di-platform-log-reader` Role and RoleBinding that platforms before #321 wrote in each
 * runtime namespace for the logs projection. The controller holds `pods/log get` cluster-wide, so
 * it now deletes them ({@link Controller.pruneLogReader}).
 */
const LOG_READER = 'di-platform-log-reader';
const LOG_READER_KINDS = [
  ['rbac.authorization.k8s.io/v1', 'RoleBinding'],
  ['rbac.authorization.k8s.io/v1', 'Role'],
] as const;

type PodSpecVolumes = {
  volumes?: {
    secret?: { secretName?: string };
    projected?: { sources?: { secret?: { name?: string } }[] };
  }[];
};

/** A host Deployment's pod template, as {@link Controller.hostTlsFor} reads it. */
type HostTemplate = {
  metadata?: { annotations?: Record<string, string> };
  spec?: PodSpecVolumes;
};

/** True when a pod spec mounts Secret `name`, directly or projected. */
function mountsSecret(spec: PodSpecVolumes | undefined, name: string): boolean {
  return (spec?.volumes ?? []).some(
    (v) =>
      v.secret?.secretName === name ||
      !!v.projected?.sources?.some((source) => source.secret?.name === name),
  );
}

/** True when `pod` mounts the pre-cut-over copy {@link SCHEDULER_TLS_COPY} (#541 m6e). */
function mountsSchedulerTlsCopy(pod: Resource): boolean {
  return mountsSecret(pod.spec as PodSpecVolumes | undefined, SCHEDULER_TLS_COPY);
}

export class Controller {
  /**
   * Newest TracingLogger timestamp already projected, per tenant, host pod uid, and projection
   * key (logKeyId). A key's cursor moves only once its ConfigMap is written (#316). Entries of
   * pods and keys that are gone are dropped by projectLogs, and those of tenants no longer
   * projected by tick (#131), so neither grows without bound.
   */
  private readonly logCursors = new Map<string, Map<string, Map<string, string>>>();
  /** Last successful egress name resolution, kept so a failed lookup does not revoke. */
  private readonly egressAddresses = new Map<string, string[]>();
  constructor(
    private readonly api: Api,
    private readonly cfg: ControllerConfig,
    private readonly resolveName: (name: string) => Promise<string[]> = resolveIpv4,
    /** The clock certificate issuance and CA rotation (#170) read. */
    private readonly now: () => Date = () => new Date(),
  ) {
    this.identities = new TenantSchedulerIdentities(api, cfg, now);
    this.accounts = new SchedulerAccountsWriter(api, cfg, now);
    this.platformIdentities = new PlatformSchedulerIdentities(api, cfg, now);
  }
  /** Renewal of the platform's own scheduler NATS identities (#541 m6e-A). */
  private readonly platformIdentities: PlatformSchedulerIdentities;
  /** Issuance of each tenant's scheduler NATS identities (#541 m6c). */
  private readonly identities: TenantSchedulerIdentities;
  /** The scheduler NATS accounts file (#541 m6d). */
  private readonly accounts: SchedulerAccountsWriter;
  /**
   * Per tenant, the operator user the written accounts file was first seen to name, and when; the
   * operator Deployment is created {@link TENANT_OPERATOR_PROPAGATION_MS} later (#541 m6e).
   */
  private readonly accountsSeen = new Map<
    string,
    Partial<Record<'hosts' | 'operator', { user: string; since: number }>>
  >();
  /**
   * The problems of the last accounts render, reported on every Tenant: empty when it was written,
   * undefined while unknown (before the first render since start, or after a failed read), when
   * each Tenant keeps the `SchedulerAccounts` condition it has.
   */
  private accountsProblems: AccountsProblem[] | undefined;
  private async get<T>(path: string): Promise<T | undefined> {
    try {
      return await this.api.call<T>('GET', path);
    } catch (error) {
      if (error instanceof ApiError && error.code === 404) return undefined;
      throw error;
    }
  }
  private async list<T>(
    apiVersion: string,
    kind: string,
    labels: Record<string, string>,
    namespace?: string,
  ): Promise<T[]> {
    const selector = Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const result = await this.api.call<{ items: T[] }>(
      'GET',
      `${collection(apiVersion, kind, namespace)}?labelSelector=${encodeURIComponent(selector)}`,
    );
    // Core Kubernetes list items may omit TypeMeta even though individual GETs include it.
    return result.items.map((item) => ({ ...item, apiVersion, kind }));
  }
  /**
   * The tenant's host pods that removal waits for (#245): terminating ones (the operator still has
   * to clear their pod-host finalizer) and ones not yet finished. A finished pod (`Succeeded` or
   * `Failed`, e.g. evicted) that nobody deletes holds nothing back: scaling to zero does not
   * remove it, and under Retain nothing else would.
   */
  private async liveHostPods(n: ReturnType<typeof names>): Promise<Resource[]> {
    const pods = await this.list<Resource>(
      'v1',
      'Pod',
      { 'wasmcloud.com/hostgroup': n.hostgroup, 'wasmcloud.com/name': 'hostgroup' },
      n.runtimeNamespace,
    );
    return pods.filter((pod) => {
      if (pod.metadata.deletionTimestamp) return true;
      const phase = (pod.status as { phase?: string } | undefined)?.phase;
      return phase !== 'Succeeded' && phase !== 'Failed';
    });
  }
  private async remove(value: Resource): Promise<void> {
    try {
      await this.api.call('DELETE', location(value), {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        preconditions: { uid: value.metadata.uid },
        propagationPolicy: 'Background',
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 404)) throw error;
    }
  }
  /**
   * Server-side apply `value` unless a foreign object holds its name. `fetched` holds objects this
   * pass already read, keyed by path, so the adoption check does not GET them again.
   */
  private async ensure(
    value: Resource,
    bootstrap = false,
    adoptSameBinding = false,
    fetched?: ReadonlyMap<string, Resource | undefined>,
  ): Promise<Resource> {
    const path = location(value);
    const existing = fetched?.has(path) ? fetched.get(path) : await this.get<Resource>(path);
    const labels = existing?.metadata.labels;
    const sameBinding =
      adoptSameBinding &&
      labels?.[INSTALLATION] === this.cfg.installation &&
      labels?.[TENANT] === value.metadata.labels?.[TENANT] &&
      labels?.[BINDING] === value.metadata.labels?.[BINDING];
    if (
      existing &&
      (labels?.[INSTALLATION] !== this.cfg.installation ||
        (labels?.[OWNER] !== value.metadata.labels?.[OWNER] &&
          !(
            bootstrap &&
            !labels?.[OWNER] &&
            labels?.[TENANT] === value.metadata.labels?.[TENANT]
          ) &&
          !sameBinding))
    ) {
      throw new AdoptionRefused(
        `Refusing to adopt ${value.kind} ${value.metadata.namespace ?? ''}/${value.metadata.name}`,
      );
    }
    if (
      existing &&
      value.kind === 'RoleBinding' &&
      JSON.stringify(existing.roleRef) !== JSON.stringify(value.roleRef)
    ) {
      // roleRef is immutable. Remove the previous grant before changing roles.
      await this.remove(existing);
    }
    return this.api.call<Resource>(
      'PATCH',
      `${location(value)}?fieldManager=${CONTROLLER_FIELD_MANAGER}`,
      value,
      'application/apply-patch+yaml',
    );
  }
  private async finalizer(value: Owned, add: boolean): Promise<void> {
    const old = value.metadata.finalizers ?? [];
    const finalizers = add ? [...new Set([...old, FINALIZER])] : old.filter((f) => f !== FINALIZER);
    if (JSON.stringify(old) !== JSON.stringify(finalizers)) {
      const updated = await this.api.call<Owned>(
        'PATCH',
        `${location(value)}?fieldManager=${CONTROLLER_FIELD_MANAGER}`,
        { metadata: { resourceVersion: value.metadata.resourceVersion, finalizers } },
        'application/merge-patch+json',
      );
      value.metadata = updated.metadata;
    }
  }
  private async status(
    value: Owned,
    ready: boolean,
    reason: string,
    message: string,
    extra: Record<string, unknown> = {},
    others: Condition[] = [],
  ): Promise<void> {
    const old = value.status?.conditions?.find((c) => c.type === 'Ready');
    const condition: Condition = {
      type: 'Ready',
      status: ready ? 'True' : 'False',
      reason,
      message,
      observedGeneration: value.metadata.generation ?? 1,
      lastTransitionTime:
        old?.status === (ready ? 'True' : 'False')
          ? old.lastTransitionTime
          : new Date().toISOString(),
    };
    const status = {
      ...extra,
      observedGeneration: value.metadata.generation ?? 1,
      conditions: [
        condition,
        ...others.map((c) => {
          const previous = value.status?.conditions?.find((p) => p.type === c.type);
          return previous?.status === c.status
            ? { ...c, lastTransitionTime: previous.lastTransitionTime }
            : c;
        }),
      ],
    };
    if (JSON.stringify(value.status) === JSON.stringify(status)) return;
    await this.api.call(
      'PATCH',
      `${location(value)}/status`,
      { metadata: { resourceVersion: value.metadata.resourceVersion }, status },
      'application/merge-patch+json',
    );
    value.status = status;
  }
  private async revoke(
    labels: Record<string, string>,
    keep: (binding: Resource) => boolean = () => false,
  ): Promise<void> {
    for (const kind of ['RoleBinding', 'ClusterRoleBinding'])
      for (const binding of await this.list<Resource>('rbac.authorization.k8s.io/v1', kind, {
        [INSTALLATION]: this.cfg.installation,
        ...labels,
      }))
        if (!keep(binding)) await this.remove(binding);
  }
  /**
   * Removal of a Tenant with a `deletionTimestamp`: steps R1-R7 in order (design-541 §4.5). Each
   * pass re-checks the steps from R1 and stops at the first that is not complete; nothing is ever
   * skipped. A step left incomplete past its deadline sets `RemovalStuck` (reason: the step ID)
   * and is retried, never forced.
   */
  private async removeTenant(tenant: Tenant): Promise<void> {
    const steps: [RemovalStep, () => Promise<string[]>][] = [
      // R1 and R4 drop the record entries; their reload-applied checks and the R3 Retain
      // finalizer removal arrive with the cut-over (m6e).
      ['R1', () => this.identities.drop(tenant.metadata.name, 'hosts').then(() => [])],
      ['R2', () => this.removalStopHosts(tenant)],
      ['R3', () => this.removalWorkloads(tenant)],
      ['R4', () => this.identities.drop(tenant.metadata.name, 'operator').then(() => [])],
      ['R5', () => this.removalOperator(tenant)],
      ['R6', () => this.removalNamespaces(tenant)],
    ];
    for (const [step, run] of steps) {
      const remaining = await run();
      if (remaining.length === 0) continue;
      // Through R3 the tenant's own operator clears its host pods' and Workloads' finalizers, so it
      // keeps running and keeps its identity (owner decision 4); R4 then drops it.
      if (step === 'R1' || step === 'R2' || step === 'R3') await this.keepTenantOperator(tenant);
      await this.removalBlocked(tenant, step, remaining);
      return;
    }
    // R7.
    await this.finalizer(tenant, false);
  }
  /** Records the step removal waits on, and reports it (with `RemovalStuck` past its deadline). */
  private async removalBlocked(
    tenant: Tenant,
    step: RemovalStep,
    remaining: string[],
  ): Promise<void> {
    const recorded = tenant.metadata.annotations?.[REMOVAL_STEP_ANNOTATION];
    const progress = removalProgress(recorded, step, this.now());
    if (recorded !== progress.annotation) {
      const updated = await this.api.call<Tenant>(
        'PATCH',
        `${location(tenant)}?fieldManager=${CONTROLLER_FIELD_MANAGER}`,
        { metadata: { annotations: { [REMOVAL_STEP_ANNOTATION]: progress.annotation } } },
        'application/merge-patch+json',
      );
      tenant.metadata = updated.metadata;
    }
    const n = names(tenant.metadata.name);
    const policy = tenant.spec.deletionPolicy ?? 'Retain';
    const pods = remaining.filter((r) => r.startsWith('pod/'));
    const hostPods = pods.length === remaining.length;
    await this.status(
      tenant,
      false,
      hostPods ? 'WaitingForHostPods' : 'Removing',
      hostPods
        ? `${policy}: waiting for host pods in ${n.runtimeNamespace} to be gone before removing the Tenant: ${remainingSummary(pods.map((r) => r.slice('pod/'.length)))}`
        : `${policy}: removal step ${step} waits for ${remainingSummary(remaining)}`,
      {},
      progress.stuck
        ? [removalStuckCondition(step, remaining, progress.since, tenant.metadata.generation ?? 1)]
        : [],
    );
  }
  /**
   * R2: scale the tenant's Deployments to zero, except its own runtime-operator, and wait for
   * the host pods (terminating ones included, #245) and the Hosts in `di-operator-<t>` to be gone.
   */
  private async removalStopHosts(tenant: Tenant): Promise<string[]> {
    const t = tenant.metadata.name;
    const n = names(t);
    const remaining: string[] = [];
    const deployments = await this.list<Resource>('apps/v1', 'Deployment', {
      [INSTALLATION]: this.cfg.installation,
      [OWNER]: tenant.metadata.uid!,
    });
    for (const deployment of deployments.filter((d) => sweepsDeployment(d, t))) {
      const updated = await this.api.call<Resource>(
        'PATCH',
        `${location(deployment)}?fieldManager=${CONTROLLER_FIELD_MANAGER}`,
        {
          metadata: { resourceVersion: deployment.metadata.resourceVersion },
          spec: { replicas: 0 },
        },
        'application/merge-patch+json',
      );
      const status = updated.status as
        | { observedGeneration?: number; replicas?: number }
        | undefined;
      if (
        status?.observedGeneration !== updated.metadata.generation ||
        (status?.replicas ?? 0) !== 0
      )
        remaining.push(`deployment/${deployment.metadata.namespace}/${deployment.metadata.name}`);
    }
    if (remaining.length) return remaining;
    // `status.replicas` leaves out terminating pods, so also wait for the live host pods to be
    // gone (#245). The wasmCloud operator clears their pod-host finalizer only while it watches
    // the runtime namespace. The list is read-only and scoped to this tenant's runtime namespace
    // and hostgroup.
    for (const pod of await this.liveHostPods(n)) remaining.push(`pod/${pod.metadata.name}`);
    for (const host of await this.list<Resource>(
      'runtime.wasmcloud.dev/v1alpha1',
      'Host',
      {},
      operatorNamespace(t),
    ))
      remaining.push(`host/${host.metadata.name}`);
    return remaining;
  }
  /**
   * R3 under `Delete`: delete the tenant's WorkloadDeployments, then wait until no
   * `runtime.wasmcloud.dev` object in `di-tenant-<t>` carries a finalizer and no Artifact remains.
   * Under `Retain` m5 keeps today's path; the finalizer removal arrives with m6.
   */
  private async removalWorkloads(tenant: Tenant): Promise<string[]> {
    if (tenant.spec.deletionPolicy !== 'Delete') return [];
    const n = names(tenant.metadata.name);
    const list = (kind: string) =>
      this.list<Resource>('runtime.wasmcloud.dev/v1alpha1', kind, {}, n.namespace);
    for (const deployment of await list('WorkloadDeployment'))
      if (!deployment.metadata.deletionTimestamp) await this.remove(deployment);
    const remaining: string[] = [];
    for (const kind of ['WorkloadDeployment', 'WorkloadReplicaSet', 'Workload', 'Artifact'])
      for (const value of await list(kind))
        if (kind === 'Artifact' || value.metadata.finalizers?.length)
          remaining.push(`${kind.toLowerCase()}/${value.metadata.name}`);
    return remaining;
  }
  /**
   * R5: delete the RoleBindings to the tenant-operator ClusterRoles (under both policies, so a
   * re-created Tenant starts clean), then `di-operator-<t>`.
   */
  private async removalOperator(tenant: Tenant): Promise<string[]> {
    const t = tenant.metadata.name;
    const bindings = async () =>
      (
        await this.list<Resource>('rbac.authorization.k8s.io/v1', 'RoleBinding', {
          [INSTALLATION]: this.cfg.installation,
          [TENANT]: t,
        })
      ).filter(bindsTenantOperatorRole);
    for (const binding of await bindings()) await this.remove(binding);
    // The hosts' scheduler identity, which a retained runtime namespace would otherwise keep; the
    // operator's goes with `di-operator-<t>` below.
    const identity = await this.get<Resource>(
      `${collection('v1', 'Secret', names(t).runtimeNamespace)}/${TENANT_HOST_SECRET}`,
    );
    if (identity && ownsIdentitySecret(identity, this.cfg.installation, tenant.metadata.uid))
      await this.remove(identity);
    // A copy of `wasmcloud-runtime-tls` left from before the cut-over (#541 m6e).
    const copy = await this.get<Resource>(
      `${collection('v1', 'Secret', names(t).runtimeNamespace)}/${SCHEDULER_TLS_COPY}`,
    );
    if (copy && this.ownsCopy(copy, tenant)) await this.remove(copy);
    const remaining = (await bindings()).map(
      (b) => `rolebinding/${b.metadata.namespace}/${b.metadata.name}`,
    );
    if (remaining.length) return remaining;
    const ns = operatorNamespace(t);
    const state = await this.removeOwnedNamespace(tenant, ns);
    if (state !== 'gone') remaining.push(namespaceRemaining(state, ns));
    return remaining;
  }
  /** R6: under `Delete`, delete the tenant's namespaces as before; `Retain` keeps them. */
  private async removalNamespaces(tenant: Tenant): Promise<string[]> {
    if (tenant.spec.deletionPolicy !== 'Delete') return [];
    const n = names(tenant.metadata.name);
    const remaining: string[] = [];
    for (const name of [n.namespace, n.runtimeNamespace, n.apiKeysNamespace]) {
      const state = await this.removeOwnedNamespace(tenant, name);
      if (state !== 'gone') remaining.push(namespaceRemaining(state, name));
    }
    return remaining;
  }
  /**
   * Deletes namespace `name` if it exists and this Tenant owns it. A namespace this Tenant does
   * not own is never deleted: it is reported as `foreign`, so the step waits on it.
   */
  private async removeOwnedNamespace(tenant: Tenant, name: string): Promise<NamespaceRemoval> {
    const namespace = await this.get<Resource>(`${collection('v1', 'Namespace')}/${name}`);
    if (!namespace) return 'gone';
    if (
      namespace.metadata.labels?.[OWNER] !== tenant.metadata.uid ||
      namespace.metadata.labels?.[INSTALLATION] !== this.cfg.installation
    )
      return 'foreign';
    await this.remove(namespace);
    return 'deleting';
  }
  /**
   * What {@link tenantAuthResources} needs from the cluster: the tenant's members (from
   * the User CRs, so a membership change re-renders the TokenRequest `resourceNames` on the next
   * reconcile), the API server endpoints, the controller certificate (kept until 30 days before
   * it expires) and the shared OAuth client secret from the platform namespace.
   */
  private async tenantAuthInputs(
    tenant: Tenant,
    users: User[],
    fetched: Map<string, Resource | undefined>,
  ): Promise<TenantAuthInputs> {
    const auth = this.cfg.tenantAuth!;
    const name = tenant.metadata.name;
    // Suspended members too, flagged, so `/-/members` lists them without reading Users (#321).
    const members = users
      .filter((u) => !u.metadata.deletionTimestamp)
      .flatMap((u) =>
        u.spec.memberships
          .filter((m) => m.tenant === name)
          .map((m) => ({ name: u.metadata.name, role: m.role, suspended: !!u.spec.suspended })),
      );
    const apiServer = await this.apiServerEndpoints();
    const tls = await this.controllerTls(tenant, auth, fetched);
    const oauth = await this.get<{ data?: Record<string, string> }>(
      `${collection('v1', 'Secret', this.cfg.namespace)}/${auth.oauthClient.secretName}`,
    );
    return {
      members,
      apiServer,
      tls,
      clientSecret: oauth?.data?.[auth.oauthClient.secretKey ?? 'clientSecret'],
      ...(auth.registry ? { hostPullToken: await this.hostPullToken(name) } : {}),
    };
  }
  /** {@link apiServerEndpoints} of the running {@link tick}, read once for every Tenant. */
  private tickApiServer?: { read?: Promise<{ addresses: string[]; port: number }> };
  /**
   * The API server's addresses and port, from the `kubernetes` EndpointSlices in `default`: read
   * once per {@link tick}, and on every call outside one.
   */
  private apiServerEndpoints(): Promise<{ addresses: string[]; port: number }> {
    if (!this.tickApiServer) return this.readApiServerEndpoints();
    this.tickApiServer.read ??= this.readApiServerEndpoints();
    return this.tickApiServer.read;
  }
  private async readApiServerEndpoints(): Promise<{ addresses: string[]; port: number }> {
    const slices = (
      await this.list<
        Resource & { endpoints?: { addresses: string[] }[]; ports?: { port: number }[] }
      >('discovery.k8s.io/v1', 'EndpointSlice', { 'kubernetes.io/service-name': 'kubernetes' })
    ).filter((s) => s.metadata.namespace === 'default');
    return {
      addresses: [
        ...new Set(slices.flatMap((s) => (s.endpoints ?? []).flatMap((e) => e.addresses))),
      ],
      port: slices[0]?.ports?.[0]?.port ?? 443,
    };
  }
  /**
   * The controller's TLS material: long-lived CAs (#170) and a leaf the current one signed. The CAs
   * and their keys live in the platform namespace ({@link tenantControllerCaSecret}), so deleting
   * `tenant-controller-tls` reissues only the leaf. {@link rotateCas} decides which CAs to keep and
   * overlaps them during a rotation. The leaf is reused while it verifies against the current CA,
   * has {@link LEAF_RENEW_DAYS} left and names what it should, so a leaf renewal keeps the CA and
   * does not roll the hosts or invalidate kubeconfigs. The CAs permit only the leaf's names (#365),
   * so a change of names is a rotation too.
   *
   * Until the platform-namespace Secret exists, the CA is taken from where it was kept before:
   * `ca.crt` in `tenant-controller-tls` and `ca.key` in the runtime namespace's
   * `tenant-controller-ca-key`, which the pass deletes once the new Secret is applied. When both
   * exist and the legacy pair is a different working CA, an older package replaced the CA after a
   * downgrade; that CA is what every party trusts, so it is adopted as is. A Secret from before
   * the CA existed has neither and is replaced once. Only Secrets this installation wrote for the
   * Tenant are read; a foreign platform-namespace CA Secret is refused ({@link ControllerCaRefused})
   * before anything is rendered from it. The Secrets read are recorded in `fetched`, so applying
   * them later in the pass does not read them again.
   */
  private async controllerTls(
    tenant: Tenant,
    auth: TenantAuthConfig,
    fetched: Map<string, Resource | undefined>,
  ): Promise<TenantAuthInputs['tls']> {
    const name = tenant.metadata.name;
    const runtimeNamespace = names(name).runtimeNamespace;
    // One GET per Secret: several keys are decoded from each.
    const secret = async (namespace: string, secretName: string) => {
      const path = `${collection('v1', 'Secret', namespace)}/${secretName}`;
      const value = await this.get<Resource & { data?: Record<string, string> }>(path);
      fetched.set(path, value);
      return value;
    };
    const caSecretName = tenantControllerCaSecret(name);
    const [tlsSecret, caSecret, legacySecret] = await Promise.all([
      secret(runtimeNamespace, 'tenant-controller-tls'),
      secret(this.cfg.namespace, caSecretName),
      secret(runtimeNamespace, TENANT_CONTROLLER_CA_KEY_SECRET),
    ]);
    // Only what this installation wrote for this Tenant is ever read; a foreign
    // `tenant-controller-tls` is then refused when it is applied, as before.
    const owned = (value: Resource | undefined) =>
      value?.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
      value.metadata.labels[OWNER] === tenant.metadata.uid;
    // The trust anchor itself: refused before anything is rendered from it, so its CA never
    // reaches the bundle or the leaf.
    if (caSecret && !owned(caSecret))
      throw new ControllerCaRefused(
        `Refusing to adopt Secret ${this.cfg.namespace}/${caSecretName}: it holds the tenant ` +
          `controller CA but was not written by installation ${this.cfg.installation} for this ` +
          'Tenant. Delete it to let the controller write its own.',
      );
    const decode = (value: { data?: Record<string, string> } | undefined, key: string) =>
      owned(value as Resource | undefined)
        ? Buffer.from(value?.data?.[key] ?? '', 'base64').toString()
        : '';
    const [cert, key] = [decode(tlsSecret, 'tls.crt'), decode(tlsSecret, 'tls.key')];
    // The layout before #170, and what an older platform package writes after a downgrade.
    const legacy = { cert: decode(tlsSecret, 'ca.crt'), key: decode(legacySecret, 'ca.key') };
    const fromCaSecret = caSecret && {
      current: { cert: decode(caSecret, 'ca.crt'), key: decode(caSecret, 'ca.key') },
      next: { cert: decode(caSecret, 'next.crt'), key: decode(caSecret, 'next.key') },
      previous: decode(caSecret, 'previous.crt'),
    };
    // A working legacy pair with a different CA than the platform Secret means an older package
    // ran since the move and replaced the CA (a downgrade, then this upgrade). Everything trusts
    // that CA now, so it is adopted unchanged; the platform Secret's CA is stale and dropped.
    const stored =
      fromCaSecret &&
      !(holdsCaKey(legacy.cert, legacy.key) && legacy.cert !== fromCaSecret.current.cert)
        ? fromCaSecret
        : { current: legacy };
    const now = this.now();
    const wanted = tenantControllerCertNames(name, auth);
    const cas = rotateCas(
      stored,
      {
        commonName: `tenant-controller CA (${runtimeNamespace})`,
        dnsNames: wanted.dns,
        ipAddresses: wanted.ips,
      },
      now,
    );
    const ca = {
      caCert: cas.current.cert,
      caKey: cas.current.key,
      ...(cas.next ? { caNext: cas.next } : {}),
      ...(cas.previous ? { caPrevious: cas.previous } : {}),
    };
    // While a successor is published the leaf keeps the names it serves, so no host goes dark
    // before the switch; names the signing CA does not permit wait for the switch (#365).
    const served = issuedBy(ca.caCert, cert, key) ? certificateNames(cert) : undefined;
    const certNames = leafNames(cas, wanted, served);
    if (
      served &&
      certificateValid(cert, LEAF_RENEW_DAYS, now) &&
      JSON.stringify(served) === JSON.stringify(certNames)
    )
      return { cert, key, ...ca };
    const leaf = leafCertificate(
      `tenant-controller.${runtimeNamespace}.svc`,
      certNames.dns,
      certNames.ips,
      365,
      ca.caCert,
      ca.caKey,
      now,
    );
    return { ...leaf, ...ca };
  }
  /**
   * The host pull token (#83 `:host-pull`): the one in `di-tenant-registry-pull` while it is well
   * formed, otherwise a new random one. Deleting the Secret therefore rotates it.
   */
  private async hostPullToken(tenant: string): Promise<string> {
    const existing = await this.get<{ data?: Record<string, string> }>(
      `${collection('v1', 'Secret', names(tenant).runtimeNamespace)}/${REGISTRY_PULL_SECRET}`,
    );
    const token = Buffer.from(existing?.data?.token ?? '', 'base64').toString();
    return HOST_PULL_TOKEN.test(token) ? token : randomBytes(32).toString('base64url');
  }
  /**
   * The host wiring last rendered per tenant (W1/S6 of the #83 `:host-pull` review). Entries of
   * tenants that are gone are dropped by tick (#131).
   */
  private readonly hostPulls = new Map<string, HostPull | undefined>();
  /** The last `storage-mode` listing read, per Tenant uid, with the host pod uid it came from. */
  /** Per Tenant uid: the last listing read, and the `<pod uid>/<restartCount>` run it came from. */
  private readonly storageListings = new Map<string, { pod: string; observation: Observation }>();
  /**
   * How the tenant hosts pull from the registry (#83 `:host-pull`), decided from desired state
   * (W1 of the review): wired while `tenantAuth.registry` is set, the registry is deployed and
   * the tenant is not suspended, whether or not the pull Secret exists right now. Its volume is
   * optional, so a host started during a rotation pulls anonymously until the kubelet syncs it.
   * Over TLS the CA digest is the current `tenant-controller-ca`'s; while that ConfigMap is
   * missing the last known digest (remembered here, else read from the host template) is kept,
   * so only a different CA rolls the hosts.
   */
  private async hostPull(tenant: Tenant, registryDeployed: boolean): Promise<HostPull | undefined> {
    const name = tenant.metadata.name;
    const wiring = await this.hostPullWiring(tenant, registryDeployed);
    this.hostPulls.set(name, wiring);
    return wiring;
  }
  private async hostPullWiring(
    tenant: Tenant,
    registryDeployed: boolean,
  ): Promise<HostPull | undefined> {
    if (!registryDeployed || tenant.spec.suspended) return undefined;
    const n = names(tenant.metadata.name);
    const ca = await this.get<{ data?: Record<string, string> }>(
      `${collection('v1', 'ConfigMap', n.runtimeNamespace)}/tenant-controller-ca`,
    );
    const cert = ca?.data?.['ca.crt'];
    if (cert) return { caDigest: tlsCertDigest(cert) };
    const known =
      this.hostPulls.get(tenant.metadata.name)?.caDigest ??
      (
        await this.get<{ spec?: { template?: { metadata?: Resource['metadata'] } } }>(
          `${collection('apps/v1', 'Deployment', n.runtimeNamespace)}/hostgroup-${n.hostgroup}`,
        )
      )?.spec?.template?.metadata?.annotations?.[REGISTRY_CA_ANNOTATION];
    return known ? { caDigest: known } : {};
  }
  /** Set once the host image warning (#159) has been logged. */
  private registryNatsWarned = false;
  /**
   * The registry's NATS account wiring (#159), read from the cluster each pass so the tenant step
   * and the tenant-auth step agree; see {@link RegistryNatsStage}.
   *
   * - Undefined while `tenantAuth.registry` is unset, and while the host image is not a known build
   *   with wash patch 0003 and the move has not started: the registry stays anonymous in `TENANT`
   *   (logged once) rather than switching to credentials its host would ignore.
   * - Once the move started (a migration Job exists, or the marker says it is done), the registry
   *   is never anonymous again, whatever the host image: it stays stopped until it can use its
   *   credentials, so it never recreates `OBJ_oci-registry` in `TENANT`.
   * - The Job is created only after `di-nats` and the hosts rolled out with this password and a
   *   previous pass stopped the registry and saw it stopped.
   *
   * The password is the one in `di-nats-registry` while well formed, otherwise a new one.
   */
  private async registryNats(tenant: Tenant): Promise<RegistryNats | undefined> {
    if (!this.cfg.tenantAuth?.registry) return undefined;
    const n = names(tenant.metadata.name);
    const at = (apiVersion: string, kind: string, name: string) =>
      `${collection(apiVersion, kind, n.runtimeNamespace)}/${name}`;
    const [marker, found] = await Promise.all([
      this.get<{ data?: Record<string, string> }>(at('v1', 'ConfigMap', REGISTRY_NATS_MIGRATION)),
      this.get<MigrationJob>(at('batch/v1', 'Job', REGISTRY_NATS_MIGRATION_JOB)),
    ]);
    const job =
      found?.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
      found.metadata.labels[OWNER] === tenant.metadata.uid
        ? found
        : undefined;
    const migrated = marker?.data?.state === 'complete' || (job?.status?.succeeded ?? 0) > 0;
    const credentials = hostImageSupportsNatsCredentials(this.cfg.hostImage);
    if (!credentials && !this.registryNatsWarned) {
      this.registryNatsWarned = true;
      console.warn(
        `tenantHostImage ${this.cfg.hostImage} is not a known build with wash patch 0003 (NATS blobstore credentials): ` +
          `tenant registries that have not moved stay in the ${NATS_TENANT_ACCOUNT} NATS account, and registries that ` +
          `already moved (or are moving) to ${NATS_REGISTRY_ACCOUNT} stay stopped until it is (#159)`,
      );
    }
    if (!credentials && !migrated && !job) return undefined;
    const secret = await this.get<{ data?: Record<string, string> }>(
      at('v1', 'Secret', REGISTRY_NATS_SECRET),
    );
    const stored = Buffer.from(secret?.data?.password ?? '', 'base64').toString();
    const password = REGISTRY_NATS_PASSWORD.test(stored) ? stored : newRegistryNatsPassword();
    if (migrated) return { password, stage: 'migrated', credentials };
    if (job) {
      // A Job that exists keeps the registry stopped until it ends, even if a rotation or an
      // image change rolls di-nats or the hosts meanwhile.
      const failure = job.status?.conditions?.find(
        (c) => c.type === 'Failed' && c.status === 'True',
      );
      return {
        password,
        stage: 'migrating',
        credentials,
        ...(failure ? { failed: failure.reason ?? failure.message ?? 'Failed' } : {}),
      };
    }
    if (tenant.spec.suspended || tenant.metadata.deletionTimestamp)
      return { password, stage: 'rollout', credentials };
    const digest = registryNatsAuthDigest(password);
    const [nats, hosts] = await Promise.all([
      this.get<RolloutDeployment>(at('apps/v1', 'Deployment', 'di-nats')),
      this.get<RolloutDeployment>(at('apps/v1', 'Deployment', `hostgroup-${n.hostgroup}`)),
    ]);
    if (!rolledOutWith(nats, digest, false) || !rolledOutWith(hosts, digest, true))
      return { password, stage: 'rollout', credentials };
    return {
      password,
      stage: (await this.registryStopped(tenant)) ? 'migrating' : 'stopping',
      credentials,
    };
  }
  /**
   * Whether the tenant registry is observed stopped (#159): its WorkloadDeployment asks for no
   * replica, its status (when reported) is current and counts none, every WorkloadReplicaSet it
   * controls is at zero, and no Workload of those sets is left. A registry that does not exist
   * is stopped.
   */
  private async registryStopped(tenant: Tenant): Promise<boolean> {
    const namespace = names(tenant.metadata.name).namespace;
    const group = 'runtime.wasmcloud.dev/v1alpha1';
    const deployment = await this.get<WorkloadObject>(
      `${collection(group, 'WorkloadDeployment', namespace)}/${REGISTRY_WORKLOAD}`,
    );
    if (!deployment) return true;
    const status = deployment.status ?? {};
    if (
      (deployment.spec?.replicas ?? 1) !== 0 ||
      (status.observedGeneration !== undefined &&
        status.observedGeneration !== deployment.metadata.generation) ||
      runningCount(status) > 0
    )
      return false;
    const [sets, workloads] = await Promise.all([
      this.list<WorkloadObject>(group, 'WorkloadReplicaSet', {}, namespace),
      this.list<WorkloadObject>(group, 'Workload', {}, namespace),
    ]);
    const owned = sets.filter(
      (set) => controllerOf(set, 'WorkloadDeployment')?.uid === deployment.metadata.uid,
    );
    if (owned.some((set) => (set.spec?.replicas ?? 0) > 0 || runningCount(set.status ?? {}) > 0))
      return false;
    return !workloads.some((workload) => {
      const owner = controllerOf(workload, 'WorkloadReplicaSet');
      return owned.some(
        (set) => set.metadata.uid === owner?.uid || set.metadata.name === owner?.name,
      );
    });
  }
  /** Workload/host pairs whose nudge PATCH failed and was logged, so each is logged once (#418). */
  private readonly nudgeFailures = new Set<string>();
  /**
   * Re-queues the tenant's unplaced Workloads once a Ready host exists (#418). The upstream
   * workload controller does not watch Hosts and retries a Workload that found no host only on
   * its 30 s timer, but its Workload watch has no predicate, so a metadata change enqueues it at
   * once. The annotation names the set of Ready hosts, so each Workload is patched once per set
   * and again whenever any host joins or leaves it.
   *
   * Best-effort: it never throws. A Workload that is gone (404) is skipped, and any other failure
   * is logged once per Workload and host. A host is used only once it has been Ready for
   * {@link NUDGE_HOST_SETTLE_MS}, so the operator's informer cache has seen it, and a Workload is
   * nudged only once it is {@link NUDGE_WORKLOAD_MIN_AGE_MS} old, so new ones the operator is still
   * placing are left alone; both are retried on the next poll.
   */
  private async nudgeUnplaced(namespace: string, readyHosts: Resource[]): Promise<void> {
    const now = this.now().getTime();
    const host = settledHostKey(readyHosts, now);
    if (!host) return;
    let workloads: WorkloadObject[];
    try {
      workloads = await this.list<WorkloadObject>(
        'runtime.wasmcloud.dev/v1alpha1',
        'Workload',
        {},
        namespace,
      );
    } catch (error) {
      console.warn(
        `Placement nudge in ${namespace}: listing Workloads failed: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }
    for (const workload of workloads) {
      if (needsNudge(workload, host, now)) await this.nudgeWorkload(namespace, workload, host);
    }
  }
  /** Sets {@link PLACEMENT_RETRY} on one Workload; see {@link nudgeUnplaced} for failures. */
  private async nudgeWorkload(
    namespace: string,
    workload: WorkloadObject,
    host: string,
  ): Promise<void> {
    try {
      await this.api.call(
        'PATCH',
        `${location(workload)}?fieldManager=${CONTROLLER_FIELD_MANAGER}`,
        { metadata: { annotations: { [PLACEMENT_RETRY]: host } } },
        'application/merge-patch+json',
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 404) return;
      const failure = `${namespace}/${workload.metadata.name}@${host}`;
      if (this.nudgeFailures.has(failure)) return;
      this.nudgeFailures.add(failure);
      console.warn(
        `Placement nudge of Workload ${failure} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  /** How the registry workload reaches `di-nats` for {@link registryNats} (#159). */
  private static registryNatsMode(state: RegistryNats | undefined): RegistryNatsMode | undefined {
    if (!state || state.stage === 'rollout') return undefined;
    return state.stage === 'migrated' && state.credentials ? 'credentials' : 'stopped';
  }
  /**
   * True once the accounts file this controller wrote has named the current user of the tenant's
   * `kind` identity for {@link TENANT_OPERATOR_PROPAGATION_MS}. Nothing reports when NATS has
   * loaded the file (owner decision 1), so a client whose new certificate names that user, and
   * which exits when its first connect is refused, starts only after that fixed wait (#541 m6e):
   * the operator's creation, and every move of the hosts to a new certificate (S2 of the #613
   * review). In memory: a restarted controller waits once more.
   */
  private async accountsLoaded(t: string, kind: 'hosts' | 'operator'): Promise<boolean> {
    const record = await this.get<{ data?: Record<string, string> }>(
      `${collection('v1', 'ConfigMap', schedulerPkiNamespace(this.cfg.namespace))}/${SCHEDULER_IDENTITIES}`,
    );
    const id = parseIdentityRecord(record?.data?.[IDENTITIES_KEY] ?? '')[tenantIdentity(t, kind)]
      ?.current;
    const accounts = id
      ? await this.get<{ data?: Record<string, string> }>(
          `${collection('v1', 'ConfigMap', this.cfg.namespace)}/${SCHEDULER_NATS_ACCOUNTS}`,
        )
      : undefined;
    const userOf = kind === 'hosts' ? tenantHostUser : tenantOperatorUser;
    const user = id ? userOf(t, id) : '';
    const seen = this.accountsSeen.get(t) ?? {};
    this.accountsSeen.set(t, seen);
    if (!id || !accountsNamesUser(accounts?.data?.[ACCOUNTS_KEY] ?? '', user)) {
      delete seen[kind];
      return false;
    }
    const now = this.now().getTime();
    const since = seen[kind]?.user === user ? seen[kind].since : undefined;
    if (since === undefined) {
      seen[kind] = { user, since: now };
      return false;
    }
    return now - since >= TENANT_OPERATOR_PROPAGATION_MS;
  }
  /**
   * Applies the tenant's runtime-operator in `di-operator-<t>` (#541 m6e, design-541 §4.6), one
   * object at a time: the Namespace, ServiceAccount and RoleBindings, then its policies, then the
   * Deployment. A Deployment that does not exist yet is created only once its accounts have
   * propagated ({@link accountsLoaded}); one that exists is always applied, suspended or
   * not (S2). Returns whether the operator is Ready; not while the API server's endpoints are
   * unknown, when nothing is applied.
   */
  private async applyTenantOperator(tenant: Tenant): Promise<boolean> {
    const t = tenant.metadata.name;
    const rendered = tenantOperatorResources(tenant, {
      installation: this.cfg.installation,
      namespace: this.cfg.namespace,
      apiServer: await this.apiServerEndpoints(),
    });
    if (!rendered.ready) return false;
    const deployment = rendered.resources.at(-1) as Resource;
    for (const value of rendered.resources.slice(0, -1)) await this.ensure(value);
    if (
      !(await this.get<Resource>(location(deployment))) &&
      !(await this.accountsLoaded(t, 'operator'))
    )
      return false;
    const applied = await this.ensure(deployment);
    return hostRolloutOf(applied as never, deployment.metadata.name).rollout?.complete === true;
  }
  /**
   * While removal is at R3 or earlier, the operator objects stay applied and the operator's
   * identity keeps being issued (owner decision 4). A failure is logged, not raised: removal keeps
   * reporting its step.
   */
  private async keepTenantOperator(tenant: Tenant): Promise<void> {
    try {
      await this.applyTenantOperator(tenant);
    } catch (error) {
      console.warn(
        `Tenant/${tenant.metadata.name}: keeping its runtime-operator during removal failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    await this.identities.reconcile(tenant, 'operator');
  }
  /**
   * `schedulerCertDigest` of the hosts' current scheduler certificate, read fresh from
   * {@link TENANT_HOST_SECRET}; undefined until the controller has issued it.
   */
  private async hostTlsDigest(tenant: Tenant): Promise<string | undefined> {
    const secret = await this.get<Resource & { data?: Record<string, string> }>(
      `${collection('v1', 'Secret', names(tenant.metadata.name).runtimeNamespace)}/${TENANT_HOST_SECRET}`,
    );
    const cert = secret?.data?.['tls.crt'];
    if (!cert || !ownsIdentitySecret(secret, this.cfg.installation, tenant.metadata.uid))
      return undefined;
    return schedulerCertDigest(Buffer.from(cert, 'base64').toString('utf8'));
  }
  /**
   * The host certificate digest the host Deployment is rendered with, or undefined to leave the
   * live Deployment untouched (#541 m6e).
   * - The live template has "moved" once it mounts {@link TENANT_HOST_SECRET} and carries a
   *   non-empty digest. A moved template is applied with its digest whatever the operator does, so
   *   suspension, replica changes and renewals are never held (W1 of the #613 review).
   * - The first move waits for the tenant's operator to be Ready. The hosts' identity is issued
   *   with the operator's, whose own accounts wait has then passed. Until then a running Tenant's
   *   host Deployment is left as it is, and a suspended Tenant's is rendered at zero replicas on
   *   {@link TENANT_HOST_SECRET} with the digest `''`, which has not moved. So unsuspending it
   *   cannot start hosts before their operator (W1 of the #613 round-3 and round-4 reviews). Once
   *   the move is allowed, the template is rendered with the issued digest, suspended (zero
   *   replicas) or not.
   * - A renewed or rotated certificate reaches the template only once its user has propagated
   *   ({@link accountsLoaded}); until then the template keeps the digest it has, so new pods are
   *   not refused at their first connect (S2 of the #613 review). For a routine renewal the old
   *   certificate's user stays admitted until the rollout completes (`identityTransition`), so
   *   the running pods keep working. A forced rotation or a deleted Secret keeps no previous
   *   user: the running pods are refused at the next accounts reload, and the hosts stay down
   *   for up to the wait plus a tick before the new pods roll. That trade avoids new pods that
   *   are refused at start and crash-loop. The wait counts against a renewal's stall window
   *   (`previousUntil`, issuance plus ten minutes), leaving the rollout about 477 s; a tenant
   *   with many replicas can report `SchedulerIdentityRenewalStalled` briefly, which clears once
   *   the rollout completes and drops nothing. Kept so: measuring from the template change would
   *   need one more persisted timestamp for a condition that is only a report.
   * - A suspended Tenant whose host identity is not issued is rendered at zero replicas with the
   *   live template's digest if it has moved, or none, so its pre-cut-over hosts stop too (S2 of
   *   the #613 round-2 and round-5 reviews). A running one is left as it is. `issued` is false in
   *   both cases.
   */
  private async hostTlsFor(
    tenant: Tenant,
    operatorReady: boolean,
  ): Promise<{ digest?: string; issued: boolean }> {
    const digest = await this.hostTlsDigest(tenant);
    const n = names(tenant.metadata.name);
    const live = async () =>
      (
        (
          await this.get<Resource>(
            `${collection('apps/v1', 'Deployment', n.runtimeNamespace)}/hostgroup-${n.hostgroup}`,
          )
        )?.spec as { template?: HostTemplate } | undefined
      )?.template;
    if (digest === undefined && !tenant.spec.suspended) return { issued: false };
    const template = await live();
    const annotation = template?.metadata?.annotations?.[SCHEDULER_TLS_ANNOTATION];
    // A template rendered while suspended with no digest (`''`) has not moved (W1 of the #613
    // round-3 review): it waits for the operator and rolls once onto the issued digest.
    const moved = Boolean(annotation) && mountsSecret(template?.spec, TENANT_HOST_SECRET);
    // Suspended without an issued identity, only a moved template keeps its digest (S2 of the
    // #613 round-5 review).
    if (digest === undefined) return { digest: moved ? annotation : '', issued: false };
    // Suspended, a template that has not moved gets the issued digest only once the first move is
    // allowed, so unsuspending it cannot skip the operator (W1 of the #613 round-4 review). A moved
    // one takes a renewed digest only after the accounts wait below (W1 of round 5).
    if (tenant.spec.suspended && !moved)
      return { digest: operatorReady ? digest : '', issued: true };
    if (!operatorReady && !moved) return { issued: true };
    // The first move waits for nothing more: the hosts' identity is issued with the operator's,
    // whose own wait has passed, since it is Ready.
    if (!moved || annotation === digest) return { digest, issued: true };
    const loaded = await this.accountsLoaded(tenant.metadata.name, 'hosts');
    return { digest: loaded ? digest : annotation, issued: true };
  }
  /** A `di-scheduler-tls` this controller copied for the Tenant: its installation and owner labels. */
  private ownsCopy(copy: Resource, tenant: Tenant): boolean {
    return (
      copy.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
      copy.metadata.labels?.[OWNER] === tenant.metadata.uid
    );
  }
  /**
   * Deletes the tenant's copy of `wasmcloud-runtime-tls` once nothing can still use it (#541 m6e):
   * the host Deployment has rolled out the template that mounts {@link TENANT_HOST_SECRET}, no pod
   * in `di-runtime-<t>` (terminating ones included) mounts the copy, and the copy carries this
   * installation's and Tenant's owner labels.
   */
  private async removeSchedulerTlsCopy(tenant: Tenant, hosts: Resource): Promise<void> {
    if (!hostRolloutOf(hosts as never, hosts.metadata.name).rollout?.complete) return;
    const n = names(tenant.metadata.name);
    const copy = await this.get<Resource>(
      `${collection('v1', 'Secret', n.runtimeNamespace)}/${SCHEDULER_TLS_COPY}`,
    );
    if (!copy || !this.ownsCopy(copy, tenant)) return;
    const pods = await this.list<Resource>('v1', 'Pod', {}, n.runtimeNamespace);
    if (pods.some(mountsSchedulerTlsCopy)) return;
    await this.remove(copy);
  }
  async reconcileTenant(tenant: Tenant, users?: User[]): Promise<void> {
    if (!validName(tenant.metadata.name)) throw new Error('Invalid tenant name');
    if (!tenant.metadata.deletionTimestamp) await this.finalizer(tenant, true);
    const n = names(tenant.metadata.name);
    if (tenant.spec.suspended || tenant.metadata.deletionTimestamp)
      // S1: the tenant operator keeps its RoleBindings until removal step R5 (design-541 §4.5).
      await this.revoke({ [TENANT]: tenant.metadata.name }, (binding) =>
        isTenantOperatorBinding(binding, tenant.metadata.name),
      );
    // Namespace deletion does not reach the cluster-scoped and platform-namespace RBAC.
    if (tenant.metadata.deletionTimestamp) {
      this.tenantAuthClean = false;
      await this.removeTenantAuth(tenant);
      await this.removeTenant(tenant);
      return;
    }
    for (const name of [n.namespace, n.runtimeNamespace, n.apiKeysNamespace]) {
      const namespace = resource(
        tenant,
        this.cfg.installation,
        'v1',
        'Namespace',
        name,
        undefined,
        {},
      );
      // The gateway's egress to the tenant console and controller selects runtime namespaces only.
      if (name === n.runtimeNamespace) namespace.metadata.labels![NAMESPACE_ROLE] = 'runtime';
      await this.ensure(namespace, true);
    }
    // The tenant's own operator first; its hosts follow once it is Ready (#541 m6e). A failure is
    // reported like a failed apply below.
    let operatorReady = false;
    let failure: unknown;
    try {
      operatorReady = await this.applyTenantOperator(tenant);
    } catch (error) {
      failure = error;
    }
    // Everything above and these reads can still throw before the try block below; such a
    // failure rejects the tick and skips tenant-auth until the next poll.
    const { digest: hostTls, issued: hostIssued } = await this.hostTlsFor(tenant, operatorReady);
    const workloads = await this.storageWorkloads(tenant);
    // Records are written before any host pod that mounts their keys is rendered (#200).
    const observation = await this.observeStorage(tenant);
    const storage = await this.recordStorage(tenant, workloads, observation);
    const registryDeployed = await this.registryDeployed(tenant);
    // A failed lookup here is reported on TenantAuthReady, not as a reconcile error (S6 of the
    // #83 `:host-pull` review): the hosts keep the last wiring, or are left untouched this tick.
    let hostPull: HostPull | undefined;
    let hostPullFailure: unknown;
    try {
      hostPull = await this.hostPull(tenant, registryDeployed);
    } catch (error) {
      hostPullFailure = error;
      hostPull = this.hostPulls.get(tenant.metadata.name);
    }
    const hostsKnown = !hostPullFailure || this.hostPulls.has(tenant.metadata.name);
    const registryNats = await this.registryNats(tenant);
    // The quota keeps the tenant-auth addition only while its Deployments exist; the
    // tenant-auth step below is the one that raises it (#121).
    const desired = tenantResources(
      tenant,
      this.cfg,
      hostTls === undefined ? undefined : { digest: hostTls },
      storage.mounted,
      await this.tenantAuthDeployed(tenant),
      registryDeployed,
      await this.tenantAuthNetworkApplied(tenant),
      hostPull,
      registryNats,
      storage.reserve,
    ).filter(
      (value) =>
        hostsKnown ||
        !(value.kind === 'Deployment' && value.metadata.name === `hostgroup-${n.hostgroup}`),
    );
    const hostgroup = `hostgroup-${n.hostgroup}`;
    // Ready needs the operator Ready and the hosts on their own identity (#541 m6e).
    let ready = operatorReady && hostIssued && hostTls !== undefined;
    let hosts: Resource | undefined;
    let foreignRecords: string | undefined;
    try {
      // The backup operator's copy of the records (design-200 §9.4). One someone else created
      // is never adopted: it stays, and StorageIntegrity names it.
      try {
        await this.ensure(storageRecordsConfigMap(tenant, this.cfg.installation, storage.records));
      } catch (error) {
        if (!(error instanceof AdoptionRefused)) throw error;
        foreignRecords = `ConfigMap ${n.runtimeNamespace}/${STORAGE_RECORDS_CONFIG} was not written by this controller and was left in place; the backup operator refuses restores until it is removed`;
      }
      if (!this.cfg.routeUrlPattern) await this.removeRoutes(tenant);
      for (const value of desired) {
        const applied = await this.ensure(value);
        if (value.kind === 'Deployment' && value.metadata.name === hostgroup) hosts = applied;
        if (value.kind === 'Deployment') {
          const spec = applied.spec as { replicas: number };
          const status = applied.status as
            | { observedGeneration?: number; readyReplicas?: number; replicas?: number }
            | undefined;
          ready &&=
            status?.observedGeneration === applied.metadata.generation &&
            (status?.readyReplicas ?? 0) === spec.replicas &&
            (spec.replicas !== 0 || (status?.replicas ?? 0) === 0);
        }
      }
      if (hosts) {
        // Rolled: every replica runs the template with the current certificate (#541 m6e).
        ready &&= hostRolloutOf(hosts as never, hostgroup).rollout?.complete === true;
        await this.removeSchedulerTlsCopy(tenant, hosts);
      }
    } catch (error) {
      failure ??= error;
    }
    // Placement depends on Host readiness alone, as the operator's findFreeHost decides it, so
    // the nudge runs even when another Deployment is not ready or the apply above failed (#418).
    if (!tenant.spec.suspended && !tenant.metadata.deletionTimestamp) {
      try {
        // The tenant operator registers its Hosts in its own namespace (design-541 §4.6).
        const registered = await this.list<Resource>(
          'runtime.wasmcloud.dev/v1alpha1',
          'Host',
          { hostgroup: n.hostgroup },
          operatorNamespace(tenant.metadata.name),
        );
        const readyHosts = registered.filter(
          (h) =>
            h.environment === n.namespace &&
            (h.status as { conditions?: Condition[] } | undefined)?.conditions?.some(
              (c) => c.type === 'Ready' && c.status === 'True',
            ),
        );
        // A Host whose pod is terminating or gone is never a nudge target: the upstream
        // scheduler would place Workloads on a host that is about to stop (#418).
        const pods = await this.list<Resource>(
          'v1',
          'Pod',
          { 'wasmcloud.com/hostgroup': n.hostgroup },
          n.runtimeNamespace,
        );
        const liveIps = new Set(
          pods.flatMap((p) => {
            const ip = (p.status as { podIP?: string } | undefined)?.podIP;
            return ip && !p.metadata.deletionTimestamp ? [ip] : [];
          }),
        );
        await this.nudgeUnplaced(
          n.namespace,
          readyHosts.filter((h) => liveIps.has(h.hostname as string)),
        );
        ready &&= readyHosts.length >= (tenant.spec.runtime?.replicas ?? 1);
      } catch (error) {
        // Reported only when it decides readiness; a tenant that is not ready yet waits anyway.
        if (ready) failure ??= error;
      }
    }
    // Apart from the apply, so neither failure holds the other back. A cleanup failure is
    // reported unless the apply already failed, and the cleanup is retried on the next pass.
    try {
      await this.pruneLogReader(tenant);
    } catch (error) {
      failure ??= error;
    }
    // Issued apart from the apply, which a failed host Deployment must not hold back, and also while
    // suspended: the tenant operator keeps running then (design-541 §4.5), so its identity must not
    // expire. The hosts' digest annotation follows a renewal on the next pass (#541 m6e).
    const identity = await this.identities.reconcile(tenant);
    // Tenant-auth is independent of the tenant's own objects: a failed apply above (such as a
    // hostgroup 409) must not keep it from reconciling or from reporting TenantAuthReady (#121).
    let auth = await this.reconcileTenantAuth(tenant, users);
    if (hostPullFailure && auth) auth = withHostPullFailure(auth, hostPullFailure);
    // A projection ConfigMap that keeps failing to be written (#316); absent otherwise.
    const logs = logWriteCondition(
      this.logWriteFailures.get(tenant.metadata.name),
      tenant.metadata.generation ?? 1,
    );
    const integrity: Condition = {
      type: 'StorageIntegrity',
      ...integrityCondition(storage, observation, foreignRecords),
      observedGeneration: tenant.metadata.generation ?? 1,
      lastTransitionTime: new Date().toISOString(),
    };
    // A refused accounts render (#541 m6d), from the last pass: the previous file keeps serving.
    const kept = tenant.status?.conditions?.find((c) => c.type === SCHEDULER_ACCOUNTS_CONDITION);
    const failing = this.accounts.failingCondition(tenant.metadata.generation ?? 1);
    const accounts = failing
      ? [failing]
      : !this.accountsProblems
        ? kept
          ? [kept]
          : []
        : this.accountsProblems.length > 0
          ? [
              schedulerAccountsCondition(
                this.accountsProblems,
                tenant.metadata.name,
                tenant.metadata.generation ?? 1,
                this.now(),
              ),
            ]
          : [];
    const others = [
      ...(auth ? [auth] : []),
      ...(logs ? [logs] : []),
      integrity,
      ...identity,
      ...accounts,
    ];
    const records = {
      storage: { keys: storage.records },
      // The rotation last handled (#541 m6c), carried into every status write so the controller
      // never writes a status that lacks it.
      ...(tenant.status?.schedulerIdentity
        ? { schedulerIdentity: tenant.status.schedulerIdentity }
        : {}),
    };
    if (failure) {
      const message = failure instanceof Error ? failure.message : 'Reconciliation failed';
      console.error(`Tenant/${tenant.metadata.name}: ${message}`);
      await this.status(tenant, false, 'ReconcileError', message, records, others);
      return;
    }
    await this.status(
      tenant,
      ready,
      tenant.spec.suspended ? 'Suspended' : ready ? 'Reconciled' : 'Provisioning',
      tenant.spec.suspended
        ? 'Access revoked; reconciling stopped runtime'
        : ready
          ? 'Tenant resources are ready'
          : 'Waiting for runtime and backend deployments',
      {
        ...n,
        httpService: `di-http.${n.runtimeNamespace}.svc.cluster.local`,
        // Read by tenant-auth: once true it no longer looks for keys in the runtime namespace.
        ...(this.cfg.tenantAuth && tenant.metadata.uid && this.apiKeysMoved.has(tenant.metadata.uid)
          ? { apiKeysMigrated: true }
          : {}),
        ...records,
      },
      others,
    );
  }

  /**
   * What the current host pod's `storage-mode` step reported (#200): its listing, read once per
   * host pod uid through `pods/log`, or its termination message when it failed.
   */
  private async observeStorage(tenant: Tenant): Promise<Observation> {
    const n = names(tenant.metadata.name);
    const pod = (await this.liveHostPods(n))
      .filter((p) => !p.metadata.deletionTimestamp)
      .sort((a, b) =>
        String(b.metadata.creationTimestamp ?? '').localeCompare(
          String(a.metadata.creationTimestamp ?? ''),
        ),
      )[0];
    if (!pod?.metadata.uid) return { state: 'pending' };
    type Terminated = { exitCode: number; message?: string; reason?: string };
    const step = (
      pod.status as
        | {
            initContainerStatuses?: {
              name: string;
              restartCount?: number;
              state?: { terminated?: Terminated };
              lastState?: { terminated?: Terminated };
            }[];
          }
        | undefined
    )?.initContainerStatuses?.find((c) => c.name === 'storage-mode');
    // One read per run of the step: a re-run in the same pod bumps its restartCount.
    const run = `${pod.metadata.uid}/${step?.restartCount ?? 0}`;
    const cached = this.storageListings.get(tenant.metadata.uid ?? '');
    if (cached?.pod === run) return cached.observation;
    const terminated = step?.state?.terminated ?? step?.lastState?.terminated;
    if (!terminated) return { state: 'pending' };
    if (terminated.exitCode !== 0) {
      const cause = terminated.message?.trim() || terminated.reason || 'no termination message';
      return {
        state: 'failed',
        message: `storage-mode in ${pod.metadata.name} exited ${terminated.exitCode}: ${cause}`,
      };
    }
    if (!step?.state?.terminated) return { state: 'pending' };
    let text: string | undefined;
    try {
      text = await this.api.call<string>(
        'GET',
        `${collection('v1', 'Pod', n.runtimeNamespace)}/${encodeURIComponent(pod.metadata.name)}/log?container=storage-mode`,
      );
    } catch (error) {
      // Not cached: the next tick reads the log again. The plan is safe without a listing.
      const cause = error instanceof Error ? error.message : String(error);
      return {
        state: 'failed',
        message: `storage-mode listing of ${pod.metadata.name} could not be read: ${cause}`,
      };
    }
    const listing = parseListing(String(text ?? ''));
    const observation: Observation = listing
      ? { state: 'read', listing }
      : {
          state: 'failed',
          message: `storage-mode in ${pod.metadata.name} printed an incomplete listing`,
        };
    if (listing) this.storageListings.set(tenant.metadata.uid ?? '', { pod: run, observation });
    return observation;
  }

  /**
   * Plan the storage records and write them into `status.storage.keys` ahead of the host pod
   * that mounts their keys (#200, design-200 §9.1).
   */
  private async recordStorage(
    tenant: Tenant,
    workloads: WorkloadDeployment[],
    observation: Observation,
  ): Promise<StoragePlan> {
    const old = Controller.storageRecords(tenant);
    const plan = planStorage({
      records: old,
      workloads,
      integrity: tenant.spec.storage?.integrity ?? 'Off',
      listing: observation.state === 'read' ? observation.listing : undefined,
    });
    const patch = recordsPatch(old, plan.records);
    if (!patch) return plan;
    let updated: Tenant | undefined;
    try {
      updated = await this.api.call<Tenant | undefined>(
        'PATCH',
        `${location(tenant)}/status`,
        {
          metadata: { resourceVersion: tenant.metadata.resourceVersion },
          status: { storage: { keys: patch } },
        },
        'application/merge-patch+json',
      );
    } catch (error) {
      // A refused or failed patch is reported on StorageIntegrity and the rest of the tenant
      // still reconciles; only keys whose old record agrees with the plan are mounted.
      const agrees = (key: string) => old[key]?.kind === plan.records[key]?.kind;
      return {
        ...plan,
        records: old,
        mounted: plan.mounted.filter(agrees),
        reserve: plan.reserve.filter(agrees),
        unwritten: `storage records could not be written: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (updated?.metadata) tenant.metadata = updated.metadata;
    tenant.status = { ...tenant.status, storage: { keys: plan.records } };
    return plan;
  }

  private static storageRecords(tenant: Tenant): StorageRecords {
    return (tenant.status?.storage as { keys?: StorageRecords } | undefined)?.keys ?? {};
  }
  /**
   * The tenant's controller and console (#58), reconciled apart from the tenant itself: a
   * failure (a missing permission or an object created by hand that can't be adopted) is reported
   * on the `TenantAuthReady` condition and never turns Ready false, so members keep their access.
   * With `tenantAuth` unset, the pair and its RBAC are pruned and no condition is reported.
   */
  private async reconcileTenantAuth(
    tenant: Tenant,
    users: User[] | undefined,
  ): Promise<Condition | undefined> {
    const condition = (ok: boolean, reason: string, message: string): Condition => ({
      type: 'TenantAuthReady',
      status: ok ? 'True' : 'False',
      reason,
      message,
      observedGeneration: tenant.metadata.generation ?? 1,
      lastTransitionTime: new Date().toISOString(),
    });
    try {
      if (!this.cfg.tenantAuth) {
        await this.pruneTenantAuth();
        return undefined;
      }
      this.tenantAuthClean = false;
      // API keys still in the runtime namespace are moved before anything is rendered, so the
      // pass that finds none left also drops the tenant controller's Secret rule there (#379).
      // A failed move keeps that read rule and is reported below; the rest still reconciles.
      let apiKeys: ApiKeyMigration;
      try {
        apiKeys = await this.moveApiKeys(tenant);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        apiKeys = { done: false, moved: 0, failures: [message] };
      }
      const legacyApiKeys = !apiKeys.done;
      const registry = await this.registryState(tenant);
      const registryNats = await this.registryNats(tenant);
      // Objects read while computing the inputs, reused by the adoption check below.
      const fetched = new Map<string, Resource | undefined>();
      const desired = tenantAuthResources(tenant, this.cfg, {
        ...(await this.tenantAuthInputs(
          tenant,
          users ??
            (await this.list<User>(VERSION, 'User', { [INSTALLATION]: this.cfg.installation })),
          fetched,
        )),
        registryServing: registry.serving,
        registryNats: Controller.registryNatsMode(registryNats),
        legacyApiKeys,
      });
      // The CA Secret was accepted this pass: a later refusal is logged again.
      this.caRefusals.delete(tenant.metadata.name);
      // Gateway policies for hosts that are no longer routed, pruned before anything is applied
      // so de-routing holds even when a later apply fails.
      const namespace = names(tenant.metadata.name).runtimeNamespace;
      for (const policy of [
        'tenant-console-gateway',
        'tenant-controller-gateway',
        'tenant-registry-gateway',
      ]) {
        if (desired.some((value) => value.metadata.name === policy)) continue;
        const stale = await this.get<Resource>(
          `${collection('networking.k8s.io/v1', 'NetworkPolicy', namespace)}/${policy}`,
        );
        if (
          stale?.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
          stale.metadata.labels[OWNER] === tenant.metadata.uid
        )
          await this.remove(stale);
      }
      // The registry is no longer configured: remove it, then give its workload slot back.
      if (!this.cfg.tenantAuth.registry) {
        // The host pull credential and Service go with it (#83 `:host-pull`).
        for (const [kind, stale] of [
          ['Secret', REGISTRY_PULL_SECRET],
          ['Service', REGISTRY_PULL_SERVICE],
          // The registry's NATS credentials (#159); its store and marker are kept.
          ['Secret', REGISTRY_NATS_SECRET],
        ] as const) {
          const value = await this.get<Resource>(`${collection('v1', kind, namespace)}/${stale}`);
          if (
            value?.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
            value.metadata.labels[OWNER] === tenant.metadata.uid
          )
            await this.remove(value);
        }
        const stale = await this.get<Resource>(
          `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', names(tenant.metadata.name).namespace)}/${REGISTRY_WORKLOAD}`,
        );
        if (
          stale?.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
          stale.metadata.labels[OWNER] === tenant.metadata.uid
        ) {
          await this.remove(stale);
          await this.ensure(tenantQuota(tenant, this.cfg, false));
        }
      }
      // Raise the quota right before the pair so its pods fit when they are created (#121), and
      // the tenant quota right before the registry so it takes no workload slot of the tenant's.
      await this.ensure(
        runtimeQuota(
          tenant,
          this.cfg,
          true,
          registryNats?.stage === 'migrating' &&
            !tenant.spec.suspended &&
            !tenant.metadata.deletionTimestamp,
        ),
      );
      if (this.cfg.tenantAuth.registry) await this.ensure(tenantQuota(tenant, this.cfg, true));
      let ready = true;
      const suspended = tenant.spec.suspended || !!tenant.metadata.deletionTimestamp;
      for (const value of desired) {
        const applied = await this.ensure(value, false, false, fetched);
        if (value.kind === 'WorkloadDeployment' && !suspended) {
          const conditions = (applied.status as { conditions?: Condition[] } | undefined)
            ?.conditions;
          ready &&= !!conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
        }
        if (value.kind === 'Deployment') {
          const spec = applied.spec as { replicas: number };
          const status = applied.status as
            | { observedGeneration?: number; readyReplicas?: number }
            | undefined;
          ready &&=
            status?.observedGeneration === applied.metadata.generation &&
            (status?.readyReplicas ?? 0) === spec.replicas;
        }
      }
      // The CA key moved to the platform namespace (#170), which the loop above just applied:
      // drop the copy the tenant controller's ServiceAccount could read.
      const legacyCaKey = fetched.get(
        `${collection('v1', 'Secret', namespace)}/${TENANT_CONTROLLER_CA_KEY_SECRET}`,
      );
      if (
        legacyCaKey?.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
        legacyCaKey.metadata.labels[OWNER] === tenant.metadata.uid
      )
        await this.remove(legacyCaKey);
      const { problems } = tenantAuthRoutes(this.cfg.tenantAuth, this.cfg.routeUrlPattern);
      if (problems.length) return condition(false, 'RouteError', problems.join('; '));
      if (registry.conflict)
        return condition(
          false,
          'RegistryHostConflict',
          `WorkloadDeployment ${registry.conflict} claims the tenant registry host ` +
            `${registryHttpHost(this.cfg.tenantAuth)}; the registry is not served until it is removed`,
        );
      const nats = registryNatsCondition(registryNats, namespace);
      if (nats) return condition(false, nats.reason, nats.message);
      const keyNamespace = names(tenant.metadata.name).apiKeysNamespace;
      if (apiKeys.failures.length) {
        const message = `API keys not moved to ${keyNamespace}: ${apiKeys.failures.join('; ')}`;
        console.error(`Tenant/${tenant.metadata.name} tenant-auth: ${message}`);
        return condition(false, 'ApiKeyMigrationFailed', message);
      }
      const what = this.cfg.tenantAuth.registry
        ? 'tenant controller, console and registry'
        : 'tenant controller and console';
      if (!ready) return condition(false, 'Provisioning', `Waiting for the ${what}`);
      // The pair works, but API keys made before #379 are still in the runtime namespace, and so
      // is the tenant controller's read of its Secrets.
      if (apiKeys.waiting)
        return condition(
          false,
          'ApiKeyMigrationWaiting',
          `API keys are not moved to ${keyNamespace} yet: ${apiKeys.waiting}`,
        );
      return condition(true, 'Reconciled', `T${what.slice(1)} are ready`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tenant-auth reconcile failed';
      const refused = error instanceof ControllerCaRefused;
      // A refused CA Secret stays refused until someone acts: logged once, reported every pass.
      if (!refused || this.caRefusals.get(tenant.metadata.name) !== message)
        console.error(`Tenant/${tenant.metadata.name} tenant-auth: ${message}`);
      if (refused) this.caRefusals.set(tenant.metadata.name, message);
      else this.caRefusals.delete(tenant.metadata.name);
      if (!this.cfg.tenantAuth) return undefined;
      try {
        // Never leave the quota raised for a pair that was not applied (#121).
        if (!(await this.tenantAuthDeployed(tenant)))
          await this.ensure(runtimeQuota(tenant, this.cfg, false));
        if (!(await this.registryDeployed(tenant)))
          await this.ensure(tenantQuota(tenant, this.cfg, false));
      } catch {
        /* The tenant step lowers it on the next poll. */
      }
      return condition(false, refused ? 'ControllerCaNotOwned' : 'ReconcileError', message);
    }
  }
  /**
   * Whether the registry front may forward (W4 of the #83 review). Admission checks only writes,
   * so a workload that claimed the registry host before the reservation (or before a
   * `registry.publicUrl` change) keeps its route, and wash picks randomly among claimants. The
   * front is therefore enabled only while the tenant is not suspended and no other workload claims
   * the registry host through `wasi:http` `config.host` or `host-aliases`. The registry's own
   * readiness is not part of the gate (W6): an unready registry has no route, so nothing else sees
   * the credentials, and gating on it would restart the controller on every registry blip. It is
   * reported on `TenantAuthReady` instead. `conflict` names the first claimant.
   */
  private async registryState(tenant: Tenant): Promise<{ serving: boolean; conflict?: string }> {
    if (!this.cfg.tenantAuth?.registry) return { serving: false };
    const label = registryHttpHost(this.cfg.tenantAuth);
    const workloads = await this.list<
      Resource & {
        spec?: {
          template?: {
            spec?: {
              hostInterfaces?: {
                namespace?: string;
                package?: string;
                config?: Record<string, unknown>;
              }[];
            };
          };
        };
        status?: { conditions?: Condition[] };
      }
    >(
      'runtime.wasmcloud.dev/v1alpha1',
      'WorkloadDeployment',
      {},
      names(tenant.metadata.name).namespace,
    );
    const owned = (w: Resource) =>
      w.metadata.name === REGISTRY_WORKLOAD &&
      w.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
      w.metadata.labels[OWNER] === tenant.metadata.uid;
    const claims = (w: (typeof workloads)[number]) =>
      (w.spec?.template?.spec?.hostInterfaces ?? []).some((h) => {
        if (h.namespace !== 'wasi' || h.package !== 'http') return false;
        const { host, 'host-aliases': aliases } = h.config ?? {};
        const hosts = [
          ...(typeof host === 'string' ? [host] : []),
          ...(typeof aliases === 'string' ? aliases.split(',') : []),
        ];
        return hosts.some((value) => claimsRegistryHost(value.trim(), label));
      });
    const conflict = workloads.find((w) => !owned(w) && claims(w))?.metadata.name;
    const suspended = tenant.spec.suspended || !!tenant.metadata.deletionTimestamp;
    return { serving: !suspended && !conflict, conflict };
  }
  /** Tenant uids whose API keys are known to be out of the runtime namespace (#379). */
  private readonly apiKeysMoved = new Set<string>();
  /**
   * Moves the tenant's API keys from the runtime namespace to `di-apikeys-<tenant>` (#379, see
   * {@link migrateApiKeys}); `done` once none is left there. Keys are moved only once the tenant
   * controller is known to run a tenant-auth build that reads both layouts
   * ({@link apiKeyMoveBlocker}). Once done it is not checked again until the controller restarts:
   * the tenant controller cannot write Secrets in the runtime namespace any more, so no key can
   * appear there again.
   */
  private async moveApiKeys(tenant: Tenant): Promise<ApiKeyMigration> {
    const uid = tenant.metadata.uid;
    if (uid && this.apiKeysMoved.has(uid)) return { done: true, moved: 0, failures: [] };
    const n = names(tenant.metadata.name);
    const secrets = (namespace: string) => collection('v1', 'Secret', namespace);
    const result = await migrateApiKeys(tenant.metadata.name, n.runtimeNamespace, {
      list: (namespace, labels) => this.list<ApiKeySecret>('v1', 'Secret', labels, namespace),
      get: (namespace, name) => this.get<ApiKeySecret>(`${secrets(namespace)}/${name}`),
      create: async (secret) => {
        try {
          await this.api.call('POST', secrets(secret.metadata.namespace as string), secret);
        } catch (error) {
          // Already copied by an earlier, interrupted pass: the caller compares it.
          if (!(error instanceof ApiError && error.code === 409)) throw error;
        }
      },
      remove: (namespace, secret) =>
        this.remove({
          ...secret,
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { ...secret.metadata, namespace },
        } as Resource),
      blocker: () => this.apiKeyMoveBlocker(tenant),
      replaced: (name) =>
        console.warn(
          `Tenant/${tenant.metadata.name}: replaced ${n.apiKeysNamespace}/${name}, which differed from the API key in ${n.runtimeNamespace} and was not written by the platform`,
        ),
    });
    if (result.moved > 0)
      console.log(
        `Tenant/${tenant.metadata.name}: moved ${result.moved} API keys from ${n.runtimeNamespace} to ${n.apiKeysNamespace}`,
      );
    if (result.done && uid) this.apiKeysMoved.add(uid);
    return result;
  }
  /** {@link apiKeyMoveBlocker} for the tenant's live controller Deployment and pods. */
  private async apiKeyMoveBlocker(tenant: Tenant): Promise<string | undefined> {
    const image = this.cfg.tenantAuth?.image ?? '';
    const namespace = names(tenant.metadata.name).runtimeNamespace;
    const [deployment, pods] = await Promise.all([
      this.get<TenantControllerDeployment>(
        `${collection('apps/v1', 'Deployment', namespace)}/tenant-controller`,
      ),
      this.list<TenantControllerPod>('v1', 'Pod', { app: 'tenant-controller' }, namespace),
    ]);
    return apiKeyMoveBlocker(image, !!this.cfg.tenantAuthReadsApiKeyNamespace, deployment, pods);
  }
  /** Whether the tenant-auth Deployments of `tenant` exist, i.e. the quota may stay raised. */
  private async tenantAuthDeployed(tenant: Tenant): Promise<boolean> {
    if (!this.cfg.tenantAuth) return false;
    const deployments = await this.list<Resource>(
      'apps/v1',
      'Deployment',
      {
        [INSTALLATION]: this.cfg.installation,
        [OWNER]: tenant.metadata.uid!,
        [COMPONENT]: 'tenant-auth',
      },
      names(tenant.metadata.name).runtimeNamespace,
    );
    return deployments.length > 0;
  }
  /**
   * Whether this tenant's `tenant-auth-network` exists, i.e. `di-tenant-network` may leave the
   * tenant-auth pods out (S1 of the #83 review): it is applied by the tenant-auth step, which
   * runs after the tenant step, so the narrowing follows on the next poll.
   */
  private async tenantAuthNetworkApplied(tenant: Tenant): Promise<boolean> {
    if (!this.cfg.tenantAuth) return false;
    const policy = await this.get<Resource>(
      `${collection('networking.k8s.io/v1', 'NetworkPolicy', names(tenant.metadata.name).runtimeNamespace)}/tenant-auth-network`,
    );
    return (
      policy?.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
      policy.metadata.labels[OWNER] === tenant.metadata.uid
    );
  }
  /** Whether the tenant registry of `tenant` exists, i.e. the tenant quota may stay raised. */
  private async registryDeployed(tenant: Tenant): Promise<boolean> {
    if (!this.cfg.tenantAuth?.registry) return false;
    const workloads = await this.list<Resource>(
      'runtime.wasmcloud.dev/v1alpha1',
      'WorkloadDeployment',
      {
        [INSTALLATION]: this.cfg.installation,
        [OWNER]: tenant.metadata.uid!,
        [COMPONENT]: 'tenant-auth',
      },
      names(tenant.metadata.name).namespace,
    );
    return workloads.length > 0;
  }
  /**
   * Delete every tenant-auth object this installation created for `tenant`, including the
   * cluster-scoped ClusterRole/ClusterRoleBinding and the Role/RoleBinding in the platform
   * namespace, which namespace deletion does not reach.
   */
  private async removeTenantAuth(tenant: Tenant): Promise<void> {
    const labels = {
      [INSTALLATION]: this.cfg.installation,
      [OWNER]: tenant.metadata.uid!,
      [COMPONENT]: 'tenant-auth',
    };
    for (const [apiVersion, kind] of TENANT_AUTH_KINDS)
      for (const value of await this.list<Resource>(apiVersion, kind, labels))
        await this.remove(value);
  }
  /** The last CA Secret refusal logged per tenant (#170), so it is logged once. */
  private readonly caRefusals = new Map<string, string>();
  /** True once a sweep found no tenant-auth objects; reset when a Tenant is deleted. */
  private tenantAuthClean = false;
  /**
   * With `tenantAuth` unset, delete every tenant-auth object of this installation. Each kind is
   * listed once (not once per Tenant), and after a sweep finds nothing the sweep is skipped
   * until a Tenant is deleted.
   */
  private async pruneTenantAuth(): Promise<void> {
    if (this.tenantAuthClean) return;
    let found = false;
    for (const [apiVersion, kind] of TENANT_AUTH_KINDS)
      for (const value of await this.list<Resource>(apiVersion, kind, {
        [INSTALLATION]: this.cfg.installation,
        [COMPONENT]: 'tenant-auth',
      })) {
        found = true;
        await this.remove(value);
      }
    this.tenantAuthClean = !found;
  }
  /** Tenant uids whose leftover log reader is known to be gone (see {@link pruneLogReader}). */
  private readonly logReaderPruned = new Set<string>();
  /**
   * One-time upgrade cleanup (#321): delete the tenant's leftover {@link LOG_READER} binding, then
   * its Role. Only objects labelled with this installation and the Tenant's uid are deleted; a
   * foreign object of that name is left alone. Idempotent: once the check has run without error
   * it is skipped for the tenant until the controller restarts.
   */
  private async pruneLogReader(tenant: Tenant): Promise<void> {
    // Without a uid nothing can be proven to be this Tenant's, so nothing is deleted.
    const uid = tenant.metadata.uid;
    if (!uid || this.logReaderPruned.has(uid)) return;
    const namespace = names(tenant.metadata.name).runtimeNamespace;
    for (const [apiVersion, kind] of LOG_READER_KINDS) {
      const value = await this.get<Resource>(
        `${collection(apiVersion, kind, namespace)}/${LOG_READER}`,
      );
      if (
        value?.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
        value.metadata.labels[OWNER] === uid
      )
        await this.remove(value);
    }
    this.logReaderPruned.add(uid);
  }
  /** No gateway is published any more: drop the route template so the console stops linking. */
  private async removeRoutes(tenant: Tenant): Promise<void> {
    const routes = await this.get<Resource>(
      `${collection('v1', 'ConfigMap', names(tenant.metadata.name).namespace)}/${ROUTES_CONFIG_NAME}`,
    );
    if (
      routes?.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
      routes.metadata.labels[OWNER] === tenant.metadata.uid
    )
      await this.remove(routes);
  }
  async reconcileUser(user: User, tenants: Tenant[]): Promise<void> {
    if (!validName(user.metadata.name)) throw new Error('Invalid user name');
    if (!user.metadata.deletionTimestamp) await this.finalizer(user, true);
    const bindings = await this.list<Resource>('rbac.authorization.k8s.io/v1', 'RoleBinding', {
      [INSTALLATION]: this.cfg.installation,
      [OWNER]: user.metadata.uid!,
    });
    // Memberships already bound survive while their tenant is merely Not Ready, so the token
    // Secrets Pulumi reads stay in place until the tenant converges.
    const granted = new Set(bindings.flatMap((binding) => binding.metadata.labels?.[TENANT] ?? []));
    const desired = userResources(user, tenants, this.cfg, granted);
    for (const binding of bindings)
      if (!desired.some((r) => location(r) === location(binding))) await this.remove(binding);
    // Token Secrets go before the ServiceAccount so no orphaned credential outlives it.
    for (const kind of ['Secret', 'ServiceAccount'])
      for (const value of await this.list<Resource>('v1', kind, {
        [INSTALLATION]: this.cfg.installation,
        [OWNER]: user.metadata.uid!,
      }))
        if (!desired.some((r) => location(r) === location(value))) await this.remove(value);
    let tokens = true;
    for (const value of desired) {
      const applied = await this.ensure(value);
      // Kubernetes populates the token asynchronously; Pulumi reads it once the User is Ready.
      if (value.kind === 'Secret')
        tokens &&= !!(applied.data as Record<string, string> | undefined)?.token;
    }
    if (user.metadata.deletionTimestamp) {
      await this.finalizer(user, false);
      return;
    }
    const complete =
      user.spec.suspended ||
      desired.filter((r) => r.kind === 'RoleBinding').length === user.spec.memberships.length * 2;
    const ready = complete && tokens;
    await this.status(
      user,
      !!ready,
      user.spec.suspended
        ? 'Suspended'
        : !complete
          ? 'TenantNotReady'
          : ready
            ? 'Reconciled'
            : 'TokenPending',
      user.spec.suspended
        ? 'Access revoked and ServiceAccount removed'
        : !complete
          ? 'Waiting for every referenced tenant to be ready'
          : ready
            ? 'Memberships reconciled'
            : 'Waiting for Kubernetes to populate the ServiceAccount token Secrets',
      user.spec.suspended
        ? { serviceAccount: null }
        : {
            serviceAccount: {
              name: `di-user-${user.metadata.name}`,
              namespace: this.cfg.namespace,
            },
          },
    );
  }
  /**
   * Provision independent Redis/NATS instances for a BackingService CR.
   * Never touches runtime-internal `${RUNTIME_DATA_NATS}` (hostgroup data plane).
   */
  async reconcileBackingService(
    service: BackingService,
    tenant: Tenant,
    classes: BackingServiceClass[],
  ): Promise<void> {
    if (!validName(service.metadata.name)) throw new Error('Invalid BackingService name');
    if (!service.metadata.uid) throw new Error('BackingService is missing metadata.uid');
    const { namespace, runtimeNamespace } = names(tenant.metadata.name);
    if (service.metadata.namespace !== namespace)
      throw new Error(
        `BackingService ${service.metadata.name} must live in tenant namespace ${namespace}`,
      );

    if (!service.metadata.deletionTimestamp) await this.finalizer(service, true);
    if (service.metadata.deletionTimestamp) {
      await this.reconcileBackingServiceDeletion(service, runtimeNamespace, service.metadata.uid);
      return;
    }

    if (service.spec.type === 'egress') {
      await this.reconcileEgressService(service, tenant, classes);
      return;
    }
    const configuration = await this.resolveBackingServiceConfiguration(service, tenant, classes);
    if (!configuration) return;
    const { cls, sizing } = configuration;
    if (service.spec.type === 'postgres') {
      await this.reconcilePostgres(service, tenant, cls, sizing);
      return;
    }
    // The live Deployment keeps its data hostPath, so a storage-root change never orphans data.
    const deploymentPath = `${collection('apps/v1', 'Deployment', runtimeNamespace)}/${backingServiceResourceName(service.metadata.name)}`;
    const live = await this.get<Resource>(deploymentPath);
    const desired = backingServiceResources(service, tenant, cls, this.cfg, sizing, live);
    const rollout = await this.applyBackingServiceResources(
      desired,
      new Map([[deploymentPath, live]]),
    );
    await this.updateBackingServiceStatus(service, tenant, cls, rollout);
  }

  /** Egress runs nothing: the service is Ready once its class approves every destination. */
  private async reconcileEgressService(
    service: BackingService,
    tenant: Tenant,
    classes: BackingServiceClass[],
  ): Promise<void> {
    const runtimeNamespace = names(tenant.metadata.name).runtimeNamespace;
    const resolved = resolveClass(service, classes, tenant.metadata.name);
    if ('error' in resolved) {
      await this.status(service, false, 'Failed', resolved.error, { runtimeNamespace });
      return;
    }
    const { cls } = resolved;
    const { approved, denied } = approveEgress(
      service.spec.destinations ?? [],
      cls.spec.egress?.allowedDestinations ?? [],
    );
    const extra = {
      runtimeNamespace,
      classRef: {
        name: cls.metadata.name,
        uid: cls.metadata.uid,
        generation: cls.metadata.generation,
      },
      approved,
    };
    if (denied.length > 0) {
      await this.status(
        service,
        false,
        'NotApproved',
        `BackingServiceClass ${cls.metadata.name} does not approve ${denied.join(', ')}`,
        extra,
      );
      return;
    }
    await this.status(
      service,
      !tenant.spec.suspended,
      tenant.spec.suspended ? 'Suspended' : 'Ready',
      tenant.spec.suspended ? 'Tenant suspended' : `Approved ${approved.join(', ')}`,
      extra,
    );
  }

  private async reconcilePostgres(
    service: BackingService,
    tenant: Tenant,
    cls: BackingServiceClass,
    sizing: SizingParameters,
  ): Promise<void> {
    const extra = {
      runtimeNamespace: names(tenant.metadata.name).runtimeNamespace,
      classRef: {
        name: cls.metadata.name,
        uid: cls.metadata.uid,
        generation: cls.metadata.generation,
      },
      endpoint: endpointFor(service, tenant, 'postgres'),
    };
    const api: PostgresApi = {
      get: (version, kind, namespace, name) =>
        this.get<Resource>(`${collection(version, kind, namespace)}/${name}`),
      ensure: (value) => this.ensure(value),
      create: async (value) => {
        try {
          return await this.api.call<Resource>(
            'POST',
            collection(value.apiVersion, value.kind, value.metadata.namespace),
            value,
          );
        } catch (error) {
          if (!(error instanceof ApiError && error.code === 409)) throw error;
          const existing = await this.get<Resource>(location(value));
          if (!existing) throw error;
          assertPostgresOwner(existing, service, this.cfg);
          return existing;
        }
      },
    };
    try {
      const credentials = await ensurePostgresCredentials(api, service, tenant, this.cfg);
      const pvc = await ensurePostgresStorage(api, service, tenant, cls, this.cfg, sizing);
      const deployments: Resource[] = [];
      for (const value of postgresServingResources(
        service,
        tenant,
        this.cfg,
        sizing,
        credentials,
      )) {
        const applied = await this.ensure(value);
        if (value.kind === 'Deployment') deployments.push(applied);
      }
      const pods = await this.list<Resource>('v1', 'Pod', {
        [INSTALLATION]: this.cfg.installation,
        [OWNER]: service.metadata.uid!,
      });
      let state = postgresReadiness(pvc, deployments, pods);
      if (!tenant.spec.suspended && state.reason === 'Initializing') {
        // Quota/admission rejections leave no pods, so only the Deployment explains the wait.
        const failure = deployments
          .filter((d) => (d.spec as { replicas?: number }).replicas !== 0)
          .map((d) => deploymentFailure(d))
          .find((f) => f !== undefined);
        if (failure) state = { ready: false, ...failure };
      }
      await this.status(
        service,
        !tenant.spec.suspended && state.ready,
        tenant.spec.suspended ? 'Suspended' : state.reason,
        tenant.spec.suspended ? 'PostgreSQL stopped; PVC and credentials retained' : state.message,
        extra,
      );
    } catch (error) {
      // API errors omit response bodies; helper errors never contain credential values.
      await this.status(
        service,
        false,
        'Failed',
        error instanceof Error ? error.message : 'PostgreSQL reconciliation failed',
        extra,
      );
    }
  }

  private async reconcileBackingServiceDeletion(
    service: BackingService,
    runtimeNamespace: string,
    ownerUid: string,
  ): Promise<void> {
    const labels = {
      [INSTALLATION]: this.cfg.installation,
      [OWNER]: ownerUid,
    };
    const bindings = (await this.list<ServiceBinding>(VERSION, 'ServiceBinding', {})).filter(
      (b) =>
        b.metadata.namespace === service.metadata.namespace &&
        b.spec.serviceName === service.metadata.name,
    );
    if (bindings.length > 0) {
      await this.status(
        service,
        false,
        'DeletionBlocked',
        `Remove ServiceBindings before deletion: ${bindings
          .map((b) => b.metadata.name)
          .sort()
          .join(', ')}`,
        { ...service.status, runtimeNamespace },
      );
      return;
    }
    if (service.spec.type === 'postgres') {
      await this.deletePostgres(service, labels, runtimeNamespace);
      return;
    }
    const deployments = await this.list<Resource>('apps/v1', 'Deployment', labels);
    const secrets = await this.list<Resource>('v1', 'Secret', labels);
    const services = await this.list<Resource>('v1', 'Service', labels);
    if (service.spec.deletionPolicy === 'Delete') {
      for (const value of [...deployments, ...secrets, ...services]) await this.remove(value);
      await this.finalizer(service, false);
      return;
    }

    // Retain: stop workloads before releasing the finalizer; keep hostPath data.
    const stopped = await this.stopBackingServiceDeployments(deployments);
    await this.status(service, false, 'Deleting', 'Stopping backing service workloads', {
      runtimeNamespace,
    });
    if (stopped) await this.finalizer(service, false);
  }

  private async deletePostgres(
    service: BackingService,
    labels: Record<string, string>,
    runtimeNamespace: string,
  ): Promise<void> {
    const deployments = await this.list<Resource>('apps/v1', 'Deployment', labels);
    await this.stopBackingServiceDeployments(deployments);
    const pods = await this.list<Resource>('v1', 'Pod', labels);
    if (pods.length > 0) {
      await this.status(
        service,
        false,
        'Deleting',
        'Waiting for PostgreSQL pods to terminate before releasing storage',
        { runtimeNamespace },
      );
      return;
    }
    const kinds =
      service.spec.deletionPolicy === 'Delete'
        ? ['Deployment', 'Service', 'ConfigMap', 'Secret', 'PersistentVolumeClaim']
        : ['Deployment', 'Service', 'ConfigMap'];
    const remaining: Resource[] = [];
    for (const kind of kinds) {
      const resources = await this.list<Resource>(
        kind === 'Deployment' ? 'apps/v1' : 'v1',
        kind,
        labels,
      );
      for (const resource of resources) {
        if (resource.metadata.namespace !== runtimeNamespace)
          throw new Error('PostgreSQL resource namespace mismatch');
        await this.remove(resource);
        if (await this.get<Resource>(location(resource))) remaining.push(resource);
      }
    }
    await this.status(
      service,
      false,
      'Deleting',
      remaining.length
        ? 'Waiting for serving resources and PVC deletion to complete'
        : 'PostgreSQL stopped; requested retention policy applied',
      { runtimeNamespace },
    );
    if (remaining.length === 0) await this.finalizer(service, false);
  }

  private async stopBackingServiceDeployments(deployments: Resource[]): Promise<boolean> {
    let stopped = true;
    for (const deployment of deployments) {
      // Never scale runtime-internal data NATS through BackingService ownership.
      if (deployment.metadata.name === RUNTIME_DATA_NATS) {
        throw new Error(`Refusing to manage runtime data plane ${RUNTIME_DATA_NATS}`);
      }
      const updated = await this.api.call<Resource>(
        'PATCH',
        `${location(deployment)}?fieldManager=${CONTROLLER_FIELD_MANAGER}`,
        {
          metadata: { resourceVersion: deployment.metadata.resourceVersion },
          spec: { replicas: 0 },
        },
        'application/merge-patch+json',
      );
      const status = updated.status as
        | { observedGeneration?: number; replicas?: number }
        | undefined;
      stopped &&=
        status?.observedGeneration === updated.metadata.generation && (status?.replicas ?? 0) === 0;
    }
    return stopped;
  }

  private async resolveBackingServiceConfiguration(
    service: BackingService,
    tenant: Tenant,
    classes: BackingServiceClass[],
  ): Promise<{ cls: BackingServiceClass; sizing: SizingParameters } | undefined> {
    const { runtimeNamespace } = names(tenant.metadata.name);
    const resolved = resolveClass(service, classes, tenant.metadata.name);
    if ('error' in resolved) {
      await this.status(service, false, 'Failed', resolved.error, { runtimeNamespace });
      return;
    }
    const { cls } = resolved;
    const sized = resolveBackingSizing(service, cls, tenant);
    if ('error' in sized) {
      await this.status(service, false, 'Failed', sized.error, {
        runtimeNamespace,
        classRef: {
          name: cls.metadata.name,
          uid: cls.metadata.uid,
          generation: cls.metadata.generation,
        },
      });
      return;
    }
    return { cls, sizing: sized.sizing };
  }

  private async applyBackingServiceResources(
    desired: Resource[],
    fetched?: ReadonlyMap<string, Resource | undefined>,
  ): Promise<{ ready: boolean; failure?: DeploymentFailure }> {
    let ready = true;
    let failure: DeploymentFailure | undefined;
    refuseReservedNames(desired);
    for (const value of desired) {
      const applied = await this.ensure(value, false, false, fetched);
      if (value.kind !== 'Deployment') continue;
      const spec = applied.spec as { replicas: number };
      const status = applied.status as
        | { observedGeneration?: number; readyReplicas?: number; replicas?: number }
        | undefined;
      const deploymentReady =
        status?.observedGeneration === applied.metadata.generation &&
        (status?.readyReplicas ?? 0) === spec.replicas &&
        (spec.replicas !== 0 || (status?.replicas ?? 0) === 0);
      ready &&= deploymentReady;
      if (!deploymentReady && spec.replicas !== 0) failure ??= deploymentFailure(applied);
    }
    return ready ? { ready } : { ready, ...(failure ? { failure } : {}) };
  }

  private async updateBackingServiceStatus(
    service: BackingService,
    tenant: Tenant,
    cls: BackingServiceClass,
    { ready, failure }: { ready: boolean; failure?: DeploymentFailure },
  ): Promise<void> {
    const suspended = tenant.spec.suspended;
    await this.status(
      service,
      ready && !suspended,
      suspended ? 'Suspended' : ready ? 'Ready' : (failure?.reason ?? 'Provisioning'),
      suspended
        ? 'Tenant suspended; backing service scaled down'
        : ready
          ? 'Backing service deployment is ready'
          : (failure?.message ?? 'Waiting for backing service deployment'),
      {
        runtimeNamespace: names(tenant.metadata.name).runtimeNamespace,
        classRef: {
          name: cls.metadata.name,
          uid: cls.metadata.uid,
          generation: cls.metadata.generation,
        },
        endpoint: endpointFor(service, tenant, cls.spec.provider as RuntimeProvider),
      },
    );
  }

  /**
   * Project ServiceBinding → controller-owned `di-binding-<bindingName>` ConfigMap
   * (and optional Secret) in the tenant namespace for named hostInterfaces.
   */
  async reconcileServiceBinding(
    binding: ServiceBinding,
    tenant: Tenant,
    service: BackingService | undefined,
    peers: ServiceBinding[],
  ): Promise<void> {
    if (!validName(binding.metadata.name)) throw new Error('Invalid ServiceBinding name');
    if (!binding.metadata.uid) throw new Error('ServiceBinding is missing metadata.uid');
    const n = names(tenant.metadata.name);
    if (binding.metadata.namespace !== n.namespace)
      throw new Error(
        `ServiceBinding ${binding.metadata.name} must live in tenant namespace ${n.namespace}`,
      );
    if (!binding.metadata.deletionTimestamp) await this.finalizer(binding, true);

    const serviceRefBase = {
      name: binding.spec.serviceName,
      uid: service?.metadata.uid,
      generation: service?.metadata.generation,
    };
    if (binding.spec.capability === 'egress') {
      await this.reconcileEgressBinding(binding, tenant, service, serviceRefBase);
      return;
    }

    if (binding.metadata.deletionTimestamp) {
      const owner = electBindingOwner(binding.spec.bindingName, peers);
      if (!owner) {
        const configName = bindingProjectionName(binding.spec.bindingName);
        const secretName = bindingSecretName(binding.spec.bindingName);
        for (const [apiVersion, kind, name] of [
          ['v1', 'ConfigMap', configName],
          ['v1', 'Secret', secretName],
        ] as const) {
          const value = await this.get<Resource>(
            `${collection(apiVersion, kind, n.namespace)}/${name}`,
          );
          if (
            value &&
            value.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
            value.metadata.labels?.[TENANT] === tenant.metadata.name
          ) {
            await this.remove(value);
          }
        }
      }
      const deletingStatus = { serviceRef: serviceRefBase };
      assertSafeBindingStatus(deletingStatus);
      await this.status(
        binding,
        false,
        'Deleting',
        owner
          ? 'Binding revoked; shared projection retained for remaining peers'
          : 'Removing projected binding configuration',
        deletingStatus,
      );
      await this.finalizer(binding, false);
      return;
    }

    const conflict = sharedBindingConflict(binding, peers);
    if (conflict) {
      const failed = { serviceRef: serviceRefBase };
      assertSafeBindingStatus(failed);
      await this.status(binding, false, 'Failed', conflict, failed);
      return;
    }

    const resolved = resolveBindingService(binding, service);
    if ('error' in resolved) {
      const deferred = { serviceRef: serviceRefBase };
      assertSafeBindingStatus(deferred);
      await this.status(binding, false, 'Failed', resolved.error, deferred);
      return;
    }

    const owner = electBindingOwner(binding.spec.bindingName, peers) ?? binding;
    if (!owner.metadata.uid) throw new Error('Elected binding owner is missing metadata.uid');

    let serviceConn: Record<string, string> | undefined;
    const connSecret = await this.get<{
      data?: Record<string, string>;
      stringData?: Record<string, string>;
    }>(
      `${collection('v1', 'Secret', n.runtimeNamespace)}/${service?.spec.type === 'postgres' ? postgresNames(service).connection : `${backingServiceResourceName(binding.spec.serviceName)}-conn`}`,
    );
    // Prefer stringData in tests; live Secrets expose base64 `data` — we only lift known cred keys.
    if (connSecret?.stringData) serviceConn = connSecret.stringData;
    else if (connSecret?.data) {
      serviceConn = {};
      for (const [key, value] of Object.entries(connSecret.data)) {
        if (typeof value !== 'string') continue;
        serviceConn[key] = Buffer.from(value, 'base64').toString('utf8');
      }
    }

    if (binding.spec.capability === 'postgres' && !serviceConn?.url) {
      await this.status(
        binding,
        false,
        'CredentialsMissing',
        'PostgreSQL connection Secret is missing; restore the runtime credentials',
        { serviceRef: serviceRefBase },
      );
      return;
    }
    const desired = serviceBindingResources(
      binding,
      tenant,
      this.cfg,
      resolved.endpoint,
      owner.metadata.uid,
      serviceConn,
    );
    for (const value of desired) await this.ensure(value, false, true);

    // Drop stale credential Secret when credentials were rotated away.
    if (!desired.some((r) => r.kind === 'Secret')) {
      const stale = await this.get<Resource>(
        `${collection('v1', 'Secret', n.namespace)}/${bindingSecretName(binding.spec.bindingName)}`,
      );
      if (
        stale &&
        stale.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
        (stale.metadata.labels?.[OWNER] === owner.metadata.uid ||
          stale.metadata.labels?.[OWNER] === binding.metadata.uid)
      ) {
        await this.remove(stale);
      }
    }

    const readyStatus = {
      serviceRef: {
        name: resolved.service.metadata.name,
        uid: resolved.service.metadata.uid,
        generation: resolved.service.metadata.generation,
      },
    };
    assertSafeBindingStatus(readyStatus);
    await this.status(
      binding,
      !tenant.spec.suspended,
      tenant.spec.suspended ? 'Suspended' : 'Ready',
      tenant.spec.suspended
        ? 'Tenant suspended; binding projection retained'
        : 'Service binding configuration projected',
      readyStatus,
    );
  }

  /**
   * An egress binding projects nothing. Its Ready status is what grants the service's
   * approved entries to `spec.workloadName` in {@link reconcileTenantEgress}.
   */
  private async reconcileEgressBinding(
    binding: ServiceBinding,
    tenant: Tenant,
    service: BackingService | undefined,
    serviceRef: { name: string; uid?: string; generation?: number },
  ): Promise<void> {
    if (binding.metadata.deletionTimestamp) {
      await this.status(binding, false, 'Deleting', 'Egress grant revoked', { serviceRef });
      await this.finalizer(binding, false);
      return;
    }
    const resolved = resolveEgressBindingService(binding, service);
    if ('error' in resolved) {
      await this.status(binding, false, 'Failed', resolved.error, { serviceRef });
      return;
    }
    await this.status(
      binding,
      !tenant.spec.suspended,
      tenant.spec.suspended ? 'Suspended' : 'Ready',
      tenant.spec.suspended
        ? 'Tenant suspended'
        : `Egress granted to WorkloadDeployment ${binding.spec.workloadName}`,
      { serviceRef },
    );
  }

  private async egressAddressesFor(name: string): Promise<string[]> {
    try {
      const addresses = await this.resolveName(name);
      this.egressAddresses.set(name, addresses);
      return addresses;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'lookup failed';
      console.error(`egress: cannot resolve ${name}: ${message}`);
      return this.egressAddresses.get(name) ?? [];
    }
  }

  /**
   * Grant approved egress to WorkloadDeployments (#13). Every workload in the tenant
   * namespace is reconciled, so a removed binding takes its fields away again. The
   * `di-tenant-egress` NetworkPolicy opens the approved ports to public addresses for the
   * tenant hosts, and goes away with the last grant.
   */
  async reconcileTenantEgress(
    tenant: Tenant,
    bindings: ServiceBinding[],
    services: ReadonlyMap<string, BackingService>,
  ): Promise<void> {
    const n = names(tenant.metadata.name);
    const grants = egressGrants(n.namespace, bindings, services);
    const all = [...grants.values()].flat();
    const addresses = new Map<string, string[]>();
    for (const name of egressResolvableNames(all))
      addresses.set(name, await this.egressAddressesFor(name));
    const workloads =
      (
        await this.api.call<{ items?: WorkloadDeployment[] } | undefined>(
          'GET',
          collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', n.namespace),
        )
      )?.items ?? [];
    for (const workload of workloads) {
      // The tenant registry's egress (its whoami call) is the platform's own, not a grant.
      if (
        workload.metadata.name === REGISTRY_WORKLOAD &&
        workload.metadata.labels?.[OWNER] === tenant.metadata.uid &&
        workload.metadata.labels?.[INSTALLATION] === this.cfg.installation
      )
        continue;
      const approved = grants.get(workload.metadata.name) ?? [];
      const patch = egressPatch(
        { ...workload, metadata: { ...workload.metadata, namespace: n.namespace } },
        egressAllowedHosts(approved, addresses),
        egressLookups(approved),
      );
      if (!patch) continue;
      await this.api.call(
        'PATCH',
        `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', n.namespace)}/${encodeURIComponent(patch.metadata.name)}?fieldManager=${EGRESS_FIELD_MANAGER}`,
        patch,
        'application/merge-patch+json',
      );
    }
    const ports = egressPorts(all);
    if (ports.length > 0) {
      await this.ensure(
        resource(
          tenant,
          this.cfg.installation,
          'networking.k8s.io/v1',
          'NetworkPolicy',
          EGRESS_NETWORK_POLICY,
          n.runtimeNamespace,
          { spec: egressNetworkPolicySpec(n.hostgroup, ports) },
        ),
      );
      return;
    }
    const existing = await this.get<Resource>(
      `${collection('networking.k8s.io/v1', 'NetworkPolicy', n.runtimeNamespace)}/${EGRESS_NETWORK_POLICY}`,
    );
    if (
      existing &&
      existing.metadata.labels?.[INSTALLATION] === this.cfg.installation &&
      existing.metadata.labels?.[OWNER] === tenant.metadata.uid
    )
      await this.remove(existing);
  }

  /**
   * di-framework WorkloadDeployments in the tenant namespace that asked for persistent
   * storage. Persistent directories live on one host, so a multi-replica tenant runtime
   * gets none and the workload fails visibly instead of splitting its data.
   */
  private async storageWorkloads(tenant: Tenant): Promise<WorkloadDeployment[]> {
    const n = names(tenant.metadata.name);
    const workloads =
      (
        await this.api.call<{ items?: WorkloadDeployment[] } | undefined>(
          'GET',
          `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', n.namespace)}?labelSelector=${encodeURIComponent(MANAGED_SELECTOR)}`,
        )
      )?.items?.filter(wantsStorage) ?? [];
    if (workloads.length > 0 && (tenant.spec.runtime?.replicas ?? 1) > 1) {
      console.error(
        `Tenant/${tenant.metadata.name} storage: persistent storage needs a single runtime replica`,
      );
      return [];
    }
    return workloads.map((workload) => ({
      ...workload,
      metadata: { ...workload.metadata, namespace: n.namespace },
    }));
  }

  /**
   * Patch the platform-owned volume and preopen into each storage workload (#11). The host
   * pod already mounts the directory (see tenantResources). Tenant users never author these
   * fields; admission only lets their updates keep them unchanged.
   */
  async reconcileWorkloadStorage(tenant: Tenant): Promise<void> {
    const records = Controller.storageRecords(tenant);
    for (const workload of await this.storageWorkloads(tenant)) {
      // A workload whose key is unrecorded, or recorded with the other kind, gets no preopen.
      if (!storageAllowed(records, workload)) continue;
      const patch = storagePatch(workload);
      if (!patch) continue;
      await this.api.call(
        'PATCH',
        `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', patch.metadata.namespace)}/${encodeURIComponent(patch.metadata.name)}?fieldManager=${STORAGE_FIELD_MANAGER}`,
        patch,
        'application/merge-patch+json',
      );
    }
  }

  /**
   * Projection ConfigMap writes (and deletes) that failed on the last poll, per tenant and
   * ConfigMap name, with how many polls in a row they failed. reconcileTenant reports one that
   * persists as the `LogsProjected` condition (#316). Pruned like logCursors.
   */
  private readonly logWriteFailures = new Map<string, Map<string, LogWriteFailure>>();

  /**
   * Publish one logs ConfigMap per projection key (#10, #106): per console application, and
   * per service and env for a /v1 deployment (logKey). Only `wasi:logging` lines the host
   * attributed to a workload in this tenant, and host WARN/ERROR lines from its
   * `workload_start` span, are kept. Each line's WorkloadDeployment goes to
   * `data.deployments`, its env to `data.envs`, and the newest host failure per
   * WorkloadDeployment to `data.failures`. Nothing is written for a key with no attributed
   * lines, so absence stays the console's unpublished state.
   *
   * A ConfigMap whose key no live WorkloadDeployment has is removed. That includes the
   * `di-logs-<service>` ConfigMap staging and prod of a /v1 service shared before #106: each
   * per-env projection first takes over that ConfigMap's lines and failures of its own
   * deployment (legacyRing), then the shared one is deleted. When a live workload outside
   * /v1 still owns that key, the ConfigMap is kept and rewritten in the same pass without the
   * lines of /v1 deployments, so no line is served from two projections.
   *
   * Each write and delete is attempted on its own: one that fails (e.g. at the ConfigMap
   * quota) is logged and retried on the next poll without holding back the other keys. A
   * shared ConfigMap whose lines could not be taken over is neither pruned nor deleted.
   */
  async projectLogs(tenant: Tenant): Promise<void> {
    const n = names(tenant.metadata.name);
    const pods = await this.api.call<{
      items: { metadata: { name: string; uid?: string }; status?: { phase?: string } }[];
    }>(
      'GET',
      `${collection('v1', 'Pod', n.runtimeNamespace)}?labelSelector=${encodeURIComponent(
        `wasmcloud.com/hostgroup=${n.hostgroup},wasmcloud.com/name=hostgroup`,
      )}`,
    );
    const deployments: WorkloadIdentity[] = (
      await this.api.call<{
        items: {
          metadata: WorkloadIdentity;
          spec?: { template?: { spec?: { service?: unknown } } };
        }[];
      }>(
        'GET',
        `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', n.namespace)}?labelSelector=${encodeURIComponent(MANAGED_SELECTOR)}`,
      )
    ).items.map((item) => ({
      ...item.metadata,
      // Span-less service supervisor failures are attributed to services only.
      service: item.spec?.template?.spec?.service !== undefined,
    }));
    const existing = (
      await this.api.call<{ items: Resource[] }>(
        'GET',
        `${collection('v1', 'ConfigMap', n.namespace)}?labelSelector=${encodeURIComponent(
          `${PROJECTION}=logs,${INSTALLATION}=${this.cfg.installation}`,
        )}`,
      )
    ).items.map((item) => ({ ...item, apiVersion: 'v1', kind: 'ConfigMap' }));
    const existingByKey = new Map(existing.map((item) => [logKeyId(configMapLogKey(item)), item]));
    const keys = new Map<string, LogKey>();
    const members = new Map<string, string[]>();
    for (const deployment of deployments) {
      const key = logKey(deployment);
      const id = logKeyId(key);
      keys.set(id, key);
      members.set(id, [...(members.get(id) ?? []), deployment.name]);
    }
    // The published ring of each live key. A /v1 key without its own ConfigMap yet starts from
    // its deployment's lines in the ConfigMap every env of the service shared before #106.
    const current = new Map<string, Resource>();
    const seeded = new Set<string>();
    for (const [id, key] of keys) {
      const own = existingByKey.get(id);
      const legacy = key.env ? existingByKey.get(key.application) : undefined;
      if (own || !legacy) {
        if (own) current.set(id, own);
        continue;
      }
      const seed = legacyRing(legacy, `${key.application}-${key.env}`, key.env);
      if (seed.lines.length === 0 && Object.keys(seed.failures).length === 0) continue;
      seeded.add(id);
      current.set(
        id,
        logsConfigMap(
          tenant.metadata.name,
          n.namespace,
          this.cfg.installation,
          key.application,
          seed.lines,
          seed.failures,
          key.env,
        ),
      );
    }
    // /v1 deployments; their lines never belong in a projection outside /v1 (see pruning).
    const v1Deployments = new Set(
      deployments.filter((deployment) => logKey(deployment).env).map((d) => d.name),
    );
    const pruned = new Set<string>();
    for (const [id, key] of keys)
      if (
        !key.env &&
        projectedRing(current.get(id)).some((entry) => v1Deployments.has(entry.deployment))
      )
        pruned.add(id);
    const incoming = new Map<string, RingLine[]>();
    // Failures are merged newest-wins by deployment, so they skip the line floor: a
    // restarted controller re-reading old lines cannot duplicate them, and never loses one.
    const failures = new Map<string, ProjectedEntry[]>();
    // Cursors of host pods that no longer exist are dropped (#131); a pod that is listed but not
    // running keeps its cursors. So are those of keys no live WorkloadDeployment has.
    const cursors =
      this.logCursors.get(tenant.metadata.name) ?? new Map<string, Map<string, string>>();
    this.logCursors.set(tenant.metadata.name, cursors);
    const listed = new Set(pods.items.map((pod) => pod.metadata.uid ?? pod.metadata.name));
    for (const pod of cursors.keys()) if (!listed.has(pod)) cursors.delete(pod);
    for (const podCursors of cursors.values())
      for (const id of podCursors.keys()) if (!keys.has(id)) podCursors.delete(id);
    const writeFailures =
      this.logWriteFailures.get(tenant.metadata.name) ?? new Map<string, LogWriteFailure>();
    this.logWriteFailures.set(tenant.metadata.name, writeFailures);
    /** Where each key's cursor of each pod moves once that key's ConfigMap is written (#316). */
    const advance = new Map<string, Map<string, string>>();
    for (const pod of pods.items) {
      if (pod.status?.phase !== 'Running') continue;
      const cursorKey = pod.metadata.uid ?? pod.metadata.name;
      const podCursors = cursors.get(cursorKey) ?? new Map<string, string>();
      cursors.set(cursorKey, podCursors);
      // Read from the oldest key cursor, so a key whose write failed reads its lines again.
      const oldest = [...podCursors.values()].reduce<string | undefined>(
        (min, value) => (min === undefined || value < min ? value : min),
        undefined,
      );
      // Re-read a short window before the cursor so a service failure logged just after a
      // tick still sees its `Starting workload` line. The floor below drops repeated lines
      // and failures merge idempotently. While a write keeps failing, its key's cursor stays
      // put. While any write or delete of this tenant is failing, every pod read is bounded like
      // the first one, and the ring by appendRing.
      const bound = writeFailures.size > 0 ? '&tailLines=1000' : '';
      const query = oldest
        ? `sinceTime=${encodeURIComponent(
            new Date(Date.parse(oldest) - LOG_LOOKBACK_MS).toISOString().replace(/\.\d+Z$/, 'Z'),
          )}${bound}`
        : 'tailLines=1000';
      const text = await this.api.call<string>(
        'GET',
        `${collection('v1', 'Pod', n.runtimeNamespace)}/${encodeURIComponent(pod.metadata.name)}/log?${query}`,
      );
      let newest = '';
      for (const [id, entries] of attributeEntries(text ?? '', n.namespace, deployments)) {
        // A pod first seen for this key (e.g. after a controller restart) resumes after the
        // newest line already published for the key. The cursor is pinned there at once, so a
        // failed write retries from it rather than from lines published since by another pod.
        let floor = podCursors.get(id);
        if (floor === undefined) {
          floor = newestStamp(projectedRing(current.get(id)));
          podCursors.set(id, floor);
        }
        // A line stamped exactly at the floor is read again: another pod (or a later write of
        // this one) can log a distinct line with the same stamp. unpublished drops the repeats.
        const fresh = entries.filter((entry) => entry.time >= (floor as string));
        for (const entry of entries) if (entry.time > newest) newest = entry.time;
        incoming.set(id, [
          ...(incoming.get(id) ?? []),
          ...fresh.flatMap((entry) =>
            entry.line
              ? [{ line: entry.line, deployment: entry.deployment, env: entry.env ?? '' }]
              : [],
          ),
        ]);
        failures.set(id, [...(failures.get(id) ?? []), ...entries]);
      }
      // Every key of this pod has seen the pod's log up to its newest attributed line, so each
      // may move there, once its own ConfigMap holds what it read.
      if (newest)
        for (const id of podCursors.keys())
          advance.set(id, (advance.get(id) ?? new Map<string, string>()).set(cursorKey, newest));
    }
    /** Shared ConfigMaps (by key id) a per-env projection could not take over from yet. */
    const held = new Set<string>();
    /** ConfigMaps written or deleted this pass; a failure of any other one is not current. */
    const attempted = new Set<string>();
    const attempt = async (name: string, write: () => Promise<unknown>) => {
      attempted.add(name);
      try {
        await write();
        writeFailures.delete(name);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'write failed';
        const previous = writeFailures.get(name);
        writeFailures.set(name, { count: (previous?.count ?? 0) + 1, message });
        // Logged when it starts or changes; one that persists is on the Tenant (LogsProjected).
        if (previous?.message !== message)
          console.error(`Tenant/${tenant.metadata.name} logs ConfigMap ${name}: ${message}`);
        return false;
      }
    };
    /** Keys whose ConfigMap could not be written; their cursors stay put for the next poll. */
    const unwritten = new Set<string>();
    // Takeovers first, so a shared ConfigMap is pruned or deleted only once they are written.
    for (const id of new Set([...seeded, ...pruned, ...incoming.keys()])) {
      const key = keys.get(id) as LogKey;
      if (!validLabelValue(key.application)) continue;
      const published = current.get(id);
      const ring = projectedRing(published);
      // Lines of a write that applied although it reported a failure are not appended twice.
      const lines = unpublished(ring, incoming.get(id) ?? []);
      const previous = projectedFailures(published);
      const merged = mergeFailures(previous, failures.get(id) ?? [], members.get(id) ?? []);
      const prune = pruned.has(id) && !held.has(id);
      if (
        !seeded.has(id) &&
        !prune &&
        lines.length === 0 &&
        JSON.stringify(merged) === JSON.stringify(previous)
      )
        continue;
      const configMap = logsConfigMap(
        tenant.metadata.name,
        n.namespace,
        this.cfg.installation,
        key.application,
        appendRing(
          ring.filter((entry) => !prune || !v1Deployments.has(entry.deployment)),
          lines,
        ),
        merged,
        key.env,
      );
      const written = await attempt(configMap.metadata.name, () => this.ensure(configMap));
      if (written) continue;
      unwritten.add(id);
      if (seeded.has(id)) held.add(key.application);
    }
    for (const [id, moves] of advance)
      if (!unwritten.has(id))
        for (const [pod, newest] of moves)
          if (newest > (cursors.get(pod)?.get(id) ?? '')) cursors.get(pod)?.set(id, newest);
    for (const [id, configMap] of existingByKey) {
      if (!keys.has(id) && !held.has(id))
        await attempt(configMap.metadata.name, () => this.remove(configMap));
    }
    for (const name of writeFailures.keys()) if (!attempted.has(name)) writeFailures.delete(name);
    if (writeFailures.size === 0) this.logWriteFailures.delete(tenant.metadata.name);
  }

  /**
   * Drop the in-memory state of tenants that are gone (#131): the host wiring and logged CA Secret
   * refusal (#170) of every tenant no longer listed, and the log cursors of every tenant whose logs are no longer projected
   * (removed, suspended or being deleted; their host pods are stopped). A tenant that comes back
   * starts as after a controller restart.
   */
  private forgetTenants(tenants: readonly Tenant[]): void {
    const listed = new Set(tenants.map((tenant) => tenant.metadata.name));
    const projected = new Set(
      tenants
        .filter((tenant) => !tenant.spec.suspended && !tenant.metadata.deletionTimestamp)
        .map((tenant) => tenant.metadata.name),
    );
    for (const name of this.hostPulls.keys()) if (!listed.has(name)) this.hostPulls.delete(name);
    const uids = new Set(tenants.map((tenant) => tenant.metadata.uid ?? ''));
    for (const uid of this.storageListings.keys())
      if (!uids.has(uid)) this.storageListings.delete(uid);
    for (const name of this.caRefusals.keys()) if (!listed.has(name)) this.caRefusals.delete(name);
    this.identities.forget(listed);
    for (const name of this.accountsSeen.keys())
      if (!listed.has(name)) this.accountsSeen.delete(name);
    for (const name of this.logCursors.keys())
      if (!projected.has(name)) this.logCursors.delete(name);
    for (const name of this.logWriteFailures.keys())
      if (!projected.has(name)) this.logWriteFailures.delete(name);
  }

  /** Tenants already reported as missing from the LIST but found by GET (#474). */
  private readonly staleTenantsLogged = new Set<string>();
  /** Whether an empty Tenant LIST next to existing Users was already reported (#474). */
  private emptyTenantListLogged = false;
  /**
   * The API server can keep answering a LIST from a stale watch cache while a GET by name finds
   * the object (#474). Tenants that the installation declares (#544), or that Users or tenant
   * namespaces reference, but the LIST missed are read by name and appended to `tenants`, so they
   * reconcile this tick. A Tenant that nothing declares or references stays invisible while the
   * list is stale.
   */
  private async recoverUnlistedTenants(
    tenants: Tenant[],
    users: User[],
    services: BackingService[],
    bindings: ServiceBinding[],
  ): Promise<void> {
    if (tenants.length === 0 && users.length > 0) {
      if (!this.emptyTenantListLogged)
        console.warn(
          `Tenant list empty while ${users.length} User(s) exist; the API may be serving a stale cache`,
        );
      this.emptyTenantListLogged = true;
    } else this.emptyTenantListLogged = false;
    const listed = new Set(tenants.map((t) => t.metadata.name));
    const referenced = new Set<string>(this.cfg.tenants);
    for (const user of users)
      for (const membership of user.spec.memberships) referenced.add(membership.tenant);
    for (const value of [...services, ...bindings]) {
      const name = tenantNameFromNamespace(value.metadata.namespace);
      if (name) referenced.add(name);
    }
    const recovered = new Set<string>();
    for (const name of referenced) {
      if (listed.has(name)) continue;
      let tenant: Tenant | undefined;
      try {
        tenant = await this.get<Tenant>(
          `${collection(VERSION, 'Tenant')}/${encodeURIComponent(name)}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Tenant/${name}: GET after a LIST miss failed: ${message}`);
        continue;
      }
      if (tenant?.metadata.labels?.[INSTALLATION] !== this.cfg.installation) continue;
      if (!this.staleTenantsLogged.has(name))
        console.warn(`Tenant list stale: ${name} found by GET; reconciling it`);
      recovered.add(name);
      tenants.push({ ...tenant, apiVersion: VERSION, kind: 'Tenant' });
    }
    for (const name of this.staleTenantsLogged)
      if (!recovered.has(name)) this.staleTenantsLogged.delete(name);
    for (const name of recovered) this.staleTenantsLogged.add(name);
  }

  async tick(): Promise<void> {
    this.tickApiServer = {};
    try {
      await this.tickOnce();
    } finally {
      this.tickApiServer = undefined;
    }
  }
  private async tickOnce(): Promise<void> {
    const tenants = await this.list<Tenant>(VERSION, 'Tenant', {
      [INSTALLATION]: this.cfg.installation,
    });
    const users = await this.list<User>(VERSION, 'User', { [INSTALLATION]: this.cfg.installation });
    const classes = await this.list<BackingServiceClass>(VERSION, 'BackingServiceClass', {
      [INSTALLATION]: this.cfg.installation,
    });
    // Cluster-wide list: BackingServices are namespaced under di-tenant-* and may lack
    // installation labels until the controller owns their infra.
    const services = await this.list<BackingService>(VERSION, 'BackingService', {});
    const bindings = await this.list<ServiceBinding>(VERSION, 'ServiceBinding', {});
    await this.recoverUnlistedTenants(tenants, users, services, bindings);
    const tenantByName = new Map(tenants.map((t) => [t.metadata.name, t]));
    this.forgetTenants(tenants);
    for (const value of [...tenants, ...users]) {
      try {
        if (value.kind === 'Tenant') await this.reconcileTenant(value as Tenant, users);
        else await this.reconcileUser(value as User, tenants);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Reconciliation failed';
        console.error(`${value.kind}/${value.metadata.name}: ${message}`);
        try {
          await this.status(value, false, 'ReconcileError', message);
        } catch {
          /* Retry on the next poll, including resourceVersion conflicts. */
        }
      }
    }
    await this.platformIdentities.reconcile();
    // After issuance and removal, so this pass's record changes reach the file (#541 m6d).
    this.accountsProblems = await this.accounts.reconcile(tenants);
    for (const tenant of tenants) {
      if (tenant.spec.suspended || tenant.metadata.deletionTimestamp) continue;
      try {
        await this.reconcileWorkloadStorage(tenant);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Storage reconcile failed';
        console.error(`Tenant/${tenant.metadata.name} storage: ${message}`);
      }
      try {
        await this.projectLogs(tenant);
      } catch (error) {
        // Log projection is best effort; never let it block reconciliation.
        const message = error instanceof Error ? error.message : 'Log projection failed';
        console.error(`Tenant/${tenant.metadata.name} logs: ${message}`);
      }
    }
    const serviceByKey = new Map(
      services.map((s) => [`${s.metadata.namespace}/${s.metadata.name}`, s]),
    );
    for (const service of services) {
      const tenantName = tenantNameFromNamespace(service.metadata.namespace);
      const tenant = tenantName ? tenantByName.get(tenantName) : undefined;
      if (!tenant) continue;
      try {
        await this.reconcileBackingService(service, tenant, classes);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Reconciliation failed';
        console.error(
          `BackingService/${service.metadata.namespace}/${service.metadata.name}: ${message}`,
        );
        try {
          await this.status(service, false, 'Failed', message, {
            runtimeNamespace: names(tenant.metadata.name).runtimeNamespace,
          });
        } catch {
          /* Retry on the next poll. */
        }
      }
    }
    // Refresh services after BS reconcile so bindings see Ready/endpoint updates in-tick.
    const servicesAfter = await this.list<BackingService>(VERSION, 'BackingService', {});
    for (const s of servicesAfter) {
      serviceByKey.set(`${s.metadata.namespace}/${s.metadata.name}`, s);
    }
    for (const binding of bindings) {
      const tenantName = tenantNameFromNamespace(binding.metadata.namespace);
      const tenant = tenantName ? tenantByName.get(tenantName) : undefined;
      if (!tenant) continue;
      const peers = bindings.filter((b) => b.metadata.namespace === binding.metadata.namespace);
      const service = serviceByKey.get(`${binding.metadata.namespace}/${binding.spec.serviceName}`);
      try {
        await this.reconcileServiceBinding(binding, tenant, service, peers);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Reconciliation failed';
        // Never log Secret bodies or credential-bearing payloads.
        console.error(
          `ServiceBinding/${binding.metadata.namespace}/${binding.metadata.name}: ${message}`,
        );
        try {
          const failed = {
            serviceRef: {
              name: binding.spec.serviceName,
              uid: service?.metadata.uid,
              generation: service?.metadata.generation,
            },
          };
          assertSafeBindingStatus(failed);
          await this.status(binding, false, 'Failed', message, failed);
        } catch {
          /* Retry on the next poll. */
        }
      }
    }
    // After bindings so this tick's Ready changes grant or revoke right away.
    for (const tenant of tenants) {
      if (tenant.spec.suspended || tenant.metadata.deletionTimestamp) continue;
      try {
        await this.reconcileTenantEgress(tenant, bindings, serviceByKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Egress reconcile failed';
        console.error(`Tenant/${tenant.metadata.name} egress: ${message}`);
      }
    }
  }
}
/**
 * TenantAuthReady with a failed host wiring lookup (S6 of the #83 `:host-pull` review). An
 * earlier failure reason of the tenant-auth step (such as `RouteError` or
 * `RegistryHostConflict`) is kept and the lookup failure is appended to its message (#131);
 * otherwise the condition turns False with `HostPullError`.
 */
export function withHostPullFailure(auth: Condition, failure: unknown): Condition {
  const detail = `Tenant host registry wiring could not be read: ${
    failure instanceof Error ? failure.message : String(failure)
  }`;
  if (auth.status === 'False' && auth.reason !== 'Provisioning')
    return { ...auth, message: `${auth.message}; ${detail}` };
  return { ...auth, status: 'False', reason: 'HostPullError', message: detail };
}
/**
 * The TenantAuthReady reason while the registry is stopped for the move of its store (#159), or
 * undefined when it runs.
 */
export function registryNatsCondition(
  state: RegistryNats | undefined,
  namespace: string,
): { reason: string; message: string } | undefined {
  const job = `Job ${REGISTRY_NATS_MIGRATION_JOB} in ${namespace}`;
  switch (state?.stage) {
    case 'stopping':
      return {
        reason: 'RegistryMigrating',
        message: `Stopping the registry before ${job} moves its store into its NATS account`,
      };
    case 'migrating':
      return state.failed
        ? {
            reason: 'RegistryMigrationFailed',
            message: `${job} could not move the registry store into its NATS account (${state.failed}); the registry stays stopped. Read its logs, then delete the Job to retry`,
          }
        : {
            reason: 'RegistryMigrating',
            message: `${job} is moving the registry store into its NATS account; the registry is stopped until it finishes`,
          };
    case 'migrated':
      return state.credentials
        ? undefined
        : {
            reason: 'RegistryHostImageUnsupported',
            message:
              'The registry store is in its NATS account, but the tenant host image is not a known build with wash patch 0003, so the registry stays stopped until tenantHostImage is one',
          };
    default:
      return undefined;
  }
}
export async function main(
  api: Api = new KubernetesApi(),
  pause: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<void> {
  const cfg = JSON.parse(process.env.PLATFORM_CONFIG ?? '{}') as ControllerConfig;
  if (!cfg.installation || !cfg.namespace || !cfg.hostImage || !cfg.schedulerNatsUrl)
    throw new Error('Missing PLATFORM_CONFIG');
  assertTenantAuthConfig(cfg.tenantAuth);
  const controller = new Controller(api, cfg);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on('SIGTERM', stop);
  try {
    while (!stopped) {
      try {
        await controller.tick();
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'API unavailable');
      }
      if (!stopped) await pause(3_000);
    }
  } finally {
    process.off('SIGTERM', stop);
  }
}
export function reportFatal(
  error: Error,
  status: { exitCode?: string | number | null } = process,
): void {
  console.error(error.message);
  status.exitCode = 1;
}
if (require.main === module) main().catch(reportFatal);
