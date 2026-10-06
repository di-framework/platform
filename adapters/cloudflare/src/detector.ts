/**
 * Detects the Cloudflare Workers and Pages runtimes.
 * Workers identify themselves with the `Cloudflare-Workers` user agent.
 * Pages Functions set `CF_PAGES=1`.
 */

export interface CloudflareRuntimeScope {
  navigator?: { userAgent?: string };
}

const WORKERS_USER_AGENT = 'Cloudflare-Workers';

type ProcessScope = { process?: { env?: Record<string, string | undefined> } };

/**
 * Reads `process.env` when the runtime provides it.
 * Workers do not define `process` unless `nodejs_compat` is enabled.
 */
export function readProcessEnv(
  scope: ProcessScope = globalThis,
): Record<string, string | undefined> {
  return scope.process?.env ?? {};
}

// Mirrors CloudFoundryDetector: a small static facade next to the standalone functions.
// biome-ignore lint/complexity/noStaticOnlyClass: same shape as CloudFoundryDetector
export class CloudflareDetector {
  static isWorkers(scope: CloudflareRuntimeScope = globalThis): boolean {
    return scope.navigator?.userAgent === WORKERS_USER_AGENT;
  }

  static isPages(env: Record<string, string | undefined> = readProcessEnv()): boolean {
    return env.CF_PAGES === '1';
  }

  static isCloudflare(
    scope: CloudflareRuntimeScope = globalThis,
    env: Record<string, string | undefined> = readProcessEnv(),
  ): boolean {
    return CloudflareDetector.isWorkers(scope) || CloudflareDetector.isPages(env);
  }
}

export function isCloudflareWorkers(scope: CloudflareRuntimeScope = globalThis): boolean {
  return CloudflareDetector.isWorkers(scope);
}

export function isCloudflarePages(
  env: Record<string, string | undefined> = readProcessEnv(),
): boolean {
  return CloudflareDetector.isPages(env);
}

export function isCloudflare(
  scope: CloudflareRuntimeScope = globalThis,
  env: Record<string, string | undefined> = readProcessEnv(),
): boolean {
  return CloudflareDetector.isCloudflare(scope, env);
}
