import { type HttpCall, problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
// Shared with platform#53 so names and labels follow one storage contract (README).
import { isManagedSecretName } from '../../../platform/src/tenancy/admission.ts';
import {
  APPLICATION,
  MANAGED_BY,
  MANAGED_BY_VALUE,
} from '../../../platform/src/tenancy/log-projection.ts';
import { KubeError, readKubeResponse, type UserKube } from '../kube.ts';
import {
  CONFIG,
  ENV,
  find,
  namespace as namespacePath,
  SECRET,
  SECRET_NAME,
  secretEnvName,
  secretObjectName,
  varsConfigMapName,
} from './config.ts';
import type { V1Context, V1Module } from './context.ts';

/** The contract's `DeployBundle`, after the generated routes checked its JSON shape. */
interface DeployBundle {
  env: 'prod' | 'staging';
  service: string;
  component: { reference: string; digest: string };
  workload: Record<string, unknown>;
  bindings: { name: string; capability: string; serviceName?: string; config?: object }[];
  secrets: string[];
}

interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    generation?: number;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  [key: string]: unknown;
}

type Json = Record<string, unknown>;

/** The field manager every deploy applies with, so re-deploys by any member own the same fields. */
export const FIELD_MANAGER = 'di-tenant-deploy';
const WORKLOAD_API = 'runtime.wasmcloud.dev/v1alpha1';
const BINDING_API = 'platform.di-framework.dev/v1alpha1';
const SERVICE_LABEL = 'di-framework.dev/service';
/** Labels cli-plugin-platform renders and the platform's log projection selects on (#103). */
const NAME_LABEL = 'app.kubernetes.io/name';
/** The only `wasi:http` host interface tenant hosts serve, as cli-plugin-platform renders it. */
const HTTP_VERSION = '0.3.0';
const HTTP_INTERFACES = ['handler'];
const CAPABILITIES = ['keyvalue', 'messaging', 'blobstore', 'postgres', 'egress'];
const DNS_LABEL = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const KUBE_TIMEOUT_MS = 15_000;
/** The only label and annotation keys a bundle may set on its workload. */
const PASSTHROUGH_PREFIX = 'app.di-framework.dev/';

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface ConfigRefs {
  configFrom: { name: string }[];
  secretFrom: { name: string }[];
}

/**
 * The vars and secrets the workload references, per the storage contract (README "Secrets and
 * vars storage contract"), checked as the caller; a 422 problem when the bundle cannot use them.
 */
async function configRefs(
  bundle: DeployBundle,
  context: V1Context,
): Promise<ConfigRefs | Response> {
  const user = context.asUser();
  const { env } = bundle;
  const unprocessable = (detail: string) => problem(422, 'Unprocessable Entity', detail);
  const vars = await find(user, `${namespacePath(context)}/configmaps/${varsConfigMapName(env)}`);
  if (vars && (vars.metadata.labels?.[CONFIG] !== 'vars' || vars.metadata.labels?.[ENV] !== env))
    return unprocessable(`${varsConfigMapName(env)} is not a tenant vars ConfigMap for ${env}`);
  for (const name of bundle.secrets) {
    const object = secretObjectName(name, env);
    // Developers cannot read Secrets (#112): the existence and label check runs as the controller.
    const secret = await find(
      context.asController(),
      `${namespacePath(context)}/secrets/${object}`,
    );
    if (!secret) return unprocessable(`secret ${name} does not exist in ${env}`);
    const labels = secret.metadata.labels ?? {};
    if (labels[CONFIG] !== 'secret' || labels[ENV] !== env || labels[SECRET] !== name)
      return unprocessable(`${object} is not a tenant secret for ${name} in ${env}`);
    if (vars?.data && Object.hasOwn(vars.data, secretEnvName(name)))
      return unprocessable(
        `secret ${name} and var ${secretEnvName(name)} are both injected as ${secretEnvName(name)} in ${env}`,
      );
  }
  return {
    configFrom: vars ? [{ name: varsConfigMapName(env) }] : [],
    secretFrom: bundle.secrets.map((name) => ({ name: secretObjectName(name, env) })),
  };
}

const isHttp = (entry: unknown): entry is Json =>
  isObject(entry) && entry.namespace === 'wasi' && entry.package === 'http';

/** Why the bundle's `wasi:http` host interface cannot be served (#101), or undefined. */
function invalidHttp(hostInterfaces: unknown, host: string): string | undefined {
  if (hostInterfaces === undefined) return undefined;
  if (!Array.isArray(hostInterfaces))
    return 'workload.spec.template.spec.hostInterfaces must be an array';
  for (const [index, entry] of hostInterfaces.entries()) {
    if (!isHttp(entry)) continue;
    const at = `workload.spec.template.spec.hostInterfaces[${index}]`;
    const interfaces = entry.interfaces;
    if (
      entry.version === undefined &&
      Array.isArray(interfaces) &&
      interfaces.includes('incoming-handler')
    )
      return `${at} declares wasi:http incoming-handler without a version; hosts serve wasi:http@${HTTP_VERSION} handler`;
    if (entry.version !== HTTP_VERSION || canonical(interfaces) !== canonical(HTTP_INTERFACES))
      return `${at} must be wasi:http@${HTTP_VERSION} with interfaces [handler]`;
    const config = entry.config;
    if (config !== undefined && !isObject(config)) return `${at}.config must be an object`;
    if (config?.host !== undefined && config.host !== host)
      return `${at}.config.host must be ${host}, the service and env, or absent`;
  }
  return undefined;
}

