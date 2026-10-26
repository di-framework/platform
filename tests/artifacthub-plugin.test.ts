/**
 * The Headlamp plugin's Artifact Hub entries and version bump (#435): scripts/artifacthub-plugin.ts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ARTIFACTHUB_DIR,
  archiveUrl,
  assertVersion,
  CHART_VALUES,
  entryDir,
  main,
  PLUGIN_DIR,
  recordedSha256,
  rfc3339,
  SOURCE,
  setChartVersion,
  tarballName,
  verifyEntry,
  writeEntry,
} from '../scripts/artifacthub-plugin';
import { spawnEnv } from './helpers/spawn-env';

const repo = resolve(import.meta.dir, '..');
const AT = '2026-10-26T12:00:00Z';
const read = (path: string) => readFileSync(path, 'utf8');

/** A scratch copy of the files the script reads and writes. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'artifacthub-plugin-'));
  for (const file of [`${PLUGIN_DIR}/package.json`, CHART_VALUES]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repo, file), join(root, file));
  }
  return root;
}

/** Writes a fake packed tarball; returns its sha256. */
function pack(root: string, version: string, bytes = `tarball ${version}`): string {
  const dir = join(root, PLUGIN_DIR, 'dist-package');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, tarballName(version)), bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

let logs: string[];
let errors: string[];
beforeEach(() => {
  logs = [];
  errors = [];
  spyOn(console, 'log').mockImplementation((m: string) => void logs.push(m));
  spyOn(console, 'error').mockImplementation((m: string) => void errors.push(m));
});
afterEach(() => {
  (console.log as unknown as { mockRestore(): void }).mockRestore();
  (console.error as unknown as { mockRestore(): void }).mockRestore();
});

describe('the repository', () => {
  test('the chart installs the plugin from its Artifact Hub package at the plugin version', () => {
    const values = Bun.YAML.parse(read(join(repo, CHART_VALUES))) as {
      headlamp: { enabled: boolean; pluginsManager: { enabled: boolean; configContent: string } };
    };
    const pkg = JSON.parse(read(join(repo, PLUGIN_DIR, 'package.json')));
    expect(values.headlamp.enabled).toBe(false);
    expect(values.headlamp.pluginsManager.enabled).toBe(true);
    expect(Bun.YAML.parse(values.headlamp.pluginsManager.configContent)).toEqual({
      plugins: [{ name: 'di-framework-platform', source: SOURCE, version: pkg.version }],
    });
  });

  test('artifacthub-repo.yml names the registered repository and its owner', () => {
    expect(Bun.YAML.parse(read(join(repo, ARTIFACTHUB_DIR, 'artifacthub-repo.yml')))).toEqual({
      repositoryID: '77c7ba33-a42d-4f30-bc77-6cdf5b78d51b',
      owners: [{ name: 'geoffsee', email: 'gseemueller@gmail.com' }],
    });
  });

  test('every committed entry is a version directory with a package and a README', () => {
    for (const entry of readdirSync(join(repo, ARTIFACTHUB_DIR), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      expect(entry.name).toMatch(/^\d+\.\d+\.\d+$/);
      const dir = join(repo, ARTIFACTHUB_DIR, entry.name);
      const pkg = Bun.YAML.parse(read(join(dir, 'artifacthub-pkg.yml'))) as { version: string };
      expect(pkg.version).toBe(entry.name);
      expect(existsSync(join(dir, 'README.md'))).toBe(true);
    }
  });
});

describe('versions and names', () => {
  test('assertVersion accepts release versions only', () => {
    expect(assertVersion('6.0.18')).toBe('6.0.18');
    for (const bad of [undefined, '', 'v6.0.18', '6.0', '6.0.18-rc.1']) {
      expect(() => assertVersion(bad)).toThrow('expected a release version');
    }
  });

  test('the archive URL is the release asset of the same version', () => {
    expect(archiveUrl('6.0.18')).toBe(
      'https://github.com/di-framework/platform/releases/download/v6.0.18/di-framework-platform-6.0.18.tar.gz',
    );
    expect(entryDir('6.0.18')).toBe(`${ARTIFACTHUB_DIR}/6.0.18`);
  });

  test('rfc3339 is UTC with whole seconds', () => {
    expect(rfc3339(new Date('2026-10-26T12:00:00.789Z'))).toBe(AT);
  });
});

// The repository's own plugin version: the release PR moves it, so the bump tests target a
// version that is never the current one.
const CURRENT: string = JSON.parse(read(join(repo, PLUGIN_DIR, 'package.json'))).version;
const NEXT = '9.9.9';

describe('setChartVersion', () => {
  const values = read(join(repo, CHART_VALUES));

  test('rewrites only the plugin entry version line', () => {
    expect(CURRENT).not.toBe(NEXT);
    const out = setChartVersion(values, NEXT);
    const before = values.split('\n');
    const after = out.split('\n');
    const changed = before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]));
    expect(changed).toEqual([[`          version: ${CURRENT}`, `          version: ${NEXT}`]]);
    expect(out).toContain('    version: 0.1.1\n');
    expect(setChartVersion(out, NEXT)).toBe(out);
  });

  test('fails when the plugin entry is gone', () => {
    expect(() => setChartVersion(values.replace(SOURCE, 'https://example.com/x'), '1.0.0')).toThrow(
      'no di-framework-platform plugin entry',
    );
  });
});

