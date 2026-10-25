import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => ({
  post: vi.fn(),
  request: vi.fn(),
}));
vi.mock('@kinvolk/headlamp-plugin/lib/ApiProxy', () => proxy);

import {
  CONFLICT_MESSAGE,
  createInstance,
  fetchSecret,
  isConflict,
  patchInstance,
  submitInstance,
} from './api';
import { editPatch, formFromObject, type JsonPatchOp } from './mapping';
import { applyPatch, invalidError, PATCH_REJECTED, PatchError } from './testdata/applyPatch';
import { minimal } from './testdata/fixtures';

const BASE = '/apis/platform.di-framework.dev/v1alpha1/namespaces';
const patch: JsonPatchOp[] = [
  { op: 'test', path: '/metadata/resourceVersion', value: '7' },
  { op: 'replace', path: '/spec/version', value: '6.0.18' },
];

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  for (const fn of Object.values(proxy)) {
    fn.mockReset();
  }
});

describe('api', () => {
  it('creates with a POST of the exact object to the namespace collection, without auto-logout', async () => {
    proxy.post.mockResolvedValue({ ok: 1 });
    await expect(createInstance(minimal)).resolves.toStrictEqual({ ok: 1 });
    expect(proxy.post).toHaveBeenCalledWith(`${BASE}/team-a/platforminstances`, minimal, false);

    await createInstance({ ...minimal, metadata: { name: 'x' } });
    expect(proxy.post).toHaveBeenLastCalledWith(
      `${BASE}//platforminstances`,
      { ...minimal, metadata: { name: 'x' } },
      false,
    );
  });

  it('edits with a JSON Patch to the object path, without auto-logout', async () => {
    proxy.request.mockResolvedValue({ ok: 2 });
    await expect(patchInstance('team-a', 'one', patch)).resolves.toStrictEqual({ ok: 2 });
    expect(proxy.request).toHaveBeenCalledWith(
      `${BASE}/team-a/platforminstances/one`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
        headers: { 'Content-Type': 'application/json-patch+json' },
      },
      false,
    );
  });

  it('turns a patch the server could not apply (its generic 422) or a 409 into the conflict message', async () => {
    for (const err of [
      new PatchError('testing value /spec/version failed: test failed'),
      // Over HTTP/2 there is no status text, so Headlamp's message starts with " - ".
      httpError(422, ` - ${PATCH_REJECTED}`),
      httpError(409, 'Conflict - Operation cannot be fulfilled on platforminstances'),
    ]) {
      proxy.request.mockRejectedValueOnce(err);
      const rejection = patchInstance('team-a', 'one', patch);
      await expect(rejection).rejects.toThrow(CONFLICT_MESSAGE);
      await expect(rejection).rejects.toMatchObject({ status: 409, cause: err });
    }
  });

  it('shows a real concurrent change as the conflict message', async () => {
    const opened = { ...minimal, metadata: { ...minimal.metadata, resourceVersion: '7' } };
    const edit = editPatch(opened, { ...formFromObject(opened), version: '6.0.18' });
    const current = { ...opened, spec: { ...opened.spec, version: '6.0.20' } };
    // The server applies the patch to the current object; its failed test is the server's 422.
    proxy.request.mockImplementationOnce(async (_path: string, init: { body: string }) =>
      applyPatch(current, JSON.parse(init.body)),
    );
    await expect(patchInstance('team-a', 'one', edit)).rejects.toThrow(CONFLICT_MESSAGE);
  });

  it('passes a validation error (422 is invalid) and every other error through unchanged', async () => {
    const invalid = invalidError(
      'one',
      'spec.version: Invalid value: "6.0": spec.version in body should match',
    );
    proxy.request.mockRejectedValueOnce(invalid);
    await expect(patchInstance('team-a', 'one', patch)).rejects.toBe(invalid);
    const cel = invalidError('one', 'spec.target: Invalid value: "object": target is immutable');
    proxy.request.mockRejectedValueOnce(cel);
    await expect(patchInstance('team-a', 'one', patch)).rejects.toBe(cel);
    const forbidden = httpError(403, 'Forbidden');
    proxy.request.mockRejectedValueOnce(forbidden);
    await expect(patchInstance('team-a', 'one', patch)).rejects.toBe(forbidden);
  });

  it('isConflict needs a 409, or a 422 with the server message for a patch that did not apply', () => {
    expect(isConflict(undefined)).toBe(false);
    expect(isConflict({ status: 409 })).toBe(true);
    expect(isConflict({ status: 422 })).toBe(false);
    expect(isConflict({ status: 422, message: `Unprocessable Entity - ${PATCH_REJECTED}` })).toBe(
      true,
    );
    expect(isConflict(invalidError('one', 'spec.version: Invalid value'))).toBe(false);
    // The json-patch text never reaches the client, so it is not what is matched.
    expect(isConflict({ status: 422, message: 'testing value /spec/version failed' })).toBe(false);
    expect(isConflict({ message: PATCH_REJECTED })).toBe(false);
    expect(isConflict({ status: 400, message: PATCH_REJECTED })).toBe(false);
  });

  it('dispatches a submission by mode', async () => {
    proxy.post.mockResolvedValue('created');
    proxy.request.mockResolvedValue('patched');
    await expect(submitInstance({ mode: 'create', object: minimal })).resolves.toBe('created');
    await expect(
      submitInstance({ mode: 'edit', namespace: 'team-a', name: 'one', patch }),
    ).resolves.toBe('patched');
  });

  it('reads the Secret with cache: no-store and without auto-logout', async () => {
    proxy.request.mockResolvedValue({ data: {} });
    await expect(fetchSecret('team-a', 'one-kubeconfig')).resolves.toStrictEqual({ data: {} });
    expect(proxy.request).toHaveBeenCalledWith(
      '/api/v1/namespaces/team-a/secrets/one-kubeconfig',
      { cache: 'no-store' },
      false,
    );
  });

  it('lets a 403 or 404 reject with its status, for the section to explain', async () => {
    for (const status of [403, 404]) {
      const err = httpError(status, 'no');
      proxy.request.mockRejectedValueOnce(err);
      await expect(fetchSecret('team-a', 'one-kubeconfig')).rejects.toMatchObject({ status });
    }
    expect(proxy.request).toHaveBeenCalledTimes(2);
    for (const call of proxy.request.mock.calls) {
      expect(call[2]).toBe(false);
    }
  });
});
