import { useContainer } from '@di-framework/core/container';
import { readProcessEnv } from './detector';
import { CloudflareEnvironment, setCloudflareBindings } from './environment';
import type { BindingClassifierRegistry } from './spi/registry';
import type {
  CloudflareBindingKind,
  CloudflareBindingOptions,
  EnableCloudflareBindingsOptions,
} from './types';
import { CLOUDFLARE_BINDING_KINDS } from './types';

export const CFW_ENVIRONMENT_TOKEN = 'cfw:environment';

export function cloudflareBindingToken(name: string): string {
  return `cfw:binding:${name}`;
}

export function cloudflareKindToken(kind: CloudflareBindingKind): string {
  return `cfw:kind:${kind}`;
}

export const CFW_KV_TOKEN = cloudflareKindToken('kv');
export const CFW_D1_TOKEN = cloudflareKindToken('d1');
export const CFW_R2_TOKEN = cloudflareKindToken('r2');
export const CFW_DURABLE_OBJECT_TOKEN = cloudflareKindToken('durable-object');
export const CFW_QUEUE_TOKEN = cloudflareKindToken('queue');
export const CFW_SERVICE_TOKEN = cloudflareKindToken('service');
export const CFW_AI_TOKEN = cloudflareKindToken('ai');
export const CFW_HYPERDRIVE_TOKEN = cloudflareKindToken('hyperdrive');
export const CFW_VECTORIZE_TOKEN = cloudflareKindToken('vectorize');
export const CFW_ANALYTICS_TOKEN = cloudflareKindToken('analytics');

interface BindingContainer {
  has?: (token: string) => boolean;
  registerFactory?: (
    token: string | typeof CloudflareEnvironment,
    factory: () => unknown,
    options?: { singleton?: boolean },
  ) => void;
  registerValue?: (token: string | typeof CloudflareEnvironment, value: unknown) => void;
  registerInstance?: (token: string | typeof CloudflareEnvironment, value: unknown) => void;
  resolve?: (token: string) => unknown;
}

function asContainer(value: unknown): BindingContainer | undefined {
  if (typeof value === 'object' && value !== null) return value as BindingContainer;
  if (typeof value === 'function') return value as BindingContainer;
  return undefined;
}

function environmentOptions(
  options: EnableCloudflareBindingsOptions,
): ConstructorParameters<typeof CloudflareEnvironment>[0] {
  return {
    ...(options.bindings !== undefined ? { bindings: options.bindings } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.secretNames !== undefined ? { secretNames: options.secretNames } : {}),
    ...(options.kindHints !== undefined ? { kindHints: options.kindHints } : {}),
    ...(options.localFallback !== undefined ? { localFallback: options.localFallback } : {}),
    ...(options.registry !== undefined
      ? { registry: options.registry as BindingClassifierRegistry }
      : {}),
  };
}

export function lookupCloudflareBinding(
  name: string,
  options: CloudflareBindingOptions = {},
): unknown {
  const env = new CloudflareEnvironment(environmentOptions(options));
  const found = env.getBinding(name);
  if (found) return found;

  const fallback = readFallbackEnv(options.fallbackEnv, options.env ?? readProcessEnv());
  if (fallback) {
    return { name, kind: 'var' as const, binding: fallback };
  }
  if (options.defaultValue !== undefined) return options.defaultValue;
  if (options.required !== false) {
    throw new Error(`Cloudflare binding '${name}' was not found`);
  }
  return undefined;
}

function readFallbackEnv(
  fallbackEnv: string | readonly string[] | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  if (!fallbackEnv) return undefined;
  const keys = Array.isArray(fallbackEnv) ? fallbackEnv : [fallbackEnv];
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function registerLazy(
  container: BindingContainer,
  token: string | typeof CloudflareEnvironment,
  factory: () => unknown,
): void {
  if (typeof token === 'string' && typeof container.has === 'function' && container.has(token)) {
    return;
  }
  if (typeof container.registerFactory === 'function') {
    container.registerFactory(token, factory, { singleton: false });
    return;
  }
  const value = factory();
  if (typeof container.registerValue === 'function') {
    container.registerValue(token, value);
    return;
  }
  if (typeof container.registerInstance === 'function') {
    container.registerInstance(token, value);
  }
}

export function registerCloudflareBinding(
  name: string,
  options: CloudflareBindingOptions = {},
  targetContainer?: unknown,
): void {
  const container = asContainer(targetContainer ?? options.container ?? useContainer());
  if (!container) return;
  registerLazy(container, cloudflareBindingToken(name), () =>
    lookupCloudflareBinding(name, options),
  );
}

/**
 * Publishes `bindings` for later resolves and registers lazy factories.
 * Call `setCloudflareBindings(env)` from the Worker handler before resolving
 * services when the env object is not known at registration time.
 */
export function bindCloudflareBindings(
  targetContainer?: unknown,
  options: EnableCloudflareBindingsOptions = {},
): CloudflareEnvironment {
  if (options.bindings !== undefined) {
    setCloudflareBindings(options.bindings);
  }
  const container = asContainer(targetContainer ?? options.container ?? useContainer());
  const snapshot = new CloudflareEnvironment(environmentOptions(options));
  if (!container) return snapshot;

  const factoryOptions = environmentOptions(options);
  registerLazy(container, CloudflareEnvironment, () => new CloudflareEnvironment(factoryOptions));
  registerLazy(container, CFW_ENVIRONMENT_TOKEN, () => new CloudflareEnvironment(factoryOptions));

  for (const kind of CLOUDFLARE_BINDING_KINDS) {
    registerLazy(container, cloudflareKindToken(kind), () => {
      return new CloudflareEnvironment(factoryOptions).getBindingByKind(kind);
    });
  }

  const knownNames = new Set<string>([
    ...snapshot.getBindings().map((binding) => binding.name),
    ...snapshot.getDeclarations().map((declaration) => declaration.name),
  ]);
  for (const name of knownNames) {
    registerLazy(container, cloudflareBindingToken(name), () =>
      lookupCloudflareBinding(name, options),
    );
  }

  return snapshot;
}
