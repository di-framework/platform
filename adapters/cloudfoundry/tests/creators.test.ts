import { describe, expect, it } from 'bun:test';
import { AmqpServiceInfoCreator } from '../src/creators/amqp.ts';
import { BlobStorageServiceInfoCreator } from '../src/creators/blob-storage.ts';
import { RedisServiceInfoCreator } from '../src/creators/redis.ts';
import { RelationalServiceInfoCreator } from '../src/creators/relational.ts';
import { UserProvidedServiceInfoCreator } from '../src/creators/user-provided.ts';

describe('RelationalServiceInfoCreator', () => {
  const creator = new RelationalServiceInfoCreator();

  it('should accept and create postgres service from ElephantSQL or Crunchy', () => {
    const raw = {
      name: 'prod-postgres',
      label: 'elephantsql',
      plan: 'turtle',
      tags: ['postgres', 'relational'],
      credentials: {
        uri: 'postgres://pguser:secretpass@postgres.internal.net:5432/orders_db?sslmode=require',
      },
    };

    expect(creator.accept(raw)).toBe(true);
    const info = creator.createServiceInfo(raw);
    expect(info.id).toBe('prod-postgres');
    expect(info.dialect).toBe('postgres');
    expect(info.host).toBe('postgres.internal.net');
    expect(info.port).toBe(5432);
    expect(info.database).toBe('orders_db');
    expect(info.username).toBe('pguser');
    expect(info.password).toBe('secretpass');
    expect(info.ssl).toBe(true);
    expect(info.jdbcUrl).toBe('jdbc:postgresql://postgres.internal.net:5432/orders_db');
  });

  it('should accept and create mysql service with separate credentials', () => {
    const raw = {
      name: 'mysql-db',
      label: 'p-mysql',
      tags: ['mysql', 'database'],
      credentials: {
        hostname: 'mysql.cluster.local',
        port: '3306',
        name: 'inventory',
        username: 'admin',
        password: 'pwd',
        ssl: false,
      },
    };

    expect(creator.accept(raw)).toBe(true);
    const info = creator.createServiceInfo(raw);
    expect(info.dialect).toBe('mysql');
    expect(info.host).toBe('mysql.cluster.local');
    expect(info.port).toBe(3306);
    expect(info.database).toBe('inventory');
    expect(info.username).toBe('admin');
    expect(info.password).toBe('pwd');
    expect(info.ssl).toBe(false);
    expect(info.uri).toBe('mysql://admin:pwd@mysql.cluster.local:3306/inventory');
  });

  it('should accept and create MariaDB and SQLite services', () => {
    const mariadb = {
      name: 'maria-db',
      label: 'mariadb',
      tags: ['mariadb'],
      credentials: {
        uri: 'mariadb://root:pass@mariadb.local:3306/db',
      },
    };
    expect(creator.accept(mariadb)).toBe(true);
    expect(creator.createServiceInfo(mariadb).dialect).toBe('mariadb');

    const sqlite = {
      name: 'sqlite-db',
      label: 'sqlite',
      tags: ['sqlite'],
      credentials: {
        uri: 'sqlite:///var/data/app.db',
        jdbcUrl: 'jdbc:sqlite:/var/data/app.db',
      },
    };
    expect(creator.accept(sqlite)).toBe(true);
    const sqliteInfo = creator.createServiceInfo(sqlite);
    expect(sqliteInfo.dialect).toBe('sqlite');
    expect(sqliteInfo.jdbcUrl).toBe('jdbc:sqlite:/var/data/app.db');
  });

  it('should handle JDBC URIs and fallback DB names', () => {
    const jdbcService = {
      name: 'legacy-jdbc',
      label: 'postgresql',
      tags: ['rdbms'],
      credentials: {
        uri: 'jdbc:postgresql://dbhost:5432/customdb?ssl=true',
        jdbcUrl: 'jdbc:postgresql://dbhost:5432/customdb?ssl=true',
      },
    };
    expect(creator.accept(jdbcService)).toBe(true);
    const info = creator.createServiceInfo(jdbcService);
    expect(info.dialect).toBe('postgres');
    expect(info.host).toBe('dbhost');
    expect(info.ssl).toBe(true);
    expect(info.database).toBe('customdb');
  });

  it('should reject non-relational services', () => {
    expect(
      creator.accept({ name: 'redis', label: 'p-redis', tags: ['redis'], credentials: {} }),
    ).toBe(false);
  });
});

describe('RedisServiceInfoCreator', () => {
  const creator = new RedisServiceInfoCreator();

  it('should accept and parse Redis Cloud service with TLS rediss:// URL', () => {
    const raw = {
      name: 'session-cache',
      label: 'rediscloud',
      tags: ['redis', 'cache'],
      credentials: {
        uri: 'rediss://:mypassword@redis-cluster.cloud.redislabs.com:6380/1',
      },
    };

    expect(creator.accept(raw)).toBe(true);
    const info = creator.createServiceInfo(raw);
    expect(info.host).toBe('redis-cluster.cloud.redislabs.com');
    expect(info.port).toBe(6380);
    expect(info.password).toBe('mypassword');
    expect(info.database).toBe(1);
    expect(info.tls).toBe(true);
  });

  it('should construct Redis URI from discrete credential fields', () => {
    const raw = {
      name: 'local-redis',
      label: 'p-redis',
      tags: ['redis'],
      credentials: {
        hostname: 'redis.internal',
        port: '6379',
        password: 'pwd',
        db: 0,
        cluster: true,
      },
    };

    expect(creator.accept(raw)).toBe(true);
    const info = creator.createServiceInfo(raw);
    expect(info.host).toBe('redis.internal');
    expect(info.port).toBe(6379);
    expect(info.cluster).toBe(true);
    expect(info.uri).toBe('redis://:pwd@redis.internal:6379/0');
  });

  it('should reject non-redis services', () => {
    expect(creator.accept({ name: 'pg', label: 'postgresql', credentials: {} })).toBe(false);
  });
});

