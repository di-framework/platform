import { describe, expect, test } from 'bun:test';
import {
  claimedGeneration,
  claimedWatermark,
  PAGE,
  PAIR_LEN,
  PAIRS_START,
  SECTOR,
  SLOT_LEN,
  slotOffset,
  type Tear,
  tearFirstRewrite,
  tearLastAppend,
  tearLastWrite,
  tearRewriteTarget,
  tearSecondRewrite,
} from './tear.ts';

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

/** A codec-4 image of `slots.length` pairs; `slots[u]` holds the generations of A and B. */
function codec4(slots: [number, number][], fill: number): Uint8Array {
  const image = new Uint8Array(PAIRS_START + slots.length * PAIR_LEN).fill(fill);
  slots.forEach((generations, unit) => {
    generations.forEach((gen, slot) => {
      const view = new DataView(image.buffer, slotOffset(unit, slot as 0 | 1), 12);
      view.setBigUint64(0, BigInt(gen), true);
      view.setUint32(8, gen === 0 ? 0 : PAGE, true);
    });
  });
  return image;
}

describe('codec-4 tears', () => {
  test('tearRewriteTarget tears the slot that is not the winner, also when both changed', () => {
    const before = codec4(
      [
        [3, 2],
        [1, 0],
      ],
      0,
    );
    const after = codec4(
      [
        [5, 4],
        [1, 0],
      ],
      7,
    );
    const { bytes, page, tearAt } = tearRewriteTarget(before, after) as Tear;
    // Unit 0: A (3) wins, so B is the target; A keeps its old bytes.
    expect(page).toEqual([slotOffset(0, 1), slotOffset(0, 1) + SLOT_LEN]);
    expect(tearAt % SECTOR).toBe(0);
    expect(sectorsEqual(bytes, before, 0, page[0])).toBe(true);
    expect(sectorsEqual(bytes, after, page[0], tearAt)).toBe(true);
    expect(sectorsEqual(bytes, before, tearAt, bytes.length)).toBe(true);
    expect(claimedGeneration(bytes, 0, 1)).toBe(4n);
    expect(tearRewriteTarget(before, before)).toBeNull();
  });

  test('tearSecondRewrite mixes two writes to the target and leaves the winner', () => {
    const before = codec4([[3, 2]], 0);
    const first = codec4([[3, 4]], 1);
    const second = codec4([[3, 4]], 2);
    const { bytes, page, tearAt } = tearSecondRewrite(before, first, second) as Tear;
    expect(page[0]).toBe(slotOffset(0, 1));
    expect(sectorsEqual(bytes, before, 0, page[0])).toBe(true);
    expect(sectorsEqual(bytes, first, page[0], tearAt)).toBe(true);
    expect(sectorsEqual(bytes, second, tearAt, page[1])).toBe(true);
    expect(tearSecondRewrite(before, first, before)).toBeNull();
  });

  test('tearLastAppend zeroes the data sectors of a short last slot only', () => {
    const image = codec4(
      [
        [2, 0],
        [3, 4],
      ],
      9,
    );
    new DataView(image.buffer, slotOffset(1, 1) + 8, 4).setUint32(0, 1000, true);
    const { bytes, page, tearAt } = tearLastAppend(image) as Tear;
    expect(page).toEqual([slotOffset(1, 1), slotOffset(1, 1) + 64 + 1000]);
    expect(tearAt % SECTOR).toBe(0);
    expect(bytes.subarray(tearAt, page[1]).every((b) => b === 0)).toBe(true);
    expect(sectorsEqual(bytes, image, 0, tearAt)).toBe(true);
    expect(sectorsEqual(bytes, image, page[1], bytes.length)).toBe(true);
    expect(tearLastAppend(codec4([[2, 0]], 9))).toBeNull();
  });

  test('claimedWatermark reads D from the record with the higher sequence', () => {
    const image = codec4([[1, 0]], 0);
    const record = (at: number, seq: number, units: number) => {
      const view = new DataView(image.buffer, at, 16);
      view.setBigUint64(0, BigInt(seq), true);
      view.setBigUint64(8, BigInt(units), true);
    };
    record(4096, 1, 0);
    expect(claimedWatermark(image)).toBe(0n);
    record(8192, 2, 5);
    expect(claimedWatermark(image)).toBe(5n);
    record(4096, 3, 4);
    expect(claimedWatermark(image)).toBe(4n);
  });
});
