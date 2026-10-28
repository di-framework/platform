import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CONFLICT_MESSAGE } from './api';
import { PlatformInstanceFormDialog } from './components/PlatformInstanceForm';
import { applyPatch, PatchError } from './testdata/applyPatch';
import { full, minimal } from './testdata/fixtures';
import type { PlatformInstanceObject } from './types';

// The real ApiProxy needs Headlamp's runtime; this test only uses CONFLICT_MESSAGE from api.ts.
vi.mock('@kinvolk/headlamp-plugin/lib/ApiProxy', () => ({}));

/** The form's input for a field, by its id (`pi-<field>`). */
function input(field: string): HTMLInputElement {
  const el = document.getElementById(`pi-${field}`);
  if (!el) {
    throw new Error(`no input pi-${field}`);
  }
  return el as HTMLInputElement;
}

function type(field: string, value: string) {
  fireEvent.change(input(field), { target: { value } });
}

describe('PlatformInstanceFormDialog', () => {
  it('creates exactly the minimal manifest from the required fields', async () => {
    const submit = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    render(
      <PlatformInstanceFormDialog
        open
        mode="create"
        defaultNamespace="team-a"
        onClose={onClose}
        submit={submit}
      />,
    );
    type('name', 'one');
    type('version', '6.0.17');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toStrictEqual({ mode: 'create', object: minimal });
    expect(onClose).toHaveBeenCalled();
  });

  it('blocks a name over 63 characters before sending anything', async () => {
    const submit = vi.fn();
    render(
      <PlatformInstanceFormDialog
        open
        mode="create"
        defaultNamespace="team-a"
        onClose={() => {}}
        submit={submit}
      />,
    );
    type('name', 'a'.repeat(64));
    type('version', '6.0.17');
    expect(screen.getByText(/at most 63 characters \(it has 64\)/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('shows the API error and stays open', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('Conflict - already exists'));
    const onClose = vi.fn();
    render(
      <PlatformInstanceFormDialog
        open
        mode="create"
        defaultNamespace="team-a"
        onClose={onClose}
        submit={submit}
      />,
    );
    type('name', 'one');
    type('version', '6.0.17');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('already exists');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('on edit, disables name, namespace, target and storage root, and sends a guarded patch', async () => {
    const live = {
      ...full,
      metadata: {
        ...full.metadata,
        resourceVersion: '9',
        labels: { team: 'b' },
        annotations: { note: 'keep' },
      },
      spec: { ...full.spec, futureField: 'keep' },
    } as PlatformInstanceObject;
    const submit = vi.fn().mockResolvedValue({});
    const { rerender } = render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={live}
        onClose={() => {}}
        submit={submit}
      />,
    );
    // A watch update while the dialog is open must not move the baseline the patch is tested on.
    const newer = {
      ...live,
      metadata: { ...live.metadata, resourceVersion: '10' },
      spec: { ...live.spec, version: '6.0.20' },
    } as PlatformInstanceObject;
    rerender(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={newer}
        onClose={() => {}}
        submit={submit}
      />,
    );
    for (const field of ['name', 'namespace', 'storageRoot']) {
      expect(input(field).disabled).toBe(true);
    }
    // MUI renders a select as a button-like div; disabled shows as aria-disabled.
    expect(
      screen.getByRole('combobox', { name: /Target type/ }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(input('version').disabled).toBe(false);

    type('version', '6.0.19');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    const sent = submit.mock.calls[0]?.[0];
    expect(sent).toStrictEqual({
      mode: 'edit',
      namespace: 'team-b',
      name: 'full-instance',
      patch: [
        { op: 'test', path: '/spec/version', value: '6.0.18-rc.1' },
        { op: 'replace', path: '/spec/version', value: '6.0.19' },
      ],
    });
    // Applied to the object as it is now (another version), the patch is a conflict.
    expect(() => applyPatch(newer, sent.patch)).toThrow(PatchError);
    // A write that left the version alone (a status update) doesn't stop the edit.
    const statusWrite = { ...live, metadata: { ...live.metadata, resourceVersion: '10' } };
    expect(applyPatch(statusWrite, sent.patch).spec.version).toBe('6.0.19');
    // Applied to the object it was made for, only the version changes.
    expect(applyPatch(live, sent.patch)).toStrictEqual({
      ...live,
      spec: { ...live.spec, version: '6.0.19' },
    });
  });

  it("doesn't offer kube-router on create (#456)", () => {
    render(
      <PlatformInstanceFormDialog
        open
        mode="create"
        defaultNamespace="team-a"
        onClose={() => {}}
        submit={vi.fn()}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('combobox', { name: /Network policy engine/ }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toStrictEqual(['(API default)', 'existing']);
    expect(screen.getByText(/kube-router isn't offered on vcluster/)).toBeTruthy();
  });

  it('keeps kube-router on edit of an instance that already has it (#456)', async () => {
    const live = {
      ...full,
      metadata: { ...full.metadata, resourceVersion: '9' },
      spec: {
        ...full.spec,
        platform: { ...full.spec.platform, networkPolicyEngine: 'kube-router' },
      },
    } as PlatformInstanceObject;
    const submit = vi.fn().mockResolvedValue({});
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={live}
        onClose={() => {}}
        submit={submit}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('combobox', { name: /Network policy engine/ }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toStrictEqual(['(API default)', 'existing', 'kube-router']);
    fireEvent.click(screen.getByRole('option', { name: 'kube-router' }));
    type('version', '6.0.19');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/already uses it/)).toBeTruthy();
    // The engine is kept as is (no op on it); only the version changes.
    expect(submit.mock.calls[0]?.[0]).toStrictEqual({
      mode: 'edit',
      namespace: 'team-b',
      name: 'full-instance',
      patch: [
        { op: 'test', path: '/spec/version', value: '6.0.18-rc.1' },
        { op: 'replace', path: '/spec/version', value: '6.0.19' },
      ],
    });
  });

  it('shows the conflict message when the object changed since the dialog opened', async () => {
    const live = { ...full, metadata: { ...full.metadata, resourceVersion: '9' } };
    const submit = vi.fn().mockRejectedValue(new Error(CONFLICT_MESSAGE));
    const onClose = vi.fn();
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={live}
        onClose={onClose}
        submit={submit}
      />,
    );
    type('version', '6.0.19');
    fireEvent.click(screen.getByRole('button', { name: 'Show patch' }));
    expect(screen.getByLabelText('Object preview').textContent).toContain('/spec/version');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(screen.getByRole('alert').textContent).toBe(CONFLICT_MESSAGE);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the YAML of the object to create, and a non-Error rejection as text', async () => {
    const submit = vi.fn().mockRejectedValue('plain failure');
    render(<PlatformInstanceFormDialog open mode="create" onClose={() => {}} submit={submit} />);
    expect(input('namespace').value).toBe('default');
    type('name', 'one');
    type('version', '6.0.17');
    fireEvent.click(screen.getByRole('button', { name: 'Show YAML' }));
    expect(screen.getByLabelText('Object preview').textContent).toContain('kind: PlatformInstance');
    fireEvent.click(screen.getByRole('button', { name: 'Hide YAML' }));
    expect(screen.queryByLabelText('Object preview')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('plain failure');
  });
});