describe('AmqpServiceInfoCreator', () => {
  const creator = new AmqpServiceInfoCreator();

  it('should accept and parse CloudAMQP service with uris list', () => {
    const raw = {
      name: 'events-amqp',
      label: 'cloudamqp',
      tags: ['rabbitmq', 'amqp', 'messaging'],
      credentials: {
        uris: [
          'amqps://user:secret@rabbit1.cloudamqp.com/myvhost',
          'amqps://user:secret@rabbit2.cloudamqp.com/myvhost',
        ],
        http_api_uri: 'https://user:secret@rabbit1.cloudamqp.com/api',
      },
    };

    expect(creator.accept(raw)).toBe(true);
    const info = creator.createServiceInfo(raw);
    expect(info.host).toBe('rabbit1.cloudamqp.com');
    expect(info.virtualHost).toBe('myvhost');
    expect(info.username).toBe('user');
    expect(info.password).toBe('secret');
    expect(info.ssl).toBe(true);
    expect(info.uris.length).toBe(2);
    expect(info.httpManagementUri).toBe('https://user:secret@rabbit1.cloudamqp.com/api');
  });

  it('should construct AMQP URI from individual fields', () => {
    const raw = {
      name: 'p-rabbit',
      label: 'p-rabbitmq',
      tags: ['rabbitmq'],
      credentials: {
        hostname: 'rabbitmq.node',
        port: '5672',
        username: 'rabbit',
        password: 'pass',
        vhost: 'v1',
      },
    };

    expect(creator.accept(raw)).toBe(true);
    const info = creator.createServiceInfo(raw);
    expect(info.uri).toBe('amqp://rabbit:pass@rabbitmq.node:5672/v1');
  });

  it('should reject non-amqp services', () => {
    expect(creator.accept({ name: 'pg', label: 'postgres', credentials: {} })).toBe(false);
  });
});

describe('BlobStorageServiceInfoCreator', () => {
  const creator = new BlobStorageServiceInfoCreator();

  it('should accept and parse MinIO / S3 service', () => {
    const raw = {
      name: 'media-s3',
      label: 'minio',
      tags: ['s3', 'blobstore', 'storage'],
      credentials: {
        bucket: 'media-uploads',
        endpoint: 'https://minio.apps.local:9000',
        region: 'us-east-1',
        access_key_id: 'minioadmin',
        secret_access_key: 'miniopassword',
        path_style: true,
      },
    };

    expect(creator.accept(raw)).toBe(true);
    const info = creator.createServiceInfo(raw);
    expect(info.bucketName).toBe('media-uploads');
    expect(info.endpoint).toBe('https://minio.apps.local:9000');
    expect(info.region).toBe('us-east-1');
    expect(info.accessKeyId).toBe('minioadmin');
    expect(info.secretAccessKey).toBe('miniopassword');
    expect(info.pathStyle).toBe(true);
    expect(info.uri).toBe('https://minio.apps.local:9000/media-uploads');
  });

  it('should parse s3:// URI format', () => {
    const raw = {
      name: 's3-bucket',
      label: 's3',
      credentials: {
        uri: 's3://mykey:mysecret@prod-bucket-name',
      },
    };

    expect(creator.accept(raw)).toBe(true);
    const info = creator.createServiceInfo(raw);
    expect(info.bucketName).toBe('prod-bucket-name');
    expect(info.accessKeyId).toBe('mykey');
    expect(info.secretAccessKey).toBe('mysecret');
  });

  it('should reject non-blob services', () => {
    expect(creator.accept({ name: 'cache', label: 'redis', credentials: {} })).toBe(false);
  });
});

describe('UserProvidedServiceInfoCreator', () => {
  const creator = new UserProvidedServiceInfoCreator();

  it('should accept user-provided services', () => {
    const raw = {
      name: 'custom-api',
      label: 'user-provided',
      tags: ['custom'],
      credentials: {
        uri: 'https://api.thirdparty.com/v1',
        apiKey: 'xyz123',
        host: 'api.thirdparty.com',
        port: 443,
        username: 'client',
        password: 'tok',
      },
    };

    expect(creator.accept(raw)).toBe(true);
    const info = creator.createServiceInfo(raw);
    expect(info.name).toBe('custom-api');
    expect(info.label).toBe('user-provided');
    expect(info.uri).toBe('https://api.thirdparty.com/v1');
    expect(info.host).toBe('api.thirdparty.com');
    expect(info.port).toBe(443);
    expect(info.username).toBe('client');
    expect(info.password).toBe('tok');
  });

  it('should accept services with empty or missing label', () => {
    expect(creator.accept({ name: 'orphan', label: '', credentials: {} })).toBe(true);
  });
});
