/**
 * Print the pinned tool environment as POSIX `export` lines for shells:
 *
 *   eval "$(bun scripts/env.ts)"
 *
 * The build scripts apply the same environment themselves (see lib/cli.ts),
 * so this is only needed for interactive shells and ad-hoc tool invocations.
 */
import { type Context, run } from './lib/cli.ts';
import { exportEnvLines } from './lib/toolchain.ts';

export async function printEnv(ctx: Context): Promise<void> {
  for (const line of exportEnvLines(ctx.toolsEnv)) console.log(line);
}

if (import.meta.main) await run('env', printEnv);
