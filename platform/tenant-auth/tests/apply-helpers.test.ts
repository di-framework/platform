import { describe, expect, test } from 'bun:test';
import {
  APPLY_ARGS,
  assertBundleSize,
  assertDigestsMatch,
  MAX_CONFIGMAP_DATA_BYTES,
  sha256,
  splitManifests,
} from '../scripts/apply-helpers.ts';

describe('deploy-local apply helpers', () => {
  test('uses server-side apply with force-conflicts', () => {
    expect(APPLY_ARGS).toContain('--server-side');
    expect(APPLY_ARGS).toContain('--force-conflicts');
    expect(APPLY_ARGS).toContain('--field-manager=tenant-auth-deploy-local');
  });

  test('splits config objects from Deployments', () => {
    const { config, workloads } = splitManifests([
      { kind: 'ConfigMap' },
      { kind: 'Deployment' },
      { kind: 'Service' },
    ]);
    expect(config.map((m) => m.kind)).toEqual(['ConfigMap', 'Service']);
    expect(workloads.map((m) => m.kind)).toEqual(['Deployment']);
  });

  test('size guard passes small and rejects oversized bundles', () => {
    expect(() => assertBundleSize({ a: 'x'.repeat(320_000) })).not.toThrow();
    expect(() => assertBundleSize({ a: 'x'.repeat(MAX_CONFIGMAP_DATA_BYTES), b: 'y' })).toThrow(
      /over the/,
    );
  });

  test('digest comparison', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(() => assertDigestsMatch('a', 'a')).not.toThrow();
    expect(() => assertDigestsMatch('a', 'b')).toThrow(/does not match/);
  });
});
