/** The form's tenancy sections (#273, the spec.platform settings of #442). */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlatformInstanceFormDialog } from './components/PlatformInstanceForm';
import { applyPatch } from './testdata/applyPatch';
import { tenancyFull, tenancyMinimal } from './testdata/fixtures';
import type { PlatformInstanceObject } from './types';

vi.mock('@kinvolk/headlamp-plugin/lib/ApiProxy', () => ({}));

const TENANT_AUTH_IMAGE =
  'ghcr.io/di-framework/tenant-auth@sha256:455af084f57e60a54b16b6f5c4f39fcafb0593612fb036e1b099b88423147a30';

function input(id: string): HTMLInputElement {
  const el = document.getElementById(`pi-${id}`);
  if (!el) {
    throw new Error(`no input pi-${id}`);
  }
  return el as HTMLInputElement;
}

/** What a MUI select (rendered as a combobox with the id) shows; empty shows a zero-width space. */
function shown(id: string): string {
  return (input(id).textContent ?? '').replaceAll('​', '');
}

function type(id: string, value: string) {
  fireEvent.change(input(id), { target: { value } });
}

/** Picks `option` in the MUI select labelled `label` (the n-th one with that label). */
function choose(label: RegExp, option: string, n = 0) {
  fireEvent.mouseDown(screen.getAllByRole('combobox', { name: label })[n] as HTMLElement);
  fireEvent.click(screen.getByRole('option', { name: option }));
}

function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

