import { describe, expect, it } from 'bun:test';
import { parseVcapApplication } from '../src/application-info.ts';
import {
  bindCloudFoundryConnectors,
  CF_APPLICATION_TOKEN,
  CF_ENVIRONMENT_TOKEN,
} from '../src/bindings.ts';
import { AmqpServiceInfoCreator } from '../src/creators/amqp.ts';
import { BlobStorageServiceInfoCreator } from '../src/creators/blob-storage.ts';
import { RedisServiceInfoCreator } from '../src/creators/redis.ts';
import { RelationalServiceInfoCreator } from '../src/creators/relational.ts';
import { UserProvidedServiceInfoCreator } from '../src/creators/user-provided.ts';
import { CloudFoundryService, VcapApplication } from '../src/decorators.ts';
import { CloudFoundryEnvironment, resetDefaultEnvironment } from '../src/environment.ts';
import type { CloudFoundryServiceInfo } from '../src/types.ts';

describe('100% Coverage Verification', () => {
  it('should cover application-info edge cases', () => {
    // 1. process.env with invalid JSON
    process.env.VCAP_APPLICATION = 'invalid-json';
    try {
      expect(parseVcapApplication()).toBeNull();
    } finally {
      delete process.env.VCAP_APPLICATION;
    }

    // 2. object with VCAP_APPLICATION object
    const objWithObj = {
      VCAP_APPLICATION: {
        name: 'my-app',
        space_id: 's1',
      },
    };
    expect(parseVcapApplication(objWithObj)?.applicationName).toBe('my-app');

    // 3. object with empty string VCAP_APPLICATION
    expect(parseVcapApplication({ VCAP_APPLICATION: '' })).toBeNull();
    expect(parseVcapApplication({ VCAP_APPLICATION: null as any })).toBeNull();
  });

  it('should cover bindings.ts registerInstance fallback', () => {
    const mockStore = new Map<any, any>();
    const mockContainer = {
      registerInstance(token: any, val: any) {
        mockStore.set(token, val);
      },
    };

    const env = bindCloudFoundryConnectors(mockContainer as any, {
      env: { VCAP_SERVICES: '' },
    });
    expect(mockStore.get(CF_ENVIRONMENT_TOKEN)).toBe(env);
  });

  it('should cover creators branch conditions', () => {
    // AMQP
    const amqpCreator = new AmqpServiceInfoCreator();
    expect(
      amqpCreator.accept({ name: 'q', label: 'custom', tags: ['message-queue'], credentials: {} }),
    ).toBe(true);
    expect(
      amqpCreator.accept({
        name: 'q',
        label: 'custom',
        tags: [],
        credentials: { uri: 'amqp://localhost' },
      }),
    ).toBe(true);
    expect(
      amqpCreator.accept({
        name: 'q',
        label: 'custom',
        tags: [],
        credentials: { uris: ['amqps://localhost'] },
      }),
    ).toBe(true);

    // BlobStorage
    const blobCreator = new BlobStorageServiceInfoCreator();
    expect(blobCreator.accept({ name: 'b', label: 'custom', tags: ['s3'], credentials: {} })).toBe(
      true,
    );
    expect(
      blobCreator.accept({
        name: 'b',
        label: 'custom',
        tags: [],
        credentials: { uri: 's3://my-bucket' },
      }),
    ).toBe(true);
    expect(
      blobCreator.accept({
        name: 'b',
        label: 'custom',
        tags: [],
        credentials: { bucketName: 'my-bucket', endpoint: 'http://localhost' },
      }),
    ).toBe(true);

    // Redis
    const redisCreator = new RedisServiceInfoCreator();
    expect(
      redisCreator.accept({ name: 'r', label: 'custom', tags: ['cache'], credentials: {} }),
    ).toBe(true);
    expect(
      redisCreator.accept({
        name: 'r',
        label: 'custom',
        tags: [],
        credentials: { uri: 'redis://localhost' },
      }),
    ).toBe(true);
    expect(
      redisCreator.accept({
        name: 'r',
        label: 'custom',
        tags: [],
        credentials: { uri: 'rediss://localhost' },
      }),
    ).toBe(true);
    const rInfo = redisCreator.createServiceInfo({
      name: 'r2',
      label: 'p-redis',
      credentials: { database: 2, tls: true },
    });
    expect(rInfo.database).toBe(2);
    expect(rInfo.tls).toBe(true);

    // Relational
    const relationalCreator = new RelationalServiceInfoCreator();
    expect(
      relationalCreator.accept({
        name: 'db',
        label: 'custom',
        tags: [],
        credentials: { uri: 'postgres://localhost' },
      }),
    ).toBe(true);
    expect(
      relationalCreator.accept({
        name: 'db',
        label: 'custom',
        tags: [],
        credentials: { uri: 'mysql://localhost' },
      }),
    ).toBe(true);
    expect(
      relationalCreator.accept({
        name: 'db',
        label: 'custom',
        tags: [],
        credentials: { uri: 'sqlite://file.db' },
      }),
    ).toBe(true);
    expect(
      relationalCreator.accept({
        name: 'db',
        label: 'custom',
        tags: [],
        credentials: { jdbcUrl: 'jdbc:mysql://localhost:3306/db' },
      }),
    ).toBe(true);

    // Relational unknown scheme in JDBC or URI
    const unknownDialect = relationalCreator.createServiceInfo({
      name: 'db',
      label: 'custom',
      tags: ['relational'],
      credentials: { uri: 'cockroach://localhost:26257/defaultdb' },
    });
    expect(unknownDialect.dialect).toBe('postgres');

    // User provided port as string
    const userCreator = new UserProvidedServiceInfoCreator();
    const upInfo = userCreator.createServiceInfo({
      name: 'u',
      label: 'user-provided',
      credentials: { port: '8080' },
    });
    expect(upInfo.port).toBe(8080);
  });

  it('should cover decorators fallback, token derivation, and property getters', () => {
    resetDefaultEnvironment();
    process.env.VCAP_SERVICES = JSON.stringify({
      'p-mysql': [
        { name: 'env-mysql', label: 'p-mysql', credentials: { uri: 'mysql://localhost/db' } },
      ],
    });
    process.env.VCAP_APPLICATION = JSON.stringify({
      application_name: 'env-app',
      space_name: 'env-space',
    });

    try {
      class TestDecoratedClass {
        @CloudFoundryService()
        defaultService!: CloudFoundryServiceInfo;

        @CloudFoundryService({ name: 'by-name' })
        byNameService!: any;

        @CloudFoundryService({ label: 'p-mysql' })
        byLabelService!: any;

        @CloudFoundryService(/p-mysql/)
        byRegexService!: any;

        @CloudFoundryService('missing-opt', {
          required: false,
          fallbackEnv: ['UNSET_VAR_1', 'SET_VAR_2'],
        })
        fallbackArrayService!: any;

        @CloudFoundryService('none-matched-opt', {
          required: false,
          fallbackEnv: ['UNSET_1', 'UNSET_2'],
        })
        noneMatchedService!: any;

        @VcapApplication()
        appInfo!: any;
      }

      process.env.SET_VAR_2 = 'http://fallback-uri.com';

      const inst = new TestDecoratedClass();
      expect(inst.defaultService.name).toBe('env-mysql');
      expect(inst.byLabelService.name).toBe('env-mysql');
      expect(inst.byRegexService.name).toBe('env-mysql');
      expect(inst.fallbackArrayService.uri).toBe('http://fallback-uri.com');
      expect(inst.noneMatchedService).toBeUndefined();
      expect(inst.appInfo.applicationName).toBe('env-app');

      // Test required: false returning undefined when not found
      class NoFallbackClass {
        @CloudFoundryService('non-existent', { required: false })
        missing!: any;
      }
      expect(new NoFallbackClass().missing).toBeUndefined();

      // Test VcapApplication setter
      inst.appInfo = { applicationName: 'updated' } as any;
      expect(inst.appInfo.applicationName).toBe('updated');
    } finally {
      delete process.env.VCAP_SERVICES;
      delete process.env.VCAP_APPLICATION;
      delete process.env.SET_VAR_2;
      resetDefaultEnvironment();
    }
  });
});
