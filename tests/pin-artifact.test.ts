import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ARTIFACTS, pinArtifact, pinText } from '../scripts/pin-artifact';

const repo = resolve(import.meta.dir, '..');
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
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('platform/pglite-component/README.md');
    const usage = Bun.spawnSync(['bun', join(repo, 'scripts/pin-artifact.ts')], {
      cwd: root,
      stderr: 'pipe',
    });
    expect(usage.exitCode).toBe(2);
  });
});
