import { describe, expect, test } from 'bun:test';
import {
  BackgroundDiscovery,
  type BackgroundDiscoveryOptions,
  sleepUnlessAborted,
} from '../src/discovery-retry.ts';
import type { ProviderMetadata } from '../src/oidc.ts';

const provider = { issuer: 'https://id.example' } as ProviderMetadata;

/** A discovery wired to fakes: `failures` attempts fail, then the issuer answers. */
function harness(failures: number, overrides: Partial<BackgroundDiscoveryOptions> = {}) {
  const lines: [string, Record<string, unknown>][] = [];
  const sleeps: number[] = [];
  let attempts = 0;
  const discovery = new BackgroundDiscovery({
    issuer: 'https://id.example',
    audit: (event, fields) => lines.push([event, fields]),
    discover: async () => {
      attempts++;
      if (attempts <= failures) throw new Error(`down ${attempts}`);
      return provider;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { discovery, lines, sleeps, attempts: () => attempts };
}

describe('BackgroundDiscovery', () => {
  test('starts complete when given a provider', async () => {
    const discovery = new BackgroundDiscovery({ issuer: 'x', audit: () => {} }, provider);
    await discovery.discovered;
    expect(discovery.provider).toBe(provider);
    expect(discovery.state).toEqual({ status: 'complete', provider });
  });

  test('the default backoff doubles from 1 s and caps at 30 s', async () => {
    const { discovery, sleeps, lines } = harness(8);
    expect(discovery.state).toEqual({ status: 'pending', retryAfterSeconds: 1 });
    await discovery.run();
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(lines.filter(([e]) => e === 'discovery.failed').map(([, f]) => f.retryInMs)).toEqual(
      sleeps,
    );
    expect(lines[0]).toEqual([
      'discovery.failed',
      { error: 'down 1', issuer: 'https://id.example', retryInMs: 1_000 },
    ]);
    expect(lines.at(-1)).toEqual(['discovery.succeeded', { issuer: 'https://id.example' }]);
    expect(discovery.provider).toBe(provider);
  });

  test('a custom backoff is honoured and retryAfterSeconds rounds up to at least 1', async () => {
    const seen: unknown[] = [];
    const { discovery, sleeps } = harness(4, {
      backoff: { initialMs: 10, maxMs: 40 },
      sleep: async (ms) => {
        sleeps.push(ms);
        seen.push(discovery.state);
      },
    });
    await discovery.run();
    expect(sleeps).toEqual([10, 20, 40, 40]);
    expect(seen.every((s) => (s as { retryAfterSeconds: number }).retryAfterSeconds === 1)).toBe(
      true,
    );
  });

  test('onDiscovered runs before discovery.succeeded is logged', async () => {
    const order: string[] = [];
    const { discovery } = harness(0, {
      audit: (event) => order.push(event),
      onDiscovered: (found) => order.push(`found ${found.issuer}`),
    });
    await discovery.run();
    await discovery.discovered;
    expect(order).toEqual(['found https://id.example', 'discovery.succeeded']);
  });

  test('stop() during an attempt ends the loop without a failure line', async () => {
    let discovery!: BackgroundDiscovery;
    const lines: string[] = [];
    discovery = new BackgroundDiscovery({
      issuer: 'x',
      audit: (event) => lines.push(event),
      discover: async (_issuer, _attempts, signal) => {
        discovery.stop();
        expect(signal.aborted).toBe(true);
        throw new Error('aborted');
      },
    });
    await discovery.run();
    await discovery.discovered;
    expect(lines).toEqual([]);
    expect(discovery.provider).toBeNull();
  });

  test('stop() during the sleep ends the loop with no further attempts', async () => {
    const h = harness(100, {
      sleep: async () => {
        h.discovery.stop();
      },
    });
    await h.discovery.run();
    expect(h.attempts()).toBe(1);
    expect(h.lines.map(([e]) => e)).toEqual(['discovery.failed']);
  });
});

describe('sleepUnlessAborted', () => {
  test('resolves after the delay', async () => {
    const began = performance.now();
    await sleepUnlessAborted(5, new AbortController().signal);
    expect(performance.now() - began).toBeGreaterThanOrEqual(4);
  });

  test('resolves early once the signal aborts', async () => {
    const abort = new AbortController();
    const began = performance.now();
    const sleeping = sleepUnlessAborted(60_000, abort.signal);
    abort.abort();
    await sleeping;
    expect(performance.now() - began).toBeLessThan(1_000);
  });
});
