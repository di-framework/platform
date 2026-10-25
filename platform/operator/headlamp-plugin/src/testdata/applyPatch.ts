/**
 * Test helper: applies an RFC 6902 JSON Patch the way the apiserver does: all or nothing. A failed
 * `test`, a `replace`/`remove` of a missing member or an `add` under a missing parent rejects the
 * whole patch with the error Headlamp's API proxy raises for the apiserver's answer.
 *
 * The apiserver (`k8s.io/apiserver` `pkg/endpoints/handlers/patch.go`) reports any JSON Patch that
 * doesn't apply with `errors.NewGenericServerResponse(422, …)`, whose message is the fixed text
 * below: the json-patch error is dropped. Headlamp prefixes the status text. The json-patch text is
 * kept on `detail`, for tests to tell which op failed; the plugin never sees it.
 */

import type { JsonPatchOp } from '../mapping';

type Tree = Record<string, unknown>;

/** The apiserver's message for a 422 from NewGenericServerResponse. */
export const PATCH_REJECTED = 'the server rejected our request due to an error in our request';

export class PatchError extends Error {
  readonly status = 422;

  constructor(readonly detail: string) {
    super(`Unprocessable Entity - ${PATCH_REJECTED}`);
  }
}

/** The error Headlamp raises for a 422 from CRD schema or CEL validation of the patched object. */
export function invalidError(name: string, causes: string): Error & { status: number } {
  return Object.assign(
    new Error(
      `Unprocessable Entity - PlatformInstance.platform.di-framework.dev "${name}" is invalid: ${causes}`,
    ),
    { status: 422 },
  );
}

function parse(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((k) => k.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** The object holding the last key of `keys`, or a PatchError when the path doesn't exist. */
function parentOf(root: Tree, keys: string[], path: string): Tree {
  let parent: unknown = root;
  for (const k of keys) {
    parent = (parent as Tree | undefined)?.[k];
  }
  if (parent === null || typeof parent !== 'object') {
    throw new PatchError(`doc is missing path: ${path}`);
  }
  return parent as Tree;
}

function mustExist(node: Tree, leaf: string, op: JsonPatchOp): void {
  if (!(leaf in node)) {
    throw new PatchError(`${op.op} operation does not apply: doc is missing key: ${op.path}`);
  }
}

function applyOp(root: Tree, op: JsonPatchOp): void {
  const keys = parse(op.path);
  const leaf = keys.pop() as string;
  const node = parentOf(root, keys, op.path);
  if (op.op === 'remove') {
    mustExist(node, leaf, op);
    delete node[leaf];
    return;
  }
  if (op.op === 'test') {
    if (JSON.stringify(node[leaf]) !== JSON.stringify(op.value)) {
      throw new PatchError(`testing value ${op.path} failed: test failed`);
    }
    return;
  }
  if (op.op === 'replace') {
    mustExist(node, leaf, op);
  }
  node[leaf] = structuredClone(op.value);
}

export function applyPatch<T>(doc: T, patch: JsonPatchOp[]): T {
  const out = structuredClone(doc) as unknown as Tree;
  for (const op of patch) {
    applyOp(out, op);
  }
  return out as unknown as T;
}
