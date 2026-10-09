/**
 * Print the pinned tool environment as POSIX `export` lines for shells:
 *
 *   eval "$(bun scripts/env.ts)"
 *
 * The build scripts themselves import `setupEnv` from lib.ts, so this is only
 * needed for interactive shells and Makefile recipes that spawn tools directly.
 */
import { exportEnvLines, loadToolEnv, packageDir } from './lib.ts';

if (import.meta.main) {
  const pkgDir = packageDir(import.meta.url);
  const env = await loadToolEnv(pkgDir);
  for (const line of await exportEnvLines(env)) console.log(line);
}
