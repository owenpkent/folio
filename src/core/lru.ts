/**
 * A least-recently-used map with a fixed capacity.
 *
 * Backed by a plain `Map`, which iterates in insertion order: re-inserting on
 * every hit therefore keeps the least recently used entry at the head, so
 * eviction is just "delete the first key". That is enough for the caches here
 * (tens of entries) and avoids a hand-rolled linked list.
 *
 * `onEvict` is the point of the class rather than an extra: the values these
 * caches hold own resources the garbage collector cannot reclaim on its own
 * (see the pdf.js page cache in PdfJsEngine), so dropping a reference frees
 * nothing unless something is told to release it.
 *
 * `clear()` deliberately does NOT call `onEvict`. It is teardown, and every
 * caller pairs it with destroying whatever backed the values anyway; running
 * per-entry release against an already-destroyed owner is at best wasted work.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly limit: number;
  private readonly onEvict?: (value: V, key: K) => void;

  constructor(limit: number, onEvict?: (value: V, key: K) => void) {
    // A zero or negative capacity would evict on every set and loop forever
    // looking for something to drop. NaN needs the explicit check: it survives
    // Math.max, and `size > NaN` is false, so the cache would grow unbounded --
    // exactly the failure this class exists to prevent.
    const floored = Math.floor(limit);
    this.limit = Number.isFinite(floored) ? Math.max(1, floored) : 1;
    this.onEvict = onEvict;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Re-insert at the tail: this entry is now the most recently used.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    const replaced = this.map.get(key);
    // `has` rather than `replaced !== undefined`: V may legitimately include
    // undefined, and a missing key must not be reported as a replacement.
    const wasPresent = this.map.has(key);
    this.map.delete(key);
    this.map.set(key, value);

    // Overwriting a key drops the old value exactly as eviction does, and the
    // old value owns the same resource the collector cannot reclaim, so it
    // needs the same release. Without this the cache leaks the one thing it
    // exists to bound: a re-rendered page replaces its entry and the previous
    // PDFPageProxy is never cleaned up. Re-setting a key to the value it
    // already holds is not a replacement, though, and releasing there would
    // destroy what the cache is about to hand back out.
    if (wasPresent && replaced !== value) {
      this.onEvict?.(replaced as V, key);
    }

    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const evicted = this.map.get(oldest.value) as V;
      this.map.delete(oldest.value);
      this.onEvict?.(evicted, oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
