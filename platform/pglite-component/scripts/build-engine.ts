/** Build the PostgreSQL WASI engine with real setjmp/longjmp error recovery. */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { type Context, logger, run } from './lib/cli.ts';
import { fetchVerified } from './lib/fetch.ts';
import { fileExists, isDirectory } from './lib/fs.ts';
import { type Pins, requiredPin } from './lib/versions.ts';

const log = logger('build-engine');

/**
 * Electric's 17.5 WASI changes replayed onto upstream PostgreSQL (#383).
 * Applied to the pinned upstream tag before wasipg's own patches; see
 * engine/patches/README.md for how it is produced and regenerated.
 */
export const ENGINE_SOURCE_PATCH = 'engine/patches/postgresql-17.11-wasi.patch';

/** Files whose contents form the source-tree stamp (mirrors the old shell STAMP). */
export const STAMP_FILES = [
  'scripts/patch-engine-source.ts',
  'scripts/tool-versions.env',
  'engine/reply-buffer.c',
  'engine/build-pgcrypto.sh',
  ENGINE_SOURCE_PATCH,
] as const;

export async function sourceStamp(pkgDir: string, selfPath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const file of [selfPath, ...STAMP_FILES.map((f) => join(pkgDir, f))]) {
    hasher.update(await Bun.file(file).bytes());
  }
  return hasher.digest('hex');
}

/**
 * SOURCE_DATE_EPOCH for the engine build: the commit time of the pinned
 * wasipg recipe (`git show -s --format=%ct`). Tools that stamp a build time,
 * such as OpenSSL's crypto/buildinf.h and clang's __DATE__/__TIME__, then
 * emit the same bytes on every rebuild of the same inputs (#267).
 */
export function sourceDateEpoch(commitTime: string): string {
  const epoch = commitTime.trim();
  if (!/^\d+$/.test(epoch)) {
    throw new Error(
      `pinned engine source has no usable commit time: ${JSON.stringify(commitTime)}`,
    );
  }
  return epoch;
}

/** The engine tree inside the wasipg recipe; build.sh copies it into the container. */
export const ENGINE_TREE = join('build', 'work', 'postgres-pglite');
/** Written by prepareEngineTree; the patched build.sh refuses to run without it. */
export const ENGINE_TREE_MARKER = '.df-engine-source';

/** Start of the recipe's own source checkout (clone of postgres-pglite + wasipg patches). */
export const UPSTREAM_CHECKOUT_START =
  '# Source checkout, pinned to PGLITE_REF (shallow fetch of the exact sha).\n' +
  'SRC=work/postgres-pglite\nif [ ! -f "$SRC/.wasipg-ref" ] || [ "$(cat "$SRC/.wasipg-ref")" != "$PGLITE_REF" ]; then\n';
export const UPSTREAM_CHECKOUT_END = '  echo "$PGLITE_REF" > "$SRC/.wasipg-ref"\nfi\n';
/** Replacement: build-engine.ts prepares the tree, build.sh only checks it is there. */
export const PREPARED_CHECKOUT = [
  '# Source tree prepared by di-framework build-engine.ts: upstream PostgreSQL plus',
  "# Electric's WASI changes and this recipe's patches (see prepareEngineTree).",
  'SRC=work/postgres-pglite',
  `[ -f "$SRC/${ENGINE_TREE_MARKER}" ] || { echo "engine source tree was not prepared by build-engine.ts" >&2; exit 1; }`,
  '',
].join('\n');

/**
 * Patch the upstream wasipg build recipe in place: fill the x86_64 SDK pins,
 * replace its postgres-pglite checkout with the tree build-engine.ts prepares,
 * and reroute its container file transfer through the di-framework source patch.
 */
