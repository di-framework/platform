import { describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ARTIFACTS, parsePairs, pinArtifact, pinText } from '../scripts/pin-artifact';
import { git, sandboxClone, spawnEnv } from './helpers/spawn-env';

const repo = resolve(import.meta.dir, '..');
const env = spawnEnv;
const DIGEST = `sha256:${'1'.repeat(64)}`;
const OTHER = `sha256:${'2'.repeat(64)}`;

/** A scratch copy of every file the pin script may touch. */
function copyTargets(): string {
  const root = mkdtempSync(join(tmpdir(), 'pin-artifact-'));
  for (const file of new Set(Object.values(ARTIFACTS).flatMap((t) => t.map((x) => x.file)))) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repo, file), join(root, file));
  }
  return root;
}

describe('pinText', () => {
  const target = { file: 'x.md', ref: 'ghcr.io/di-framework/tenant-auth' };

  test('replaces a placeholder and an existing digest', () => {
    const text = [
      'image: ghcr.io/di-framework/tenant-auth@sha256:<digest from the workflow summary>',
      `old: ghcr.io/di-framework/tenant-auth@sha256:${'a'.repeat(64)}`,
      'tag: ghcr.io/di-framework/tenant-auth:latest',
    ].join('\n');
    const result = pinText(text, target, DIGEST);
    expect(result.matches).toBe(2);
    expect(result.text).toBe(
      [
        `image: ghcr.io/di-framework/tenant-auth@${DIGEST}`,
        `old: ghcr.io/di-framework/tenant-auth@${DIGEST}`,
        'tag: ghcr.io/di-framework/tenant-auth:latest',
      ].join('\n'),
    );
  });

  test('a variant ref does not match the longer variant, and linePrefix limits the lines', () => {
    const text = [
      `| \`wasi-tls\` | \`ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:${'a'.repeat(64)}\` |`,
      '| `wasi-tls-exclusive` | `ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@sha256:<pending>` |',
      `default: ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:${'a'.repeat(64)}`,
    ].join('\n');
    const [canonical, exclusive] = [
      ARTIFACTS['wash-wasi-tls'],
      ARTIFACTS['wash-wasi-tls-exclusive'],
    ];
    const one = pinText(text, { ...(canonical?.[0] ?? target), file: 'x' }, DIGEST);
    expect(one.matches).toBe(1);
    expect(one.text.split('\n')[1]).toContain('<pending>');
    expect(one.text.split('\n')[2]).toContain('a'.repeat(64));
    const two = pinText(text, { ...(exclusive?.[0] ?? target), file: 'x' }, OTHER);
    expect(two.matches).toBe(1);
    expect(two.text.split('\n')[0]).toContain('a'.repeat(64));
    expect(two.text.split('\n')[1]).toContain(`wasi-tls-exclusive@${OTHER}`);
  });

  test('rejects anything but a sha256 digest', () => {
    expect(() => pinText('', target, 'sha256:abc')).toThrow('not a sha256 digest');
    expect(() => pinText('', target, `sha512:${'1'.repeat(64)}`)).toThrow('not a sha256 digest');
  });
});

