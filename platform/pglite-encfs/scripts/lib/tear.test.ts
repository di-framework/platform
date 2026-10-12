import { describe, expect, test } from 'bun:test';
import { PAGE, SECTOR, tearFirstRewrite, tearLastWrite } from './tear.ts';

const HEADER = 4096;

function file(pages: number, fill: number): Uint8Array {
  return new Uint8Array(HEADER + pages * PAGE).fill(fill);
}

/** Which sectors of `bytes` come from `from` (by fill value). */
function sectorsEqual(bytes: Uint8Array, from: Uint8Array, start: number, end: number): boolean {
  return bytes.subarray(start, end).every((b, i) => b === from[start + i]);
}

describe('tearLastWrite', () => {
  test('keeps new sectors up to the tear and old ones after it, inside the last changed page', () => {
    const before = file(3, 0);
    const after = Uint8Array.from(before);
    // Page 0 and part of page 1 changed; page 1 is the write in flight.
    after.fill(1, HEADER, HEADER + PAGE + 3000);
    const tear = tearLastWrite(before, after, HEADER);
    expect(tear).not.toBeNull();
    const { bytes, page, tearAt } = tear as NonNullable<typeof tear>;
    expect(page).toEqual([HEADER + PAGE, HEADER + 2 * PAGE]);
    expect(tearAt % SECTOR).toBe(0);
    expect(tearAt).toBeGreaterThan(page[0]);
    expect(tearAt).toBeLessThan(page[1]);
    expect(sectorsEqual(bytes, after, 0, tearAt)).toBe(true);
    expect(sectorsEqual(bytes, before, tearAt, page[1])).toBe(true);
    expect(sectorsEqual(bytes, after, page[1], bytes.length)).toBe(true);
  });

  test('a change inside the header tears the header', () => {
    const before = file(1, 0);
    const after = Uint8Array.from(before);
    after[40] = 9;
    expect(tearLastWrite(before, after, HEADER)?.page).toEqual([0, HEADER]);
  });

  test('identical or resized files are not torn', () => {
    expect(tearLastWrite(file(1, 0), file(1, 0), HEADER)).toBeNull();
    expect(tearLastWrite(file(1, 0), file(2, 1), HEADER)).toBeNull();
  });
});

describe('tearFirstRewrite', () => {
  test('starts from the old version and persists only the first new sectors of the first changed page', () => {
    const before = file(2, 0);
    const after = Uint8Array.from(before);
    after.fill(2, HEADER + 100, HEADER + 2 * PAGE);
    const tear = tearFirstRewrite(before, after, HEADER);
    const { bytes, page, tearAt } = tear as NonNullable<typeof tear>;
    expect(page).toEqual([HEADER, HEADER + PAGE]);
    expect(tearAt).toBe(HEADER + 2 * SECTOR);
    expect(sectorsEqual(bytes, before, 0, HEADER)).toBe(true);
    expect(sectorsEqual(bytes, after, HEADER, tearAt)).toBe(true);
    expect(sectorsEqual(bytes, before, tearAt, bytes.length)).toBe(true);
  });

  test('never persists the whole page', () => {
    const before = file(1, 0);
    const after = Uint8Array.from(before);
    after.fill(3, HEADER + PAGE - 10);
    const { tearAt, page } = tearFirstRewrite(before, after, HEADER) as NonNullable<
      ReturnType<typeof tearFirstRewrite>
    >;
    expect(tearAt).toBe(page[0] + PAGE - SECTOR);
    expect(tearFirstRewrite(before, before, HEADER)).toBeNull();
  });
});
