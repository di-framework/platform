import { CloudflareDetector, type CloudflareRuntimeScope } from './detector';
import { type BindingClassifierRegistry, getDefaultRegistry } from './spi/registry';
import type {
  AiBindingInfo,
  AnalyticsBindingInfo,
  BindingFilter,
  CloudflareBindingInfo,
  CloudflareBindingKind,
  D1BindingInfo,
  DurableObjectBindingInfo,
  HyperdriveBindingInfo,
  KvBindingInfo,
  QueueBindingInfo,
  R2BindingInfo,
  ServiceBindingInfo,
  VectorizeBindingInfo,
  WranglerBindingDeclaration,
} from './types';
import { parseWranglerBindings } from './wrangler';

export interface CloudflareEnvironmentOptions {
  /** Worker `env`. An empty object disables local fallback. */
  bindings?: Readonly<Record<string, unknown>>;
  /** Parsed wrangler config, or a JSON string of one. */
  config?: unknown;
  env?: Record<string, string | undefined>;
  /** Runtime scope used for the Workers user-agent check. Defaults to `globalThis`. */
  scope?: CloudflareRuntimeScope;
  registry?: BindingClassifierRegistry;
  secretNames?: readonly string[];
  kindHints?: Readonly<Record<string, CloudflareBindingKind>>;
  localFallback?: boolean | Readonly<Record<string, unknown>>;
}

export class CloudflareEnvironment {
  private readonly options: CloudflareEnvironmentOptions;
  private readonly env: Record<string, string | undefined>;
  private readonly scope: CloudflareRuntimeScope;
  private readonly registry: BindingClassifierRegistry;
  private readonly secretNames: ReadonlySet<string>;
  private readonly kindHints: Readonly<Record<string, CloudflareBindingKind>>;
  private readonly localFallback: boolean | Readonly<Record<string, unknown>>;
  private bindings: readonly CloudflareBindingInfo[] | undefined;
  private declarations: readonly WranglerBindingDeclaration[] | undefined;

  constructor(options: CloudflareEnvironmentOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.scope = options.scope ?? globalThis;
    this.registry = options.registry ?? getDefaultRegistry();
    this.secretNames = new Set(options.secretNames ?? []);
    this.kindHints = options.kindHints ?? {};
    if (options.localFallback === false) {
      this.localFallback = false;
    } else if (typeof options.localFallback === 'object') {
      this.localFallback = options.localFallback;
    } else {
      this.localFallback = true;
    }
  }

  isCloudflare(): boolean {
    return CloudflareDetector.isCloudflare(this.scope, this.env);
  }

  getDeclarations(): readonly WranglerBindingDeclaration[] {
    if (this.declarations === undefined) {
      this.declarations = parseWranglerBindings(this.options.config);
    }
    return this.declarations;
  }

  getBindings<T extends CloudflareBindingInfo = CloudflareBindingInfo>(
    filter?: BindingFilter | string | RegExp,
  ): readonly T[] {
    const all = this.ensureBindings() as readonly T[];
    if (!filter) return all;
    if (typeof filter === 'string') {
      return all.filter((binding) => binding.name === filter);
    }
    if (filter instanceof RegExp) {
      return all.filter((binding) => filter.test(binding.name));
    }
    return all.filter((binding) => matchesFilter(binding, filter));
  }

  getBinding<T extends CloudflareBindingInfo = CloudflareBindingInfo>(name: string): T | null {
    return this.getBindings<T>(name)[0] ?? null;
  }

  getKvBinding(name?: string): KvBindingInfo | null {
    return this.bindingOfKind('kv', name);
  }

  getD1Binding(name?: string): D1BindingInfo | null {
    return this.bindingOfKind('d1', name);
  }

  getR2Binding(name?: string): R2BindingInfo | null {
    return this.bindingOfKind('r2', name);
  }

  getDurableObjectBinding(name?: string): DurableObjectBindingInfo | null {
    return this.bindingOfKind('durable-object', name);
  }

  getQueueBinding(name?: string): QueueBindingInfo | null {
    return this.bindingOfKind('queue', name);
  }

  getServiceBinding(name?: string): ServiceBindingInfo | null {
    return this.bindingOfKind('service', name);
  }

  getAiBinding(name?: string): AiBindingInfo | null {
    return this.bindingOfKind('ai', name);
  }

  getHyperdriveBinding(name?: string): HyperdriveBindingInfo | null {
    return this.bindingOfKind('hyperdrive', name);
  }

  getVectorizeBinding(name?: string): VectorizeBindingInfo | null {
    return this.bindingOfKind('vectorize', name);
  }