async function save(name: 'Create' | 'Save') {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

function live(fixture: PlatformInstanceObject, hostImage?: string): PlatformInstanceObject {
  return {
    ...structuredClone(fixture),
    metadata: { ...fixture.metadata, resourceVersion: '9' },
    status: {
      phase: 'Ready',
      applied: { generation: 1, tenants: 2, users: 2, tenantHostImage: hostImage },
    },
  };
}

describe('the tenancy sections of the form', () => {
  it('creates exactly the minimal tenancy manifest from tenants, users and memberships', async () => {
    const submit = vi.fn().mockResolvedValue({});
    render(
      <PlatformInstanceFormDialog
        open
        mode="create"
        defaultNamespace="team-d"
        onClose={() => {}}
        submit={submit}
      />,
    );
    expect(screen.getByText(/a new instance records the operator's pinned default/)).toBeTruthy();
    type('name', 'tenancy-minimal');
    type('version', '6.0.20');
    click('Add tenant');
    type('tenants-0-name', 'acme');
    click('Add user');
    type('users-0-name', 'dev');
    // A new membership picks the first tenant the user isn't in yet, as a viewer.
    click('Add membership to user 1');
    expect(shown('users-0-memberships-0-tenant')).toBe('acme');
    expect(shown('users-0-memberships-0-role')).toBe('viewer');
    await save('Create');
    expect(submit.mock.calls[0]?.[0]).toStrictEqual({ mode: 'create', object: tenancyMinimal });
  });

  it('blocks a partial tenantAuth and bad names before sending, then sends the whole', async () => {
    const submit = vi.fn().mockResolvedValue({});
    render(
      <PlatformInstanceFormDialog
        open
        mode="create"
        defaultNamespace="team-d"
        onClose={() => {}}
        submit={submit}
      />,
    );
    type('name', 'auth');
    type('version', '6.0.20');
    click('Add tenant');
    type('tenants-0-name', 'Acme');
    click('Add user');
    // No tenant to choose yet when the tenant row's name is invalid... the row still offers it.
    click('Add membership to user 1');
    type('tenantAuthIssuer', 'https://login.example');
    await save('Create');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByText(/Tenant name must be lowercase letters/)).toBeTruthy();
    expect(screen.getByText('User name is required.')).toBeTruthy();
    expect(
      screen.getAllByText('tenantAuth needs issuer, clientId and clientSecretRef together.'),
    ).toHaveLength(3);
    expect(screen.getByText('Tenant auth needs the tenant-auth image.')).toBeTruthy();

    type('tenants-0-name', 'acme');
    type('users-0-name', 'dev');
    choose(/^Tenant, membership/, 'acme');
    choose(/^Role, membership/, 'developer');
    type('tenantAuthClientId', 'console');
    type('tenantAuthSecretName', 'tenant-auth-oauth');
    type('tenantAuthSecretKey', 'clientSecret');
    type('tenantAuthImage', TENANT_AUTH_IMAGE);
    type('tenantAuthIssuerUpstreamPodPort', '8080');
    type('tenantHostImage', 'localhost/wash:dev');
    choose(/Tenant host image pull policy/, 'Never');
    await save('Create');
    const object = submit.mock.calls[0]?.[0].object as PlatformInstanceObject;
    expect(object.spec.platform).toStrictEqual({
      tenants: [{ name: 'acme' }],
      users: [{ name: 'dev', memberships: [{ tenant: 'acme', role: 'developer' }] }],
      tenantAuth: {
        issuer: 'https://login.example',
        clientId: 'console',
        clientSecretRef: { name: 'tenant-auth-oauth', key: 'clientSecret' },
        image: TENANT_AUTH_IMAGE,
        issuerUpstreamPodPort: 8080,
      },
      tenantHostImage: 'localhost/wash:dev',
      tenantHostImagePullPolicy: 'Never',
    });
  });

  it('shows the recorded host image on edit and patches a changed one', async () => {
    const old = live(tenancyFull, 'ghcr.io/di-framework/wash:recorded');
    const submit = vi.fn().mockResolvedValue({});
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={old}
        onClose={() => {}}
        submit={submit}
      />,
    );
    expect(screen.getByText(/Empty keeps the last applied image/).textContent).toContain(
      'ghcr.io/di-framework/wash:recorded',
    );
    expect(input('tenantHostImage').disabled).toBe(false);
    type('tenantHostImage', 'localhost/wash:v2');
    fireEvent.click(screen.getByRole('button', { name: 'Show patch' }));
    expect(screen.getByLabelText('Object preview').textContent).toContain(
      '/spec/platform/tenantHostImage',
    );
    await save('Save');
    expect(submit.mock.calls[0]?.[0].patch).toStrictEqual([
      { op: 'test', path: '/spec/platform/tenantHostImage', value: 'localhost/wash:dev' },
      { op: 'replace', path: '/spec/platform/tenantHostImage', value: 'localhost/wash:v2' },
    ]);
  });

  it('rejects memberships of a removed tenant on edit until they are removed too', async () => {
    const old = live(tenancyFull);
    const submit = vi.fn().mockResolvedValue({});
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={old}
        onClose={() => {}}
        submit={submit}
      />,
    );
    click('Remove tenant 2');
    // The memberships keep naming globex, which is no longer a choice but still shows.
    expect(
      screen.getAllByText(
        '"globex" is not in Tenants: every users[].memberships[].tenant must name an entry of tenants.',
      ),
    ).toHaveLength(2);
    expect(shown('users-0-memberships-1-tenant')).toBe('globex');
    await save('Save');
    expect(submit).not.toHaveBeenCalled();

    click('Remove membership 2 of user 1');
    click('Remove user 2');
    expect(screen.queryByText(/is not in Tenants/)).toBeNull();
    await save('Save');
    const patch = submit.mock.calls[0]?.[0].patch;
    expect(patch.map((op: { op: string; path: string }) => `${op.op} ${op.path}`)).toStrictEqual([
      'test /spec/platform/tenants',
      'test /spec/platform/users',
      'replace /spec/platform/tenants',
      'replace /spec/platform/users',
    ]);
    const updated = applyPatch(old, patch);
    expect(updated.spec.platform?.tenants).toStrictEqual([tenancyFull.spec.platform?.tenants?.[0]]);
    expect(updated.spec.platform?.users).toStrictEqual([
      { name: 'dev', memberships: [{ tenant: 'acme', role: 'developer' }] },
    ]);
  });

  it('caps the tenants and memberships at the CRD limits', () => {
    const old = live(tenancyFull);
    old.spec.platform = {
      ...old.spec.platform,
      tenants: Array.from({ length: 32 }, (_, i) => ({ name: `t${i}` })),
      users: [
        {
          name: 'dev',
          memberships: Array.from({ length: 16 }, (_, i) => ({
            tenant: `t${i}`,
            role: 'viewer' as const,
          })),
        },
      ],
    };
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={old}
        onClose={() => {}}
        submit={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Add tenant' }).hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Add membership to user 1' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('asks for a tenant when a membership is added without tenants', async () => {
    const submit = vi.fn();
    render(
      <PlatformInstanceFormDialog
        open
        mode="create"
        defaultNamespace="team-d"
        onClose={() => {}}
        submit={submit}
      />,
    );
    type('name', 'solo');
    type('version', '6.0.20');
    click('Add user');
    type('users-0-name', 'solo');
    click('Add membership to user 1');
    expect(shown('users-0-memberships-0-tenant')).toBe('');
    await save('Create');
    expect(screen.getByText('Choose a tenant.')).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it('shows list-level errors for lists over the CRD limits', () => {
    const old = live(tenancyMinimal);
    old.spec.platform = {
      tenants: Array.from({ length: 33 }, (_, i) => ({ name: `t${i}` })),
      users: Array.from({ length: 129 }, (_, i) => ({
        name: `u${i}`,
        memberships: Array.from({ length: i === 0 ? 17 : 0 }, (_, j) => ({
          tenant: `t${j}`,
          role: 'viewer' as const,
        })),
      })),
    };
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={old}
        onClose={() => {}}
        submit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('At most 32 tenants.')).toBeTruthy();
    expect(screen.getByText('At most 128 users.')).toBeTruthy();
    expect(screen.getByText('At most 16 memberships per user.')).toBeTruthy();
  });

  it('keeps existing tenant names read-only, and edits one membership among several', async () => {
    const old = live(tenancyFull);
    const submit = vi.fn().mockResolvedValue({});
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={old}
        onClose={() => {}}
        submit={submit}
      />,
    );
    // The platform has no rename: a new name would remove the tenant and create another.
    expect(input('tenants-0-name').disabled).toBe(true);
    expect(screen.getAllByText(/Can't be renamed/)).toHaveLength(2);
    click('Add tenant');
    expect(input('tenants-2-name').disabled).toBe(false);
    type('tenants-2-name', 'initech');
    choose(/^Tenant, membership 1 of user 1$/, 'initech');
    choose(/^Role, membership 2 of user 1$/, 'developer');
    await save('Save');
    const updated = applyPatch(old, submit.mock.calls[0]?.[0].patch);
    expect(updated.spec.platform?.tenants?.map((t) => t.name)).toStrictEqual([
      'acme',
      'globex',
      'initech',
    ]);
    expect(updated.spec.platform?.tenants?.[0]?.runtime).toStrictEqual({
      replicas: 2,
      coreInstances: 200,
    });
    expect(updated.spec.platform?.users?.[0]?.memberships).toStrictEqual([
      { tenant: 'initech', role: 'developer' },
      { tenant: 'globex', role: 'developer' },
    ]);
    expect(updated.spec.platform?.users?.[1]).toStrictEqual(tenancyFull.spec.platform?.users?.[1]);
  });

  it("says an installed instance without a recorded host image keeps the platform's own default", () => {
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={live(tenancyMinimal)}
        onClose={() => {}}
        submit={vi.fn()}
      />,
    );
    expect(screen.getByText(/Empty keeps the platform's own default\./)).toBeTruthy();
    expect(screen.queryByText(/a new instance records/)).toBeNull();
  });

  it("adds a membership in the first tenant the user isn't in yet", () => {
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={live(tenancyFull)}
        onClose={() => {}}
        submit={vi.fn()}
      />,
    );
    // auditor is in globex only.
    click('Add membership to user 2');
    expect(shown('users-1-memberships-1-tenant')).toBe('acme');
  });

  it('disables the tenancy controls while saving', async () => {
    let finish: (v: unknown) => void = () => {};
    const submit = vi.fn(() => new Promise((r) => (finish = r)));
    render(
      <PlatformInstanceFormDialog
        open
        mode="edit"
        existing={live(tenancyFull)}
        onClose={() => {}}
        submit={submit}
      />,
    );
    type('tenantAuthClientId', 'other');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(input('tenants-0-name').disabled).toBe(true);
    expect(input('users-0-name').disabled).toBe(true);
    for (const name of ['Add tenant', 'Add user', 'Remove tenant 1', 'Add membership to user 1']) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
    await act(async () => {
      finish({});
    });
  });
});
