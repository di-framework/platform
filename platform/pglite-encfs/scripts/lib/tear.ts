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

/** Codec-4 layout (src/slots.rs): header page, two watermark records, then pairs. */
export const PAIRS_START = 3 * 4096;
/** One slot: 64 bytes of metadata and up to 8 KiB of ciphertext. */
export const SLOT_LEN = 64 + PAGE;

/** The generation a slot claims (bytes 0..8, little endian; src/slots.rs). */
function generation(image: Uint8Array, start: number): bigint {
  return new DataView(image.buffer, image.byteOffset + start, 8).getBigUint64(0, true);
}

/**
 * One torn candidate per changed pair of two codec-4 images, in file order.
 * A write never targets the slot holding the durable version, so the other
 * slot of the pair holds a version that was durable when the write was in
 * flight, and a tear of the written slot is a real crash state:
 * - when one slot changed, that slot, with the other as it was before;
 * - when both changed (a sync came in between), only for `newest`: the slot
 *   with the higher generation in `after`, which was written last, with the
 *   other as it is after. Which of them came first is not known then.
 */
function changedSlots(before: Uint8Array, after: Uint8Array, newest: boolean): [number, number][] {
  const changed = (start: number) => {
    const end = Math.min(start + SLOT_LEN, after.length);
    return (
      start < end && firstDifference(before.subarray(start, end), after.subarray(start, end)) >= 0
    );
  };
  const slots: [number, number][] = [];
  for (let pair = PAIRS_START; pair < after.length; pair += 2 * SLOT_LEN) {
    const [a, b] = [changed(pair), changed(pair + SLOT_LEN)];
    if (!a && !b) continue;
    let start = a ? pair : pair + SLOT_LEN;
    if (a && b) {
      if (!newest || pair + 2 * SLOT_LEN > after.length) continue;
      if (generation(after, pair + SLOT_LEN) > generation(after, pair)) start = pair + SLOT_LEN;
    }
    slots.push([start, Math.min(start + SLOT_LEN, after.length)]);
  }
  return slots;
}

/**
 * A sector boundary strictly inside the changes of one slot, so the slot
 * holds new bytes before it and old bytes from it on; null when the changes
 * fit in one sector and no tear can mix them.
 */
function tearPoint(
  before: Uint8Array,
  after: Uint8Array,
  [start, end]: [number, number],
): number | null {
  const a = before.subarray(start, end);
  const b = after.subarray(start, end);
  const first = start + firstDifference(a, b);
  const last = start + lastDifference(a, b);
  const middle = roundUp(first + Math.floor((last - first) / 2));
  if (first < middle && middle <= last) return middle;
  const next = roundUp(first + 1);
  return next <= last ? next : null;
}

/**
 * Codec 4: tear the last slot write in flight. The image is `after`, except
 * that the last changed slot that can be torn keeps its new sectors only up
 * to a sector boundary inside its changes. A slot write never covers part of
 * another slot's version, so the tear stays inside one slot.
 */
export function tearLastSlot(before: Uint8Array, after: Uint8Array): Tear | null {
  if (before.length !== after.length) return null;
  for (const slot of changedSlots(before, after, true).reverse()) {
    const tearAt = tearPoint(before, after, slot);
    if (tearAt === null) continue;
    const bytes = Uint8Array.from(after);
    bytes.set(before.subarray(tearAt, slot[1]), tearAt);
    return { bytes, page: slot, tearAt };
  }
  return null;
}

/**
 * Codec 4: tear the first slot rewrite after a durable commit. The image is
 * `before`, except that the first changed slot that can be torn takes the
 * sectors of `after` up to a sector boundary inside its changes.
 */
export function tearFirstSlot(before: Uint8Array, after: Uint8Array): Tear | null {
  if (before.length !== after.length) return null;
  for (const slot of changedSlots(before, after, false)) {
    const tearAt = tearPoint(before, after, slot);
    if (tearAt === null) continue;
    const bytes = Uint8Array.from(before);
    bytes.set(after.subarray(slot[0], tearAt), slot[0]);
    return { bytes, page: slot, tearAt };
  }
  return null;
}
