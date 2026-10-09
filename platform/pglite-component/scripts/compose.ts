/** Plug a consumer component into the PGlite provider with the pinned `wac`. */
import { join } from 'node:path';
import { die, dieUsage, fileExists, loadToolEnv, packageDir, setupEnv } from './lib.ts';

export interface ComposeArgs {
  app: string;
  out: string;
  provider: string;
}

export function parseComposeArgs(argv: string[], pkgDir: string): ComposeArgs {
  const [app, out, provider] = argv;
  if (!app || !out || argv.length > 3) {
    console.error(
      [
        'compose a consumer component with the PGlite provider',
        '',
        '  compose.ts <app.wasm> <out.wasm> [provider.wasm]',
        '',
        'The consumer must import `di-framework:pglite/database@0.1.0`.',
        '',
      ].join('\n'),
    );
    dieUsage(
      'compose',
      argv.length < 2 ? 'missing <app.wasm> and <out.wasm>' : `too many arguments`,
    );
  }
  return {
    app: app as string,
    out: out as string,
    provider: (provider as string | undefined) ?? join(pkgDir, 'dist', 'di-framework-pglite.wasm'),
  };
}

export async function composeConsumer(app: string, out: string, provider: string): Promise<void> {
  if (!Bun.which('wac')) die('compose', 'wac not found; run bun scripts/install-tools.ts');
  if (!Bun.which('wasm-tools'))
    die('compose', 'wasm-tools not found; run bun scripts/install-tools.ts');
  if (!(await fileExists(app))) die('compose', `consumer component not found: ${app}`);
  if (!(await fileExists(provider)))
    die('compose', `provider component not found: ${provider} (run make build)`);
  console.error((await Bun.$`wac --version`.text()).trim());
  await Bun.$`wac plug --plug ${provider} ${app} -o ${out}`;
  await Bun.$`wasm-tools validate --features all ${out}`;
  const wit = await Bun.$`wasm-tools component wit ${out}`.text();
  if (wit.includes('import di-framework:pglite/database@0.1.0')) {
    die('compose', `${out} still imports di-framework:pglite/database@0.1.0; plug did not apply`);
  }
  console.error(`[compose] ok: ${out}`);
  const worldBlock = wit.match(/^world root[\s\S]*?^}/m);
  console.error(worldBlock?.[0] ?? wit);
}

if (import.meta.main) {
  const pkgDir = packageDir(import.meta.url);
  const env = await loadToolEnv(pkgDir);
  await setupEnv(env);
  const args = parseComposeArgs(process.argv.slice(2), pkgDir);
  try {
    await composeConsumer(args.app, args.out, args.provider);
  } catch (error) {
    die('compose', error instanceof Error ? error.message : String(error));
  }
}
