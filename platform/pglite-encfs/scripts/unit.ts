/** `make unit`: rustfmt, clippy (host and Wasm) and the host unit tests. */
import { join } from 'node:path';
import { $ } from 'bun';
import { ensureToolchain } from './build.ts';
import { type Context, RUST_TARGET, run } from './lib/env.ts';

export async function unit(ctx: Context): Promise<void> {
  await ensureToolchain(ctx);
  await $`cargo fmt --check`;
  await $`cargo clippy --locked --lib --tests -- -D warnings`;
  await $`cargo clippy --locked --release --target ${RUST_TARGET} -- -D warnings`;
  // The smoke root probe (tests/root-probe) and the benchmark consumer
  // (tests/bench) are their own crates.
  for (const [name, target] of [
    ['root-probe', RUST_TARGET],
    ['bench', 'wasm32-wasip2'],
  ] as const) {
    const cwd = join(ctx.pkgDir, 'tests', name);
    await $`cargo fmt --check`.cwd(cwd);
    await $`cargo clippy --locked --release --target ${target} -- -D warnings`
      .cwd(cwd)
      .env({ ...ctx.env, CARGO_TARGET_DIR: join(ctx.pkgDir, 'target', name) });
  }
  await $`cargo test --locked --lib`;
}

if (import.meta.main) await run('unit', unit);
