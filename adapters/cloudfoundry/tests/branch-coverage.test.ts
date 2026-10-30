import { describe, expect, it } from 'bun:test';
import { parseVcapApplication } from '../src/application-info.ts';
import { AmqpServiceInfoCreator } from '../src/creators/amqp.ts';
import { BlobStorageServiceInfoCreator } from '../src/creators/blob-storage.ts';
import { RedisServiceInfoCreator } from '../src/creators/redis.ts';
import { RelationalServiceInfoCreator } from '../src/creators/relational.ts';
import { CloudFoundryEnvironment } from '../src/environment.ts';
import type { CloudFoundryServiceInfoCreator } from '../src/spi/creator.ts';
import { ServiceInfoCreatorRegistry } from '../src/spi/registry.ts';
import type { BlobStorageServiceInfo, RawVcapServiceData } from '../src/types.ts';

describe('application info', () => {
  it('drops application URIs that are neither a list nor a string', () => {
    const info = parseVcapApplication({
      VCAP_APPLICATION: { name: 'app', application_uris: 42 },
    });
    expect(info?.applicationUris).toEqual([]);
  });
});

describe('AMQP creator branches', () => {
  const creator = new AmqpServiceInfoCreator();

  it('reads the url credential when uris and uri are absent', () => {
    const info = creator.createServiceInfo({
      name: 'mq',
      label: 'rabbitmq',
      credentials: { url: 'amqp://u:p@mq.internal:5673/vh' },
    });
    expect(info.uri).toBe('amqp://u:p@mq.internal:5673/vh');
    expect(info.host).toBe('mq.internal');
    expect(info.port).toBe(5673);
    expect(info.virtualHost).toBe('vh');
  });

  it('uses the tls flag when ssl is absent and leaves ssl unset otherwise', () => {
    const withTls = creator.createServiceInfo({
      name: 'mq',
      label: 'rabbitmq',
      credentials: { hostname: 'h', tls: true },
    });
    expect(withTls.ssl).toBe(true);

    const sslWins = creator.createServiceInfo({
      name: 'mq',
      label: 'rabbitmq',
      credentials: { hostname: 'h', ssl: false, tls: true },
    });
    expect(sslWins.ssl).toBe(false);

    const neither = creator.createServiceInfo({
      name: 'mq',
      label: 'rabbitmq',
      credentials: { hostname: 'h' },
    });
    expect(neither.ssl).toBeUndefined();
  });

  it('keeps discrete credentials when the URI cannot be parsed', () => {
    const info = creator.createServiceInfo({
      name: 'mq',
      label: 'rabbitmq',
      credentials: { uri: 'not a url', hostname: 'fallback-host', port: 1234 },
    });
    expect(info.host).toBe('fallback-host');
    expect(info.port).toBe(1234);
  });
});

describe('blob storage creator branches', () => {
  const creator = new BlobStorageServiceInfoCreator();

  it('reads aws_secret_access_key and camelCase pathStyle', () => {
    const info = creator.createServiceInfo({
      name: 's3',
      label: 's3',
      credentials: { bucket: 'b', aws_secret_access_key: 'shh', pathStyle: true },
    });
    expect(info.secretAccessKey).toBe('shh');
    expect(info.pathStyle).toBe(true);
  });

  it('keeps discrete credentials when an s3:// URI cannot be parsed', () => {
    const info = creator.createServiceInfo({
      name: 's3',
      label: 's3',
      credentials: { bucket: 'kept', uri: 's3://bad host/x' },
    });
    expect(info.bucketName).toBe('kept');
    expect(info.uri).toBe('s3://bad host/x');
  });

  it('prefixes https:// to a bare endpoint when building the URI', () => {
    const info = creator.createServiceInfo({
      name: 's3',
      label: 's3',
      credentials: { bucket: 'b', endpoint: 'minio.internal:9000' },
    });
    expect(info.uri).toBe('https://minio.internal:9000/b');
  });
});

describe('redis creator branches', () => {
  const creator = new RedisServiceInfoCreator();

  it('uses the ssl flag when tls is absent', () => {
    const info = creator.createServiceInfo({
      name: 'cache',
      label: 'redis',
      credentials: { host: 'r', ssl: true },
    });
    expect(info.tls).toBe(true);
  });

  it('keeps discrete credentials when the URI cannot be parsed', () => {
    const info = creator.createServiceInfo({
      name: 'cache',
      label: 'redis',
      credentials: { uri: 'not a url', host: 'fallback-host', port: 6380 },
    });
    expect(info.host).toBe('fallback-host');
    expect(info.port).toBe(6380);
  });
});