export function patchUpstreamBuild(
  versionsEnv: string,
  buildSh: string,
  sdkSha: string,
  wasiSdkSha: string,
  patchScript: string,
): { versionsEnv: string; buildSh: string } {
  const patchedVersions = versionsEnv
    .replace('SDK_SHA256_X86_64=__FILLED_BY_FIRST_BUILD__', `SDK_SHA256_X86_64=${sdkSha}`)
    .replace(
      'WASI_SDK_OVERLAY_SHA256_X86_64=__FILLED_BY_FIRST_BUILD__',
      `WASI_SDK_OVERLAY_SHA256_X86_64=${wasiSdkSha}`,
    );
  let patchedBuild = buildSh.replace('docker build -t', 'docker build --load -t');
  const checkoutStart = patchedBuild.indexOf(UPSTREAM_CHECKOUT_START);
  const checkoutEnd = patchedBuild.indexOf(UPSTREAM_CHECKOUT_END, checkoutStart);
  if (checkoutStart < 0 || checkoutEnd < 0) {
    throw new Error('upstream build.sh: postgres-pglite checkout anchor not found');
  }
  patchedBuild = `${patchedBuild.slice(0, checkoutStart)}${PREPARED_CHECKOUT}${patchedBuild.slice(
    checkoutEnd + UPSTREAM_CHECKOUT_END.length,
  )}`;
  const containerBlock = [
    'CONTAINER="df-pglite-engine-build-$$"',
    'trap \'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true\' EXIT',
    'docker create --name "$CONTAINER" \\',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: injected shell for the upstream build recipe, not a TS template.
    '  ${VOLARGS[@]+"${VOLARGS[@]}"} \\',
    '  -e WASI=true -e CI=true -e SJLJ=true -e DEBUG=false \\',
    // PG_BRANCH only names directories inside Electric's WASI scripts (and the
    // postgresql-REL_17_5_WASM.patched marker the replay patch carries); the
    // PostgreSQL version itself comes from the upstream tree's configure.
    '  -e PG_VERSION=17.11 -e PG_BRANCH=REL_17_5_WASM -e SDKROOT=/tmp/sdk \\',
    '  -e GETZIC=false -e ZIC=/usr/sbin/zic -w /workspace \\',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: injected shell for the upstream build recipe, not a TS template.
    '  -e "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:?}" \\',
    '  "$IMG" bash -c \'./wasm-build.sh; /pack.sh\'',
    'docker cp "$SRC/." "$CONTAINER:/workspace"',
    'docker cp pack.sh "$CONTAINER:/pack.sh"',
    'docker start -a "$CONTAINER"',
    'status="$(docker inspect --format \'{{.State.ExitCode}}\' "$CONTAINER")"',
    '[ "$status" = 0 ] || exit "$status"',
    'docker cp "$CONTAINER:/tmp/sdk/dist/." out/',
    'cp ../NOTICE out/NOTICE',
    '',
  ].join('\n');
  patchedBuild = patchedBuild.replace(
    'IMG=wasipg-builder:',
    `bun "${patchScript}" "$SRC"\n\nIMG=wasipg-builder:`,
  );
  const runIndex = patchedBuild.indexOf('docker run --rm');
  if (runIndex < 0) throw new Error('upstream build.sh: `docker run --rm` anchor not found');
  // Everything from the upstream `docker run --rm` onward is replaced: the
  // volume-mount transfer breaks on remote daemons and the Go-based pristine
  // database packaging is not needed here.
  patchedBuild = `${patchedBuild.slice(0, runIndex)}${containerBlock}`;
  return { versionsEnv: patchedVersions, buildSh: patchedBuild };
}

/**
 * Environment for git commands on build-engine's own trees. Git hooks export
 * GIT_DIR and friends, which would point `git -C <tree>` at the hook's
 * repository instead; every GIT_* variable is dropped.
 */
export function gitEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => !entry[0].startsWith('GIT_') && entry[1] !== undefined,
    ),
  );
}

/** The pinned upstream PostgreSQL source the engine tree starts from. */
export interface PostgresSource {
  repo: string;
  tag: string;
  commit: string;
}

export function postgresSource(pins: Pins): PostgresSource {
  const source = {
    repo: requiredPin(pins, 'POSTGRES_SOURCE_REPO'),
    tag: requiredPin(pins, 'POSTGRES_SOURCE_TAG'),
    commit: requiredPin(pins, 'POSTGRES_SOURCE_COMMIT'),
  };
  if (!/^REL_\d+_\d+$/.test(source.tag)) {
    throw new Error(`POSTGRES_SOURCE_TAG must be a release tag such as REL_17_11: ${source.tag}`);
  }
  if (!/^[0-9a-f]{40}$/.test(source.commit)) {
    throw new Error(`POSTGRES_SOURCE_COMMIT must be a full commit SHA: ${source.commit}`);
  }
  return source;
}

/** `REL_17_11` -> `17.11`: the PostgreSQL release a source tag names. */
export function postgresVersion(tag: string): string {
  const match = /^REL_(\d+)_(\d+)$/.exec(tag);
  if (!match) throw new Error(`not a PostgreSQL release tag: ${tag}`);
  return `${match[1]}.${match[2]}`;
}

