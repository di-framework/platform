/** `make unit`: prepare the engine, then run the provider's Rust unit tests on the host. */
import { $ } from 'bun';
import { type Context, run } from './lib/cli.ts';
import { prepareEngine } from './prepare-engine.ts';

export async function unit(ctx: Context): Promise<void> {
  await prepareEngine(ctx);
  await $`cargo test --locked --lib -p di-framework-pglite-component`;
}

if (import.meta.main) await run('unit', unit);
