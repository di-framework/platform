import { describe, expect, it } from 'bun:test';
import { platformRegistryPullHost, tenantInsecureRegistries } from '../src/insecure-registries';

describe('tenant insecure registries (#149)', () => {
  const PLATFORM = 'di-framework-registry.wasmcloud.svc.cluster.local:5000';

  it('spells the platform registry as workload references do', () => {
    expect(platformRegistryPullHost('wasmcloud')).toBe(PLATFORM);
  });

  it('is empty on a TLS install', () => {
    expect(tenantInsecureRegistries({ registry: true, namespace: 'wasmcloud' })).toEqual([]);
  });

  it('allowlists the platform registry, then configured ones, without duplicates', () => {
    expect(
      tenantInsecureRegistries({ insecureRegistry: true, registry: true, namespace: 'wasmcloud' }),
    ).toEqual([PLATFORM]);
    expect(
      tenantInsecureRegistries({
        insecureRegistry: true,
        registry: true,
        namespace: 'wasmcloud',
        extra: ['reg.example:5000', PLATFORM, 'reg.example:5000'],
      }),
    ).toEqual([PLATFORM, 'reg.example:5000']);
    // Existing clusters install no platform registry.
    expect(
      tenantInsecureRegistries({
        insecureRegistry: true,
        namespace: 'wasmcloud',
        extra: ['Reg.Example'],
      }),
    ).toEqual(['Reg.Example']);
  });

  it('refuses entries wash could never match, and entries without insecureRegistry', () => {
    for (const entry of ['http://reg:5000', 'reg:5000/path', '', 'reg:', 42 as unknown as string])
      expect(() =>
        tenantInsecureRegistries({ insecureRegistry: true, namespace: 'n', extra: [entry] }),
      ).toThrow('insecureRegistries entries must be a registry host[:port]');
    expect(() => tenantInsecureRegistries({ namespace: 'n', extra: ['reg:5000'] })).toThrow(
      'insecureRegistries requires insecureRegistry: true',
    );
  });
});
