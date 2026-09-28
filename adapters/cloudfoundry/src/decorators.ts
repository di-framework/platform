import { defineMetadata, getOwnMetadata, useContainer } from '@di-framework/core/container';
import { bindCloudFoundryConnectors, CF_APPLICATION_TOKEN } from './bindings';
import { getDefaultEnvironment } from './environment';
import type {
  CloudFoundryApplicationInfo,
  CloudFoundryServiceInfo,
  CloudFoundryServiceOptions,
  EnableCloudFoundryConnectorsOptions,
  ServiceFilter,
} from './types';

const INJECT_METADATA_KEY = 'di:inject';

/**
 * Parameter or Property decorator that injects a bound Cloud Foundry service.
 *
 * @param serviceNameOrFilter Name, label, pattern, or filter object for the service.
 * @param options Fallback environment keys, required flag, or default value.
 *
 * @example Property injection
 * @Container()
 * class DatabaseRepository {
 *   @CloudFoundryService('my-postgres')
 *   private dbService!: RelationalServiceInfo;
 * }
 *
 * @example Constructor injection
 * @Container()
 * class CacheClient {
 *   constructor(
 *     @CloudFoundryService('my-redis') private redis: RedisServiceInfo
 *   ) {}
 * }
 */
export function CloudFoundryService(
  serviceNameOrFilter?: string | RegExp | ServiceFilter,
  options: CloudFoundryServiceOptions = {},
) {
  return (
    // biome-ignore lint/suspicious/noExplicitAny: decorator target
    targetClass: any,
    propertyKey?: string | symbol,
    parameterIndex?: number,
  ) => {
    const token = deriveServiceToken(serviceNameOrFilter);

    // Property injection
    if (propertyKey !== undefined && parameterIndex === undefined) {
      const metadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass) || {};
      metadata[propertyKey as string] = token;
      defineMetadata(INJECT_METADATA_KEY, metadata, targetClass);

      if (targetClass.constructor && targetClass.constructor !== Object) {
        const ctorMetadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass.constructor) || {};
        ctorMetadata[propertyKey as string] = token;
        defineMetadata(INJECT_METADATA_KEY, ctorMetadata, targetClass.constructor);
      }

      // Define property getter fallback in case accessed without DI resolution
      let cachedValue: unknown;
      Object.defineProperty(targetClass, propertyKey, {
        configurable: true,
        enumerable: true,
        get() {
          if (cachedValue !== undefined) return cachedValue;

          // Attempt container resolution first
          const container =
            (options.container as { resolve?: (t: string) => unknown }) ?? useContainer();
          if (container && typeof container.resolve === 'function') {
            try {
              const res = container.resolve(token);
              if (res !== undefined && res !== null) {
                cachedValue = res;
                return cachedValue;
              }
            } catch {
              // fall through to environment lookup
            }
          }

          // Fallback to CloudFoundryEnvironment lookup
          const env = getDefaultEnvironment();
          let service: CloudFoundryServiceInfo | null = null;
          if (typeof serviceNameOrFilter === 'string') {
            service = env.getServiceInfo(serviceNameOrFilter);
          } else if (serviceNameOrFilter) {
            service = env.getServiceInfo(serviceNameOrFilter);
          } else {
            const all = env.getServiceInfos();
            service = all[0] ?? null;
          }

          if (service) {
            cachedValue = service;
            return cachedValue;
          }

          if (options.fallbackEnv) {
            const keys = Array.isArray(options.fallbackEnv)
              ? options.fallbackEnv
              : [options.fallbackEnv];
            for (const key of keys) {
              const val = process.env[key];
              if (val) {
                cachedValue = {
                  uri: val,
                  name: key,
                  label: 'fallback',
                  tags: [],
                  credentials: { uri: val },
                };
                return cachedValue;
              }
            }
          }

          if (options.defaultValue !== undefined) {
            return options.defaultValue;
          }

          if (options.required !== false) {
            throw new Error(
              `Cloud Foundry service '${String(serviceNameOrFilter ?? 'default')}' not found and no fallback available`,
            );
          }

          return undefined;
        },
        set(value: unknown) {
          cachedValue = value;
        },
      });
    }
    // Constructor parameter injection
    else if (parameterIndex !== undefined) {
      const metadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass) || {};
      metadata[`param_${parameterIndex}`] = token;
      defineMetadata(INJECT_METADATA_KEY, metadata, targetClass);
    }
  };
}

/**
 * Injects Cloud Foundry application metadata (VCAP_APPLICATION).
 */
export function VcapApplication(options: { required?: boolean; container?: unknown } = {}) {
  return (
    // biome-ignore lint/suspicious/noExplicitAny: decorator target
    targetClass: any,
    propertyKey?: string | symbol,
    parameterIndex?: number,
  ) => {
    const token = CF_APPLICATION_TOKEN;

    if (propertyKey !== undefined && parameterIndex === undefined) {
      const metadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass) || {};
      metadata[propertyKey as string] = token;
      defineMetadata(INJECT_METADATA_KEY, metadata, targetClass);

      if (targetClass.constructor && targetClass.constructor !== Object) {
        const ctorMetadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass.constructor) || {};
        ctorMetadata[propertyKey as string] = token;
        defineMetadata(INJECT_METADATA_KEY, ctorMetadata, targetClass.constructor);
      }

      let cachedAppInfo: CloudFoundryApplicationInfo | null | undefined;
      Object.defineProperty(targetClass, propertyKey, {
        configurable: true,
        enumerable: true,
        get() {
          if (cachedAppInfo !== undefined) return cachedAppInfo;

          const container =
            (options.container as { resolve?: (t: string) => unknown }) ?? useContainer();
          if (container && typeof container.resolve === 'function') {
            try {
              const res = container.resolve(token);
              if (res !== undefined && res !== null) {
                cachedAppInfo = res as CloudFoundryApplicationInfo;
                return cachedAppInfo;
              }
            } catch {
              // fallback
            }
          }

          const info = getDefaultEnvironment().getApplicationInfo();
          if (!info && options.required === true) {
            throw new Error(
              'Cloud Foundry application info (VCAP_APPLICATION) is required but not present',
            );
          }
          cachedAppInfo = info;
          return cachedAppInfo;
        },
        set(value: CloudFoundryApplicationInfo | null) {
          cachedAppInfo = value;
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
 * Class decorator that enables Cloud Foundry connector auto-configuration on the DI container.
 */
export function EnableCloudFoundryConnectors(options: EnableCloudFoundryConnectorsOptions = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: class constructor
  return <T extends new (...args: any[]) => any>(ctor: T): T => {
    bindCloudFoundryConnectors(options.container, options);
    return ctor;
  };
}

function deriveServiceToken(serviceNameOrFilter?: string | RegExp | ServiceFilter): string {
  if (typeof serviceNameOrFilter === 'string') {
    return `cf:service:${serviceNameOrFilter}`;
  }
  if (
    serviceNameOrFilter &&
    typeof serviceNameOrFilter === 'object' &&
    'name' in serviceNameOrFilter &&
    typeof serviceNameOrFilter.name === 'string'
  ) {
    return `cf:service:${serviceNameOrFilter.name}`;
  }
  if (
    serviceNameOrFilter &&
    typeof serviceNameOrFilter === 'object' &&
    'label' in serviceNameOrFilter &&
    typeof serviceNameOrFilter.label === 'string'
  ) {
    return `cf:service:${serviceNameOrFilter.label}`;
  }
  return 'cf:service:default';
}
