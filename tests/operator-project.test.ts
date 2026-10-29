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
  compareVersions,
  EXIT_REFUSED,
  EXIT_RETRY,
  main,
  npmDeps,
  npmFailure,
  PLATFORM_PACKAGE,
  PROJECT_DIR,
  parseChecksums,
  providers,
  RetryableError,
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
        published: () => {
          throw new Error('npm latest is published by definition');
        },
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

  test('bump <version> (what release.yml runs) pins exactly that version, never npm latest', async () => {
    const root = scratch();
    try {
      const dir = join(root, PROJECT_DIR);
      const current = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies[
        PLATFORM_PACKAGE
      ] as string;
      const [major, minor, patch] = current.split('.').map(Number);
      const release = `${major}.${minor}.${(patch as number) + 1}`;
      const locked: string[] = [];
      const code = await main(['bump', release], root, {
        latest: () => {
          throw new Error('npm latest must not be asked for an explicit version');
        },
        published: (v) => v === release,
        lock: (d) => {
          const v = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).dependencies[
            PLATFORM_PACKAGE
          ];
          locked.push(v);
          writeFileSync(join(d, 'package-lock.json'), lockFor(v, { kubernetes: '4.40.0' }));
        },
        checksums: async (name, v) => checksums(name, v),
      });
      expect(code).toBe(0);
      expect(locked).toEqual([release]);
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      expect(pkg.dependencies[PLATFORM_PACKAGE]).toBe(release);
      const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
      expect(lock.packages[`node_modules/${PLATFORM_PACKAGE}`].version).toBe(release);
      // Only the platform pin moves: every other dependency is kept as committed.
      const committed = JSON.parse(read(`${PROJECT_DIR}/package.json`));
      expect({ ...pkg.dependencies, [PLATFORM_PACKAGE]: undefined }).toEqual({
        ...committed.dependencies,
        [PLATFORM_PACKAGE]: undefined,
      });
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
        published: () => true,
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

  test('compareVersions orders release versions numerically', () => {
    expect(compareVersions('6.0.9', '6.0.10')).toBeLessThan(0);
    expect(compareVersions('6.1.0', '6.0.22')).toBeGreaterThan(0);
    expect(compareVersions('6.0.22', '6.0.22')).toBe(0);
  });

  test('refuses to move the pin to an older version and changes nothing', async () => {
    const root = scratch();
    try {
      const dir = join(root, PROJECT_DIR);
      const files = ['package.json', 'package-lock.json', 'plugins.txt'];
      const before = files.map((f) => readFileSync(join(dir, f), 'utf8'));
      const pinned = JSON.parse(before[0] as string).dependencies[PLATFORM_PACKAGE] as string;
      const deps = {
        latest: () => '0.0.1',
        published: () => {
          throw new Error('not asked: the downgrade is refused first');
        },
        lock: () => {
          throw new Error('not relocked');
        },
        checksums: async () => {
          throw new Error('not fetched');
        },
      };
      await expect(bump(root, undefined, deps)).rejects.toThrow(
        `refusing to move the pin back from ${pinned} to 0.0.1`,
      );
      await expect(bump(root, '0.0.1', deps)).rejects.toThrow('refusing to move the pin back');
      expect(files.map((f) => readFileSync(join(dir, f), 'utf8'))).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('main refuses an unknown command, a non-release or prerelease version: exit 2, never retried (#523)', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(EXIT_REFUSED).toBe(2);
      expect(await main(['pin'])).toBe(EXIT_REFUSED);
      expect(await main(['bump', 'latest'], scratch())).toBe(EXIT_REFUSED);
      expect(await main(['bump', '6.0.24-rc.1'], scratch())).toBe(EXIT_REFUSED);
      expect(err.mock.calls.map((c) => String(c[0]))).toEqual([
        '::error::unknown command "pin"',
        '::error::expected a release version like 6.0.22, got "latest"',
        '::error::expected a release version like 6.0.22, got "6.0.24-rc.1"',
      ]);
    } finally {
      err.mockRestore();
    }
  });

  /** Deps for an explicit bump to a version npm serves only when `served` says so. */
  const depsFor = (served: () => boolean, lock: (dir: string) => void = () => {}) => ({
    latest: () => {
      throw new Error('not asked');
    },
    published: served,
    lock,
    checksums: async (name: string, v: string) => checksums(name, v),
  });
  const nextRelease = (root: string) => {
    const pinned = JSON.parse(readFileSync(join(root, PROJECT_DIR, 'package.json'), 'utf8'))
      .dependencies[PLATFORM_PACKAGE] as string;
    const [major, minor, patch] = pinned.split('.').map(Number);
    return `${major}.${minor}.${(patch as number) + 1}`;
  };

  test('a version npm does not serve yet exits 75, which release.yml retries, and changes nothing (#523)', async () => {
    const root = scratch();
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(EXIT_RETRY).toBe(75);
      const dir = join(root, PROJECT_DIR);
      const files = ['package.json', 'package-lock.json', 'plugins.txt'];
      const before = files.map((f) => readFileSync(join(dir, f), 'utf8'));
      const release = nextRelease(root);
      const code = await main(
        ['bump', release],
        root,
        depsFor(
          () => false,
          () => {
            throw new Error('not relocked');
          },
        ),
      );
      expect(code).toBe(EXIT_RETRY);
      expect(String(err.mock.calls[0]?.[0])).toBe(
        `::notice::npm does not serve ${PLATFORM_PACKAGE}@${release} yet (retryable)`,
      );
      expect(files.map((f) => readFileSync(join(dir, f), 'utf8'))).toEqual(before);
    } finally {
      err.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a relock npm cannot resolve yet is retryable; any other relock failure exits 1 (#523)', async () => {
    const root = scratch();
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const release = nextRelease(root);
      const retry = depsFor(
        () => true,
        () => {
          throw npmFailure('npm install', 1, 'npm error code ETARGET\nnpm error notarget');
        },
      );
      expect(await main(['bump', release], root, retry)).toBe(EXIT_RETRY);
      const broken = depsFor(
        () => true,
        () => {
          throw npmFailure('npm install', 1, 'npm error code ERESOLVE');
        },
      );
      expect(await main(['bump', release], scratch(), broken)).toBe(1);
    } finally {
      err.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('npmFailure retries only a version not served yet or a registry failure (#523)', () => {
    const retryable = (stderr: string) => npmFailure('npm x', 1, stderr) instanceof RetryableError;
    expect(retryable('npm error code E404\nnpm error 404 No match found for version 9.9.9')).toBe(
      true,
    );
    expect(retryable('npm error code ETARGET')).toBe(true);
    expect(retryable('npm error code E503')).toBe(true);
    expect(retryable('npm error code ECONNRESET')).toBe(true);
    expect(retryable('npm error code EAI_AGAIN')).toBe(true);
    expect(retryable('npm error code ERESOLVE')).toBe(false);
    expect(retryable('npm error code EINTEGRITY')).toBe(false);
    expect(retryable('')).toBe(false);
  });
});

describe('npmDeps against a stubbed npm and GitHub (#523)', () => {
  /**
   * Runs fn with an `npm` on PATH that prints `stdout`, writes `stderr` and exits `code`, and
   * records its arguments.
   */
  const withNpm = <T>(code: number, stdout: string, stderr: string, fn: (log: string) => T): T => {
    const bin = mkdtempSync(join(tmpdir(), 'operator-project-npm-'));
    const log = join(bin, 'calls.log');
    writeFileSync(
      join(bin, 'npm'),
      `#!/bin/sh\necho "$*" >> "${log}"\nprintf '%s' '${stdout}'\nprintf '%s' '${stderr}' >&2\nexit ${code}\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      return fn(log);
    } finally {
      write.mockRestore();
      process.env.PATH = path;
      rmSync(bin, { recursive: true, force: true });
    }
  };

  test('latest is npm view <package> version; a failure is classified', () => {
    withNpm(0, '6.0.30\n', '', (log) => {
      expect(npmDeps.latest()).toBe('6.0.30');
      expect(readFileSync(log, 'utf8')).toContain(`view ${PLATFORM_PACKAGE} version`);
    });
    withNpm(1, '', 'npm error code ECONNRESET', () => {
      expect(() => npmDeps.latest()).toThrow(RetryableError);
    });
    withNpm(1, '', 'npm error code EACCES', () => {
      const error = (() => {
        try {
          npmDeps.latest();
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RetryableError);
    });
  });

  test('published is true only for exactly that version; E404 is "not yet"; other errors throw', () => {
    withNpm(0, '9.9.9\n', '', (log) => {
      expect(npmDeps.published('9.9.9')).toBe(true);
      expect(readFileSync(log, 'utf8')).toContain(`view ${PLATFORM_PACKAGE}@9.9.9 version`);
    });
    withNpm(0, '', '', () => expect(npmDeps.published('9.9.9')).toBe(false));
    withNpm(1, '', 'npm error code E404\nnpm error 404 No match found for version 9.9.9', () =>
      expect(npmDeps.published('9.9.9')).toBe(false),
    );
    withNpm(1, '', 'npm error code E503', () =>
      expect(() => npmDeps.published('9.9.9')).toThrow(RetryableError),
    );
    withNpm(1, '', 'npm error code EACCES', () =>
      expect(() => npmDeps.published('9.9.9')).toThrow('exited 1'),
    );
  });

  test('lock relocks in the project directory; a version npm cannot resolve yet is retryable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-project-lock-'));
    try {
      withNpm(0, '', '', (log) => {
        npmDeps.lock(dir);
        expect(readFileSync(log, 'utf8')).toContain(
          'install --package-lock-only --ignore-scripts --no-audit --no-fund',
        );
      });
      withNpm(1, '', 'npm error code ETARGET', () =>
        expect(() => npmDeps.lock(dir)).toThrow(RetryableError),
      );
      withNpm(1, '', 'npm error code ERESOLVE', () =>
        expect(() => npmDeps.lock(dir)).toThrow('exited 1'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checksums retries a network failure or a 5xx, not a 404', async () => {
    const respond = (impl: () => Promise<Response>) =>
      spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const outcome = async (impl: () => Promise<Response>) => {
      const f = respond(impl);
      try {
        return await npmDeps.checksums('command', '1.2.1').catch((e: unknown) => e);
      } finally {
        f.mockRestore();
      }
    };
    expect(await outcome(async () => new Response('sums'))).toBe('sums');
    const network = await outcome(async () => {
      throw new Error('socket hang up');
    });
    expect(network).toBeInstanceOf(RetryableError);
    expect(String(network)).toContain(checksumsUrl('command', '1.2.1'));
    expect(await outcome(async () => new Response('', { status: 502 }))).toBeInstanceOf(
      RetryableError,
    );
    const missing = await outcome(async () => new Response('', { status: 404 }));
    expect(missing).not.toBeInstanceOf(RetryableError);
    expect(String(missing)).toContain('HTTP 404');
  });
});
