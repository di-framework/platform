import type { CloudflareBindingKind, WranglerBindingDeclaration } from './types';

interface NamedEntry {
  readonly kind: CloudflareBindingKind;
  readonly names: readonly string[];
}

const ARRAY_SECTIONS: Readonly<Record<string, NamedEntry>> = {
  kv_namespaces: { kind: 'kv', names: ['binding'] },
  d1_databases: { kind: 'd1', names: ['binding'] },
  r2_buckets: { kind: 'r2', names: ['binding'] },
  services: { kind: 'service', names: ['binding'] },
  vectorize: { kind: 'vectorize', names: ['binding'] },
  vectorize_indexes: { kind: 'vectorize', names: ['binding'] },
  analytics_engine_datasets: { kind: 'analytics', names: ['binding'] },
  hyperdrive: { kind: 'hyperdrive', names: ['binding'] },
  ratelimits: { kind: 'ratelimit', names: ['name', 'binding'] },
  workflows: { kind: 'workflow', names: ['binding', 'name'] },
  send_email: { kind: 'email', names: ['name', 'binding'] },
  pipelines: { kind: 'pipeline', names: ['binding'] },
  dispatch_namespaces: { kind: 'dispatch-namespace', names: ['binding'] },
  secrets_store_secrets: { kind: 'secrets-store', names: ['binding'] },
  mtls_certificates: { kind: 'mtls', names: ['binding'] },
};

const OBJECT_SECTIONS: Readonly<Record<string, CloudflareBindingKind>> = {
  ai: 'ai',
  browser: 'browser',
  images: 'images',
  assets: 'assets',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function entryName(entry: unknown, keys: readonly string[]): string | undefined {
  const record = asRecord(entry);
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function addDeclaration(
  declarations: WranglerBindingDeclaration[],
  seen: Set<string>,
  name: string,
  kind: CloudflareBindingKind,
  config: Readonly<Record<string, unknown>>,
): void {
  if (seen.has(name)) return;
  seen.add(name);
  declarations.push({ name, kind, config });
}

/**
 * Reads binding declarations from a parsed wrangler config.
 * JSON strings are accepted. JSONC and invalid JSON yield no declarations.
 * The first declaration for a given name wins.
 */
export function parseWranglerBindings(input?: unknown): readonly WranglerBindingDeclaration[] {
  if (input === undefined || input === null) return [];

  let parsed: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }

  const config = asRecord(parsed);
  if (!config) return [];

  const declarations: WranglerBindingDeclaration[] = [];
  const seen = new Set<string>();

  for (const [section, spec] of Object.entries(ARRAY_SECTIONS)) {
    const entries = config[section];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const name = entryName(entry, spec.names);
      if (!name) continue;
      addDeclaration(declarations, seen, name, spec.kind, {
        ...(asRecord(entry) ?? {}),
      });
    }
  }

  const durableObjects = asRecord(config.durable_objects);
  const durableBindings = durableObjects?.bindings;
  if (Array.isArray(durableBindings)) {
    for (const entry of durableBindings) {
      const name = entryName(entry, ['name', 'binding']);
      if (!name) continue;
      addDeclaration(declarations, seen, name, 'durable-object', {
        ...(asRecord(entry) ?? {}),
      });
    }
  }

  const queues = asRecord(config.queues);
  const producers = queues?.producers;
  if (Array.isArray(producers)) {
    for (const entry of producers) {
      const name = entryName(entry, ['binding', 'name']);
      if (!name) continue;
      addDeclaration(declarations, seen, name, 'queue', {
        ...(asRecord(entry) ?? {}),
      });
    }
  }

  for (const [section, kind] of Object.entries(OBJECT_SECTIONS)) {
    const entry = asRecord(config[section]);
    const name = entryName(entry, ['binding']);
    if (!entry || !name) continue;
    addDeclaration(declarations, seen, name, kind, entry);
  }

  const vars = asRecord(config.vars);
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      if (!name.trim()) continue;
      addDeclaration(declarations, seen, name, 'var', { value });
    }
  }

  return declarations;
}