/** Refuse a fetched tag that does not resolve to the pinned commit. */
export function checkTagCommit(source: PostgresSource, fetched: string): void {
  const actual = fetched.trim();
  if (actual !== source.commit) {
    throw new Error(
      `${source.repo} tag ${source.tag} resolves to ${actual || '(nothing)'}, ` +
        `but scripts/tool-versions.env pins ${source.commit}`,
    );
  }
}

/** What to do when our WASI replay patch (ENGINE_SOURCE_PATCH) no longer applies. */
export const REPLAY_PATCH_HINT =
  'After a base bump, regenerate engine/patches/postgresql-*-wasi.patch as described in ' +
  'engine/patches/README.md.';

/** What to do when one of the pinned wasipg recipe's build/patches no longer applies. */
export const RECIPE_PATCH_HINT =
  'This patch comes from the pinned wasipg recipe (PGLITE_SOURCE_REF in ' +
  'scripts/tool-versions.env), not from engine/patches, so regenerating the WASI patch does ' +
  'not fix it: check whether a PGLITE_SOURCE_REF bump changed build/patches, or whether the ' +
  'base bump moved the code the patch touches.';

/** The error shown when a patch no longer applies, with what to do about it. */
export function patchDoesNotApply(
  patch: string,
  source: PostgresSource,
  gitOutput: string,
  hint: string = REPLAY_PATCH_HINT,
): Error {
  const detail = gitOutput.trim() ? `\n${gitOutput.trim()}` : '';
  return new Error(
    `${patch} no longer applies to PostgreSQL ${source.tag} (${source.commit.slice(0, 10)}). ` +
      `${hint}${detail}`,
  );
}

/** Apply one patch to `tree`, checking first so a failure leaves the tree untouched. */
export async function applyCheckedPatch(
  tree: string,
  patchFile: string,
  label: string,
  source: PostgresSource,
  hint: string = REPLAY_PATCH_HINT,
): Promise<void> {
  const check = await $`git -C ${tree} apply --check --whitespace=nowarn ${patchFile}`
    .env(gitEnv())
    .nothrow()
    .quiet();
  if (check.exitCode !== 0) {
    throw patchDoesNotApply(label, source, `${check.stdout}${check.stderr}`, hint);
  }
  await $`git -C ${tree} apply --whitespace=nowarn ${patchFile}`.env(gitEnv()).quiet();
}

/** wasipg's own source patches, in the order its build.sh applies them. */
export async function recipePatches(patchDir: string): Promise<string[]> {
  return (await readdir(patchDir))
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => join(patchDir, name));
}

/**
 * Build the engine source tree from scratch: the pinned upstream PostgreSQL
 * tag (its commit checked), Electric's WASI changes replayed onto it, then the
 * wasipg recipe's patches. patch-engine-source.ts runs on the result later,
 * from the recipe's build.sh.
 */
export async function prepareEngineTree(
  tree: string,
  source: PostgresSource,
  replayPatch: string,
  recipePatchDir: string,
): Promise<void> {
  await rm(tree, { recursive: true, force: true });
  await mkdir(tree, { recursive: true });
  await $`git -C ${tree} init -q`.env(gitEnv());
  await $`git -C ${tree} remote add origin ${source.repo}`.env(gitEnv());
  await $`git -C ${tree} fetch -q --depth 1 origin ${`refs/tags/${source.tag}`}`.env(gitEnv());
  checkTagCommit(
    source,
    await $`git -C ${tree} rev-parse ${'FETCH_HEAD^{commit}'}`.env(gitEnv()).text(),
  );
  await $`git -C ${tree} checkout -q FETCH_HEAD`.env(gitEnv());
  await applyCheckedPatch(tree, replayPatch, ENGINE_SOURCE_PATCH, source, REPLAY_PATCH_HINT);
  for (const patch of await recipePatches(recipePatchDir)) {
    await applyCheckedPatch(
      tree,
      patch,
      `wasipg build/patches/${patch.split('/').pop()}`,
      source,
      RECIPE_PATCH_HINT,
    );
  }
  await Bun.write(join(tree, ENGINE_TREE_MARKER), `${source.tag} ${source.commit}\n`);
}

/** The wasipg build recipe the engine is built with. */
export const WASIPG_REPO = 'https://github.com/moznion/wasipg.git';

