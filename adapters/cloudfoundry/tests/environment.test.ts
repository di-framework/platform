import { describe, expect, it } from 'bun:test';
import {
  CloudFoundryEnvironment,
  getDefaultEnvironment,
  resetDefaultEnvironment,
} from '../src/environment.ts';

describe('CloudFoundryEnvironment', () => {
  it('should discover application info and services in Cloud Foundry mode', () => {
    const envData = {
      VCAP_APPLICATION: JSON.stringify({
        application_name: 'payment-api',
        space_name: 'production',
        instance_index: 0,
      }),
      VCAP_SERVICES: JSON.stringify({
        'p-postgresql': [
          {
            name: 'payments-db',
            label: 'p-postgresql',
            tags: ['postgres'],
            credentials: { uri: 'postgres://u:p@db:5432/paydb' },
          },
        ],
        'p-redis': [
          {
            name: 'cache-redis',
            label: 'p-redis',
            tags: ['redis'],
            credentials: { uri: 'redis://:pass@redishost:6379' },
          },
        ],
        cloudamqp: [
          {
            name: 'events-mq',
            label: 'cloudamqp',
            tags: ['rabbitmq'],
            credentials: { uri: 'amqp://guest:guest@localhost:5672' },
          },
        ],
        minio: [
          {
            name: 'attachments-s3',
            label: 'minio',
            tags: ['s3'],
            credentials: { bucket: 'attachments', access_key: 'k', secret_key: 's' },
          },
        ],
        'user-provided': [
          {
            name: 'stripe-creds',
            label: 'user-provided',
            tags: ['stripe'],
            credentials: { secretKey: 'sk_live_123' },
          },
        ],
      }),
    };

    const cf = new CloudFoundryEnvironment({ env: envData });
    expect(cf.isCloudFoundry()).toBe(true);
    expect(cf.getApplicationInfo()?.applicationName).toBe('payment-api');

    // Filter tests
    expect(cf.getServiceInfos().length).toBe(5);
    expect(cf.getServiceInfos('payments-db').length).toBe(1);
    expect(cf.getServiceInfos(/redis/).length).toBe(1);
    expect(cf.getServiceInfos({ label: 'minio' }).length).toBe(1);
    expect(cf.getServiceInfos({ tag: 'rabbitmq' }).length).toBe(1);
    expect(cf.getServiceInfos({ tag: /stripe/ }).length).toBe(1);
    expect(cf.getServiceInfos({ dialect: 'postgres' }).length).toBe(1);
    expect(cf.getServiceInfos({ predicate: (s) => s.name.startsWith('pay') }).length).toBe(1);

    // Typed getters
    const pg = cf.getRelationalServiceInfo('payments-db');
    expect(pg?.dialect).toBe('postgres');
    expect(cf.getRelationalServiceInfo()).not.toBeNull();

    const redis = cf.getRedisServiceInfo('cache-redis');
    expect(redis?.port).toBe(6379);
    expect(cf.getRedisServiceInfo()).not.toBeNull();

    const amqp = cf.getAmqpServiceInfo('events-mq');
    expect(amqp?.host).toBe('localhost');
    expect(cf.getAmqpServiceInfo()).not.toBeNull();

    const s3 = cf.getBlobStorageServiceInfo('attachments-s3');
    expect(s3?.bucketName).toBe('attachments');
    expect(cf.getBlobStorageServiceInfo()).not.toBeNull();

    const ups = cf.getUserProvidedServiceInfo('stripe-creds');
    expect(ups?.credentials.secretKey).toBe('sk_live_123');
    expect(cf.getUserProvidedServiceInfo({ tag: 'stripe' })?.name).toBe('stripe-creds');

    expect(cf.getServiceCredentials<{ secretKey: string }>('stripe-creds')?.secretKey).toBe(
      'sk_live_123',
    );
    expect(cf.getServiceCredentials('non-existent')).toBeNull();
  });

  it('should support local fallback when outside Cloud Foundry', () => {
    const localEnv = {
      DATABASE_URL: 'postgres://localuser:localpass@127.0.0.1:5432/localdb',
      REDIS_URL: 'redis://127.0.0.1:6379',
      AMQP_URL: 'amqp://127.0.0.1:5672',
      S3_BUCKET: 'local-bucket',
      S3_ENDPOINT: 'http://localhost:9000',
      AWS_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'local-key',
      AWS_SECRET_ACCESS_KEY: 'local-secret',
    };

    const cf = new CloudFoundryEnvironment({
      env: localEnv,
      localFallback: {
        services: {
          'custom-fallback': {
            label: 'user-provided',
            credentials: { apiKey: 'fallback-key' },
          },
        },
      },
    });

    expect(cf.isCloudFoundry()).toBe(false);
    expect(cf.getApplicationInfo()).toBeNull();

    const db = cf.getRelationalServiceInfo();
    expect(db).not.toBeNull();
    expect(db?.host).toBe('127.0.0.1');

    const redis = cf.getRedisServiceInfo();
    expect(redis).not.toBeNull();
    expect(redis?.port).toBe(6379);

    const amqp = cf.getAmqpServiceInfo();
    expect(amqp).not.toBeNull();
    expect(amqp?.host).toBe('127.0.0.1');

    const blob = cf.getBlobStorageServiceInfo();
    expect(blob).not.toBeNull();
    expect(blob?.bucketName).toBe('local-bucket');
    expect(blob?.endpoint).toBe('http://localhost:9000');

    const custom = cf.getServiceInfo('custom-fallback');
    expect(custom?.credentials.apiKey).toBe('fallback-key');
  });

  it('should return empty when localFallback is disabled', () => {
    const localEnv = {
      DATABASE_URL: 'postgres://localhost/mydb',
    };

    const cf = new CloudFoundryEnvironment({
      env: localEnv,
      localFallback: false,
    });

    expect(cf.getServiceInfos()).toEqual([]);
    expect(cf.getRelationalServiceInfo()).toBeNull();
  });

  it('should manage default singleton environment', () => {
    resetDefaultEnvironment();
    const env1 = getDefaultEnvironment();
    const env2 = getDefaultEnvironment();
    expect(env1).toBe(env2);
    resetDefaultEnvironment();
  });
});
