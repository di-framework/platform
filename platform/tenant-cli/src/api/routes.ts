/**
 * Server-side mount of the generated `/v1` routes for a plain `Bun.serve` fetch handler, without
 * an HttpRouter container: the generated controllers resolve `TenantControllerHandlers` from the
 * global container on each call, so one router holding every generated route is enough.
 */
import { TypedRouter } from '@di-framework/http';
import auth from './contracts/auth-v1.codegen.ts';
import { secrets, vars } from './contracts/config-v1.codegen.ts';
import deploy from './contracts/deploy-v1.codegen.ts';
import deployments from './contracts/deployments-v1.codegen.ts';
import services from './contracts/services-v1.codegen.ts';
import { routes as authRoutes } from './generated/auth/v1/http.ts';
import { routes as deployRoutes } from './generated/deploy/v1/http.ts';
import { routes as deploymentsRoutes } from './generated/deployments/v1/http.ts';
import { routes as secretsRoutes } from './generated/secrets/v1/http.ts';
import { routes as servicesRoutes } from './generated/services/v1/http.ts';
import { routes as varsRoutes } from './generated/vars/v1/http.ts';
import { problem } from './handlers.ts';
import { coerceQuery, ValidationError, validate } from './validate.ts';

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema: Record<string, unknown>;
}

interface Route {
  operation: string;
  method: string;
  pattern: RegExp;
  query: Parameter[];
}

/** Every operation's method, path pattern and query parameters, read from the manifests. */
export const ROUTES: Route[] = [auth, deploy, deployments, secrets, vars, services].flatMap(
  (manifest) =>
    Object.entries(manifest.operations).map(([operation, { http }]) => {
      const path = `${manifest.http.prefix}${http?.path}`.replace(/:\w+/g, '[^/]+');
      return {
        operation,
        method: http?.method as string,
        pattern: new RegExp(`^${path}$`),
        query: ((http?.parameters ?? []) as unknown as Parameter[]).filter((p) => p.in === 'query'),
      };
    }),
);

/** One router holding every generated route, in manifest order. */
const router = TypedRouter({
  routes: [
    authRoutes,
    deployRoutes,
    deploymentsRoutes,
    secretsRoutes,
    varsRoutes,
    servicesRoutes,
  ].flatMap((set) => set.routes),
});

/** The contract operation a request addresses, or undefined when it names none. */
export function match(method: string, pathname: string): Route | undefined {
  return ROUTES.find((route) => route.method === method && route.pattern.test(pathname));
}

function checkQuery(route: Route, url: URL): void {
  for (const parameter of route.query) {
    const values = url.searchParams.getAll(parameter.name);
    const at = `query.${parameter.name}`;
    if (values.length === 0) {
      if (parameter.required) throw new ValidationError(`${at} is required`);
      continue;
    }
    const raw = values.length === 1 ? (values[0] as string) : values;
    validate(parameter.schema, coerceQuery(parameter.schema, raw, at), at);
  }
}

/**
 * Serves one `/v1` request through the generated routes. Returns undefined when the request
 * names no contract operation, so the caller decides how to answer it. Requests that do not
 * match the contract (query parameters, content type, body) get a 400 or 415 problem before
 * reaching a handler.
 */
export async function dispatch(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  const route = match(request.method, url.pathname);
  if (!route) return undefined;
  try {
    checkQuery(route, url);
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      const type = (request.headers.get('content-type') ?? '').toLowerCase();
      if (!type.includes('application/json') && !type.includes('+json'))
        return problem(415, 'Unsupported Media Type', 'the request body must be application/json');
    }
    return (await router.fetch(request)) as Response;
  } catch (error) {
    if (error instanceof ValidationError) return problem(400, 'Bad Request', error.message);
    throw error;
  }
}
