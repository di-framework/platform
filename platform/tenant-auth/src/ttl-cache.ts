/**
 * A size-bounded cache whose entries carry their own expiry. Lookups never return an entry at or
 * past its expiry; inserts sweep expired entries before falling back to least-recently-used
 * eviction, so the map never holds more than `maxEntries` values.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; until: number }>();

  constructor(
    readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1)
      throw new Error(`cache size must be a positive integer, got ${maxEntries}`);
  }

  get size(): number {
    return this.entries.size;
  }

  /** The live value for `key`, refreshed as most recently used; expired entries are dropped. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.until <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Store `value` until the absolute time `until`; an already-expired value is not stored. */
  set(key: string, value: V, until: number): void {
    this.entries.delete(key);
    if (until <= this.now()) return;
    if (this.entries.size >= this.maxEntries) this.sweep();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, until });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drop every entry at or past its expiry. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.until <= now) this.entries.delete(key);
  }
}
