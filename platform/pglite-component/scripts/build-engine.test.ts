import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import {
  applyCheckedPatch,
  checkTagCommit,
  ENGINE_SOURCE_PATCH,
  ENGINE_TREE_MARKER,
  type PostgresSource,
  PREPARED_CHECKOUT,
  patchDoesNotApply,
  patchUpstreamBuild,
  postgresSource,
  prepareEngineTree,
  recipePatches,
  STAMP_FILES,
  sourceDateEpoch,
} from './build-engine.ts';
import { loadPins } from './lib/versions.ts';

const pkgDir = resolve(import.meta.dir, '..');

describe('sourceDateEpoch', () => {
  test('uses the pinned commit time', () => {
    expect(sourceDateEpoch('1754000000\n')).toBe('1754000000');
  });

  test('rejects output that is not a Unix timestamp', () => {
    expect(() => sourceDateEpoch('')).toThrow('no usable commit time');
    expect(() => sourceDateEpoch('fatal: bad object')).toThrow('no usable commit time');
  });
});

const upstreamVersions = [
  'SDK_SHA256_X86_64=__FILLED_BY_FIRST_BUILD__',
  'WASI_SDK_OVERLAY_SHA256_X86_64=__FILLED_BY_FIRST_BUILD__',
  '',
].join('\n');

const upstreamCheckout = [
  '# Source checkout, pinned to PGLITE_REF (shallow fetch of the exact sha).',
  'SRC=work/postgres-pglite',
  'if [ ! -f "$SRC/.wasipg-ref" ] || [ "$(cat "$SRC/.wasipg-ref")" != "$PGLITE_REF" ]; then',
  '  rm -rf "$SRC"',
  '  git -C "$SRC" fetch -q --depth 1 origin "$PGLITE_REF"',
  '  for p in patches/*.patch; do',
  '    git -C "$SRC" apply "../../$p"',
  '  done',
  '  echo "$PGLITE_REF" > "$SRC/.wasipg-ref"',
  'fi',
  '',
].join('\n');

const upstreamBuild = [
  '#!/usr/bin/env bash',
  upstreamCheckout,
  'docker build -t "$IMG" .',
  'IMG=wasipg-builder:latest',
  'docker run --rm \\',
  '  -v "$(pwd)/$SRC:/workspace:rw" \\',
  '  "$IMG" bash -c \'./wasm-build.sh; /pack.sh\'',
  '',
  '(cd .. && go run ./cmd/mkdata -bundle build/out/pglite-wasi.tar.xz)',
  'cp ../NOTICE out/NOTICE',
  '',
].join('\n');

describe('patchUpstreamBuild', () => {
  const patched = patchUpstreamBuild(
    upstreamVersions,
    upstreamBuild,
    'sdk-sha',
    'wasi-sdk-sha',
    '/pkg/scripts/patch-engine-source.ts',
  );

  test('fills the x86_64 SDK pins', () => {
    expect(patched.versionsEnv).toContain('SDK_SHA256_X86_64=sdk-sha');
    expect(patched.versionsEnv).toContain('WASI_SDK_OVERLAY_SHA256_X86_64=wasi-sdk-sha');
    expect(patched.versionsEnv).not.toContain('__FILLED_BY_FIRST_BUILD__');
  });

  test('replaces the docker run tail with the container block', () => {
    expect(patched.buildSh).toContain('docker build --load -t');
    expect(patched.buildSh).toContain(
      'bun "/pkg/scripts/patch-engine-source.ts" "$SRC"\n\nIMG=wasipg-builder:',
    );
    expect(patched.buildSh).toContain('docker create --name "$CONTAINER"');
    expect(patched.buildSh).toContain('docker cp "$SRC/." "$CONTAINER:/workspace"');
    expect(patched.buildSh).not.toContain('docker run --rm');
    expect(patched.buildSh).not.toContain('go run ./cmd/mkdata');
    expect(patched.buildSh).not.toContain('-v "$(pwd)/$SRC:/workspace:rw"');
    expect(patched.buildSh.endsWith('cp ../NOTICE out/NOTICE\n')).toBe(true);
    expect(patched.buildSh.split('cp ../NOTICE out/NOTICE')).toHaveLength(2);
  });

  test('replaces the postgres-pglite checkout with the prepared-tree check', () => {
    expect(patched.buildSh).toContain(PREPARED_CHECKOUT);
    expect(patched.buildSh).toContain(`[ -f "$SRC/${ENGINE_TREE_MARKER}" ] ||`);
    expect(patched.buildSh).not.toContain('PGLITE_REF');
    expect(patched.buildSh).not.toContain('patches/*.patch');
    // The source patch still runs on that tree, before the image build.
    expect(patched.buildSh.indexOf(PREPARED_CHECKOUT)).toBeLessThan(
      patched.buildSh.indexOf('bun "/pkg/scripts/patch-engine-source.ts" "$SRC"'),
    );
    // The container build is told this is a 17.11 tree.
    expect(patched.buildSh).toContain('-e PG_VERSION=17.11 -e PG_BRANCH=REL_17_5_WASM');
  });

  test('passes SOURCE_DATE_EPOCH into the build container', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: expected shell text, not a TS template.
    expect(patched.buildSh).toContain('-e "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:?}"');
  });

  test('fails loudly when the upstream anchor moves', () => {
    expect(() =>
      patchUpstreamBuild(
        upstreamVersions,
        `${upstreamCheckout}IMG=wasipg-builder:x\n`,
        'a',
        'b',
        '/p.ts',
      ),
    ).toThrow('`docker run --rm` anchor not found');
    expect(() =>
      patchUpstreamBuild(
        upstreamVersions,
        upstreamBuild.replace(upstreamCheckout, ''),
        'a',
        'b',
        '/p.ts',
      ),
    ).toThrow('postgres-pglite checkout anchor not found');
  });
});