  getAnalyticsBinding(name?: string): AnalyticsBindingInfo | null {
    return this.bindingOfKind('analytics', name);
  }

  getBindingByKind<T extends CloudflareBindingInfo = CloudflareBindingInfo>(
    kind: CloudflareBindingKind,
    name?: string,
  ): T | null {
    return this.bindingOfKind(kind, name);
  }

  private bindingOfKind<T extends CloudflareBindingInfo>(
    kind: CloudflareBindingKind,
    name?: string,
  ): T | null {
    if (name) {
      const found = this.getBinding<T>(name);
      return found?.kind === kind ? found : null;
    }
    return this.getBindings<T>({ kind })[0] ?? null;
  }

  private ensureBindings(): readonly CloudflareBindingInfo[] {
    if (this.bindings !== undefined) return this.bindings;
    const declared = new Map(this.getDeclarations().map((entry) => [entry.name, entry]));
    const live = this.resolveLiveBindings();
    const names = [...new Set([...declared.keys(), ...Object.keys(live)])].sort((a, b) =>
      a.localeCompare(b),
    );
    const result: CloudflareBindingInfo[] = [];
    for (const name of names) {
      const declaration = declared.get(name);
      const hasLive = Object.hasOwn(live, name);
      const liveValue = hasLive ? live[name] : undefined;
      if (liveValue === undefined && !declaration) continue;
      if (liveValue === null && !declaration) continue;
      result.push(this.describe(name, liveValue, declaration));
    }
    this.bindings = result;
    return result;
  }

  private resolveLiveBindings(): Readonly<Record<string, unknown>> {
    if (this.options.bindings !== undefined) return this.options.bindings;
    const published = getCloudflareBindings();
    if (published !== undefined) return published;
    if (typeof this.localFallback === 'object') return this.localFallback;
    if (this.localFallback === true) return parseBindingsJson(this.env.CLOUDFLARE_BINDINGS);
    return {};
  }

  private describe(
    name: string,
    value: unknown,
    declaration: WranglerBindingDeclaration | undefined,
  ): CloudflareBindingInfo {
    const classified = this.registry.classify(name, value);
    let kind = declaration?.kind ?? classified.kind;
    const hint = this.kindHints[name];
    if (hint) kind = hint;
    if (kind === 'var' && this.secretNames.has(name)) kind = 'secret';

    const fallback = declaration?.config.value;
    const binding = value === undefined || value === null ? fallback : value;
    const config = declaration?.config;
    if (kind === 'hyperdrive') {
      return {
        name,
        kind,
        ...(binding !== undefined ? { binding } : {}),
        connectionString: readConnectionString(binding, config),
        ...(config ? { config } : {}),
      } as HyperdriveBindingInfo;
    }
    return {
      name,
      kind,
      ...(binding !== undefined ? { binding } : {}),
      ...(config ? { config } : {}),
    };
  }
}

function matchesFilter(binding: CloudflareBindingInfo, filter: BindingFilter): boolean {
  if (filter.name) {
    if (typeof filter.name === 'string' && binding.name !== filter.name) return false;
    if (filter.name instanceof RegExp && !filter.name.test(binding.name)) return false;
  }
  if (filter.kind && binding.kind !== filter.kind) return false;
  if (filter.predicate && !filter.predicate(binding)) return false;
  return true;
}

function readConnectionString(
  binding: unknown,
  config: Readonly<Record<string, unknown>> | undefined,
): string {
  if (typeof binding === 'object' && binding !== null && 'connectionString' in binding) {
    const value = (binding as { connectionString?: unknown }).connectionString;
    if (typeof value === 'string') return value;
  }
  const configured = config?.connectionString;
  return typeof configured === 'string' ? configured : '';
}

function parseBindingsJson(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

let defaultEnvironment: CloudflareEnvironment | null = null;
let currentBindings: Readonly<Record<string, unknown>> | undefined;

/**
 * Publishes the Worker `env` for later lookups.
 * Module initialization cannot see bindings; call this from the request handler
 * before resolving services.
 */
export function setCloudflareBindings(
  bindings: Readonly<Record<string, unknown>> | undefined,
): void {
  currentBindings = bindings;
  resetDefaultEnvironment();
}

export function getCloudflareBindings(): Readonly<Record<string, unknown>> | undefined {
  return currentBindings;
}

export function resetCloudflareBindings(): void {
  currentBindings = undefined;
  resetDefaultEnvironment();
}

export function getDefaultEnvironment(): CloudflareEnvironment {
  if (!defaultEnvironment) {
    defaultEnvironment = new CloudflareEnvironment();
  }
  return defaultEnvironment;
}

export function resetDefaultEnvironment(): void {
  defaultEnvironment = null;
}
