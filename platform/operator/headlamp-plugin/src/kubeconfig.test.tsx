import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KubeconfigSection } from './components/KubeconfigSection';
import {
  decodeKubeconfig,
  kubeconfigErrorMessage,
  kubeconfigFileName,
  type SecretLike,
  secretPath,
} from './kubeconfig';

const KUBECONFIG = 'apiVersion: v1\nkind: Config\nclusters: []\n# ünïcode\n';
const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(KUBECONFIG)));
const secret: SecretLike = { data: { kubeconfig: encoded } };

function forbidden() {
  return Object.assign(new Error('Forbidden - secrets "one-kubeconfig" is forbidden'), {
    status: 403,
  });
}

describe('kubeconfig helpers', () => {
  it('reads the Secret through the core API path', () => {
    expect(secretPath('team-a', 'one-kubeconfig')).toBe(
      '/api/v1/namespaces/team-a/secrets/one-kubeconfig',
    );
  });

  it('decodes data.kubeconfig as UTF-8', () => {
    expect(decodeKubeconfig(secret)).toBe(KUBECONFIG);
    expect(() => decodeKubeconfig({ data: {} })).toThrow(/no "kubeconfig" key/);
  });

  it('explains a 403 as a missing permission on that Secret', () => {
    const msg = kubeconfigErrorMessage(forbidden(), 'team-a', 'one-kubeconfig');
    expect(msg).toMatch(/don't have permission/);
    expect(msg).toContain('"one-kubeconfig"');
    expect(msg).toContain('"team-a"');
    expect(msg).toContain('403');
    expect(kubeconfigErrorMessage({ status: 404 }, 'a', 'b')).toMatch(/not found/);
    expect(kubeconfigErrorMessage(new Error('boom'), 'a', 'b')).toMatch(/boom/);
  });

  it('names the download after the instance', () => {
    expect(kubeconfigFileName('one')).toBe('one-kubeconfig.yaml');
  });
});

describe('KubeconfigSection', () => {
  it('waits for status.kubeconfigSecretRef before offering anything', () => {
    const fetchSecret = vi.fn();
    render(<KubeconfigSection instanceName="one" namespace="team-a" fetchSecret={fetchSecret} />);
    expect(screen.getByText(/hasn't published a kubeconfig/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetchSecret).not.toHaveBeenCalled();
  });

  it('reads nothing until asked, then shows it; Hide drops it and Show reads again', async () => {
    const fetchSecret = vi.fn().mockResolvedValue(secret);
    render(
      <KubeconfigSection
        instanceName="one"
        namespace="team-a"
        secretName="one-kubeconfig"
        fetchSecret={fetchSecret}
      />,
    );
    expect(fetchSecret).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show kubeconfig' }));
    });
    expect(fetchSecret).toHaveBeenCalledWith('team-a', 'one-kubeconfig');
    expect(screen.getByLabelText('kubeconfig').textContent).toBe(KUBECONFIG);

    fireEvent.click(screen.getByRole('button', { name: 'Hide kubeconfig' }));
    expect(screen.queryByLabelText('kubeconfig')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show kubeconfig' }));
    });
    expect(fetchSecret).toHaveBeenCalledTimes(2);
  });

  it('shows a clear message on 403 and no kubeconfig', async () => {
    const fetchSecret = vi.fn().mockRejectedValue(forbidden());
    render(
      <KubeconfigSection
        instanceName="one"
        namespace="team-a"
        secretName="one-kubeconfig"
        fetchSecret={fetchSecret}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show kubeconfig' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(
      /don't have permission.*"one-kubeconfig".*"team-a".*403/,
    );
    expect(screen.queryByLabelText('kubeconfig')).toBeNull();
  });

  it('downloads a fresh read as <name>-kubeconfig.yaml without keeping it on screen', async () => {
    const fetchSecret = vi.fn().mockResolvedValue(secret);
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(
      <KubeconfigSection
        instanceName="one"
        namespace="team-a"
        secretName="one-kubeconfig"
        fetchSecret={fetchSecret}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download kubeconfig' }));
    });
    expect(fetchSecret).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('one-kubeconfig.yaml');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
    expect(screen.queryByLabelText('kubeconfig')).toBeNull();
    click.mockRestore();
  });
});