/**
 * Sets `config.host` of the `wasi:http` host interface to `<service>-<env>`, the
 * WorkloadDeployment name, so staging and prod of one service never claim the same host.
 */
function withHttpHost(template: Json, host: string): Json {
  if (!Array.isArray(template.hostInterfaces)) return template;
  return {
    ...template,
    hostInterfaces: template.hostInterfaces.map((entry: unknown) =>
      isHttp(entry) ? { ...entry, config: { ...(entry.config as Json | undefined), host } } : entry,
    ),
  };
}

/** Why the bundle cannot be applied, or undefined when it can. */
function invalid(bundle: DeployBundle): string | undefined {
  const { service, env, component, workload, bindings, secrets } = bundle;
  if (!DNS_LABEL.test(service) || service.length > 40)
    return 'service must be a DNS label of at most 40 characters';
  if (!component.reference) return 'component.reference must not be empty';
  if (!/^sha256:[0-9a-f]+$/.test(component.digest))
    return 'component.digest must be a sha256 digest';
  if (workload.kind !== undefined && workload.kind !== 'WorkloadDeployment')
    return 'workload.kind must be WorkloadDeployment';
  if (workload.apiVersion !== undefined && workload.apiVersion !== WORKLOAD_API)
    return `workload.apiVersion must be ${WORKLOAD_API}`;
  const metadata = workload.metadata;
  if (metadata !== undefined && !isObject(metadata)) return 'workload.metadata must be an object';
  if (metadata) {
    for (const key of Object.keys(metadata))
      if (!['name', 'namespace', 'labels', 'annotations'].includes(key))
        return `workload.metadata.${key} is not allowed; only labels and annotations pass through`;
    for (const key of ['labels', 'annotations']) {
      const map = metadata[key];
      if (map === undefined) continue;
      if (!isObject(map) || !Object.values(map).every((value) => typeof value === 'string'))
        return `workload.metadata.${key} must map strings to strings`;
      for (const name of Object.keys(map))
        if (!name.startsWith(PASSTHROUGH_PREFIX))
          return `workload.metadata.${key}.${name} must start with ${PASSTHROUGH_PREFIX}`;
    }
  }
  if (metadata?.namespace !== undefined)
    return 'workload.metadata.namespace is set by the controller';
  if (metadata?.name !== undefined && metadata.name !== `${service}-${env}`)
    return `workload.metadata.name must be ${service}-${env} or absent`;
  const spec = workload.spec;
  const template = isObject(spec) && isObject(spec.template) ? spec.template.spec : undefined;
  if (!isObject(template)) return 'workload.spec.template.spec must be an object';
  for (const field of ['hostSelector', 'environment', 'hostId'])
    if (template[field] !== undefined)
      return `workload.spec.template.spec.${field} is set by the controller`;
  const components = template.components;
  if (!Array.isArray(components) || components.length === 0 || !components.every(isObject))
    return 'workload.spec.template.spec.components must be a non-empty array of objects';
  const httpReason = invalidHttp(template.hostInterfaces, `${service}-${env}`);
  if (httpReason) return httpReason;
  const guests: [string, unknown][] = components.map((guest, index) => [
    `components[${index}]`,
    guest,
  ]);
  if (template.service !== undefined) guests.push(['service', template.service]);
  for (const [at, guest] of guests) {
    if (!isObject(guest)) return `workload.spec.template.spec.${at} must be an object`;
    const local = guest.localResources;
    const environment = isObject(local) ? local.environment : undefined;
    for (const field of ['configFrom', 'secretFrom'])
      if (isObject(environment) && environment[field] !== undefined)
        return `workload.spec.template.spec.${at}.localResources.environment.${field} is set by the controller`;
  }
  if (
    !components.some(
      (guest) => typeof guest.image === 'string' && guest.image.endsWith(`@${component.digest}`),
    )
  )
    return 'workload does not run component.digest: no component image is pinned to it';
  const seen = new Set<string>();
  for (const [index, binding] of bindings.entries()) {
    const at = `bindings[${index}]`;
    if (!DNS_LABEL.test(binding.name) || binding.name.length > 63)
      return `${at}.name must be a DNS label`;
    if (seen.has(binding.name)) return `${at}.name repeats ${binding.name}`;
    seen.add(binding.name);
    if (!CAPABILITIES.includes(binding.capability))
      return `${at}.capability must be one of ${CAPABILITIES.join(', ')}`;
    if (!binding.serviceName || !DNS_LABEL.test(binding.serviceName))
      return `${at}.serviceName must name a backing service in the tenant`;
    if (binding.config && Object.keys(binding.config).length > 0)
      return `${at}.config is not supported by ServiceBinding`;
  }
  for (const [index, name] of secrets.entries()) {
    if (!SECRET_NAME.test(name) || isManagedSecretName(name))
      return `secrets[${index}] must be a tenant secret name`;
    if (secrets.indexOf(name) !== index) return `secrets[${index}] repeats ${name}`;
  }
  return undefined;
}

