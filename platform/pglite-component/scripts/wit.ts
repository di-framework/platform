/** `make wit`: print the WIT recovered from the built component. */
import { die, loadToolEnv, packageDir, setupEnv } from './lib.ts';

if (import.meta.main) {
  try {
    const pkgDir = packageDir(import.meta.url);
    const env = await loadToolEnv(pkgDir);
    await setupEnv(env);
    process.chdir(pkgDir);
    console.log(
      (await Bun.$`wasm-tools component wit dist/di-framework-pglite.wasm`.text()).trimEnd(),
    );
  } catch (error) {
    die('wit', error instanceof Error ? error.message : String(error));
  }
}
