import { describe, expect, it } from 'bun:test';
import { CONTAINERD_DROP_IN, registryMirrorFiles, registryMirrors } from '../src/registry-mirrors';

describe('registryMirrors', () => {
  it('means no mirrors when unset or empty', () => {
    expect(registryMirrors(undefined)).toBeUndefined();
    expect(registryMirrors(null)).toBeUndefined();
    expect(registryMirrors({})).toBeUndefined();
    expect(registryMirrorFiles(undefined)).toEqual([]);
  });

  it('accepts registry hosts and ordered http(s) mirror URLs, sorting registries', () => {
    expect(
      registryMirrors({
        'registry.example:5000': ['http://10.0.0.1:5000', 'https://mirror.example/v2/proxy/'],
        'docker.io': ['https://mirror.gcr.io', 'https://registry.example'],
      }),
    ).toEqual({
      'docker.io': ['https://mirror.gcr.io', 'https://registry.example'],
      'registry.example:5000': ['http://10.0.0.1:5000', 'https://mirror.example/v2/proxy/'],
    });
  });

  it('rejects values that are not a registry-to-list object', () => {
    for (const value of ['docker.io', 1, true, [['docker.io', ['https://mirror.gcr.io']]]]) {
      expect(() => registryMirrors(value)).toThrow('registryMirrors must be an object');
    }
  });

  it('rejects registry hosts that are not plain lowercase host names or host:port', () => {
    for (const registry of [
      '',
      'Docker.io',
      'docker.io/library',
      'https://docker.io',
      '-docker.io',
      'docker..io',
      'docker.io:0',
      'docker.io:65536',
      'docker.io:',
      'docker io',
      '_default',
      '../etc',
      "docker.io'",
      'docker.io"',
      'docker.io;id',
      '$(id)',
      'docker.io\n',
    ]) {
      expect(() => registryMirrors({ [registry]: ['https://mirror.gcr.io'] })).toThrow(
        'registryMirrors key must be a lowercase registry host or host:port',
      );
    }
  });

  it('rejects mirror lists that are empty, not lists, or repeat a mirror', () => {
    for (const urls of [[], 'https://mirror.gcr.io', undefined, {}]) {
      expect(() => registryMirrors({ 'docker.io': urls })).toThrow(
        'registryMirrors.docker.io must be a non-empty list of mirror URLs',
      );
    }
    expect(() =>
      registryMirrors({ 'docker.io': ['https://mirror.gcr.io', 'https://mirror.gcr.io'] }),
    ).toThrow('registryMirrors.docker.io lists a mirror more than once');
  });

  it('rejects mirror URLs with other schemes, credentials, queries, quotes, or shell text', () => {
    for (const url of [
      1,
      '',
      'mirror.gcr.io',
      'ftp://mirror.gcr.io',
      'HTTPS://mirror.gcr.io',
      'https://Mirror.gcr.io',
      'https://user:pass@mirror.gcr.io',
      'https://mirror.gcr.io?x=1',
      'https://mirror.gcr.io#x',
      'https://mirror.gcr.io/a b',
      'https://mirror.gcr.io/"]',
      "https://mirror.gcr.io/'",
      'https://mirror.gcr.io/$(id)',
      'https://mirror.gcr.io/`id`',
      'https://mirror.gcr.io;id',
      'https://mirror.gcr.io/a\\b',
      'https://mirror.gcr.io/a//b',
      'https://mirror.gcr.io\n',
      'https://mirror.gcr.io:99999',
    ]) {
      expect(() => registryMirrors({ 'docker.io': [url] })).toThrow(
        'registryMirrors.docker.io entries must be http:// or https:// URLs',
      );
    }
  });
});

describe('registryMirrorFiles', () => {
  it('writes a containerd drop-in and one hosts.toml per registry with mirrors before upstream', () => {
    const files = registryMirrorFiles(
      registryMirrors({
        'ghcr.io': ['https://ghcr.mirror.example/proxy', 'http://10.0.0.1:5000'],
        'docker.io': ['https://mirror.gcr.io'],
      }),
    );
    expect(files).toEqual([
      {
        path: CONTAINERD_DROP_IN,
        variable: 'DI_K0S_FILE_0',
        content:
          '# Managed by @di-framework/platform: registry mirrors.\n' +
          'version = 3\n' +
          '\n' +
          '[plugins."io.containerd.cri.v1.images".registry]\n' +
          '  config_path = "/etc/containerd/certs.d"\n',
      },
      {
        path: '/etc/containerd/certs.d/docker.io/hosts.toml',
        variable: 'DI_K0S_FILE_1',
        content:
          '# Managed by @di-framework/platform: registry mirrors.\n' +
          'server = "https://registry-1.docker.io"\n' +
          '\n' +
          '[host."https://mirror.gcr.io"]\n' +
          '  capabilities = ["pull", "resolve"]\n',
      },
      {
        path: '/etc/containerd/certs.d/ghcr.io/hosts.toml',
        variable: 'DI_K0S_FILE_2',
        content:
          '# Managed by @di-framework/platform: registry mirrors.\n' +
          'server = "https://ghcr.io"\n' +
          '\n' +
          '[host."https://ghcr.mirror.example/proxy"]\n' +
          '  capabilities = ["pull", "resolve"]\n' +
          '\n' +
          '[host."http://10.0.0.1:5000"]\n' +
          '  capabilities = ["pull", "resolve"]\n',
      },
    ]);
    expect(CONTAINERD_DROP_IN).toBe('/etc/k0s/containerd.d/di-framework-registry-mirrors.toml');
  });
});
