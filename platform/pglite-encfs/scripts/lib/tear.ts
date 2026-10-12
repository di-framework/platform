/**
 * Power-loss torn-write simulation, ported from the encryption spike.
 *
 * Inputs are the bytes of one file in two snapshots: `before` (commit A
 * durable) and `after` (commit B durable). A torn write keeps whole 512-byte
 * sectors: some from the new version and the rest from the old one, inside
 * one PostgreSQL page write (8 KiB, after encfs's header).
 */

export const SECTOR = 512;
/** PostgreSQL block size: the unit of one page write. */
export const PAGE = 8192;

function firstDifference(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function lastDifference(a: Uint8Array, b: Uint8Array): number {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] !== b[i]) return i;
  return -1;
}

const roundUp = (n: number) => Math.ceil(n / SECTOR) * SECTOR;
const roundDown = (n: number) => Math.floor(n / SECTOR) * SECTOR;

export interface Tear {
  bytes: Uint8Array;
  /** Page write [start, end) that was torn, and the first offset taken from the old version. */
  page: [number, number];
  tearAt: number;
}

/**
 * Tear the last write in flight: the page holding the last changed byte keeps
 * new sectors up to a tear point in the middle of its changes and old sectors
 * after it. Earlier pages keep their new contents (they were fsynced before).
 * Returns null when the versions are identical or differ in length.
 */
export function tearLastWrite(before: Uint8Array, after: Uint8Array, header: number): Tear | null {
  if (before.length !== after.length) return null;
  const first = firstDifference(before, after);
  if (first < 0) return null;
  const last = lastDifference(before, after);
  let start: number;
  let end: number;
  if (last < header) {
    [start, end] = [0, header];
  } else {
    start = header + Math.floor((last - header) / PAGE) * PAGE;
    end = Math.min(start + PAGE, after.length);
  }
  const low = Math.max(first, start);
  let tearAt = roundUp(low + Math.floor((last - low) / 2));
  if (!(start < tearAt && tearAt < end)) tearAt = roundDown(start + PAGE / 2);
  const bytes = Uint8Array.from(after);
  bytes.set(before.subarray(tearAt, end), tearAt);
  return { bytes, page: [start, end], tearAt };
}

/**
 * Tear the rewrite of the page that already holds a durable commit: the
 * result is `before`, except the page containing the first change, whose
 * first sectors (just past the change) come from `after`.
 * Returns null when the versions are identical or differ in length.
 */
export function tearFirstRewrite(
  before: Uint8Array,
  after: Uint8Array,
  header: number,
): Tear | null {
  if (before.length !== after.length) return null;
  const first = firstDifference(before, after);
  if (first < 0) return null;
  const start = header + Math.floor((first - header) / PAGE) * PAGE;
  const end = Math.min(start + PAGE, after.length);
  const tearAt = Math.min(roundDown(first + SECTOR) + SECTOR, start + PAGE - SECTOR, end);
  const bytes = Uint8Array.from(before);
  bytes.set(after.subarray(start, tearAt), start);
  return { bytes, page: [start, end], tearAt };
}
