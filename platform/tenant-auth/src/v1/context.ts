import {
  type HttpCall,
  type OperationName,
  problem,
} from '@di-framework/tenant-cli/src/api/handlers.ts';
import type { Principal } from '../identity.ts';
import type { UserKube } from '../kube.ts';

/** What a `/v1` handler knows about the request beyond the generated command. */
export interface V1Context {
  tenant: string;
  principal: Principal;
  /** The API server as the calling user (their `di-user-<user>` ServiceAccount). */
  asUser(): UserKube;
  audit(event: string, fields?: Record<string, unknown>): void;
}

export type V1Handler = (command: unknown, call: HttpCall, context: V1Context) => Promise<Response>;

/** The handlers one resource module provides, keyed by contract operation. */
export type V1Module = Partial<Record<OperationName, V1Handler>>;

/** A handler that answers 501 until its endpoint lane implements it. */
export const notImplemented =
  (name: OperationName): V1Handler =>
  async () =>
    problem(501, 'Not Implemented', `${name} is not implemented in the pilot yet`);
