/**
 * Test helper: applies an RFC 6902 JSON Patch the way the apiserver does (all or nothing; a failed
 * `test`, a `replace`/`remove` of a missing member or an `add` under a missing parent rejects the
 * whole patch with the apiserver's 422 message).
 */

import type { JsonPatchOp } from '../mapping';

type Tree = Record<string, unknown>;

export class PatchError extends Error {
  status = 422;
}

function parse(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function applyPatch<T>(doc: T, patch: JsonPatchOp[]): T {
  const out = structuredClone(doc) as unknown as Tree;
  for (const op of patch) {
    const keys = parse(op.path);
    const leaf = keys.pop() as string;
    let parent: unknown = out;
    for (const k of keys) {
      parent = (parent as Tree | undefined)?.[k];
    }
    if (parent === null || typeof parent !== 'object') {
      throw new PatchError(`doc is missing path: ${op.path}`);
    }
    const node = parent as Tree;
    const exists = leaf in node;
    switch (op.op) {
      case 'test':
        if (JSON.stringify(node[leaf]) !== JSON.stringify(op.value)) {
          throw new PatchError(`testing value ${op.path} failed: test failed`);
        }
        break;
      case 'add':
        node[leaf] = structuredClone(op.value);
        break;
      case 'replace':
        if (!exists) {
          throw new PatchError(`replace operation does not apply: doc is missing key: ${op.path}`);
        }
        node[leaf] = structuredClone(op.value);
        break;
      case 'remove':
        if (!exists) {
          throw new PatchError(`remove operation does not apply: doc is missing key: ${op.path}`);
        }
        delete node[leaf];
        break;
    }
  }
  return out as unknown as T;
}
