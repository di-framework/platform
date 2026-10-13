/** `make unit`: rustfmt, clippy (host and Wasm) and the host unit tests. */
import { $ } from 'bun';
import { ensureToolchain } from './build.ts';
import { type Context, RUST_TARGET, run } from './lib/env.ts';

export async function unit(ctx: Context): Promise<void> {
  await ensureToolchain(ctx);
  await $`cargo fmt --check`;
  await $`cargo clippy --locked --lib --tests -- -D warnings`;
  await $`cargo clippy --locked --lib --tests --features write-codec-3 -- -D warnings`;
  await $`cargo clippy --locked --release --target ${RUST_TARGET} -- -D warnings`;
  await $`cargo clippy --locked --release --target ${RUST_TARGET} --features write-codec-3 -- -D warnings`;
  // Default build (writes codec 2) and the opt-in codec-3 writer.
  await $`cargo test --locked --lib`;
  await $`cargo test --locked --lib --features write-codec-3`;
}

if (import.meta.main) await run('unit', unit);
