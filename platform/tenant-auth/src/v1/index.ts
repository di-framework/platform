/**
 * The controller's `/v1` API. Each resource group lives in its own module; this file only wires
 * them into the generated routes. The generated controllers resolve `TenantControllerHandlers`
 * from the global container, so the modules' handlers are installed on that instance, and the
 * per-request context reaches them through async local storage.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { problem, TenantControllerHandlers } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { dispatch, useContainer } from '@di-framework/tenant-cli/src/api/routes.ts';
import { AuthError } from '../identity.ts';
import { KubeError } from '../kube.ts';
import { auth } from './auth.ts';
import { config } from './config.ts';
import type { V1Context, V1Handler, V1Module } from './context.ts';
import { deploy } from './deploy.ts';
import { logs } from './logs.ts';
import { permits } from './policy.ts';
import { services } from './services.ts';

export type { V1Context, V1Handler, V1Module } from './context.ts';

/** Every resource module, by name. Each contract operation belongs to exactly one. */
export const MODULES: Record<string, V1Module> = { auth, config, logs, deploy, services };

const current = new AsyncLocalStorage<V1Context>();
const target = useContainer().resolve(TenantControllerHandlers);
for (const module of Object.values(MODULES))
  for (const name of Object.keys(module) as (keyof V1Module)[]) {
    // Outside `serveV1` (for example tenant-cli's own tests, which share this module registry)
    // there is no context, so the contract's original handler answers instead.
    const fallback = target[name].bind(target);
    target[name] = (command, call) => {
      const context = current.getStore();
      if (!context) return fallback(command, call);
      // The role policy runs after validation and before the resource module.
      const { user, role } = context.principal;
      if (!permits(name, role)) {
        context.audit('request.denied', { user, operation: name, role, status: 403 });
        return Promise.resolve(problem(403, 'Forbidden', `a ${role} may not call ${name}`));
      }
      return (module[name] as V1Handler)(command, call, context);
    };
  }

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
};

/** Maps an error a handler raised (API server, `asUser`, identity) to a problem response. */
function failure(error: unknown): Response {
  if (!(error instanceof KubeError || error instanceof AuthError)) throw error;
  if (error.status >= 400 && error.status < 500)
    return problem(error.status, TITLES[error.status] ?? 'Client Error', error.message);
  return problem(502, 'Bad Gateway', error.message);
}

/** Serves one authenticated `/v1` request; a path that names no operation gets a 404 problem. */
export async function serveV1(request: Request, context: V1Context): Promise<Response> {
  let response: Response | undefined;
  try {
    response = await current.run(context, () => dispatch(request));
  } catch (error) {
    return failure(error);
  }
  return (
    response ??
    problem(
      404,
      'Not Found',
      `${request.method} ${new URL(request.url).pathname} is not a /v1 operation`,
    )
  );
}
