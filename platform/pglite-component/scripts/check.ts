/** `make check`: prepare the engine, then `cargo check` the wasm target. */
import { $ } from 'bun';
import { type Context, run } from './lib/cli.ts';
import { prepareEngine } from './prepare-engine.ts';

export async function check(ctx: Context): Promise<void> {
  await prepareEngine(ctx);
  await $`cargo check --locked --target ${ctx.tools.rustTarget} -p di-framework-pglite-component`;
}

if (import.meta.main) await run('check', check);