/** Sets every guest's vars and secrets sources to the controller's own; bundles cannot add any. */
function inject(template: Json, sources: ConfigRefs): Json {
  const withSources = (guest: unknown) => {
    const target = guest as Json;
    const local = isObject(target.localResources) ? target.localResources : {};
    const environment = isObject(local.environment) ? local.environment : {};
    return {
      ...target,
      localResources: {
        ...local,
        environment: {
          ...environment,
          // An empty list is omitted, e.g. no vars ConfigMap means no vars in that env.
          ...(sources.configFrom.length ? { configFrom: sources.configFrom } : {}),
          ...(sources.secretFrom.length ? { secretFrom: sources.secretFrom } : {}),
        },
      },
    };
  };
  return {
    ...template,
    ...(Array.isArray(template.components)
      ? { components: template.components.map(withSources) }
      : {}),
    ...(isObject(template.service) ? { service: withSources(template.service) } : {}),
  };
}

/**
 * The objects a bundle applies, in apply order: bindings first, then the workload. A deploy names
 * its `revision` on the workload (`RUNNING`), which a bundle cannot set (`PASSTHROUGH_PREFIX`).
 */
function render(
  bundle: DeployBundle,
  tenant: string,
  refs: ConfigRefs,
  revision?: string,
): { path: string; object: KubeObject }[] {
  const namespace = `di-tenant-${tenant}`;
  const name = `${bundle.service}-${bundle.env}`;
  // cli-plugin-platform renders `name` as the WorkloadDeployment name and `di-framework destroy`
  // deletes by it, so it must not be the bare service; `application` keys the log projection.
  // ServiceBindings get only `managed-by` (as the CLI renders) plus service and env.
  const bindingLabels = {
    [MANAGED_BY]: MANAGED_BY_VALUE,
    [SERVICE_LABEL]: bundle.service,
    [ENV]: bundle.env,
  };
  const labels = { ...bindingLabels, [NAME_LABEL]: name, [APPLICATION]: bundle.service };
  const metadata = (bundle.workload.metadata ?? {}) as Json;
  const spec = bundle.workload.spec as Json;
  const template = (spec.template as Json).spec as Json;
  const workload: KubeObject = {
    apiVersion: WORKLOAD_API,
    kind: 'WorkloadDeployment',
    metadata: {
      ...metadata,
      name,
      namespace,
      labels: { ...(metadata.labels as Record<string, string>), ...labels },
      ...(revision
        ? {
            annotations: {
              ...(metadata.annotations as Record<string, string>),
              [RUNNING]: revision,
            },
          }
        : {}),
    },
    spec: {
      ...spec,
      template: {
        ...(spec.template as Json),
        spec: {
          ...inject(withHttpHost(template, name), refs),
          environment: namespace,
          hostSelector: { hostgroup: `tenant-${tenant}` },
        },
      },
    },
  };
  const bindings = bundle.bindings.map((binding) => {
    const object: KubeObject = {
      apiVersion: BINDING_API,
      kind: 'ServiceBinding',
      metadata: { name: `${name}-${binding.name}`, namespace, labels: bindingLabels },
      spec: {
        serviceName: binding.serviceName,
        bindingName: binding.name,
        capability: binding.capability,
        ...(binding.capability === 'egress' ? { workloadName: name } : {}),
      },
    };
    return {
      path: `/apis/${BINDING_API}/namespaces/${namespace}/servicebindings/${object.metadata.name}`,
      object,
    };
  });
  return [
    ...bindings,
    {
      path: `/apis/${WORKLOAD_API}/namespaces/${namespace}/workloaddeployments/${name}`,
      object: workload,
    },
  ];
}

