import { Container } from '@di-framework/core/decorators';

/** The request shape the generated controllers hand to a handler. */
export interface HttpCall {
  transport: 'http';
  request: {
    headers?: { get(name: string): string | null };
    content?: unknown;
    params?: Record<string, string | undefined>;
    query?: Record<string, string | string[] | undefined>;
  };
}

/** Every operation of the `/v1` contract, in manifest order. */
export const OPERATIONS = [
  'authInfo',
  'whoami',
  'logout',
  'previewDeploy',
  'deploy',
  'createService',
  'logs',
  'proxy',
  'deployments',
  'deploymentStats',
  'rollback',
  'secrets',
  'setSecret',
  'updateSecret',
  'unsetSecret',
  'vars',
  'setVar',
  'updateVar',
  'unsetVar',
] as const;

export type OperationName = (typeof OPERATIONS)[number];
type Handler = (command: unknown, call: HttpCall) => Promise<Response>;

/** RFC 9457 problem response, the error shape the contract promises. */
export function problem(status: number, title: string, detail?: string): Response {
  return Response.json(
    { type: 'about:blank', title, status, ...(detail ? { detail } : {}) },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/**
 * The contract's server side, with no behaviour yet: every operation answers 501 so the
 * generated routes, the OpenAPI document, and the client can be built and tested against the
 * real surface. The tenant controller replaces these one by one.
 */
@Container()
export class TenantControllerHandlers {
  constructor() {
    for (const name of OPERATIONS) this[name] = (_command, _call) => this.notImplemented(name);
  }

  declare authInfo: Handler;
  declare whoami: Handler;
  declare logout: Handler;
  declare previewDeploy: Handler;
  declare deploy: Handler;
  declare createService: Handler;
  declare logs: Handler;
  declare proxy: Handler;
  declare deployments: Handler;
  declare deploymentStats: Handler;
  declare rollback: Handler;
  declare secrets: Handler;
  declare setSecret: Handler;
  declare updateSecret: Handler;
  declare unsetSecret: Handler;
  declare vars: Handler;
  declare setVar: Handler;
  declare updateVar: Handler;
  declare unsetVar: Handler;

  private async notImplemented(name: OperationName): Promise<Response> {
    return problem(501, 'Not Implemented', `${name} is not implemented in the pilot yet`);
  }
}
