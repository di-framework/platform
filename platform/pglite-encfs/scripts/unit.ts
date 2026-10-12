/** `make unit`: rustfmt, clippy (host and Wasm) and the host unit tests. */
import { $ } from 'bun';
import { ensureToolchain } from './build.ts';
import { type Context, RUST_TARGET, run } from './lib/env.ts';

export async function unit(ctx: Context): Promise<void> {
  await ensureToolchain(ctx);
  await $`cargo fmt --check`;
  await $`cargo clippy --locked --lib --tests -- -D warnings`;
  await $`cargo clippy --locked --release --target ${RUST_TARGET} -- -D warnings`;
  await $`cargo test --locked --lib`;
}

if (import.meta.main) await run('unit', unit);
