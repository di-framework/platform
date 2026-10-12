/**
 * Plain-HTTP registries tenant hosts may pull from (#149). Tenant hosts never run
 * `--allow-insecure-registries`, which would switch every pull (GHCR and the tenant registry's
 * TLS pull listener included) to plain HTTP. They get one `--insecure-registry <host[:port]>` per
 * entry instead; wash matches it exactly against the reference's registry (case-sensitive, no
 * default-port normalisation), so each entry must be spelled as workload references spell it.
 */

/** Service name and port of the platform's own registry (`registry: true`). */
export const PLATFORM_REGISTRY_SERVICE = 'di-framework-registry';
export const PLATFORM_REGISTRY_PORT = 5000;

/**
 * The registry host workload references use for the platform registry: the stack output
 * `registry.pull`, and so the exact spelling the tenant hosts' allowlist must carry.
 */
export function platformRegistryPullHost(namespace: string): string {
  return `${PLATFORM_REGISTRY_SERVICE}.${namespace}.svc.cluster.local:${PLATFORM_REGISTRY_PORT}`;
}

const HOST_PORT = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$/;

/**
 * The tenant hosts' `--insecure-registry` entries: the platform registry when it is installed and
 * `insecureRegistry` is set, then `extra` (config `insecureRegistries`, for registries the caller
 * runs itself), without duplicates. Empty unless `insecureRegistry` is set.
 */
export function tenantInsecureRegistries(args: {
  insecureRegistry?: boolean;
  registry?: boolean;
  namespace: string;
  extra?: readonly string[];
}): string[] {
  const extra = args.extra ?? [];
  for (const entry of extra) {
    if (typeof entry !== 'string' || !HOST_PORT.test(entry))
      throw new Error(
        `insecureRegistries entries must be a registry host[:port] (no scheme or path) as workload references spell it; received ${JSON.stringify(entry)}`,
      );
  }
  if (!args.insecureRegistry) {
    if (extra.length) throw new Error('insecureRegistries requires insecureRegistry: true');
    return [];
  }
  const own = args.registry ? [platformRegistryPullHost(args.namespace)] : [];
  return [...new Set([...own, ...extra])];
}
