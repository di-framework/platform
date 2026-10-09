/** Build the PostgreSQL WASI engine with real setjmp/longjmp error recovery. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { type Context, logger, run } from './lib/cli.ts';
import { fileExists, isDirectory } from './lib/fs.ts';
import { requiredPin } from './lib/versions.ts';

const log = logger('build-engine');

/** Files whose contents form the source-tree stamp (mirrors the old shell STAMP). */
export const STAMP_FILES = [
  'scripts/patch-engine-source.ts',
  'scripts/tool-versions.env',
  'engine/reply-buffer.c',
] as const;

export async function sourceStamp(pkgDir: string, selfPath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const file of [selfPath, ...STAMP_FILES.map((f) => join(pkgDir, f))]) {
    hasher.update(await Bun.file(file).bytes());
  }
  return hasher.digest('hex');
}

/**
 * Patch the upstream wasipg build recipe in place: fill the x86_64 SDK pins
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
  const containerBlock = [
    'CONTAINER="df-pglite-engine-build-$$"',
    'trap \'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true\' EXIT',
    'docker create --name "$CONTAINER" \\',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: injected shell for the upstream build recipe, not a TS template.
    '  ${VOLARGS[@]+"${VOLARGS[@]}"} \\',
    '  -e WASI=true -e CI=true -e SJLJ=true -e DEBUG=false \\',
    '  -e PG_VERSION=17.5 -e PG_BRANCH=REL_17_5_WASM -e SDKROOT=/tmp/sdk \\',
    '  -e GETZIC=false -e ZIC=/usr/sbin/zic -w /workspace \\',
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

  if (!(await isDirectory(join(sourceDir, '.git')))) {
    await mkdir(sourceDir, { recursive: true });
    await $`git -C ${sourceDir} init -q`;
    await $`git -C ${sourceDir} remote add origin https://github.com/moznion/wasipg.git`;
  }
  const sourceRef = requiredPin(ctx.tools.pins, 'PGLITE_SOURCE_REF');
  await $`git -C ${sourceDir} fetch --depth 1 origin ${sourceRef}`;
  await $`git -C ${sourceDir} checkout FETCH_HEAD -- build NOTICE LICENSE`;

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

  // Keep the upstream build recipe, adapting file transfer for remote container
  // daemons and omitting its Go-specific pristine-database packaging step.
  // Do not reuse shared upstream FAST volumes: clean source builds avoid stale
  // objects compiled with a different compiler or recovery configuration.
  await $`bash ${buildShPath}`.env({
    ...env,
    DF_PGLITE_SOURCE_PATCH: patchScript,
    FAST: 'false',
  });

  await Bun.write(tarball, Bun.file(join(sourceDir, 'build', 'out', 'pglite-wasi.tar.xz')));
  await Bun.write(stampFile, stamp);
  log('engine source ready');
}

if (import.meta.main) await run('build-engine', buildEngineSource);
