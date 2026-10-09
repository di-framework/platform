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

/**
 * The container the generated controllers resolve their handlers from. Hosts that install
 * handlers (the tenant controller) must use this copy, not their own `@di-framework/core`.
 */
export { useContainer } from '@di-framework/core/container';

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
  input: Record<string, unknown>;
}

/** Largest request body `/v1` accepts; deploy bundles and config values are small. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Every operation's method, path pattern and query parameters, read from the manifests. */
export const ROUTES: Route[] = [auth, deploy, deployments, secrets, vars, services].flatMap(
  (manifest) =>
    Object.entries(manifest.operations).map(([operation, { http, input }]) => {
      const path = `${manifest.http.prefix}${http?.path}`.replace(/:\w+/g, '[^/]+');
      return {
        operation,
        method: http?.method as string,
        pattern: new RegExp(`^${path}$`),
        input: (
          manifest.schemas as Record<string, { schema: { jsonSchema: Record<string, unknown> } }>
        )[input]?.schema.jsonSchema as Record<string, unknown>,
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
 * Reads the body as text, counting bytes as they stream in, and stops at the cap so a body
 * without a Content-Length cannot be buffered whole. Undefined when the body is too large.
 */
async function readCapped(request: Request): Promise<string | undefined> {
  const stream = request.clone().body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Parses the request body (an absent one reads as `{}`) and checks it against the input schema. */
function checkBody(route: Route, text: string): void {
  let body: unknown = {};
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ValidationError('the request body is not valid JSON');
    }
  }
  validate(route.input, body);
}

/**
 * Serves one `/v1` request through the generated routes. Returns undefined when the request
 * names no contract operation, so the caller decides how to answer it. Requests that do not
 * match the contract (query parameters, content type, size, body) get a 400, 413 or 415 problem
 * before reaching a handler. A handler result that breaks the response contract gets a 500.
 */
export async function dispatch(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  const route = match(request.method, url.pathname);
  if (!route) return undefined;
  let forward = request;
  try {
    checkQuery(route, url);
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES)
      return problem(413, 'Content Too Large', `the request body exceeds ${MAX_BODY_BYTES} bytes`);
    const text = await readCapped(request);
    if (text === undefined)
      return problem(413, 'Content Too Large', `the request body exceeds ${MAX_BODY_BYTES} bytes`);
    if (text !== '') {
      // 415 means a body was sent in a format the contract does not accept (RFC 9110 15.5.16).
      const type = (request.headers.get('content-type') ?? '').toLowerCase();
      if (!type.includes('application/json') && !type.includes('+json'))
        return problem(415, 'Unsupported Media Type', 'the request body must be application/json');
    }
    checkBody(route, text);
    if (text === '' && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
      // A bodiless request passed the schema (its input is Empty); hand the generated route an
      // explicit `{}` so the router's JSON content-type check lets it through.
      const headers = new Headers(request.headers);
      headers.set('content-type', 'application/json');
      headers.delete('content-length');
      forward = new Request(request.url, { method: request.method, headers, body: '{}' });
    }
  } catch (error) {
    if (error instanceof ValidationError) return problem(400, 'Bad Request', error.message);
    throw error;
  }
  try {
    return (await router.fetch(forward)) as Response;
  } catch (error) {
    // The request was already checked, so a validation failure here is a handler result that
    // breaks the response contract: a server bug, not the client's.
    if (error instanceof ValidationError) return problem(500, 'Internal Server Error');
    throw error;
  }
}
