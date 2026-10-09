/** Plug a consumer component into the PGlite provider with the pinned `wac`. */
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import { type Args, type Context, parseFlags, run, UsageError } from './lib/cli.ts';
import { fileExists } from './lib/fs.ts';

const USAGE = [
  'compose a consumer component with the PGlite provider',
  '',
  '  compose.ts <app.wasm> <out.wasm> [provider.wasm]',
  '',
  'The consumer must import `di-framework:pglite/database@0.1.0`.',
].join('\n');

export interface ComposeArgs {
  app: string;
  out: string;
  provider: string;
}

/** Positional paths resolve against `cwd`, not the package, so `make compose APP=...` keeps working. */
export function parseComposeArgs(
  argv: string[],
  pkgDir: string,
  cwd = process.cwd(),
): Args<ComposeArgs> {
  const flags = parseFlags(argv, {}, USAGE, { positionals: true });
  if (flags.help) return flags;
  const [app, out, provider, ...extra] = flags.positionals;
  if (!app || !out) throw new UsageError(`missing <app.wasm> and <out.wasm>\n\n${USAGE}`);
  if (extra.length > 0) throw new UsageError(`too many arguments\n\n${USAGE}`);
  return {
    help: false,
    app: resolve(cwd, app),
    out: resolve(cwd, out),
    provider: provider ? resolve(cwd, provider) : join(pkgDir, 'dist', 'di-framework-pglite.wasm'),
  };
}

export async function composeConsumer(ctx: Context, { app, out, provider }: ComposeArgs) {
  const need = (cmd: string): void => {
    if (!Bun.which(cmd, { PATH: ctx.env.PATH })) {
      throw new Error(`${cmd} not found; run bun scripts/install-tools.ts`);
    }
  };
  need('wac');
  need('wasm-tools');
  if (!(await fileExists(app))) throw new Error(`consumer component not found: ${app}`);
  if (!(await fileExists(provider))) {
    throw new Error(`provider component not found: ${provider} (run make build)`);
  }
  console.error((await $`wac --version`.text()).trim());
  await $`wac plug --plug ${provider} ${app} -o ${out}`;
  await $`wasm-tools validate --features all ${out}`;
  const wit = await $`wasm-tools component wit ${out}`.text();
  if (wit.includes('import di-framework:pglite/database@0.1.0')) {
    throw new Error(`${out} still imports di-framework:pglite/database@0.1.0; plug did not apply`);
  }
  console.error(`[compose] ok: ${out}`);
  console.error(wit.match(/^world root[\s\S]*?^}/m)?.[0] ?? wit);
}

export async function compose(ctx: Context, argv: string[]): Promise<void> {
  const args = parseComposeArgs(argv, ctx.pkgDir);
  if (args.help) {
    console.error(USAGE);
    return;
  }
  await composeConsumer(ctx, args);
}

if (import.meta.main) await run('compose', compose);
