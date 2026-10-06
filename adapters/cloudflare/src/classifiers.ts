import type { CloudflareBindingClassifier } from './spi/classifier';
import type {
  AnalyticsBindingInfo,
  CloudflareBindingInfo,
  CloudflareBindingKind,
  HyperdriveBindingInfo,
} from './types';

export function isBindingRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasFunctions(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => typeof value[name] === 'function');
}

function lacksFunctions(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => typeof value[name] !== 'function');
}

class ShapeClassifier implements CloudflareBindingClassifier {
  constructor(
    readonly kind: CloudflareBindingKind,
    private readonly matches: (value: Record<string, unknown>) => boolean,
  ) {}

  accept(_name: string, value: unknown): boolean {
    return isBindingRecord(value) && this.matches(value);
  }

  create(name: string, value: unknown): CloudflareBindingInfo {
    return { name, kind: this.kind, binding: value };
  }
}

class HyperdriveClassifier implements CloudflareBindingClassifier<HyperdriveBindingInfo> {
  readonly kind = 'hyperdrive' as const;

  accept(_name: string, value: unknown): boolean {
    if (!isBindingRecord(value) || typeof value.connectionString !== 'string') return false;
    return (
      typeof value.host === 'string' ||
      typeof value.database === 'string' ||
      typeof value.user === 'string'
    );
  }

  create(name: string, value: unknown): HyperdriveBindingInfo {
    const record = value as Record<string, unknown>;
    return {
      name,
      kind: 'hyperdrive',
      binding: value as HyperdriveBindingInfo['binding'],
      connectionString: String(record.connectionString),
    };
  }
}

class AnalyticsClassifier implements CloudflareBindingClassifier<AnalyticsBindingInfo> {
  readonly kind = 'analytics' as const;

  accept(_name: string, value: unknown): boolean {
    return isBindingRecord(value) && typeof value.writeDataPoint === 'function';
  }

  create(name: string, value: unknown): AnalyticsBindingInfo {
    return {
      name,
      kind: 'analytics',
      binding: value as AnalyticsBindingInfo['binding'],
    };
  }
}

class VarClassifier implements CloudflareBindingClassifier {
  readonly kind = 'var' as const;

  accept(_name: string, value: unknown): boolean {
    const kind = typeof value;
    return kind === 'string' || kind === 'number' || kind === 'boolean';
  }

  create(name: string, value: unknown): CloudflareBindingInfo {
    return { name, kind: 'var', binding: value };
  }
}

function shape(
  kind: CloudflareBindingKind,
  required: readonly string[],
  rejected: readonly string[] = [],
  extra?: (value: Record<string, unknown>) => boolean,
): CloudflareBindingClassifier {
  return new ShapeClassifier(kind, (value) => {
    if (!hasFunctions(value, required) || !lacksFunctions(value, rejected)) return false;
    return extra ? extra(value) : true;
  });
}

/**
 * Built-in classifiers, ordered from the most specific host-object shape
 * to primitives. Fetchers are last because several bindings also expose `fetch`.
 */
export function createDefaultClassifiers(): CloudflareBindingClassifier[] {
  return [
    new HyperdriveClassifier(),
    shape('d1', ['prepare', 'batch'], ['idFromName'], (value) => {
      return typeof value.exec === 'function' || typeof value.dump === 'function';
    }),
    shape('r2', ['get', 'put', 'head']),
    shape('kv', ['get', 'put', 'delete', 'list'], ['head', 'createMultipartUpload', 'prepare']),
    shape('durable-object', ['get', 'idFromName', 'idFromString']),
    shape('queue', ['send', 'sendBatch']),
    shape('vectorize', ['query'], ['prepare'], (value) => {
      return typeof value.upsert === 'function' || typeof value.insert === 'function';
    }),
    new AnalyticsClassifier(),
    shape('ai', ['run'], ['prepare'], (value) => {
      return typeof value.models === 'function' || typeof value.gateway === 'function';
    }),
    shape('images', ['input', 'info']),
    shape('workflow', ['create', 'get', 'createBatch']),
    shape('ratelimit', ['limit'], ['get', 'put', 'fetch', 'send', 'run', 'prepare', 'launch']),
    shape('browser', ['launch'], ['fetch', 'run', 'prepare']),
    shape('pipeline', ['send'], ['sendBatch', 'fetch', 'put', 'get']),
    shape('service', ['fetch'], ['put', 'prepare', 'idFromName', 'sendBatch', 'writeDataPoint']),
    new VarClassifier(),
  ];
}
