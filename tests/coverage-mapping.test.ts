import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  calculatePackageMetrics,
  generateShieldBadgeJson,
  getPackageSlugFromPath,
  getWorkspacePackages,
  isSourceFile,
  parseLcov,
  writeShieldBadgeFiles,
} from '../scripts/coverage-mapping';

const repoRoot = resolve(import.meta.dir, '..');

function writePackage(root: string, relPath: string, name: string): void {
  const dir = join(root, relPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
}

describe('coverage badge mapping', () => {
  it('discovers every @di-framework package, including nested ones', () => {
    const packages = getWorkspacePackages(repoRoot);
    expect(packages.map((pkg) => pkg.name)).toEqual([
      '@di-framework/backup-agent',
      '@di-framework/backup-destination',
      '@di-framework/bindings',
      '@di-framework/cloudflare',
      '@di-framework/cloudfoundry',
      '@di-framework/pglite-component',
      '@di-framework/platform',
      '@di-framework/sqlite-component',
    ]);
    expect(packages.map((pkg) => pkg.slug)).toEqual([
      'backup-agent',
      'backup-destination',
      'bindings',
      'cloudflare',
      'cloudfoundry',
      'pglite-component',
      'platform',
      'sqlite-component',
    ]);
    expect(packages.find((pkg) => pkg.slug === 'platform')?.relPath).toBe('platform/platform');
    expect(packages.find((pkg) => pkg.slug === 'cloudfoundry')?.relPath).toBe(
      'adapters/cloudfoundry',
    );
  });

  it('skips hidden directories such as local agent plugin state', () => {
    const root = mkdtempSync(join(tmpdir(), 'cov-hidden-'));
    writePackage(root, 'platform/real', '@di-framework/real');
    writePackage(root, '.di-framework/plugin', '@di-framework/plugin');
    writePackage(root, '.tools/cache', '@di-framework/cached');
    expect(getWorkspacePackages(root).map((pkg) => pkg.name)).toEqual(['@di-framework/real']);
  });

  it('maps source files onto package slugs and ignores tests', () => {
    getWorkspacePackages(repoRoot);
    expect(getPackageSlugFromPath('platform/platform/src/index.ts')).toBe('platform');
    expect(getPackageSlugFromPath('adapters/cloudfoundry/src/index.ts')).toBe('cloudfoundry');
    expect(getPackageSlugFromPath(join(repoRoot, 'platform/bindings/src/index.ts'))).toBe(
      'bindings',
    );
    expect(isSourceFile('platform/platform/src/index.ts')).toBe(true);
    expect(isSourceFile('platform/platform/tests/platform.test.ts')).toBe(false);
    expect(isSourceFile('adapters/cloudfoundry/src/index.test.ts')).toBe(false);
    expect(isSourceFile('scripts/publish-workspace.ts')).toBe(false);
  });

  it('does not treat a checkout named platform/platform as the platform package', () => {
    const runner = mkdtempSync(join(tmpdir(), 'work-'));
    const checkout = join(runner, 'platform', 'platform');
    writePackage(checkout, 'platform/platform', '@di-framework/platform');
    writePackage(checkout, 'adapters/cloudfoundry', '@di-framework/cloudfoundry');
    writePackage(checkout, 'node_modules/@di-framework/core', '@di-framework/core');
    writePackage(checkout, 'sqlite-src/platform/platform', '@di-framework/platform');
    writeFileSync(join(checkout, 'sqlite-src', '.git'), 'gitdir: /tmp/sqlite\n');

    const packages = getWorkspacePackages(checkout);
    expect(packages.map((pkg) => pkg.slug)).toEqual(['cloudfoundry', 'platform']);
    expect(getPackageSlugFromPath(join(checkout, 'adapters/cloudfoundry/src/index.ts'))).toBe(
      'cloudfoundry',
    );
    expect(getPackageSlugFromPath(join(checkout, 'platform/platform/src/index.ts'))).toBe(
      'platform',
    );
    expect(isSourceFile(join(checkout, 'platform/platform/tests/index.test.ts'))).toBe(false);
  });

  it('writes Shields endpoint JSON for each discovered package', () => {
    const root = mkdtempSync(join(tmpdir(), 'cov-pkgs-'));
    writePackage(root, 'platform/platform', '@di-framework/platform');
    writePackage(root, 'adapters/cloudfoundry', '@di-framework/cloudfoundry');
    const packages = getWorkspacePackages(root);
    const lcov = `
SF:${join(root, 'platform/platform/src/index.ts')}
DA:1,1
DA:2,0
end_of_record
SF:${join(root, 'adapters/cloudfoundry/src/index.ts')}
DA:1,1
end_of_record
SF:${join(root, 'adapters/cloudfoundry/tests/index.test.ts')}
DA:1,1
end_of_record
`;
    const metrics = calculatePackageMetrics(packages, parseLcov(lcov));
    const platform = metrics.find((metric) => metric.slug === 'platform');
    const cloudfoundry = metrics.find((metric) => metric.slug === 'cloudfoundry');
    if (!platform || !cloudfoundry) throw new Error('missing package metric');
    expect(platform.badgeMessage).toBe('50%');
    expect(cloudfoundry.badgeMessage).toBe('100%');
    expect(generateShieldBadgeJson(platform)).toEqual({
      schemaVersion: 1,
      label: 'line coverage',
      message: '50%',
      color: 'red',
    });

    const outDir = join(root, 'coverage', 'badges');
    const written = writeShieldBadgeFiles(metrics, outDir);
    expect(written.map((file) => file.slice(outDir.length + 1)).sort()).toEqual([
      'cloudfoundry.json',
      'platform.json',
    ]);
  });
});
