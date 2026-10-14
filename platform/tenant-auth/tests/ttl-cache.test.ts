import { describe, expect, test } from 'bun:test';
import { TtlCache } from '../src/ttl-cache.ts';

function clock(start = 1_000_000) {
  const time = { now: start };
  return { time, now: () => time.now };
}

describe('TtlCache', () => {
  test('rejects a non-positive or fractional size', () => {
    expect(() => new TtlCache(0)).toThrow('positive integer');
    expect(() => new TtlCache(1.5)).toThrow('positive integer');
  });

  test('serves an entry until its expiry and drops it at that instant', () => {
    const { time, now } = clock();
    const cache = new TtlCache<string>(4, now);
    cache.set('a', 'A', time.now + 100);
    time.now += 99;
    expect(cache.get('a')).toBe('A');
    time.now += 1;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('does not store an entry that is already expired', () => {
    const { time, now } = clock();
    const cache = new TtlCache<string>(4, now);
    cache.set('a', 'A', time.now);
    cache.set('b', 'B', time.now - 1);
    expect(cache.size).toBe(0);
  });

  test('evicts the least recently used entry once full', () => {
    const { time, now } = clock();
    const cache = new TtlCache<string>(3, now);
    cache.set('a', 'A', time.now + 1000);
    cache.set('b', 'B', time.now + 1000);
    cache.set('c', 'C', time.now + 1000);
    expect(cache.get('a')).toBe('A');
    cache.set('d', 'D', time.now + 1000);
    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
    expect(cache.get('d')).toBe('D');
  });

  test('sweeps expired entries before evicting live ones', () => {
    const { time, now } = clock();
    const cache = new TtlCache<string>(3, now);
    cache.set('live', 'L', time.now + 1000);
    cache.set('short1', 'S', time.now + 10);
    cache.set('short2', 'S', time.now + 10);
    time.now += 10;
    cache.set('new', 'N', time.now + 1000);
    expect(cache.size).toBe(2);
    expect(cache.get('live')).toBe('L');
    expect(cache.get('new')).toBe('N');
  });

  test('overwriting a key replaces its value and expiry without growing', () => {
    const { time, now } = clock();
    const cache = new TtlCache<string>(2, now);
    cache.set('a', 'A', time.now + 10);
    cache.set('a', 'A2', time.now + 1000);
    expect(cache.size).toBe(1);
    time.now += 500;
    expect(cache.get('a')).toBe('A2');
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
  });

  test('never grows past its bound under many distinct keys', () => {
    const { time, now } = clock();
    const cache = new TtlCache<number>(64, now);
    for (let i = 0; i < 10_000; i++) {
      cache.set(`k${i}`, i, time.now + 60_000);
      expect(cache.size).toBeLessThanOrEqual(64);
    }
    expect(cache.get('k9999')).toBe(9999);
    expect(cache.get('k0')).toBeUndefined();
  });
});
