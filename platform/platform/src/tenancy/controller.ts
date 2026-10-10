import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import { claimsRegistryHost } from './admission';
import {
  backingServiceResourceName,
  backingServiceResources,
  endpointFor,
  RUNTIME_DATA_NATS,
  type RuntimeProvider,
  resolveBackingSizing,
  resolveClass,
  tenantNameFromNamespace,
} from './backing-service-reconcile';
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
  applicationKey,
  attributeEntries,
  logsConfigMap,
  MANAGED_SELECTOR,
  mergeFailures,
  PROJECTION,
  type ProjectedEntry,
  projectedFailures,
  projectedLines,
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
  assertTenantAuthConfig,
  type BackingService,
  type BackingServiceClass,
  BINDING,
  COMPONENT,
  type Condition,
  type ControllerConfig,
  FINALIZER,
  INSTALLATION,
  NAMESPACE_ROLE,
  names,
  OWNER,
  REGISTRY_WORKLOAD,
  type Resource,
  ROUTES_CONFIG_NAME,
  registryHttpHost,
  resource,
  runtimeQuota,
  type ServiceBinding,
  type SizingParameters,
  TENANT,
  type Tenant,
  type TenantAuthInputs,
  tenantAuthResources,
  tenantAuthRoutes,
  tenantControllerCertNames,
  tenantQuota,
  tenantResources,
  type User,
  userResources,
  VERSION,
  validName,
} from './resources';
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
import { certificateNames, certificateValid, selfSignedCertificate } from './tls';
import {
  STORAGE_FIELD_MANAGER,
  storageKeys,
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
};
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
export class ApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
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

