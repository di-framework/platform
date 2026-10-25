import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlatformInstanceFormDialog } from './components/PlatformInstanceForm';
import { full, minimal } from './testdata/fixtures';

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
    expect(submit.mock.calls[0]?.[0]).toStrictEqual(minimal);
    expect(submit.mock.calls[0]?.[1]).toBe('create');
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

  it('on edit, disables name, namespace, target and storage root, and PUTs the new spec', async () => {
    const live = { ...full, metadata: { ...full.metadata, resourceVersion: '9' } };
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
    expect(submit.mock.calls[0]?.[0]).toStrictEqual({
      ...live,
      spec: { ...full.spec, version: '6.0.19' },
    });
    expect(submit.mock.calls[0]?.[1]).toBe('edit');
  });
});
