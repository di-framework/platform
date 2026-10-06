import { defineMetadata, getOwnMetadata, useContainer } from '@di-framework/core/container';
import {
  bindCloudflareBindings,
  cloudflareBindingToken,
  lookupCloudflareBinding,
  registerCloudflareBinding,
} from './bindings';
import type { CloudflareBindingOptions, EnableCloudflareBindingsOptions } from './types';

const INJECT_METADATA_KEY = 'di:inject';

/**
 * Injects one Cloudflare binding by its wrangler name.
 * The lookup runs when the property is read or the constructor argument is
 * resolved, so `setCloudflareBindings(env)` can happen in the Worker handler.
 *
 * @example Property injection
 * class Orders {
 *   @CloudflareBinding('ORDERS')
 *   db!: D1BindingInfo;
 * }
 */
export function CloudflareBinding(name: string, options: CloudflareBindingOptions = {}) {
  registerCloudflareBinding(name, options, options.container);
  return (
    // biome-ignore lint/suspicious/noExplicitAny: decorator target
    targetClass: any,
    propertyKey?: string | symbol,
    parameterIndex?: number,
  ) => {
    const token = cloudflareBindingToken(name);

    if (propertyKey !== undefined && parameterIndex === undefined) {
      const metadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass) || {};
      metadata[propertyKey as string] = token;
      defineMetadata(INJECT_METADATA_KEY, metadata, targetClass);

      if (targetClass.constructor && targetClass.constructor !== Object) {
        const ctorMetadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass.constructor) || {};
        ctorMetadata[propertyKey as string] = token;
        defineMetadata(INJECT_METADATA_KEY, ctorMetadata, targetClass.constructor);
      }

      const cache = new WeakMap<object, { present: boolean; value: unknown }>();
      Object.defineProperty(targetClass, propertyKey, {
        configurable: true,
        enumerable: true,
        get(this: object) {
          const cached = cache.get(this);
          if (cached?.present) return cached.value;

          const container =
            (options.container as { resolve?: (token: string) => unknown } | undefined) ??
            useContainer();
          if (container && typeof container.resolve === 'function') {
            try {
              const resolved = container.resolve(token);
              if (resolved !== undefined && resolved !== null) {
                cache.set(this, { present: true, value: resolved });
                return resolved;
              }
            } catch {
              // The container may not have the token yet, or the binding is still absent.
            }
          }

          const value = lookupCloudflareBinding(name, options);
          if (value !== undefined) {
            cache.set(this, { present: true, value });
          }
          return value;
        },
        set(this: object, value: unknown) {
          cache.set(this, { present: true, value });
        },
      });
    } else if (parameterIndex !== undefined) {
      const metadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass) || {};
      metadata[`param_${parameterIndex}`] = token;
      defineMetadata(INJECT_METADATA_KEY, metadata, targetClass);
    }
  };
}

/**
 * Registers lazy Cloudflare binding factories on the DI container.
 * Bindings passed here are also published via `setCloudflareBindings`.
 */
export function EnableCloudflareBindings(options: EnableCloudflareBindingsOptions = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: class constructor
  return <T extends new (...args: any[]) => any>(ctor: T): T => {
    bindCloudflareBindings(options.container, options);
    return ctor;
  };
}
