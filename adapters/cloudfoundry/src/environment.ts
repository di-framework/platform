import { parseVcapApplication } from './application-info';
import { CloudFoundryDetector } from './detector';
import {
  getDefaultRegistry,
  parseVcapServices,
  type ServiceInfoCreatorRegistry,
} from './spi/registry';
import type {
  AmqpServiceInfo,
  BlobStorageServiceInfo,
  CloudFoundryApplicationInfo,
  CloudFoundryServiceInfo,
  LocalFallbackOptions,
  RedisServiceInfo,
  RelationalServiceInfo,
  ServiceFilter,
  UserProvidedServiceInfo,
} from './types';

export interface CloudFoundryEnvironmentOptions {
  /** Custom environment dictionary (defaults to process.env) */
  env?: Record<string, string | undefined>;
  /** Custom service info creator registry */
  registry?: ServiceInfoCreatorRegistry;
  /** Options or boolean for local fallback */
  localFallback?: boolean | LocalFallbackOptions;
}

export class CloudFoundryEnvironment {
  private readonly env: Record<string, string | undefined>;
  private readonly registry: ServiceInfoCreatorRegistry;
  private readonly localFallbackOptions: LocalFallbackOptions | null;

  private appInfo: CloudFoundryApplicationInfo | null | undefined;
  private services: readonly CloudFoundryServiceInfo[] | undefined;

  constructor(options: CloudFoundryEnvironmentOptions = {}) {
    this.env = options.env ?? process.env;
    this.registry = options.registry ?? getDefaultRegistry();

    if (options.localFallback === false) {
      this.localFallbackOptions = null;
    } else if (typeof options.localFallback === 'object') {
      this.localFallbackOptions = options.localFallback;
    } else {
      // Default enabled
      this.localFallbackOptions = {};
    }
  }

  /**
   * Returns true if running within a Cloud Foundry runtime.
   */
  isCloudFoundry(): boolean {
    return CloudFoundryDetector.isCloudFoundry(this.env);
  }

  /**
   * Returns parsed CloudFoundryApplicationInfo or null if not running in CF.
   */
  getApplicationInfo(): CloudFoundryApplicationInfo | null {
    if (this.appInfo === undefined) {
      this.appInfo = parseVcapApplication(this.env);
    }
    return this.appInfo;
  }

