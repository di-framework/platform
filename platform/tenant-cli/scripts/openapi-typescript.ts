/**
 * Run the `openapi-typescript` CLI against the TypeScript 6 compiler API.
 *
 * TypeScript 7, the repo's compiler, ships no JavaScript compiler API, but
 * openapi-typescript (peer `typescript@^5`) builds its output with the
 * compiler's factory and printer. A runtime plugin replaces the `typescript`
 * module openapi-typescript resolves with `@typescript/typescript6`, the
 * official TypeScript 6 API package, so the generated file is unchanged.
 *
 *   bun --no-install scripts/openapi-typescript.ts <openapi.yaml> -o <schema.d.ts>
 */
import { dirname } from 'node:path';
import { plugin } from 'bun';

const cli = Bun.resolveSync('openapi-typescript/bin/cli.js', import.meta.dir);
const compilerDir = dirname(Bun.resolveSync('typescript/package.json', dirname(cli)));
let typescript6: object;
try {
  typescript6 = (await import('@typescript/typescript6')).default;
} catch (error) {
  throw new Error(
    '@typescript/typescript6 is required to run openapi-typescript under TypeScript 7; run `bun install`',
    { cause: error },
  );
}
const escaped = compilerDir.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

plugin({
  name: 'typescript6-api',
  setup(build) {
    // Runtime plugins cannot rewrite static specifiers, so replace the module
    // openapi-typescript resolves `typescript` to when it is loaded.
    build.onLoad({ filter: new RegExp(`^${escaped}/`) }, () => ({
      loader: 'object',
      exports: { ...typescript6, default: typescript6 },
    }));
  },
});

await import(cli);