describe('engine source pins', () => {
  test('tool-versions.env pins upstream REL_17_11 by tag and full commit', async () => {
    const source = postgresSource(await loadPins(pkgDir));
    expect(source).toEqual({
      repo: 'https://github.com/postgres/postgres.git',
      tag: 'REL_17_11',
      commit: '083ac033419f690758508e08c1736089384bbee8',
    });
  });

  test('rejects a branch name or an abbreviated commit', () => {
    const pins = {
      POSTGRES_SOURCE_REPO: 'https://example.invalid/pg.git',
      POSTGRES_SOURCE_TAG: 'REL_17_11',
      POSTGRES_SOURCE_COMMIT: '083ac033419f690758508e08c1736089384bbee8',
    };
    expect(() => postgresSource({ ...pins, POSTGRES_SOURCE_TAG: 'REL_17_STABLE' })).toThrow(
      'must be a release tag',
    );
    expect(() => postgresSource({ ...pins, POSTGRES_SOURCE_COMMIT: '083ac03' })).toThrow(
      'must be a full commit SHA',
    );
    expect(() => postgresSource({})).toThrow('missing pin POSTGRES_SOURCE_REPO');
  });

  test('the replay patch is part of the source stamp', () => {
    expect(STAMP_FILES).toContain(ENGINE_SOURCE_PATCH);
  });

  test('the replay patch is text only and names its base and source', async () => {
    const patch = await Bun.file(join(pkgDir, ENGINE_SOURCE_PATCH)).text();
    const header = patch.slice(0, patch.indexOf('diff --git '));
    expect(header).toContain('tag REL_17_11');
    expect(header).toContain('commit 083ac033419f690758508e08c1736089384bbee8');
    expect(header).toContain('REL_17_5_WASM-pglite (2194acf356e9b7bf7cff29c4ed4bd6b82b93895d)');
    expect(header).toContain('PostgreSQL License');
    expect(patch).not.toContain('GIT binary patch');
    expect(patch).not.toContain('Binary files ');
    expect(patch.match(/^diff --git /gm)).toHaveLength(118);
  });
});

const source: PostgresSource = {
  repo: 'https://example.invalid/pg.git',
  tag: 'REL_17_11',
  commit: '083ac033419f690758508e08c1736089384bbee8',
};

describe('checkTagCommit', () => {
  test('accepts the pinned commit and refuses anything else', () => {
    expect(() => checkTagCommit(source, `${source.commit}\n`)).not.toThrow();
    expect(() => checkTagCommit(source, 'ffffffffffffffffffffffffffffffffffffffff')).toThrow(
      'tag REL_17_11 resolves to ffffffffffffffffffffffffffffffffffffffff, but scripts/tool-versions.env pins 083ac033419f690758508e08c1736089384bbee8',
    );
    expect(() => checkTagCommit(source, '')).toThrow('resolves to (nothing)');
  });
});

