/**
 * Core type definitions for Cloud Foundry metadata, VCAP parsing,
 * ServiceInfo models, and connector SPI interfaces.
 */

export interface RawVcapServiceData {
  readonly name: string;
  readonly label: string;
  readonly tags?: readonly string[];
  readonly plan?: string;
  readonly credentials?: Readonly<Record<string, unknown>>;
  readonly volume_mounts?: readonly unknown[];
  readonly syslog_drain_url?: string | null;
  readonly provider?: string | null;
  readonly binding_name?: string | null;
  readonly instance_name?: string | null;
  readonly [key: string]: unknown;
}

export interface CloudFoundryApplicationInfo {
  readonly applicationId: string;
  readonly applicationName: string;
  readonly applicationUris: readonly string[];
  readonly applicationVersion?: string;
  readonly spaceId: string;
  readonly spaceName: string;
  readonly organizationId?: string;
  readonly organizationName?: string;
  readonly instanceId?: string;
  readonly instanceIndex?: number;
  readonly host?: string;
  readonly port?: number;
  readonly limits?: {
    readonly disk?: number;
    readonly fds?: number;
    readonly mem?: number;
  };
  readonly rawConfig: Readonly<Record<string, unknown>>;
}

export interface CloudFoundryServiceInfo {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly plan?: string;
  readonly tags: readonly string[];
  readonly credentials: Readonly<Record<string, unknown>>;
}

export type RelationalDialect = 'postgres' | 'mysql' | 'mariadb' | 'sqlite';

export interface RelationalServiceInfo extends CloudFoundryServiceInfo {
  readonly dialect: RelationalDialect;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username?: string;
  readonly password?: string;
  readonly uri: string;
  readonly jdbcUrl?: string;
  readonly ssl?: boolean;
}

export interface RedisServiceInfo extends CloudFoundryServiceInfo {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly database?: number;
  readonly uri: string;
  readonly tls?: boolean;
  readonly cluster?: boolean;
}

export interface AmqpServiceInfo extends CloudFoundryServiceInfo {
  readonly host: string;
  readonly port: number;
  readonly virtualHost?: string;
  readonly username?: string;
  readonly password?: string;
  readonly uri: string;
  readonly uris: readonly string[];
  readonly ssl?: boolean;
  readonly httpManagementUri?: string;
}

export interface BlobStorageServiceInfo extends CloudFoundryServiceInfo {
  readonly endpoint?: string;
  readonly bucketName: string;
  readonly region?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly uri?: string;
  readonly pathStyle?: boolean;
}

export interface UserProvidedServiceInfo extends CloudFoundryServiceInfo {
  readonly uri?: string;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly password?: string;
}

export type ServicePredicate = (service: CloudFoundryServiceInfo) => boolean;

export interface ServiceFilter {
  readonly name?: string | RegExp;
  readonly label?: string | RegExp;
  readonly tag?: string | RegExp;
  readonly dialect?: RelationalDialect;
  readonly predicate?: ServicePredicate;
}

export interface CloudFoundryServiceOptions {
  /**
   * Environment variable key(s) to inspect for fallback when service is not bound in Cloud Foundry.
   */
  readonly fallbackEnv?: string | readonly string[];
  /**
   * If true, throws an error if the service cannot be resolved. Defaults to true.
   */
  readonly required?: boolean;
  /**
   * Default value to inject if the service is not found and required is false.
   */
  readonly defaultValue?: unknown;
  /**
   * Target container for resolution or binding.
   */
  readonly container?: unknown;
}

export interface LocalFallbackOptions {
  /** Environment variable keys for relational database fallback (e.g. ['DATABASE_URL', 'POSTGRES_URL']) */
  readonly relationalUriEnv?: readonly string[];
  /** Environment variable keys for Redis fallback (e.g. ['REDIS_URL', 'REDIS_TLS_URL']) */
  readonly redisUriEnv?: readonly string[];
  /** Environment variable keys for AMQP / RabbitMQ fallback (e.g. ['AMQP_URL', 'RABBITMQ_URL', 'CLOUDAMQP_URL']) */
  readonly amqpUriEnv?: readonly string[];
  /** S3 / Blob storage fallback credentials */
  readonly blobStorageEnv?: {
    readonly bucket?: string;
    readonly endpoint?: string;
    readonly region?: string;
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
  };
  /** Explicit fallback service infos keyed by service name */
  readonly services?: Record<string, Partial<CloudFoundryServiceInfo>>;
}

export interface EnableCloudFoundryConnectorsOptions {
  /** Custom environment dictionary (defaults to process.env) */
  readonly env?: Record<string, string | undefined>;
  /** Enable local fallback resolution when not in Cloud Foundry */
  readonly localFallback?: boolean | LocalFallbackOptions;
  /** Custom DI container to bind discovered services into */
  readonly container?: unknown;
}