/** Sends one request as the calling user; a rejected token or a network failure is a 502. */
async function send<T>(
  user: UserKube,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<T> {
  const bare = path.split('?')[0];
  try {
    const response = await user.fetch(method, path, {
      headers,
      body,
      signal: AbortSignal.timeout(KUBE_TIMEOUT_MS),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new KubeError(502, `${method} ${bare} rejected the user's token`);
    }
    return await readKubeResponse<T>(method, path, response);
  } catch (error) {
    if (error instanceof KubeError) throw error;
    throw new KubeError(502, `${method} ${bare} failed: ${String(error)}`);
  }
}

/** Server-side applies one object as the calling user; `dryRun` changes nothing. */
function apply(
  user: UserKube,
  path: string,
  object: KubeObject,
  dryRun: boolean,
): Promise<KubeObject> {
  // JSON is YAML, so the API server reads the object as an apply configuration.
  return send<KubeObject>(
    user,
    'PATCH',
    `${path}?fieldManager=${FIELD_MANAGER}${dryRun ? '&dryRun=All' : ''}`,
    { Accept: 'application/json', 'Content-Type': 'application/apply-patch+yaml' },
    JSON.stringify(object),
  );
}

/** Reads the current object as the calling user; undefined when it does not exist yet. */
async function current(user: UserKube, path: string): Promise<KubeObject | undefined> {
  try {
    return await user.call<KubeObject>('GET', path);
  } catch (error) {
    if (error instanceof KubeError && error.status === 404) return undefined;
    throw error;
  }
}

/** JSON with sorted keys, so two objects compare by content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** The fields of `after` that differ from `before`: labels and each top-level spec field. */
function changedFields(before: KubeObject, after: KubeObject): string[] {
  const changed: string[] = [];
  if (canonical(before.metadata.labels ?? {}) !== canonical(after.metadata.labels ?? {}))
    changed.push('metadata.labels');
  const keys = new Set([...Object.keys(before.spec ?? {}), ...Object.keys(after.spec ?? {})]);
  for (const key of [...keys].sort())
    if (canonical(before.spec?.[key]) !== canonical(after.spec?.[key])) changed.push(`spec.${key}`);
  return changed;
}

// ---- revisions (platform#55:history) ----------------------------------------------------------

/**
 * Each deploy is stored as a revision ConfigMap `di-deploy-<service>-<env>.<n>`. The name prefix
 * and the revision label keep them apart from the #53 vars ConfigMaps (`di-vars-<env>`, label
 * `config: vars`) and from the log projection, which selects on `di-framework.dev/projection`;
 * revisions carry neither.
 */
export const REVISION_PREFIX = 'di-deploy-';
export const REVISION = 'platform.di-framework.dev/deploy-revision';
/** The revision id a deploy applied, on the WorkloadDeployment: the source of the running one. */
export const RUNNING = 'platform.di-framework.dev/revision';
const CREATED_AT = 'platform.di-framework.dev/created-at';
/** The bundle's component as JSON, so lists read metadata only. */
const COMPONENT = 'platform.di-framework.dev/component';
/** Where the revision is in the reserve-apply-mark protocol (README "Deploy history"). */
const STATE = 'platform.di-framework.dev/revision-state';
const STATUS = 'platform.di-framework.dev/status';
const READY_AT = 'platform.di-framework.dev/ready-at';
const ROLLBACK_OF = 'platform.di-framework.dev/rollback-of';
const METADATA_LIST = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1';
/**
 * The tenant namespace allows `count/configmaps: 100` (resources.ts), shared with `di-vars-<env>`,
 * the `di-logs-*` projections and `kube-root-ca.crt`; revisions stay within these budgets.
 */
export const HISTORY_PER_SERVICE_ENV = 10;
export const HISTORY_TENANT_BUDGET = 40;
/** How many revision numbers a deploy tries when concurrent deploys take the same one. */
export const RESERVE_ATTEMPTS = 5;
/** How many times a revision update is retried after a 409 from a concurrent writer. */
export const UPDATE_ATTEMPTS = 5;
/** A ConfigMap holds at most 1 MiB; this leaves room for metadata and the digest. */
export const MAX_STORED_BUNDLE_BYTES = 900 * 1024;

type Status = 'pending' | 'rolling' | 'ready' | 'failed' | 'rolled-back';
type State = 'pending' | 'live' | 'replaced' | 'failed';
const STATES: readonly string[] = ['pending', 'live', 'replaced', 'failed'];
interface Live {
  status: Status;
  readyAt?: string;
}

interface RevisionObject {
  metadata: {
    name: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  data?: Record<string, string>;
  [key: string]: unknown;
}

/** A revision ConfigMap's metadata that passed `parseRevision`. */
interface Revision {
  object: RevisionObject;
  id: string;
  n: number;
  service: string;
  env: string;
  state: State;
  createdAt: string;
  component: DeployBundle['component'];
}

const coreNamespace = (tenant: string) => `/api/v1/namespaces/di-tenant-${tenant}`;
const configmapsPath = (tenant: string) => `${coreNamespace(tenant)}/configmaps`;
const workloadsPath = (tenant: string) =>
  `/apis/${WORKLOAD_API}/namespaces/di-tenant-${tenant}/workloaddeployments`;
const bindingsPath = (tenant: string) =>
  `/apis/${BINDING_API}/namespaces/di-tenant-${tenant}/servicebindings`;
const validService = (service: unknown): service is string =>
  typeof service === 'string' && DNS_LABEL.test(service) && service.length <= 40;
const INVALID_SERVICE = 'service must be a DNS label of at most 40 characters';
const groupOf = (revision: { service: string; env: string }) =>
  `${revision.service}-${revision.env}`;
const nameOf = (revision: Revision) => revision.object.metadata.name;
const isComponent = (value: unknown): value is DeployBundle['component'] =>
  isObject(value) && typeof value.reference === 'string' && typeof value.digest === 'string';

/** A revision ConfigMap as a `Revision`, or undefined (logged) when it was edited out of shape. */
function parseRevision(object: RevisionObject): Revision | undefined {
  const { name, labels = {}, annotations = {} } = object.metadata;
  const skip = (reason: string) => {
    console.log(JSON.stringify({ event: 'deploy.revision-skipped', name, reason }));
    return undefined;
  };
  const label = labels[REVISION] ?? '';
  if (!/^[1-9][0-9]{0,8}$/.test(label)) return skip(`${REVISION} is not a positive integer`);
  const service = labels[SERVICE_LABEL];
  const env = labels[ENV];
  if (!validService(service) || (env !== 'prod' && env !== 'staging'))
    return skip('service or env label is invalid');
  const id = `${service}-${env}.${label}`;
  if (name !== `${REVISION_PREFIX}${id}`) return skip(`name is not ${REVISION_PREFIX}${id}`);
  let component: unknown;
  try {
    component = JSON.parse(annotations[COMPONENT] ?? '');
  } catch {
    return skip(`${COMPONENT} is not JSON`);
  }
  if (!isComponent(component)) return skip(`${COMPONENT} is not a component`);
  const state = annotations[STATE] ?? 'live';
  if (!STATES.includes(state)) return skip(`${STATE} is not a known state`);
  return {
    object,
    id,
    n: Number(label),
    service,
    env,
    state: state as State,
    createdAt: annotations[CREATED_AT] ?? '',
    component,
  };
}

/** Within one service/env, `<n>` alone orders revisions, newest first. */
const byNumber = (a: Revision, b: Revision) => b.n - a.n;

/**
 * Newest first. Each service/env keeps the slots `created-at` (tiebreak: name) gives it, filled
 * in `<n>` order, so a clock step can reorder services but never revisions of one service/env.
 */
function ordered(items: Revision[]): Revision[] {
  const byTime = [...items].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || nameOf(a).localeCompare(nameOf(b)),
  );
  const groups = new Map<string, Revision[]>();
  for (const revision of [...items].sort(byNumber)) {
    const group = groups.get(groupOf(revision)) ?? [];
    group.push(revision);
    groups.set(groupOf(revision), group);
  }
  return byTime.map((revision) => groups.get(groupOf(revision))?.shift() as Revision);
}

/**
 * The well-formed revisions in the tenant matching `filter`, newest first (`ordered`). Only their
 * metadata is listed; `load` fetches the one bundle a rollback needs.
 */
async function revisions(
  user: UserKube,
  tenant: string,
  filter: { env?: string; service?: string },
): Promise<Revision[]> {
  const selector = [
    REVISION,
    ...(filter.env ? [`${ENV}=${filter.env}`] : []),
    ...(filter.service ? [`${SERVICE_LABEL}=${filter.service}`] : []),
  ];
  const list = await send<{ items?: RevisionObject[] }>(
    user,
    'GET',
    `${configmapsPath(tenant)}?labelSelector=${encodeURIComponent(selector.join(','))}`,
    { Accept: METADATA_LIST },
  );
  return ordered(
    (list.items ?? [])
      .filter((item) => item.metadata.name.startsWith(REVISION_PREFIX))
      .map(parseRevision)
      .filter((revision): revision is Revision => revision !== undefined),
  );
}

/** A state change the history read derived from the workloads, to be written back by a deploy. */
interface Mark {
  revision: Revision;
  state: State;
}

/** The revisions, the tenant's workloads by name, and each service/env's running revision. */
interface History {
  items: Revision[];
  workloads: Map<string, KubeObject>;
  running: Map<string, Revision>;
  marks: Mark[];
}

/**
 * Reads the history. The running revision of a service/env is the one its WorkloadDeployment
 * names (`RUNNING`), whatever its ConfigMap says: that revision reads as `live`, and any other
 * `live` one as `replaced`. This repairs history after a crash between apply and mark, after
 * out-of-order concurrent applies, and for workloads that were destroyed. `marks` lists what
 * changed; reads only report them, and the next deploy writes them.
 */
async function history(
  user: UserKube,
  tenant: string,
  filter: { env?: string; service?: string } = {},
): Promise<History> {
  const items = await revisions(user, tenant, filter);
  const list = await user.call<{ items?: KubeObject[] }>(
    'GET',
    `${workloadsPath(tenant)}?labelSelector=${encodeURIComponent(`${MANAGED_BY}=${MANAGED_BY_VALUE}`)}`,
  );
  const workloads = new Map((list.items ?? []).map((item) => [item.metadata.name, item]));
  const running = new Map<string, Revision>();
  const marks: Mark[] = [];
  for (const revision of items) {
    const named = workloads.get(groupOf(revision))?.metadata.annotations?.[RUNNING] === revision.id;
    if (named) running.set(groupOf(revision), revision);
    const state = named ? 'live' : revision.state === 'live' ? 'replaced' : revision.state;
    if (state === revision.state) continue;
    marks.push({ revision, state });
    revision.state = state;
  }
  return { items, workloads, running, marks };
}

/** The live rollout state of a WorkloadDeployment, from its Ready condition. */
function liveStatus(workload: KubeObject | undefined): Live {
  const status = workload?.status as Json | undefined;
  const conditions = status?.conditions;
  const ready = Array.isArray(conditions)
    ? (conditions as Json[]).find((condition) => condition.type === 'Ready')
    : undefined;
  // Until the platform observed the applied generation, Ready describes the previous spec.
  const observed = ready?.observedGeneration ?? status?.observedGeneration;
  const generation = workload?.metadata.generation;
  if (
    ready &&
    typeof observed === 'number' &&
    typeof generation === 'number' &&
    observed < generation
  )
    return { status: 'rolling' };
  if (ready?.status === 'True')
    return {
      status: 'ready',
      ...(typeof ready.lastTransitionTime === 'string'
        ? { readyAt: ready.lastTransitionTime }
        : {}),
    };
  if (ready?.status === 'False') return { status: 'failed' };
  return { status: ready ? 'rolling' : 'pending' };
}

const sha256 = (text: string) =>
  `sha256:${new Bun.CryptoHasher('sha256').update(text).digest('hex')}`;

/** The contract's `Deployment` for one revision. */
function deployment(revision: Revision, { status, readyAt }: Live) {
  return {
    id: revision.id,
    service: revision.service,
    env: revision.env,
    status,
    component: revision.component,
    createdAt: revision.createdAt,
    ...(readyAt ? { readyAt } : {}),
  };
}

/** What a revision that is not running reports: its recorded status, or that it never went live. */
function recorded(revision: Revision): Live {
  if (revision.state === 'pending' || revision.state === 'failed')
    return { status: revision.state };
  const annotations = revision.object.metadata.annotations ?? {};
  return {
    status: (annotations[STATUS] as Status | undefined) ?? 'pending',
    ...(annotations[READY_AT] ? { readyAt: annotations[READY_AT] } : {}),
  };
}

const hasStatus = (error: unknown, status: number) =>
  error instanceof KubeError && error.status === status;

/** Deletes `path`; an object a concurrent deploy already deleted counts as deleted. */
async function remove(user: UserKube, path: string): Promise<void> {
  try {
    await user.call('DELETE', path);
  } catch (error) {
    if (!hasStatus(error, 404)) throw error;
  }
}

/**
 * The revisions to delete to make room for one more of `group`: at most `HISTORY_PER_SERVICE_ENV`
 * per service/env and `HISTORY_TENANT_BUDGET` in the tenant, oldest first, never a revision a
 * workload runs. A 507 when the revisions workloads run already fill the tenant budget.
 */
function evictions({ items, running }: History, group: string): Revision[] | Response {
  const kept = new Set(running.values());
  const counts = new Map<string, number>([[group, 1]]);
  for (const revision of items)
    counts.set(groupOf(revision), (counts.get(groupOf(revision)) ?? 0) + 1);
  const oldest = [...items].reverse();
  const evict = new Set<Revision>();
  for (const revision of oldest) {
    const count = counts.get(groupOf(revision)) ?? 0;
    if (kept.has(revision) || count <= HISTORY_PER_SERVICE_ENV) continue;
    evict.add(revision);
    counts.set(groupOf(revision), count - 1);
  }
  let total = items.length + 1 - evict.size;
  for (const revision of oldest) {
    if (total <= HISTORY_TENANT_BUDGET) break;
    if (evict.has(revision) || kept.has(revision)) continue;
    evict.add(revision);
    total--;
  }
  if (total > HISTORY_TENANT_BUDGET)
    return problem(
      507,
      'Insufficient Storage',
      `the ${kept.size} revisions running workloads fill the tenant's deploy history budget of ${HISTORY_TENANT_BUDGET}, so nothing was applied`,
    );
  return [...evict];
}

/** Creates the revision as `pending` from `first` on, taking the next `<n>` on a 409. */
async function reserve(
  user: UserKube,
  tenant: string,
  bundle: DeployBundle,
  first: number,
  rollbackOf?: string,
): Promise<Revision | Response> {
  const text = JSON.stringify(bundle);
  for (let n = first; n < first + RESERVE_ATTEMPTS; n++) {
    const object: RevisionObject = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: `${REVISION_PREFIX}${bundle.service}-${bundle.env}.${n}`,
        labels: { [REVISION]: String(n), [SERVICE_LABEL]: bundle.service, [ENV]: bundle.env },
        annotations: {
          [CREATED_AT]: new Date().toISOString(),
          [STATE]: 'pending',
          [COMPONENT]: JSON.stringify(bundle.component),
          ...(rollbackOf ? { [ROLLBACK_OF]: rollbackOf } : {}),
        },
      },
      data: { bundle: text, digest: sha256(text) },
    };
    try {
      await user.call('POST', configmapsPath(tenant), object);
      return parseRevision(object) as Revision;
    } catch (error) {
      if (hasStatus(error, 409)) continue;
      if (hasStatus(error, 403) && /exceeded quota/i.test((error as Error).message))
        return problem(
          507,
          'Insufficient Storage',
          `the tenant's ConfigMap quota is full, so nothing was applied: ${(error as Error).message}`,
        );
      throw error;
    }
  }
  return problem(
    409,
    'Conflict',
    `concurrent deploys of ${bundle.service} in ${bundle.env} took ${RESERVE_ATTEMPTS} revision numbers; nothing was applied`,
  );
}

