import { describe, expect, it } from 'bun:test';
import {
  assertHostImageSupportsAllowlist,
  platformRegistryPullHost,
  tenantInsecureRegistries,
} from '../src/insecure-registries';

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

  it('refuses an insecureRegistries value that is not a list', () => {
    for (const extra of ['reg:5000', { reg: 5000 }])
      expect(() =>
        tenantInsecureRegistries({
          insecureRegistry: true,
          namespace: 'n',
          extra: extra as unknown as string[],
        }),
      ).toThrow('insecureRegistries must be a list of host[:port]');
  });

  it('refuses a tenantHostImage built before patch 0002 once the allowlist is non-empty', () => {
    const old =
      'ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:ee89fd4bce4f9f35f4cd09c63d3cbdd07bea3071b5d372f82c9f49b9741c3669';
    expect(() => assertHostImageSupportsAllowlist(old, [PLATFORM])).toThrow(
      `tenantHostImage ${old} predates wash patch 0002 and rejects --insecure-registry`,
    );
    // Without an allowlist the old image gets no --insecure-registry and still starts.
    expect(() => assertHostImageSupportsAllowlist(old, [])).not.toThrow();
    const current =
      'ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:d88158b0b09edd9fc3e79d787762697c60f65baf134d895529e85d6c47cd80ad';
    expect(() => assertHostImageSupportsAllowlist(current, [PLATFORM])).not.toThrow();
  });
});
