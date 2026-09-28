import { describe, expect, it } from 'bun:test';
import { Container as CoreContainer } from '@di-framework/core/container';
import { Container } from '@di-framework/core/decorators';
import {
  bindCloudFoundryConnectors,
  CF_AMQP_TOKEN,
  CF_APPLICATION_TOKEN,
  CF_BLOB_TOKEN,
  CF_ENVIRONMENT_TOKEN,
  CF_REDIS_TOKEN,
  CF_RELATIONAL_TOKEN,
} from '../src/bindings.ts';
import {
  CloudFoundryService,
  EnableCloudFoundryConnectors,
  VcapApplication,
} from '../src/decorators.ts';
import { CloudFoundryEnvironment, resetDefaultEnvironment } from '../src/environment.ts';
import type {
  CloudFoundryApplicationInfo,
  RedisServiceInfo,
  RelationalServiceInfo,
} from '../src/types.ts';

describe('bindCloudFoundryConnectors & Decorators', () => {
  it('should bind services and application info to a DI container', () => {
    const testContainer = new CoreContainer();
    const envData = {
      VCAP_APPLICATION: JSON.stringify({
        application_name: 'orders-app',
        space_name: 'prod',
      }),
      VCAP_SERVICES: JSON.stringify({
        'p-mysql': [
          {
            name: 'orders-mysql',
            label: 'p-mysql',
            tags: ['mysql'],
            credentials: { uri: 'mysql://root:pass@localhost:3306/orders' },
          },
        ],
        'p-redis': [
          {
            name: 'cache-redis',
            label: 'p-redis',
            tags: ['redis'],
            credentials: { uri: 'redis://localhost:6379' },
          },
        ],
        'p-rabbitmq': [
          {
            name: 'queue-amqp',
            label: 'p-rabbitmq',
            tags: ['rabbitmq'],
            credentials: { uri: 'amqp://guest:guest@localhost:5672' },
          },
        ],
        minio: [
          {
            name: 'media-blob',
            label: 'minio',
            tags: ['s3'],
            credentials: { bucket: 'media', access_key: 'a', secret_key: 's' },
          },
        ],
      }),
    };

    const env = bindCloudFoundryConnectors(testContainer, { env: envData });
    expect(env).toBeInstanceOf(CloudFoundryEnvironment);

    // Verify tokens in container
    expect(testContainer.resolve<CloudFoundryEnvironment>(CF_ENVIRONMENT_TOKEN)).toBe(env);
    expect(testContainer.resolve<CloudFoundryEnvironment>(CloudFoundryEnvironment)).toBe(env);
    expect(
      (testContainer.resolve(CF_APPLICATION_TOKEN) as CloudFoundryApplicationInfo).applicationName,
    ).toBe('orders-app');
    expect((testContainer.resolve(CF_RELATIONAL_TOKEN) as RelationalServiceInfo).dialect).toBe(
      'mysql',
    );
    expect((testContainer.resolve('cf:service:orders-mysql') as RelationalServiceInfo).name).toBe(
      'orders-mysql',
    );
    expect((testContainer.resolve(CF_REDIS_TOKEN) as RedisServiceInfo).host).toBe('localhost');
    expect(testContainer.resolve(CF_AMQP_TOKEN)).toBeDefined();
    expect(testContainer.resolve(CF_BLOB_TOKEN)).toBeDefined();
  });

  it('should support property injection and lazy getters via decorators', () => {
    const testContainer = new CoreContainer();
    const envData = {
      VCAP_APPLICATION: JSON.stringify({
        application_name: 'decorated-app',
        space_name: 'staging',
      }),
      VCAP_SERVICES: JSON.stringify({
        elephantsql: [
          {
            name: 'pg-db',
            label: 'elephantsql',
            tags: ['postgres'],
            credentials: { uri: 'postgres://u:p@localhost:5432/test' },
          },
        ],
      }),
    };

    bindCloudFoundryConnectors(testContainer, { env: envData });

    class ServiceClass {
      @VcapApplication({ container: testContainer })
      appInfo!: CloudFoundryApplicationInfo;

      @CloudFoundryService('pg-db', { container: testContainer })
      dbService!: RelationalServiceInfo;

      @CloudFoundryService('missing-service', {
        required: false,
        defaultValue: { name: 'default' },
        container: testContainer,
      })
      optionalService!: any;
    }

    const instance = new ServiceClass();
    expect(instance.appInfo.applicationName).toBe('decorated-app');
    expect(instance.dbService.name).toBe('pg-db');
    expect(instance.dbService.dialect).toBe('postgres');
    expect(instance.optionalService.name).toBe('default');

    // Test setter override
    instance.dbService = { name: 'custom' } as any;
    expect(instance.dbService.name).toBe('custom');
  });

  it('should support fallbackEnv in @CloudFoundryService', () => {
    process.env.FALLBACK_DB_URL = 'postgres://fallback@localhost:5432/fallbackdb';
    try {
      class FallbackClass {
        @CloudFoundryService('non-existent', {
          fallbackEnv: 'FALLBACK_DB_URL',
          container: new CoreContainer(),
        })
        db!: any;
      }

      const instance = new FallbackClass();
      expect(instance.db.uri).toBe('postgres://fallback@localhost:5432/fallbackdb');
    } finally {
      delete process.env.FALLBACK_DB_URL;
    }
  });

  it('should throw when required service or app info is missing', () => {
    class StrictClass {
      @CloudFoundryService('missing-db', { container: new CoreContainer() })
      db!: any;
    }

    class StrictAppClass {
      @VcapApplication({ required: true, container: new CoreContainer() })
      app!: any;
    }

    const inst1 = new StrictClass();
    expect(() => inst1.db).toThrow(/not found/);

    const inst2 = new StrictAppClass();
    expect(() => inst2.app).toThrow(/VCAP_APPLICATION/);
  });

  it('should support @EnableCloudFoundryConnectors class decorator and constructor injection', () => {
    const testContainer = new CoreContainer();

    @EnableCloudFoundryConnectors({
      container: testContainer,
      env: {
        VCAP_SERVICES: JSON.stringify({
          'p-redis': [
            {
              name: 'redis-svc',
              label: 'p-redis',
              tags: ['redis'],
              credentials: { uri: 'redis://127.0.0.1:6379' },
            },
          ],
        }),
      },
    })
    @Container({ container: testContainer })
    class DecoratedContainerClass {
      constructor(
        @CloudFoundryService('redis-svc') public redis: RedisServiceInfo,
        @VcapApplication() public app: CloudFoundryApplicationInfo,
      ) {}
    }

    const resolved = testContainer.resolve(DecoratedContainerClass);
    expect(resolved).toBeDefined();
    expect(resolved.redis.name).toBe('redis-svc');
  });
});
