import { describe, expect, it } from 'bun:test';
import { CloudFoundryDetector, isCloudFoundry } from '../src/detector.ts';

describe('CloudFoundryDetector', () => {
  it('should detect Cloud Foundry when VCAP_APPLICATION is set', () => {
    const env = { VCAP_APPLICATION: '{"name":"my-app"}' };
    expect(CloudFoundryDetector.isCloudFoundry(env)).toBe(true);
    expect(isCloudFoundry(env)).toBe(true);
    expect(CloudFoundryDetector.getApplicationJson(env)).toBe('{"name":"my-app"}');
  });

  it('should detect Cloud Foundry when VCAP_SERVICES is set', () => {
    const env = { VCAP_SERVICES: '{"p-mysql":[]}' };
    expect(CloudFoundryDetector.isCloudFoundry(env)).toBe(true);
    expect(isCloudFoundry(env)).toBe(true);
    expect(CloudFoundryDetector.getServicesJson(env)).toBe('{"p-mysql":[]}');
  });

  it('should return false when environment is empty or whitespace', () => {
    expect(CloudFoundryDetector.isCloudFoundry({})).toBe(false);
    expect(isCloudFoundry({})).toBe(false);
    expect(CloudFoundryDetector.isCloudFoundry({ VCAP_APPLICATION: '  ', VCAP_SERVICES: '' })).toBe(
      false,
    );
    expect(CloudFoundryDetector.getApplicationJson({})).toBeUndefined();
    expect(CloudFoundryDetector.getServicesJson({})).toBeUndefined();
  });

  it('should use process.env by default', () => {
    const originalApp = process.env.VCAP_APPLICATION;
    try {
      delete process.env.VCAP_APPLICATION;
      delete process.env.VCAP_SERVICES;
      expect(CloudFoundryDetector.isCloudFoundry()).toBe(false);

      process.env.VCAP_APPLICATION = '{"name":"test"}';
      expect(CloudFoundryDetector.isCloudFoundry()).toBe(true);
      expect(CloudFoundryDetector.getApplicationJson()).toBe('{"name":"test"}');
    } finally {
      if (originalApp !== undefined) {
        process.env.VCAP_APPLICATION = originalApp;
      } else {
        delete process.env.VCAP_APPLICATION;
      }
    }
  });
});