export class Controller {
  /** Newest TracingLogger timestamp already projected, per host pod uid. */
  private readonly logCursors = new Map<string, string>();
  /** Last successful egress name resolution, kept so a failed lookup does not revoke. */
  private readonly egressAddresses = new Map<string, string[]>();
  constructor(
    private readonly api: Api,
    private readonly cfg: ControllerConfig,
    private readonly resolveName: (name: string) => Promise<string[]> = resolveIpv4,
  ) {}
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
  private async ensure(
    value: Resource,
    bootstrap = false,
    adoptSameBinding = false,
  ): Promise<Resource> {
    const existing = await this.get<Resource>(location(value));
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
      throw new Error(
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
      `${location(value)}?fieldManager=di-platform-controller`,
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
        location(value),
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
  private async revoke(labels: Record<string, string>): Promise<void> {
    for (const kind of ['RoleBinding', 'ClusterRoleBinding'])
      for (const binding of await this.list<Resource>('rbac.authorization.k8s.io/v1', kind, {
        [INSTALLATION]: this.cfg.installation,
        ...labels,
      }))
        await this.remove(binding);
  }
  /**
   * What {@link tenantAuthResources} needs from the cluster: the tenant's active members (from
   * the User CRs, so a membership change re-renders the TokenRequest `resourceNames` on the next
   * reconcile), the API server endpoints, the controller certificate (kept until 30 days before
   * it expires) and the shared OAuth client secret from the platform namespace.
   */
  private async tenantAuthInputs(tenant: Tenant, users: User[]): Promise<TenantAuthInputs> {
    const auth = this.cfg.tenantAuth!;
    const name = tenant.metadata.name;
    const members = users
      .filter(
        (u) =>
          !u.spec.suspended &&
          !u.metadata.deletionTimestamp &&
          u.spec.memberships.some((m) => m.tenant === name),
      )
      .map((u) => u.metadata.name)
      .sort((a, b) => a.localeCompare(b));
    const slices = (
      await this.list<
        Resource & { endpoints?: { addresses: string[] }[]; ports?: { port: number }[] }
      >('discovery.k8s.io/v1', 'EndpointSlice', { 'kubernetes.io/service-name': 'kubernetes' })
    ).filter((s) => s.metadata.namespace === 'default');
    const apiServer = {
      addresses: [
        ...new Set(slices.flatMap((s) => (s.endpoints ?? []).flatMap((e) => e.addresses))),
      ],
      port: slices[0]?.ports?.[0]?.port ?? 443,
    };
    const existing = await this.get<Resource>(
      `${collection('v1', 'Secret', names(name).runtimeNamespace)}/tenant-controller-tls`,
    );
    const data = existing?.data as Record<string, string> | undefined;
    const current = data && {
      cert: Buffer.from(data['tls.crt'] ?? '', 'base64').toString(),
      key: Buffer.from(data['tls.key'] ?? '', 'base64').toString(),
    };
    const certNames = tenantControllerCertNames(name, auth);
    const sameNames = (cert: string) =>
      JSON.stringify(certificateNames(cert)) === JSON.stringify(certNames);
    const tls =
      current && certificateValid(current.cert, 30) && sameNames(current.cert)
        ? current
        : selfSignedCertificate(
            `tenant-controller.${names(name).runtimeNamespace}.svc`,
            certNames.dns,
            certNames.ips,
            365,
          );
    const oauth = await this.get<{ data?: Record<string, string> }>(
      `${collection('v1', 'Secret', this.cfg.namespace)}/${auth.oauthClient.secretName}`,
    );
    return {
      members,
      apiServer,
      tls,
      clientSecret: oauth?.data?.[auth.oauthClient.secretKey ?? 'clientSecret'],
    };
  }
  async reconcileTenant(tenant: Tenant, users?: User[]): Promise<void> {
    if (!validName(tenant.metadata.name)) throw new Error('Invalid tenant name');
    if (!tenant.metadata.deletionTimestamp) await this.finalizer(tenant, true);
    const n = names(tenant.metadata.name);
    if (tenant.spec.suspended || tenant.metadata.deletionTimestamp)
      await this.revoke({ [TENANT]: tenant.metadata.name });
    // Namespace deletion does not reach the cluster-scoped and platform-namespace RBAC.
    if (tenant.metadata.deletionTimestamp) {
      this.tenantAuthClean = false;
      await this.removeTenantAuth(tenant);
    }
    if (tenant.metadata.deletionTimestamp && tenant.spec.deletionPolicy === 'Delete') {
      let remaining = false;
      for (const name of [n.namespace, n.runtimeNamespace]) {
        const namespace = await this.get<Resource>(`${collection('v1', 'Namespace')}/${name}`);
        if (!namespace) continue;
        if (
          namespace.metadata.labels?.[OWNER] !== tenant.metadata.uid ||
          namespace.metadata.labels?.[INSTALLATION] !== this.cfg.installation
        )
          throw new Error(`Refusing to delete foreign namespace ${name}`);
        await this.remove(namespace);
        remaining = true;
      }
      if (!remaining) await this.finalizer(tenant, false);
      return;
    }
    if (tenant.metadata.deletionTimestamp) {
      let stopped = true;
      const deployments = await this.list<Resource>('apps/v1', 'Deployment', {
        [INSTALLATION]: this.cfg.installation,
        [OWNER]: tenant.metadata.uid!,
      });
      for (const deployment of deployments) {
        const updated = await this.api.call<Resource>(
          'PATCH',
          `${location(deployment)}?fieldManager=di-platform-controller`,
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
          status?.observedGeneration === updated.metadata.generation &&
          (status?.replicas ?? 0) === 0;
      }
      if (stopped) await this.finalizer(tenant, false);
      return;
    }
    for (const name of [n.namespace, n.runtimeNamespace]) {
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
    // Everything above and these reads can still throw before the try block below; such a
    // failure rejects the tick and skips tenant-auth until the next poll.
    const secret = await this.get<{ data: Record<string, string> }>(
      `${collection('v1', 'Secret', this.cfg.namespace)}/wasmcloud-runtime-tls`,
    );
    const workloads = await this.storageWorkloads(tenant);
    // The quota keeps the tenant-auth addition only while its Deployments exist; the
    // tenant-auth step below is the one that raises it (#121).
    const desired = tenantResources(
      tenant,
      this.cfg,
      secret,
      storageKeys(workloads),
      await this.tenantAuthDeployed(tenant),
      await this.registryDeployed(tenant),
      await this.tenantAuthNetworkApplied(tenant),
    );
    let ready = !!secret;
    let failure: unknown;
    try {
      if (!this.cfg.routeUrlPattern) await this.removeRoutes(tenant);
      for (const value of desired) {
        const applied = await this.ensure(value);
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
      if (ready && !tenant.spec.suspended && !tenant.metadata.deletionTimestamp) {
        const hosts = await this.list<Resource>('runtime.wasmcloud.dev/v1alpha1', 'Host', {
          hostgroup: n.hostgroup,
        });
        ready =
          hosts.filter(
            (h) =>
              h.environment === n.namespace &&
              (h.status as { conditions?: Condition[] } | undefined)?.conditions?.some(
                (c) => c.type === 'Ready' && c.status === 'True',
              ),
          ).length >= (tenant.spec.runtime?.replicas ?? 1);
      }
    } catch (error) {
      failure = error;
    }
    // Tenant-auth is independent of the tenant's own objects: a failed apply above (such as a
    // hostgroup 409) must not keep it from reconciling or from reporting TenantAuthReady (#121).
    const auth = await this.reconcileTenantAuth(tenant, users);
    if (failure) {
      const message = failure instanceof Error ? failure.message : 'Reconciliation failed';
      console.error(`Tenant/${tenant.metadata.name}: ${message}`);
      await this.status(tenant, false, 'ReconcileError', message, {}, auth ? [auth] : []);
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
      { ...n, httpService: `di-http.${n.runtimeNamespace}.svc.cluster.local` },
      auth ? [auth] : [],
    );
  }
  /**
   * The tenant's controller and console (#58), reconciled apart from the tenant itself: a
   * failure here (an object left by `deploy-local.ts`, a missing permission) is reported on the
   * `TenantAuthReady` condition and never turns Ready false, so members keep their access.
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
      const registry = await this.registryState(tenant);
      const desired = tenantAuthResources(tenant, this.cfg, {
        ...(await this.tenantAuthInputs(
          tenant,
          users ??
            (await this.list<User>(VERSION, 'User', { [INSTALLATION]: this.cfg.installation })),
        )),
        registryServing: registry.serving,
      });
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
      await this.ensure(runtimeQuota(tenant, this.cfg, true));
      if (this.cfg.tenantAuth.registry) await this.ensure(tenantQuota(tenant, this.cfg, true));
      let ready = true;
      const suspended = tenant.spec.suspended || !!tenant.metadata.deletionTimestamp;
      for (const value of desired) {
        const applied = await this.ensure(value);
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
      const { problems } = tenantAuthRoutes(this.cfg.tenantAuth, this.cfg.routeUrlPattern);
      if (problems.length) return condition(false, 'RouteError', problems.join('; '));
      if (registry.conflict)
        return condition(
          false,
          'RegistryHostConflict',
          `WorkloadDeployment ${registry.conflict} claims the tenant registry host ` +
            `${registryHttpHost(this.cfg.tenantAuth)}; the registry is not served until it is removed`,
        );
      // The front opens only on the poll after the registry is Ready.
      if (this.cfg.tenantAuth.registry && !suspended) ready &&= registry.serving;
      const what = this.cfg.tenantAuth.registry
        ? 'tenant controller, console and registry'
        : 'tenant controller and console';
      return ready
        ? condition(true, 'Reconciled', `T${what.slice(1)} are ready`)
        : condition(false, 'Provisioning', `Waiting for the ${what}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tenant-auth reconcile failed';
      console.error(`Tenant/${tenant.metadata.name} tenant-auth: ${message}`);
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
      return condition(false, 'ReconcileError', message);
    }
  }
  /**
   * Whether the registry front may forward (W4 of the #83 review). Admission checks only writes,
   * so a workload that claimed the registry host before the reservation (or before a
   * `registry.publicUrl` change) keeps its route, and wash picks randomly among claimants. The
   * front is therefore enabled only while the controller-owned `di-tenant-registry` is Ready and
   * no other workload claims its host through `wasi:http` `config.host` or `host-aliases`.
   * `conflict` names the first claimant.
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
    const ready = workloads.some(
      (w) =>
        owned(w) && !!w.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
    );
    return { serving: ready && !conflict, conflict };
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
    const desired = userResources(user, tenants, this.cfg);
    const bindings = await this.list<Resource>('rbac.authorization.k8s.io/v1', 'RoleBinding', {
      [INSTALLATION]: this.cfg.installation,
      [OWNER]: user.metadata.uid!,
    });
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
    const desired = backingServiceResources(service, tenant, cls, this.cfg, sizing);
    const ready = await this.applyBackingServiceResources(desired);
    await this.updateBackingServiceStatus(service, tenant, cls, ready);
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
      const state = postgresReadiness(pvc, deployments, pods);
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
        `${location(deployment)}?fieldManager=di-platform-controller`,
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

  private async applyBackingServiceResources(desired: Resource[]): Promise<boolean> {
    let ready = true;
    for (const value of desired) {
      const applied = await this.ensure(value);
      if (value.kind !== 'Deployment') continue;
      if (applied.metadata.name === RUNTIME_DATA_NATS)
        throw new Error(`Refusing to manage runtime data plane ${RUNTIME_DATA_NATS}`);
      const spec = applied.spec as { replicas: number };
      const status = applied.status as
        | { observedGeneration?: number; readyReplicas?: number; replicas?: number }
        | undefined;
      ready &&=
        status?.observedGeneration === applied.metadata.generation &&
        (status?.readyReplicas ?? 0) === spec.replicas &&
        (spec.replicas !== 0 || (status?.replicas ?? 0) === 0);
    }
    return ready;
  }

  private async updateBackingServiceStatus(
    service: BackingService,
    tenant: Tenant,
    cls: BackingServiceClass,
    ready: boolean,
  ): Promise<void> {
    await this.status(
      service,
      ready && !tenant.spec.suspended,
      tenant.spec.suspended ? 'Suspended' : ready ? 'Ready' : 'Provisioning',
      tenant.spec.suspended
        ? 'Tenant suspended; backing service scaled down'
        : ready
          ? 'Backing service deployment is ready'
          : 'Waiting for backing service deployment',
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
        try {
          serviceConn[key] = Buffer.from(value, 'base64').toString('utf8');
        } catch {
          /* ignore undecodable */
        }
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
    for (const workload of await this.storageWorkloads(tenant)) {
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
   * Publish one logs ConfigMap per console application (#10). Only `wasi:logging` lines the
   * host attributed to a workload in this tenant, and host WARN/ERROR lines from its
   * `workload_start` span, are kept. The newest host failure per WorkloadDeployment goes to
   * `data.failures`. Nothing is written for an application with no attributed lines, so
   * absence stays the console's unpublished state.
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
    const existingByApp = new Map(
      existing.map((item) => [item.metadata.labels?.['di-framework.dev/application'] ?? '', item]),
    );
    const incoming = new Map<string, string[]>();
    // Failures are merged newest-wins by deployment, so they skip the line floor: a
    // restarted controller re-reading old lines cannot duplicate them, and never loses one.
    const failures = new Map<string, ProjectedEntry[]>();
    for (const pod of pods.items) {
      if (pod.status?.phase !== 'Running') continue;
      const cursorKey = pod.metadata.uid ?? pod.metadata.name;
      const cursor = this.logCursors.get(cursorKey);
      // Re-read a short window before the cursor so a service failure logged just after a
      // tick still sees its `Starting workload` line. The floor below drops repeated lines
      // and failures merge idempotently.
      const query = cursor
        ? `sinceTime=${encodeURIComponent(
            new Date(Date.parse(cursor) - LOG_LOOKBACK_MS).toISOString().replace(/\.\d+Z$/, 'Z'),
          )}`
        : 'tailLines=1000';
      const text = await this.api.call<string>(
        'GET',
        `${collection('v1', 'Pod', n.runtimeNamespace)}/${encodeURIComponent(pod.metadata.name)}/log?${query}`,
      );
      let newest = cursor ?? '';
      for (const [app, entries] of attributeEntries(text ?? '', n.namespace, deployments)) {
        // A restarted controller resumes after the newest line it already published.
        const floor = cursor ?? projectedLines(existingByApp.get(app)).at(-1)?.split(' ')[0] ?? '';
        const fresh = entries.filter((entry) => entry.time > floor);
        for (const entry of fresh) if (entry.time > newest) newest = entry.time;
        incoming.set(app, [
          ...(incoming.get(app) ?? []),
          ...fresh.flatMap((entry) => (entry.line ? [entry.line] : [])),
        ]);
        failures.set(app, [...(failures.get(app) ?? []), ...entries]);
      }
      if (newest) this.logCursors.set(cursorKey, newest);
    }
    const live = new Set(deployments.map(applicationKey));
    for (const [app, lines] of incoming) {
      if (!live.has(app) || !validLabelValue(app)) continue;
      const current = existingByApp.get(app);
      const previous = projectedFailures(current);
      const members = deployments.filter((d) => applicationKey(d) === app).map((d) => d.name);
      const merged = mergeFailures(previous, failures.get(app) ?? [], members);
      if (lines.length === 0 && JSON.stringify(merged) === JSON.stringify(previous)) continue;
      await this.ensure(
        logsConfigMap(
          tenant.metadata.name,
          n.namespace,
          this.cfg.installation,
          app,
          appendRing(projectedLines(current), lines),
          merged,
        ),
      );
    }
    for (const [app, configMap] of existingByApp) {
      if (!live.has(app)) await this.remove(configMap);
    }
  }

  async tick(): Promise<void> {
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
    const tenantByName = new Map(tenants.map((t) => [t.metadata.name, t]));
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
