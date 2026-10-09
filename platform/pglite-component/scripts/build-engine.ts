/** Build the PostgreSQL WASI engine with real setjmp/longjmp error recovery. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  die,
  fileExists,
  isDirectory,
  loadToolEnv,
  log,
  mkdir,
  packageDir,
  readFileText,
  requiredPin,
  setupEnv,
} from './lib.ts';

/** Files whose contents form the source-tree stamp (mirrors the old shell STAMP). */
export const STAMP_FILES = [
  'scripts/patch-engine-source.ts',
  'scripts/tool-versions.env',
  'engine/reply-buffer.c',
] as const;

export async function sourceStamp(pkgDir: string, selfPath: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of [selfPath, ...STAMP_FILES.map((f) => join(pkgDir, f))]) {
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
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
  patchedBuild = `${patchedBuild.slice(0, runIndex)}${containerBlock}${patchedBuild.slice(runIndex)}`;
  return { versionsEnv: patchedVersions, buildSh: patchedBuild };
}

export async function buildEngineSource(pkgDir?: string): Promise<void> {
  const dir = pkgDir ?? packageDir(import.meta.url);
  const env = await loadToolEnv(dir);
  await setupEnv(env);
  const engineDir = join(dir, 'target', 'engine');
  const sourceDir = join(engineDir, 'source');
  await mkdir(engineDir, { recursive: true });

  const stamp = await sourceStamp(dir, new URL(import.meta.url).pathname);
  const stampFile = join(engineDir, 'source-stamp');
  const tarball = join(engineDir, 'pglite-source.tar.xz');
  if (
    (await fileExists(stampFile)) &&
    (await readFileText(stampFile)) === stamp &&
    (await fileExists(tarball)) &&
    Bun.file(tarball).size > 0
  ) {
    return;
  }

  if (!Bun.which('docker')) {
    die('build-engine', 'engine build needs Docker or a Docker-compatible Podman context');
  }
  if (!process.env.DOCKER_CONTEXT) {
    const dockerOk = (await Bun.$`docker info`.nothrow().quiet()).exitCode === 0;
    if (!dockerOk) {
      const podmanOk = (await Bun.$`docker --context podman info`.nothrow().quiet()).exitCode === 0;
      if (podmanOk) process.env.DOCKER_CONTEXT = 'podman';
    }
  }
  await Bun.$`docker info`.quiet();

  if (!(await isDirectory(join(sourceDir, '.git')))) {
    await mkdir(sourceDir, { recursive: true });
    await Bun.$`git -C ${sourceDir} init -q`;
    await Bun.$`git -C ${sourceDir} remote add origin https://github.com/moznion/wasipg.git`;
  }
  const sourceRef = requiredPin(env.pins, 'PGLITE_SOURCE_REF');
  await Bun.$`git -C ${sourceDir} fetch --depth 1 origin ${sourceRef}`;
  await Bun.$`git -C ${sourceDir} checkout FETCH_HEAD -- build NOTICE LICENSE`;

  const versionsEnvPath = join(sourceDir, 'build', 'versions.env');
  const buildShPath = join(sourceDir, 'build', 'build.sh');
  const patched = patchUpstreamBuild(
    await readFileText(versionsEnvPath),
    await readFileText(buildShPath),
    requiredPin(env.pins, 'PGLITE_SDK_SHA256_X86_64'),
    requiredPin(env.pins, 'PGLITE_WASI_SDK_SHA256_X86_64'),
    join(dir, 'scripts', 'patch-engine-source.ts'),
  );
  await Bun.write(versionsEnvPath, patched.versionsEnv);
  await Bun.write(buildShPath, patched.buildSh);

  // Keep the upstream build recipe, adapting file transfer for remote container
  // daemons and omitting its Go-specific pristine-database packaging step.
  // Do not reuse shared upstream FAST volumes: clean source builds avoid stale
  // objects compiled with a different compiler or recovery configuration.
  await Bun.$`bash ${join(sourceDir, 'build', 'build.sh')}`.env({
    ...process.env,
    DF_PGLITE_SOURCE_PATCH: join(dir, 'scripts', 'patch-engine-source.ts'),
    FAST: 'false',
  });

  await Bun.$`cp ${join(sourceDir, 'build', 'out', 'pglite-wasi.tar.xz')} ${tarball}`;
  await Bun.write(stampFile, stamp);
  log('build-engine', 'engine source ready');
}

if (import.meta.main) {
  try {
    await buildEngineSource();
  } catch (error) {
    die('build-engine', error instanceof Error ? error.message : String(error));
  }
}
