import { problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
import {
  EGRESS_MAX_DESTINATIONS as MAX_DESTINATIONS,
  validEgressDestination,
} from '../../../platform/src/tenancy/egress.ts';
import { KubeError } from '../kube.ts';
import { ENV as ENV_LABEL } from './config.ts';
import type { V1Module } from './context.ts';
import { SERVICE_LABEL } from './deploy.ts';
import { proxySessions, SERVICE_NAME } from './proxy.ts';

/** The backing-service types admission accepts, with the platform default class of each. */
export const DEFAULT_CLASSES = {
  keyvalue: 'keyvalue-redis',
  messaging: 'messaging-nats',
  blobstore: 'blobstore-nats',
  postgres: 'postgres-dedicated',
  egress: 'egress-public',
} as const;
type ServiceType = keyof typeof DEFAULT_CLASSES;

const GROUP_VERSION = 'platform.di-framework.dev/v1alpha1';
/** Records the `/v1` environment the service was created for. */
export const ENV_ANNOTATION = 'platform.di-framework.dev/env';
const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|Ki|Mi|Gi|Ti)?$/;

type Sizing = { storage?: string; memory?: string; cpu?: string };

interface CreateServiceCommand {
  env: string;
  type: ServiceType;
  name: string;
  className?: string;
  parameters?: Sizing;
  deletionPolicy?: 'Retain' | 'Delete';
  destinations?: string[];
}

interface BackingService {
  metadata: { name: string; creationTimestamp?: string; annotations?: Record<string, string> };
  spec: {
    type: ServiceType;
    className?: string;
    parameters?: Sizing;
    deletionPolicy?: 'Retain' | 'Delete';
    destinations?: string[];
  };
}

interface ServiceBinding {
  metadata: { name: string; labels?: Record<string, string> };
  spec?: { serviceName?: string };
}

const servicesPath = (tenant: string) =>
  `/apis/${GROUP_VERSION}/namespaces/di-tenant-${tenant}/backingservices`;
const notFound = (error: unknown) => error instanceof KubeError && error.status === 404;

/**
 * The deployed service a ServiceBinding belongs to, `<service>-<env>` as the deploy lane names its
 * WorkloadDeployment, or the binding's own name when it carries no deploy labels.
 */
function binderOf(binding: ServiceBinding): string {
  const labels = binding.metadata.labels ?? {};
  const service = labels[SERVICE_LABEL];
  const env = labels[ENV_LABEL];
  return service && env ? `${service}-${env}` : binding.metadata.name;
}

/** The admission rules a request can break, checked before the API server sees it. */
function invalid(command: CreateServiceCommand): string | undefined {
  if (command.name.length > 40 || !SERVICE_NAME.test(command.name))
    return 'name must be a DNS label of at most 40 characters';
  const fallback = DEFAULT_CLASSES[command.type];
  if (command.className !== undefined && command.className !== fallback)
    return `className for ${command.type} must be the platform default ${fallback}`;
  for (const [key, value] of Object.entries(command.parameters ?? {}))
    if (!QUANTITY.test(value as string)) return `parameters.${key} must be a quantity such as 1Gi`;
  if (command.type === 'egress') {
    if (!command.destinations?.length) return 'an egress service needs at least one destination';
    if (command.parameters !== undefined) return 'an egress service takes no sizing parameters';
    if (command.destinations.length > MAX_DESTINATIONS)
      return `an egress service takes at most ${MAX_DESTINATIONS} destinations`;
    if (new Set(command.destinations).size !== command.destinations.length)
      return 'destinations must not repeat';
    // The platform's own check for a requested destination: `host`, `*.suffix`, either with
    // `:port`, within the BackingService schema's length limit.
    const bad = command.destinations.find((d) => !validEgressDestination(d));
    if (bad !== undefined) return `destination ${bad} must be host, *.suffix, or either with :port`;
  } else if (command.destinations !== undefined) {
    return 'destinations are only allowed on an egress service';
  }
  return undefined;
}

