import {
  type HttpCall,
  type OperationName,
  problem,
} from '@di-framework/tenant-cli/src/api/handlers.ts';
import type { Principal } from '../identity.ts';
import { type KubeClient, KubeError, type UserKube } from '../kube.ts';

/** What a `/v1` handler knows about the request beyond the generated command. */
export interface V1Context {
  tenant: string;
  principal: Principal;
  /** Origin of the tenant's OCI registry, when the platform configured one (platform#83). */
  registryUrl?: string;
  /** Whether a registry is configured, even while it is not served (no `registryUrl`). */
  registryConfigured?: boolean;
  /**
   * The registry workload's `wasi:http` host (platform#83). A deploy never claims it, since the
   * registry front sends registry users' credentials to whatever serves it.
   */
  registryHost?: string;
  /** The API server as the calling user (their `di-user-<user>` ServiceAccount). */
  asUser(): UserKube;
  /**
   * The API server as the tenant controller's own ServiceAccount. Only for Secret reads (#112):
   * developers may write Secrets but never read them, so names, labels and resourceVersions come
   * from here, and no Secret data read this way is ever returned or logged.
   */
  asController(): SecretReader;
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

/** Reads Secret metadata through the controller's own credential. */
export interface SecretReader {
  call<T>(method: 'GET', path: string): Promise<T>;
}

/** Metadata-only media types, so Secret values never reach the controller process (#112). */
export const METADATA_LIST =
  'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json';
export const METADATA_ONE =
  'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1,application/json';

/**
 * Wraps the controller's client for `/v1` Secret reads (#112): it asks for metadata only, and a
 * 401/403 is the controller's own credential failing, not the caller being denied, so it becomes
 * a 502 whose detail stays in the audit.
 */
export function controllerSecretReader(kube: Pick<KubeClient, 'call'>): SecretReader {
  return {
    async call<T>(method: 'GET', path: string): Promise<T> {
      const route = path.split('?')[0] ?? path;
      const accept = route.endsWith('/secrets') ? METADATA_LIST : METADATA_ONE;
      try {
        return await kube.call<T>(method, path, undefined, accept);
      } catch (error) {
        if (error instanceof KubeError && (error.status === 401 || error.status === 403))
          throw new KubeError(
            502,
            `controller error: ${method} ${route} was refused to the tenant controller (${error.status}): ${error.message}`,
          );
        throw error;
      }
    },
  };
}