describe('patchDoesNotApply', () => {
  test('names the patch, the base and the regeneration steps', () => {
    const error = patchDoesNotApply(ENGINE_SOURCE_PATCH, source, 'error: patch failed: a.c:1\n');
    expect(error.message).toContain(
      `${ENGINE_SOURCE_PATCH} no longer applies to PostgreSQL REL_17_11 (083ac03341)`,
    );
    expect(error.message).toContain('engine/patches/README.md');
    expect(error.message).toEndWith('\nerror: patch failed: a.c:1');
    expect(patchDoesNotApply('x.patch', source, '  ').message).toEndWith('README.md.');
  });
});

/** A local "upstream" repository with one tagged commit. */
async function upstreamRepo(dir: string): Promise<string> {
  const repo = join(dir, 'upstream');
  await mkdir(repo, { recursive: true });
  await $`git -C ${repo} init -q`;
  await Bun.write(join(repo, 'a.c'), 'int a;\n');
  await $`git -C ${repo} add a.c`;
  await $`git -C ${repo} -c user.name=t -c user.email=t@example.invalid commit -q -m base`;
  await $`git -C ${repo} tag REL_17_11`;
  return repo;
}

/** A unified diff that replaces `from` with `to` in file `name`. */
const diff = (name: string, from: string, to: string): string =>
  [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    '@@ -1 +1 @@',
    `-${from}`,
    `+${to}`,
    '',
  ].join('\n');

describe('applyCheckedPatch', () => {
  test('applies a matching patch and leaves the tree untouched when one does not apply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-pglite-apply-test.'));
    try {
      const tree = await upstreamRepo(dir);
      const good = join(dir, 'good.patch');
      await Bun.write(good, `header text is ignored\n\n${diff('a.c', 'int a;', 'int b;')}`);
      await applyCheckedPatch(tree, good, 'good.patch', source);
      expect(await Bun.file(join(tree, 'a.c')).text()).toBe('int b;\n');

      const stale = join(dir, 'stale.patch');
      await Bun.write(stale, diff('a.c', 'int a;', 'int c;'));
      await expect(applyCheckedPatch(tree, stale, 'stale.patch', source)).rejects.toThrow(
        /stale\.patch no longer applies to PostgreSQL REL_17_11 .*\n.*patch failed: a\.c:1/s,
      );
      expect(await Bun.file(join(tree, 'a.c')).text()).toBe('int b;\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('prepareEngineTree', () => {
  test('checks out the pinned tag, then applies the replay and recipe patches in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-pglite-tree-test.'));
    try {
      const repo = await upstreamRepo(dir);
      const commit = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
      const pinned: PostgresSource = { repo, tag: 'REL_17_11', commit };
      const replay = join(dir, 'replay.patch');
      await Bun.write(replay, diff('a.c', 'int a;', 'int b;'));
      const recipe = join(dir, 'patches');
      await mkdir(recipe);
      // Applied in name order: 0002 needs 0001's result.
      await Bun.write(join(recipe, '0002-second.patch'), diff('a.c', 'int c;', 'int d;'));
      await Bun.write(join(recipe, '0001-first.patch'), diff('a.c', 'int b;', 'int c;'));
      await Bun.write(join(recipe, 'README.md'), 'not a patch');
      expect((await recipePatches(recipe)).map((p) => p.split('/').pop())).toEqual([
        '0001-first.patch',
        '0002-second.patch',
      ]);

      const tree = join(dir, 'tree');
      await mkdir(tree);
      await Bun.write(join(tree, 'stale.o'), 'left over from an earlier build');
      await prepareEngineTree(tree, pinned, replay, recipe);
      expect(await Bun.file(join(tree, 'a.c')).text()).toBe('int d;\n');
      expect(await Bun.file(join(tree, ENGINE_TREE_MARKER)).text()).toBe(`REL_17_11 ${commit}\n`);
      expect(await Bun.file(join(tree, 'stale.o')).exists()).toBe(false);

      await expect(
        prepareEngineTree(tree, { ...pinned, commit: 'f'.repeat(40) }, replay, recipe),
      ).rejects.toThrow(`resolves to ${commit}`);
      await expect(
        prepareEngineTree(tree, pinned, join(recipe, '0002-second.patch'), recipe),
      ).rejects.toThrow(`${ENGINE_SOURCE_PATCH} no longer applies`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
