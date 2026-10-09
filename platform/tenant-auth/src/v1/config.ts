import { type HttpCall, problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { isManagedSecretName } from '../../../platform/src/tenancy/admission.ts';
import { KubeError, type UserKube } from '../kube.ts';
import type { V1Context, V1Handler, V1Module } from './context.ts';

/**
 * `/v1/secrets` and `/v1/vars` (platform#53). The storage layout is the contract the deploy lane
 * injects from; it is documented in the README under "Secrets and vars storage contract".
 */

const LABEL = 'platform.di-framework.dev';
const CONFIG = `${LABEL}/config`;
const ENV = `${LABEL}/env`;
const SECRET = `${LABEL}/secret`;
const UPDATED_AT = `${LABEL}/updated-at`;

const SECRET_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,252}$/;

interface Metadata {
  name: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
interface Stored {
  metadata: Metadata;
  data?: Record<string, string>;
}

/** The ConfigMap holding one environment's vars. */
export const varsConfigMapName = (env: string) => `di-vars-${env}`;
/** The Secret holding one tenant secret in one environment. */
export const secretObjectName = (name: string, env: string) => `${name}.${env}`;
/** The environment variable a secret is injected as. */
export const secretEnvName = (name: string) => name.toUpperCase().replaceAll('-', '_');

const namespace = (context: V1Context) => `/api/v1/namespaces/di-tenant-${context.tenant}`;
const envOf = (call: HttpCall) => String(call.request.query?.env);
const nameOf = (call: HttpCall) => call.request.params?.name ?? '';
const valueIn = (command: unknown) => (command as { value: string }).value;
const now = () => new Date().toISOString();

async function find(kube: UserKube, path: string): Promise<Stored | undefined> {
  try {
    return await kube.call<Stored>('GET', path);
  } catch (error) {
    if (error instanceof KubeError && error.status === 404) return undefined;
    throw error;
  }
}

/** Replaces an object read earlier; a concurrent write surfaces as a 409 the caller can retry. */
async function replace(kube: UserKube, path: string, object: Stored, what: string) {
  try {
    await kube.call('PUT', path, object);
  } catch (error) {
    if (error instanceof KubeError && error.status === 409)
      throw new KubeError(409, `${what} changed concurrently; retry`);
    throw error;
  }
}

const noContent = () => new Response(null, { status: 204 });

// ---- secrets ---------------------------------------------------------------------------------

/** Refuses names that are not DNS labels or that the platform manages; undefined when fine. */
function refuseSecretName(name: string): Response | undefined {
  if (!SECRET_NAME.test(name))
    return problem(400, 'Bad Request', `secret name ${JSON.stringify(name)} must be a DNS label`);
  if (isManagedSecretName(name))
    return problem(403, 'Forbidden', `${name} is a platform-managed secret name`);
  return undefined;
}

const secretPath = (context: V1Context, name: string, env: string) =>
  `${namespace(context)}/secrets/${secretObjectName(name, env)}`;

/** The labelled Secret, or a 404/409 problem when it is missing or not a tenant secret. */
async function existingSecret(
  context: V1Context,
  name: string,
  env: string,
  missingIsError: boolean,
): Promise<Stored | Response | undefined> {
  const found = await find(context.asUser(), secretPath(context, name, env));
  if (!found)
    return missingIsError
      ? problem(404, 'Not Found', `secret ${name} does not exist in ${env}`)
      : undefined;
  if (found.metadata.labels?.[CONFIG] !== 'secret')
    return problem(409, 'Conflict', `${secretObjectName(name, env)} is not a tenant secret`);
  return found;
}

function secretObject(name: string, env: string, value: string, resourceVersion?: string) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: secretObjectName(name, env),
      ...(resourceVersion ? { resourceVersion } : {}),
      labels: { [CONFIG]: 'secret', [ENV]: env, [SECRET]: name },
      annotations: { [UPDATED_AT]: now() },
    },
    stringData: { [secretEnvName(name)]: value },
  };
}

async function writeSecret(
  command: unknown,
  call: HttpCall,
  context: V1Context,
  mustExist: boolean,
): Promise<Response> {
  const name = nameOf(call);
  const env = envOf(call);
  const refused = refuseSecretName(name);
  if (refused) return refused;
  const existing = await existingSecret(context, name, env, mustExist);
  if (existing instanceof Response) return existing;
  const kube = context.asUser();
  const object = secretObject(name, env, valueIn(command), existing?.metadata.resourceVersion);
  if (existing)
    await replace(kube, secretPath(context, name, env), object as never, `secret ${name}`);
  else await kube.call('POST', `${namespace(context)}/secrets`, object);
  context.audit(mustExist ? 'secret.updated' : 'secret.set', {
    user: context.principal.user,
    name,
    env,
  });
  return noContent();
}

