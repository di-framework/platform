import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = import.meta.dir;
const dist = join(pkgDir, 'dist');

// `dist/` is gitignored and only produced by `make build`. Skip artifact checks
// when it is absent so contributors who did not touch this package still get a
// green `bun test`. CI builds it and sets OCI_REGISTRY_REQUIRE_DIST=1.
const built =
  existsSync(join(dist, 'di-framework-oci-registry.wasm')) ||
  process.env.OCI_REGISTRY_REQUIRE_DIST === '1';

describe('oci-registry component package', () => {
  test.skipIf(!built)('dist artifacts exist', () => {
    for (const file of [
      'di-framework-oci-registry.wasm',
      'di-framework-oci-registry.wit',
      'BUILD-INFO.txt',
      'SHA256SUMS',
    ]) {
      expect(existsSync(join(dist, file)), file).toBe(true);
    }
  });

  test.skipIf(!built)('built WIT serves HTTP and calls the tenant controller', () => {
    const wit = readFileSync(join(dist, 'di-framework-oci-registry.wit'), 'utf8');
    expect(wit).toContain('export wasi:http/handler@0.3.0');
    expect(wit).toContain('import wasi:http/client@0.3.0');
    expect(wit).toContain('import wasmcloud:blobstore/container@0.1.0');
    expect(wit).toContain('import wasmcloud:secrets/store@2.1.0');
  });

  test('keeps the upstream license and records the source commit', () => {
    expect(readFileSync(join(pkgDir, 'LICENSE'), 'utf8')).toContain('Apache License');
    const readme = readFileSync(join(pkgDir, 'README.md'), 'utf8');
    expect(readme).toContain('ee52f49e88e1f9fe4cf001bd232e0bbc6b52bcb3');
    expect(existsSync(join(pkgDir, 'conformance.md'))).toBe(true);
  });

  test('source no longer carries a shared Basic credential', () => {
    const auth = readFileSync(join(pkgDir, 'src', 'auth.rs'), 'utf8');
    expect(auth).not.toContain('registry-password');
    expect(auth).toContain('/v1/auth/whoami');
    const dev = readFileSync(join(pkgDir, '.wash', 'config.yaml'), 'utf8');
    expect(dev).not.toContain('registry-password');
    expect(dev).toContain('tenant-controller-url');
  });
});