/** Fetch the pinned wasipg recipe (build/, NOTICE, LICENSE) into `sourceDir`; returns its commit time. */
export async function fetchRecipe(
  sourceDir: string,
  sourceRef: string,
  repo: string = WASIPG_REPO,
): Promise<string> {
  if (!(await isDirectory(join(sourceDir, '.git')))) {
    await mkdir(sourceDir, { recursive: true });
    await $`git -C ${sourceDir} init -q`.env(gitEnv());
    await $`git -C ${sourceDir} remote add origin ${repo}`.env(gitEnv());
  }
  await $`git -C ${sourceDir} fetch --depth 1 origin ${sourceRef}`.env(gitEnv());
  await $`git -C ${sourceDir} checkout FETCH_HEAD -- build NOTICE LICENSE`.env(gitEnv());
  return sourceDateEpoch(
    await $`git -C ${sourceDir} show -s --format=%ct FETCH_HEAD`.env(gitEnv()).text(),
  );
}

export async function buildEngineSource(ctx: Context): Promise<void> {
  const { pkgDir } = ctx;
  const engineDir = join(pkgDir, 'target', 'engine');
  const sourceDir = join(engineDir, 'source');
  await mkdir(engineDir, { recursive: true });

  const stamp = await sourceStamp(pkgDir, import.meta.path);
  const stampFile = join(engineDir, 'source-stamp');
  const tarball = join(engineDir, 'pglite-source.tar.xz');
  if (
    (await fileExists(stampFile)) &&
    (await Bun.file(stampFile).text()) === stamp &&
    (await fileExists(tarball)) &&
    Bun.file(tarball).size > 0
  ) {
    return;
  }

  if (!Bun.which('docker', { PATH: ctx.env.PATH })) {
    throw new Error('engine build needs Docker or a Docker-compatible Podman context');
  }
  let env = ctx.env;
  if (!env.DOCKER_CONTEXT) {
    const dockerOk = (await $`docker info`.nothrow().quiet()).exitCode === 0;
    if (!dockerOk) {
      const podmanOk = (await $`docker --context podman info`.nothrow().quiet()).exitCode === 0;
      if (podmanOk) env = { ...env, DOCKER_CONTEXT: 'podman' };
    }
  }
  await $`docker info`.env(env).quiet();

  const epoch = await fetchRecipe(sourceDir, requiredPin(ctx.tools.pins, 'PGLITE_SOURCE_REF'));

  const versionsEnvPath = join(sourceDir, 'build', 'versions.env');
  const buildShPath = join(sourceDir, 'build', 'build.sh');
  const patchScript = join(pkgDir, 'scripts', 'patch-engine-source.ts');
  const patched = patchUpstreamBuild(
    await Bun.file(versionsEnvPath).text(),
    await Bun.file(buildShPath).text(),
    requiredPin(ctx.tools.pins, 'PGLITE_SDK_SHA256_X86_64'),
    requiredPin(ctx.tools.pins, 'PGLITE_WASI_SDK_SHA256_X86_64'),
    patchScript,
  );
  await Bun.write(versionsEnvPath, patched.versionsEnv);
  await Bun.write(buildShPath, patched.buildSh);

  // A fresh tree on every source build: a reused one could carry stale patches.
  await prepareEngineTree(
    join(sourceDir, ENGINE_TREE),
    postgresSource(ctx.tools.pins),
    join(pkgDir, ENGINE_SOURCE_PATCH),
    join(sourceDir, 'build', 'patches'),
  );

  // pgcrypto links libcrypto built from this checksum-verified OpenSSL source;
  // patch-engine-source.ts copies it into the container's source tree.
  const openssl = join(
    engineDir,
    `openssl-${requiredPin(ctx.tools.pins, 'OPENSSL_VERSION')}.tar.gz`,
  );
  await fetchVerified(
    requiredPin(ctx.tools.pins, 'OPENSSL_URL'),
    openssl,
    requiredPin(ctx.tools.pins, 'OPENSSL_SHA256'),
    { log },
  );

  // Keep the upstream build recipe, adapting file transfer for remote container
  // daemons and omitting its Go-specific pristine-database packaging step.
  // Do not reuse shared upstream FAST volumes: clean source builds avoid stale
  // objects compiled with a different compiler or recovery configuration.
  // SOURCE_DATE_EPOCH goes into the build container (see patchUpstreamBuild)
  // so the engine is byte-reproducible; `make reproducible` checks it.
  await $`bash ${buildShPath}`.env({
    ...env,
    DF_PGLITE_SOURCE_PATCH: patchScript,
    DF_PGLITE_OPENSSL_TARBALL: openssl,
    FAST: 'false',
    SOURCE_DATE_EPOCH: epoch,
  });

  await Bun.write(tarball, Bun.file(join(sourceDir, 'build', 'out', 'pglite-wasi.tar.xz')));
  await Bun.write(stampFile, stamp);
  log('engine source ready');
}

if (import.meta.main) await run('build-engine', buildEngineSource);
