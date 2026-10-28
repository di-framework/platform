/**
 * The install project the operator image bakes and its release bump (#431): scripts/operator-project.ts.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  bakedPlugins,
  bump,
  checksumsUrl,
  main,
  PLATFORM_PACKAGE,
  PROJECT_DIR,
  parseChecksums,
  providers,
  renderPlugins,
  setPlatformVersion,
} from '../scripts/operator-project';

const repo = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
const SUM = (c: string) => c.repeat(64);

/** A scratch repo with the committed project. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'operator-project-'));
  mkdirSync(join(root, PROJECT_DIR), { recursive: true });
  for (const f of ['package.json', 'package-lock.json', 'plugins.txt']) {
    cpSync(join(repo, PROJECT_DIR, f), join(root, PROJECT_DIR, f));
  }
  return root;
}

/** A lockfile installing the platform at version with the given providers. */
function lockFor(version: string, provs: Record<string, string>) {
  const packages: Record<string, { version: string }> = {
    '': { version: '' },
    [`node_modules/${PLATFORM_PACKAGE}`]: { version },
    'node_modules/@pulumi/pulumi': { version: '3.0.0' },
  };
  for (const [name, v] of Object.entries(provs))
    packages[`node_modules/@pulumi/${name}`] = { version: v };
  return JSON.stringify({ packages });
}

const checksums = (name: string, version: string) =>
  ['amd64', 'arm64']
    .map(
      (arch, i) =>
        `${SUM(String(i + 1))}  pulumi-resource-${name}-v${version}-linux-${arch}.tar.gz`,
    )
    .concat([`${SUM('9')}  pulumi-resource-${name}-v${version}-darwin-arm64.tar.gz`])
    .join('\n');

describe('the committed project', () => {
  const pkg = JSON.parse(read(`${PROJECT_DIR}/package.json`));
  const lock = read(`${PROJECT_DIR}/package-lock.json`);
  const plugins = read(`${PROJECT_DIR}/plugins.txt`);

  test('pins an exact platform version that the lockfile installs', () => {
    const version = pkg.dependencies[PLATFORM_PACKAGE];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(lock).packages[`node_modules/${PLATFORM_PACKAGE}`].version).toBe(version);
  });

  test('plugins.txt is what the bump writes for the lockfile', () => {
    const sums = new Map(
      [...providers(lock)].map(([name]) => {
        const lines = plugins.split('\n').filter((l) => l.startsWith(`${name} `));
        const byArch = Object.fromEntries(lines.map((l) => [l.split(' ')[2], l.split(' ')[3]]));
        return [name, byArch as { amd64: string; arm64: string }];
      }),
    );
    expect(renderPlugins(providers(lock), sums)).toBe(plugins);
    expect([...providers(lock).keys()]).toEqual(['command', 'kubernetes']);
  });
});

describe('bump', () => {
  test('setPlatformVersion rewrites only the platform pin', () => {
    const text = read(`${PROJECT_DIR}/package.json`);
    const next = JSON.parse(setPlatformVersion(text, '9.9.9'));
    expect(next.dependencies[PLATFORM_PACKAGE]).toBe('9.9.9');
    expect({ ...next.dependencies, [PLATFORM_PACKAGE]: 'x' }).toEqual({
      ...JSON.parse(text).dependencies,
      [PLATFORM_PACKAGE]: 'x',
    });
    expect(() => setPlatformVersion('{"dependencies":{}}', '1.0.0')).toThrow(/no @di-framework/);
  });

  test('parseChecksums takes both linux archives and refuses a missing one', () => {
    expect(parseChecksums(checksums('kubernetes', '4.0.0'), 'kubernetes', '4.0.0')).toEqual({
      amd64: SUM('1'),
      arm64: SUM('2'),
    });
    expect(() => parseChecksums(checksums('kubernetes', '4.0.0'), 'kubernetes', '4.0.1')).toThrow(
      /no sha256 for pulumi-resource-kubernetes-v4.0.1-linux-amd64.tar.gz/,
    );
    expect(checksumsUrl('command', '1.2.1')).toBe(
      'https://github.com/pulumi/pulumi-command/releases/download/v1.2.1/pulumi-command_1.2.1_checksums.txt',
    );
  });

  test("pins npm's latest, relocks and rewrites plugins.txt for the new providers", async () => {
    const root = scratch();
    try {
      const fetched: string[] = [];
      const r = await bump(root, undefined, {
        latest: () => '6.9.0',
        lock: (dir) => {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
          const version = pkg.dependencies[PLATFORM_PACKAGE];
          writeFileSync(join(dir, 'package-lock.json'), lockFor(version, { kubernetes: '4.40.0' }));
        },
        checksums: async (name, version) => {
          fetched.push(`${name}@${version}`);
          return checksums(name, version);
        },
      });
      expect(r).toEqual({ version: '6.9.0', changed: true });
      expect(fetched).toEqual(['kubernetes@4.40.0']);
      const dir = join(root, PROJECT_DIR);
      expect(
        JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies[PLATFORM_PACKAGE],
      ).toBe('6.9.0');
      const plugins = readFileSync(join(dir, 'plugins.txt'), 'utf8');
      expect([...bakedPlugins(plugins)]).toEqual([['kubernetes', '4.40.0']]);
      expect(plugins).toContain(`kubernetes 4.40.0 amd64 ${SUM('1')}\n`);
      expect(plugins).toContain(`kubernetes 4.40.0 arm64 ${SUM('2')}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a current pin changes nothing and fetches no checksums', async () => {
    const root = scratch();
    try {
      const dir = join(root, PROJECT_DIR);
      const before = ['package.json', 'plugins.txt'].map((f) => readFileSync(join(dir, f), 'utf8'));
      const version = JSON.parse(before[0] as string).dependencies[PLATFORM_PACKAGE];
      const r = await bump(root, version, {
        latest: () => {
          throw new Error('not asked');
        },
        lock: () => {},
        checksums: async () => {
          throw new Error('not fetched');
        },
      });
      expect(r).toEqual({ version, changed: false });
      expect(
        ['package.json', 'plugins.txt'].map((f) => readFileSync(join(dir, f), 'utf8')),
      ).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('main refuses an unknown command or a non-release version', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['pin'])).toBe(1);
      expect(await main(['bump', 'latest'], scratch())).toBe(1);
      expect(err.mock.calls.map((c) => String(c[0]))).toEqual([
        '::error::unknown command "pin"',
        '::error::expected a release version like 6.0.22, got "latest"',
      ]);
    } finally {
      err.mockRestore();
    }
  });
});