/** Read-modify-writes a revision's annotations, re-reading after a 409; a deleted one is skipped. */
async function annotate(
  user: UserKube,
  tenant: string,
  name: string,
  change: Record<string, string>,
): Promise<void> {
  const path = `${configmapsPath(tenant)}/${name}`;
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
    const object = await current(user, path);
    if (!object) return;
    const { metadata } = object as unknown as RevisionObject;
    try {
      await user.call('PUT', path, {
        ...object,
        metadata: { ...metadata, annotations: { ...metadata.annotations, ...change } },
      });
      return;
    } catch (error) {
      if (hasStatus(error, 404)) return;
      if (!hasStatus(error, 409)) throw error;
    }
  }
  throw new KubeError(409, `${name} kept changing; its history state was not updated`);
}

/**
 * The stored bundle of a rollback target: a 422 when it does not match `data.digest` or is not a
 * complete bundle for the revision's service and env.
 */
async function load(
  user: UserKube,
  tenant: string,
  revision: Revision,
): Promise<DeployBundle | Response> {
  const object = (await current(user, `${configmapsPath(tenant)}/${nameOf(revision)}`)) as
    | RevisionObject
    | undefined;
  const text = object?.data?.bundle ?? '';
  const unprocessable = (reason: string) =>
    problem(422, 'Unprocessable Entity', `deployment ${revision.id} ${reason}`);
  if (object?.data?.digest !== sha256(text))
    return unprocessable('does not match its stored digest');
  let bundle: unknown;
  try {
    bundle = JSON.parse(text);
  } catch {
    return unprocessable('stores a bundle that is not JSON');
  }
  if (
    !isObject(bundle) ||
    bundle.service !== revision.service ||
    bundle.env !== revision.env ||
    !isComponent(bundle.component) ||
    !isObject(bundle.workload) ||
    !Array.isArray(bundle.bindings) ||
    !bundle.bindings.every(isObject) ||
    !Array.isArray(bundle.secrets) ||
    !bundle.secrets.every((name) => typeof name === 'string')
  )
    return unprocessable('stores an incomplete bundle');
  return bundle as unknown as DeployBundle;
}

