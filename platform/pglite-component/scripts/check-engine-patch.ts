/**
 * `make check-engine-patch`: prove the engine source patches still apply,
 * without the container build. Builds the engine tree exactly as
 * build-engine.ts does (pinned upstream tag, commit checked; Electric's WASI
 * changes; the wasipg recipe's patches), then runs every patch-engine-source.ts
 * edit on it. Run it first after bumping POSTGRES_SOURCE_TAG: a stale patch
 * fails here in seconds, naming the patch and what to do.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ENGINE_SOURCE_PATCH,
  ENGINE_TREE,
  fetchRecipe,
  postgresSource,
  prepareEngineTree,
} from './build-engine.ts';
import { type Context, logger, run } from './lib/cli.ts';
import { requiredPin } from './lib/versions.ts';
import {
  engineRoot,
  patchEngineSource,
  patchFrontendGlue,
  patchPgcryptoSources,
} from './patch-engine-source.ts';

const log = logger('check-engine-patch');

/** Apply every engine source edit to the tree at `tree` (see the module comment). */
export async function patchEngineTree(tree: string, pkgDir: string): Promise<void> {
  await patchEngineSource(tree, pkgDir);
  await patchFrontendGlue(tree);
  await patchPgcryptoSources(tree);
}

export async function checkEnginePatch(ctx: Context): Promise<void> {
  const { pkgDir } = ctx;
  const source = postgresSource(ctx.tools.pins);
  // Inside the engine root, where patch-engine-source.ts allows edits, and
  // apart from the real build's tree.
  await mkdir(engineRoot(pkgDir), { recursive: true });
  const work = await mkdtemp(join(engineRoot(pkgDir), 'check-engine-patch.'));
  try {
    const recipe = join(work, 'source');
    await fetchRecipe(recipe, requiredPin(ctx.tools.pins, 'PGLITE_SOURCE_REF'));
    const tree = join(recipe, ENGINE_TREE);
    await prepareEngineTree(
      tree,
      source,
      join(pkgDir, ENGINE_SOURCE_PATCH),
      join(recipe, 'build', 'patches'),
    );
    await patchEngineTree(tree, pkgDir);
    log(`ok: engine patches apply to PostgreSQL ${source.tag} (${source.commit})`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.main) await run('check-engine-patch', checkEnginePatch);
