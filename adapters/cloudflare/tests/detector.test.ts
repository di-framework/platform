import { describe, expect, it } from 'bun:test';
import {
  CloudflareDetector,
  isCloudflare,
  isCloudflarePages,
  isCloudflareWorkers,
  readProcessEnv,
} from '../src/detector.ts';

describe('CloudflareDetector', () => {
  it('detects the Workers user agent', () => {
    const scope = { navigator: { userAgent: 'Cloudflare-Workers' } };
    expect(CloudflareDetector.isWorkers(scope)).toBe(true);
    expect(isCloudflareWorkers(scope)).toBe(true);
    expect(CloudflareDetector.isCloudflare(scope, {})).toBe(true);
    expect(isCloudflare(scope, {})).toBe(true);
  });

  it('detects Pages from CF_PAGES', () => {
    const env = { CF_PAGES: '1' };
    expect(CloudflareDetector.isPages(env)).toBe(true);
    expect(isCloudflarePages(env)).toBe(true);
    expect(isCloudflare({}, env)).toBe(true);
  });

  it('rejects empty and lookalike runtimes', () => {
    expect(CloudflareDetector.isWorkers({})).toBe(false);
    expect(CloudflareDetector.isWorkers({ navigator: { userAgent: '  ' } })).toBe(false);
    expect(CloudflareDetector.isWorkers({ navigator: { userAgent: 'workers' } })).toBe(false);
    expect(CloudflareDetector.isPages({})).toBe(false);
    expect(CloudflareDetector.isPages({ CF_PAGES: '0' })).toBe(false);
    expect(isCloudflareWorkers({})).toBe(false);
    expect(isCloudflare({}, {})).toBe(false);
  });

  it('reads process.env and globalThis by default', () => {
    const original = process.env.CF_PAGES;
    try {
      delete process.env.CF_PAGES;
      expect(CloudflareDetector.isPages()).toBe(false);
      expect(isCloudflarePages()).toBe(false);
      process.env.CF_PAGES = '1';
      expect(CloudflareDetector.isPages()).toBe(true);
      expect(CloudflareDetector.isCloudflare()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.CF_PAGES;
      else process.env.CF_PAGES = original;
    }
  });

  it('uses an empty env when the runtime has no process', () => {
    expect(readProcessEnv({})).toEqual({});
    expect(CloudflareDetector.isPages(readProcessEnv({}))).toBe(false);
    expect(isCloudflare({}, readProcessEnv({}))).toBe(false);
  });
});
