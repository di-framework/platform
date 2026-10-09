/**
 * Entry-point plumbing for `bun scripts/<name>.ts`.
 *
 * Commands receive a {@link Context} and throw on failure; {@link run} is the
 * only place that touches `process.argv`, Bun Shell defaults, or the exit code.
 */
import { resolve } from 'node:path';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import { $ } from 'bun';
import { type Env, loadTools, resolveToolsEnv, type Tools, type ToolsEnv } from './toolchain.ts';

export const PKG_DIR = resolve(import.meta.dir, '..', '..');

export interface Context {
  pkgDir: string;
  tools: Tools;
  /** What the pinned toolchain adds to the caller's environment. */
  toolsEnv: ToolsEnv;
  /** Full environment for every spawned tool: caller's env plus {@link toolsEnv}. */
  env: Env;
}

export type Command = (ctx: Context, argv: string[]) => Promise<void>;

/** Thrown for bad command-line input; {@link run} exits 2 instead of 1. */
export class UsageError extends Error {}

export async function createContext(pkgDir = PKG_DIR, base: Env = process.env): Promise<Context> {
  const tools = await loadTools(pkgDir, base);
  const toolsEnv = await resolveToolsEnv(tools, base);
  return { pkgDir, tools, toolsEnv, env: { ...base, ...toolsEnv } };
}

/** Build the context, point Bun Shell at the package, run the command, map errors to exit codes. */
export async function run(tag: string, command: Command): Promise<void> {
  try {
    const ctx = await createContext();
    $.cwd(ctx.pkgDir);
    $.env(ctx.env);
    await command(ctx, process.argv.slice(2));
  } catch (error) {
    console.error(`[${tag}] error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}

export function logger(tag: string): (message: string) => void {
  return (message) => console.error(`[${tag}] ${message}`);
}

type FlagOptions = NonNullable<ParseArgsConfig['options']>;
type ParsedValues<T extends FlagOptions> = ReturnType<
  typeof parseArgs<{ options: T; strict: true; allowPositionals: true }>
>['values'];

/** Parsed command arguments: either a help request or the command's options. */
export type Args<T> = { help: true } | ({ help: false } & T);

export type Flags<T extends FlagOptions> = Args<{ values: ParsedValues<T>; positionals: string[] }>;

/**
 * Strict `util.parseArgs` with `-h/--help` added. Unknown flags become a
 * {@link UsageError} carrying `usage`; `--help` is reported, not acted on, so
 * commands stay free of `process.exit`.
 */
export function parseFlags<T extends FlagOptions>(
  argv: string[],
  options: T,
  usage: string,
  { positionals = false }: { positionals?: boolean } = {},
): Flags<T> {
  try {
    const parsed = parseArgs({
      args: argv,
      options: { ...options, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: positionals,
    });
    const values = parsed.values as ParsedValues<T> & { help?: boolean };
    if (values.help === true) return { help: true };
    return { help: false, values, positionals: parsed.positionals };
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
  }
}
