/**
 * The environment for every process these tests spawn (git, bun scripts, the pin action).
 *
 * Git hooks (pre-push runs this suite) export GIT_DIR and friends, which would point every git
 * command at the hook's repository instead of the one in `cwd`; every GIT_* variable is dropped.
 * The developer's global and system git config (hooksPath, templates, url rewrites) are ignored
 * too, so sandboxes behave the same everywhere.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const spawnEnv: Record<string, string> = {
  ...(Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  ) as Record<string, string>),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

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
