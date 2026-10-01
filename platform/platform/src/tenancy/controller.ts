import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import {
  backingServiceResourceName,
  backingServiceResources,
  endpointFor,
  RUNTIME_DATA_NATS,
  resolveBackingSizing,
  resolveClass,
  tenantNameFromNamespace,
} from './backing-service-reconcile';
import {
  appendRing,
  applicationKey,
  attributeEntries,
  logsConfigMap,
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
  type BackingService,
  type BackingServiceClass,
  BINDING,
  type Condition,
  type ControllerConfig,
  FINALIZER,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  ROUTES_CONFIG_NAME,
  resource,
  type ServiceBinding,
  type SizingParameters,
  TENANT,
  type Tenant,
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
  serviceBindingResources,
  sharedBindingConflict,
} from './service-binding-reconcile';
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
              // Do not put API response bodies in logs: they may contain Secret data.
              reject(
                new ApiError(
                  res.statusCode ?? 500,
                  `${method} ${path.split('?')[0]} returned ${res.statusCode}`,
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
export class Controller {
  /** Newest TracingLogger timestamp already projected, per host pod uid. */
  private readonly logCursors = new Map<string, string>();
  constructor(
    private readonly api: Api,
    private readonly cfg: ControllerConfig,
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
  ): Promise<T[]> {
    const selector = Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const result = await this.api.call<{ items: T[] }>(
      'GET',
      `${collection(apiVersion, kind)}?labelSelector=${encodeURIComponent(selector)}`,
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
      conditions: [condition],
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
    for (const binding of await this.list<Resource>('rbac.authorization.k8s.io/v1', 'RoleBinding', {
      [INSTALLATION]: this.cfg.installation,
      ...labels,
    }))
      await this.remove(binding);
  }
  async reconcileTenant(tenant: Tenant): Promise<void> {
    if (!validName(tenant.metadata.name)) throw new Error('Invalid tenant name');
    if (!tenant.metadata.deletionTimestamp) await this.finalizer(tenant, true);
    const n = names(tenant.metadata.name);
    if (tenant.spec.suspended || tenant.metadata.deletionTimestamp)
      await this.revoke({ [TENANT]: tenant.metadata.name });
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
      await this.ensure(
        resource(tenant, this.cfg.installation, 'v1', 'Namespace', name, undefined, {}),
        true,
      );
    }
    const secret = await this.get<{ data: Record<string, string> }>(
      `${collection('v1', 'Secret', this.cfg.namespace)}/wasmcloud-runtime-tls`,
    );
    const workloads = await this.storageWorkloads(tenant);
    const desired = tenantResources(tenant, this.cfg, secret, storageKeys(workloads));
    let ready = !!secret;
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
    );
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
        endpoint: endpointFor(service, tenant, cls.spec.provider),
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
          `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', n.namespace)}?labelSelector=${encodeURIComponent('app.kubernetes.io/managed-by=di-framework')}`,
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
        `${collection('runtime.wasmcloud.dev/v1alpha1', 'WorkloadDeployment', n.namespace)}?labelSelector=${encodeURIComponent('app.kubernetes.io/managed-by=di-framework')}`,
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
        incoming.set(app, [...(incoming.get(app) ?? []), ...fresh.map((entry) => entry.line)]);
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
        if (value.kind === 'Tenant') await this.reconcileTenant(value as Tenant);
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
  }
}
export async function main(
  api: Api = new KubernetesApi(),
  pause: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<void> {
  const cfg = JSON.parse(process.env.PLATFORM_CONFIG ?? '{}') as ControllerConfig;
  if (!cfg.installation || !cfg.namespace || !cfg.hostImage || !cfg.schedulerNatsUrl)
    throw new Error('Missing PLATFORM_CONFIG');
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