  /**
   * Retrieves all discovered Cloud Foundry services, applying optional filtering.
   */
  getServiceInfos<T extends CloudFoundryServiceInfo = CloudFoundryServiceInfo>(
    filter?: ServiceFilter | string | RegExp,
  ): readonly T[] {
    this.ensureServicesLoaded();
    const all = (this.services ?? []) as T[];

    if (!filter) {
      return all;
    }

    if (typeof filter === 'string') {
      return all.filter((s) => s.name === filter || s.label === filter || s.tags.includes(filter));
    }

    if (filter instanceof RegExp) {
      return all.filter((s) => filter.test(s.name) || filter.test(s.label));
    }

    return all.filter((service) => {
      if (filter.name) {
        if (typeof filter.name === 'string' && service.name !== filter.name) return false;
        if (filter.name instanceof RegExp && !filter.name.test(service.name)) return false;
      }
      if (filter.label) {
        if (typeof filter.label === 'string' && service.label !== filter.label) return false;
        if (filter.label instanceof RegExp && !filter.label.test(service.label)) return false;
      }
      if (filter.tag) {
        if (typeof filter.tag === 'string' && !service.tags.includes(filter.tag)) return false;
        if (
          filter.tag instanceof RegExp &&
          !service.tags.some((t) => (filter.tag as RegExp).test(t))
        )
          return false;
      }
      if (filter.dialect) {
        if (
          !('dialect' in service) ||
          (service as unknown as RelationalServiceInfo).dialect !== filter.dialect
        ) {
          return false;
        }
      }
      if (filter.predicate && !filter.predicate(service)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Retrieves a single service by name, filter, or returns the first matching service.
   */
  getServiceInfo<T extends CloudFoundryServiceInfo = CloudFoundryServiceInfo>(
    serviceNameOrFilter?: string | RegExp | ServiceFilter,
  ): T | null {
    const list = this.getServiceInfos<T>(serviceNameOrFilter);
    return list[0] ?? null;
  }

  /**
   * Retrieves relational database service info (PostgreSQL, MySQL, MariaDB, SQLite).
   */
  getRelationalServiceInfo(filter?: string | RegExp | ServiceFilter): RelationalServiceInfo | null {
    if (typeof filter === 'string' || filter instanceof RegExp) {
      const found = this.getServiceInfo<RelationalServiceInfo>(filter);
      if (found && 'dialect' in found) return found;
    } else if (filter) {
      const found = this.getServiceInfo<RelationalServiceInfo>(filter);
      if (found && 'dialect' in found) return found;
    }

    // Find any relational service
    const all = this.getServiceInfos<RelationalServiceInfo>();
    return all.find((s) => 'dialect' in s) ?? null;
  }

  /**
   * Retrieves Redis service info.
   */
  getRedisServiceInfo(filter?: string | RegExp | ServiceFilter): RedisServiceInfo | null {
    if (typeof filter === 'string' || filter instanceof RegExp) {
      const found = this.getServiceInfo<RedisServiceInfo>(filter);
      if (found && isRedisInfo(found)) return found;
    } else if (filter) {
      const found = this.getServiceInfo<RedisServiceInfo>(filter);
      if (found && isRedisInfo(found)) return found;
    }

    const all = this.getServiceInfos<RedisServiceInfo>();
    return all.find((s) => isRedisInfo(s)) ?? null;
  }

  /**
   * Retrieves AMQP / RabbitMQ service info.
   */
  getAmqpServiceInfo(filter?: string | RegExp | ServiceFilter): AmqpServiceInfo | null {
    if (typeof filter === 'string' || filter instanceof RegExp) {
      const found = this.getServiceInfo<AmqpServiceInfo>(filter);
      if (found && isAmqpInfo(found)) return found;
    } else if (filter) {
      const found = this.getServiceInfo<AmqpServiceInfo>(filter);
      if (found && isAmqpInfo(found)) return found;
    }

    const all = this.getServiceInfos<AmqpServiceInfo>();
    return all.find((s) => isAmqpInfo(s)) ?? null;
  }

  /**
   * Retrieves Blob Storage / S3 service info.
   */
  getBlobStorageServiceInfo(
    filter?: string | RegExp | ServiceFilter,
  ): BlobStorageServiceInfo | null {
    if (typeof filter === 'string' || filter instanceof RegExp) {
      const found = this.getServiceInfo<BlobStorageServiceInfo>(filter);
      if (found && isBlobStorageInfo(found)) return found;
    } else if (filter) {
      const found = this.getServiceInfo<BlobStorageServiceInfo>(filter);
      if (found && isBlobStorageInfo(found)) return found;
    }

    const all = this.getServiceInfos<BlobStorageServiceInfo>();
    return all.find((s) => isBlobStorageInfo(s)) ?? null;
  }

  /**
   * Retrieves User-Provided service info.
   */
  getUserProvidedServiceInfo(
    filter?: string | RegExp | ServiceFilter,
  ): UserProvidedServiceInfo | null {
    if (typeof filter === 'string' || filter instanceof RegExp) {
      return this.getServiceInfo<UserProvidedServiceInfo>(filter);
    }
    const all = this.getServiceInfos<UserProvidedServiceInfo>({
      label: 'user-provided',
      ...(filter || {}),
    });
    return all[0] ?? null;
  }

  /**
   * Retrieves raw credentials map for a service.
   */
  getServiceCredentials<T = Record<string, unknown>>(serviceName: string): T | null {
    const service = this.getServiceInfo(serviceName);
    return service ? (service.credentials as unknown as T) : null;
  }

  private ensureServicesLoaded(): void {
    if (this.services !== undefined) return;

    let discovered = parseVcapServices(this.env, this.registry);

    if (discovered.length === 0 && this.localFallbackOptions) {
      discovered = this.buildLocalFallbackServices(this.localFallbackOptions);
    }

    this.services = discovered;
  }

  private buildLocalFallbackServices(
    options: LocalFallbackOptions,
  ): readonly CloudFoundryServiceInfo[] {
    const list: CloudFoundryServiceInfo[] = [];

    // 1. Explicit local fallback services
    if (options.services) {
      for (const [name, partial] of Object.entries(options.services)) {
        list.push({
          id: partial.id ?? name,
          name: partial.name ?? name,
          label: partial.label ?? 'local-fallback',
          tags: partial.tags ?? ['local'],
          credentials: Object.freeze({ ...(partial.credentials || {}) }),
          ...partial,
        } as CloudFoundryServiceInfo);
      }
    }

    // 2. Relational fallback from environment variables
    const relationalKeys = options.relationalUriEnv ?? [
      'DATABASE_URL',
      'POSTGRES_URL',
      'POSTGRESQL_URL',
      'MYSQL_URL',
      'MARIADB_URL',
      'SQLITE_URL',
    ];
    for (const key of relationalKeys) {
      const uriVal = this.env[key];
      if (uriVal && uriVal.trim().length > 0) {
        const rawEntry = {
          name: 'local-db',
          label: 'relational',
          tags: ['local', 'relational'],
          credentials: { uri: uriVal.trim() },
        };
        list.push(this.registry.createServiceInfo(rawEntry));
        break;
      }
    }

    // 3. Redis fallback
    const redisKeys = options.redisUriEnv ?? ['REDIS_URL', 'REDIS_TLS_URL', 'REDISCLOUD_URL'];
    for (const key of redisKeys) {
      const uriVal = this.env[key];
      if (uriVal && uriVal.trim().length > 0) {
        const rawEntry = {
          name: 'local-redis',
          label: 'redis',
          tags: ['local', 'redis', 'cache'],
          credentials: { uri: uriVal.trim() },
        };
        list.push(this.registry.createServiceInfo(rawEntry));
        break;
      }
    }

    // 4. AMQP fallback
    const amqpKeys = options.amqpUriEnv ?? [
      'AMQP_URL',
      'RABBITMQ_URL',
      'CLOUDAMQP_URL',
      'RABBITMQ_BIGWIG_URL',
    ];
    for (const key of amqpKeys) {
      const uriVal = this.env[key];
      if (uriVal && uriVal.trim().length > 0) {
        const rawEntry = {
          name: 'local-amqp',
          label: 'rabbitmq',
          tags: ['local', 'amqp', 'rabbitmq'],
          credentials: { uri: uriVal.trim() },
        };
        list.push(this.registry.createServiceInfo(rawEntry));
        break;
      }
    }

    // 5. Blob storage fallback
    const blobBucket =
      options.blobStorageEnv?.bucket ??
      this.env.S3_BUCKET ??
      this.env.AWS_S3_BUCKET ??
      this.env.BLOB_STORAGE_BUCKET;
    if (blobBucket) {
      const rawEntry = {
        name: 'local-blob-storage',
        label: 's3',
        tags: ['local', 's3', 'blob'],
        credentials: {
          bucket: blobBucket,
          endpoint:
            options.blobStorageEnv?.endpoint ??
            this.env.S3_ENDPOINT ??
            this.env.AWS_ENDPOINT_URL_S3 ??
            this.env.AWS_ENDPOINT_URL,
          region:
            options.blobStorageEnv?.region ??
            this.env.AWS_REGION ??
            this.env.AWS_DEFAULT_REGION ??
            'us-east-1',
          accessKeyId:
            options.blobStorageEnv?.accessKeyId ??
            this.env.AWS_ACCESS_KEY_ID ??
            this.env.S3_ACCESS_KEY,
          secretAccessKey:
            options.blobStorageEnv?.secretAccessKey ??
            this.env.AWS_SECRET_ACCESS_KEY ??
            this.env.S3_SECRET_KEY,
        },
      };
      list.push(this.registry.createServiceInfo(rawEntry));
    }

    return list;
  }
}

function isRedisInfo(s: CloudFoundryServiceInfo): boolean {
  return (
    'host' in s &&
    'port' in s &&
    (s.label.toLowerCase().includes('redis') ||
      s.tags.includes('redis') ||
      s.tags.includes('cache'))
  );
}

function isAmqpInfo(s: CloudFoundryServiceInfo): boolean {
  return (
    'uris' in s ||
    s.label.toLowerCase().includes('rabbitmq') ||
    s.label.toLowerCase().includes('amqp') ||
    s.tags.includes('rabbitmq') ||
    s.tags.includes('amqp')
  );
}

function isBlobStorageInfo(s: CloudFoundryServiceInfo): boolean {
  return (
    'bucketName' in s ||
    s.label.toLowerCase().includes('s3') ||
    s.tags.includes('s3') ||
    s.tags.includes('blob') ||
    s.tags.includes('blobstore')
  );
}

let defaultEnvironment: CloudFoundryEnvironment | null = null;

export function getDefaultEnvironment(): CloudFoundryEnvironment {
  if (!defaultEnvironment) {
    defaultEnvironment = new CloudFoundryEnvironment();
  }
  return defaultEnvironment;
}

export function resetDefaultEnvironment(): void {
  defaultEnvironment = null;
}