/** ServiceBindings this service/env rendered (labels and name prefix) that `keep` lacks. */
async function staleBindings(
  user: UserKube,
  tenant: string,
  bundle: DeployBundle,
  keep: Set<string>,
): Promise<string[]> {
  const selector = [
    `${MANAGED_BY}=${MANAGED_BY_VALUE}`,
    `${SERVICE_LABEL}=${bundle.service}`,
    `${ENV}=${bundle.env}`,
  ].join(',');
  const list = await user.call<{ items?: KubeObject[] }>(
    'GET',
    `${bindingsPath(tenant)}?labelSelector=${encodeURIComponent(selector)}`,
  );
  const prefix = `${bundle.service}-${bundle.env}-`;
  return (list.items ?? [])
    .map((item) => item.metadata.name)
    .filter((name) => name.startsWith(prefix) && !keep.has(name));
}

/**
 * Reads the history, prunes it, reserves a `pending` revision, applies the checked bundle naming
 * the revision on the workload and prunes dropped bindings, then marks the revision `live`, the
 * one it replaced `replaced`, and writes the repairs `history` found. A failed apply marks the
 * revision `failed`, so history never names a bundle that did not go live.
 */
async function rollout(
  bundle: DeployBundle,
  context: V1Context,
  refs: ConfigRefs,
  rollbackOf?: string,
): Promise<Response> {
  const user = context.asUser();
  const { tenant } = context;
  const group = `${bundle.service}-${bundle.env}`;
  const view = await history(user, tenant);
  const before = liveStatus(view.workloads.get(group));
  const previous = view.running.get(group);
  const own = view.items.filter((revision) => groupOf(revision) === group);
  const first = Math.max(0, ...own.map((revision) => revision.n)) + 1;
  const evict = evictions(view, group);
  if (evict instanceof Response) return evict;
  for (const revision of evict) await remove(user, `${configmapsPath(tenant)}/${nameOf(revision)}`);
  const revision = await reserve(user, tenant, bundle, first, rollbackOf);
  if (revision instanceof Response) return revision;
  try {
    const objects = render(bundle, tenant, refs, revision.id);
    for (const { path, object } of objects) await apply(user, path, object, false);
    const keep = new Set(objects.map(({ object }) => object.metadata.name));
    for (const stale of await staleBindings(user, tenant, bundle, keep))
      await remove(user, `${bindingsPath(tenant)}/${stale}`);
  } catch (error) {
    await annotate(user, tenant, nameOf(revision), { [STATE]: 'failed' }).catch(() => {});
    throw error;
  }
  // The change is live: a bookkeeping failure is logged, not reported as a failed deploy; the
  // workload names this revision, so the next deploy repairs it.
  try {
    await annotate(user, tenant, nameOf(revision), { [STATE]: 'live' });
    if (previous)
      await annotate(user, tenant, nameOf(previous), {
        [STATE]: 'replaced',
        [STATUS]: rollbackOf ? 'rolled-back' : before.status,
        ...(before.readyAt ? { [READY_AT]: before.readyAt } : {}),
      });
    for (const mark of view.marks)
      if (mark.revision !== previous && !evict.includes(mark.revision))
        await annotate(user, tenant, nameOf(mark.revision), { [STATE]: mark.state });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'deploy.history-mark-failed',
        revision: revision.id,
        error: String(error),
      }),
    );
  }
  context.audit(rollbackOf ? 'deploy.rolled-back' : 'deploy.applied', {
    user: context.principal.user,
    env: bundle.env,
    service: bundle.service,
    digest: bundle.component.digest,
    revision: revision.id,
    ...(rollbackOf ? { to: rollbackOf } : {}),
  });
  return Response.json(deployment(revision, { status: 'pending' }), { status: 202 });
}

