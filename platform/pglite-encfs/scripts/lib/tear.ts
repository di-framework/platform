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

/** Two slots per unit: slot A, then slot B. */
export const PAIR_LEN = 2 * SLOT_LEN;

/** Where `slot` (0 = A, 1 = B) of `unit` starts (src/slots.rs `slot_offset`). */
export function slotOffset(unit: number, slot: 0 | 1): number {
  return PAIRS_START + unit * PAIR_LEN + slot * SLOT_LEN;
}

/** The generation `slot` of `unit` claims; 0 when the slot is past the end. */
export function claimedGeneration(image: Uint8Array, unit: number, slot: 0 | 1): bigint {
  const start = slotOffset(unit, slot);
  return start + 8 <= image.length ? generation(image, start) : 0n;
}

/** The `len` field of a slot (bytes 8..12, little endian); 0 past the end. */
export function slotLength(image: Uint8Array, start: number): number {
  if (start + 12 > image.length) return 0;
  return new DataView(image.buffer, image.byteOffset + start + 8, 4).getUint32(0, true);
}

/**
 * The slot of `unit` that a rewrite of its durable version targets (design
 * note 6.2): the one that does not claim the higher generation. On a disk
 * nobody tampered with, the higher claim is the winner.
 */
export function rewriteTarget(image: Uint8Array, unit: number): 0 | 1 {
  return claimedGeneration(image, unit, 1) > claimedGeneration(image, unit, 0) ? 0 : 1;
}

/** The pairs of a codec-4 image that hold both slots. */
function wholePairs(image: Uint8Array): number {
  return Math.max(0, Math.floor((image.length - PAIRS_START) / PAIR_LEN));
}

/**
 * Codec 4: tear the first rewrite of a durable unit. The image is `before`,
 * except that in the first pair whose rewrite target (the slot that is not
 * the winner in `before`) changed in `after`, that slot takes the sectors of
 * `after` up to a sector boundary inside its changes. Unlike
 * {@link tearFirstSlot}, this also tears a pair whose two slots both changed
 * (a sync came in between): the target was written first, so its tear is the
 * crash state right after the first rewrite, with the winner of `before`
 * untouched.
 */
export function tearRewriteTarget(before: Uint8Array, after: Uint8Array): Tear | null {
  if (before.length !== after.length) return null;
  for (let unit = 0; unit < wholePairs(before); unit++) {
    const start = slotOffset(unit, rewriteTarget(before, unit));
    const torn = tearSlot(before, after, [start, start + SLOT_LEN]);
    if (torn) return torn;
  }
  return null;
}

/**
 * Codec 4: tear one slot write. The image is `before`, except that `slot`
 * takes the sectors of `after` up to a sector boundary inside its changes.
 * Null when the slot did not change, or its changes fit in one sector.
 */
export function tearSlot(
  before: Uint8Array,
  after: Uint8Array,
  slot: [number, number],
): Tear | null {
  if (before.length !== after.length || slot[1] > after.length) return null;
  if (firstDifference(before.subarray(...slot), after.subarray(...slot)) < 0) return null;
  const tearAt = tearPoint(before, after, slot);
  if (tearAt === null) return null;
  const bytes = Uint8Array.from(before);
  bytes.set(after.subarray(slot[0], tearAt), slot[0]);
  return { bytes, page: slot, tearAt };
}

/**
 * The watermark `D` a codec-4 image claims: the durable-unit count of the
 * record with the higher `seq` (src/slots.rs). Read without the key, so it
 * is only meaningful on an image nobody tampered with.
 */
export function claimedWatermark(image: Uint8Array): bigint {
  const record = (at: number) => {
    if (at + 16 > image.length) return { seq: 0n, units: 0n };
    const view = new DataView(image.buffer, image.byteOffset + at, 16);
    return { seq: view.getBigUint64(0, true), units: view.getBigUint64(8, true) };
  };
  const [zero, one] = [record(4096), record(8192)];
  return (one.seq > zero.seq ? one : zero).units;
}

/**
 * Codec 4, C10: one unit rewritten twice without a sync, the second write
 * torn. `first` and `second` are two continuations of `before` that both
 * rewrote the same durable unit, so their copies of its rewrite target are
 * two writes to that slot, sealed with different nonces. The image is
 * `before`, except that the target holds the sectors of `first` up to a
 * sector boundary and those of `second` from it on: neither write's tag
 * verifies, and the winner of `before` is untouched.
 */
export function tearSecondRewrite(
  before: Uint8Array,
  first: Uint8Array,
  second: Uint8Array,
): Tear | null {
  if (before.length !== first.length || before.length !== second.length) return null;
  for (let unit = 0; unit < wholePairs(before); unit++) {
    const start = slotOffset(unit, rewriteTarget(before, unit));
    const slot: [number, number] = [start, start + SLOT_LEN];
    const changed = (image: Uint8Array) =>
      firstDifference(before.subarray(...slot), image.subarray(...slot)) >= 0;
    if (!changed(first) || !changed(second)) continue;
    const tearAt = tearPoint(first, second, slot);
    if (tearAt === null) continue;
    const bytes = Uint8Array.from(before);
    bytes.set(first.subarray(start, tearAt), start);
    bytes.set(second.subarray(tearAt, slot[1]), tearAt);
    return { bytes, page: slot, tearAt };
  }
  return null;
}

/**
 * Codec 4, C6: an unaligned append inside the last unit, torn. The last
 * pair's winner (the slot the append wrote) keeps its first sector, with the
 * slot header, and its sectors from the next boundary on did not reach the
 * disk: zeros, as past the old end of the file. The file length did. Null
 * when the last unit is full, so no append inside it can be in flight.
 */
export function tearLastAppend(image: Uint8Array): Tear | null {
  const pairs = Math.ceil((image.length - PAIRS_START) / PAIR_LEN);
  if (pairs < 1) return null;
  const unit = pairs - 1;
  const start = slotOffset(unit, rewriteTarget(image, unit) === 0 ? 1 : 0);
  const len = slotLength(image, start);
  if (len === 0 || len >= PAGE) return null;
  const end = Math.min(start + 64 + len, image.length);
  const tearAt = roundUp(start + 64 + 1);
  if (tearAt >= end) return null;
  const bytes = Uint8Array.from(image);
  bytes.fill(0, tearAt, end);
  return { bytes, page: [start, end], tearAt };
}