const secrets: V1Handler = async (_command, call, context) => {
  const env = envOf(call);
  const selector = encodeURIComponent(`${CONFIG}=secret,${ENV}=${env}`);
  const list = await context
    .asUser()
    .call<{ items: Stored[] }>('GET', `${namespace(context)}/secrets?labelSelector=${selector}`);
  const items = list.items
    .map(({ metadata }) => ({
      name: metadata.labels?.[SECRET] ?? metadata.name,
      updatedAt: metadata.annotations?.[UPDATED_AT] ?? metadata.creationTimestamp ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return Response.json({ env, items });
};

const unsetSecret: V1Handler = async (_command, call, context) => {
  const name = nameOf(call);
  const env = envOf(call);
  const refused = refuseSecretName(name);
  if (refused) return refused;
  const existing = await existingSecret(context, name, env, true);
  if (existing instanceof Response) return existing;
  await context.asUser().call('DELETE', secretPath(context, name, env));
  context.audit('secret.unset', { user: context.principal.user, name, env });
  return noContent();
};

// ---- vars ------------------------------------------------------------------------------------

const varsPath = (context: V1Context, env: string) =>
  `${namespace(context)}/configmaps/${varsConfigMapName(env)}`;

function timestamps(map: Stored | undefined): Record<string, string> {
  try {
    return JSON.parse(map?.metadata.annotations?.[UPDATED_AT] ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function refuseVarName(name: string): Response | undefined {
  if (VAR_NAME.test(name)) return undefined;
  return problem(
    400,
    'Bad Request',
    `var name ${JSON.stringify(name)} must be an environment variable name`,
  );
}

type VarChange = (data: Record<string, string>, name: string) => Response | undefined;

/** Read-modify-write of the environment's vars ConfigMap. */
async function changeVars(
  call: HttpCall,
  context: V1Context,
  event: string,
  change: VarChange,
  createIfMissing: boolean,
): Promise<Response> {
  const name = nameOf(call);
  const env = envOf(call);
  const refused = refuseVarName(name);
  if (refused) return refused;
  const kube = context.asUser();
  const path = varsPath(context, env);
  const existing = await find(kube, path);
  if (!existing && !createIfMissing)
    return problem(404, 'Not Found', `var ${name} does not exist in ${env}`);
  const data = { ...existing?.data };
  const failed = change(data, name);
  if (failed) return failed;
  const times = timestamps(existing);
  if (name in data) times[name] = now();
  else delete times[name];
  const object = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      ...existing?.metadata,
      name: varsConfigMapName(env),
      labels: { ...existing?.metadata.labels, [CONFIG]: 'vars', [ENV]: env },
      annotations: { ...existing?.metadata.annotations, [UPDATED_AT]: JSON.stringify(times) },
    },
    data,
  };
  if (existing) await replace(kube, path, object, `the ${env} vars`);
  else await kube.call('POST', `${namespace(context)}/configmaps`, object);
  context.audit(event, { user: context.principal.user, name, env });
  return noContent();
}

const missingVar = (name: string, call: HttpCall) =>
  problem(404, 'Not Found', `var ${name} does not exist in ${envOf(call)}`);

const vars: V1Handler = async (_command, call, context) => {
  const env = envOf(call);
  const map = await find(context.asUser(), varsPath(context, env));
  const times = timestamps(map);
  const fallback = map?.metadata.creationTimestamp ?? '';
  const items = Object.entries(map?.data ?? {})
    .map(([name, value]) => ({ name, value, updatedAt: times[name] ?? fallback }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return Response.json({ env, items });
};

export const config: V1Module = {
  secrets,
  setSecret: (command, call, context) => writeSecret(command, call, context, false),
  updateSecret: (command, call, context) => writeSecret(command, call, context, true),
  unsetSecret,
  vars,
  setVar: (command, call, context) =>
    changeVars(
      call,
      context,
      'var.set',
      (data, name) => {
        data[name] = valueIn(command);
        return undefined;
      },
      true,
    ),
  updateVar: (command, call, context) =>
    changeVars(
      call,
      context,
      'var.updated',
      (data, name) => {
        if (!(name in data)) return missingVar(name, call);
        data[name] = valueIn(command);
        return undefined;
      },
      false,
    ),
  unsetVar: (_command, call, context) =>
    changeVars(
      call,
      context,
      'var.unset',
      (data, name) => {
        if (!(name in data)) return missingVar(name, call);
        delete data[name];
        return undefined;
      },
      false,
    ),
};
