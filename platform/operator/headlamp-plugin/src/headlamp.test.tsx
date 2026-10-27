/**
 * The Headlamp glue (index, resource, list and detail views) against stand-ins for Headlamp's
 * components: the real ones need Headlamp's runtime, store and router.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  routes: [] as { path: string; name: string; component: () => JSX.Element }[],
  sidebar: [] as unknown[],
  submit: vi.fn(),
  fetchSecret: vi.fn(),
  item: null as unknown,
}));

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  registerRoute: (r: (typeof h.routes)[number]) => h.routes.push(r),
  registerSidebarEntry: (e: unknown) => h.sidebar.push(e),
}));
vi.mock('@kinvolk/headlamp-plugin/lib/k8s/cluster', () => ({
  KubeObject: class {
    jsonData: Record<string, unknown>;
    constructor(json: Record<string, unknown>) {
      this.jsonData = json;
    }
    getName() {
      return (this.jsonData.metadata as { name: string }).name;
    }
    getNamespace() {
      return (this.jsonData.metadata as { namespace?: string }).namespace;
    }
  },
}));
vi.mock('./api', () => ({ submitInstance: h.submit, fetchSecret: h.fetchSecret }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ namespace: 'team-a', name: 'one' }) }));

interface GridProps {
  resourceType: unknown;
  name: string;
  namespace: string;
  actions: (item: unknown) => ReactNode[];
  extraInfo: (item: unknown) => { name: string; value: ReactNode }[] | null;
  extraSections: (item: unknown) => { id: string; section: ReactNode }[];
}

vi.mock('@kinvolk/headlamp-plugin/lib/components/common', () => ({
  SectionBox: (p: { title: string; children: ReactNode }) => (
    <section aria-label={p.title}>{p.children}</section>
  ),
  NameValueTable: (p: { rows: { name: string; value: ReactNode }[] }) => (
    <dl>
      {p.rows.map((r) => (
        <div key={r.name} data-row={r.name}>
          <dt>{r.name}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  ),
  DetailsGrid: (p: GridProps) => {
    // Headlamp calls these with null while loading.
    expect(p.actions(null)).toStrictEqual([]);
    expect(p.extraInfo(null)).toBeNull();
    expect(p.extraSections(null)).toStrictEqual([]);
    return (
      <div data-grid={`${p.namespace}/${p.name}`}>
        {p.actions(h.item)}
        <dl>
          {p.extraInfo(h.item)?.map((r) => (
            <div key={r.name} data-row={r.name}>
              <dt>{r.name}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
        {p.extraSections(h.item).map((s) => (
          <div key={s.id} data-section={s.id}>
            {s.section}
          </div>
        ))}
      </div>
    );
  },
  ResourceListView: (p: {
    title: string;
    resourceClass: unknown;
    columns: unknown[];
    headerProps: { titleSideActions: ReactNode[] };
  }) => (
    <div data-list={p.title} data-columns={p.columns.length}>
      {p.headerProps.titleSideActions}
    </div>
  ),
}));

import { platformInstanceColumns } from './columns';
import { PlatformInstanceDetail, Url } from './components/Detail';
import { PlatformInstanceList } from './components/List';
import {
  asObject,
  DETAILS_PATH,
  LIST_PATH,
  PlatformInstance,
  ROUTE_DETAILS,
  ROUTE_LIST,
} from './resource';
import { full } from './testdata/fixtures';
import type { PlatformInstanceObject } from './types';

function rowValue(name: string): string {
  return document.querySelector(`[data-row="${name}"] dd`)?.textContent ?? '';
}

const ready: PlatformInstanceObject = {
  ...full,
  metadata: { ...full.metadata, resourceVersion: '5' },
  status: {
    phase: 'Ready',
    installedVersion: '6.0.18-rc.1',
    lastRepair: '2026-10-25T10:00:00Z',
    endpoints: { kubernetes: 'https://10.0.0.1:6443', http: 'javascript:alert(1)' },
    kubeconfigSecretRef: { name: 'full-instance-kubeconfig' },
    applied: {
      generation: 3,
      tenants: 2,
      users: 1,
      tenantAuthIssuer: 'https://login.example',
      tenantHostImage: 'localhost/wash:dev',
    },
  },
};

beforeEach(() => {
  h.submit.mockReset();
  h.fetchSecret.mockReset();
});

describe('resource', () => {
  it('describes the CRD to Headlamp and exposes spec and status', () => {
    expect(PlatformInstance.kind).toBe('PlatformInstance');
    expect(PlatformInstance.apiVersion).toBe('platform.di-framework.dev/v1alpha1');
    expect(PlatformInstance.apiName).toBe('platforminstances');
    expect(PlatformInstance.isNamespaced).toBe(true);
    expect(PlatformInstance.detailsRoute).toBe(ROUTE_DETAILS);
    expect(PlatformInstance.listRoute).toBe(ROUTE_LIST);

    const item = new PlatformInstance(ready as never);
    expect(item.spec).toBe(ready.spec);
    expect(item.status).toBe(ready.status);
    expect(asObject(item)).toBe(ready);
    expect(new PlatformInstance({ ...full } as never).status).toStrictEqual({});
  });
});

describe('index', () => {
  it('registers the sidebar entry and the list and detail routes', async () => {
    await import('./index');
    expect(h.sidebar).toStrictEqual([
      {
        parent: null,
        name: 'platform-instances',
        label: 'Platform Instances',
        url: LIST_PATH,
        icon: 'mdi:cube-outline',
      },
    ]);
    expect(h.routes.map((r) => [r.path, r.name])).toStrictEqual([
      [LIST_PATH, ROUTE_LIST],
      [DETAILS_PATH, ROUTE_DETAILS],
    ]);
    h.item = new PlatformInstance(ready as never);
    for (const route of h.routes) {
      const { unmount } = render(route.component());
      unmount();
    }
  });
});

describe('list', () => {
  it('shows the plugin columns and opens the create form, which submits through the API', async () => {
    h.submit.mockResolvedValue({});
    render(<PlatformInstanceList />);
    const list = document.querySelector('[data-list="Platform Instances"]');
    expect(list?.getAttribute('data-columns')).toBe(String(platformInstanceColumns.length));

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.change(document.getElementById('pi-name') as HTMLElement, {
      target: { value: 'one' },
    });
    fireEvent.change(document.getElementById('pi-version') as HTMLElement, {
      target: { value: '6.0.17' },
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Create' }).at(-1) as HTMLElement);
    });
    expect(h.submit).toHaveBeenCalledWith({
      mode: 'create',
      object: expect.objectContaining({ metadata: { name: 'one', namespace: 'default' } }),
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the create form closes on Cancel', () => {
    render(<PlatformInstanceList />);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Url (endpoint link guard)', () => {
  it('links only http and https URLs', () => {
    render(
      <div>
        <Url url="https://10.0.0.1:6443" />
        <Url url="http://apps.example" />
        <Url url="javascript:alert(1)" />
        <Url url="data:text/html,x" />
        <Url />
      </div>,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toStrictEqual([
      'https://10.0.0.1:6443',
      'http://apps.example',
    ]);
    for (const a of links) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('target')).toBe('_blank');
    }
    expect(screen.getByText('javascript:alert(1)').tagName).toBe('CODE');
    expect(screen.getByText('data:text/html,x').tagName).toBe('CODE');
    expect(screen.getByText('-').tagName).toBe('SPAN');
  });
});

describe('detail', () => {
  it('shows the spec and status, and renders a javascript: endpoint as text', () => {
    h.item = new PlatformInstance(ready as never);
    render(<PlatformInstanceDetail />);
    expect(document.querySelector('[data-grid]')?.getAttribute('data-grid')).toBe('team-a/one');
    expect(rowValue('Phase')).toBe('Ready');
    expect(rowValue('Version')).toBe('6.0.18-rc.1');
    expect(rowValue('Installed version')).toBe('6.0.18-rc.1');
    expect(rowValue('Target')).toBe('vcluster');
    expect(rowValue('Deletion policy')).toBe('Retain');
    expect(rowValue('Network policy engine')).toBe('kube-router');
    expect(rowValue('Storage root')).toBe('/var/lib/di-framework/team-b/full-instance');
    expect(rowValue('Gateway NodePort')).toBe('30080');
    expect(rowValue('Last repair')).toBe('2026-10-25T10:00:00Z');
    expect(rowValue('Applied tenants')).toBe('2');
    expect(rowValue('Applied users')).toBe('1');
    expect(rowValue('Applied tenant auth issuer')).toBe('https://login.example');
    expect(rowValue('Applied tenant host image')).toBe('localhost/wash:dev');
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://10.0.0.1:6443');
    expect(screen.getByText('javascript:alert(1)').tagName).toBe('CODE');
    expect(screen.getByRole('button', { name: 'Show kubeconfig' })).toBeTruthy();
  });

  it('shows placeholders for an instance the operator has not reported on', () => {
    h.item = new PlatformInstance({
      ...full,
      spec: { version: '6.0.17' },
      metadata: { name: 'bare' },
    } as never);
    render(<PlatformInstanceDetail />);
    expect(rowValue('Installed version')).toBe('-');
    expect(rowValue('Target')).toBe('-');
    expect(rowValue('Deletion policy')).toBe('-');
    expect(rowValue('Network policy engine')).toBe('-');
    expect(rowValue('Storage root')).toBe('(operator default)');
    expect(rowValue('Gateway NodePort')).toBe('-');
    expect(rowValue('Last repair')).toBe('-');
    expect(rowValue('Applied tenants')).toBe('-');
    expect(rowValue('Applied users')).toBe('-');
    expect(rowValue('Applied tenant auth issuer')).toBe('-');
    expect(rowValue('Applied tenant host image')).toBe('-');
    expect(screen.getByText(/hasn't published a kubeconfig/)).toBeTruthy();
  });

  it('shows an applied install without tenantAuth or a recorded host image (#442)', () => {
    h.item = new PlatformInstance({
      ...ready,
      status: { ...ready.status, applied: { generation: 3, tenants: 0, users: 0 } },
    } as never);
    render(<PlatformInstanceDetail />);
    expect(rowValue('Applied tenants')).toBe('0');
    expect(rowValue('Applied tenant auth issuer')).toBe('-');
    expect(rowValue('Applied tenant host image')).toBe("(platform's own default)");
  });

  it('shows dashes when the spec is missing entirely', () => {
    h.item = new PlatformInstance({ ...full, spec: undefined } as never);
    render(<PlatformInstanceDetail />);
    expect(rowValue('Version')).toBe('-');
  });

  it('Edit spec opens the form on the object and sends the patch through the API', async () => {
    h.submit.mockResolvedValue({});
    h.item = new PlatformInstance(ready as never);
    render(<PlatformInstanceDetail />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit spec' }));
    fireEvent.change(document.getElementById('pi-version') as HTMLElement, {
      target: { value: '6.0.19' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(h.submit).toHaveBeenCalledWith({
      mode: 'edit',
      namespace: 'team-b',
      name: 'full-instance',
      patch: [
        { op: 'test', path: '/spec/version', value: '6.0.18-rc.1' },
        { op: 'replace', path: '/spec/version', value: '6.0.19' },
      ],
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keys the kubeconfig section to the instance and its Secret (S2)', async () => {
    h.fetchSecret.mockResolvedValue({ data: { kubeconfig: btoa('apiVersion: v1\n') } });
    h.item = new PlatformInstance(ready as never);
    const { rerender } = render(<PlatformInstanceDetail />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show kubeconfig' }));
    });
    expect(h.fetchSecret).toHaveBeenCalledWith('team-b', 'full-instance-kubeconfig');
    expect(screen.getByLabelText('kubeconfig').textContent).toBe('apiVersion: v1\n');

    // The operator points the instance at a different Secret: the old text must not stay.
    h.item = new PlatformInstance({
      ...ready,
      status: { ...ready.status, kubeconfigSecretRef: { name: 'rotated' } },
    } as never);
    rerender(<PlatformInstanceDetail />);
    expect(screen.queryByLabelText('kubeconfig')).toBeNull();
  });
});
