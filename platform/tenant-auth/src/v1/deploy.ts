import { problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
// Shared with platform#53 so names and labels follow one storage contract (README).
import { isManagedSecretName } from '../../../platform/src/tenancy/admission.ts';
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
import { notImplemented, type V1Context, type V1Handler, type V1Module } from './context.ts';

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
const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
const NAME_LABEL = 'app.kubernetes.io/name';
const APPLICATION_LABEL = 'di-framework.dev/application';
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
    const secret = await find(user, `${namespacePath(context)}/secrets/${object}`);
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
function invalidHttp(hostInterfaces: unknown, service: string): string | undefined {
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
    if (config?.host !== undefined && config.host !== service)
      return `${at}.config.host must be ${service}, the service name, or absent`;
  }
  return undefined;
}

/** Sets `config.host` of the `wasi:http` host interface to the service, so hosts route to it. */
function withHttpHost(template: Json, service: string): Json {
  if (!Array.isArray(template.hostInterfaces)) return template;
  return {
    ...template,
    hostInterfaces: template.hostInterfaces.map((entry: unknown) =>
      isHttp(entry)
        ? { ...entry, config: { ...(entry.config as Json | undefined), host: service } }
        : entry,
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
  const httpReason = invalidHttp(template.hostInterfaces, service);
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

/** The objects a bundle applies, in apply order: bindings first, then the workload. */
function render(
  bundle: DeployBundle,
  tenant: string,
  refs: ConfigRefs,
): { path: string; object: KubeObject }[] {
  const namespace = `di-tenant-${tenant}`;
  const name = `${bundle.service}-${bundle.env}`;
  const labels = {
    [MANAGED_BY_LABEL]: 'di-framework',
    [NAME_LABEL]: bundle.service,
    [APPLICATION_LABEL]: bundle.service,
    [SERVICE_LABEL]: bundle.service,
    [ENV]: bundle.env,
  };
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
    },
    spec: {
      ...spec,
      template: {
        ...(spec.template as Json),
        spec: {
          ...inject(withHttpHost(template, bundle.service), refs),
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
      metadata: { name: `${name}-${binding.name}`, namespace, labels },
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

/** Server-side applies one object as the calling user; `dryRun` changes nothing. */
async function apply(
  user: UserKube,
  path: string,
  object: KubeObject,
  dryRun: boolean,
): Promise<KubeObject> {
  const target = `${path}?fieldManager=${FIELD_MANAGER}${dryRun ? '&dryRun=All' : ''}`;
  try {
    const response = await user.fetch('PATCH', target, {
      headers: { Accept: 'application/json', 'Content-Type': 'application/apply-patch+yaml' },
      // JSON is YAML, so the API server reads the object as an apply configuration.
      body: JSON.stringify(object),
      signal: AbortSignal.timeout(KUBE_TIMEOUT_MS),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new KubeError(502, `PATCH ${path} rejected the user's token`);
    }
    return await readKubeResponse<KubeObject>('PATCH', path, response);
  } catch (error) {
    if (error instanceof KubeError) throw error;
    throw new KubeError(502, `PATCH ${path} failed: ${String(error)}`);
  }
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

const validated =
  (
    handler: (bundle: DeployBundle, context: V1Context, refs: ConfigRefs) => Promise<Response>,
  ): V1Handler =>
  async (command, _call, context) => {
    const bundle = command as DeployBundle;
    const reason = invalid(bundle);
    if (reason) return problem(422, 'Unprocessable Entity', reason);
    const refs = await configRefs(bundle, context);
    if (refs instanceof Response) return refs;
    return handler(bundle, context, refs);
  };

/** `/v1/deploy` and `/v1/deployments` (platform#55). */
export const deploy: V1Module = {
  previewDeploy: validated(async (bundle, context, refs) => {
    const user = context.asUser();
    const changes = [];
    for (const { path, object } of render(bundle, context.tenant, refs)) {
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
    return Response.json({ env: bundle.env, service: bundle.service, changes });
  }),
  deploy: validated(async (bundle, context, refs) => {
    const user = context.asUser();
    let applied: KubeObject | undefined;
    for (const { path, object } of render(bundle, context.tenant, refs))
      applied = await apply(user, path, object, false);
    const workload = applied as KubeObject;
    context.audit('deploy.applied', {
      user: context.principal.user,
      env: bundle.env,
      service: bundle.service,
      digest: bundle.component.digest,
    });
    return Response.json(
      {
        id: `${workload.metadata.name}.${workload.metadata.generation ?? 1}`,
        service: bundle.service,
        env: bundle.env,
        status: 'pending',
        component: bundle.component,
        createdAt: new Date().toISOString(),
      },
      { status: 202 },
    );
  }),
  registry: notImplemented('registry'),
  deployments: notImplemented('deployments'),
  deploymentStats: notImplemented('deploymentStats'),
  rollback: notImplemented('rollback'),
};