describe('set-version', () => {
  test('moves the plugin package.json and the chart line, nothing else', () => {
    const root = scratch();
    expect(main(['set-version', NEXT], root)).toBe(0);
    const pkg = JSON.parse(read(join(root, PLUGIN_DIR, 'package.json')));
    const original = JSON.parse(read(join(repo, PLUGIN_DIR, 'package.json')));
    expect(pkg).toEqual({ ...original, version: NEXT });
    expect(pkg.version).not.toBe(original.version);
    expect(read(join(root, CHART_VALUES))).toBe(
      setChartVersion(read(join(repo, CHART_VALUES)), NEXT),
    );
    expect(read(join(root, CHART_VALUES))).toContain(`version: ${NEXT}\n`);
    expect(logs).toEqual([`Set the Headlamp plugin version to ${NEXT}`]);
  });
});

describe('write', () => {
  test('writes the Artifact Hub package and README from the tarball checksum', () => {
    const root = scratch();
    const sha = pack(root, '6.0.18');
    expect(main(['write', '6.0.18', '--created-at', AT], root)).toBe(0);
    const dir = join(root, entryDir('6.0.18'));
    expect(Bun.YAML.parse(read(join(dir, 'artifacthub-pkg.yml')))).toEqual({
      version: '6.0.18',
      name: 'di-framework-platform',
      displayName: 'di-framework Platform Instances',
      createdAt: AT,
      description: 'Manage di-framework PlatformInstances from Headlamp.',
      homeURL: `https://github.com/di-framework/platform/blob/v6.0.18/${PLUGIN_DIR}/README.md`,
      license: 'MIT OR Apache-2.0',
      keywords: ['headlamp', 'kubernetes', 'di-framework'],
      links: [
        {
          name: 'source',
          url: `https://github.com/di-framework/platform/tree/v6.0.18/${PLUGIN_DIR}`,
        },
      ],
      annotations: {
        'headlamp/plugin/archive-url': archiveUrl('6.0.18'),
        'headlamp/plugin/archive-checksum': `sha256:${sha}`,
        'headlamp/plugin/version-compat': '>=0.46.0',
        'headlamp/plugin/distro-compat': 'in-cluster,web,app',
      },
    });
    expect(read(join(dir, 'README.md'))).toContain('# di-framework Platform Instances 6.0.18');
    expect(logs).toEqual([`Wrote ${entryDir('6.0.18')}`]);
  });

  test('defaults createdAt to now', () => {
    const root = scratch();
    pack(root, '6.0.18');
    expect(main(['write', '6.0.18'], root, () => new Date('2026-01-02T03:04:05.6Z'))).toBe(0);
    const yaml = read(join(root, entryDir('6.0.18'), 'artifacthub-pkg.yml'));
    expect(yaml).toContain('createdAt: "2026-01-02T03:04:05Z"');
  });

  test('is idempotent: the same tarball keeps the entry as it is', () => {
    const root = scratch();
    pack(root, '6.0.18');
    expect(writeEntry(root, '6.0.18', AT)).toBe(true);
    const before = read(join(root, entryDir('6.0.18'), 'artifacthub-pkg.yml'));
    expect(main(['write', '6.0.18', '--created-at', '2027-01-01T00:00:00Z'], root)).toBe(0);
    expect(read(join(root, entryDir('6.0.18'), 'artifacthub-pkg.yml'))).toBe(before);
    expect(logs).toEqual([`${entryDir('6.0.18')} is already up to date`]);
  });

  test('restores a missing README when the entry has the same checksum', () => {
    const root = scratch();
    pack(root, '6.0.18');
    writeEntry(root, '6.0.18', AT);
    const dir = join(root, entryDir('6.0.18'));
    const pkgBefore = read(join(dir, 'artifacthub-pkg.yml'));
    rmSync(join(dir, 'README.md'));
    expect(writeEntry(root, '6.0.18', '2027-01-01T00:00:00Z')).toBe(true);
    expect(read(join(dir, 'README.md'))).toContain('# di-framework Platform Instances 6.0.18');
    expect(read(join(dir, 'artifacthub-pkg.yml'))).toBe(pkgBefore);
    rmSync(join(dir, 'README.md'));
    pack(root, '6.0.18', 'other bytes');
    expect(() => writeEntry(root, '6.0.18', AT)).toThrow('a published version is not rewritten');
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
  });

  test('refuses to rewrite a published version with a different checksum', () => {
    const root = scratch();
    pack(root, '6.0.18');
    writeEntry(root, '6.0.18', AT);
    const before = read(join(root, entryDir('6.0.18'), 'artifacthub-pkg.yml'));
    pack(root, '6.0.18', 'other bytes');
    expect(main(['write', '6.0.18'], root)).toBe(1);
    expect(errors[0]).toContain('a published version is not rewritten');
    expect(read(join(root, entryDir('6.0.18'), 'artifacthub-pkg.yml'))).toBe(before);
  });

  test('needs a packed tarball and an RFC 3339 UTC time', () => {
    const root = scratch();
    expect(main(['write', '6.0.18', '--created-at', AT], root)).toBe(1);
    expect(errors[0]).toContain('run `bun run package` first');
    pack(root, '6.0.18');
    expect(main(['write', '6.0.18', '--created-at'], root)).toBe(1);
    expect(errors[1]).toContain('createdAt must be RFC 3339 UTC');
    expect(existsSync(join(root, entryDir('6.0.18')))).toBe(false);
  });
});

