/** `make wit`: print the WIT recovered from the built component. */
import { join } from 'node:path';
import { $ } from 'bun';
import { type Context, run } from './lib/cli.ts';

export async function wit(ctx: Context): Promise<void> {
  const component = join(ctx.pkgDir, 'dist', 'di-framework-pglite.wasm');
  console.log((await $`wasm-tools component wit ${component}`.text()).trimEnd());
}

if (import.meta.main) await run('wit', wit);
