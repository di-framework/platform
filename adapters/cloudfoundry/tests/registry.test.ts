import { describe, expect, it } from 'bun:test';
import type { CloudFoundryServiceInfoCreator } from '../src/spi/creator.ts';
import {
  getDefaultRegistry,
  parseVcapServices,
  ServiceInfoCreatorRegistry,
} from '../src/spi/registry.ts';
import type { CloudFoundryServiceInfo, RawVcapServiceData } from '../src/types.ts';

describe('ServiceInfoCreatorRegistry', () => {
  it('should parse complex multi-service VCAP_SERVICES payload', () => {
    const registry = new ServiceInfoCreatorRegistry();

    const vcap = {
      elephantsql: [
        {
          name: 'db-orders',
          label: 'elephantsql',
          tags: ['postgres'],
          credentials: { uri: 'postgres://u:p@db:5432/orders' },
        },
      ],
      rediscloud: [
        {
          name: 'redis-cache',
          label: 'rediscloud',
          tags: ['redis'],
          credentials: { uri: 'redis://:p@redis:6379/0' },
        },
      ],
      'user-provided': [
        {
          name: 'external-api',
          label: 'user-provided',
          tags: ['api'],
          credentials: { apiKey: 'key-123' },
        },
      ],
    };

    const services = registry.parseVcapServices(vcap);
    expect(services.length).toBe(3);

    const db = services.find((s) => s.name === 'db-orders');
    expect(db).toBeDefined();
    expect((db as any).dialect).toBe('postgres');

    const redis = services.find((s) => s.name === 'redis-cache');
    expect(redis).toBeDefined();
    expect((redis as any).host).toBe('redis');

    const custom = services.find((s) => s.name === 'external-api');
    expect(custom).toBeDefined();
    expect(custom?.credentials.apiKey).toBe('key-123');
  });

  it('should support registering custom creators with high and low priority', () => {
    const registry = new ServiceInfoCreatorRegistry();

    const customCreator: CloudFoundryServiceInfoCreator = {
      accept: (data) => data.label === 'custom-broker',
      createServiceInfo: (data) =>
        ({
          id: data.name,
          name: data.name,
          label: data.label,
          tags: ['custom'],
          credentials: data.credentials || {},
          customProperty: true,
        }) as any,
    };

    registry.registerCreator(customCreator, { priority: 'high' });

    const raw: RawVcapServiceData = {
      name: 'my-custom',
      label: 'custom-broker',
      credentials: { foo: 'bar' },
    };

    const res = registry.createServiceInfo(raw);
    expect((res as any).customProperty).toBe(true);
  });

  it('should fallback to default info when no creator accepts', () => {
    const emptyRegistry = new ServiceInfoCreatorRegistry(false);
    const raw: RawVcapServiceData = {
      name: 'unhandled-service',
      label: 'some-label',
      plan: 'free',
      tags: ['unknown'],
      credentials: { token: 'abc' },
    };

    const info = emptyRegistry.createServiceInfo(raw);
    expect(info.name).toBe('unhandled-service');
    expect(info.label).toBe('some-label');
    expect(info.plan).toBe('free');
    expect(info.credentials.token).toBe('abc');
  });

  it('should parse from process.env, JSON strings, arrays, or empty values', () => {
    const original = process.env.VCAP_SERVICES;
    try {
      delete process.env.VCAP_SERVICES;
      expect(parseVcapServices()).toEqual([]);

      process.env.VCAP_SERVICES = JSON.stringify({
        'p-mysql': [
          { name: 'mysql-1', label: 'p-mysql', credentials: { uri: 'mysql://root@localhost/db' } },
        ],
      });
      const fromEnv = parseVcapServices();
      expect(fromEnv.length).toBe(1);
      expect(fromEnv[0]?.name).toBe('mysql-1');

      // Test with string input
      const fromStr = parseVcapServices(process.env.VCAP_SERVICES);
      expect(fromStr.length).toBe(1);

      // Test with invalid JSON
      expect(parseVcapServices('not-json')).toEqual([]);
      expect(parseVcapServices('{')).toEqual([]);
      expect(parseVcapServices({ VCAP_SERVICES: '{invalid' } as any)).toEqual([]);

      // Test with direct array of RawVcapServiceData
      const fromArr = parseVcapServices([
        { name: 'direct-service', label: 'user-provided', credentials: {} },
      ]);
      expect(fromArr.length).toBe(1);
      expect(fromArr[0]?.name).toBe('direct-service');

      // Test with null
      expect(parseVcapServices(null as any)).toEqual([]);
    } finally {
      if (original !== undefined) process.env.VCAP_SERVICES = original;
    }
  });

  it('should return singleton default registry', () => {
    const r1 = getDefaultRegistry();
    const r2 = getDefaultRegistry();
    expect(r1).toBe(r2);
  });
});
