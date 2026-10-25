/**
 * The plugin's writes and the kubeconfig read, through Headlamp's API proxy for the current
 * cluster. Every call carries the viewer's own credentials, so Kubernetes RBAC applies.
 */

import { post, put, request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import type { SecretLike } from './kubeconfig';
import { secretPath } from './kubeconfig';
import { collectionPath, objectPath } from './mapping';
import type { PlatformInstanceObject } from './types';

/** POST the object exactly as built: the same body `kubectl create -f` sends for the manifest. */
export function createInstance(obj: PlatformInstanceObject): Promise<unknown> {
  return post(collectionPath(obj.metadata.namespace ?? ''), obj, false);
}

/** PUT the edited object (it carries metadata.resourceVersion, so a concurrent edit fails 409). */
export function updateInstance(obj: PlatformInstanceObject): Promise<unknown> {
  return put(
    objectPath(obj.metadata.namespace ?? '', obj.metadata.name),
    obj as unknown as Parameters<typeof put>[1],
    false,
  );
}

/** Reads the kubeconfig Secret, bypassing any HTTP cache; a 403 rejects with `status: 403`. */
export function fetchSecret(namespace: string, name: string): Promise<SecretLike> {
  return request(secretPath(namespace, name), { cache: 'no-store' }, false);
}
