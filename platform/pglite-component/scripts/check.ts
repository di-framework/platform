/** `make check`: prepare the engine, then `cargo check` the wasm target. */

import { die, loadToolEnv, packageDir, setupEnv } from './lib.ts';
import { prepareEngine } from './prepare-engine.ts';

if (import.meta.main) {
  try {
    const pkgDir = packageDir(import.meta.url);
    const env = await loadToolEnv(pkgDir);
    await setupEnv(env);
    process.chdir(pkgDir);
    await prepareEngine(pkgDir);
    await Bun.$`cargo check --locked --target ${env.rustTarget} -p di-framework-pglite-component`;
  } catch (error) {
    die('check', error instanceof Error ? error.message : String(error));
  }
}
