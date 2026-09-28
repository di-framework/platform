# @di-framework/cloudfoundry

Cloud Foundry connector for `@di-framework` — automatic `VCAP_SERVICES` and `VCAP_APPLICATION` discovery, strongly typed ServiceInfo models, SPI creator extensible registry, and automated DI bindings.

Inspired by Spring Cloud Connectors (`spring-cloud-cloudfoundry-connector`), this package streamlines running `@di-framework` applications on Cloud Foundry and Tanzu Application Service.

## Features

- **Automatic Environment Detection**: Fast detection via `CloudFoundryDetector` and `isCloudFoundry()`.
- **Application Info Parsing**: Strongly typed `CloudFoundryApplicationInfo` containing application names, URIs, instance index, space, limits, etc.
- **Service Info Creators (SPI)**: Extensible discovery and normalized models for:
  - **Relational Databases**: PostgreSQL, MySQL, MariaDB, SQLite (`RelationalServiceInfo`)
  - **Redis / Cache**: Redis standalone, TLS, cluster (`RedisServiceInfo`)
  - **AMQP / Message Brokers**: RabbitMQ, CloudAMQP (`AmqpServiceInfo`)
  - **Blob Storage / S3**: MinIO, AWS S3, Object Store (`BlobStorageServiceInfo`)
  - **User-Provided Services**: `cf cups` custom services (`UserProvidedServiceInfo`)
- **DI & Decorator Integration**:
  - `@CloudFoundryService('service-name')` for parameter and property injection
  - `@VcapApplication()` for application metadata injection
  - `@EnableCloudFoundryConnectors()` for container-wide auto-wiring
- **Local Fallback**: Automatically falls back to standard local environment variables (`DATABASE_URL`, `REDIS_URL`, `AMQP_URL`, `S3_BUCKET`) when running outside Cloud Foundry.

## Installation

```bash
bun add @di-framework/cloudfoundry
```

## Quick Start

### 1. Using `@EnableCloudFoundryConnectors` and `@CloudFoundryService`

```typescript
import { Container } from '@di-framework/core/decorators';
import {
  CloudFoundryService,
  EnableCloudFoundryConnectors,
  RelationalServiceInfo,
  RedisServiceInfo,
  VcapApplication,
  CloudFoundryApplicationInfo,
} from '@di-framework/cloudfoundry';

@EnableCloudFoundryConnectors()
@Container()
export class ApplicationService {
  @VcapApplication()
  private appInfo!: CloudFoundryApplicationInfo;

  @CloudFoundryService('my-postgres-db')
  private dbService!: RelationalServiceInfo;

  @CloudFoundryService('my-redis-cache')
  private redisService!: RedisServiceInfo;

  start() {
    console.log(`Running app ${this.appInfo?.applicationName}`);
    console.log(`Database URI: ${this.dbService.uri}`);
    console.log(`Redis host: ${this.redisService.host}:${this.redisService.port}`);
  }
}
```

### 2. Programmatic Discovery via `CloudFoundryEnvironment`

```typescript
import { CloudFoundryEnvironment } from '@di-framework/cloudfoundry';

const cfEnv = new CloudFoundryEnvironment();

if (cfEnv.isCloudFoundry()) {
  const appInfo = cfEnv.getApplicationInfo();
  console.log(`Space: ${appInfo?.spaceName}, Instance: ${appInfo?.instanceIndex}`);

  // Retrieve primary relational database
  const db = cfEnv.getRelationalServiceInfo();
  if (db) {
    console.log(`Connected to ${db.dialect} at ${db.host}:${db.port}/${db.database}`);
  }

  // Retrieve Redis service
  const redis = cfEnv.getRedisServiceInfo();
  if (redis) {
    console.log(`Redis URI: ${redis.uri}`);
  }
}
```

### 3. Custom Service Creators (SPI)

You can register custom service info creators with `ServiceInfoCreatorRegistry`:

```typescript
import {
  CloudFoundryServiceInfoCreator,
  getDefaultRegistry,
  RawVcapServiceData,
  CloudFoundryServiceInfo,
} from '@di-framework/cloudfoundry';

export interface ElasticsearchServiceInfo extends CloudFoundryServiceInfo {
  readonly uri: string;
}

export class ElasticsearchServiceInfoCreator implements CloudFoundryServiceInfoCreator<ElasticsearchServiceInfo> {
  accept(data: RawVcapServiceData): boolean {
    return data.label.includes('elasticsearch') || (data.tags || []).includes('elasticsearch');
  }

  createServiceInfo(data: RawVcapServiceData): ElasticsearchServiceInfo {
    const creds = data.credentials || {};
    return {
      id: data.name,
      name: data.name,
      label: data.label,
      tags: [...(data.tags || [])],
      credentials: creds,
      uri: String(creds.uri ?? 'http://localhost:9200'),
    };
  }
}

getDefaultRegistry().registerCreator(new ElasticsearchServiceInfoCreator());
```

## License

Licensed under either [MIT](../../LICENSE-MIT) or [Apache-2.0](../../LICENSE-APACHE), at your option.