/** Validates the bundle and the vars and secrets it uses, then runs `handler`. */
async function checked(
  bundle: DeployBundle,
  context: V1Context,
  handler: (refs: ConfigRefs) => Promise<Response>,
): Promise<Response> {
  const reason = invalid(bundle);
  if (reason) return problem(422, 'Unprocessable Entity', reason);
  // The workload's HTTP host is `<service>-<env>`; it must not be the tenant registry's.
  const host = `${bundle.service}-${bundle.env}`;
  if (context.registryHost && host === context.registryHost.toLowerCase())
    return problem(
      422,
      'Unprocessable Entity',
      `${host} is reserved for the tenant registry; choose another service name`,
    );
  const refs = await configRefs(bundle, context);
  if (refs instanceof Response) return refs;
  return handler(refs);
}

const queryValue = (call: HttpCall, name: string) => {
  const raw = call.request.query?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
};

/** `/v1/deploy` and `/v1/deployments` (platform#55). */
export const deploy: V1Module = {
  previewDeploy: async (command, _call, context) => {
    const bundle = command as DeployBundle;
    return checked(bundle, context, async (refs) => {
      const user = context.asUser();
      const changes = [];
      const objects = render(bundle, context.tenant, refs);
      for (const { path, object } of objects) {
        const before = await current(user, path);
        const after = await apply(user, path, object, true);
        const fields = before ? changedFields(before, after) : [];
        changes.push({
          kind: !before ? 'create' : fields.length ? 'update' : 'unchanged',
          resource: object.kind,
          name: object.metadata.name,
          ...(fields.length ? { detail: fields.join(', ') } : {}),
        });
      }
      const keep = new Set(objects.map(({ object }) => object.metadata.name));
      for (const stale of await staleBindings(user, context.tenant, bundle, keep))
        changes.push({ kind: 'delete', resource: 'ServiceBinding', name: stale });
      return Response.json({ env: bundle.env, service: bundle.service, changes });
    });
  },
  deploy: async (command, _call, context) => {
    const bundle = command as DeployBundle;
    return checked(bundle, context, async (refs) => {
      const size = new TextEncoder().encode(JSON.stringify(bundle)).byteLength;
      if (size > MAX_STORED_BUNDLE_BYTES)
        return problem(
          422,
          'Unprocessable Entity',
          `bundle is ${size} bytes; deploy history stores at most ${MAX_STORED_BUNDLE_BYTES}`,
        );
      return rollout(bundle, context, refs);
    });
  },
  // The credential is the caller's own identity token or API key, which the registry checks
  // against this controller's whoami (platform#83); nothing is minted and no Secret is read.
  registry: async (_command, _call, context) => {
    if (!context.registryUrl)
      return problem(503, 'Service Unavailable', 'no registry is configured for this tenant');
    return Response.json({ url: context.registryUrl, auth: 'basic-identity', username: 'token' });
  },
  deployments: async (_command, call, context) => {
    const env = String(queryValue(call, 'env'));
    const service = queryValue(call, 'service');
    if (service !== undefined && !validService(service))
      return problem(422, 'Unprocessable Entity', INVALID_SERVICE);
    const view = await history(context.asUser(), context.tenant, { env, service });
    // The running revision of each service reports the live rollout; the others what they were
    // when they were replaced, or `pending`/`failed` when they never went live.
    const live = new Map<Revision, Live>();
    for (const [group, revision] of view.running)
      live.set(revision, liveStatus(view.workloads.get(group)));
    return Response.json({
      items: view.items.map((revision) =>
        deployment(revision, live.get(revision) ?? recorded(revision)),
      ),
    });
  },
  deploymentStats: async (_command, call, context) => {
    const env = String(queryValue(call, 'env'));
    const view = await history(context.asUser(), context.tenant, { env });
    // Revisions that never went live (`pending`, `failed`) are not deployments.
    const items = view.items.filter(
      (revision) => revision.state === 'live' || revision.state === 'replaced',
    );
    const services = [...new Set(items.map((revision) => revision.service))];
    let ready = 0;
    let failed = 0;
    for (const service of services) {
      const { status } = liveStatus(view.workloads.get(`${service}-${env}`));
      if (status === 'ready') ready++;
      if (status === 'failed') failed++;
    }
    return Response.json({
      env,
      services: services.length,
      deployments: items.length,
      ready,
      failed,
      ...(items[0] ? { lastDeployedAt: items[0].createdAt } : {}),
    });
  },
  rollback: async (command, _call, context) => {
    const { env, service, to } = command as { env: string; service: string; to?: string };
    if (!validService(service)) return problem(422, 'Unprocessable Entity', INVALID_SERVICE);
    const user = context.asUser();
    const view = await history(user, context.tenant, { env, service });
    const running = view.running.get(`${service}-${env}`);
    // By default, the newest revision that went live before the running one.
    const target = to
      ? view.items.find(
          (revision) =>
            revision.id === to && (revision.state === 'live' || revision.state === 'replaced'),
        )
      : view.items.find(
          (revision) => revision.state === 'replaced' && (!running || revision.n < running.n),
        );
    if (!target)
      return problem(
        404,
        'Not Found',
        to
          ? `deployment ${to} is not in the history of ${service} in ${env}`
          : `${service} has no earlier deployment in ${env}`,
      );
    const bundle = await load(user, context.tenant, target);
    if (bundle instanceof Response) return bundle;
    return checked(bundle, context, (refs) => rollout(bundle, context, refs, target.id));
  },
};
