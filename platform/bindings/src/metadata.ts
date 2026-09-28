import { defineMetadata, getOwnMetadata } from '@di-framework/core/container';

export const WASMCLOUD_BINDING_KEY = 'di:wasmcloud-binding';

export type WasmCloudBindingOptions = {
  /** Same-namespace managed PostgreSQL BackingService. */
  serviceName?: string;
  interfaces?: string[];
  secretFrom?: string;
  configFrom?: string;
  config?: Record<string, string>;
};

export type WasmCloudBindingMetadata = {
  name: string;
  options: WasmCloudBindingOptions;
};

const SECRET_CONFIG_KEYS = new Set([
  'password',
  'secret',
  'token',
  'uri',
  'url',
  'connectionstring',
  'connection-string',
]);

export function isWitIdentifier(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

export function rejectsPlaintextSecret(
  config: Record<string, string> | undefined,
): string | undefined {
  if (config === undefined) return undefined;
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_CONFIG_KEYS.has(key.toLowerCase())) {
      return `config key "${key}" must not carry a secret value; use secretFrom`;
    }
    if (/:\/\//.test(value) || /password=/i.test(value)) {
      return `config value for "${key}" looks like a secret or connection string; use secretFrom`;
    }
  }
  return undefined;
}

export function defineBindingMetadata(target: object, metadata: WasmCloudBindingMetadata): void {
  defineMetadata(WASMCLOUD_BINDING_KEY, metadata, target);
}

export function getBindingMetadata(target: object): WasmCloudBindingMetadata | undefined {
  return getOwnMetadata(WASMCLOUD_BINDING_KEY, target) as WasmCloudBindingMetadata | undefined;
}