/** `/v1/services` creation, deletion, and the service HTTP proxy session (platform#56). */
export const services: V1Module = {
  async createService(input, _call, context) {
    const command = input as CreateServiceCommand;
    const reason = invalid(command);
    if (reason) return problem(422, 'Unprocessable Entity', reason);
    const spec: BackingService['spec'] = { type: command.type };
    if (command.destinations !== undefined) spec.destinations = command.destinations;
    if (command.className !== undefined) spec.className = command.className;
    if (command.parameters !== undefined && Object.keys(command.parameters).length > 0)
      spec.parameters = command.parameters;
    if (command.deletionPolicy !== undefined) spec.deletionPolicy = command.deletionPolicy;
    const namespace = `di-tenant-${context.tenant}`;
    const created = await context
      .asUser()
      .call<BackingService>(
        'POST',
        `/apis/${GROUP_VERSION}/namespaces/${namespace}/backingservices`,
        {
          apiVersion: GROUP_VERSION,
          kind: 'BackingService',
          metadata: { name: command.name, annotations: { [ENV_ANNOTATION]: command.env } },
          spec,
        },
      );
    context.audit('service.created', {
      user: context.principal.user,
      service: command.name,
      type: command.type,
      env: command.env,
    });
    return Response.json(
      {
        name: created.metadata.name,
        env: command.env,
        type: created.spec.type,
        className: created.spec.className || DEFAULT_CLASSES[created.spec.type],
        ...(created.spec.parameters ? { parameters: created.spec.parameters } : {}),
        ...(created.spec.deletionPolicy ? { deletionPolicy: created.spec.deletionPolicy } : {}),
        ...(created.spec.destinations ? { destinations: created.spec.destinations } : {}),
        createdAt: created.metadata.creationTimestamp ?? new Date().toISOString(),
      },
      { status: 201 },
    );
  },

  /**
   * Deletes a BackingService of `env` (platform#98). Refused with 409 while any ServiceBinding
   * names it, whatever its `deletionPolicy`: a running workload would lose the capability. Once
   * deleted, the platform keeps (`Retain`, the default) or deletes (`Delete`) its data and
   * storage according to that policy.
   */
  async deleteService(_input, call, context) {
    const env = String(call.request.query?.env);
    const name = call.request.params?.service ?? '';
    if (name.length > 63 || !SERVICE_NAME.test(name))
      return problem(422, 'Unprocessable Entity', 'service must be a DNS label');
    const user = context.asUser();
    const path = `${servicesPath(context.tenant)}/${name}`;
    const missing = () => problem(404, 'Not Found', `service ${name} does not exist in ${env}`);
    let existing: BackingService;
    try {
      existing = await user.call<BackingService>('GET', path);
    } catch (error) {
      if (notFound(error)) return missing();
      throw error;
    }
    // A service created without `/v1` carries no env; it is deletable from either env.
    const createdFor = existing.metadata.annotations?.[ENV_ANNOTATION];
    if (createdFor !== undefined && createdFor !== env) return missing();
    const bindings = await user.call<{ items?: ServiceBinding[] }>(
      'GET',
      `/apis/${GROUP_VERSION}/namespaces/di-tenant-${context.tenant}/servicebindings`,
    );
    const binders = [
      ...new Set(
        (bindings.items ?? [])
          .filter((binding) => binding.spec?.serviceName === name)
          .map(binderOf),
      ),
    ].sort((a, b) => a.localeCompare(b));
    if (binders.length > 0)
      return problem(
        409,
        'Conflict',
        `service ${name} is bound by deployed services: ${binders.join(', ')}; remove them first`,
      );
    try {
      await user.call('DELETE', path);
    } catch (error) {
      if (notFound(error)) return missing();
      throw error;
    }
    context.audit('service.deleted', {
      user: context.principal.user,
      service: name,
      env,
      deletionPolicy: existing.spec.deletionPolicy ?? 'Retain',
    });
    return new Response(null, { status: 204 });
  },

  async proxy(input, call, context) {
    const { env, port } = input as { env: string; port?: number };
    const service = call.request.params?.service ?? '';
    if (service.length > 63 || !SERVICE_NAME.test(service))
      return problem(422, 'Unprocessable Entity', 'service must be a DNS label');
    if (port !== undefined && port !== 80)
      return problem(
        422,
        'Unprocessable Entity',
        'only port 80, the tenant HTTP upstream, can be proxied',
      );
    const session = proxySessions.issue({
      tenant: context.tenant,
      user: context.principal.user,
      service,
      env,
    });
    if (!session)
      return problem(429, 'Too Many Requests', 'too many live proxy sessions; retry later');
    context.audit('proxy.session', {
      user: context.principal.user,
      service,
      env,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
    // The controller has no configured public URL, so the origin is the one the caller reached
    // (its Host). Behind a gateway host (platform#58) a configured public origin should win.
    const origin = new URL((call.request as { url: string }).url).origin;
    return Response.json(
      {
        url: `${origin}/v1/services/${service}/proxy/${session.id}`,
        port: 80,
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
      { status: 201 },
    );
  },
};