describe('verify', () => {
  test('a missing entry passes unless required', () => {
    const root = scratch();
    expect(main(['verify', '0.1.0'], root)).toBe(0);
    expect(logs[0]).toContain('no Artifact Hub entry for 0.1.0');
    expect(main(['verify', '0.1.0', '--required'], root)).toBe(1);
    expect(errors[0]).toContain('artifacthub-pkg.yml is missing');
  });

  test('passes when the tarball matches, fails when it differs', () => {
    const root = scratch();
    const sha = pack(root, '6.0.18');
    writeEntry(root, '6.0.18', AT);
    expect(verifyEntry(root, '6.0.18', true)).toContain(`sha256:${sha}`);
    pack(root, '6.0.18', 'rebuilt differently');
    expect(main(['verify', '6.0.18', '--required'], root)).toBe(1);
    expect(errors[0]).toMatch(/^::error::di-framework-platform-6\.0\.18\.tar\.gz is sha256:/);
  });

  test('recordedSha256 reads the archive checksum annotation', () => {
    const hex = 'b'.repeat(64);
    expect(recordedSha256(`  headlamp/plugin/archive-checksum: sha256:${hex}\n`)).toBe(hex);
    expect(recordedSha256('version: 1.0.0\n')).toBeUndefined();
  });
});

describe('the command line', () => {
  test('rejects an unknown command or a bad version', () => {
    expect(main(['publish', '6.0.18'], scratch())).toBe(1);
    expect(main(['write'], scratch())).toBe(1);
    expect(errors[0]).toContain('unknown command "publish"');
    expect(errors[1]).toContain('expected a release version');
  });

  test('runs as a script from the repository root', () => {
    const root = scratch();
    const result = Bun.spawnSync(
      ['bun', join(repo, 'scripts/artifacthub-plugin.ts'), 'verify', '0.1.0'],
      {
        cwd: root,
        env: spawnEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('nothing to verify');
  });
});
