import { describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';
import { kubeconfigServer, tenantKubeconfig } from '../src/kubeconfig';

const secretData = {
  token: Buffer.from('eyJhbGciOi.payload.sig').toString('base64'),
  'ca.crt': Buffer.from('-----BEGIN CERTIFICATE-----\nca\n').toString('base64'),
  namespace: Buffer.from('wasmcloud').toString('base64'),
};

describe('tenantKubeconfig', () => {
  it('uses the token as the only credential and selects the tenant workload namespace', () => {
    const text = tenantKubeconfig({
      server: 'https://127.0.0.1:26443',
      tenant: 'meshtastic',
      user: 'dev',
      secretData,
    });
    expect(load(text)).toEqual({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          name: 'meshtastic',
          cluster: {
            server: 'https://127.0.0.1:26443',
            'certificate-authority-data': secretData['ca.crt'],
          },
        },
      ],
      users: [{ name: 'dev@meshtastic', user: { token: 'eyJhbGciOi.payload.sig' } }],
      contexts: [
        {
          name: 'dev@meshtastic',
          context: {
            cluster: 'meshtastic',
            user: 'dev@meshtastic',
            namespace: 'di-tenant-meshtastic',
          },
        },
      ],
      'current-context': 'dev@meshtastic',
    });
    expect(text).not.toContain('client-key');
  });

  it('refuses a token Secret Kubernetes has not populated', () => {
    const args = { server: 'https://k8s:6443', tenant: 'alpha', user: 'alice' };
    expect(() => tenantKubeconfig({ ...args, secretData: undefined })).toThrow(
      'Token Secret for user alice in tenant alpha is not populated',
    );
    expect(() => tenantKubeconfig({ ...args, secretData: { token: secretData.token } })).toThrow(
      'not populated',
    );
  });
});

describe('kubeconfigServer', () => {
  const admin = `
apiVersion: v1
kind: Config
clusters:
  - name: one
    cluster: { server: 'https://10.0.0.1:6443', certificate-authority-data: x }
  - name: two
    cluster: { server: 'https://127.0.0.1:16443' }
  - name: plain
    cluster: { server: 'http://127.0.0.1:8080' }
contexts:
  - name: first
    context: { cluster: one, user: admin }
  - name: second
    context: { cluster: two, user: admin }
  - name: insecure
    context: { cluster: plain, user: admin }
current-context: first
`;

  it("resolves the selected context's cluster server, defaulting to current-context", () => {
    expect(kubeconfigServer(admin)).toBe('https://10.0.0.1:6443');
    expect(kubeconfigServer(admin, 'second')).toBe('https://127.0.0.1:16443');
  });

  it('returns undefined when the server cannot be resolved unambiguously', () => {
    expect(kubeconfigServer(admin, 'missing')).toBeUndefined();
    expect(kubeconfigServer(admin, 'insecure')).toBeUndefined();
    expect(kubeconfigServer(admin.replace('current-context: first', ''))).toBeUndefined();
    expect(kubeconfigServer('clusters: [')).toBeUndefined();
    expect(kubeconfigServer('just text')).toBeUndefined();
    expect(kubeconfigServer('contexts: {}\ncurrent-context: x')).toBeUndefined();
  });
});
