/**
 * The environment for every process these tests spawn (git, bun scripts, the pin action).
 *
 * Git hooks (pre-push runs this suite) export GIT_DIR and friends, which would point every git
 * command at the hook's repository instead of the one in `cwd`; every GIT_* variable is dropped.
 * The developer's global and system git config (hooksPath, templates, url rewrites) are ignored
 * too, so sandboxes behave the same everywhere. In their place a sandbox global config points
 * `core.hooksPath` and `init.templateDir` at an empty directory: no hook runs in a sandbox, and
 * `init` and `clone` do not copy the sample hooks into every repository.
 */
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandboxHome = mkdtempSync(join(tmpdir(), 'sandbox-home-'));
const empty = join(sandboxHome, 'empty');
mkdirSync(empty);
const gitConfig = join(sandboxHome, 'config');
writeFileSync(gitConfig, `[core]\n\thooksPath = ${empty}\n[init]\n\ttemplateDir = ${empty}\n`);

export const spawnEnv: Record<string, string> = {
  ...(Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  ) as Record<string, string>),
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: '1',
};

/**
 * One executable for every stub command: it sources `<its own path>.sh`. On macOS the first run
 * of a newly written executable waits for a system policy check (about 200 ms idle, far longer
 * on a loaded machine), and a stub written per test paid it every time. A symlink to this file
 * runs at the cost of an ordinary exec, and the script it sources is only read, never executed.
 */
const dispatcher = join(sandboxHome, 'stub');
writeFileSync(dispatcher, '#!/bin/bash\n. "$0.sh"\n');
chmodSync(dispatcher, 0o755);

/** Put a `name` command in `bin` that runs the bash `script` with the caller's arguments. */
export function stubCommand(bin: string, name: string, script: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, `${name}.sh`), `${script}\n`);
  symlinkSync(dispatcher, join(bin, name));
}

/** Run git in `cwd` with the sandbox environment and a fixed identity; throws on failure. */
export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    env: spawnEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.toString().trim();
}

/** A clone whose `origin` is a fresh local bare repository (never a network remote). */
export function sandboxClone(prefix: string): { base: string; origin: string; work: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const origin = join(base, 'origin.git');
  const work = join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, work);
  return { base, origin, work };
}

const templates = new Map<string, { base: string; value: unknown }>();

/**
 * A private copy of a {@link sandboxClone} that `build` prepares once per `key`. Preparing a
 * sandbox takes a handful of git processes and copying a prepared one takes none, so a file that
 * starts many tests from the same history pays for it once instead of once per test. Every call
 * still gets its own directories, so no test sees another's commits. `value` is what `build`
 * returned; it must not depend on the template's paths (commit ids are fine).
 */
export function sandboxCopy<T>(
  prefix: string,
  key: string,
  build: (box: { base: string; origin: string; work: string }) => T,
): { base: string; origin: string; work: string; value: T } {
  const id = `${prefix}\0${key}`;
  let template = templates.get(id);
  if (!template) {
    const box = sandboxClone(prefix);
    template = { base: box.base, value: build(box) };
    templates.set(id, template);
  }
  const base = mkdtempSync(join(tmpdir(), prefix));
  cpSync(template.base, base, { recursive: true });
  // The clone's `origin` is an absolute path into the template; point it at the copy instead.
  const config = join(base, 'work', '.git', 'config');
  const text = readFileSync(config, 'utf8')
    .replaceAll(realpathSync(template.base), base)
    .replaceAll(template.base, base);
  writeFileSync(config, text);
  return {
    base,
    origin: join(base, 'origin.git'),
    work: join(base, 'work'),
    value: template.value as T,
  };
}
