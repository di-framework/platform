/**
 * The controller's `/v1` API. Each resource group lives in its own module; this file only wires
 * them into the generated routes. The generated controllers resolve `TenantControllerHandlers`
 * from the global container, so the modules' handlers are installed on that instance, and the
 * per-request context reaches them through async local storage.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { useContainer } from '@di-framework/core/container';
import { problem, TenantControllerHandlers } from '@di-framework/tenant-cli/src/api/handlers.ts';
import { dispatch } from '@di-framework/tenant-cli/src/api/routes.ts';
import { auth } from './auth.ts';
import { config } from './config.ts';
import type { V1Context, V1Handler, V1Module } from './context.ts';
import { deploy } from './deploy.ts';
import { logs } from './logs.ts';
import { services } from './services.ts';

export type { V1Context, V1Handler, V1Module } from './context.ts';

/** Every resource module, by name. Each contract operation belongs to exactly one. */
export const MODULES: Record<string, V1Module> = { auth, config, logs, deploy, services };

const current = new AsyncLocalStorage<V1Context>();
const target = useContainer().resolve(TenantControllerHandlers);
for (const module of Object.values(MODULES))
  for (const name of Object.keys(module) as (keyof V1Module)[])
    target[name] = (command, call) =>
      (module[name] as V1Handler)(command, call, current.getStore() as V1Context);

/** Serves one authenticated `/v1` request; a path that names no operation gets a 404 problem. */
export async function serveV1(request: Request, context: V1Context): Promise<Response> {
  const response = await current.run(context, () => dispatch(request));
  return (
    response ??
    problem(
      404,
      'Not Found',
      `${request.method} ${new URL(request.url).pathname} is not a /v1 operation`,
    )
  );
}
