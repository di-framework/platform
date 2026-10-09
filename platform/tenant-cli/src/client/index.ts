import type { components, operations, paths } from './schema';
import { events } from './sse.ts';

export { events, type SseEvent } from './sse.ts';

type Json<
  Op extends keyof operations,
  Status extends number,
> = operations[Op]['responses'] extends {
  [S in Status]: { content: { 'application/json': infer T } };
}
  ? T
  : never;
type Body<Op extends keyof operations> = operations[Op] extends {
  requestBody: { content: { 'application/json': infer T } };
}
  ? T
  : never;
type Query<Op extends keyof operations> = operations[Op]['parameters'] extends {
  query: infer Q;
}
  ? Q
  : never;

export type Env = Query<'deployments'>['env'];
export type AuthInfo = components['schemas']['AuthInfo'];
export type Principal = components['schemas']['Principal'];
export type DeployBundle = Body<'deploy'>;
export type DeployPlan = Json<'previewDeploy', 200>;
export type Deployment = Json<'deploy', 202>;
export type DeploymentList = Json<'deployments', 200>;
export type DeploymentStats = Json<'deploymentStats', 200>;
export type RollbackRequest = Body<'rollback'>;
export type CreateServiceRequest = Body<'createService'>;
export type Service = Json<'createService', 201>;
export type LogEvent = Json<'logs', 200>;
export type LogsQuery = Query<'logs'>;
export type SecretList = Json<'secrets', 200>;
export type ConfigList = Json<'vars', 200>;
export type ProxyRequest = Body<'proxy'>;
export type ProxySession = Json<'proxy', 201>;
export type Problem = components['schemas']['Problem'];

/**
 * Every path the client calls, checked against the generated `paths` at compile time: an
 * operation that leaves the contract stops the client from building.
 */
const PATHS = {
  authInfo: '/v1/auth/info',
  whoami: '/v1/auth/whoami',
  logout: '/v1/auth/logout',
  previewDeploy: '/v1/deploy/preview',
  deploy: '/v1/deploy',
  createService: '/v1/services',
  logs: '/v1/services/{service}/logs',
  proxy: '/v1/services/{service}/proxy',
  deployments: '/v1/deployments',
  deploymentStats: '/v1/deployments/stats',
  rollback: '/v1/deployments/rollback',
  secrets: '/v1/secrets',
  secret: '/v1/secrets/{name}',
  vars: '/v1/vars',
  var: '/v1/vars/{name}',
} as const satisfies Record<string, keyof paths>;

/** A non-2xx answer from the controller, carrying its problem details when it sent any. */
export class ControllerError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<Problem>,
  ) {
    super(problem.detail ?? problem.title ?? `controller answered ${status}`);
    this.name = 'ControllerError';
  }
}

export interface ClientOptions {
  /** The controller's base URL, without a trailing slash. */
  baseUrl: string;
  /** Identity-server access token or tenant API key; absent only for `authInfo`. */
  token?: string;
  fetch?: typeof fetch;
}

type QueryValues = Record<string, string | number | boolean | undefined>;

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  params?: Record<string, string>;
  query?: QueryValues;
  body?: unknown;
  accept?: string;
}

export function createClient(options: ClientOptions) {
  const base = options.baseUrl.replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;

  const url = (call: Call): string => {
    const path = call.path.replace(/\{(\w+)\}/g, (_, key: string) =>
      encodeURIComponent(call.params?.[key] ?? ''),
    );
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const qs = search.toString();
    return `${base}${path}${qs ? `?${qs}` : ''}`;
  };

  const send = async (call: Call): Promise<Response> => {
    const headers = new Headers({ accept: call.accept ?? 'application/json' });
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    if (call.body !== undefined) headers.set('content-type', 'application/json');
    const response = await doFetch(url(call), {
      method: call.method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });
    if (response.ok) return response;
    let problem: Partial<Problem> = {};
    try {
      problem = (await response.json()) as Partial<Problem>;
    } catch {
      // Not a problem document; the status alone carries the error.
    }
    throw new ControllerError(response.status, problem);
  };

  const json = async <T>(call: Call): Promise<T> => (await send(call)).json() as Promise<T>;
  const empty = async (call: Call): Promise<void> => {
    await send(call);
  };

  return {
    authInfo: () => json<AuthInfo>({ method: 'GET', path: PATHS.authInfo }),
    whoami: () => json<Principal>({ method: 'GET', path: PATHS.whoami }),
    logout: () => empty({ method: 'POST', path: PATHS.logout }),

    previewDeploy: (bundle: DeployBundle) =>
      json<DeployPlan>({ method: 'POST', path: PATHS.previewDeploy, body: bundle }),
    deploy: (bundle: DeployBundle) =>
      json<Deployment>({ method: 'POST', path: PATHS.deploy, body: bundle }),

    createService: (request: CreateServiceRequest) =>
      json<Service>({ method: 'POST', path: PATHS.createService, body: request }),
    proxy: (service: string, request: ProxyRequest) =>
      json<ProxySession>({ method: 'POST', path: PATHS.proxy, params: { service }, body: request }),

    /** Yields one LogEvent per `log` event until the server sends `end` or the stream closes. */
    async *logs(service: string, query: LogsQuery): AsyncGenerator<LogEvent> {
      const response = await send({
        method: 'GET',
        path: PATHS.logs,
        params: { service },
        query,
        accept: 'text/event-stream',
      });
      if (!response.body) return;
      for await (const event of events(response.body)) {
        if (event.event === 'end') return;
        if (event.event === undefined || event.event === 'log') {
          yield JSON.parse(event.data) as LogEvent;
        }
      }
    },

    deployments: (query: Query<'deployments'>) =>
      json<DeploymentList>({ method: 'GET', path: PATHS.deployments, query }),
    deploymentStats: (env: Env) =>
      json<DeploymentStats>({ method: 'GET', path: PATHS.deploymentStats, query: { env } }),
    rollback: (request: RollbackRequest) =>
      json<Deployment>({ method: 'POST', path: PATHS.rollback, body: request }),

    secrets: (env: Env) => json<SecretList>({ method: 'GET', path: PATHS.secrets, query: { env } }),
    setSecret: (env: Env, name: string, value: string) =>
      empty({
        method: 'PUT',
        path: PATHS.secret,
        params: { name },
        query: { env },
        body: { value },
      }),
    updateSecret: (env: Env, name: string, value: string) =>
      empty({
        method: 'PATCH',
        path: PATHS.secret,
        params: { name },
        query: { env },
        body: { value },
      }),
    unsetSecret: (env: Env, name: string) =>
      empty({ method: 'DELETE', path: PATHS.secret, params: { name }, query: { env } }),

    vars: (env: Env) => json<ConfigList>({ method: 'GET', path: PATHS.vars, query: { env } }),
    setVar: (env: Env, name: string, value: string) =>
      empty({ method: 'PUT', path: PATHS.var, params: { name }, query: { env }, body: { value } }),
    updateVar: (env: Env, name: string, value: string) =>
      empty({
        method: 'PATCH',
        path: PATHS.var,
        params: { name },
        query: { env },
        body: { value },
      }),
    unsetVar: (env: Env, name: string) =>
      empty({ method: 'DELETE', path: PATHS.var, params: { name }, query: { env } }),
  };
}

export type TenantClient = ReturnType<typeof createClient>;
