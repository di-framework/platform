import { describe, expect, it } from 'bun:test';
import { parseVcapApplication } from '../src/application-info.ts';

describe('parseVcapApplication', () => {
  it('should parse valid VCAP_APPLICATION JSON string', () => {
    const raw = JSON.stringify({
      application_id: 'app-123',
      application_name: 'orders-service',
      application_uris: ['orders.apps.example.com', 'orders-internal.example.com'],
      application_version: 'v1.2.0',
      space_id: 'space-456',
      space_name: 'prod',
      organization_id: 'org-789',
      organization_name: 'enterprise',
      instance_id: 'inst-1',
      instance_index: 2,
      host: '0.0.0.0',
      port: 8080,
      limits: { disk: 1024, fds: 16384, mem: 512 },
    });

    const info = parseVcapApplication(raw);
    expect(info).not.toBeNull();
    expect(info?.applicationId).toBe('app-123');
    expect(info?.applicationName).toBe('orders-service');
    expect(info?.applicationUris).toEqual([
      'orders.apps.example.com',
      'orders-internal.example.com',
    ]);
    expect(info?.applicationVersion).toBe('v1.2.0');
    expect(info?.spaceId).toBe('space-456');
    expect(info?.spaceName).toBe('prod');
    expect(info?.organizationId).toBe('org-789');
    expect(info?.organizationName).toBe('enterprise');
    expect(info?.instanceId).toBe('inst-1');
    expect(info?.instanceIndex).toBe(2);
    expect(info?.host).toBe('0.0.0.0');
    expect(info?.port).toBe(8080);
    expect(info?.limits).toEqual({ disk: 1024, fds: 16384, mem: 512 });
  });

  it('should parse alternate property naming conventions', () => {
    const raw = {
      app_id: 'alt-app',
      name: 'alt-name',
      uris: 'single-uri.example.com',
      version: '2.0.0',
      spaceId: 'sp-1',
      spaceName: 'dev',
      org_id: 'org-1',
      org_name: 'org-name',
      instanceIndex: '3',
      port: '3000',
    };

    const info = parseVcapApplication(raw);
    expect(info?.applicationId).toBe('alt-app');
    expect(info?.applicationName).toBe('alt-name');
    expect(info?.applicationUris).toEqual(['single-uri.example.com']);
    expect(info?.applicationVersion).toBe('2.0.0');
    expect(info?.instanceIndex).toBe(3);
    expect(info?.port).toBe(3000);
  });

  it('should parse from process.env wrapper or when VCAP_APPLICATION is a property', () => {
    const env = {
      VCAP_APPLICATION: JSON.stringify({
        application_id: 'env-app',
        application_name: 'env-name',
        space_id: 'env-space',
        space_name: 'env-space-name',
      }),
    };

    const info = parseVcapApplication(env);
    expect(info?.applicationId).toBe('env-app');
    expect(info?.applicationName).toBe('env-name');
  });

  it('should return null on invalid JSON or missing environment', () => {
    expect(parseVcapApplication('invalid-json')).toBeNull();
    expect(parseVcapApplication('{')).toBeNull();
    expect(parseVcapApplication({ VCAP_APPLICATION: '{invalid' } as any)).toBeNull();

    const originalApp = process.env.VCAP_APPLICATION;
    try {
      delete process.env.VCAP_APPLICATION;
      expect(parseVcapApplication()).toBeNull();
    } finally {
      if (originalApp !== undefined) process.env.VCAP_APPLICATION = originalApp;
    }
  });

  it('should handle non-object or invalid types gracefully', () => {
    expect(parseVcapApplication(null as any)).toBeNull();
    expect(parseVcapApplication('null')).toBeNull();
    expect(parseVcapApplication('123')).toBeNull();
    expect(parseVcapApplication(undefined)).toBeNull();
    expect(
      parseVcapApplication({ instance_index: 'invalid-number', port: 'invalid-port' })
        ?.instanceIndex,
    ).toBeUndefined();
  });
});
