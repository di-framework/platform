/** Edge cases of the view helpers that the feature tests don't reach. */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { versionColumn } from './columns';
import { ConditionsTable } from './components/Conditions';
import { KubeconfigSection } from './components/KubeconfigSection';
import { PlatformInstanceFormDialog } from './components/PlatformInstanceForm';
import { kubeconfigErrorMessage } from './kubeconfig';
import { editPatch, emptyForm, formFromObject, validateForm } from './mapping';
import { conditionRows } from './status';
import { full } from './testdata/fixtures';
import type { Condition, PlatformInstanceObject } from './types';

describe('edge cases', () => {
  it('rejects an invalid namespace on create', () => {
    const form = { ...emptyForm('Bad_NS'), name: 'one', version: '6.0.17' };
    expect(validateForm(form, 'create').namespace).toMatch(/DNS-1123 label/);
    expect(validateForm({ ...form, namespace: 'a'.repeat(64) }, 'create').namespace).toBeDefined();
  });

  it('explains a non-Error failure by its text', () => {
    expect(kubeconfigErrorMessage('socket hang up', 'a', 'b')).toBe(
      `Couldn't read the kubeconfig Secret "b": socket hang up`,
    );
    expect(kubeconfigErrorMessage(null, 'a', 'b')).toMatch(/null$/);
  });

  it('version column without a spec shows a dash', () => {
    const row = { jsonData: {} } as never;
    expect(versionColumn.getValue(row)).toBe('');
    render(<div>{versionColumn.render(row)}</div>);
    expect(screen.getByText('-')).toBeTruthy();
  });

  it('a condition missing reason, message and time shows dashes', () => {
    const bare = { type: 'Ready', status: 'True' } as Condition;
    expect(conditionRows({ metadata: {}, status: { conditions: [bare] } })).toEqual([
      expect.objectContaining({ reason: '', message: '', lastTransitionTime: '' }),
    ]);
    render(
      <ConditionsTable
        instance={{ metadata: { name: 'x' }, status: { conditions: [bare] } } as never}
      />,
    );
    expect(screen.getAllByText('-').length).toBe(3);
  });

  it('a failed read offers no download', async () => {
    const fetchSecret = vi.fn().mockRejectedValue({ status: 404 });
    const createObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL });
    render(
      <KubeconfigSection
        instanceName="one"
        namespace="team-a"
        secretName="gone"
        fetchSecret={fetchSecret}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download kubeconfig' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/not found/);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('a read that finishes after unmount changes nothing', async () => {
    let resolve: (v: unknown) => void = () => {};
    const fetchSecret = vi.fn(() => new Promise((r) => (resolve = r)));
    const { unmount } = render(
      <KubeconfigSection
        instanceName="one"
        namespace="team-a"
        secretName="s"
        fetchSecret={fetchSecret as never}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show kubeconfig' }));
    unmount();
    await act(async () => {
      resolve({ data: { kubeconfig: btoa('x') } });
    });
    expect(fetchSecret).toHaveBeenCalledTimes(1);
  });

  it('the form shows a field error on blur and takes a select choice', async () => {
    const submit = vi.fn().mockResolvedValue({});
    render(
      <PlatformInstanceFormDialog
        open
        mode="create"
        defaultNamespace="team-a"
        onClose={() => {}}
        submit={submit}
      />,
    );
    fireEvent.blur(document.getElementById('pi-version') as HTMLElement);
    expect(screen.getByText('Version is required.')).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: /Deletion policy/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Retain' }));
    fireEvent.change(document.getElementById('pi-name') as HTMLElement, {
      target: { value: 'one' },
    });
    fireEvent.change(document.getElementById('pi-version') as HTMLElement, {
      target: { value: '6.0.17' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(submit.mock.calls[0]?.[0].object.spec.deletionPolicy).toBe('Retain');
  });
  it('reads an object without namespace or spec as an empty form', () => {
    const bare = { metadata: { name: 'x' } } as PlatformInstanceObject;
    expect(formFromObject(bare)).toStrictEqual({ ...emptyForm(''), name: 'x' });
    expect(editPatch(bare, { ...formFromObject(bare), version: '1.2.3' })).toStrictEqual([
      { op: 'add', path: '/spec', value: {} },
      { op: 'add', path: '/spec/version', value: '1.2.3' },
      { op: 'add', path: '/spec/target', value: {} },
      { op: 'add', path: '/spec/target/type', value: 'vcluster' },
    ]);
  });

  it('adds a gateway field next to an existing one without recreating the gateway', () => {
    const noEndpoint: PlatformInstanceObject = {
      ...full,
      spec: { ...full.spec, platform: { gateway: { httpNodePort: 30080 } } },
    };
    const patch = editPatch(noEndpoint, {
      ...formFromObject(noEndpoint),
      httpEndpoint: 'http://a.example',
    });
    expect(patch).toStrictEqual([
      { op: 'add', path: '/spec/platform/gateway/httpEndpoint', value: 'http://a.example' },
    ]);
  });

  it('orders unknown condition types by name', () => {
    const c = (type: string) => ({ type, status: 'True' }) as Condition;
    const rows = conditionRows({
      metadata: {},
      status: { conditions: [c('Zeta'), c('Alpha'), c('Ready')] },
    });
    expect(rows.map((r) => r.type)).toStrictEqual(['Ready', 'Alpha', 'Zeta']);
  });

  it('a failed read that finishes after unmount changes nothing', async () => {
    let reject: (e: unknown) => void = () => {};
    const fetchSecret = vi.fn(() => new Promise((_, r) => (reject = r)));
    const { unmount } = render(
      <KubeconfigSection
        instanceName="one"
        namespace="team-a"
        secretName="s"
        fetchSecret={fetchSecret as never}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show kubeconfig' }));
    unmount();
    await act(async () => {
      reject({ status: 403 });
    });
    expect(fetchSecret).toHaveBeenCalledTimes(1);
  });

  it('edits an object without a namespace, and ignores closing while saving', async () => {
    let finish: (v: unknown) => void = () => {};
    const submit = vi.fn<(s: unknown) => Promise<unknown>>(() => new Promise((r) => (finish = r)));
    const onClose = vi.fn();
    const clusterScoped = { ...full, metadata: { name: 'x', resourceVersion: '1' } };
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={clusterScoped}
        onClose={onClose}
        submit={submit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      finish({});
    });
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ mode: 'edit', namespace: '', name: 'x' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
