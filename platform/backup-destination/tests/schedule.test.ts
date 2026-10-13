import { describe, expect, test } from 'bun:test';
import { cronMatches, isDue, previousFire, validCron } from '../src/schedule.ts';

const at = (iso: string) => new Date(iso);

describe('cron schedules', () => {
  test('validates every field against its range', () => {
    for (const valid of [
      '0 2 * * *',
      '*/15 0-2 1,15 1-6 1-5',
      '30 3 * * 7',
      '0 0 29 2 *',
      '59 23 31 12 0-7/7',
    ]) {
      expect(validCron(valid)).toBe(true);
    }
    for (const invalid of [
      'a b c d e',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      '5-1 * * * *',
      '*/0 * * * *',
      '* * * *',
      '* * * * * *',
      '1,,2 * * * *',
      '',
    ]) {
      expect(validCron(invalid)).toBe(false);
    }
  });

  test('finds the previous fire by walking days, not minutes', () => {
    // Later today has not come yet: yesterday's fire.
    expect(previousFire('59 3 * * *', at('2026-10-13T03:30:00Z'))).toEqual(
      at('2026-10-12T03:59:00Z'),
    );
    expect(previousFire('15 3 * * *', at('2026-10-13T03:30:59Z'))).toEqual(
      at('2026-10-13T03:15:00Z'),
    );
    expect(previousFire('0 12 * * 1', at('2026-10-13T03:30:00Z'))).toEqual(
      at('2026-10-12T12:00:00Z'),
    );
    // 29 February: four years back.
    expect(previousFire('0 0 29 2 *', at('2026-10-13T00:00:00Z'))).toEqual(
      at('2024-02-29T00:00:00Z'),
    );
    // A date that never exists, and an invalid schedule, return quickly.
    const started = performance.now();
    expect(previousFire('0 0 31 2 *', at('2026-10-13T00:00:00Z'))).toBeUndefined();
    expect(previousFire('99 * * * *', at('2026-10-13T00:00:00Z'))).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
    expect(cronMatches('0 2 * * 7', at('2026-09-27T02:00:00Z'))).toBe(true);
    expect(cronMatches('0 2 * * *', at('2026-09-27T02:01:00Z'))).toBe(false);
    expect(cronMatches('bad', at('2026-09-27T02:00:00Z'))).toBe(false);
    expect(isDue('99 * * * *', undefined, at('2026-09-27T02:00:00Z'))).toBe(false);
  });
});
