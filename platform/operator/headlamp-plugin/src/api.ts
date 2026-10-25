/**
 * The plugin's writes and the kubeconfig read, through Headlamp's API proxy for the current
 * cluster. Every call carries the viewer's own credentials, so Kubernetes RBAC applies.
 */

import { post, request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import type { SecretLike } from './kubeconfig';
import { secretPath } from './kubeconfig';
import { collectionPath, type JsonPatchOp, objectPath } from './mapping';
import type { PlatformInstanceObject } from './types';

/** What the form asks to send: a new object, or a JSON Patch against an existing one. */
export type Submission =
  | { mode: 'create'; object: PlatformInstanceObject }
  | { mode: 'edit'; namespace: string; name: string; patch: JsonPatchOp[] };

/** Shown when the object changed after the edit dialog opened. */
export const CONFLICT_MESSAGE =
  'This PlatformInstance changed after you opened the form, so nothing was saved. ' +
  'Close the dialog and open Edit spec again to see the current values.';

/**
 * A failed `test` operation (the apiserver answers 422 "testing value ... failed") or a 409: the
 * object is no longer the one the form was opened on.
 */
export function isConflict(err: unknown): boolean {
  const { status, message } = (err ?? {}) as { status?: number; message?: unknown };
  return (
    status === 409 ||
    (status === 422 &&
      /testing value|test failed/i.test(typeof message === 'string' ? message : ''))
  );
}

/** POST the object exactly as built: the same body `kubectl create -f` sends for the manifest. */
export function createInstance(obj: PlatformInstanceObject): Promise<unknown> {
  return post(collectionPath(obj.metadata.namespace ?? ''), obj, false);
}

/**
 * Send the edit as `application/json-patch+json`. Its `test` operations make a concurrent change
 * fail; that failure is rethrown with {@link CONFLICT_MESSAGE}. (The plugin library's ApiProxy has
 * only a merge-patch `patch` helper, so this goes through its `request` helper.)
 */
export async function patchInstance(
  namespace: string,
  name: string,
  patch: JsonPatchOp[],
): Promise<unknown> {
  try {
    return await request(
      objectPath(namespace, name),
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
        headers: { 'Content-Type': 'application/json-patch+json' },
      },
      false,
    );
  } catch (err) {
    if (isConflict(err)) {
      throw Object.assign(new Error(CONFLICT_MESSAGE), { status: 409, cause: err });
    }
    throw err;
  }
}

export function submitInstance(submission: Submission): Promise<unknown> {
  return submission.mode === 'create'
    ? createInstance(submission.object)
    : patchInstance(submission.namespace, submission.name, submission.patch);
}

/** Reads the kubeconfig Secret, bypassing any HTTP cache; a 403 rejects with `status: 403`. */
export function fetchSecret(namespace: string, name: string): Promise<SecretLike> {
  return request(secretPath(namespace, name), { cache: 'no-store' }, false);
}