describe('relational creator branches', () => {
  const creator = new RelationalServiceInfoCreator();

  it('reads sslmode=require from a JDBC URI', () => {
    const info = creator.createServiceInfo({
      name: 'db',
      label: 'postgresql',
      credentials: { uri: 'jdbc:postgresql://pg.internal:5432/app?sslmode=require' },
    });
    expect(info.host).toBe('pg.internal');
    expect(info.ssl).toBe(true);
  });

  it('keeps discrete credentials when a JDBC URI cannot be parsed', () => {
    const info = creator.createServiceInfo({
      name: 'db',
      label: 'postgresql',
      credentials: { uri: 'jdbc:not a url', hostname: 'fallback-host', port: 6543 },
    });
    expect(info.host).toBe('fallback-host');
    expect(info.port).toBe(6543);
  });

  it('keeps discrete credentials when a plain URI cannot be parsed', () => {
    const info = creator.createServiceInfo({
      name: 'db',
      label: 'postgresql',
      credentials: { uri: 'not a url', hostname: 'fallback-host', port: 6543 },
    });
    expect(info.host).toBe('fallback-host');
    expect(info.port).toBe(6543);
  });
});

describe('environment filters', () => {
  const services = {
    postgresql: [{ name: 'db', label: 'postgresql', credentials: { uri: 'postgres://h/d' } }],
    redis: [{ name: 'cache', label: 'redis', credentials: { uri: 'redis://h:6379' } }],
    rabbitmq: [{ name: 'mq', label: 'rabbitmq', credentials: { uri: 'amqp://h/v' } }],
    s3: [{ name: 'files', label: 's3', credentials: { bucket: 'b' } }],
  };
  const env = new CloudFoundryEnvironment({
    env: { VCAP_SERVICES: JSON.stringify(services) },
    localFallback: false,
  });

  it('filters by name string and name pattern', () => {
    expect(env.getServiceInfos({ name: 'cache' }).map((s) => s.name)).toEqual(['cache']);
    expect(env.getServiceInfos({ name: /^(db|mq)$/ }).map((s) => s.name)).toEqual(['db', 'mq']);
  });

  it('returns the typed service matching an object filter', () => {
    expect(env.getRelationalServiceInfo({ name: 'db' })?.name).toBe('db');
    expect(env.getRedisServiceInfo({ name: 'cache' })?.name).toBe('cache');
    expect(env.getAmqpServiceInfo({ name: 'mq' })?.name).toBe('mq');
    expect(env.getBlobStorageServiceInfo({ name: 'files' })?.name).toBe('files');
  });
});

describe('local blob storage fallback', () => {
  const blob = (vars: Record<string, string>) =>
    new CloudFoundryEnvironment({
      env: vars,
    }).getBlobStorageServiceInfo() as BlobStorageServiceInfo;

  it('reads secondary endpoint, region and key variables', () => {
    const info = blob({
      S3_BUCKET: 'b',
      AWS_ENDPOINT_URL: 'http://minio:9000',
      AWS_DEFAULT_REGION: 'eu-west-1',
      S3_ACCESS_KEY: 'ak',
      S3_SECRET_KEY: 'sk',
    });
    expect(info.endpoint).toBe('http://minio:9000');
    expect(info.region).toBe('eu-west-1');
    expect(info.accessKeyId).toBe('ak');
    expect(info.secretAccessKey).toBe('sk');
  });

  it('defaults the region to us-east-1', () => {
    expect(blob({ S3_BUCKET: 'b' }).region).toBe('us-east-1');
  });
});

describe('service info creator registry', () => {
  const custom = (label: string): CloudFoundryServiceInfoCreator => ({
    accept: (s: RawVcapServiceData) => s.label === 'redis',
    createServiceInfo: (s: RawVcapServiceData) => ({
      id: s.name,
      name: s.name,
      label,
      tags: [],
      credentials: {},
    }),
  });
  const redis = { name: 'cache', label: 'redis', credentials: { uri: 'redis://h' } };

  it('checks low-priority creators after the built-ins', () => {
    const registry = new ServiceInfoCreatorRegistry();
    registry.registerCreator(custom('low'), { priority: 'low' });
    expect(registry.createServiceInfo(redis).label).toBe('redis');
    registry.registerCreator(custom('high'));
    expect(registry.createServiceInfo(redis).label).toBe('high');
  });

  it('skips creators whose accept throws', () => {
    const registry = new ServiceInfoCreatorRegistry();
    registry.registerCreator({
      accept: () => {
        throw new Error('boom');
      },
      createServiceInfo: () => {
        throw new Error('unreachable');
      },
    });
    expect(registry.createServiceInfo(redis).label).toBe('redis');
  });

  it('returns no services for invalid VCAP_SERVICES in the process env', () => {
    const original = process.env.VCAP_SERVICES;
    process.env.VCAP_SERVICES = '{invalid';
    try {
      expect(new ServiceInfoCreatorRegistry().parseVcapServices()).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.VCAP_SERVICES;
      else process.env.VCAP_SERVICES = original;
    }
  });

  it('accepts an already-parsed VCAP_SERVICES object', () => {
    const parsed = new ServiceInfoCreatorRegistry().parseVcapServices({
      VCAP_SERVICES: { redis: [redis] },
    });
    expect(parsed.map((s) => s.name)).toEqual(['cache']);
  });

  it('returns no services when the JSON is not an object', () => {
    expect(new ServiceInfoCreatorRegistry().parseVcapServices('42')).toEqual([]);
  });
});