describe('pinArtifact against the repository files', () => {
  test.each(Object.keys(ARTIFACTS))('%s: every target matches, and a rerun is a no-op', (name) => {
    const root = copyTargets();
    const changed = pinArtifact(root, name, DIGEST);
    expect(changed.length).toBeGreaterThan(0);
    for (const file of changed) expect(readFileSync(join(root, file), 'utf8')).toContain(DIGEST);
    expect(pinArtifact(root, name, DIGEST)).toEqual([]);
    expect(pinArtifact(root, name, OTHER)).toEqual(changed);
  });

  test('the canonical host pin never moves the platform default', () => {
    const root = copyTargets();
    const readme = 'platform/tenant-host/README.md';
    const before = readFileSync(join(root, readme), 'utf8');
    const source = readFileSync(join(repo, 'platform/platform/src/index.ts'), 'utf8');
    const current = source.match(/DEFAULT_HOST_IMAGE =\s+'([^']+)'/)?.[1];
    expect(current).toBeDefined();
    pinArtifact(root, 'wash-wasi-tls', DIGEST);
    const after = readFileSync(join(root, readme), 'utf8');
    // Only the published-images row changed; the default and the examples still name the default.
    const diff = after.split('\n').filter((line, i) => line !== before.split('\n')[i]);
    expect(diff).toEqual([
      `| \`wasi-tls\` | \`ghcr.io/di-framework/wash:2.8.0-wasi-tls@${DIGEST}\` |`,
    ]);
    expect(after).toContain(`\`${current}\``);
    for (const targets of Object.values(ARTIFACTS)) {
      for (const t of targets) expect(t.file.startsWith('platform/platform/src/')).toBe(false);
    }
  });

  test('unknown artifacts and drifted docs fail', () => {
    const root = copyTargets();
    expect(() => pinArtifact(root, 'nope', DIGEST)).toThrow('unknown artifact');
    writeFileSync(join(root, 'platform/pglite-component/README.md'), 'no pin here\n');
    expect(() => pinArtifact(root, 'pglite-component', DIGEST)).toThrow('no ghcr.io/');
  });

  test('the CLI rewrites files under the working directory and prints them', () => {
    const root = copyTargets();
    const result = Bun.spawnSync(
      ['bun', join(repo, 'scripts/pin-artifact.ts'), 'pglite-component', DIGEST],
      { env, cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('platform/pglite-component/README.md');
    const usage = Bun.spawnSync(['bun', join(repo, 'scripts/pin-artifact.ts')], {
      env,
      cwd: root,
      stderr: 'pipe',
    });
    expect(usage.exitCode).toBe(2);
  });
});

test('parsePairs reads artifact/digest pairs', () => {
  expect(parsePairs(['a', DIGEST, 'b', OTHER])).toEqual([
    ['a', DIGEST],
    ['b', OTHER],
  ]);
  expect(() => parsePairs([])).toThrow('usage');
  expect(() => parsePairs(['a'])).toThrow('usage');
});

test('the CLI pins several artifacts in one edit', () => {
  const root = copyTargets();
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(repo, 'scripts/pin-artifact.ts'),
      'wash-wasi-tls',
      DIGEST,
      'wash-wasi-tls-exclusive',
      OTHER,
    ],
    { env, cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe('platform/tenant-host/README.md');
  const readme = readFileSync(join(root, 'platform/tenant-host/README.md'), 'utf8');
  expect(readme).toContain(`wash:2.8.0-wasi-tls@${DIGEST}`);
  expect(readme).toContain(`wash:2.8.0-wasi-tls-exclusive@${OTHER}`);
});

describe('.github/actions/open-pin-pr against a local origin', () => {
  const action = Bun.YAML.parse(
    readFileSync(join(repo, '.github/actions/open-pin-pr/action.yml'), 'utf8'),
  ) as { runs: { steps: { name: string; run?: string }[] } };
  const script = action.runs.steps.find((s) => s.name === 'Commit pins and open PR')?.run ?? '';

  /**
   * A local origin and a clone at the first commit. With `newer`, origin's main has one more
   * commit that changes that file: `src/a` is an input of the sandbox workflow (w.yml), `docs/b`
   * is not.
   */
  function sandbox(newer?: 'src/a' | 'docs/b') {
    const { base, origin, work } = sandboxClone('open-pin-pr-');
    cpSync(copyTargets(), work, { recursive: true });
    mkdirSync(join(work, 'scripts'));
    for (const file of ['pin-artifact.ts', 'source-check.ts']) {
      cpSync(join(repo, 'scripts', file), join(work, 'scripts', file));
    }
    writeFileSync(join(work, 'w.yml'), "on:\n  push:\n    paths:\n      - 'src/**'\n");
    mkdirSync(join(work, 'src'));
    mkdirSync(join(work, 'docs'));
    writeFileSync(join(work, 'src/a'), 'one\n');
    writeFileSync(join(work, 'docs/b'), 'one\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'one');
    const first = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', origin, 'HEAD:main');
    if (newer) {
      writeFileSync(join(work, newer), 'two\n');
      git(work, 'commit', '-q', '-am', 'two');
      git(work, 'push', '-q', origin, 'HEAD:main');
      git(work, 'checkout', '-q', '--detach', first);
    }
    // A fake gh that records its arguments and reports no open PR.
    const bin = join(base, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${base}/gh.log"\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const run = (pins: string, event = 'push') =>
      Bun.spawnSync(['bash', '-c', script], {
        cwd: work,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...env,
          PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
          GITHUB_SHA: first,
          EVENT: event,
          NAME: 'wash',
          WORKFLOW: 'w.yml',
          PINS: pins,
          GH_TOKEN: 'x',
          RUN_URL: 'https://example.invalid/run',
          RUNNER_TEMP: base,
        },
      });
    return {
      base,
      run,
      branches: () => git(base, '--git-dir', origin, 'branch', '--list'),
      log: (ref: string) => git(base, '--git-dir', origin, 'log', '--format=%s', ref),
      files: (ref: string) =>
        git(base, '--git-dir', origin, 'diff', '--name-only', `${ref}~1`, ref),
    };
  }

  test('both wash variants land in one commit on one branch, bot/pin-wash (W1)', () => {
    const box = sandbox();
    const result = box.run(`wash-wasi-tls ${DIGEST}\nwash-wasi-tls-exclusive ${OTHER}\n`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(box.branches()).toContain('bot/pin-wash');
    expect(box.log('bot/pin-wash').split('\n')[0]).toBe(
      `chore: pin wash: wash-wasi-tls to ${DIGEST}; wash-wasi-tls-exclusive to ${OTHER}`,
    );
    expect(box.files('bot/pin-wash')).toBe('platform/tenant-host/README.md');
    const gh = readFileSync(join(box.base, 'gh.log'), 'utf8');
    expect(gh).toContain('pr list --head bot/pin-wash');
    expect(gh).toContain('pr create --base main --head bot/pin-wash');
    const body = readFileSync(join(box.base, 'pin-pr-body.md'), 'utf8');
    expect(body).toContain('A maintainer has to approve and run this PR');
  });

  test('a single pin is titled "chore: pin <artifact> to <digest>"', () => {
    const box = sandbox();
    const result = box.run(`pglite-component ${DIGEST}`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(box.log('bot/pin-wash').split('\n')[0]).toBe(`chore: pin pglite-component to ${DIGEST}`);
  });

  test('an unrelated newer commit on main does not stop the pin (#173 C1)', () => {
    const box = sandbox('docs/b');
    const result = box.run(`wash-wasi-tls ${DIGEST}`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain('stale=false');
    expect(box.branches()).toContain('bot/pin-wash');
  });

  test('newer inputs on main make a push run stale: it pins nothing and succeeds (W2)', () => {
    const box = sandbox('src/a');
    const result = box.run(`wash-wasi-tls ${DIGEST}`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain('::notice::the inputs on main have changed');
    expect(box.branches()).not.toContain('bot/pin-wash');
  });

  test('workflow_dispatch pins even when main has newer inputs', () => {
    const box = sandbox('src/a');
    const result = box.run(`wash-wasi-tls ${DIGEST}`, 'workflow_dispatch');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(box.branches()).toContain('bot/pin-wash');
  });

  test('an empty pin list is a no-op, and a bad digest fails before any push', () => {
    const box = sandbox();
    expect(box.run('').exitCode).toBe(0);
    expect(box.run('wash-wasi-tls sha256:nope').exitCode).toBe(1);
    expect(box.branches()).not.toContain('bot/pin-wash');
  });
});
