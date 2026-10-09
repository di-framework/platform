import { type HttpCall, problem } from '@di-framework/tenant-cli/src/api/handlers.ts';
// Intentional cross-package import (platform#53): the managed-name predicate must stay the one
// the admission policy enforces, so it is shared from the platform package, not copied.
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

/** A DNS label that starts with a letter, so its environment variable name is valid too. */
const SECRET_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
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

/** Runs a write; a 409 (stale resourceVersion, or a create that raced) becomes a retry problem. */
async function guarded(write: () => Promise<unknown>, what: string) {
  try {
    await write();
  } catch (error) {
    if (error instanceof KubeError && error.status === 409)
      throw new KubeError(409, `${what} changed concurrently; retry`);
    throw error;
  }
}

/** Replaces an object read earlier, or creates it when none existed. */
function write(
  kube: UserKube,
  path: string,
  collection: string,
  object: unknown,
  existed: boolean,
  what: string,
) {
  return guarded(
    () => (existed ? kube.call('PUT', path, object) : kube.call('POST', collection, object)),
    what,
  );
}

/** Deletes an object only if it is still the version read earlier. */
function remove(kube: UserKube, path: string, resourceVersion: string | undefined, what: string) {
  return guarded(
    () =>
      kube.call('DELETE', path, {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        ...(resourceVersion ? { preconditions: { resourceVersion } } : {}),
      }),
    what,
  );
}

const conflict = (detail: string) => problem(409, 'Conflict', detail);

const noContent = () => new Response(null, { status: 204 });

// ---- secrets ---------------------------------------------------------------------------------

/** Refuses names that are not DNS labels or that the platform manages; undefined when fine. */
function refuseSecretName(name: string): Response | undefined {
  if (!SECRET_NAME.test(name))
    return problem(
      400,
      'Bad Request',
      `secret name ${JSON.stringify(name)} must be a DNS label starting with a letter`,
    );
  if (isManagedSecretName(name))
    return problem(403, 'Forbidden', `${name} is a platform-managed secret name`);
  return undefined;
}

const varsPath = (context: V1Context, env: string) =>
  `${namespace(context)}/configmaps/${varsConfigMapName(env)}`;

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
  const envName = secretEnvName(name);
  const map = await find(kube, varsPath(context, env));
  if (map?.data && Object.hasOwn(map.data, envName))
    return conflict(`var ${envName} already exists in ${env}; a secret and a var cannot share it`);
  const object = secretObject(name, env, valueIn(command), existing?.metadata.resourceVersion);
  await write(
    kube,
    secretPath(context, name, env),
    `${namespace(context)}/secrets`,
    object,
    existing !== undefined,
    `secret ${name}`,
  );
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
      name: metadata.labels?.[SECRET] ?? metadata.name.replace(new RegExp(`\\.${env}$`), ''),
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
  await remove(
    context.asUser(),
    secretPath(context, name, env),
    existing?.metadata.resourceVersion,
    `secret ${name}`,
  );
  context.audit('secret.unset', { user: context.principal.user, name, env });
  return noContent();
};

// ---- vars ------------------------------------------------------------------------------------

function timestamps(map: Stored | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(map?.metadata.annotations?.[UPDATED_AT] ?? '{}');
    return Object.assign(Object.create(null), parsed) as Record<string, string>;
  } catch {
    return Object.create(null) as Record<string, string>;
  }
}

/**
 * `__proto__` is refused: object spreads and many JSON consumers treat it as the prototype, not a
 * key. Other `Object.prototype` names (`constructor`, `toString`, ...) are ordinary vars, safe
 * because var data is prototype-free and membership uses `Object.hasOwn`.
 */
const RESERVED_VAR_NAMES = new Set(['__proto__']);

function refuseVarName(name: string): Response | undefined {
  if (RESERVED_VAR_NAMES.has(name))
    return problem(400, 'Bad Request', `var name ${JSON.stringify(name)} is reserved`);
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
  precheck?: (context: V1Context, name: string, env: string) => Promise<Response | undefined>,
): Promise<Response> {
  const name = nameOf(call);
  const env = envOf(call);
  const refused = refuseVarName(name);
  if (refused) return refused;
  const blocked = await precheck?.(context, name, env);
  if (blocked) return blocked;
  const kube = context.asUser();
  const path = varsPath(context, env);
  const existing = await find(kube, path);
  if (!existing && !createIfMissing)
    return problem(404, 'Not Found', `var ${name} does not exist in ${env}`);
  if (existing && existing.metadata.labels?.[CONFIG] !== 'vars')
    return conflict(`${varsConfigMapName(env)} is not a tenant vars ConfigMap`);
  // Prototype-free, so a name like `toString` is only ever an own key.
  const data: Record<string, string> = Object.assign(Object.create(null), existing?.data);
  const failed = change(data, name);
  if (failed) return failed;
  const times = timestamps(existing);
  if (Object.hasOwn(data, name)) times[name] = now();
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
  await write(
    kube,
    path,
    `${namespace(context)}/configmaps`,
    object,
    existing !== undefined,
    `the ${env} vars`,
  );
  context.audit(event, { user: context.principal.user, name, env });
  return noContent();
}

/** A 409 when a tenant secret in `env` is already injected under the var's name. */
async function secretSharing(context: V1Context, name: string, env: string) {
  const secret = name.toLowerCase().replaceAll('_', '-');
  if (secretEnvName(secret) !== name || !SECRET_NAME.test(secret)) return undefined;
  const found = await find(context.asUser(), secretPath(context, secret, env));
  if (found?.metadata.labels?.[CONFIG] !== 'secret') return undefined;
  return conflict(
    `secret ${secret} is injected as ${name} in ${env}; a secret and a var cannot share it`,
  );
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
      // Only set can introduce a new name; update and unset act on an existing var, which
      // already passed this check when it was set, so they need no secret-sharing check.
      secretSharing,
    ),
  updateVar: (command, call, context) =>
    changeVars(
      call,
      context,
      'var.updated',
      (data, name) => {
        if (!Object.hasOwn(data, name)) return missingVar(name, call);
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
        if (!Object.hasOwn(data, name)) return missingVar(name, call);
        delete data[name];
        return undefined;
      },
      false,
    ),
};
